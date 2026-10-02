import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STALE_AFTER_MS = 120_000;

function utcTimestampMs(value) {
  if (!value) return null;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/i.test(String(value))
    ? String(value)
    : `${String(value).replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function countRows(db, table) {
  return tableExists(db, table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : null;
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name)));
}

function openTradeCounts(db, authoritativeAccount) {
  const columns = tableColumns(db, "trades");
  if (!columns.has("status")) return { openTrades: null, legacyOpenTrades: null, unattributedOpenTrades: null };
  const openTrades = Number(db.prepare("SELECT COUNT(*) AS count FROM trades WHERE lower(trim(status)) = 'open'").get().count);
  const attributionColumns = ["strategy_id", "strategy_name", "strategy_version"];
  const unattributedOpenTrades = attributionColumns.every(column => columns.has(column))
    ? Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM trades
        WHERE lower(trim(status)) = 'open'
          AND (
            coalesce(trim(strategy_id), '') = ''
            OR coalesce(trim(strategy_name), '') = ''
            OR coalesce(trim(strategy_version), '') = ''
          )
      `).get().count)
    : null;
  if (!columns.has("trade_account") || !authoritativeAccount) {
    return { openTrades, legacyOpenTrades: null, unattributedOpenTrades };
  }
  const legacyOpenTrades = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM trades
    WHERE lower(trim(status)) = 'open'
      AND coalesce(trim(trade_account), '') <> trim(?)
  `).get(authoritativeAccount).count);
  return { openTrades, legacyOpenTrades, unattributedOpenTrades };
}

export function readProjectPaperTelemetry(sqliteFile, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const staleAfterMs = Number(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  if (!sqliteFile || !fs.existsSync(sqliteFile)) {
    return {
      available: false,
      healthy: false,
      status: "missing",
      sqliteFile: sqliteFile || null,
      warning: "The dedicated VWAP Paper telemetry database is not available.",
    };
  }

  let db;
  try {
    db = new DatabaseSync(sqliteFile, { readOnly: true });
    const account = tableExists(db, "account_snapshot")
      ? db.prepare("SELECT * FROM account_snapshot ORDER BY account_snapshot_id DESC LIMIT 1").get() || null
      : null;
    const instrument = tableExists(db, "instrument_snapshot")
      ? db.prepare("SELECT * FROM instrument_snapshot ORDER BY instrument_snapshot_id DESC LIMIT 1").get() || null
      : null;
    const health = tableExists(db, "logger_health")
      ? db.prepare("SELECT * FROM logger_health ORDER BY health_id DESC LIMIT 1").get() || null
      : null;
    const instance = tableExists(db, "sierra_instance")
      ? db.prepare("SELECT * FROM sierra_instance ORDER BY rowid DESC LIMIT 1").get() || null
      : null;
    const latestSnapshotUtc = account?.snapshot_utc || account?.created_utc || instrument?.created_utc || null;
    const latestSnapshotMs = utcTimestampMs(latestSnapshotUtc);
    const ageMs = latestSnapshotMs === null ? null : Math.max(0, nowMs - latestSnapshotMs);
    const expectedPaperIdentity = instance?.instance_role === "paper" && account?.instance_role === "paper";
    const expectedSimulationIdentity = Number(account?.is_simulated) === 1
      && String(account?.account_type_guess || "").toLowerCase() === "simulation";
    const fresh = ageMs !== null && ageMs <= staleAfterMs;
    const tradeCounts = openTradeCounts(db, account?.trade_account || null);
    const reconciliationRequired = Number(tradeCounts.legacyOpenTrades || 0) > 0;
    const attributionRequired = Number(tradeCounts.unattributedOpenTrades || 0) > 0;
    const healthy = Boolean(account && instrument && health && expectedPaperIdentity && expectedSimulationIdentity && fresh && !reconciliationRequired && !attributionRequired);
    const loggerVersion = String(health?.message || "").match(/\bversion=([^\s]+)/i)?.[1] || null;

    return {
      available: true,
      healthy,
      status: healthy ? "active" : reconciliationRequired ? "reconciliation_required" : attributionRequired ? "attribution_required" : fresh ? "identity_mismatch" : "stale",
      sqliteFile,
      instanceName: instance?.instance_name || account?.instance_name || null,
      instanceRole: instance?.instance_role || account?.instance_role || null,
      account: account?.trade_account || instrument?.trade_account || null,
      accountType: account?.account_type_guess || null,
      isSimulated: Number(account?.is_simulated) === 1,
      symbol: instrument?.symbol || null,
      loggerVersion,
      latestSnapshotUtc,
      ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
      counts: {
        accountSnapshots: countRows(db, "account_snapshot"),
        orders: countRows(db, "orders"),
        fills: countRows(db, "fills"),
        trades: countRows(db, "trades"),
        openTrades: tradeCounts.openTrades,
        legacyOpenTrades: tradeCounts.legacyOpenTrades,
        unattributedOpenTrades: tradeCounts.unattributedOpenTrades,
      },
      warning: healthy
        ? null
        : reconciliationRequired
          ? `${tradeCounts.legacyOpenTrades} open trade record(s) belong to a non-authoritative Paper account and require audited reconciliation.`
          : attributionRequired
            ? `${tradeCounts.unattributedOpenTrades} open trade record(s) lack the required strategy identity and require evidence-backed attribution.`
          : !fresh
          ? "The dedicated VWAP Paper telemetry heartbeat is stale."
          : "The dedicated telemetry database is not reporting the expected Paper simulation identity.",
      isolation: "Status only. This database is not merged into the existing Paper calendar or ledger.",
    };
  } catch (error) {
    return {
      available: true,
      healthy: false,
      status: "unreadable",
      sqliteFile,
      warning: `The dedicated VWAP Paper telemetry database could not be read: ${error.message}`,
    };
  } finally {
    db?.close();
  }
}
