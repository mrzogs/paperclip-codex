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

function selectedColumn(columns, name) {
  return columns.has(name) ? name : `NULL AS ${name}`;
}

function normalizedUtc(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return null;
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/i.test(text) ? text : `${text.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

function normalizedSide(value) {
  const text = String(value || "").trim();
  if (/short|sell/i.test(text)) return "Short";
  if (/long|buy/i.test(text)) return "Long";
  return text || null;
}

function projectPaperTrades(db, authoritativeAccount, sqliteFile, instrument) {
  const columns = tableColumns(db, "trades");
  if (!columns.has("trade_account") || !authoritativeAccount) return [];
  const fields = [
    "trade_id", "instance_name", "trade_account", "account_type_guess", "is_simulated",
    "symbol", "instrument", "contract", "strategy_id", "strategy_name", "strategy_version",
    "attribution_confidence", "direction", "status", "entry_datetime", "exit_datetime",
    "initial_quantity", "max_quantity", "final_quantity", "average_entry_price",
    "average_exit_price", "initial_stop_price", "final_stop_price", "initial_target_price",
    "final_target_price", "exit_classification", "gross_points", "gross_ticks",
    "gross_currency_value", "total_commission", "net_profit_loss", "profit_loss",
    "opening_order_id", "closing_order_id", "text_tag", "order_action_source",
    "created_utc", "updated_utc",
  ];
  const simulatedPredicate = columns.has("is_simulated") ? "AND is_simulated = 1" : "";
  const rows = db.prepare(`
    SELECT ${fields.map(name => selectedColumn(columns, name)).join(", ")}
    FROM trades
    WHERE lower(trim(coalesce(trade_account, ''))) = lower(trim(?))
      ${simulatedPredicate}
    ORDER BY rowid DESC
    LIMIT 500
  `).all(authoritativeAccount);
  const latestPrice = ["last_trade_price", "last_price", "trade_price", "price"]
    .map(name => finiteNumber(instrument?.[name]))
    .find(value => value !== null) ?? null;

  return rows.map(row => {
    const closed = String(row.status || "").trim().toLowerCase() === "closed";
    const entryAtUtc = normalizedUtc(row.created_utc) || normalizedUtc(row.entry_datetime);
    const exitAtUtc = closed ? normalizedUtc(row.updated_utc) || normalizedUtc(row.exit_datetime) : null;
    const account = String(row.trade_account || authoritativeAccount).trim();
    const symbol = String(row.symbol || row.instrument || instrument?.symbol || "n/a").trim();
    const strategyName = String(row.strategy_name || "CICD VWAP Pullback").trim();
    const quantity = finiteNumber(row.initial_quantity) ?? finiteNumber(row.max_quantity) ?? finiteNumber(row.final_quantity) ?? 0;
    const realizedPnlDollars = closed
      ? finiteNumber(row.net_profit_loss) ?? finiteNumber(row.profit_loss) ?? finiteNumber(row.gross_currency_value)
      : null;
    return {
      tradeId: `cicd-vwap-paper-sqlite-${row.trade_id}`,
      sourceId: `cicd-vwap-paper-sqlite-${row.trade_id}`,
      sourceSystem: "cicd_vwap_paper_sqlite",
      sourceDetail: "Dedicated CICD VWAP Sierra paper telemetry SQLite trades table read-only",
      sourceFile: sqliteFile,
      mode: "paper",
      account,
      accountType: "Paper Simulation",
      accountFamily: "CICD VWAP Paper",
      tradeAccount: account,
      symbol,
      instrument: String(row.instrument || symbol).trim(),
      contract: row.contract ? String(row.contract).trim() : null,
      strategyId: row.strategy_id ? String(row.strategy_id).trim() : null,
      strategyName,
      strategyStudy: strategyName,
      strategyVersion: row.strategy_version ? String(row.strategy_version).trim() : null,
      tradeSource: "strategy",
      approvalStatus: "observed_cicd_paper",
      dashboardBucket: "cicd_vwap_paper_telemetry_sqlite",
      side: normalizedSide(row.direction),
      quantity,
      entryPrice: finiteNumber(row.average_entry_price),
      exitPrice: finiteNumber(row.average_exit_price),
      initialStopPrice: finiteNumber(row.initial_stop_price),
      finalStopPrice: finiteNumber(row.final_stop_price),
      targetPrice: finiteNumber(row.final_target_price) ?? finiteNumber(row.initial_target_price),
      entryAtUtc,
      exitAtUtc,
      tradeDateUtc: exitAtUtc || entryAtUtc,
      timestampUtc: exitAtUtc || entryAtUtc,
      status: closed ? "Closed" : String(row.status || "Open").trim(),
      realizedPnlDollars,
      grossPoints: finiteNumber(row.gross_points),
      points: finiteNumber(row.gross_points),
      grossTicks: finiteNumber(row.gross_ticks),
      grossCurrencyValue: finiteNumber(row.gross_currency_value),
      totalCommission: finiteNumber(row.total_commission),
      openingOrderId: row.opening_order_id,
      closingOrderId: row.closing_order_id,
      internalOrderId: row.closing_order_id || row.opening_order_id || row.trade_id,
      textTag: row.text_tag ? String(row.text_tag).trim() : null,
      orderActionSource: row.order_action_source ? String(row.order_action_source).trim() : null,
      attributionConfidence: row.attribution_confidence ? String(row.attribution_confidence).trim() : null,
      profitTreatment: "observed_cicd_paper",
      createdAtUtc: normalizedUtc(row.created_utc),
      updatedAtUtc: normalizedUtc(row.updated_utc),
      averageEntryPrice: finiteNumber(row.average_entry_price),
      latestPrice,
      unrealizedPnlDollars: null,
      openedAtUtc: entryAtUtc,
      lastUpdatedUtc: normalizedUtc(row.updated_utc) || entryAtUtc,
    };
  });
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

function tradeAccountCounts(db, authoritativeAccount) {
  const columns = tableColumns(db, "trades");
  const totalTrades = countRows(db, "trades");
  if (totalTrades === null || !columns.has("trade_account") || !authoritativeAccount) {
    return {
      totalTrades,
      authoritativeTrades: null,
      excludedTrades: null,
      foreignAccountTrades: null,
      foreignAccounts: [],
    };
  }

  const simulatedPredicate = columns.has("is_simulated") ? "AND is_simulated = 1" : "";
  const authoritativeTrades = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM trades
    WHERE lower(trim(coalesce(trade_account, ''))) = lower(trim(?))
      ${simulatedPredicate}
  `).get(authoritativeAccount).count);
  const foreignAccountTrades = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM trades
    WHERE coalesce(trim(trade_account), '') <> ''
      AND lower(trim(trade_account)) <> lower(trim(?))
  `).get(authoritativeAccount).count);
  const foreignAccounts = db.prepare(`
    SELECT trim(trade_account) AS account, COUNT(*) AS count
    FROM trades
    WHERE coalesce(trim(trade_account), '') <> ''
      AND lower(trim(trade_account)) <> lower(trim(?))
    GROUP BY lower(trim(trade_account))
    ORDER BY count DESC, account ASC
  `).all(authoritativeAccount).map(row => ({ account: String(row.account), count: Number(row.count) }));

  return {
    totalTrades,
    authoritativeTrades,
    excludedTrades: Math.max(0, totalTrades - authoritativeTrades),
    foreignAccountTrades,
    foreignAccounts,
  };
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
    const accountTradeCounts = tradeAccountCounts(db, account?.trade_account || null);
    const trades = projectPaperTrades(db, account?.trade_account || null, sqliteFile, instrument);
    const closedTrades = trades.filter(trade => String(trade.status || "").toLowerCase() === "closed");
    const openPositions = trades.filter(trade => String(trade.status || "").toLowerCase() !== "closed");
    const reconciliationRequired = Number(tradeCounts.legacyOpenTrades || 0) > 0;
    const attributionRequired = Number(tradeCounts.unattributedOpenTrades || 0) > 0;
    const healthy = Boolean(account && instrument && health && expectedPaperIdentity && expectedSimulationIdentity && fresh && !reconciliationRequired && !attributionRequired);
    const loggerVersion = String(health?.message || "").match(/\bversion=([^\s]+)/i)?.[1] || null;
    const foreignAccountSummary = accountTradeCounts.foreignAccounts
      .map(entry => `${entry.account} (${entry.count})`)
      .join(", ");
    const historicalIsolationNotice = Number(accountTradeCounts.foreignAccountTrades || 0) > 0
      ? `${accountTradeCounts.foreignAccountTrades} historical trade record(s) belong to non-authoritative Paper account(s) ${foreignAccountSummary} and are excluded from ${account?.trade_account || "the authoritative account"} trades and P&L.`
      : null;

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
        trades: accountTradeCounts.totalTrades,
        authoritativeTrades: accountTradeCounts.authoritativeTrades,
        excludedTrades: accountTradeCounts.excludedTrades,
        foreignAccountTrades: accountTradeCounts.foreignAccountTrades,
        openTrades: tradeCounts.openTrades,
        legacyOpenTrades: tradeCounts.legacyOpenTrades,
        unattributedOpenTrades: tradeCounts.unattributedOpenTrades,
      },
      trades,
      closedTrades,
      openPositions,
      foreignAccounts: accountTradeCounts.foreignAccounts,
      closedNetProfitLossDollars: Number(closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlDollars || 0), 0).toFixed(2)),
      warning: healthy
        ? historicalIsolationNotice
        : reconciliationRequired
          ? `${tradeCounts.legacyOpenTrades} open trade record(s) belong to a non-authoritative Paper account and require audited reconciliation.`
          : attributionRequired
            ? `${tradeCounts.unattributedOpenTrades} open trade record(s) lack the required strategy identity and require evidence-backed attribution.`
          : !fresh
          ? "The dedicated VWAP Paper telemetry heartbeat is stale."
          : "The dedicated telemetry database is not reporting the expected Paper simulation identity.",
      isolation: historicalIsolationNotice
        ? `Displayed as a separate observed CICD VWAP Paper feed. ${historicalIsolationNotice} Approved Paper bundle totals remain unchanged.`
        : "Displayed as a separate observed CICD VWAP Paper feed; approved Paper bundle totals remain unchanged.",
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
