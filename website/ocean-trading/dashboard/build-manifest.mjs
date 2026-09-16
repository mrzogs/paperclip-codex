import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import {
  scopeReplayTelemetry,
  selectReplayTradeLogFallbackAccounts,
  visibleReplayTrades,
} from "./replay-session-scope.mjs";
import { withManifestBuildLock } from "./manifest-build-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPLAY_CONNECTOR_RELATIVE_PATH = path.join("connectors", "sierra-chart", "src", "replay-orchestration.mjs");
const PAPER_TRADE_ATTRIBUTION_RELATIVE_PATH = path.join("connectors", "sierra-chart", "src", "paper-trade-attribution.mjs");
const STRATEGIES_DIR = process.env.OCEAN_STRATEGY_REPO_DIR || "D:\\ExternalRepos\\ocean-trading-strategies";
const OQL_REPO_ROOT = process.env.OQL_REPO_ROOT || "D:\\ExternalRepos\\ocean-quant-lab";
const OQL_VWAP_REPLAY_EXPERIMENTS_DIR = path.join(
  OQL_REPO_ROOT,
  "strategies",
  "vwap_wave_pullback_balanced_nasdaq_v0434",
  "experiments",
);
const OCEAN_TRADING_DIR = path.join(STRATEGIES_DIR, "Ocean Trading");
const BACKTEST_DIR = path.join(STRATEGIES_DIR, "backtest_outputs");
const CACHED_BACKTEST_RESULTS_DIR = path.join(ROOT, "backtesting", "results");
const REGIME_RESULTS_DIR = path.join(ROOT, "backtesting", "results");
const REGIME_SUMMARY_FILE = path.join(REGIME_RESULTS_DIR, "regime-summary-mnq-mnqm26_fut_cme-5m.json");
const OUTPUT_FILE = path.join(ROOT, "dashboard", "dashboard-data.json");
const SQLITE_FILE = process.env.OCEAN_WEBSITE_DB || "D:\\OceanTradingData\\website\\ocean-trading-website.sqlite";
const SQLITE_PERSIST_SCRIPT = path.join(ROOT, "dashboard", "persist-sqlite.py");
const OPEN_POSITIONS_BASELINE_FILE = path.join(ROOT, "dashboard", "data", "open-positions-baseline.json");
const DTC_POSITION_SNAPSHOT_FILE = path.join(ROOT, "dashboard", "data", "dtc-position-snapshot.json");
const PROP_FIRM_RULE_SETS_FILE = path.join(ROOT, "dashboard", "data", "prop-firm-rule-sets.json");
const PROP_FIRM_ACCOUNTS_FILE = path.join(ROOT, "dashboard", "data", "prop-firm-accounts.json");
const PAPERCLIP_SYNC_FILE = path.join(ROOT, "dashboard", "data", "paperclip-sync.json");
const DASHBOARD_MONITOR_STATE_FILE = path.join(ROOT, "dashboard", "data", "monitor-state.json");
const REPLAY_MONITOR_STATE_FILE = path.join(ROOT, "dashboard", "data", "replay-monitor-state.json");
const REPLAY_MONITOR_CLEARS_FILE = path.join(ROOT, "dashboard", "data", "replay-monitor-clears.json");
const SIERRA_SYMBOL_CONFIG_FILE = path.join(ROOT, "dashboard", "config", "sierra-symbols.json");
const PYTHON_EXECUTABLE =
  process.env.OCEAN_TRADING_PYTHON ||
  process.env.PYTHON ||
  path.join(process.env.LOCALAPPDATA || "C:\\Users\\wayne\\AppData\\Local", "Programs", "Python", "Python312", "python.exe");
const OCEAN_TRADING_SOURCE = path.join(OCEAN_TRADING_DIR, "OceanTrading.cpp");
const LIVE_SIERRA_ROOT = process.env.SIERRA_LIVE_ROOT || "E:\\SierraChart-LiveTrading";
const LIVE_TRADE_LOG_DIR = path.join(LIVE_SIERRA_ROOT, "TradeActivityLogs");
const LIVE_TRADE_ACCOUNT_DATA_DIR = path.join(LIVE_SIERRA_ROOT, "TradeAccountData");
const PATRADING_LIVE_SQLITE_FILE =
  process.env.PATRADING_LIVE_SQLITE_FILE ||
  path.join(LIVE_SIERRA_ROOT, "Data", "TradeTelemetry", "Live", "TradeTelemetry_Live.sqlite");
const LIVE_TRADE_OUTPUT_FILE = path.join(ROOT, "dashboard", "data", "live-trades.json");
const LIVE_ACCOUNT_MONITOR_OUTPUT_FILE = path.join(ROOT, "dashboard", "data", "live-account-monitor.json");
const EXCLUDED_LIVE_TRADE_FILES_FILE = path.join(ROOT, "dashboard", "data", "excluded-live-trade-files.json");
const LIVE_TRADING_CLEAN_START_FILE = path.join(ROOT, "dashboard", "data", "live-trading-clean-start.json");
const PAPER_SIERRA_ROOT = process.env.SIERRA_PAPER_ROOT || "D:\\Trading\\SierraChart-PaperTrading";
const PAPER_TRADE_LOG_DIR = path.join(PAPER_SIERRA_ROOT, "TradeActivityLogs");
const PAPER_TRADE_ACCOUNT_DATA_DIR = path.join(PAPER_SIERRA_ROOT, "TradeAccountData");
const PATRADING_PAPER_SQLITE_FILE =
  process.env.PATRADING_PAPER_SQLITE_FILE ||
  path.join(PAPER_SIERRA_ROOT, "Data", "TradeTelemetry", "PaperTrading", "TradeTelemetry_PaperTrading.sqlite");
const REPLAY_SIERRA_ROOT = process.env.SIERRA_REPLAY_ROOT || "D:\\Trading\\SierraChart-Replay";
const REPLAY_TRADE_LOG_DIR = path.join(REPLAY_SIERRA_ROOT, "TradeActivityLogs");
const PATRADING_REPLAY_SQLITE_FILE =
  process.env.PATRADING_REPLAY_SQLITE_FILE ||
  path.join(REPLAY_SIERRA_ROOT, "Data", "TradeTelemetry", "Replay", "TradeTelemetry_Replay.sqlite");
const PAPER_ACCOUNT_MONITOR_OUTPUT_FILE = path.join(ROOT, "dashboard", "data", "paper-account-monitor.json");
const PAPER_RECONCILIATION_FILE = path.join(OCEAN_TRADING_DIR, `paper-trade-reconciliation-${new Date().toISOString().slice(0, 10)}.md`);
const PAPER_MANUAL_HISTORY_ARCHIVE_DIR = path.join(PAPER_SIERRA_ROOT, "TradeActivityLogs_ExcludedManualHistory_20260516");
const PAPER_TRADING_CLEAN_START_FILE = path.join(ROOT, "dashboard", "data", "paper-trading-clean-start.json");
const PAPER_HYGIENE_ARTIFACT = path.join(OCEAN_TRADING_DIR, "paper-trading-data-hygiene-2026-05-16.md");
const LUCID_RULES_ARTIFACT = path.join(OCEAN_TRADING_DIR, "lucid-flex-50k-risk-profile.md");
const REPLAY_SESSION_RESET_BACKTRACK_MS = 5 * 60 * 1000;

function findPaperclipRepoRoot(startDir, relativePath = REPLAY_CONNECTOR_RELATIVE_PATH) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, relativePath))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const PAPERCLIP_REPO_ROOT = findPaperclipRepoRoot(ROOT);
const REPLAY_CONNECTOR_MODULE_PATH = PAPERCLIP_REPO_ROOT
  ? path.join(PAPERCLIP_REPO_ROOT, REPLAY_CONNECTOR_RELATIVE_PATH)
  : null;
const PAPER_TRADE_ATTRIBUTION_MODULE_PATH = PAPERCLIP_REPO_ROOT
  ? path.join(PAPERCLIP_REPO_ROOT, PAPER_TRADE_ATTRIBUTION_RELATIVE_PATH)
  : null;
async function importOptionalModule(modulePath) {
  if (!modulePath) return null;
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    return {
      __importError: String(error?.message || error),
    };
  }
}

const replayConnector = await importOptionalModule(REPLAY_CONNECTOR_MODULE_PATH);
const paperTradeAttribution = await importOptionalModule(PAPER_TRADE_ATTRIBUTION_MODULE_PATH);

function buildDefaultSierraSymbolConfig() {
  return {
    paper: {
      root: PAPER_SIERRA_ROOT,
      chartbook: path.join(PAPER_SIERRA_ROOT, "Data", "OceanTrading-PaperTrading.cht"),
      dataFolder: path.join(PAPER_SIERRA_ROOT, "Data"),
      symbol: "MNQM26_FUT_CME",
      displaySymbol: "MNQM26_FUT_CME[M]",
      dataFile: path.join(PAPER_SIERRA_ROOT, "Data", "MNQM26_FUT_CME.scid"),
      account: "Sim1",
      dataPort: 11298,
      tradingPort: 11299,
      service: "Teton CME Routing",
      updatedAt: "2026-05-17",
    },
    live: {
      root: LIVE_SIERRA_ROOT,
      dataFolder: path.join(LIVE_SIERRA_ROOT, "Data"),
      dataPort: 11098,
      tradingPort: 11099,
    },
    replay: {
      root: REPLAY_SIERRA_ROOT,
      tradeActivityLogDir: REPLAY_TRADE_LOG_DIR,
      account: "Sim1",
    },
  };
}

function readSierraSymbolConfig() {
  const defaults = buildDefaultSierraSymbolConfig();
  const configured = readJson(SIERRA_SYMBOL_CONFIG_FILE, {});
  return {
    ...defaults,
    ...configured,
    paper: {
      ...defaults.paper,
      ...(configured.paper || {}),
    },
    live: {
      ...defaults.live,
      ...(configured.live || {}),
    },
    replay: {
      ...defaults.replay,
      ...(configured.replay || {}),
    },
  };
}

const MARKDOWN_FIELD_RE = /^- ([^:]+):\s*`?([^`]+)`?\s*$/;

function listFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(dir, entry.name),
      absPath: path.resolve(path.join(dir, entry.name)),
    }))
    .filter((entry) => predicate(entry))
    .sort((a, b) => fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs);
}

function findLatestByPattern(dir, pattern) {
  const file = listFiles(dir, (entry) => pattern.test(entry.name))[0];
  return file ? file.absPath : null;
}

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    let renamed = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        renamed = true;
        break;
      } catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    if (!renamed) {
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function basename(filePath) {
  return path.basename(String(filePath || "unknown"));
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function normalizeSqliteTimestampGlobal(value) {
  const text = cleanText(value);
  if (!text) return null;
  return text.includes("T") ? text : text.replace(" ", "T").replace(/$/, "Z");
}

function londonOffsetMsForUtc(utcMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs)).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const londonAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return londonAsUtc - Math.trunc(utcMs / 1000) * 1000;
}

function sierraSerialToUtcIsoGlobal(value) {
  const text = cleanText(value);
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return normalizeSqliteTimestampGlobal(text);
  if (number <= 1) return null;
  const londonWallMs = Date.UTC(1899, 11, 30) + number * 24 * 60 * 60 * 1000;
  let utcMs = londonWallMs - londonOffsetMsForUtc(londonWallMs);
  utcMs = londonWallMs - londonOffsetMsForUtc(utcMs);
  return new Date(utcMs).toISOString();
}

function parseReplaySessionClock(value) {
  const text = cleanText(value);
  if (!text) return null;
  const isoCandidate = text.includes("T") ? text : text.replace(" ", "T");
  const stamped = /Z$/i.test(isoCandidate) ? isoCandidate : `${isoCandidate}Z`;
  const millis = Date.parse(stamped);
  return Number.isFinite(millis) ? millis : null;
}

function parseReplayObservationTime(value) {
  const text = cleanText(value);
  if (!text) return { observedAtUtc: null, observedAtMs: null };
  const normalized = text.replace(/\s+/g, " ").trim().replace(" ", "T");
  const millis = Date.parse(normalized);
  if (!Number.isFinite(millis)) return { observedAtUtc: null, observedAtMs: null };
  return { observedAtUtc: new Date(millis).toISOString(), observedAtMs: millis };
}

function replayChartDateKeyFromUtc(value) {
  const text = cleanText(value);
  const stamped = text && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const millis = Date.parse(stamped);
  if (!Number.isFinite(millis)) return cleanText(text?.slice(0, 10));
  const date = new Date(millis);
  const month = date.getUTCMonth() + 1;
  const isUkDst = month > 3 && month < 11;
  const chartMillis = millis + (isUkDst ? 60 * 60 * 1000 : 0);
  return new Date(chartMillis).toISOString().slice(0, 10);
}

function parseCsvRecord(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < String(line || "").length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

function readCsvObjects(filePath) {
  const text = readText(filePath)?.replace(/^\uFEFF/, "");
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = parseCsvRecord(lines.shift() || "").map((header) => cleanText(header) || "");
  return lines.map((line) => {
    const values = parseCsvRecord(line);
    return headers.reduce((row, header, index) => {
      if (header) row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function readReplayMonitorState() {
  return readJson(REPLAY_MONITOR_STATE_FILE, {
    version: 1,
    currentSessionId: null,
    currentSessionFingerprint: null,
    clearedSessionId: null,
    clearedAtUtc: null,
    lastObserved: null,
    accounts: {},
  });
}

function createReplaySessionFingerprint(snapshot) {
  return [
    snapshot.replayAccountId || "all-accounts",
    snapshot.controllerCommandId || "no-controller-command",
    snapshot.requestedStartDateTime || snapshot.effectiveStartDateTime || "no-requested-start",
  ].join("|");
}

function normalizeReplayAccountId(value) {
  const text = cleanText(value);
  const match = text.match(/^sim\s*(\d+)$/i);
  return match ? `Sim${match[1]}` : text || "Sim1";
}

function replayAccountLabel(accountId) {
  return normalizeReplayAccountId(accountId).replace(/^Sim(\d+)$/i, "SIM $1");
}

function parseReplayAccountFromTradeLog(filePath) {
  const match = basename(filePath || "").match(/^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\.([^.]+?)(?:\.simulated)?\.data$/i);
  return match ? normalizeReplayAccountId(match[1]) : null;
}

function replayAccountSortValue(accountId) {
  const match = normalizeReplayAccountId(accountId).match(/^Sim(\d+)$/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function isReplayAccountId(value) {
  const accountId = normalizeReplayAccountId(value);
  return Boolean(accountId && accountId !== "None" && /^[A-Za-z0-9_-]+$/.test(accountId));
}

function discoverReplayAccountIds({
  sourceAccounts = [],
  rawRowsByAccount = new Map(),
  logsByAccount = new Map(),
  persistedAccounts = {},
  activeReplayAccountId = null,
  fallbackAccountIds = ["Sim1", "Sim2", "Sim3", "Sim4", "Sim5"],
} = {}) {
  const ids = new Set();
  const add = (value) => {
    const accountId = normalizeReplayAccountId(value);
    if (isReplayAccountId(accountId)) ids.add(accountId);
  };

  for (const account of sourceAccounts || []) add(account?.accountId);
  for (const accountId of rawRowsByAccount.keys()) add(accountId);
  for (const accountId of logsByAccount.keys()) add(accountId);
  for (const accountId of Object.keys(persistedAccounts || {})) add(accountId);
  add(activeReplayAccountId);

  const discovered = [...ids].sort((a, b) => replayAccountSortValue(a) - replayAccountSortValue(b) || a.localeCompare(b));
  if (discovered.length) return discovered;
  return fallbackAccountIds.map((accountId) => normalizeReplayAccountId(accountId)).filter(isReplayAccountId);
}

function replayAccountState(accountId, existing = {}) {
  return {
    accountId: normalizeReplayAccountId(accountId),
    label: replayAccountLabel(accountId),
    currentSessionId: existing.currentSessionId || null,
    currentSessionFingerprint: existing.currentSessionFingerprint || null,
    clearedSessionId: existing.clearedSessionId || null,
    clearedAtUtc: existing.clearedAtUtc || null,
    lastObserved: existing.lastObserved || null,
    telemetryScope: existing.telemetryScope || null,
    groupedTrades: Array.isArray(existing.groupedTrades) ? existing.groupedTrades : [],
  };
}

function detectReplaySessionReset(previous, current) {
  if (!previous) {
    return { reset: true, reason: "initial_replay_session" };
  }
  if (
    current.controllerAction === "start"
    && current.controllerCommandId
    && current.controllerCommandId !== previous.controllerCommandId
  ) {
    return { reset: true, reason: "replay_start_command_changed" };
  }
  if (
    Number.isFinite(previous.chartTimeMs)
    && Number.isFinite(current.chartTimeMs)
    && current.chartTimeMs < previous.chartTimeMs - REPLAY_SESSION_RESET_BACKTRACK_MS
  ) {
    return { reset: true, reason: "replay_chart_time_moved_backwards" };
  }
  if (
    Number.isFinite(previous.replayEventCount)
    && Number.isFinite(current.replayEventCount)
    && current.replayEventCount < previous.replayEventCount
  ) {
    return { reset: true, reason: "replay_event_count_dropped" };
  }
  return { reset: false, reason: "replay_session_continues" };
}

function normalizeReplayGroupedTrade(event, sessionId, index) {
  const replayAccountId = normalizeReplayAccountId(event?.replayAccountId || event?.context?.replayAccountId || "Sim1");
  const targets = Array.isArray(event?.targetPlan) ? event.targetPlan : [];
  const observation = parseReplayObservationTime(
    event?.context?.closeTimestamp
    || event?.context?.barTime
    || event?.outcome?.exitKey
    || event?.entryKey,
  );
  return {
    replaySessionId: sessionId,
    tradeId: `${sessionId || "replay"}:${replayAccountId}:${event?.entryKey || index}`,
    entryKey: event?.entryKey || null,
    lucidSessionDay: cleanText(event?.lucidSessionDay || event?.sessionDay),
    observedAtUtc: observation.observedAtUtc,
    observedAtMs: observation.observedAtMs,
    direction: cleanText(event?.direction),
    entry: Number.isFinite(Number(event?.entry)) ? Number(event.entry) : null,
    initialStop: Number.isFinite(Number(event?.initialStop)) ? Number(event.initialStop) : null,
    targetPlan: targets,
    targetPlanLabel: targets.length
      ? targets.map((target) => `${target.contracts ?? "?"}@${target.r ?? "?"}R`).join(", ")
      : null,
    hermesProfile: cleanText(event?.hermesProfile),
    hermesAction: cleanText(event?.hermesAction),
    exitReason: cleanText(event?.outcome?.exitReason),
    completionStatus: cleanText(event?.outcome?.completionStatus),
    realizedPnlDollars: Number.isFinite(Number(event?.outcome?.pnl)) ? Number(Number(event.outcome.pnl).toFixed(2)) : null,
    replayAccountId,
    replayAccountLabel: cleanText(event?.replayAccountLabel || event?.context?.replayAccountLabel || replayAccountLabel(replayAccountId)),
    sourceTradeLogAccount: normalizeReplayAccountId(event?.sourceTradeLogAccount || event?.context?.replayAccountId || replayAccountId),
    source: "sierra_replay_connector",
  };
}

function replayAccountSummary(rows, account) {
  const accountRows = rows.filter((trade) => trade.replayAccountId === account.accountId);
  const realizedRows = accountRows.filter((trade) =>
    Number.isFinite(Number(trade.realizedPnlDollars)) &&
    String(trade.completionStatus || "").toLowerCase() !== "open"
  );
  return {
    ...account,
    groupedTradesVisibleCount: accountRows.length,
    realizedTrades: realizedRows.length,
    closedNetPnlDollars: Number(realizedRows.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0).toFixed(2)),
    openPnlDollars: Number(Number(account.openPnlDollars || 0).toFixed(2)),
    netPnlDollars: Number((realizedRows.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0) + Number(account.openPnlDollars || 0)).toFixed(2)),
  };
}

function replayTradeActivityLogDir() {
  const config = readSierraSymbolConfig();
  return config.replay?.tradeActivityLogDir || path.join(config.replay?.root || REPLAY_SIERRA_ROOT, "TradeActivityLogs");
}

function replayConnectorControlDir() {
  const config = readSierraSymbolConfig();
  return config.replay?.connectorControlDir
    || path.join(config.replay?.root || REPLAY_SIERRA_ROOT, "connector-control", "oql-vwap-replay-isolated");
}

function replayControllerStatusFile() {
  return path.join(replayConnectorControlDir(), "vwap-replay-status.txt");
}

function parseKeyValueStatus(text) {
  const status = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([^=\s]+)=(.*)$/);
    if (!match) continue;
    status[match[1].trim()] = match[2].trim();
  }
  return status;
}

function readReplayControllerStatus() {
  const statusPath = replayControllerStatusFile();
  const status = parseKeyValueStatus(readText(statusPath));
  const statusMtimeMs = fs.existsSync(statusPath) ? fs.statSync(statusPath).mtimeMs : null;
  return Object.keys(status).length ? { status, statusPath, statusMtimeMs } : { status: {}, statusPath, statusMtimeMs };
}

function replayLogsDir() {
  const config = readSierraSymbolConfig();
  return config.replay?.logsDir || path.join(config.replay?.root || REPLAY_SIERRA_ROOT, "Logs");
}

function replayDataDir() {
  const config = readSierraSymbolConfig();
  return config.replay?.dataDir || path.join(config.replay?.root || REPLAY_SIERRA_ROOT, "Data");
}

function replayTradeDateFromFile(filePath) {
  return cleanText(basename(filePath || "").match(/^TradeActivityLog_(\d{4}-\d{2}-\d{2})_UTC\./i)?.[1]);
}

function replayChartTimeToUtc(chartTime) {
  const match = cleanText(chartTime)?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const isUkDst = month > 3 && month < 11;
  const millis = Date.UTC(year, month - 1, day, hour - (isUkDst ? 1 : 0), minute, second);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function replayScidPathForSymbol(symbol) {
  const text = cleanText(symbol) || "MNQM26-CME";
  const candidates = [
    path.join(replayDataDir(), `${text}.scid`),
    path.join(replayDataDir(), `${text.replace("_FUT_", "-").replace(/_/g, "-")}.scid`),
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function readReplayScidCloseAt(symbol, utcIso) {
  const file = replayScidPathForSymbol(symbol);
  const targetMs = Date.parse(utcIso);
  if (!file || !Number.isFinite(targetMs)) return null;
  const epochMs = Date.UTC(1899, 11, 30);
  const targetSierraMs = targetMs - epochMs;
  const headerBytes = 56;
  const recordBytes = 40;
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const count = Math.floor((stat.size - headerBytes) / recordBytes);
    const buffer = Buffer.alloc(recordBytes);
    const readRecord = (index) => {
      fs.readSync(fd, buffer, 0, recordBytes, headerBytes + index * recordBytes);
      return {
        ms: Number(buffer.readBigInt64LE(0)) / 1000,
        close: buffer.readFloatLE(20),
      };
    };
    let low = 0;
    let high = count - 1;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const record = readRecord(mid);
      if (record.ms <= targetSierraMs) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const record = readRecord(best);
    return Number.isFinite(record.close) && Math.abs(record.close) < 1000000 ? record.close : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readReplaySierraWindowSnapshot() {
  const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$process = Get-Process SierraChart_64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*SierraChart-Replay*' } | Select-Object -First 1
if (-not $process -or -not $process.MainWindowHandle) { Write-Output '{}'; exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$items = New-Object System.Collections.Generic.List[string]
function Walk($element, [int]$depth) {
  if ($null -eq $element -or $depth -gt 8) { return }
  $name = [string]$element.Current.Name
  if ($name) { $script:items.Add($name) }
  $child = $walker.GetFirstChild($element)
  while ($child) {
    Walk $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}
Walk $root 0
$npl = $items | Where-Object { $_ -match '^N:-?[0-9,.]+C,' } | Select-Object -First 1 | ForEach-Object { [string]$_ }
$trade = $items | Where-Object { $_ -match '^\[Sim\d+\]\s+Trade:' } | Select-Object -First 1 | ForEach-Object { [string]$_ }
$account = $items | Where-Object { $_ -match '^Sim\d+$' } | Select-Object -First 1 | ForEach-Object { [string]$_ }
[pscustomobject]@{
  account = $account
  netProfitLossText = $npl
  tradeText = $trade
  windowTitle = $process.MainWindowTitle
} | ConvertTo-Json -Compress
`;
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    ).trim();
    const snapshot = output ? JSON.parse(output) : {};
    const nplText = cleanText(snapshot.netProfitLossText);
    const npl = Number(nplText?.match(/^N:([-0-9,.]+)C,/i)?.[1]?.replace(/,/g, ""));
    if (!Number.isFinite(npl)) return null;
    const account = isReplayAccountId(normalizeReplayAccountId(snapshot.account))
      ? normalizeReplayAccountId(snapshot.account)
      : normalizeReplayAccountId(nplText?.match(/\bSim\d+\b/i)?.[0] || "Sim1");
    return {
      account,
      netProfitLossDollars: Number(npl.toFixed(2)),
      netProfitLossText: nplText,
      tradeText: cleanText(snapshot.tradeText),
      windowTitle: cleanText(snapshot.windowTitle),
      source: "sierra_replay_window_ui_automation",
      updatedAtUtc: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function replayActiveTradeDateKey(controllerStatus) {
  const chartDateTime = cleanText(controllerStatus?.currentChartDateTime);
  return cleanText(chartDateTime?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]);
}

function parseReplayCommandTimestamp(commandId) {
  const match = cleanText(commandId)?.match(/-(\d{8}T\d{6}Z)(?:-|$)/i);
  if (!match) return null;
  const text = match[1].replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i,
    "$1-$2-$3T$4:$5:$6Z",
  );
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? millis : null;
}

function parseReplayMessageLogWallTimeMs(line) {
  const match = cleanText(line)?.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return null;
  const millis = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number((match[7] || "0").padEnd(3, "0")),
  ).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function inferReplayRunStartDateFromMessageLogs(controllerStatus) {
  const commandStartedAtMs = parseReplayCommandTimestamp(controllerStatus?.commandId);
  if (!Number.isFinite(commandStartedAtMs)) return null;
  const candidates = [];
  for (const file of replayRunMessageLogFiles(controllerStatus)) {
    const text = readText(file.absPath);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/Chart:\s+Replay\b/i.test(line) || !/VWAP Wave Pullback/i.test(line)) continue;
      const wallTimeMs = parseReplayMessageLogWallTimeMs(line);
      if (Number.isFinite(wallTimeMs) && wallTimeMs < commandStartedAtMs) continue;
      const barTime = cleanText(line.match(/\bbar_time=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1]);
      const signalTime = cleanText(line.match(/\bsignal_time=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1]);
      const dateKey = cleanText((barTime || signalTime)?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]);
      if (dateKey) candidates.push(dateKey);
    }
  }
  return candidates.sort()[0] || null;
}

function replayDateKeyToMs(dateKey) {
  const match = cleanText(dateKey)?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const millis = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(millis) ? millis : null;
}

function replayDateKeyFromParts(year, month, day) {
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString().slice(0, 10);
}

function parseReplayRunDateWindow(controllerStatus) {
  const commandId = cleanText(controllerStatus?.commandId);
  const currentDateKey = replayActiveTradeDateKey(controllerStatus);
  const currentYear = Number(currentDateKey?.slice(0, 4)) || new Date().getUTCFullYear();
  const inferredStartKey = inferReplayRunStartDateFromMessageLogs(controllerStatus);
  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const namedRange = commandId?.match(/(?:^|[_-])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{2})_(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{2})(?:[_-]|$)/i);
  if (namedRange) {
    const commandStartKey = replayDateKeyFromParts(currentYear, monthMap[namedRange[1].toLowerCase()], Number(namedRange[2]));
    const startKey = minReplayDateKey(commandStartKey, inferredStartKey);
    const endKey = replayDateKeyFromParts(currentYear, monthMap[namedRange[3].toLowerCase()], Number(namedRange[4]));
    return { startKey, endKey, reason: inferredStartKey && inferredStartKey !== commandStartKey ? "message_log_inferred_run_start" : "controller_command_date_range" };
  }

  const compactRange = commandId?.match(/(?:^|[_-])(20\d{6})_(\d{4})(?:[_-]|$)/);
  if (compactRange) {
    const commandStartKey = compactRange[1].replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
    const startKey = minReplayDateKey(commandStartKey, inferredStartKey);
    return { startKey, endKey: currentDateKey || startKey, reason: inferredStartKey && inferredStartKey !== commandStartKey ? "message_log_inferred_run_start" : "controller_command_start_date" };
  }

  return { startKey: inferredStartKey || currentDateKey, endKey: currentDateKey, reason: inferredStartKey ? "message_log_inferred_run_start" : "controller_current_chart_date" };
}

function maxReplayDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return replayDateKeyToMs(a) >= replayDateKeyToMs(b) ? a : b;
}

function minReplayDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return replayDateKeyToMs(a) <= replayDateKeyToMs(b) ? a : b;
}

function isReplayDateInWindow(dateKey, window) {
  const dateMs = replayDateKeyToMs(dateKey);
  const startMs = replayDateKeyToMs(window?.startKey);
  const endMs = replayDateKeyToMs(window?.endKey);
  if (!Number.isFinite(dateMs)) return false;
  if (Number.isFinite(startMs) && dateMs < startMs) return false;
  if (Number.isFinite(endMs) && dateMs > endMs) return false;
  return true;
}

function selectActiveReplayTradeFiles(files, controllerStatus) {
  const statusText = String(controllerStatus?.status || "").toLowerCase();
  const actionText = String(controllerStatus?.action || "").toLowerCase();
  const controllerActive = statusText === "status" && actionText === "status" && String(controllerStatus?.isReplayRunning).toLowerCase() === "true";
  const runWindow = parseReplayRunDateWindow(controllerStatus);
  const commandStartedAtMs = parseReplayCommandTimestamp(controllerStatus?.commandId);
  const commandMtimeFloorMs = Number.isFinite(commandStartedAtMs) ? commandStartedAtMs - REPLAY_SESSION_RESET_BACKTRACK_MS : null;
  if (!controllerActive && files.length) {
    const latestFile = [...files].sort((a, b) => fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs)[0];
    const latestMtimeMs = fs.statSync(latestFile.absPath).mtimeMs;
    const latestAccount = parseReplayAccountFromTradeLog(latestFile.absPath);
    const latestDateKey = replayTradeDateFromFile(latestFile.absPath);
    const latestMonthKey = latestDateKey?.slice(0, 7);
    const freshFloorMs = latestMtimeMs - 48 * 60 * 60 * 1000;
    const freshFiles = files.filter((file) =>
      parseReplayAccountFromTradeLog(file.absPath) === latestAccount
      && replayTradeDateFromFile(file.absPath)?.startsWith(latestMonthKey)
      && fs.statSync(file.absPath).mtimeMs >= freshFloorMs
    );
    const dateKeys = [...new Set(freshFiles.map((file) => replayTradeDateFromFile(file.absPath)).filter(Boolean))].sort();
    if (freshFiles.length && dateKeys.length) {
      return {
        files: freshFiles,
        activeDateKey: dateKeys.at(-1),
        startDateKey: dateKeys[0],
        endDateKey: dateKeys.at(-1),
        commandStartedAtMs: null,
        reason: "latest_fresh_trade_activity_when_controller_inactive",
      };
    }
  }
  const windowFiles = files.filter((file) => isReplayDateInWindow(replayTradeDateFromFile(file.absPath), runWindow));
  const latestWindowFile = [...windowFiles].sort((a, b) => fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs)[0] || null;
  const activeWindowAccount = parseReplayAccountFromTradeLog(latestWindowFile?.absPath);
  const accountWindowFiles = activeWindowAccount
    ? windowFiles.filter((file) => parseReplayAccountFromTradeLog(file.absPath) === activeWindowAccount)
    : windowFiles;
  if (/date_range/.test(runWindow.reason) && accountWindowFiles.length) {
    return {
      files: accountWindowFiles,
      activeDateKey: runWindow.endKey,
      startDateKey: runWindow.startKey,
      endDateKey: runWindow.endKey,
      commandStartedAtMs,
      reason: `${runWindow.reason}_all_window_files`,
    };
  }
  const freshWindowFiles = Number.isFinite(commandMtimeFloorMs)
    ? windowFiles.filter((file) => fs.statSync(file.absPath).mtimeMs >= commandMtimeFloorMs)
    : windowFiles;
  if (freshWindowFiles.length) {
    return {
      files: freshWindowFiles,
      activeDateKey: runWindow.endKey,
      startDateKey: runWindow.startKey,
      endDateKey: runWindow.endKey,
      commandStartedAtMs,
      reason: `${runWindow.reason}_fresh_run_files`,
    };
  }
  if (windowFiles.length) {
    return {
      files: windowFiles,
      activeDateKey: runWindow.endKey,
      startDateKey: runWindow.startKey,
      endDateKey: runWindow.endKey,
      commandStartedAtMs,
      reason: runWindow.reason,
    };
  }

  if (!controllerActive && files.length) {
    const latestFile = [...files].sort((a, b) => fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs)[0];
    const latestMtimeMs = fs.statSync(latestFile.absPath).mtimeMs;
    const latestAccount = parseReplayAccountFromTradeLog(latestFile.absPath);
    const latestDateKey = replayTradeDateFromFile(latestFile.absPath);
    const latestMonthKey = latestDateKey?.slice(0, 7);
    const freshFloorMs = latestMtimeMs - 48 * 60 * 60 * 1000;
    const freshFiles = files.filter((file) =>
      parseReplayAccountFromTradeLog(file.absPath) === latestAccount
      && replayTradeDateFromFile(file.absPath)?.startsWith(latestMonthKey)
      && fs.statSync(file.absPath).mtimeMs >= freshFloorMs
    );
    const dateKeys = [...new Set(freshFiles.map((file) => replayTradeDateFromFile(file.absPath)).filter(Boolean))].sort();
    if (freshFiles.length && dateKeys.length) {
      return {
        files: freshFiles,
        activeDateKey: dateKeys.at(-1),
        startDateKey: dateKeys[0],
        endDateKey: dateKeys.at(-1),
        commandStartedAtMs: null,
        reason: "latest_fresh_trade_activity_when_controller_stopped",
      };
    }
  }

  const activeDateKey = replayActiveTradeDateKey(controllerStatus);
  if (activeDateKey) {
    const activeDateFiles = files.filter((file) => replayTradeDateFromFile(file.absPath) === activeDateKey);
    if (activeDateFiles.length) {
      return {
        files: activeDateFiles,
        activeDateKey,
        reason: "controller_current_chart_date",
      };
    }
  }

  const latestFile = [...files].sort((a, b) => fs.statSync(b.absPath).mtimeMs - fs.statSync(a.absPath).mtimeMs)[0] || null;
  const latestDateKey = replayTradeDateFromFile(latestFile?.absPath);
  return {
    files: latestDateKey ? files.filter((file) => replayTradeDateFromFile(file.absPath) === latestDateKey) : files,
    activeDateKey: latestDateKey,
    reason: latestDateKey ? "latest_trade_activity_date" : "all_trade_activity_files",
  };
}

function isReplayTradeActivityFile(entry) {
  return /^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\.(?!None\.)([^.]+?)(?:\.simulated)?\.data$/i.test(entry.name);
}

function parseReplayTradeActivityFile(file) {
  const parsed = parsePaperTradeActivityFile(file);
  const events = parsed.length ? parsed : parseLiveTradeActivityFile(file);
  return events.map((event) => {
    const accountId = normalizeReplayAccountId(event.account || parseReplayAccountFromTradeLog(file.absPath));
    return {
      ...event,
      account: accountId,
      replayAccountId: accountId,
      replayAccountLabel: replayAccountLabel(accountId),
      sourceTradeLogAccount: accountId,
      tradeSource: event.tradeSource || "replay",
      dashboardBucket: "replay",
      approvalStatus: "replay",
    };
  });
}

function isExistingFlattenFillNear(fillEvents, marker) {
  const markerMs = Date.parse(marker.tradeDateUtc);
  if (!Number.isFinite(markerMs)) return false;
  return fillEvents.some((fill) => {
    const fillMs = Date.parse(fill.tradeDateUtc);
    if (!Number.isFinite(fillMs) || Math.abs(fillMs - markerMs) > 10 * 60 * 1000) return false;
    if (normalizeReplayAccountId(fill.account) !== marker.account) return false;
    if (normalizeSymbolKey(fill.symbol) !== normalizeSymbolKey(marker.symbol)) return false;
    const previous = Number(fill.previousPosition);
    const after = Number(fill.positionAfter);
    return Number.isFinite(previous) && Number.isFinite(after) && previous !== 0 && after === 0;
  });
}

function parseReplayForceFlatMarkers(controllerStatus, fillEvents) {
  const commandStartedAtMs = parseReplayCommandTimestamp(controllerStatus?.commandId);
  const floorMs = Number.isFinite(commandStartedAtMs) ? commandStartedAtMs - REPLAY_SESSION_RESET_BACKTRACK_MS : 0;
  const currentChartUtc = replayChartTimeToUtc(controllerStatus?.currentChartDateTime);
  const currentChartMs = Date.parse(currentChartUtc);
  const logFiles = replayRunMessageLogFiles(controllerStatus);
  const markers = [];
  for (const file of logFiles) {
    const text = readText(file.absPath);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/Chart:\s+Replay\b/i.test(line)) continue;
      const wallTimeMs = parseReplayMessageLogWallTimeMs(line);
      if (Number.isFinite(commandStartedAtMs) && Number.isFinite(wallTimeMs) && wallTimeMs < commandStartedAtMs) continue;
      if (!/session boundary force flat/i.test(line)) continue;
      if (!/active_entry=/i.test(line)) continue;
      const barTime = cleanText(line.match(/bar_time=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1]);
      const tradeDateUtc = replayChartTimeToUtc(barTime);
      const positionQty = Number(line.match(/position_qty=([-\d.]+)/)?.[1]);
      if (!tradeDateUtc || !Number.isFinite(positionQty) || positionQty === 0) continue;
      if (Number.isFinite(currentChartMs) && Date.parse(tradeDateUtc) > currentChartMs) continue;
      const symbol = cleanText(line.match(/Chart:\s+Replay[^:]*:\s*([A-Z0-9-]+)\[/)?.[1]) || "MNQM26-CME";
      const account = "Sim1";
      const price = readReplayScidCloseAt(symbol, tradeDateUtc);
      if (!Number.isFinite(price)) continue;
      const marker = {
        tradeDateUtc,
        account,
        symbol,
        price,
        positionQty,
        sourceFile: file.absPath,
      };
      if (!isExistingFlattenFillNear(fillEvents, marker)) markers.push(marker);
    }
  }
  return markers;
}

function replayRunMessageLogFiles(controllerStatus) {
  const commandStartedAtMs = parseReplayCommandTimestamp(controllerStatus?.commandId);
  const floorMs = Number.isFinite(commandStartedAtMs) ? commandStartedAtMs - REPLAY_SESSION_RESET_BACKTRACK_MS : 0;
  return listFiles(replayLogsDir(), (entry) => /^Message Log .*\.log$/i.test(entry.name))
    .filter((file) => fs.statSync(file.absPath).mtimeMs >= floorMs)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function applyReplaySyntheticForceFlatFills(fillEvents, controllerStatus) {
  const markers = parseReplayForceFlatMarkers(controllerStatus, fillEvents);
  if (!markers.length) return { fillEvents, syntheticFills: [] };
  const items = [
    ...fillEvents.map((fill) => ({ type: "fill", tradeDateUtc: fill.tradeDateUtc, fill })),
    ...markers.map((marker) => ({ type: "marker", tradeDateUtc: marker.tradeDateUtc, marker })),
  ].sort((a, b) => String(a.tradeDateUtc || "").localeCompare(String(b.tradeDateUtc || "")));
  const positions = new Map();
  const enhanced = [];
  const syntheticFills = [];
  for (const item of items) {
    if (item.type === "fill") {
      const fill = item.fill;
      enhanced.push(fill);
      const key = `${normalizeReplayAccountId(fill.account)}|${normalizeSymbolKey(fill.symbol)}`;
      const after = Number(fill.positionAfter);
      if (Number.isFinite(after)) positions.set(key, after);
      continue;
    }
    const marker = item.marker;
    const key = `${marker.account}|${normalizeSymbolKey(marker.symbol)}`;
    const currentPosition = Number(positions.get(key));
    const closingPosition = Number.isFinite(currentPosition) && currentPosition !== 0 ? currentPosition : marker.positionQty;
    if (!Number.isFinite(closingPosition) || closingPosition === 0) continue;
    const synthetic = {
      sequence: enhanced.length + syntheticFills.length + 1,
      eventType: "fill",
      sourceFile: marker.sourceFile,
      tradeDateUtc: marker.tradeDateUtc,
      account: marker.account,
      symbol: marker.symbol,
      chartbook: "OceanTrading-Replay",
      price: marker.price,
      side: closingPosition > 0 ? "Sell" : "Buy",
      quantity: Math.abs(closingPosition),
      positionAfter: 0,
      previousPosition: closingPosition,
      internalOrderId: `synthetic-force-flat-${marker.tradeDateUtc}`,
      status: "Synthetic replay force-flat fill reconstructed from Sierra message log",
      tradeSource: "strategy",
      strategyName: "VWAP Wave Pullback",
      strategyStudy: "VWAP Wave Pullback",
      approvalStatus: "replay",
      dashboardBucket: "replay",
    };
    enhanced.push(synthetic);
    syntheticFills.push(synthetic);
    positions.set(key, 0);
  }
  return { fillEvents: enhanced, syntheticFills };
}

function valueReplayOpenPositionsAtCurrentChartTime(openPositions, controllerStatus) {
  const currentChartDateTime = cleanText(controllerStatus?.currentChartDateTime);
  const currentUtc = replayChartTimeToUtc(currentChartDateTime);
  if (!currentUtc) return openPositions;
  return openPositions.map((position) => {
    const price = readReplayScidCloseAt(position.symbol, currentUtc);
    if (!Number.isFinite(price)) return position;
    const quantity = Number(position.quantity) || 0;
    const avg = Number(position.averageEntryPrice);
    if (!quantity || !Number.isFinite(avg)) return position;
    const points = position.side === "Short" ? avg - price : price - avg;
    return {
      ...position,
      latestPrice: Number(price.toFixed(4)),
      unrealizedPnlDollars: Number((points * quantity * contractMultiplier(position.symbol)).toFixed(2)),
      lastUpdatedUtc: currentUtc,
      valuationSource: "sierra_scid_current_chart_time",
    };
  });
}

function replayLifecycleKeyFromCommandId(controllerStatus) {
  const commandId = cleanText(controllerStatus?.commandId);
  return cleanText(commandId?.match(/(v\d+_profile\d+_[a-z]{3}\d{2}_[a-z]{3}\d{2}_mn-[0-9a-f]+)/i)?.[1]);
}

function listReplayLifecycleCsvFiles() {
  if (!fs.existsSync(OQL_VWAP_REPLAY_EXPERIMENTS_DIR)) return [];
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, depth + 1);
        continue;
      }
      if (entry.isFile() && /lifecycle\.csv$/i.test(entry.name)) {
        found.push({ absPath, name: entry.name, mtimeMs: fs.statSync(absPath).mtimeMs });
      }
    }
  };
  walk(OQL_VWAP_REPLAY_EXPERIMENTS_DIR);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findReplayLifecycleCsv(controllerStatus) {
  const key = replayLifecycleKeyFromCommandId(controllerStatus);
  const files = listReplayLifecycleCsvFiles();
  if (key) {
    const exact = files.find((file) => file.name.toLowerCase().includes(key.toLowerCase()));
    if (exact) return exact;
  }
  const runWindow = parseReplayRunDateWindow(controllerStatus);
  const preferredMonth = cleanText(runWindow.startKey?.slice(0, 7));
  const monthName = preferredMonth === "2026-05" ? /may/i : null;
  return files.find((file) => !monthName || monthName.test(file.absPath)) || null;
}

function replayLifecycleChartDateKey(row) {
  return cleanText(row?.chart_time || row?.bar_time)?.slice(0, 10);
}

function isReplayLifecycleRowInWindow(row, activeSelection) {
  const dateKey = replayLifecycleChartDateKey(row);
  const dateMs = replayDateKeyToMs(dateKey);
  const startMs = replayDateKeyToMs(activeSelection?.startDateKey);
  const endMs = replayDateKeyToMs(activeSelection?.endDateKey);
  if (!Number.isFinite(dateMs)) return false;
  if (Number.isFinite(startMs) && dateMs < startMs) return false;
  if (Number.isFinite(endMs) && dateMs >= endMs) return false;
  return true;
}

function buildReplayClosedTradesFromLifecycleCsv(controllerStatus, activeSelection) {
  const file = findReplayLifecycleCsv(controllerStatus);
  if (!file?.absPath || !fs.existsSync(file.absPath)) return { closedTrades: [], sourceFile: null };
  const rows = readCsvObjects(file.absPath);
  const closedTrades = rows
    .filter((row) => cleanText(row.event) === "exit_fill")
    .filter((row) => isReplayLifecycleRowInWindow(row, activeSelection))
    .map((row, index) => {
      const direction = cleanText(row.direction)?.toLowerCase();
      const chartTime = cleanText(row.chart_time || row.bar_time);
      const chartIso = chartTime ? chartTime.replace(" ", "T") : null;
      const account = normalizeReplayAccountId(row.trade_account || "Sim1");
      const pnl = Number(row.pnl);
      const entry = Number(row.entry);
      const exit = Number(row.exit_price);
      const quantity = Number(row.qty);
      return {
        tradeDateUtc: chartIso,
        entryAtUtc: chartIso,
        exitAtUtc: chartIso,
        account,
        symbol: "MNQU26_FUT_CME",
        tradeSource: "strategy",
        strategyName: "VWAP Wave Pullback",
        strategyStudy: "VWAP Wave Pullback",
        approvalStatus: "replay",
        dashboardBucket: "replay",
        side: direction === "short" ? "Short" : "Long",
        quantity: Number.isFinite(quantity) ? quantity : null,
        entryPrice: Number.isFinite(entry) ? entry : null,
        exitPrice: Number.isFinite(exit) ? exit : null,
        realizedPnlDollars: Number.isFinite(pnl) ? Number(pnl.toFixed(4)) : null,
        internalOrderId: cleanText(row.parent_order_id) || `lifecycle-${index + 1}`,
        source: "oql_replay_lifecycle_csv",
        sourceFile: file.absPath,
        status: cleanText(row.reason) || "Closed / reduced",
      };
    })
    .filter((trade) => isReplayAccountId(trade.account) && Number.isFinite(Number(trade.realizedPnlDollars)))
    .sort((a, b) => String(a.exitAtUtc || a.tradeDateUtc || "").localeCompare(String(b.exitAtUtc || b.tradeDateUtc || "")));
  return { closedTrades, sourceFile: file.absPath };
}

function replayGroupedTradeFromClosedTrade(trade, sessionId, index) {
  const replayAccountId = normalizeReplayAccountId(trade.account || "Sim1");
  const observed = parseReplayObservationTime(trade.exitAtUtc || trade.tradeDateUtc || trade.entryAtUtc);
  const tradeId = [
    sessionId || "replay-session",
    replayAccountId,
    trade.entryAtUtc || trade.tradeDateUtc || "unknown-entry",
    trade.exitAtUtc || "unknown-exit",
    index,
  ].join(":");
  return {
    replaySessionId: sessionId,
    tradeId,
    sourceTradeId: trade.sourceId || null,
    capturedAtUtc: trade.capturedAtUtc || null,
    entryKey: trade.entryAtUtc || trade.tradeDateUtc || null,
    lucidSessionDay: replayChartDateKeyFromUtc(trade.entryAtUtc || trade.tradeDateUtc),
    observedAtUtc: observed.observedAtUtc,
    observedAtMs: observed.observedAtMs,
    direction: cleanText(trade.side),
    entry: Number.isFinite(Number(trade.entryPrice)) ? Number(trade.entryPrice) : null,
    initialStop: null,
    targetPlan: [],
    targetPlanLabel: null,
    hermesProfile: cleanText(trade.strategyName),
    hermesAction: cleanText(trade.strategyStudy),
    exitReason: cleanText(trade.status || "closed"),
    completionStatus: "completed",
    realizedPnlDollars: Number.isFinite(Number(trade.realizedPnlDollars))
      ? Number(Number(trade.realizedPnlDollars).toFixed(4))
      : null,
    replayAccountId,
    replayAccountLabel: replayAccountLabel(replayAccountId),
    sourceTradeLogAccount: replayAccountId,
    source: cleanText(trade.sourceSystem || trade.source) || "sierra_replay_trade_activity_log",
    sourceFile: trade.sourceFile || null,
  };
}

function mergeReplayClosedTradeSources(primaryTrades, fallbackTrades) {
  const keyForTrade = (trade) => [
    normalizeReplayAccountId(trade.account || trade.replayAccountId || "Sim1"),
    normalizeSymbolKey(trade.symbol || trade.instrument || ""),
    cleanText(trade.strategyName || trade.strategy || ""),
    cleanText(trade.side || trade.direction || ""),
    cleanText(trade.entryAtUtc || ""),
    cleanText(trade.exitAtUtc || trade.tradeDateUtc || trade.timestampUtc || ""),
    Number(trade.entryPrice ?? 0).toFixed(4),
    Number(trade.exitPrice ?? 0).toFixed(4),
    Number(trade.realizedPnlDollars ?? 0).toFixed(2),
  ].join("|");
  const orderKeyForTrade = (trade) => {
    const orderId = cleanText(trade.closingOrderId || trade.internalOrderId);
    const exitAtUtc = cleanText(trade.exitAtUtc || trade.tradeDateUtc || trade.timestampUtc);
    if (!orderId || !exitAtUtc) return null;
    return [
      normalizeReplayAccountId(trade.account || trade.replayAccountId || "Sim1"),
      normalizeSymbolKey(trade.symbol || trade.instrument || ""),
      orderId,
      exitAtUtc,
    ].join("|");
  };
  const merged = [];
  const seen = new Set();
  const seenOrders = new Set();
  for (const trade of [...(primaryTrades || []), ...(fallbackTrades || [])]) {
    if (!trade || !Number.isFinite(Number(trade.realizedPnlDollars))) continue;
    const key = keyForTrade(trade);
    const orderKey = orderKeyForTrade(trade);
    if (seen.has(key) || (orderKey && seenOrders.has(orderKey))) continue;
    seen.add(key);
    if (orderKey) seenOrders.add(orderKey);
    merged.push(trade);
  }
  return merged.sort((a, b) => String(a.exitAtUtc || a.tradeDateUtc || "").localeCompare(String(b.exitAtUtc || b.tradeDateUtc || "")));
}

function importReplaySqliteClosedTrades() {
  if (!fs.existsSync(PATRADING_REPLAY_SQLITE_FILE)) {
    return { ok: false, sourceFile: PATRADING_REPLAY_SQLITE_FILE, closedTrades: [], error: "Replay telemetry SQLite file does not exist." };
  }
  const script = String.raw`
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

db_path = Path(sys.argv[1])
uri = "file:" + quote(str(db_path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro&cache=private"
conn = sqlite3.connect(uri, uri=True, timeout=0.25)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA query_only=ON")
conn.execute("PRAGMA busy_timeout=250")

def table_exists(name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

def rows(sql):
    return [dict(row) for row in conn.execute(sql).fetchall()]

counts = {}
for table in ["trades", "fills", "orders", "account_snapshot"]:
    counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) if table_exists(table) else None

trade_rows = rows("""
    SELECT trade_id, instance_id, instance_name, instance_role, environment,
           trade_account, account_type_guess, is_simulated, symbol, trade_symbol,
           instrument, contract, chart_symbol, tick_size, tick_value, currency,
           strategy_name, attribution_confidence, direction, status, entry_datetime,
           exit_datetime, initial_quantity, max_quantity, final_quantity,
           average_entry_price, average_exit_price, initial_stop_price, final_stop_price,
           initial_target_price, final_target_price, exit_classification,
           gross_points, gross_ticks, gross_currency_value, net_profit_loss,
           total_commission, profit_loss, opening_order_id, closing_order_id,
           parent_order_id, text_tag, order_action_source, created_utc, updated_utc
    FROM trades
    WHERE LOWER(COALESCE(environment, '')) = 'replay'
    ORDER BY CAST(COALESCE(exit_datetime, entry_datetime, 0) AS REAL) ASC, trade_id ASC
""") if table_exists("trades") else []

conn.close()
print(json.dumps({"ok": True, "sourceFile": str(db_path), "counts": counts, "trades": trade_rows}))
`;
  try {
    const payload = JSON.parse(execFileSync(PYTHON_EXECUTABLE, ["-c", script, PATRADING_REPLAY_SQLITE_FILE], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }));
    const telemetryRows = (payload.trades || []).map((row) => {
      const account = normalizeReplayAccountId(row.trade_account || "Sim1");
      const symbol = cleanText(row.chart_symbol) || cleanText(row.trade_symbol) || cleanText(row.symbol) || cleanText(row.instrument) || "n/a";
      const exitAtUtc = sierraSerialToUtcIsoGlobal(row.exit_datetime);
      const entryAtUtc = sierraSerialToUtcIsoGlobal(row.entry_datetime);
      const realized = Number(row.net_profit_loss ?? row.profit_loss ?? row.gross_currency_value);
      const sideText = cleanText(row.direction);
      const attributed = classifyTradeFromContext([row.strategy_name, row.text_tag, row.order_action_source]);
      const strategyName = cleanText(row.strategy_name)
        || (attributed.tradeSource === "strategy" ? attributed.strategyName : cleanText(row.text_tag))
        || "Replay Trade";
      return {
        tradeId: `patrading-replay-sqlite-${row.trade_id}`,
        sourceId: `patrading-replay-sqlite-${row.trade_id}`,
        telemetryTradeId: Number(row.trade_id),
        instanceId: row.instance_id,
        capturedAtUtc: normalizeSqliteTimestampGlobal(row.created_utc),
        telemetryStatus: String(row.status || "").toLowerCase(),
        sourceSystem: "patrading_replay_sqlite",
        sourceFile: PATRADING_REPLAY_SQLITE_FILE,
        mode: "replay",
        account,
        replayAccountId: account,
        symbol,
        instrument: cleanText(row.instrument) || symbol,
        contract: cleanText(row.contract),
        strategyName,
        strategyStudy: attributed.tradeSource === "strategy" ? attributed.strategyStudy : null,
        side: /short/i.test(sideText || "") ? "Short" : /long|buy/i.test(sideText || "") ? "Long" : sideText,
        quantity: Number(row.initial_quantity ?? row.max_quantity ?? row.final_quantity ?? 0) || 0,
        entryPrice: Number(row.average_entry_price) || null,
        exitPrice: Number(row.average_exit_price) || null,
        entryAtUtc,
        exitAtUtc,
        tradeDateUtc: exitAtUtc || entryAtUtc || normalizeSqliteTimestampGlobal(row.updated_utc || row.created_utc),
        timestampUtc: exitAtUtc || entryAtUtc || normalizeSqliteTimestampGlobal(row.updated_utc || row.created_utc),
        status: "Closed / reduced",
        realizedPnlDollars: Number.isFinite(realized) ? Number(realized.toFixed(4)) : null,
        grossPoints: Number(row.gross_points) || null,
        points: Number(row.gross_points) || null,
        grossTicks: Number(row.gross_ticks) || null,
        openingOrderId: row.opening_order_id,
        closingOrderId: row.closing_order_id,
        textTag: cleanText(row.text_tag),
        orderActionSource: cleanText(row.order_action_source),
      };
    }).filter((trade) => isReplayAccountId(trade.account) && Date.parse(trade.entryAtUtc) > Date.UTC(2000, 0, 1));
    const closedTrades = telemetryRows.filter((trade) => trade.telemetryStatus === "closed" && trade.exitAtUtc && Number.isFinite(trade.realizedPnlDollars));
    return { ok: true, sourceFile: payload.sourceFile, counts: payload.counts || {}, closedTrades, telemetryRows };
  } catch (error) {
    return { ok: false, sourceFile: PATRADING_REPLAY_SQLITE_FILE, closedTrades: [], error: String(error?.message || error) };
  }
}

function buildReplaySessionStateFromTradeLogs(persisted, importNote = null) {
  const tradeLogDir = replayTradeActivityLogDir();
  const allFiles = listFiles(tradeLogDir, isReplayTradeActivityFile).sort((a, b) => a.name.localeCompare(b.name));
  const controller = readReplayControllerStatus();
  const controllerStatus = controller.status || {};
  const activeSelection = selectActiveReplayTradeFiles(allFiles, controllerStatus);
  const files = activeSelection.files
    .filter((file) => file?.absPath && fs.existsSync(file.absPath))
    .sort((a, b) => a.name.localeCompare(b.name));
  const latestFile = [...files].sort((a, b) => {
    const bMtime = fs.existsSync(b.absPath) ? fs.statSync(b.absPath).mtimeMs : 0;
    const aMtime = fs.existsSync(a.absPath) ? fs.statSync(a.absPath).mtimeMs : 0;
    return bMtime - aMtime;
  })[0] || null;
  const latestFileMtimeMs = latestFile?.absPath && fs.existsSync(latestFile.absPath) ? fs.statSync(latestFile.absPath).mtimeMs : null;
  const parsedEvents = [];
  const parseErrors = [];

  for (const file of files) {
    try {
      parsedEvents.push(...parseReplayTradeActivityFile(file));
    } catch (error) {
      parseErrors.push({ file: file.absPath, error: String(error?.message || error) });
    }
  }

  const controllerIsActive = String(controllerStatus?.status || "").toLowerCase() === "status"
    && String(controllerStatus?.action || "").toLowerCase() === "status"
    && String(controllerStatus?.isReplayRunning).toLowerCase() === "true"
    && (!Number.isFinite(latestFileMtimeMs) || !Number.isFinite(controller.statusMtimeMs) || controller.statusMtimeMs + 2000 >= latestFileMtimeMs);
  const currentChartUtc = controllerIsActive ? replayChartTimeToUtc(controllerStatus.currentChartDateTime) : null;
  const currentChartMs = Date.parse(currentChartUtc);
  const rawFillEvents = parsedEvents.filter((event) =>
    event.eventType === "fill"
    && (!Number.isFinite(currentChartMs) || Date.parse(event.tradeDateUtc) <= currentChartMs)
  );
  const replayForceFlatReconciliation = applyReplaySyntheticForceFlatFills(rawFillEvents, controllerStatus);
  const fillEvents = replayForceFlatReconciliation.fillEvents;
  const lifecycleReplay = buildReplayClosedTradesFromLifecycleCsv(controllerStatus, activeSelection);
  const sqliteReplay = importReplaySqliteClosedTrades();
  if (fs.existsSync(PATRADING_REPLAY_SQLITE_FILE) && !sqliteReplay.ok) {
    throw new Error(`Replay telemetry read failed; retaining the last published manifest: ${sqliteReplay.error}`);
  }
  const telemetry = scopeReplayTelemetry(sqliteReplay.telemetryRows || [], persisted.accounts || {});
  const scopedIds = new Set(telemetry.rows.map((trade) => trade.sourceId));
  const scopedAccount = (trade) => Boolean(telemetry.scopes[normalizeReplayAccountId(trade.account)]?.runId);
  const currentSqliteTrades = sqliteReplay.closedTrades.filter((trade) => scopedIds.has(trade.sourceId));
  const latestLogMtimeByAccount = files.reduce((accounts, file) => {
    const accountId = parseReplayAccountFromTradeLog(file.absPath);
    const mtimeMs = file?.absPath && fs.existsSync(file.absPath) ? fs.statSync(file.absPath).mtimeMs : null;
    if (accountId && Number.isFinite(mtimeMs)) accounts[accountId] = Math.max(accounts[accountId] || 0, mtimeMs);
    return accounts;
  }, {});
  const replayLogFallbackAccounts = new Set(selectReplayTradeLogFallbackAccounts({
    latestLogMtimeByAccount,
    telemetryRows: sqliteReplay.telemetryRows || [],
    telemetryScopes: telemetry.scopes,
  }));
  const includeFallbackTrade = (trade) => {
    const accountId = normalizeReplayAccountId(trade.account || trade.replayAccountId || "Sim1");
    return !scopedAccount(trade) || replayLogFallbackAccounts.has(accountId);
  };
  const activeSelectionAccountIds = new Set(files.map((file) => parseReplayAccountFromTradeLog(file.absPath)).filter(Boolean));
  const lifecycleAccountIds = new Set(lifecycleReplay.closedTrades.map((trade) => normalizeReplayAccountId(trade.account)).filter(isReplayAccountId));
  const lifecycleMatchesActiveSelection =
    lifecycleReplay.closedTrades.length
    && (!activeSelectionAccountIds.size || [...lifecycleAccountIds].some((accountId) => activeSelectionAccountIds.has(accountId)))
    && activeSelection.reason !== "latest_fresh_trade_activity_when_controller_inactive";
  const logClosedTrades = buildClosedTradesFromFills(fillEvents);
  const eligibleLifecycleTrades = lifecycleReplay.closedTrades.filter(includeFallbackTrade);
  const eligibleLogTrades = logClosedTrades.filter(includeFallbackTrade);
  const fallbackTrades = lifecycleMatchesActiveSelection
    ? mergeReplayClosedTradeSources(eligibleLifecycleTrades, eligibleLogTrades)
    : eligibleLogTrades;
  const closedTrades = mergeReplayClosedTradeSources(currentSqliteTrades, fallbackTrades);
  const replayTradeSource = sqliteReplay.closedTrades.length
    ? lifecycleMatchesActiveSelection
      ? "patrading_replay_sqlite_plus_oql_lifecycle_plus_sierra_replay_trade_activity_log"
      : "patrading_replay_sqlite_plus_sierra_replay_trade_activity_log"
    : lifecycleMatchesActiveSelection
      ? "oql_replay_lifecycle_csv_plus_sierra_replay_trade_activity_log"
      : "sierra_replay_trade_activity_log";
  const sierraWindowSnapshot = readReplaySierraWindowSnapshot();
  const openPositions = valueReplayOpenPositionsAtCurrentChartTime(
    buildOpenPositionsFromFills(fillEvents, "replay").filter((trade) => !scopedAccount(trade)),
    controllerStatus,
  );
  openPositions.push(...telemetry.rows.filter((trade) => scopedAccount(trade) && trade.telemetryStatus === "open").map((trade) => ({
    ...trade,
    status: "Open",
    unrealizedPnlDollars: null,
  })));
  const openPnlByAccount = openPositions.reduce((accounts, position) => {
    const accountId = normalizeReplayAccountId(position.account || "Sim1");
    accounts.set(accountId, (accounts.get(accountId) || 0) + (Number(position.unrealizedPnlDollars) || 0));
    return accounts;
  }, new Map());
  const openPositionsByAccount = openPositions.reduce((accounts, position) => {
    const accountId = normalizeReplayAccountId(position.account || "Sim1");
    if (!accounts.has(accountId)) accounts.set(accountId, []);
    accounts.get(accountId).push(position);
    return accounts;
  }, new Map());
  const closedTradeAccountIds = [...new Set(closedTrades.map((trade) => normalizeReplayAccountId(trade.account)).filter(isReplayAccountId))]
    .sort((a, b) => replayAccountSortValue(a) - replayAccountSortValue(b) || a.localeCompare(b));
  const activeReplayAccountId =
    telemetry.activeAccountId
    || closedTradeAccountIds[0]
    || parseReplayAccountFromTradeLog(latestFile?.absPath)
    || normalizeReplayAccountId([...new Set(fillEvents.map((event) => event.replayAccountId).filter(Boolean))].sort()[0] || "Sim1");
  const latestActiveAccountFile =
    [...files].filter((file) => file?.absPath && fs.existsSync(file.absPath) && parseReplayAccountFromTradeLog(file.absPath) === activeReplayAccountId)
      .sort((a, b) => {
        const bMtime = fs.existsSync(b.absPath) ? fs.statSync(b.absPath).mtimeMs : 0;
        const aMtime = fs.existsSync(a.absPath) ? fs.statSync(a.absPath).mtimeMs : 0;
        return bMtime - aMtime;
      })[0]
    || latestFile;
  const snapshot = {
    latestTradeLog: latestActiveAccountFile?.absPath || null,
    latestMessageLog: null,
    tradeDateKey: activeSelection.activeDateKey || replayTradeDateFromFile(latestFile?.absPath),
    requestedStartDateTime: null,
    effectiveStartDateTime: cleanText(controllerStatus.effectiveStartDateTime || controllerStatus.currentChartDateTime),
    currentChartDateTime: cleanText(controllerStatus.currentChartDateTime),
    chartTimeMs: parseReplaySessionClock(controllerStatus.currentChartDateTime),
    controllerAction: String(controllerStatus.action || "").trim().toLowerCase() || null,
    controllerCommandId: cleanText(controllerStatus.commandId),
    replayEventCount: closedTrades.length,
    updatedAtUtc: new Date().toISOString(),
    activeTradeLogSelectionReason: activeSelection.reason,
    runStartDateKey: activeSelection.startDateKey || activeSelection.activeDateKey || null,
    runEndDateKey: activeSelection.endDateKey || activeSelection.activeDateKey || null,
    commandStartedAtUtc: Number.isFinite(activeSelection.commandStartedAtMs)
      ? new Date(activeSelection.commandStartedAtMs).toISOString()
      : null,
  };
  const rawRowsByAccount = closedTrades.reduce((accounts, trade, index) => {
    const accountId = normalizeReplayAccountId(trade.account || "Sim1");
    if (!accounts.has(accountId)) accounts.set(accountId, []);
    accounts.get(accountId).push({ trade, index });
    return accounts;
  }, new Map());
  const logsByAccount = files.reduce((accounts, file) => {
    const accountId = parseReplayAccountFromTradeLog(file.absPath);
    if (!accountId) return accounts;
    accounts.set(accountId, (accounts.get(accountId) || 0) + 1);
    return accounts;
  }, new Map());
  const persistedAccounts = persisted.accounts && typeof persisted.accounts === "object" ? persisted.accounts : {};
  const nextAccounts = {};
  const replayStateGeneratedAtUtc = new Date().toISOString();
  const replayAccountIds = discoverReplayAccountIds({
    rawRowsByAccount,
    logsByAccount,
    persistedAccounts,
    activeReplayAccountId,
  });

  for (const accountId of replayAccountIds) {
    const account = { accountId, label: replayAccountLabel(accountId) };
    const existing = replayAccountState(account.accountId, persistedAccounts[account.accountId]);
    const rawRows = rawRowsByAccount.get(account.accountId) || [];
    const accountSnapshot = {
      ...snapshot,
      replayAccountId: account.accountId,
      replayEventCount: rawRows.length,
      tradeLogCount: logsByAccount.get(account.accountId) || 0,
      updatedAtUtc: replayStateGeneratedAtUtc,
    };
    const telemetryScope = telemetry.scopes[accountId] || existing.telemetryScope;
    const accountFingerprint = telemetryScope?.runId || [
      accountSnapshot.replayAccountId,
      accountSnapshot.latestTradeLog || "no-trade-log",
      accountSnapshot.tradeLogCount,
      accountSnapshot.tradeDateKey || "no-trade-date",
    ].join("|");
    const accountResetDecision = detectReplaySessionReset(existing.lastObserved, accountSnapshot);
    const accountSessionId = telemetryScope?.runId || (rawRows.length && (
      accountResetDecision.reset
      || existing.currentSessionFingerprint !== accountFingerprint
      || !existing.currentSessionId
    )
      ? `replay-session-${account.accountId}-${replayStateGeneratedAtUtc.replace(/[:.]/g, "-")}`
      : rawRows.length
      ? existing.currentSessionId
      : null);
    const groupedAccountTrades = rawRows.map(({ trade, index }) => replayGroupedTradeFromClosedTrade(trade, accountSessionId, index));
    nextAccounts[account.accountId] = replayAccountState(account.accountId, {
      ...existing,
      telemetryScope,
      currentSessionId: accountSessionId,
      currentSessionFingerprint: rawRows.length ? accountFingerprint : null,
      lastObserved: { ...accountSnapshot, sessionBoundaryReason: telemetryScope?.reason || (rawRows.length ? accountResetDecision.reason : "account_bucket_rebuilt_empty") },
      groupedTrades: groupedAccountTrades,
    });
  }

  const currentAccountState = replayAccountState(
    activeReplayAccountId || "Sim1",
    nextAccounts[activeReplayAccountId || "Sim1"] || persistedAccounts[activeReplayAccountId || "Sim1"],
  );
  const currentSessionId = currentAccountState.currentSessionId || persisted.currentSessionId;
  const nextState = {
    ...persisted,
    version: 2,
    currentSessionId,
    currentSessionFingerprint: currentAccountState.currentSessionFingerprint || null,
    lastObserved: {
      ...snapshot,
      replayAccountId: activeReplayAccountId,
      updatedAtUtc: replayStateGeneratedAtUtc,
    },
    accounts: nextAccounts,
  };
  writeJsonAtomic(REPLAY_MONITOR_STATE_FILE, nextState);

  const normalizedGroupedTrades = Object.values(nextAccounts).flatMap((account) => account.groupedTrades || []);
  const clears = readJson(REPLAY_MONITOR_CLEARS_FILE, { accounts: {} });
  const visibleGroupedTrades = visibleReplayTrades(nextAccounts, clears);
  const hiddenAfterClearCount = Math.max(normalizedGroupedTrades.length - visibleGroupedTrades.length, 0);
  const visibleNetPnl = visibleGroupedTrades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
  const allGroupedNetPnl = normalizedGroupedTrades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
  const openNetPnl = openPositions.reduce((sum, position) => sum + (Number(position.unrealizedPnlDollars) || 0), 0);
  const visibleNetPnlWithOpen = visibleNetPnl + openNetPnl;
  const allGroupedNetPnlWithOpen = allGroupedNetPnl + openNetPnl;
  const replayAccounts = replayAccountIds.map((accountId) => ({
    accountId,
    label: replayAccountLabel(accountId),
    tradeLogCount: logsByAccount.get(accountId) || 0,
    groupedTradesCount: normalizedGroupedTrades.filter((trade) => trade.replayAccountId === accountId).length,
    groupedTradesVisibleCount: visibleGroupedTrades.filter((trade) => trade.replayAccountId === accountId).length,
    openPositionsCount: (openPositionsByAccount.get(accountId) || []).length,
    openPnlDollars: Number((openPnlByAccount.get(accountId) || 0).toFixed(2)),
    sierraWindowNetPnlDollars: sierraWindowSnapshot?.account === accountId ? sierraWindowSnapshot.netProfitLossDollars : null,
    sierraWindowNplText: sierraWindowSnapshot?.account === accountId ? sierraWindowSnapshot.netProfitLossText : null,
  }));
  const replayAccountSummaries = replayAccounts.map((account) => replayAccountSummary(visibleGroupedTrades, account));
  const replayAudit = {
    generatedAtUtc: snapshot.updatedAtUtc,
    groupedTradesFound: normalizedGroupedTrades.length,
    groupedTradesVisible: visibleGroupedTrades.length,
    groupedTradesHiddenAfterClear: hiddenAfterClearCount,
    groupedTradesNetPnlDollars: Number(allGroupedNetPnlWithOpen.toFixed(2)),
    visibleNetPnlDollars: Number(visibleNetPnlWithOpen.toFixed(2)),
    closedNetPnlDollars: Number(allGroupedNetPnl.toFixed(2)),
    openNetPnlDollars: Number(openNetPnl.toFixed(2)),
    sierraWindowNetPnlDollars: sierraWindowSnapshot?.netProfitLossDollars ?? null,
    sierraWindowSnapshot,
    openPositions: openPositions.length,
    syntheticForceFlatFills: replayForceFlatReconciliation.syntheticFills.length,
    replayFillCount: fillEvents.length,
    replayExitFillCount: logClosedTrades.length,
    lifecycleClosedTrades: lifecycleReplay.closedTrades.length,
    sqliteReplayOk: sqliteReplay.ok,
    sqliteReplaySourceFile: sqliteReplay.sourceFile,
    sqliteReplayCounts: sqliteReplay.counts || {},
    sqliteReplayClosedTrades: sqliteReplay.closedTrades.length,
    sqliteReplayError: sqliteReplay.error || null,
    telemetryRunScopes: telemetry.scopes,
    replayLogFallbackAccounts: [...replayLogFallbackAccounts],
    mergedReplayClosedTrades: closedTrades.length,
    lifecycleSourceFile: lifecycleReplay.sourceFile,
    pnlSource: replayTradeSource,
    sourceTradeLogCount: allFiles.length,
    readableTradeLogCount: files.length - parseErrors.length,
    activeTradeLogCount: files.length,
    activeTradeDateKey: snapshot.tradeDateKey,
    runStartDateKey: snapshot.runStartDateKey,
    runEndDateKey: snapshot.runEndDateKey,
    activeTradeLogSelectionReason: activeSelection.reason,
    selectedAccountTradeLogCount: logsByAccount.get(activeReplayAccountId || "Sim1") || 0,
    latestTradeLog: snapshot.latestTradeLog,
    latestMessageLog: snapshot.latestMessageLog,
    artifactReplayCount: null,
    connectorRecommendation: importNote || (lifecycleReplay.closedTrades.length
      ? "Using OQL replay lifecycle CSV for strategy-owned replay P/L."
      : files.length
      ? "Using direct Sierra replay TradeActivityLog fallback."
      : "No replay TradeActivityLog files found."),
    parseErrors: parseErrors.length,
    accounts: replayAccountSummaries,
  };
  const status = files.length
    ? normalizedGroupedTrades.length
      ? "observed"
      : "no_replay_fills"
    : "unavailable";
  const currentSession = {
    sessionId: currentSessionId,
    source: replayTradeSource,
    status,
    sessionBoundaryReason: currentAccountState.lastObserved?.sessionBoundaryReason || "trade_activity_log_fallback",
    activeReplayAccountId,
    requestedStartDateTime: null,
    effectiveStartDateTime: null,
    currentChartDateTime: snapshot.currentChartDateTime,
    replayRoot: path.dirname(tradeLogDir),
    replayTradeActivityLogDir: tradeLogDir,
    replayLogsDir: null,
    connectorControlDir: path.dirname(controller.statusPath),
    latestTradeLog: snapshot.latestTradeLog,
    latestMessageLog: null,
    controllerCommandId: snapshot.controllerCommandId,
    controllerAction: snapshot.controllerAction,
    replaySpeed: cleanText(controllerStatus.replaySpeed),
    replayAccounts,
    replayAccountSummaries,
    defaultReplayAccountId: activeReplayAccountId || "Sim1",
    groupedTrades: normalizedGroupedTrades,
    groupedTradesVisible: visibleGroupedTrades,
    groupedTradesCount: normalizedGroupedTrades.length,
    groupedTradesVisibleCount: visibleGroupedTrades.length,
    groupedTradesNetPnlDollars: Number(visibleNetPnlWithOpen.toFixed(2)),
    closedTradesNetPnlDollars: Number(visibleNetPnl.toFixed(2)),
    openPositionsNetPnlDollars: Number(openNetPnl.toFixed(2)),
    sierraWindowNetPnlDollars: sierraWindowSnapshot?.netProfitLossDollars ?? null,
    sierraWindowSnapshot,
    openPositions,
    audit: replayAudit,
    lastClearedAtUtc: clears.accounts?.[activeReplayAccountId]?.clearedAtUtc || null,
    note: files.length
      ? lifecycleReplay.closedTrades.length
        ? "Replay rows are grouped from the OQL lifecycle CSV matching the active replay command so the website uses the same strategy-owned P/L source as the run report."
        : "Replay rows are grouped from the active Sierra replay TradeActivityLog date reported by the replay controller and stored in separate SIM account buckets, isolated from paper/live dashboard totals."
      : `No replay TradeActivityLog files were found in ${tradeLogDir}.`,
  };
  return {
    persistedState: nextState,
    currentSession,
    report: null,
    artifact: null,
    sourceFiles: [
      REPLAY_MONITOR_STATE_FILE,
      REPLAY_MONITOR_CLEARS_FILE,
      PATRADING_REPLAY_SQLITE_FILE,
      `${PATRADING_REPLAY_SQLITE_FILE}-wal`,
      lifecycleReplay.sourceFile,
      ...files.map((file) => file.absPath),
      ...replayRunMessageLogFiles(controllerStatus).map((file) => file.absPath),
      replayScidPathForSymbol("MNQM26-CME"),
      controller.statusPath,
      REPLAY_CONNECTOR_MODULE_PATH,
    ].filter(Boolean).filter((file, index, allFiles) => allFiles.indexOf(file) === index),
  };
}

function buildReplaySessionState() {
  const persisted = readReplayMonitorState();
  if (fs.existsSync(PATRADING_REPLAY_SQLITE_FILE)) {
    return buildReplaySessionStateFromTradeLogs(persisted, "Replay telemetry is scoped per account and captured run.");
  }
  if (!replayConnector?.buildReplayValidationArtifact || !replayConnector?.buildReplayValidationReport) {
    const note = REPLAY_CONNECTOR_MODULE_PATH
      ? replayConnector?.__importError
        ? `Replay connector import failed at ${REPLAY_CONNECTOR_MODULE_PATH}: ${replayConnector.__importError}`
        : `Replay connector import failed: ${REPLAY_CONNECTOR_MODULE_PATH}`
      : `Replay connector not found by walking upward from ${ROOT}`;
    return buildReplaySessionStateFromTradeLogs(persisted, note);
  }

  const replayArtifactPayload = replayConnector.buildReplayValidationArtifact({ mode: "replay", logLimit: 500, tradeLogLimit: 500 });
  const replayReport = replayArtifactPayload?.report || replayConnector.buildReplayValidationReport({ mode: "replay" });
  const groupedTrades = Array.isArray(replayArtifactPayload?.artifact?.replayEvents)
    ? replayArtifactPayload.artifact.replayEvents
    : [];
  const controllerStatus = replayReport?.controllerStatus?.status || {};
  const snapshot = {
    latestTradeLog: cleanText(replayReport?.latestTradeLog),
    latestMessageLog: cleanText(replayReport?.latestMessageLog),
    tradeDateKey: cleanText(basename(replayReport?.latestTradeLog || "").match(/^TradeActivityLog_(\d{4}-\d{2}-\d{2})_UTC\./i)?.[1]),
    requestedStartDateTime: cleanText(
      replayArtifactPayload?.metadata?.requestedStartDateTime || controllerStatus.requestedStartDateTime,
    ),
    effectiveStartDateTime: cleanText(
      replayArtifactPayload?.metadata?.effectiveStartDateTime
      || controllerStatus.effectiveStartDateTime
      || controllerStatus.currentChartDateTime,
    ),
    currentChartDateTime: cleanText(controllerStatus.currentChartDateTime),
    chartTimeMs: parseReplaySessionClock(controllerStatus.currentChartDateTime),
    controllerAction: String(controllerStatus.action || "").trim().toLowerCase() || null,
    controllerCommandId: cleanText(controllerStatus.commandId),
    replayEventCount: groupedTrades.length,
    updatedAtUtc: new Date().toISOString(),
  };
  const parsedTradeActivitySummary = replayArtifactPayload?.metadata?.parsedTradeActivitySummary || {};
  const sourceAccounts = Array.isArray(parsedTradeActivitySummary.accounts) ? parsedTradeActivitySummary.accounts : [];
  const activeReplayAccountId = parseReplayAccountFromTradeLog(snapshot.latestTradeLog);
  const rawRowsByAccount = groupedTrades.reduce((accounts, event, index) => {
    const accountId = normalizeReplayAccountId(event?.replayAccountId || event?.context?.replayAccountId || "Sim1");
    if (!accounts.has(accountId)) accounts.set(accountId, []);
    accounts.get(accountId).push({ event, index });
    return accounts;
  }, new Map());
  const persistedAccounts = persisted.accounts && typeof persisted.accounts === "object" ? persisted.accounts : {};
  const nextAccounts = {};
  const replayStateGeneratedAtUtc = new Date().toISOString();
  const replayAccountIds = discoverReplayAccountIds({
    sourceAccounts,
    rawRowsByAccount,
    persistedAccounts,
    activeReplayAccountId,
  });

  for (const accountId of replayAccountIds) {
    const account = { accountId, label: replayAccountLabel(accountId) };
    const existing = replayAccountState(account.accountId, persistedAccounts[account.accountId]);
    const rawRows = rawRowsByAccount.get(account.accountId) || [];
    const canUpdateAccount = true;
    const accountSnapshot = {
      ...snapshot,
      replayAccountId: account.accountId,
      replayEventCount: rawRows.length,
      updatedAtUtc: replayStateGeneratedAtUtc,
    };
    const accountFingerprint = createReplaySessionFingerprint(accountSnapshot);
    const accountResetDecision = detectReplaySessionReset(existing.lastObserved, accountSnapshot);
    const accountSessionId = rawRows.length && (
      accountResetDecision.reset
      || existing.currentSessionFingerprint !== accountFingerprint
      || !existing.currentSessionId
    )
      ? `replay-session-${account.accountId}-${replayStateGeneratedAtUtc.replace(/[:.]/g, "-")}`
      : rawRows.length
      ? existing.currentSessionId
      : null;
    const groupedAccountTrades = rawRows.map(({ event, index }) => normalizeReplayGroupedTrade(event, accountSessionId, index));
    nextAccounts[account.accountId] = replayAccountState(account.accountId, {
      ...existing,
      currentSessionId: accountSessionId,
      currentSessionFingerprint: rawRows.length ? accountFingerprint : null,
      lastObserved: { ...accountSnapshot, sessionBoundaryReason: rawRows.length ? accountResetDecision.reason : "account_bucket_rebuilt_empty" },
      groupedTrades: groupedAccountTrades,
    });
  }

  const currentAccountState = replayAccountState(
    activeReplayAccountId || "Sim1",
    nextAccounts[activeReplayAccountId || "Sim1"] || persistedAccounts[activeReplayAccountId || "Sim1"],
  );
  const currentSessionId = currentAccountState.currentSessionId || persisted.currentSessionId;
  const fingerprint = currentAccountState.currentSessionFingerprint || createReplaySessionFingerprint({ ...snapshot, replayAccountId: activeReplayAccountId });
  const resetDecision = currentAccountState.lastObserved?.sessionBoundaryReason
    ? { reset: false, reason: currentAccountState.lastObserved.sessionBoundaryReason }
    : detectReplaySessionReset(persisted.lastObserved, snapshot);
  const nextState = {
    ...persisted,
    version: 2,
    currentSessionId,
    currentSessionFingerprint: fingerprint,
    lastObserved: {
      ...snapshot,
      replayAccountId: activeReplayAccountId,
      updatedAtUtc: replayStateGeneratedAtUtc,
    },
    accounts: nextAccounts,
  };
  writeJsonAtomic(REPLAY_MONITOR_STATE_FILE, nextState);

  const normalizedGroupedTrades = Object.values(nextAccounts).flatMap((account) => account.groupedTrades || []);
  const visibleGroupedTrades = visibleReplayTrades(nextAccounts, readJson(REPLAY_MONITOR_CLEARS_FILE, { accounts: {} }));
  const hiddenAfterClearCount = Math.max(normalizedGroupedTrades.length - visibleGroupedTrades.length, 0);
  const visibleNetPnl = visibleGroupedTrades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
  const allGroupedNetPnl = normalizedGroupedTrades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
  const replayAccounts = replayAccountIds.map((accountId) => {
    const sourceAccount = sourceAccounts.find((item) => item.accountId === accountId) || {};
    return {
      accountId,
      label: replayAccountLabel(accountId),
      tradeLogCount: Number.isFinite(Number(sourceAccount.tradeLogCount)) ? Number(sourceAccount.tradeLogCount) : 0,
      groupedTradesCount: normalizedGroupedTrades.filter((trade) => trade.replayAccountId === accountId).length,
      groupedTradesVisibleCount: visibleGroupedTrades.filter((trade) => trade.replayAccountId === accountId).length,
    };
  });
  const replayAccountSummaries = replayAccounts.map((account) => replayAccountSummary(visibleGroupedTrades, account));
  const replayAudit = {
    generatedAtUtc: snapshot.updatedAtUtc,
    groupedTradesFound: normalizedGroupedTrades.length,
    groupedTradesVisible: visibleGroupedTrades.length,
    groupedTradesHiddenAfterClear: hiddenAfterClearCount,
    groupedTradesNetPnlDollars: Number(allGroupedNetPnl.toFixed(2)),
    visibleNetPnlDollars: Number(visibleNetPnl.toFixed(2)),
    replayFillCount: Number.isFinite(Number(parsedTradeActivitySummary.replayFillCount))
      ? Number(parsedTradeActivitySummary.replayFillCount)
      : null,
    replayExitFillCount: Number.isFinite(Number(parsedTradeActivitySummary.replayExitFillCount))
      ? Number(parsedTradeActivitySummary.replayExitFillCount)
      : null,
    sourceTradeLogCount: Number.isFinite(Number(parsedTradeActivitySummary.tradeLogCount))
      ? Number(parsedTradeActivitySummary.tradeLogCount)
      : null,
    readableTradeLogCount: Number.isFinite(Number(parsedTradeActivitySummary.readableTradeLogCount))
      ? Number(parsedTradeActivitySummary.readableTradeLogCount)
      : null,
    latestTradeLog: snapshot.latestTradeLog,
    latestMessageLog: snapshot.latestMessageLog,
    artifactReplayCount: Number.isFinite(Number(replayArtifactPayload?.artifact?.summary?.replayCount))
      ? Number(replayArtifactPayload.artifact.summary.replayCount)
      : null,
    connectorRecommendation: cleanText(replayArtifactPayload?.metadata?.recommendation),
    accounts: replayAccountSummaries,
  };
  const currentSession = {
    sessionId: currentSessionId,
    source: "sierra_replay_connector",
    status: replayReport?.controllerReadiness?.status || "observed",
    sessionBoundaryReason: resetDecision.reason,
    activeReplayAccountId,
    requestedStartDateTime: snapshot.requestedStartDateTime,
    effectiveStartDateTime: snapshot.effectiveStartDateTime,
    currentChartDateTime: snapshot.currentChartDateTime,
    replayRoot: replayReport?.instance?.root || null,
    replayTradeActivityLogDir: replayReport?.instance?.tradeActivityLogDir || null,
    replayLogsDir: replayReport?.instance?.logsDir || null,
    connectorControlDir: replayReport?.controllerStatus?.paths?.controlDir || null,
    latestTradeLog: snapshot.latestTradeLog,
    latestMessageLog: snapshot.latestMessageLog,
    controllerCommandId: snapshot.controllerCommandId,
    controllerAction: snapshot.controllerAction,
    replaySpeed: cleanText(controllerStatus.replaySpeed),
    replayAccounts,
    replayAccountSummaries,
    defaultReplayAccountId: activeReplayAccountId || "Sim1",
    groupedTrades: normalizedGroupedTrades,
    groupedTradesVisible: visibleGroupedTrades,
    groupedTradesCount: normalizedGroupedTrades.length,
    groupedTradesVisibleCount: visibleGroupedTrades.length,
    groupedTradesNetPnlDollars: Number(visibleNetPnl.toFixed(2)),
    audit: replayAudit,
    lastClearedAtUtc: currentAccountState.clearedSessionId === currentAccountState.currentSessionId ? currentAccountState.clearedAtUtc : null,
    note: "Replay rows are grouped trades built from the Sierra replay connector and stored in separate SIM account buckets, isolated from paper/live dashboard totals.",
  };
  return {
    persistedState: nextState,
    currentSession,
    report: replayReport,
    artifact: replayArtifactPayload?.artifact || null,
    sourceFiles: [
      REPLAY_MONITOR_STATE_FILE,
      snapshot.latestTradeLog,
      snapshot.latestMessageLog,
      replayReport?.controllerStatus?.paths?.commandPath,
      replayReport?.controllerStatus?.paths?.statusPath,
      REPLAY_CONNECTOR_MODULE_PATH,
    ].filter(Boolean).filter((file, index, files) => files.indexOf(file) === index),
  };
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function parseMarkdownFields(text, keys) {
  const lines = text ? text.split(/\r?\n/) : [];
  const result = {};
  for (const line of lines) {
    const match = line.match(MARKDOWN_FIELD_RE);
    if (!match) continue;
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (keys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

function parseLedger() {
  const file = findLatestByPattern(OCEAN_TRADING_DIR, /^oce-26_papertrade_ledger_.*\.md$/i);
  if (!file) return { sourceFiles: [], latestLedger: null };
  const text = readText(file);
  const fields = parseMarkdownFields(text, [
    "Strategy",
    "Paper trading performed",
    "Trades observed for Lunchy in this run",
    "Fills observed for Lunchy in this run",
    "Missed signals reconstructed in this run",
    "P/L",
    "Recommendation",
  ]);
  return {
    sourceFiles: [file],
    latestLedger: {
      path: file,
      strategy: fields.Strategy || "Unknown",
      paperTradingPerformed: fields["Paper trading performed"] || "unknown",
      tradesObserved: fields["Trades observed for Lunchy in this run"] || null,
      fillsObserved: fields["Fills observed for Lunchy in this run"] || null,
      missedSignalsReconstructed: fields["Missed signals reconstructed in this run"] || null,
      pnl: fields["P/L"] || null,
      recommendation: fields["Recommendation"] || "n/a",
      textSnippet: text?.split("\n").slice(0, 24).join("\n").trim(),
    },
  };
}

function parseDailyReport() {
  const file =
    findLatestByPattern(OCEAN_TRADING_DIR, /^oce-\d+_daily_report_.*\.md$/i) ||
    findLatestByPattern(OCEAN_TRADING_DIR, /^oce-26_papertrade_daily_.*\.md$/i);
  if (!file) return { sourceFiles: [], latestDaily: null };
  const text = readText(file);
  const fields = parseMarkdownFields(text, [
    "Strategy",
    "Day number",
    "Valid Lunchy signals observed",
    "Valid Lunchy trades/fills observed",
    "Missed Lunchy signals reconstructed",
    "Realized Lunchy P/L",
    "Recommendation / next owner",
  ]);
  const coverageDate = text.match(/Coverage Date\s+(\d{4}-\d{2}-\d{2})/i)?.[1] ||
    path.basename(file).match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  const fillEvents = text.match(/paper fill events on \d{4}-\d{2}-\d{2}:\s*`?(\d+)`?/i)?.[1];
  const closedTrades = text.match(/normalized closed trades on \d{4}-\d{2}-\d{2}:\s*`?(\d+)`?/i)?.[1];
  const missedSignals = text.match(/detected additional logged .*? signals:\s*`?(\d+)`?/i)?.[1] ||
    text.match(/Missed .*? signals[^:\n]*:\s*`?(\d+)`?/i)?.[1];
  const realizedPnl = text.match(/closed-trade net P\/L for \d{4}-\d{2}-\d{2}:\s*`?([^`\n]+)`?/i)?.[1] ||
    fields["Realized Lunchy P/L"];
  const liveReadiness = text.match(/Live-trading readiness:\s*([^\n]+)/i)?.[1];
  return {
    sourceFiles: [file],
    latestDaily: {
      path: file,
      strategy: fields.Strategy || "Daily operating report",
      dayNumber: fields["Day number"] || coverageDate || "n/a",
      validSignals: fields["Valid Lunchy signals observed"] || fillEvents || null,
      validTrades: fields["Valid Lunchy trades/fills observed"] || closedTrades || null,
      missedSignals: fields["Missed Lunchy signals reconstructed"] || missedSignals || null,
      realizedPnL: realizedPnl || null,
      recommendation: fields["Recommendation / next owner"] || liveReadiness || "n/a",
      textSnippet: text?.split("\n").slice(0, 30).join("\n").trim(),
    },
  };
}

function parseBacktestJson(filePath) {
  if (!filePath) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    try {
      return JSON.parse(text);
    } catch {
      const normalized = text
        .replace(/\b-Infinity\b/g, "null")
        .replace(/\bInfinity\b/g, "null")
        .replace(/\bNaN\b/g, "null");
      return JSON.parse(normalized);
    }
  } catch {
    return null;
  }
}

function buildRegimeEngine() {
  const payload = readJson(REGIME_SUMMARY_FILE, null);
  if (!payload) {
    return {
      status: "missing",
      summary: "No regime-engine summary artifact is available yet.",
      sourceFiles: [],
      dashboardContract: {
        consumerPath: "dashboard manifest -> regimeEngine",
        readOnly: true,
      },
    };
  }
  return {
    status: "ready",
    ...payload,
    sourceFiles: [
      REGIME_SUMMARY_FILE,
      payload.artifacts?.labelsCsv,
    ].filter(Boolean),
  };
}

function parseSierraStudyCatalog() {
  const text = readText(OCEAN_TRADING_SOURCE) || "";
  const studies = [];
  const exportRe = /SCSFExport\s+(scsf_[A-Za-z0-9_]+)\s*\([^)]*\)[\s\S]*?sc\.GraphName\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = exportRe.exec(text)) !== null) {
    const graphName = match[2];
    studies.push({
      name: graphName,
      functionName: match[1],
      sourceFile: OCEAN_TRADING_SOURCE,
      sourceSystem: "sierra_strategy_artifact",
      sourceDetail: "Sierra Chart ACSIL/C++ source catalog",
      platform: "Sierra Chart ACSIL/C++",
      status: graphName.includes("Cody")
        ? "removed_from_paper_trading"
        : graphName.includes("RubberBand")
        ? "rejected_after_backtest"
        : graphName.includes("Lunchy")
          ? "papertrade_candidate"
          : "created_for_paper_trading",
    });
  }
  return studies;
}

function parsePaperTradingPlan() {
  const handoff = path.join(STRATEGIES_DIR, "paper_trading_handoff_2026-05-14.md");
  const status = path.join(STRATEGIES_DIR, "paper_trading_status_2026-05-14.md");
  const handoffText = readText(handoff) || "";
  const statusText = readText(status) || "";
  const hygiene = buildPaperDataHygiene();
  const imported = importPaperSqliteTrades();
  const cleanStart = readJson(PAPER_TRADING_CLEAN_START_FILE, null);
  const sierraConfig = readSierraSymbolConfig();
  const paperSymbol = sierraConfig.paper.symbol;
  const paperDisplaySymbol = sierraConfig.paper.displaySymbol || paperSymbol;
  const paperSymbolUpdatedAt = sierraConfig.paper.updatedAt || "unknown date";
  const paperSymbolReason = `paper chartbook current-service symbol is ${paperDisplaySymbol} as of ${paperSymbolUpdatedAt}`;
  const strategies = [
    {
      name: "Ocean Trading MNQ Opening Range Breakout 2R",
      sierraStudy: "Ocean Trading NQ Opening Range Breakout 2R",
      instrument: paperSymbol,
      mode: "paper",
      status: "configured_chart_level_symbol_confirmed",
      sourceFile: OCEAN_TRADING_SOURCE,
      backtestReport: path.join(BACKTEST_DIR, "oce-8-report.md"),
      trades: 134,
      winRate: 0.5746,
      netProfitDollars: 9429,
      profitFactor: 1.83,
      maxDrawdownDollars: 1449,
      longTrades: null,
      shortTrades: null,
      decision: "approved_for_paper_trading",
      reason: `Approved bundled paper strategy on MNQ; ${paperSymbolReason}.`,
    },
    {
      name: "VWAP Momentum Reclaim 2R Capped",
      sierraStudy: "Ocean Trading NQ VWAP Reclaim Pullback 2R",
      selectedCandidate: "grid_s5_st25_cd10_sw4000_mt6_b025",
      instrument: paperSymbol,
      mode: "paper",
      status: "configured_chart_level_symbol_confirmed",
      sourceFile: OCEAN_TRADING_SOURCE,
      backtestReport: path.join(BACKTEST_DIR, "vwap-grid-optimization-win40-summary.md"),
      trades: 2037,
      winRate: 0.462,
      netProfitDollars: 104587.86,
      profitFactor: 1.37,
      maxDrawdownDollars: 9590.99,
      worstTradeDollars: -1966.4,
      averageTradesPerDay: 5.2,
      longTrades: null,
      shortTrades: null,
      decision: "approved_for_paper_trading",
      reason: `Selected optimized VWAP grid because it met the above-40% win-rate preference while keeping worst completed trade under the $2,000 blow-up threshold; ${paperSymbolReason}.`,
    },
  ];
  const separation = buildPaperDashboardSeparation(imported, strategies);
  return {
    sourceFiles: [
      handoff,
      status,
      cleanStart ? PAPER_TRADING_CLEAN_START_FILE : null,
      ...(imported.sourceFiles || []),
    ].filter((file) => file && fs.existsSync(file)),
    account: sierraConfig.paper.account || "Sim1",
    instanceRoot: sierraConfig.paper.root || PAPER_SIERRA_ROOT,
    symbol: paperSymbol,
    displaySymbol: paperDisplaySymbol,
    dataFile: sierraConfig.paper.dataFile || path.join(sierraConfig.paper.dataFolder || path.join(PAPER_SIERRA_ROOT, "Data"), `${paperSymbol}.scid`),
    service: sierraConfig.paper.service || null,
    symbolUpdatedAt: sierraConfig.paper.updatedAt || null,
    dataPort: sierraConfig.paper.dataPort || 11298,
    tradingPort: sierraConfig.paper.tradingPort || 11299,
    status: statusText.includes("blocked pending final chart-level load confirmation")
      ? "blocked_pending_chart_level_load_confirmation"
      : "configured",
    summary: "Dedicated paper dashboard for MNQ Sierra Chart simulation work. Paper calendar and ledger rows are read from the paper telemetry SQLite ledger only.",
    dataHygiene: hygiene,
    strategies,
    trades: imported.recentTrades || [],
    performanceTrades: imported.allTrades || [],
    closedTrades: imported.recentClosedTrades || [],
    performanceClosedTrades: imported.performanceClosedTrades || imported.allClosedTrades || [],
    strategyClosedTrades: imported.strategyClosedTrades || [],
    dailyNetProfitLossDollars: imported.dailyNetProfitLossDollars ?? null,
    dailyNetProfitLossDateUtc: imported.dailyNetProfitLossDateUtc ?? null,
    dailyNetProfitLossSourceFile: imported.dailyNetProfitLossSourceFile ?? null,
    openPositions: imported.openPositions || [],
    separation,
    importSummary: imported.summary,
    sourceHealth: imported.sourceHealth || imported.summary?.sourceHealth || null,
    cleanStart,
    accountMonitor: imported.accountMonitor,
    reconciliation: imported.reconciliation,
    dtcSnapshot: imported.dtcSnapshot || imported.summary?.dtcSnapshot || null,
    fullLedgerFile: imported.fullLedgerFile,
    reconciliationReportFile: imported.reconciliationReportFile,
    importPolicy: {
      source: "PATrading paper telemetry SQLite ledger opened read-only with mode=ro, cache=private, PRAGMA query_only=ON, and short-lived reads.",
      sqliteFile: PATRADING_PAPER_SQLITE_FILE,
      cleanStart: "Clean-start filtering is not applied to the paper dashboard because the paper telemetry SQLite ledger is the source of truth.",
      attribution: "Strategy, account, side, quantity, prices, timestamps, status, and P/L come directly from the PATrading trades table.",
      separation: "Paper dashboard calendar and right-hand ledger do not fall back to Sierra TradeActivityLogs.",
    },
    handoffSnippet: handoffText.split("\n").slice(0, 34).join("\n").trim(),
    statusSnippet: statusText.split("\n").slice(0, 42).join("\n").trim(),
  };
}

function isPaperStrategyLog(entry) {
  if (!/^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(entry.name)) return false;
  if (!/\.Sim[1-5](\.simulated)?\.data$/i.test(entry.name)) return false;
  const cleanStart = readJson(PAPER_TRADING_CLEAN_START_FILE, {});
  if (cleanStart.effectiveDateUtc) {
    const fileDate = parseLiveLogFileName(entry.name).tradeDateUtc;
    if (fileDate && fileDate < cleanStart.effectiveDateUtc) return false;
  }
  return true;
}

function cleanStartTimestampMs(cleanStart) {
  const raw = cleanStart?.cleanedAtUtc || cleanStart?.effectiveAtUtc || null;
  if (!raw) return null;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function eventTimestampMs(event) {
  const raw = event?.tradeDateUtc || null;
  if (!raw) return null;
  const text = String(raw);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00Z`
    : /Z$|[+-]\d{2}:?\d{2}$/i.test(text)
      ? text
      : `${text}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyPaperCleanStartEventCutoff(events, cleanStart) {
  const cutoffMs = cleanStartTimestampMs(cleanStart);
  if (cutoffMs === null) {
    return {
      events,
      eventsBeforeCleanStart: events.length,
      eventsFilteredBeforeCleanStart: 0,
      cleanStartCleanedAtUtc: cleanStart?.cleanedAtUtc || null,
    };
  }
  const filtered = events.filter((event) => {
    const eventMs = eventTimestampMs(event);
    return eventMs === null || eventMs >= cutoffMs;
  });
  return {
    events: filtered,
    eventsBeforeCleanStart: events.length,
    eventsFilteredBeforeCleanStart: events.length - filtered.length,
    cleanStartCleanedAtUtc: cleanStart?.cleanedAtUtc || null,
  };
}

function buildPaperDashboardSeparation(imported, approvedStrategies) {
  const approved = new Set(
    approvedStrategies
      .flatMap((strategy) => [strategy.name, strategy.sierraStudy])
      .filter(Boolean),
  );
  const allTrades = imported.allTrades || [];
  const allClosedTrades = imported.allClosedTrades || [];
  const openPositions = imported.openPositions || [];
  const approvedTrades = allTrades.filter((trade) => approved.has(trade.strategyName) || approved.has(trade.strategyStudy));
  const offBundleTrades = allTrades.filter((trade) => trade.tradeSource === "strategy" && !approved.has(trade.strategyName) && !approved.has(trade.strategyStudy));
  const manualTrades = allTrades.filter((trade) => trade.tradeSource !== "strategy");
  const approvedClosedTrades = allClosedTrades.filter((trade) => approved.has(trade.strategyName) || approved.has(trade.strategyStudy));
  const offBundleClosedTrades = allClosedTrades.filter((trade) => trade.tradeSource === "strategy" && !approved.has(trade.strategyName) && !approved.has(trade.strategyStudy));
  const manualClosedTrades = allClosedTrades.filter((trade) => trade.tradeSource !== "strategy");
  const approvedOpenPositions = openPositions.filter((trade) => approved.has(trade.strategyName) || approved.has(trade.strategyStudy));
  const offBundleOpenPositions = openPositions.filter((trade) => trade.tradeSource === "strategy" && !approved.has(trade.strategyName) && !approved.has(trade.strategyStudy));
  const manualOpenPositions = openPositions.filter((trade) => trade.tradeSource !== "strategy");
  const grouped = new Map();

  for (const trade of offBundleClosedTrades) {
    const key = trade.strategyName || trade.strategyStudy || "Unapproved paper strategy";
    const bucket = grouped.get(key) || {
      strategy: key,
      sourceFile: trade.sourceFile || null,
      chartbooks: new Set(),
      tradesObserved: 0,
      fillsObserved: 0,
      pnl: 0,
    };
    bucket.tradesObserved += 1;
    bucket.fillsObserved += Number(trade.quantity) || 0;
    bucket.pnl += Number(trade.realizedPnlDollars) || 0;
    if (trade.chartbook) bucket.chartbooks.add(trade.chartbook);
    grouped.set(key, bucket);
  }

  for (const trade of offBundleTrades) {
    const key = trade.strategyName || trade.strategyStudy || "Unapproved paper strategy";
    const bucket = grouped.get(key) || {
      strategy: key,
      sourceFile: trade.sourceFile || null,
      chartbooks: new Set(),
      tradesObserved: 0,
      fillsObserved: 0,
      pnl: 0,
    };
    bucket.fillsObserved += Number(trade.quantity) || 0;
    if (trade.chartbook) bucket.chartbooks.add(trade.chartbook);
    grouped.set(key, bucket);
  }

  const offBundleRows = [...grouped.values()].map((row) => ({
    strategy: row.strategy,
    paperTradingPerformed: "connector-attributed but not approved",
    tradesObserved: row.tradesObserved,
    fillsObserved: row.fillsObserved,
    missedSignals: 0,
    recommendation: row.chartbooks.size
      ? `Isolated from approved paper totals. Observed on ${[...row.chartbooks].join(", ")} until explicitly approved.`
      : "Isolated from approved paper totals until explicitly approved.",
    sourceSystem: "sierra",
    sourceDetail: "Sierra connector paper log attribution outside the approved paper bundle",
    sourceFile: row.sourceFile,
    realizedPnlDollars: Number(row.pnl.toFixed(2)),
  }));

  return {
    approvedBundle: {
      trades: approvedTrades,
      closedTrades: approvedClosedTrades,
      openPositions: approvedOpenPositions,
    },
    otherStrategies: {
      trades: offBundleTrades,
      closedTrades: offBundleClosedTrades,
      openPositions: offBundleOpenPositions,
      rows: offBundleRows,
    },
    manual: {
      trades: manualTrades,
      closedTrades: manualClosedTrades,
      openPositions: manualOpenPositions,
    },
  };
}

function isCopiedManualPaperLog(entry) {
  return /^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(entry.name)
    && !/\.Sim[1-5](\.simulated)?\.data$/i.test(entry.name)
    && !/\.None\.data$/i.test(entry.name);
}

function buildPaperDataHygiene() {
  const cleanStart = readJson(PAPER_TRADING_CLEAN_START_FILE, null);
  const sqliteExists = fs.existsSync(PATRADING_PAPER_SQLITE_FILE);
  const sqliteStat = sqliteExists ? fs.statSync(PATRADING_PAPER_SQLITE_FILE) : null;
  const hygiene = {
    policy: "Paper dashboard calendar, summary, and right-hand ledger read only the PATrading paper telemetry SQLite ledger. Sierra paper TradeActivityLogs are not a fallback for these UI areas.",
    paperSqliteFile: PATRADING_PAPER_SQLITE_FILE,
    paperSqliteExists: sqliteExists,
    paperSqliteSizeBytes: sqliteStat?.size ?? null,
    cleanStart,
    excludedManualHistoryArchiveDir: null,
    archivedCopiedManualLogCount: 0,
    activeCopiedManualLogCount: 0,
    activeCopiedManualLogs: [],
    activeStrategyLogCount: 0,
    activeStrategyLogExamples: [],
    artifactPath: PAPER_HYGIENE_ARTIFACT,
  };
  writePaperDataHygieneArtifact(hygiene);
  return hygiene;
}

function writePaperDataHygieneArtifact(hygiene) {
  const lines = [
    "# Paper Trading Data Hygiene",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Policy",
    "",
    `- ${hygiene.policy}`,
    "- The dashboard must not fall back to Sierra paper TradeActivityLogs for paper calendar, summary, or right-hand ledger values.",
    `- SQLite source: ${hygiene.paperSqliteFile}`,
    `- SQLite exists: ${hygiene.paperSqliteExists ? "yes" : "no"}`,
    `- SQLite size bytes: ${hygiene.paperSqliteSizeBytes ?? "n/a"}`,
    "",
    "## Cleanup Result",
    "",
    "- Old Sierra paper log import path: disabled for dashboard paper data.",
    "- Cleanup required: none for the SQLite ledger unless Wayne explicitly asks to remove runtime startup events.",
    "",
    "## Remaining Locked Files",
    "",
    ...(hygiene.activeCopiedManualLogs.length
      ? hygiene.activeCopiedManualLogs.map((file) => `- ${file}`)
      : ["- None"]),
    "",
  ];
  fs.mkdirSync(path.dirname(PAPER_HYGIENE_ARTIFACT), { recursive: true });
  fs.writeFileSync(PAPER_HYGIENE_ARTIFACT, lines.join("\n"));
}

function buildLiveTradingPlan() {
  const handoff = path.join(STRATEGIES_DIR, "sierra_live_trader_handoff_2026-05-14.md");
  const imported = importLiveSqliteTrades();
  const cleanStart = readJson(LIVE_TRADING_CLEAN_START_FILE, null);
  const hasLiveImport = Boolean(
    imported.summary?.filesScanned ||
      imported.summary?.eventsImported ||
      imported.summary?.fillsImported ||
      imported.summary?.closedTrades ||
      imported.summary?.openPositions ||
      imported.accounts?.length,
  );
  return {
    sourceFiles: [...(fs.existsSync(handoff) ? [handoff] : []), ...(cleanStart ? [LIVE_TRADING_CLEAN_START_FILE] : []), ...(imported.sourceFiles || [])],
    instanceRoot: LIVE_SIERRA_ROOT,
    tradeActivityLogDir: LIVE_TRADE_LOG_DIR,
    liveSqliteFile: PATRADING_LIVE_SQLITE_FILE,
    status: hasLiveImport ? "ledger_imported_execution_disabled" : "clean_start_no_live_data",
    account: imported.accounts?.length ? `${imported.accounts.length} imported live account log set(s)` : "No live account logs found",
    summary: hasLiveImport
      ? "Live trade data is imported from the PATrading live SQLite logger."
      : "No live trade data is currently available from the PATrading live SQLite logger.",
    strategies: [],
    trades: imported.recentTrades || [],
    performanceTrades: imported.allTrades || [],
    closedTrades: imported.recentClosedTrades || [],
    performanceClosedTrades: imported.allClosedTrades || [],
    openPositions: imported.openPositions || [],
    importSummary: imported.summary,
    cleanStart,
    accountMonitor: imported.accountMonitor,
    accountSnapshots: imported.accountSnapshots,
    profitReconciliation: imported.profitReconciliation,
    dtcSnapshot: imported.dtcSnapshot || imported.summary?.dtcSnapshot || null,
    fullLedgerFile: imported.fullLedgerFile,
    importPolicy: {
      source: "PATrading live SQLite ledger opened read-only with mode=ro, cache=private, PRAGMA query_only=ON, and short-lived reads.",
      sqliteFile: PATRADING_LIVE_SQLITE_FILE,
      accountMonitorSource: "Sierra Chart TradeAccountData binary .data files are preferred for True Profit when available.",
      cleanStart: "Clean-start filtering is not applied to live dashboard trade rows because the PATrading live SQLite ledger is the source of truth.",
      excludedLogs: "Live dashboard calendar, ledger, and live page do not fall back to Sierra TradeActivityLogs.",
      classification: "Trade classification, strategy attribution, account, side, quantity, prices, status, and P/L come directly from the PATrading live SQLite trades table.",
      dailyReportScope: "Daily report should import the previous Europe/London calendar day's live Sierra activity and update this ledger.",
    },
    blockers: [
      "No strategy has completed paper-trading approval for live deployment.",
      "Live Trader metadata requires explicit board approval before any live execution.",
      "Live Sierra instance must remain separate from the paper instance.",
    ],
  };
}

function buildLucidFlexRules() {
  return {
    profileName: "Lucid Flex 50K",
    updatedAtUtc: new Date().toISOString(),
    accountPhaseFocus: "Use these limits for live-account simulation governance and strategy acceptance checks.",
    sources: [
      "https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account",
      "https://support.lucidtrading.com/en/articles/12945795-lucidflex-funded-account",
      "https://support.lucidtrading.com/en/articles/12945805-lucidflex-consistency-percentage",
      "https://support.lucidtrading.com/en/articles/12945815-lucidflex-drawdown",
      "https://support.lucidtrading.com/en/articles/12945808-lucidflex-scaling-plan",
      "https://support.lucidtrading.com/en/articles/13425130-new-live-structure",
      "https://lucidtrading.com/general-faq/",
    ],
    evaluation: {
      accountSize: 50000,
      profitTargetDollars: 3000,
      maxLossLimitDollars: 2000,
      consistencyMaxPercent: 0.5,
      largestDayAtTargetMaxDollars: 1500,
      cushionExampleAtTargetDollars: 1560,
      maxContracts: "4 minis or 40 micros",
      dailyLossLimit: "None",
      scalingPlan: "No scaling limits during evaluation.",
      governance: [
        "Do not keep trading aggressively after reaching the $3,000 target; continue only if consistency is not satisfied.",
        "If account profit is at or above target and largest day / account profit is above 50%, trade only enough to dilute the consistency percentage.",
        "Any live-simulation plan that can breach the $2,000 MLL must be blocked before order placement.",
      ],
    },
    funded: {
      accountSize: 50000,
      maxLossLimitDollars: 2000,
      dailyLossLimit: "None",
      consistencyRule: "None for LucidFlex funded accounts per official funded-account page.",
      payoutRequirements: "5 profitable days of at least $150 plus positive net profit in payout cycle.",
      payoutMax: "50% of profit up to $2,000 for 50K Flex.",
      scalingPlan: [
        { profitRange: "$0 - $999", maxContracts: "2 minis or 20 micros" },
        { profitRange: "$1,000 - $1,999", maxContracts: "3 minis or 30 micros" },
        { profitRange: "$2,000 - $2,999", maxContracts: "4 minis or 40 micros" },
      ],
    },
    live: {
      startingBalanceDollars: 0,
      startingLiveDrawdownDollars: 2000,
      maxLiveContracts: "4 minis or 40 micros",
      dailyLossLimit: "None",
      drawdownMethod: "End-of-day drawdown",
      liveTargetForBonusDollars: 2100,
      noHedging: true,
      cooldownAfterLiveBreach: "Standard cooldown period shown as 2 weeks; risk team can extend for reckless behavior.",
      governance: [
        "Live simulation must treat the $2,000 drawdown as a hard fail floor.",
        "Never place a trade if planned total risk plus current open risk can take the account below the live drawdown floor.",
        "Use bracketed orders only; unknown or manual trades remain separate from Ocean Trading strategy performance.",
      ],
    },
    platformRules: {
      simCloseOut: "LucidPro, LucidFlex, and LucidDirect sim positions must be closed by 4:45 PM US Eastern and trading resumes at 6:00 PM US Eastern.",
      overnight: "Overnight holding is not permitted on sim accounts; LucidLive may hold overnight subject to margin/risk settings.",
      microscalping: "Flag risk if more than 50% of profits come from trades held 5 seconds or less.",
      hft: "High-frequency or abusive trading is prohibited.",
      automation: "Automated strategies/copy trading are permitted, but the trader remains responsible for software errors.",
    },
    strategyAcceptance: {
      maxPlannedRiskDollars: 2000,
      minAccountBufferDollars: 2000,
      preferredRiskPerTradeDollars: "Use materially less than $2,000 where possible; $2,000 is the fail floor, not a target.",
      mustReport: [
        "Projected worst completed trade and intratrade adverse excursion against the $2,000 MLL.",
        "Largest single-day profit and consistency percentage during evaluation-style tests.",
        "Daily P/L distribution so over-earning one day does not block consistency.",
        "Contract sizing under Flex funded/live scaling tiers.",
      ],
    },
  };
}

function defaultPropFirmRuleSets() {
  return {
    ruleSets: [
      {
        id: "lucid-flex-50k-evaluation",
        provider: "Lucid",
        program: "LucidFlex",
        accountSize: 50000,
        phase: "evaluation",
        label: "Lucid Flex 50K Evaluation",
        profitTargetDollars: 3000,
        maxLossLimitDollars: 2000,
        dailyLossLimitDollars: null,
        dailyLossLimitDescription: "None on LucidFlex evaluation accounts.",
        consistency: {
          enabled: true,
          maxPercent: 0.5,
          formula: "Largest single-day profit / account profit",
          largestDayAtTargetDollars: 1500,
          cushionExampleAtTargetDollars: 1560,
        },
        minTradingDays: null,
        maxPositionSize: {
          minis: 4,
          micros: 40,
          description: "4 minis or 40 micros",
        },
        profitClassification: "qualification_progress_not_withdrawable",
        failureRules: [
          "Account fails if the max loss limit is reached.",
          "Account cannot upgrade until the profit target and consistency requirement are both satisfied.",
        ],
        sourceUrls: [
          "https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account",
          "https://support.lucidtrading.com/en/articles/12945805-lucidflex-consistency-percentage",
        ],
        updatedAtUtc: new Date().toISOString(),
      },
    ],
  };
}

function loadPropFirmRuleSets() {
  const existing = readJson(PROP_FIRM_RULE_SETS_FILE, null);
  if (existing?.ruleSets?.length) return existing;
  const defaults = defaultPropFirmRuleSets();
  fs.mkdirSync(path.dirname(PROP_FIRM_RULE_SETS_FILE), { recursive: true });
  fs.writeFileSync(PROP_FIRM_RULE_SETS_FILE, JSON.stringify(defaults, null, 2));
  return defaults;
}

function loadPropFirmAccountAssignments() {
  const existing = readJson(PROP_FIRM_ACCOUNTS_FILE, null);
  if (existing?.accounts) return existing;
  const defaults = {
    accounts: {},
    notes: "Confirmed prop-firm rule-set links are stored here. Unknown accounts can be confirmed from the website.",
  };
  fs.mkdirSync(path.dirname(PROP_FIRM_ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(PROP_FIRM_ACCOUNTS_FILE, JSON.stringify(defaults, null, 2));
  return defaults;
}

function suggestRuleSetForAccount(account) {
  const value = String(account || "").toUpperCase();
  if (/^(LFE|LTE)/.test(value)) return "lucid-flex-50k-evaluation";
  return null;
}

function collectTradingAccounts(...modePayloads) {
  const accounts = new Map();
  for (const mode of modePayloads) {
    for (const account of mode?.accounts || []) {
      if (!account) continue;
      const current = accounts.get(account) || { account, modes: new Set(), tradeCount: 0 };
      current.modes.add(mode.mode || "unknown");
      accounts.set(account, current);
    }
    for (const collection of ["performanceTrades", "performanceClosedTrades", "openPositions"]) {
      for (const row of mode?.[collection] || []) {
        const account = row.account;
        if (!account) continue;
        const current = accounts.get(account) || { account, modes: new Set(), tradeCount: 0 };
        current.modes.add(mode.mode || "unknown");
        current.tradeCount += 1;
        current.accountType = row.accountType || current.accountType;
        current.accountFamily = row.accountFamily || current.accountFamily;
        accounts.set(account, current);
      }
    }
  }
  return [...accounts.values()].map((entry) => ({
    ...entry,
    modes: [...entry.modes].sort(),
  }));
}

function buildPropFirmConfig(liveTrading, paperTrading) {
  const ruleSets = loadPropFirmRuleSets();
  const assignments = loadPropFirmAccountAssignments();
  const liveWithMode = { ...liveTrading, mode: "live" };
  const paperWithMode = { ...paperTrading, mode: "paper" };
  const accounts = collectTradingAccounts(liveWithMode, paperWithMode).map((account) => {
    const confirmed = assignments.accounts?.[account.account] || null;
    const suggestedRuleSetId = suggestRuleSetForAccount(account.account);
    const ruleSetId = confirmed?.ruleSetId || suggestedRuleSetId;
    const status = confirmed?.status || (suggestedRuleSetId ? "needs_review" : "unassigned");
    return {
      ...account,
      provider: confirmed?.provider || (suggestedRuleSetId ? "Lucid" : account.accountFamily || "Unknown"),
      phase: confirmed?.phase || (suggestedRuleSetId ? "evaluation" : null),
      ruleSetId,
      suggestedRuleSetId,
      status,
      confirmed: Boolean(confirmed?.confirmedAtUtc),
      confirmedAtUtc: confirmed?.confirmedAtUtc || null,
      notes: confirmed?.notes || null,
    };
  });
  return {
    ruleSets: ruleSets.ruleSets,
    accounts,
    files: {
      ruleSets: PROP_FIRM_RULE_SETS_FILE,
      accounts: PROP_FIRM_ACCOUNTS_FILE,
    },
  };
}

function writeLucidRulesArtifact(rules) {
  const lines = [
    "# Lucid Flex 50K Risk Profile",
    "",
    `Generated: ${rules.updatedAtUtc}`,
    "",
    "## Evaluation",
    "",
    `- Profit target: $${rules.evaluation.profitTargetDollars.toLocaleString("en-US")}`,
    `- Max loss limit: $${rules.evaluation.maxLossLimitDollars.toLocaleString("en-US")}`,
    `- Consistency: largest single-day profit / account profit must be <= ${(rules.evaluation.consistencyMaxPercent * 100).toFixed(0)}%`,
    `- Largest day at target guide: $${rules.evaluation.largestDayAtTargetMaxDollars.toLocaleString("en-US")} at a $${rules.evaluation.profitTargetDollars.toLocaleString("en-US")} target`,
    `- Max size: ${rules.evaluation.maxContracts}`,
    "",
    "## Funded",
    "",
    `- Max loss limit: $${rules.funded.maxLossLimitDollars.toLocaleString("en-US")}`,
    `- Consistency rule: ${rules.funded.consistencyRule}`,
    `- Payout eligibility: ${rules.funded.payoutRequirements}`,
    `- Payout maximum: ${rules.funded.payoutMax}`,
    "",
    "## Live",
    "",
    `- Starting balance: $${rules.live.startingBalanceDollars}`,
    `- Starting live drawdown: $${rules.live.startingLiveDrawdownDollars.toLocaleString("en-US")}`,
    `- Max live contracts: ${rules.live.maxLiveContracts}`,
    `- Drawdown method: ${rules.live.drawdownMethod}`,
    "",
    "## Ocean Trading Governance",
    "",
    ...rules.strategyAcceptance.mustReport.map((item) => `- ${item}`),
    "",
    "## Sources",
    "",
    ...rules.sources.map((source) => `- ${source}`),
    "",
  ];
  fs.mkdirSync(path.dirname(LUCID_RULES_ARTIFACT), { recursive: true });
  fs.writeFileSync(LUCID_RULES_ARTIFACT, lines.join("\n"));
}

function isLiveTradeActivityFile(entry) {
  if (!/^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(entry.name)) return false;
  if (/\.None\.data$/i.test(entry.name)) return false;
  if (/Sim1|simulated/i.test(entry.name)) return false;
  const cleanStart = readJson(LIVE_TRADING_CLEAN_START_FILE, {});
  if (cleanStart.effectiveDateUtc) {
    const fileDate = parseLiveLogFileName(entry.name).tradeDateUtc;
    if (fileDate && fileDate < cleanStart.effectiveDateUtc) return false;
  }
  const excluded = readJson(EXCLUDED_LIVE_TRADE_FILES_FILE, {});
  const excludedFiles = new Set((excluded.files || []).map((file) => path.resolve(file).toLowerCase()));
  if (excludedFiles.has(path.resolve(entry.absPath).toLowerCase())) return false;
  return true;
}

function cleanLogString(value) {
  return String(value || "").replace(/[^\x20-\x7e]+$/g, "").trim();
}

function extractPrintableStrings(filePath) {
  const buffer = fs.readFileSync(filePath);
  return (buffer.toString("latin1").match(/[ -~]{5,}/g) || []).map(cleanLogString).filter(Boolean);
}

function parsePaperDailyNetPnlFromLog(filePath) {
  let latest = null;
  for (const line of extractPrintableStrings(filePath)) {
    const match = line.match(/Profit management:\s*Daily Net P\/L =\s*(-?\d+(?:\.\d+)?)/i);
    if (match) latest = Number(match[1]);
  }
  return Number.isFinite(latest) ? Number(latest.toFixed(2)) : null;
}

function parseLiveLogFileName(name) {
  const match = name.match(/^TradeActivityLog_(\d{4}-\d{2}-\d{2})_UTC\.(.+)\.data$/i);
  const account = String(match?.[2] || "unknown").replace(/\.simulated$/i, "");
  return {
    tradeDateUtc: match?.[1] || null,
    account,
  };
}

function classifyTradeFromContext(context) {
  const joinedContext = (context || []).map((line) => String(line || "")).join(" | ");
  if (/OQL VCB D4\.2|Diagnostic Margins\s*\/\s*Unchanged D4 Rules|OQLVCBI8|OQL_VCB_D4/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "OQL VCB D4.2",
      strategyStudy: "OQL VCB D4.2 (Diagnostic Margins / Unchanged D4 Rules / Native Brackets)",
      approvalStatus: "strategy",
      dashboardBucket: "replay_strategy_oql_vcb_d42",
    };
  }
  if (/OQL VCB Strategy v2\.3\.5/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "OQL VCB Strategy v2.3.5",
      strategyStudy: "OQL VCB Strategy v2.3.5",
      approvalStatus: "strategy",
      dashboardBucket: "replay_strategy_oql_vcb_v235",
    };
  }
  if (/OQL_VCB_V2_3/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "OQL VCB Strategy v2.3",
      strategyStudy: "OQL VCB Strategy v2.3",
      approvalStatus: "strategy",
      dashboardBucket: "replay_strategy_oql_vcb_v23",
    };
  }
  if (/VWAP Wave Pullback/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "VWAP Wave Pullback",
      strategyStudy: "VWAP Wave Pullback",
      approvalStatus: "strategy",
      dashboardBucket: "paper_strategy_vwap_wave_pullback",
    };
  }
  if (/VWAP Momentum Reclaim/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "VWAP Momentum Reclaim 2R Capped",
      strategyStudy: "VWAP Momentum Reclaim",
      approvalStatus: "strategy",
      dashboardBucket: "paper_strategy_vwap_momentum_reclaim",
    };
  }
  if (/Opening Range Breakout/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "Ocean Trading MNQ Opening Range Breakout 2R",
      strategyStudy: "Ocean Trading NQ Opening Range Breakout 2R",
      approvalStatus: "strategy",
      dashboardBucket: "paper_strategy_orb",
    };
  }
  if (/PATrading|H2\s*\/\s*L2|H2\s*L2/i.test(joinedContext)) {
    return {
      tradeSource: "strategy",
      strategyName: "PATrading H2 / L2 Entry",
      strategyStudy: "PATrading H2 / L2 Entry",
      approvalStatus: "strategy",
      dashboardBucket: "replay_strategy_patrading_h2_l2",
    };
  }
  return paperTradeAttribution?.classifyPaperTradeContext?.({ context })
    || {
      tradeSource: "manual",
      strategyName: "Manual Trade",
      strategyStudy: null,
      approvalStatus: "manual",
      dashboardBucket: "manual_paper",
    };
}

function manualTradeClassification(dashboardBucket = "manual") {
  return {
    tradeSource: "manual",
    strategyName: "Manual Trade",
    strategyStudy: null,
    approvalStatus: "manual",
    dashboardBucket,
  };
}

function parseSymbol(value) {
  const text = String(value || "");
  const dotted = text.match(/\b([A-Z0-9]{2,8}\.(?:CME|COMEX|NYMEX)(?:\[M\])?)\b/);
  if (dotted) return dotted[1].replace("[M]", "");
  const sierraService = text.match(/\b([A-Z0-9]{2,12}_FUT_(?:CME|COMEX|NYMEX)(?:\[M\])?)\b/);
  return sierraService ? sierraService[1].replace("[M]", "") : null;
}

function parseLastPrice(value) {
  const match = String(value || "").match(/\bLast:\s*(-?\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

function parseAutoTradeContext(line, tradeDateUtc) {
  const text = String(line || "");
  if (!/^Auto-trade:/i.test(text)) return null;
  const action = text.includes("BuyEntry")
    ? "BuyEntry"
    : text.includes("SellEntry")
      ? "SellEntry"
      : text.includes("Flatten&CancelAllOrders")
        ? "Flatten"
        : null;
  if (!action) return null;
  const currentPositionMatch = text.match(/Current Position quantity:\s*(-?\d+)/i);
  const barTimeMatch = text.match(/Bar start date-time:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?/i);
  const barTime = barTimeMatch ? `${barTimeMatch[1]}T${barTimeMatch[2]}` : tradeDateUtc;
  return {
    action,
    currentPositionQty: currentPositionMatch ? Number(currentPositionMatch[1]) : null,
    key: `${action}|${barTime}|${parseLastPrice(text) ?? "no-price"}`,
    tradeDateUtc: barTime || tradeDateUtc,
  };
}

function parseSimulationFillPrice(line, side) {
  const text = String(line || "");
  const bidMatch = text.match(/\bBid:\s*(-?\d+(?:\.\d+)?)/i);
  const askMatch = text.match(/\bAsk:\s*(-?\d+(?:\.\d+)?)/i);
  if (side === "Buy" && askMatch) return Number(askMatch[1]);
  if (side === "Sell" && bidMatch) return Number(bidMatch[1]);
  const lastMatch = text.match(/\bLast:\s*(-?\d+(?:\.\d+)?)/i);
  if (lastMatch) return Number(lastMatch[1]);
  if (bidMatch && askMatch) return (Number(bidMatch[1]) + Number(askMatch[1])) / 2;
  return null;
}

function parseLiveTradeActivityFile(file) {
  const { tradeDateUtc, account } = parseLiveLogFileName(file.name);
  const records = parseTradeActivityRecords(file.absPath);
  const events = [];
  const positions = new Map();
  const context = [];
  let lastClassification = classifyTradeFromContext([]);
  let lastAutoTrade = null;
  let lastChartbook = null;

  for (const record of records) {
    const recordType = tradeRecordInteger(record, 101);
    const message = tradeRecordString(record, 104);
    const symbol = tradeRecordString(record, 103);
    const recordAccount = tradeRecordString(record, 118) || account;
    const chartbook = tradeRecordString(record, 127) || lastChartbook;
    if (chartbook) lastChartbook = chartbook;

    if (message) {
      context.push(message);
      if (context.length > 16) context.shift();
      if (/User order entry/i.test(message)) {
        lastClassification = manualTradeClassification("manual_live");
        lastAutoTrade = null;
      }
      const autoTrade = parseAutoTradeContext(message, tradeDateUtc);
      if (autoTrade) {
        lastClassification = paperTradeAttribution?.classifyPaperTradeContext?.({ context, chartbook })
          || classifyTradeFromContext(context);
        lastAutoTrade = autoTrade;
      }
    }

    if (recordType !== 2 || !/(?:Filled|Partial fill)/i.test(message)) continue;
    const sideCode = tradeRecordInteger(record, 109);
    const side = sideCode === 1 ? "Buy" : sideCode === 2 ? "Sell" : null;
    const price = normalizeTradeActivityRecordPrice(symbol, tradeRecordDouble(record, 113));
    if (!side || price === null || !symbol || !recordAccount) continue;

    const key = `${recordAccount}|${symbol}`;
    const previousPosition = positions.get(key) || 0;
    const recordedPosition = tradeRecordDouble(record, 125);
    const positionAfter = Number.isFinite(recordedPosition) ? recordedPosition : 0;
    const quantity = Math.abs(positionAfter - previousPosition);
    if (!quantity) continue;
    positions.set(key, positionAfter);

    const recordTimeUtc = tradeRecordSierraDateTimeUtc(record, 102)
      || tradeRecordSierraDateTimeUtc(record, 160)
      || lastAutoTrade?.tradeDateUtc
      || tradeDateUtc;

    events.push({
      sequence: events.length + 1,
      eventType: "fill",
      sourceFile: file.absPath,
      tradeDateUtc: recordTimeUtc,
      account: recordAccount,
      symbol,
      chartbook,
      price,
      side,
      quantity,
      positionAfter,
      previousPosition,
      internalOrderId: tradeRecordString(record, 124) || tradeRecordString(record, 106) || null,
      status: positionAfter === 0 ? "Position flattened / reduced" : "Position updated",
      ...lastClassification,
    });
  }

  return events.length ? events : parseLiveTradeActivityFileFromStrings(file);
}

function parseLiveTradeActivityFileFromStrings(file) {
  const { tradeDateUtc, account } = parseLiveLogFileName(file.name);
  const strings = extractPrintableStrings(file.absPath);
  const events = [];
  const context = [];
  let lastSymbol = null;
  let lastChartbook = null;
  let lastPrice = null;
  let lastClassification = classifyTradeFromContext([]);
  let lastAutoTrade = null;
  let lastOrderId = null;
  let lastOrderType = null;
  let pendingOrderQuantityHint = null;
  const emittedSimulationFills = new Set();
  const simulatedPositions = new Map();
  const orderTypesById = new Map();
  const orderQuantityHintsById = new Map();

  for (const raw of strings) {
    const line = cleanLogString(raw);
    const symbol = parseSymbol(line);
    if (symbol) lastSymbol = symbol;
    if (/\.cht$/i.test(line)) lastChartbook = line;
    const price = parseLastPrice(line);
    if (price !== null) lastPrice = price;
    const quantityHintMatch = line.match(/\bLastModifyQuantity of\s+(\d+)/i);
    if (quantityHintMatch) pendingOrderQuantityHint = Number(quantityHintMatch[1]);
    if (/^\d+k$/.test(line)) {
      lastOrderId = line.replace(/\D/g, "");
      if (pendingOrderQuantityHint !== null) {
        orderQuantityHintsById.set(lastOrderId, pendingOrderQuantityHint);
        pendingOrderQuantityHint = null;
      }
    }
    const orderTypeMatch = line.match(/^(Market|Limit|Stop)/i);
    if (orderTypeMatch) {
      lastOrderType = orderTypeMatch[1];
      if (lastOrderId) orderTypesById.set(lastOrderId, lastOrderType);
    }
    context.push(line);
    if (context.length > 16) context.shift();

    const autoTrade = parseAutoTradeContext(line, tradeDateUtc);
    if (autoTrade) {
      lastClassification = classifyTradeFromContext(context);
      lastAutoTrade = autoTrade;
    }

    if (/User order entry/i.test(line)) {
      lastClassification = manualTradeClassification("manual_live");
      lastAutoTrade = null;
      events.push({
        sequence: events.length + 1,
        eventType: "order_entry",
        sourceFile: file.absPath,
        tradeDateUtc,
        account,
        symbol: parseSymbol(line) || lastSymbol || "unknown",
        chartbook: lastChartbook,
        price: parseLastPrice(line) ?? lastPrice,
        side: "Order entry",
        quantity: null,
        positionAfter: null,
        previousPosition: null,
        internalOrderId: null,
        status: "Submitted from Sierra Chart",
        ...lastClassification,
      });
      continue;
    }

    if (/Trade simulation fill/i.test(line) && lastAutoTrade) {
      const orderType = lastOrderId ? orderTypesById.get(lastOrderId) || lastOrderType : lastOrderType;
      const fillKey = /Market/i.test(orderType || "")
        ? `${file.absPath}|${lastAutoTrade.key}`
        : `${file.absPath}|${lastOrderId || lastAutoTrade.key}|${orderType || "unknown"}`;
      if (emittedSimulationFills.has(fillKey)) continue;
      emittedSimulationFills.add(fillKey);
      const key = `${account || "Sim1"}|${lastSymbol || "unknown"}`;
      const previousPosition = simulatedPositions.get(key) || 0;
      let side = null;
      let quantity = 5;
      let positionAfter = previousPosition;
      if (/Market/i.test(orderType || "") && lastAutoTrade.action === "BuyEntry") {
        side = "Buy";
        positionAfter = previousPosition + quantity;
      } else if (/Market/i.test(orderType || "") && lastAutoTrade.action === "SellEntry") {
        side = "Sell";
        positionAfter = previousPosition - quantity;
      } else if (/Market/i.test(orderType || "") && lastAutoTrade.action === "Flatten") {
        const currentPosition = Number(lastAutoTrade.currentPositionQty);
        if (Number.isFinite(currentPosition) && currentPosition !== 0) {
          quantity = Math.abs(currentPosition);
          side = currentPosition > 0 ? "Sell" : "Buy";
          positionAfter = 0;
        }
      } else if (/^(Limit|Stop)$/i.test(orderType || "") && previousPosition !== 0) {
        const hintedQuantity = lastOrderId ? Number(orderQuantityHintsById.get(lastOrderId)) : NaN;
        quantity = Number.isFinite(hintedQuantity) && hintedQuantity > 0
          ? Math.min(Math.abs(previousPosition), hintedQuantity)
          : Math.abs(previousPosition);
        side = previousPosition > 0 ? "Sell" : "Buy";
        positionAfter = previousPosition + (side === "Buy" ? quantity : -quantity);
      }
      if (!side) continue;
      simulatedPositions.set(key, positionAfter);
      events.push({
        sequence: events.length + 1,
        eventType: "fill",
        sourceFile: file.absPath,
        tradeDateUtc: lastAutoTrade.tradeDateUtc || tradeDateUtc,
        account,
        symbol: lastSymbol || "unknown",
        chartbook: lastChartbook,
        price: parseSimulationFillPrice(line, side) ?? lastPrice,
        side,
        quantity,
        positionAfter,
        previousPosition,
        internalOrderId: lastOrderId,
        status: lastAutoTrade.action === "Flatten"
          ? "Simulated position flattened"
          : /^(Limit|Stop)$/i.test(orderType || "")
            ? "Simulated child order fill"
            : "Simulated strategy fill",
        ...lastClassification,
      });
      continue;
    }

    const positionMatch = line.match(/Updated Internal Position Quantity to\s+(-?\d+)\.\s+Previous:\s+(-?\d+)\.\s+Fill of InternalOrderID:\s+(\d+)/i);
    if (!positionMatch) continue;
    const positionAfter = Number(positionMatch[1]);
    const previousPosition = Number(positionMatch[2]);
    const quantity = Math.abs(positionAfter - previousPosition);
    if (!quantity) continue;
    const side = positionAfter > previousPosition ? "Buy" : "Sell";
    events.push({
      sequence: events.length + 1,
      eventType: "fill",
      sourceFile: file.absPath,
      tradeDateUtc,
      account,
      symbol: lastSymbol || "unknown",
      chartbook: lastChartbook,
      price: lastPrice,
      side,
      quantity,
      positionAfter,
      previousPosition,
      internalOrderId: positionMatch[3],
      status: positionAfter === 0 ? "Position flattened / reduced" : "Position updated",
      ...lastClassification,
    });
  }

  return events;
}

function parseTradeActivityRecords(filePath) {
  const buffer = fs.readFileSync(filePath);
  const records = [];
  let current = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const field = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (length > 1_000_000 || offset + length > buffer.length) break;
    const value = buffer.subarray(offset, offset + length);
    offset += length;
    if (field === 199) {
      if (current.length) records.push(current);
      current = [];
    } else {
      current.push({ field, length, value });
    }
  }

  if (current.length) records.push(current);
  return records;
}

function tradeRecordField(record, field) {
  return record.find((entry) => entry.field === field) || null;
}

function tradeRecordString(record, field) {
  const entry = tradeRecordField(record, field);
  return entry ? entry.value.toString("utf8").replace(/\0+$/g, "").trim() : "";
}

function tradeRecordInteger(record, field) {
  const entry = tradeRecordField(record, field);
  if (!entry) return null;
  if (entry.length === 1) return entry.value.readUInt8(0);
  if (entry.length === 2) return entry.value.readUInt16LE(0);
  if (entry.length >= 4) return entry.value.readInt32LE(0);
  return null;
}

function tradeRecordDouble(record, field) {
  const entry = tradeRecordField(record, field);
  return entry?.length >= 8 ? entry.value.readDoubleLE(0) : null;
}

function tradeRecordSierraDateTimeUtc(record, field) {
  const entry = tradeRecordField(record, field);
  if (!entry || entry.length < 8) return null;
  try {
    const micros = entry.value.readBigUInt64LE(0);
    if (micros <= 0n) return null;
    const baseMs = Date.UTC(1899, 11, 30);
    const timestampMs = baseMs + Number(micros / 1000n);
    const date = new Date(timestampMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d{3}Z$/, "");
  } catch {
    return null;
  }
}

function normalizeTradeActivityRecordPrice(symbol, rawPrice) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const normalized = String(symbol || "").replace("[M]", "").toUpperCase();
  const root = normalized.match(/^([A-Z0-9]+)/)?.[1] || "";
  if ((root.startsWith("NQ") || root.startsWith("MNQ") || root.startsWith("ES") || root.startsWith("MES")) && price > 100000) {
    return price / 100;
  }
  if ((root.startsWith("CL") || root.startsWith("MCL")) && price > 1000) return price / 1000;
  if (root.startsWith("NG") && price > 100) return price / 1000;
  return price;
}

function parsePaperTradeActivityFile(file, state = {}) {
  const { tradeDateUtc, account } = parseLiveLogFileName(file.name);
  const records = parseTradeActivityRecords(file.absPath);
  const events = [];
  const positions = state.positions || new Map();
  const context = state.context || [];
  let lastClassification = state.lastClassification || classifyTradeFromContext([]);
  let lastAutoTrade = state.lastAutoTrade || null;
  let lastChartbook = state.lastChartbook || null;

  for (const record of records) {
    const recordType = tradeRecordInteger(record, 101);
    const message = tradeRecordString(record, 104);
    const symbol = tradeRecordString(record, 103);
    const recordAccount = tradeRecordString(record, 118) || account;
    const chartbook = tradeRecordString(record, 127) || lastChartbook;
    const studyContext = tradeRecordString(record, 130);
    if (chartbook) lastChartbook = chartbook;
    const observedPositionKey = recordAccount && symbol ? `${recordAccount}|${symbol}` : null;
    const recordedPosition = tradeRecordDouble(record, 125);
    if (recordType !== 2 && observedPositionKey && Number.isFinite(recordedPosition)) {
      positions.set(observedPositionKey, recordedPosition);
    }

    if (message) {
      context.push(message);
      if (context.length > 16) context.shift();
      if (/User order entry/i.test(message)) {
        lastClassification = manualTradeClassification("manual_paper");
        lastAutoTrade = null;
      }
      const autoTrade = parseAutoTradeContext(message, tradeDateUtc);
      if (autoTrade) {
        lastClassification = paperTradeAttribution?.classifyPaperTradeContext?.({ context, chartbook })
          || classifyTradeFromContext(context);
        lastAutoTrade = autoTrade;
      }
    }
    if (studyContext) {
      const recordContext = [...context, studyContext].filter(Boolean);
      const recordClassification = paperTradeAttribution?.classifyPaperTradeContext?.({ context: recordContext, chartbook })
        || classifyTradeFromContext(recordContext);
      if (recordClassification?.tradeSource === "strategy") {
        lastClassification = recordClassification;
      }
    }

    if (recordType !== 2 || !/Trade simulation fill/i.test(message)) continue;
    const sideCode = tradeRecordInteger(record, 109);
    const side = sideCode === 1 ? "Buy" : sideCode === 2 ? "Sell" : null;
    const price = normalizeTradeActivityRecordPrice(symbol, tradeRecordDouble(record, 113));
    if (!side || price === null || !symbol || !recordAccount) continue;

    const key = `${recordAccount}|${symbol}`;
    const previousPosition = positions.get(key) || 0;
    const fillQuantity = tradeRecordDouble(record, 114);
    const inferredPositionAfter = Number.isFinite(fillQuantity)
      ? previousPosition + (side === "Buy" ? fillQuantity : -fillQuantity)
      : 0;
    const positionAfter = Number.isFinite(recordedPosition) ? recordedPosition : inferredPositionAfter;
    const quantity = Number.isFinite(fillQuantity) && fillQuantity > 0
      ? fillQuantity
      : Math.abs(positionAfter - previousPosition);
    if (!quantity) continue;
    positions.set(key, positionAfter);

    const recordTimeUtc = tradeRecordSierraDateTimeUtc(record, 102)
      || tradeRecordSierraDateTimeUtc(record, 160)
      || lastAutoTrade?.tradeDateUtc
      || tradeDateUtc;

    events.push({
      sequence: events.length + 1,
      eventType: "fill",
      sourceFile: file.absPath,
      tradeDateUtc: recordTimeUtc,
      account: recordAccount,
      symbol,
      chartbook,
      price,
      side,
      quantity,
      positionAfter,
      previousPosition,
      internalOrderId: tradeRecordString(record, 124) || null,
      status: positionAfter === 0 ? "Simulated position flattened / reduced" : "Simulated strategy fill",
      ...lastClassification,
    });
  }

  state.context = context;
  state.lastClassification = lastClassification;
  state.lastAutoTrade = lastAutoTrade;
  state.lastChartbook = lastChartbook;
  return events;
}

function importLiveSqliteTrades() {
  const parseErrors = [];
  let sqlite = {
    ok: false,
    sourceFile: PATRADING_LIVE_SQLITE_FILE,
    counts: {},
    trades: [],
    fills: [],
    orders: [],
    accountSnapshots: [],
    health: [],
  };

  if (fs.existsSync(PATRADING_LIVE_SQLITE_FILE)) {
    const script = String.raw`
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

db_path = Path(sys.argv[1])
uri = "file:" + quote(str(db_path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro&cache=private"
conn = sqlite3.connect(uri, uri=True, timeout=0.25)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA query_only=ON")
conn.execute("PRAGMA busy_timeout=250")

def table_exists(name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

counts = {}
for table in ["trades", "trade_legs", "fills", "account_snapshot", "logger_health", "orders", "order_events"]:
    counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) if table_exists(table) else None

trade_rows = rows("""
    SELECT trade_id, instance_id, instance_name, instance_role, environment,
           trade_account, account_type_guess, is_simulated, symbol, trade_symbol,
           instrument, contract, chart_symbol, tick_size, tick_value, currency,
           strategy_name, attribution_confidence, direction, status, entry_datetime,
           exit_datetime, initial_quantity, max_quantity, final_quantity,
           average_entry_price, average_exit_price, initial_stop_price, final_stop_price,
           initial_target_price, final_target_price, exit_classification,
           gross_points, gross_ticks, gross_currency_value, net_profit_loss,
           total_commission, profit_loss, opening_order_id, closing_order_id,
           parent_order_id, text_tag, order_action_source, created_utc, updated_utc
    FROM trades
    WHERE LOWER(COALESCE(environment, '')) = 'live'
      AND COALESCE(is_simulated, 0) = 0
      AND LOWER(COALESCE(account_type_guess, '')) NOT IN ('simulation', 'paper simulation')
    ORDER BY CAST(COALESCE(exit_datetime, entry_datetime, 0) AS REAL) ASC, trade_id ASC
""") if table_exists("trades") else []

fill_rows = rows("""
    SELECT fill_id, trade_account, account_type_guess, symbol, internal_order_id,
           parent_internal_order_id, side, quantity, fill_price, fill_datetime,
           position_after, text_tag, order_action_source, is_simulated, created_utc
    FROM fills
    WHERE COALESCE(is_simulated, 0) = 0
      AND LOWER(COALESCE(account_type_guess, '')) NOT IN ('simulation', 'paper simulation')
    ORDER BY fill_datetime ASC, fill_id ASC
""") if table_exists("fills") else []

order_rows = rows("""
    SELECT internal_order_id, instance_id, instance_name, trade_account, symbol,
           parent_internal_order_id, side, order_type, order_status, order_quantity,
           filled_quantity, price1, avg_fill_price, last_fill_price, text_tag,
           order_action_source, stop_target_class, is_simulated, first_seen_utc, last_seen_utc
    FROM orders
    WHERE COALESCE(is_simulated, 0) = 0
    ORDER BY internal_order_id ASC
""") if table_exists("orders") else []

payload = {
    "ok": True,
    "sourceFile": str(db_path),
    "counts": counts,
    "trades": trade_rows,
    "fills": fill_rows,
    "orders": order_rows,
    "unpairedFills": rows("""
        SELECT f.fill_id, f.trade_account, f.account_type_guess, f.symbol, f.side,
               f.quantity, f.fill_price, f.fill_datetime, f.position_after,
               f.text_tag, f.order_action_source, f.is_simulated, f.created_utc,
               f.internal_order_id, f.parent_internal_order_id
        FROM fills f
        LEFT JOIN trade_legs l ON l.internal_order_id = f.internal_order_id
        WHERE l.leg_id IS NULL
          AND COALESCE(f.is_simulated, 0) = 0
          AND LOWER(COALESCE(f.account_type_guess, '')) NOT IN ('simulation', 'paper simulation')
        ORDER BY f.fill_datetime ASC, f.fill_id ASC
    """) if table_exists("fills") and table_exists("trade_legs") else [],
    "accountSnapshots": rows("""
        SELECT account_snapshot_id, instance_id, instance_name, instance_role, trade_account,
               account_type_guess, trade_service, is_simulated, cash_balance,
               available_funds, daily_profit_loss, daily_net_profit_loss,
               open_positions_profit_loss, margin_requirement, account_value,
               currency, account_data_available, monitor_source,
               daily_net_profit_loss_source, source_datetime, snapshot_utc,
               snapshot_reason, created_utc
        FROM account_snapshot
        WHERE COALESCE(is_simulated, 0) = 0
          AND LOWER(COALESCE(account_type_guess, '')) NOT IN ('simulation', 'paper simulation')
        ORDER BY account_snapshot_id DESC
        LIMIT 120
    """) if table_exists("account_snapshot") else [],
    "health": rows("""
        SELECT health_id, instance_id, instance_name, database_path, message, created_utc
        FROM logger_health
        ORDER BY health_id DESC
        LIMIT 10
    """) if table_exists("logger_health") else [],
}
conn.close()
print(json.dumps(payload))
`;
    try {
      sqlite = JSON.parse(execFileSync(PYTHON_EXECUTABLE, ["-c", script, PATRADING_LIVE_SQLITE_FILE], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }));
    } catch (error) {
      parseErrors.push({ file: PATRADING_LIVE_SQLITE_FILE, error: String(error?.message || error) });
    }
  } else {
    parseErrors.push({ file: PATRADING_LIVE_SQLITE_FILE, error: "PATrading live SQLite file does not exist." });
  }

  const toNumberOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const sierraSerialToUtcIso = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    const number = Number(text);
    if (!Number.isFinite(number)) return normalizeSqliteTimestamp(text);
    if (number <= 1) return null;
    const londonWallMs = Date.UTC(1899, 11, 30) + number * 24 * 60 * 60 * 1000;
    let utcMs = londonWallMs - londonOffsetMsForUtc(londonWallMs);
    utcMs = londonWallMs - londonOffsetMsForUtc(utcMs);
    return new Date(utcMs).toISOString();
  };
  const normalizeSqliteTimestamp = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    return text.includes("T") ? text : text.replace(" ", "T").replace(/$/, "Z");
  };
  const normalizeSqliteSide = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    if (/short|sell/i.test(text)) return String(text).toLowerCase() === "short" ? "Short" : "Sell";
    if (/long|buy/i.test(text)) return String(text).toLowerCase() === "long" ? "Long" : "Buy";
    return text;
  };
  const normalizeTradeDirection = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    if (/short/i.test(text)) return "Short";
    if (/long/i.test(text)) return "Long";
    return normalizeSqliteSide(text);
  };
  const hasValidSierraSerial = (value) => {
    const text = cleanText(value);
    if (!text) return false;
    const number = Number(text);
    if (Number.isFinite(number)) return number > 1;
    return Boolean(normalizeSqliteTimestamp(text));
  };
  const isFilledOrder = (order) => Number(order?.filled_quantity) > 0 || Number(order?.order_status) === 8;
  const isExitChildOrder = (order) => (
    Number(order?.parent_internal_order_id || 0) !== 0
    && /stop|target/i.test(cleanText(order?.stop_target_class) || "")
    && isFilledOrder(order)
  );
  const repairLiveOpenTradesFromExitEvidence = (rows, orders, fills) => {
    const childOrdersByParent = new Map();
    for (const order of orders || []) {
      if (!isExitChildOrder(order)) continue;
      const parentId = Number(order.parent_internal_order_id);
      const matches = childOrdersByParent.get(parentId) || [];
      matches.push(order);
      childOrdersByParent.set(parentId, matches);
    }
    const fillsByOrder = new Map();
    for (const fill of fills || []) {
      const orderId = Number(fill.internal_order_id);
      if (!Number.isFinite(orderId)) continue;
      const matches = fillsByOrder.get(orderId) || [];
      matches.push(fill);
      fillsByOrder.set(orderId, matches);
    }
    return (rows || []).map((row) => {
      if (/^closed$/i.test(String(row.status || "")) || hasValidSierraSerial(row.exit_datetime)) return row;
      const openingOrderId = Number(row.opening_order_id);
      if (!Number.isFinite(openingOrderId)) return row;
      const exitOrder = (childOrdersByParent.get(openingOrderId) || [])
        .slice()
        .sort((a, b) => String(a.last_seen_utc || a.first_seen_utc || "").localeCompare(String(b.last_seen_utc || b.first_seen_utc || "")))
        .at(-1);
      if (!exitOrder) return row;
      const exitFill = (fillsByOrder.get(Number(exitOrder.internal_order_id)) || [])
        .slice()
        .sort((a, b) => Number(a.fill_datetime || 0) - Number(b.fill_datetime || 0))
        .at(-1);
      const exitPrice = toNumberOrNull(exitFill?.fill_price) ?? toNumberOrNull(exitOrder.last_fill_price) ?? toNumberOrNull(exitOrder.avg_fill_price) ?? toNumberOrNull(exitOrder.price1);
      const entryPrice = toNumberOrNull(row.average_entry_price);
      const quantity = toNumberOrNull(exitFill?.quantity) ?? toNumberOrNull(exitOrder.filled_quantity) ?? toNumberOrNull(row.initial_quantity) ?? toNumberOrNull(row.max_quantity) ?? 0;
      const direction = normalizeTradeDirection(row.direction);
      const symbol = cleanText(row.chart_symbol) || cleanText(row.trade_symbol) || cleanText(row.symbol) || cleanText(row.contract) || cleanText(row.instrument) || "n/a";
      const grossPoints = Number.isFinite(entryPrice) && Number.isFinite(exitPrice)
        ? (/short/i.test(direction || "") ? entryPrice - exitPrice : exitPrice - entryPrice)
        : toNumberOrNull(row.gross_points);
      const grossCurrencyValue = Number.isFinite(grossPoints) && Number.isFinite(quantity)
        ? grossPoints * quantity * contractMultiplier(symbol)
        : (toNumberOrNull(row.net_profit_loss) ?? toNumberOrNull(row.profit_loss) ?? toNumberOrNull(row.gross_currency_value));
      return {
        ...row,
        status: "closed",
        exit_datetime: exitFill?.fill_datetime ?? exitOrder.last_seen_utc ?? exitOrder.first_seen_utc ?? row.updated_utc,
        final_quantity: 0,
        average_exit_price: exitPrice ?? row.average_exit_price,
        closing_order_id: exitOrder.internal_order_id,
        exit_classification: cleanText(exitOrder.stop_target_class) || row.exit_classification,
        gross_points: Number.isFinite(grossPoints) ? grossPoints : row.gross_points,
        gross_ticks: Number.isFinite(grossPoints) ? grossPoints / (toNumberOrNull(row.tick_size) || 0.25) : row.gross_ticks,
        gross_currency_value: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.gross_currency_value,
        net_profit_loss: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.net_profit_loss,
        profit_loss: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.profit_loss,
        text_tag: cleanText(row.text_tag) || cleanText(exitFill?.text_tag) || cleanText(exitOrder.text_tag),
        order_action_source: cleanText(exitFill?.order_action_source) || cleanText(exitOrder.order_action_source) || cleanText(row.order_action_source),
      };
    });
  };
  const isClosed = (row) => /^closed$/i.test(String(row.status || "")) || hasValidSierraSerial(row.exit_datetime);
  const liveTradeFromSqlite = (row) => {
    const closed = isClosed(row);
    const account = cleanText(row.trade_account) || "n/a";
    const classification = classifyLiveAccount(account);
    const symbol = cleanText(row.chart_symbol) || cleanText(row.trade_symbol) || cleanText(row.symbol) || cleanText(row.instrument) || "n/a";
    const strategyName = cleanText(row.strategy_name) || (cleanText(row.attribution_confidence) === "disabled" ? "Manual Trade" : "Unattributed Live Trade");
    const exitAtUtc = sierraSerialToUtcIso(row.exit_datetime);
    const entryAtUtc = sierraSerialToUtcIso(row.entry_datetime);
    const tradeDateUtc = exitAtUtc || entryAtUtc || normalizeSqliteTimestamp(row.updated_utc || row.created_utc);
    const realized = closed ? (toNumberOrNull(row.net_profit_loss) ?? toNumberOrNull(row.profit_loss) ?? toNumberOrNull(row.gross_currency_value) ?? 0) : null;
    const grossPoints = toNumberOrNull(row.gross_points);
    const grossCurrencyValue = toNumberOrNull(row.gross_currency_value);
    const totalCommission = toNumberOrNull(row.total_commission);
    const pointValue = contractMultiplier(symbol);
    const derivedQuantity = Number.isFinite(Number(realized))
      && Number.isFinite(Number(grossPoints))
      && Number(grossPoints) !== 0
      && Number.isFinite(Number(pointValue))
      && Number(pointValue) !== 0
        ? Math.abs(Number(realized) / (Number(grossPoints) * Number(pointValue)))
        : null;
    return {
      tradeId: `patrading-live-sqlite-${row.trade_id}`,
      sourceId: `patrading-live-sqlite-${row.trade_id}`,
      sourceSystem: "patrading_sqlite",
      sourceDetail: "PATrading live SQLite trades table read-only",
      sourceFile: PATRADING_LIVE_SQLITE_FILE,
      mode: "live",
      account,
      accountType: classification.accountType,
      accountFamily: classification.accountFamily,
      profitTreatment: classification.profitTreatment,
      tradeAccount: account,
      symbol,
      instrument: cleanText(row.instrument) || symbol,
      contract: cleanText(row.contract),
      strategyName,
      strategyStudy: strategyName,
      tradeSource: cleanText(row.strategy_name) ? "strategy" : "manual",
      approvalStatus: "live",
      dashboardBucket: "patrading_live_sqlite",
      side: normalizeTradeDirection(row.direction),
      quantity: derivedQuantity !== null ? Number(derivedQuantity.toFixed(4)) : (toNumberOrNull(row.initial_quantity) ?? toNumberOrNull(row.max_quantity) ?? toNumberOrNull(row.final_quantity) ?? 0),
      entryPrice: toNumberOrNull(row.average_entry_price),
      exitPrice: toNumberOrNull(row.average_exit_price),
      initialStopPrice: toNumberOrNull(row.initial_stop_price),
      finalStopPrice: toNumberOrNull(row.final_stop_price),
      targetPrice: toNumberOrNull(row.final_target_price) ?? toNumberOrNull(row.initial_target_price),
      entryAtUtc,
      exitAtUtc,
      tradeDateUtc,
      timestampUtc: tradeDateUtc,
      status: closed ? "Closed / reduced" : cleanText(row.status) || "Open",
      realizedPnlDollars: realized,
      grossPnlDollars: grossCurrencyValue,
      commissionDollars: totalCommission,
      grossPoints,
      points: grossPoints,
      grossTicks: toNumberOrNull(row.gross_ticks),
      grossCurrencyValue,
      totalCommission,
      entryPriceRaw: row.average_entry_price,
      exitPriceRaw: row.average_exit_price,
      openingOrderId: row.opening_order_id,
      closingOrderId: row.closing_order_id,
      internalOrderId: row.closing_order_id || row.opening_order_id || row.trade_id,
      textTag: cleanText(row.text_tag),
      orderActionSource: cleanText(row.order_action_source),
      attributionConfidence: cleanText(row.attribution_confidence),
      createdAtUtc: normalizeSqliteTimestamp(row.created_utc),
      updatedAtUtc: normalizeSqliteTimestamp(row.updated_utc),
    };
  };
  const liveFillFromSqlite = (row) => {
    const account = cleanText(row.trade_account) || "n/a";
    const classification = classifyLiveAccount(account);
    const timestamp = sierraSerialToUtcIso(row.fill_datetime);
    return {
      eventType: "fill",
      mode: "live",
      account,
      accountType: classification.accountType,
      accountFamily: classification.accountFamily,
      profitTreatment: classification.profitTreatment,
      symbol: cleanText(row.symbol) || "n/a",
      side: normalizeSqliteSide(row.side),
      quantity: toNumberOrNull(row.quantity) ?? 0,
      price: toNumberOrNull(row.fill_price),
      fillPrice: toNumberOrNull(row.fill_price),
      positionAfter: toNumberOrNull(row.position_after),
      tradeDateUtc: timestamp,
      timestampUtc: timestamp,
      tradeSource: cleanText(row.text_tag) ? "strategy" : "manual",
      strategyName: cleanText(row.text_tag) || "Manual Trade",
      sourceFile: PATRADING_LIVE_SQLITE_FILE,
      sourceSystem: "patrading_sqlite",
      sourceDetail: "PATrading live SQLite fills table read-only",
      orderActionSource: cleanText(row.order_action_source),
      isSimulated: Number(row.is_simulated) === 1,
    };
  };

  const allTradeRows = repairLiveOpenTradesFromExitEvidence(
    Array.isArray(sqlite.trades) ? sqlite.trades : [],
    Array.isArray(sqlite.orders) ? sqlite.orders : [],
    Array.isArray(sqlite.fills) ? sqlite.fills : [],
  );
  const allTradeRecords = allTradeRows.map(liveTradeFromSqlite);
  const fillEvents = (Array.isArray(sqlite.fills) ? sqlite.fills : []).map(liveFillFromSqlite);
  const unpairedFills = (Array.isArray(sqlite.unpairedFills) ? sqlite.unpairedFills : []).map(liveFillFromSqlite);
  const accountSnapshots = (Array.isArray(sqlite.accountSnapshots) ? sqlite.accountSnapshots : []).map((row) => ({
    accountSnapshotId: Number(row.account_snapshot_id),
    account: cleanText(row.trade_account) || "n/a",
    accountType: classifyLiveAccount(cleanText(row.trade_account)).accountType,
    cashBalanceDollars: toNumberOrNull(row.cash_balance),
    availableFundsDollars: toNumberOrNull(row.available_funds),
    dailyProfitLossDollars: toNumberOrNull(row.daily_profit_loss),
    dailyNetProfitLossDollars: toNumberOrNull(row.daily_net_profit_loss),
    openPositionsProfitLossDollars: toNumberOrNull(row.open_positions_profit_loss),
    marginRequirementDollars: toNumberOrNull(row.margin_requirement),
    accountValueDollars: toNumberOrNull(row.account_value),
    currencyCode: cleanText(row.currency) || null,
    accountDataAvailable: Number(row.account_data_available) === 1,
    monitorSource: cleanText(row.monitor_source) || "sc.GetTradeAccountData",
    snapshotReason: cleanText(row.snapshot_reason) || null,
    snapshotAtUtc: normalizeSqliteTimestamp(row.snapshot_utc || row.created_utc),
    sourceFile: PATRADING_LIVE_SQLITE_FILE,
    sourceSystem: "patrading_live_sqlite_account_snapshot",
  }));
  const closedTrades = allTradeRecords.filter((trade) => Number.isFinite(Number(trade.realizedPnlDollars)));
  const rawOpenPositions = allTradeRecords
    .filter((trade) => !Number.isFinite(Number(trade.realizedPnlDollars)))
    .map((trade) => ({
      ...trade,
      averagePrice: trade.entryPrice,
      openQuantity: trade.quantity,
      direction: trade.side,
      openedAtUtc: trade.entryAtUtc,
    }));
  const { openPositions, dtcSnapshot } = mergeDtcSnapshotPositions(rawOpenPositions, "live");
  const manualFills = fillEvents.filter((event) => event.tradeSource === "manual");
  const strategyFills = fillEvents.filter((event) => event.tradeSource === "strategy");
  const accounts = [...new Set(allTradeRecords.map((event) => event.account).filter(Boolean))].sort();
  const symbols = [...new Set(allTradeRecords.map((event) => event.symbol).filter(Boolean))].sort();
  const tradeDatesUtc = [...new Set(closedTrades.map((event) => cleanText(event.tradeDateUtc)?.slice(0, 10)).filter(Boolean))].sort();
  const sourceFiles = fs.existsSync(PATRADING_LIVE_SQLITE_FILE) ? [PATRADING_LIVE_SQLITE_FILE] : [];
  const accountMonitor = readLiveTradeAccountMonitor();
  const profitReconciliation = buildAccountProfitReconciliation(closedTrades, accountMonitor);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const latestHealthUtc = (sqlite.health || []).map((row) => normalizeSqliteTimestamp(row.created_utc)).filter(Boolean).sort().at(-1) || null;
  const latestFillUtc = fillEvents.map((event) => event.timestampUtc).filter(Boolean).sort().at(-1) || null;
  const latestClosedTradeUtc = closedTrades.map((trade) => trade.exitAtUtc || trade.tradeDateUtc).filter(Boolean).sort().at(-1) || null;
  const latestAccountSnapshotUtc = (accountMonitor?.rows || []).map((row) => row.updatedAtUtc).filter(Boolean).sort().at(-1) || null;
  const liveDailyPnlRows = (accountMonitor?.rows || [])
    .map((row) => Number(row.dailyProfitLossDollars ?? row.dailyNetProfitLossDollars))
    .filter((value) => Number.isFinite(value) && Math.abs(value) >= 0.005);
  const hasTodayTradeRows = closedTrades.some((trade) => String(trade.exitAtUtc || trade.tradeDateUtc || "").startsWith(todayUtc))
    || fillEvents.some((event) => String(event.timestampUtc || "").startsWith(todayUtc));
  const sourceHealthWarning = !hasTodayTradeRows && liveDailyPnlRows.length
    ? "Live account P/L moved today, but telemetry SQLite has no today trades/fills. Load or repair SierraTradeTelemetryLogger in the Live chartbook."
    : null;
  const sourceHealth = {
    status: sourceHealthWarning ? "stale_or_not_capturing" : "ok",
    warning: sourceHealthWarning,
    todayUtc,
    latestHealthUtc,
    latestFillUtc,
    latestClosedTradeUtc,
    latestAccountSnapshotUtc,
    dailyPnlDollars: liveDailyPnlRows.length ? Number(liveDailyPnlRows.reduce((sum, value) => sum + value, 0).toFixed(2)) : null,
    sqliteFile: PATRADING_LIVE_SQLITE_FILE,
  };
  const ledger = {
    generatedAtUtc: new Date().toISOString(),
    sourceRoot: path.dirname(PATRADING_LIVE_SQLITE_FILE),
    liveSqliteFile: PATRADING_LIVE_SQLITE_FILE,
    sourceFiles,
    parserNote: "Extracted from PATrading live SQLite trades/fills tables only. Opened read-only with query_only enabled.",
    summary: {
      filesScanned: sourceFiles.length,
      sqliteOk: Boolean(sqlite.ok),
      sqliteCounts: sqlite.counts || {},
      eventsImported: fillEvents.length,
      fillsImported: fillEvents.length,
      manualFills: manualFills.length,
      strategyFills: strategyFills.length,
      closedTrades: closedTrades.length,
      openPositions: openPositions.length,
      logOpenPositions: rawOpenPositions.length,
      dtcSnapshot,
      accountCount: accounts.length,
      symbolCount: symbols.length,
      firstTradeDateUtc: tradeDatesUtc[0] || null,
      lastTradeDateUtc: tradeDatesUtc[tradeDatesUtc.length - 1] || null,
      accounts,
      symbols,
      parseErrors: parseErrors.length,
      sourceHealth,
      unpairedFills: unpairedFills.length,
      accountSnapshots,
      unpairedFillNote: unpairedFills.length
        ? "Unpaired live fills are present in SQLite but are excluded from P&L totals because no matching trade entry exists in the trades table."
        : null,
    },
    parseErrors,
    events: fillEvents,
    unpairedFills,
    closedTrades,
    openPositions,
    accountMonitor,
    accountSnapshots,
    profitReconciliation,
    dtcSnapshot,
    sourceHealth,
  };

  fs.mkdirSync(path.dirname(LIVE_TRADE_OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(LIVE_TRADE_OUTPUT_FILE, JSON.stringify(ledger, null, 2));

  return {
    sourceFiles,
    accounts,
    allTrades: fillEvents,
    recentTrades: fillEvents.slice(-250).reverse(),
    allClosedTrades: closedTrades,
    recentClosedTrades: closedTrades.slice(-250).reverse(),
    performanceClosedTrades: closedTrades,
    openPositions,
    fullLedgerFile: LIVE_TRADE_OUTPUT_FILE,
    summary: ledger.summary,
    accountMonitor,
    accountSnapshots,
    profitReconciliation,
    dtcSnapshot,
    sourceHealth,
  };
}

function buildPaperTradeReconciliation(fillEvents, closedTrades, openPositions, accountMonitor, dtcSnapshot) {
  const strategyRows = [...new Set(closedTrades.map((trade) => trade.strategyName || "Unknown strategy"))]
    .sort()
    .map((strategy) => {
      const trades = closedTrades.filter((trade) => (trade.strategyName || "Unknown strategy") === strategy);
      const wins = trades.filter((trade) => Number(trade.realizedPnlDollars) > 0).length;
      const losses = trades.filter((trade) => Number(trade.realizedPnlDollars) < 0).length;
      const net = trades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
      const points = trades.reduce((sum, trade) => sum + (Number(trade.points) || 0), 0);
      const first = trades.map((trade) => trade.entryAtUtc || trade.tradeDateUtc).filter(Boolean).sort()[0] || null;
      const last = trades.map((trade) => trade.exitAtUtc || trade.tradeDateUtc).filter(Boolean).sort().at(-1) || null;
      let recommendation = "Collect more paper trades before changing this strategy.";
      if (trades.length >= 5 && net < 0) recommendation = "Pause or reduce this strategy until parameters are reviewed; observed paper performance is negative.";
      if (trades.length >= 5 && net > 0 && wins / trades.length < 0.4) recommendation = "Positive but low win-rate; review execution quality and risk/reward before increasing size.";
      if (trades.length >= 5 && net > 0 && wins / trades.length >= 0.4) recommendation = "Keep under observation; observed paper performance is positive.";
      return {
        strategy,
        trades: trades.length,
        wins,
        losses,
        winRate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
        longTrades: trades.filter((trade) => trade.side === "Long").length,
        shortTrades: trades.filter((trade) => trade.side === "Short").length,
        netProfitDollars: Number(net.toFixed(2)),
        points: Number(points.toFixed(4)),
        firstTradeUtc: first,
        lastTradeUtc: last,
        recommendation,
      };
    });

  const timestamps = fillEvents.map((event) => event.tradeDateUtc).filter(Boolean).sort();
  const lastFillUtc = timestamps.at(-1) || null;
  const snapshotUtc = dtcSnapshot?.generatedAtUtc || new Date().toISOString();
  const sim1FilesAfterLastFill = listFiles(PAPER_TRADE_LOG_DIR, isPaperStrategyLog)
    .filter((file) => {
      const fileDate = parseLiveLogFileName(file.name).tradeDateUtc;
      return lastFillUtc && fileDate && fileDate > lastFillUtc.slice(0, 10);
    })
    .map((file) => file.absPath);
  const missedTrades = {
    windowStartUtc: lastFillUtc,
    windowEndUtc: snapshotUtc,
    detectedMissedTrades: 0,
    detectedMissedSignals: 0,
    confidence: "observed_logs_only",
    status: lastFillUtc
      ? "No additional paper SIM strategy fills were present in Sierra TradeActivityLogs after the last imported paper fill."
      : "No paper SIM strategy fills were available in the current clean-start window.",
    limitation:
      "Sierra TradeActivityLogs prove executed simulated fills, not hypothetical signals while the laptop or strategy was offline. To count true missed signals, the strategy must log every signal candidate with bar time, strategy name, entry/stop/targets, and blocked reason.",
    evidence: {
      lastImportedFillUtc: lastFillUtc,
      dtcSnapshotUtc: snapshotUtc,
      dtcPaperStatus: dtcSnapshot?.status || "not_run",
      dtcOpenPositions: openPositions.length,
      sim1LogFilesAfterLastFill: sim1FilesAfterLastFill,
      accountMonitorWarning: accountMonitor?.warning || null,
    },
  };
  const potentialStrategy = strategyRows.length
    ? strategyRows
        .slice()
        .sort((a, b) => (b.netProfitDollars - a.netProfitDollars) || (b.winRate || 0) - (a.winRate || 0))[0]
    : null;
  const result = {
    generatedAtUtc: new Date().toISOString(),
    paperValuePolicy:
      "Paper account value is only shown when Sierra TradeAccountData or DTC provides an actual Sim1 balance. Closed-fill P&L is reported separately and is not relabelled as account value.",
    accountValueAvailable: Boolean(accountMonitor?.rows?.length),
    missedTrades,
    strategyRows,
    potentialStrategy: potentialStrategy
      ? {
          strategy: potentialStrategy.strategy,
          basis: "Best observed net P&L in the current clean-start paper-trading fills.",
          netProfitDollars: potentialStrategy.netProfitDollars,
          winRate: potentialStrategy.winRate,
          trades: potentialStrategy.trades,
          recommendation: potentialStrategy.recommendation,
        }
      : null,
    reportFile: PAPER_RECONCILIATION_FILE,
  };

  writePaperTradeReconciliationReport(result);
  return result;
}

function writePaperTradeReconciliationReport(reconciliation) {
  const lines = [
    "# Paper Trade Reconciliation",
    "",
    `Generated: ${reconciliation.generatedAtUtc}`,
    "",
    "## Paper Value Policy",
    "",
    `- ${reconciliation.paperValuePolicy}`,
    `- Actual Sim1 account value available: ${reconciliation.accountValueAvailable ? "yes" : "no"}`,
    "",
    "## Overnight / Missed Trade Check",
    "",
    `- Window start UTC: ${reconciliation.missedTrades.windowStartUtc || "n/a"}`,
    `- Window end UTC: ${reconciliation.missedTrades.windowEndUtc || "n/a"}`,
    `- Detected missed trades from available Sierra logs: ${reconciliation.missedTrades.detectedMissedTrades}`,
    `- Detected missed signals from available Sierra logs: ${reconciliation.missedTrades.detectedMissedSignals}`,
    `- Status: ${reconciliation.missedTrades.status}`,
    `- Limitation: ${reconciliation.missedTrades.limitation}`,
    "",
    "## Strategy Result Rows",
    "",
    "| Strategy | Trades | Wins | Losses | Win rate | Net P&L | Points | Recommendation |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...(reconciliation.strategyRows.length
      ? reconciliation.strategyRows.map((row) =>
          `| ${row.strategy} | ${row.trades} | ${row.wins} | ${row.losses} | ${row.winRate === null ? "n/a" : `${(row.winRate * 100).toFixed(1)}%`} | $${row.netProfitDollars.toFixed(2)} | ${row.points.toFixed(2)} | ${row.recommendation} |`,
        )
      : ["| No paper strategy fills | 0 | 0 | 0 | n/a | $0.00 | 0.00 | No paper fills are available. |"]),
    "",
    "## Potential Strategy Based On Current Paper Results",
    "",
    reconciliation.potentialStrategy
      ? `- ${reconciliation.potentialStrategy.strategy}: ${reconciliation.potentialStrategy.recommendation}`
      : "- No potential strategy can be selected because no paper fills are available.",
    "",
  ];
  fs.mkdirSync(path.dirname(PAPER_RECONCILIATION_FILE), { recursive: true });
  fs.writeFileSync(PAPER_RECONCILIATION_FILE, lines.join("\n"));
}

function importPaperSqliteTrades() {
  const outputFile = path.join(ROOT, "dashboard", "data", "paper-trades.json");
  const parseErrors = [];
  let sqlite = {
    ok: false,
    sourceFile: PATRADING_PAPER_SQLITE_FILE,
    counts: {},
    trades: [],
    runtimeEvents: [],
  };

  if (fs.existsSync(PATRADING_PAPER_SQLITE_FILE)) {
    const script = String.raw`
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

db_path = Path(sys.argv[1])
uri = "file:" + quote(str(db_path.resolve()).replace("\\", "/"), safe="/:") + "?mode=ro&cache=private"
conn = sqlite3.connect(uri, uri=True, timeout=0.25)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA query_only=ON")
conn.execute("PRAGMA busy_timeout=250")

def table_exists(name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

counts = {}
for table in ["trades", "trade_legs", "fills", "account_snapshot", "logger_health", "orders", "order_events"]:
    counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]) if table_exists(table) else None

payload = {
    "ok": True,
    "sourceFile": str(db_path),
    "counts": counts,
    "trades": rows("""
        SELECT trade_id, instance_id, instance_name, instance_role, environment,
               trade_account, account_type_guess, is_simulated, symbol, trade_symbol,
               instrument, contract, chart_symbol, tick_size, tick_value, currency,
               strategy_name, attribution_confidence, direction, status, entry_datetime,
               exit_datetime, initial_quantity, max_quantity, final_quantity,
               average_entry_price, average_exit_price, initial_stop_price, final_stop_price,
               initial_target_price, final_target_price, exit_classification,
               gross_points, gross_ticks, gross_currency_value, net_profit_loss,
               total_commission, profit_loss, opening_order_id, closing_order_id,
               parent_order_id, text_tag, order_action_source, created_utc, updated_utc
        FROM trades
        ORDER BY CAST(COALESCE(exit_datetime, entry_datetime, 0) AS REAL) ASC, trade_id ASC
    """) if table_exists("trades") else [],
    "fills": rows("""
        SELECT fill_id, trade_account, account_type_guess, symbol, internal_order_id,
               parent_internal_order_id, side, quantity, fill_price, fill_datetime,
               position_after, text_tag, order_action_source, is_simulated, created_utc
        FROM fills
        ORDER BY fill_datetime ASC, fill_id ASC
    """) if table_exists("fills") else [],
    "orders": rows("""
        SELECT internal_order_id, instance_id, instance_name, trade_account, symbol,
               parent_internal_order_id, side, order_type, order_status, order_quantity,
               filled_quantity, price1, avg_fill_price, last_fill_price, text_tag,
               order_action_source, stop_target_class, is_simulated, first_seen_utc, last_seen_utc
        FROM orders
        ORDER BY internal_order_id ASC
    """) if table_exists("orders") else [],
    "accountSnapshots": rows("""
        SELECT account_snapshot_id, instance_id, instance_name, instance_role, trade_account,
               account_type_guess, trade_service, is_simulated, cash_balance,
               available_funds, daily_profit_loss, daily_net_profit_loss,
               open_positions_profit_loss, margin_requirement, account_value,
               currency, account_data_available, monitor_source,
               daily_net_profit_loss_source, source_datetime, snapshot_utc, created_utc
        FROM account_snapshot
        ORDER BY account_snapshot_id DESC
        LIMIT 10
    """) if table_exists("account_snapshot") else [],
    "health": rows("""
        SELECT health_id, instance_id, instance_name, database_path, message, created_utc
        FROM logger_health
        ORDER BY health_id DESC
        LIMIT 10
    """) if table_exists("logger_health") else [],
}
conn.close()
print(json.dumps(payload))
`;
    try {
      sqlite = JSON.parse(execFileSync(PYTHON_EXECUTABLE, ["-c", script, PATRADING_PAPER_SQLITE_FILE], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }));
    } catch (error) {
      parseErrors.push({ file: PATRADING_PAPER_SQLITE_FILE, error: String(error?.message || error) });
    }
  } else {
    parseErrors.push({ file: PATRADING_PAPER_SQLITE_FILE, error: "PATrading paper telemetry SQLite file does not exist." });
  }

  const normalizeSqliteTimestamp = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    return text.includes("T") ? text : text.replace(" ", "T").replace(/$/, "Z");
  };
  const sierraSerialToUtcIso = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    const number = Number(text);
    if (!Number.isFinite(number)) return normalizeSqliteTimestamp(text);
    if (number <= 1) return null;
    const londonWallMs = Date.UTC(1899, 11, 30) + number * 24 * 60 * 60 * 1000;
    let utcMs = londonWallMs - londonOffsetMsForUtc(londonWallMs);
    utcMs = londonWallMs - londonOffsetMsForUtc(utcMs);
    return new Date(utcMs).toISOString();
  };
  const normalizeSqliteSide = (value) => {
    const text = cleanText(value);
    if (!text) return null;
    if (/short/i.test(text)) return "Short";
    if (/long|buy/i.test(text)) return "Long";
    return text;
  };
  const toNumberOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const finiteAccountNumberOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) < 1e100 ? number : null;
  };
  const hasValidSierraSerial = (value) => {
    const text = cleanText(value);
    if (!text) return false;
    const number = Number(text);
    if (Number.isFinite(number)) return number > 1;
    return Boolean(normalizeSqliteTimestamp(text));
  };
  const isFilledOrder = (order) => Number(order?.filled_quantity) > 0 || Number(order?.order_status) === 8;
  const isExitChildOrder = (order) => (
    Number(order?.parent_internal_order_id || 0) !== 0
    && /stop|target/i.test(cleanText(order?.stop_target_class) || "")
    && isFilledOrder(order)
  );
  const repairPaperOpenTradesFromExitEvidence = (rows, orders, fills) => {
    const childOrdersByParent = new Map();
    for (const order of orders || []) {
      if (!isExitChildOrder(order)) continue;
      const parentId = Number(order.parent_internal_order_id);
      const matches = childOrdersByParent.get(parentId) || [];
      matches.push(order);
      childOrdersByParent.set(parentId, matches);
    }
    const fillsByOrder = new Map();
    for (const fill of fills || []) {
      const orderId = Number(fill.internal_order_id);
      if (!Number.isFinite(orderId)) continue;
      const matches = fillsByOrder.get(orderId) || [];
      matches.push(fill);
      fillsByOrder.set(orderId, matches);
    }
    return (rows || []).map((row) => {
      if (/^closed$/i.test(String(row.status || "")) || hasValidSierraSerial(row.exit_datetime)) return row;
      const openingOrderId = Number(row.opening_order_id);
      if (!Number.isFinite(openingOrderId)) return row;
      const exitOrder = (childOrdersByParent.get(openingOrderId) || [])
        .slice()
        .sort((a, b) => String(a.last_seen_utc || a.first_seen_utc || "").localeCompare(String(b.last_seen_utc || b.first_seen_utc || "")))
        .at(-1);
      if (!exitOrder) return row;
      const exitFill = (fillsByOrder.get(Number(exitOrder.internal_order_id)) || [])
        .slice()
        .sort((a, b) => Number(a.fill_datetime || 0) - Number(b.fill_datetime || 0))
        .at(-1);
      const exitPrice = toNumberOrNull(exitFill?.fill_price) ?? toNumberOrNull(exitOrder.last_fill_price) ?? toNumberOrNull(exitOrder.avg_fill_price) ?? toNumberOrNull(exitOrder.price1);
      const entryPrice = toNumberOrNull(row.average_entry_price);
      const quantity = toNumberOrNull(exitFill?.quantity) ?? toNumberOrNull(exitOrder.filled_quantity) ?? toNumberOrNull(row.initial_quantity) ?? toNumberOrNull(row.max_quantity) ?? 0;
      const direction = normalizeSqliteSide(row.direction);
      const symbol = cleanText(row.chart_symbol) || cleanText(row.trade_symbol) || cleanText(row.symbol) || cleanText(row.contract) || cleanText(row.instrument) || "n/a";
      const grossPoints = Number.isFinite(entryPrice) && Number.isFinite(exitPrice)
        ? (/short/i.test(direction || "") ? entryPrice - exitPrice : exitPrice - entryPrice)
        : toNumberOrNull(row.gross_points);
      const grossCurrencyValue = Number.isFinite(grossPoints) && Number.isFinite(quantity)
        ? grossPoints * quantity * contractMultiplier(symbol)
        : (toNumberOrNull(row.net_profit_loss) ?? toNumberOrNull(row.profit_loss) ?? toNumberOrNull(row.gross_currency_value));
      return {
        ...row,
        status: "closed",
        exit_datetime: exitFill?.fill_datetime ?? exitOrder.last_seen_utc ?? exitOrder.first_seen_utc ?? row.updated_utc,
        final_quantity: 0,
        average_exit_price: exitPrice ?? row.average_exit_price,
        closing_order_id: exitOrder.internal_order_id,
        exit_classification: cleanText(exitOrder.stop_target_class) || row.exit_classification,
        gross_points: Number.isFinite(grossPoints) ? grossPoints : row.gross_points,
        gross_ticks: Number.isFinite(grossPoints) ? grossPoints / (toNumberOrNull(row.tick_size) || 0.25) : row.gross_ticks,
        gross_currency_value: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.gross_currency_value,
        net_profit_loss: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.net_profit_loss,
        profit_loss: Number.isFinite(grossCurrencyValue) ? grossCurrencyValue : row.profit_loss,
        text_tag: cleanText(row.text_tag) || cleanText(exitFill?.text_tag) || cleanText(exitOrder.text_tag),
        order_action_source: cleanText(exitFill?.order_action_source) || cleanText(exitOrder.order_action_source) || cleanText(row.order_action_source),
      };
    });
  };
  const isClosed = (row) => /^closed$/i.test(String(row.status || "")) || hasValidSierraSerial(row.exit_datetime);
  const paperTradeFromSqlite = (row) => {
    const closed = isClosed(row);
    const account = cleanText(row.trade_account) || "Sim1";
    const symbol = cleanText(row.chart_symbol) || cleanText(row.trade_symbol) || cleanText(row.symbol) || cleanText(row.contract) || cleanText(row.instrument) || "n/a";
    const strategyName = cleanText(row.strategy_name) || (cleanText(row.attribution_confidence) === "disabled" ? "Manual Trade" : "PATrading");
    const exitAtUtc = sierraSerialToUtcIso(row.exit_datetime);
    const entryAtUtc = sierraSerialToUtcIso(row.entry_datetime);
    const tradeDateUtc = exitAtUtc || entryAtUtc || normalizeSqliteTimestamp(row.updated_utc || row.created_utc);
    const realized = closed ? (toNumberOrNull(row.net_profit_loss) ?? toNumberOrNull(row.profit_loss) ?? toNumberOrNull(row.gross_currency_value) ?? 0) : null;
    const grossPoints = toNumberOrNull(row.gross_points);
    const pointValue = contractMultiplier(symbol);
    const derivedQuantity = Number.isFinite(Number(realized))
      && Number.isFinite(Number(grossPoints))
      && Number(grossPoints) !== 0
      && Number.isFinite(Number(pointValue))
      && Number(pointValue) !== 0
        ? Math.abs(Number(realized) / (Number(grossPoints) * Number(pointValue)))
        : null;
    return {
      tradeId: `patrading-paper-sqlite-${row.trade_id}`,
      sourceId: `patrading-paper-sqlite-${row.trade_id}`,
      sourceSystem: "patrading_sqlite",
      sourceDetail: "PATrading paper telemetry SQLite trades table read-only",
      sourceFile: PATRADING_PAPER_SQLITE_FILE,
      mode: "paper",
      account,
      accountType: "Paper Simulation",
      tradeAccount: account,
      symbol,
      instrument: cleanText(row.instrument) || symbol,
      contract: cleanText(row.contract),
      strategyName,
      strategyStudy: strategyName,
      tradeSource: cleanText(row.strategy_name) ? "strategy" : "manual",
      approvalStatus: "paper",
      dashboardBucket: "patrading_paper_telemetry_sqlite",
      side: normalizeSqliteSide(row.direction),
      quantity: derivedQuantity !== null ? Number(derivedQuantity.toFixed(4)) : (toNumberOrNull(row.initial_quantity) ?? toNumberOrNull(row.max_quantity) ?? toNumberOrNull(row.final_quantity) ?? 0),
      entryPrice: toNumberOrNull(row.average_entry_price),
      exitPrice: toNumberOrNull(row.average_exit_price),
      initialStopPrice: toNumberOrNull(row.initial_stop_price),
      finalStopPrice: toNumberOrNull(row.final_stop_price),
      targetPrice: toNumberOrNull(row.final_target_price) ?? toNumberOrNull(row.initial_target_price),
      entryAtUtc,
      exitAtUtc,
      tradeDateUtc,
      timestampUtc: tradeDateUtc,
      status: closed ? "Closed / reduced" : cleanText(row.status) || "Open",
      realizedPnlDollars: realized,
      grossPoints,
      points: grossPoints,
      grossTicks: toNumberOrNull(row.gross_ticks),
      grossCurrencyValue: toNumberOrNull(row.gross_currency_value),
      totalCommission: toNumberOrNull(row.total_commission),
      maxFavourableExcursion: toNumberOrNull(row.max_favourable_excursion),
      maxAdverseExcursion: toNumberOrNull(row.max_adverse_excursion),
      openingOrderId: row.opening_order_id,
      closingOrderId: row.closing_order_id,
      internalOrderId: row.closing_order_id || row.opening_order_id || row.trade_id,
      textTag: cleanText(row.text_tag),
      orderActionSource: cleanText(row.order_action_source),
      attributionConfidence: cleanText(row.attribution_confidence),
      createdAtUtc: normalizeSqliteTimestamp(row.created_utc),
      updatedAtUtc: normalizeSqliteTimestamp(row.updated_utc),
    };
  };
  const paperTradesFromOrderPairs = (orders) => {
    const parents = new Map();
    const exitsByParent = new Map();
    for (const order of orders || []) {
      const filled = Number(order.filled_quantity) > 0 || Number(order.order_status) === 8;
      if (!filled) continue;
      const parentId = Number(order.parent_internal_order_id) || 0;
      if (parentId === 0 && /parent|standalone/i.test(cleanText(order.stop_target_class) || "")) {
        parents.set(Number(order.internal_order_id), order);
      } else if (parentId !== 0 && /stop|target/i.test(cleanText(order.stop_target_class) || "")) {
        const rows = exitsByParent.get(parentId) || [];
        rows.push(order);
        exitsByParent.set(parentId, rows);
      }
    }
    const seen = new Set();
    const derived = [];
    for (const [parentId, parent] of parents.entries()) {
      const exit = (exitsByParent.get(parentId) || [])
        .slice()
        .sort((a, b) => String(a.last_seen_utc || "").localeCompare(String(b.last_seen_utc || "")))
        .at(-1);
      if (!exit) continue;
      const account = cleanText(parent.trade_account) || cleanText(exit.trade_account) || "Sim1";
      const symbol = cleanText(parent.symbol) || cleanText(exit.symbol) || "n/a";
      const entryPrice = toNumberOrNull(parent.avg_fill_price) ?? toNumberOrNull(parent.last_fill_price) ?? toNumberOrNull(parent.price1);
      const exitPrice = toNumberOrNull(exit.last_fill_price) ?? toNumberOrNull(exit.avg_fill_price) ?? toNumberOrNull(exit.price1);
      const quantity = toNumberOrNull(parent.filled_quantity) ?? toNumberOrNull(parent.order_quantity) ?? 0;
      const direction = /sell/i.test(cleanText(parent.side)) ? "Short" : "Long";
      if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || !quantity) continue;
      const dedupeKey = [
        cleanText(parent.text_tag) || cleanText(exit.text_tag) || "untagged",
        account,
        symbol,
        direction,
        quantity,
        entryPrice.toFixed(8),
        exitPrice.toFixed(8),
      ].join("|");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const grossPoints = direction === "Short" ? entryPrice - exitPrice : exitPrice - entryPrice;
      const realizedPnlDollars = Number((grossPoints * quantity * contractMultiplier(symbol)).toFixed(2));
      const tagText = cleanText(parent.text_tag || exit.text_tag);
      const chartTime = cleanText(tagText?.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/)?.[1]);
      const chartTimeUtc = normalizeSqliteTimestamp(chartTime);
      const closedAtUtc = chartTimeUtc || normalizeSqliteTimestamp(exit.last_seen_utc || exit.first_seen_utc || parent.last_seen_utc);
      const openedAtUtc = chartTimeUtc || normalizeSqliteTimestamp(parent.first_seen_utc || parent.last_seen_utc);
      const strategyName = tagText?.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "") || "PATrading";
      derived.push({
        trade_id: `order-${parentId}`,
        trade_account: account,
        symbol,
        instrument: symbol,
        chart_symbol: symbol,
        strategy_name: strategyName,
        direction,
        status: "closed",
        initial_quantity: quantity,
        average_entry_price: entryPrice,
        average_exit_price: exitPrice,
        entry_datetime: openedAtUtc,
        exit_datetime: closedAtUtc,
        gross_points: grossPoints,
        gross_ticks: grossPoints / 0.25,
        gross_currency_value: realizedPnlDollars,
        net_profit_loss: realizedPnlDollars,
        profit_loss: realizedPnlDollars,
        opening_order_id: parent.internal_order_id,
        closing_order_id: exit.internal_order_id,
        text_tag: tagText,
        order_action_source: cleanText(exit.order_action_source),
        created_utc: openedAtUtc,
        updated_utc: closedAtUtc,
      });
    }
    return derived;
  };

  const allTradeRows = repairPaperOpenTradesFromExitEvidence(
    Array.isArray(sqlite.trades) ? sqlite.trades : [],
    Array.isArray(sqlite.orders) ? sqlite.orders : [],
    Array.isArray(sqlite.fills) ? sqlite.fills : [],
  );
  const orderDerivedRows = allTradeRows.length ? [] : paperTradesFromOrderPairs(sqlite.orders || []);
  const allTradeRecords = (allTradeRows.length ? allTradeRows : orderDerivedRows).map(paperTradeFromSqlite);
  const closedTrades = allTradeRecords.filter((trade) => Number.isFinite(Number(trade.realizedPnlDollars)));
  const performanceClosedTrades = closedTrades;
  const strategyClosedTrades = closedTrades.filter((trade) => trade.tradeSource === "strategy");
  const openPositions = allTradeRecords
    .filter((trade) => !Number.isFinite(Number(trade.realizedPnlDollars)))
    .map((trade) => ({
      ...trade,
      averagePrice: trade.entryPrice,
      openQuantity: trade.quantity,
      direction: trade.side,
      openedAtUtc: trade.entryAtUtc,
    }));
  const accounts = [...new Set(allTradeRecords.map((event) => event.account).filter(Boolean))].sort();
  const symbols = [...new Set(allTradeRecords.map((event) => event.symbol).filter(Boolean))].sort();
  const tradeDatesUtc = [...new Set(closedTrades.map((event) => cleanText(event.tradeDateUtc)?.slice(0, 10)).filter(Boolean))].sort();
  const sourceFiles = fs.existsSync(PATRADING_PAPER_SQLITE_FILE) ? [PATRADING_PAPER_SQLITE_FILE] : [];
  const dtcSnapshot = null;
  const accountSnapshotRows = Array.isArray(sqlite.accountSnapshots) ? sqlite.accountSnapshots : [];
  const accountMonitorRows = accountSnapshotRows.map((row) => {
    const account = cleanText(row.trade_account) || "Sim1";
    const updatedAtUtc = normalizeSqliteTimestamp(row.snapshot_utc || row.created_utc);
    return {
      account,
      currencyCode: cleanText(row.currency) || null,
      currentCashBalanceDollars: finiteAccountNumberOrNull(row.cash_balance),
      availableFundsForNewPositionsDollars: finiteAccountNumberOrNull(row.available_funds),
      marginRequirementDollars: finiteAccountNumberOrNull(row.margin_requirement),
      accountValueDollars: finiteAccountNumberOrNull(row.account_value),
      openPositionsProfitLossDollars: finiteAccountNumberOrNull(row.open_positions_profit_loss),
      dailyProfitLossDollars: finiteAccountNumberOrNull(row.daily_profit_loss),
      dailyNetProfitLossDollars: finiteAccountNumberOrNull(row.daily_net_profit_loss),
      sourceFile: PATRADING_PAPER_SQLITE_FILE,
      sourceSystem: cleanText(row.monitor_source) || "paper_telemetry_sqlite_account_snapshot",
      dailyNetProfitLossSource: cleanText(row.daily_net_profit_loss_source),
      updatedAtUtc,
      accountDataAvailable: Number(row.account_data_available) === 1,
      tradeService: cleanText(row.trade_service),
    };
  });
  const latestAccountMonitorByAccount = new Map();
  for (const row of accountMonitorRows) {
    const key = String(row.account || "").toLowerCase();
    if (!key || latestAccountMonitorByAccount.has(key)) continue;
    latestAccountMonitorByAccount.set(key, row);
  }
  const accountMonitor = {
    generatedAtUtc: new Date().toISOString(),
    sourceRoot: path.dirname(PATRADING_PAPER_SQLITE_FILE),
    sourceDir: path.dirname(PATRADING_PAPER_SQLITE_FILE),
    sourceFiles,
    activeSourceFiles: sourceFiles,
    expectedAccount: "Sim1",
    ignoredSourceFiles: [],
    rows: [...latestAccountMonitorByAccount.values()],
    parseErrors: [],
    warning: accountMonitorRows.length ? null : "No account snapshots were found in the paper telemetry SQLite database.",
  };
  const latestAccountMonitor = accountMonitor.rows[0] || null;
  const reconciliation = {
    reportFile: null,
    paperValuePolicy: "Paper values are sourced from the PATrading paper telemetry SQLite account_snapshot table when available; closed trade rows remain sourced from SQLite trades.",
    accountValueAvailable: accountMonitor.rows.some((row) =>
      (row.accountValueDollars !== null && row.accountValueDollars !== undefined && Number.isFinite(Number(row.accountValueDollars))) ||
      (row.currentCashBalanceDollars !== null && row.currentCashBalanceDollars !== undefined && Number.isFinite(Number(row.currentCashBalanceDollars))),
    ),
    missedTrades: {
      windowStartUtc: null,
      windowEndUtc: null,
      detectedMissedTrades: 0,
      detectedMissedSignals: 0,
      status: "sqlite_source_only",
      limitation: "Missed-trade detection is handled by the upstream paper telemetry SQLite writer.",
    },
    strategyRows: [],
  };
  const ledger = {
    generatedAtUtc: new Date().toISOString(),
    sourceRoot: path.dirname(PATRADING_PAPER_SQLITE_FILE),
    paperSqliteFile: PATRADING_PAPER_SQLITE_FILE,
    accountMonitor,
    sourceFiles,
    parserNote: "Extracted from PATrading paper telemetry SQLite trades/fills/account_snapshot tables only. Opened read-only with query_only enabled.",
    cleanStart: null,
    summary: {
      filesScanned: sourceFiles.length,
      sqliteOk: Boolean(sqlite.ok),
      sqliteCounts: sqlite.counts || {},
      eventsImported: 0,
      fillsImported: 0,
      closedTrades: closedTrades.length,
      performanceClosedTrades: performanceClosedTrades.length,
      strategyClosedTrades: strategyClosedTrades.length,
      dailyNetProfitLossDollars: latestAccountMonitor?.dailyNetProfitLossDollars ?? latestAccountMonitor?.dailyProfitLossDollars ?? null,
      dailyNetProfitLossDateUtc: latestAccountMonitor?.updatedAtUtc ?? null,
      dailyNetProfitLossSourceFile: latestAccountMonitor?.sourceFile ?? null,
      openPositions: openPositions.length,
      logOpenPositions: 0,
      dtcSnapshot,
      accountCount: accounts.length,
      symbolCount: symbols.length,
      firstTradeDateUtc: tradeDatesUtc[0] || null,
      lastTradeDateUtc: tradeDatesUtc[tradeDatesUtc.length - 1] || null,
      accounts,
      symbols,
      parseErrors: parseErrors.length,
      accountSnapshots: accountMonitor.rows,
      health: sqlite.health || [],
      cleanStartEffectiveDateUtc: null,
      cleanStartCleanedAtUtc: null,
      eventsBeforeCleanStart: 0,
      eventsFilteredBeforeCleanStart: 0,
    },
    parseErrors,
    events: [],
    closedTrades,
    performanceClosedTrades,
    strategyClosedTrades,
    openPositions,
    dtcSnapshot,
    reconciliation,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(ledger, null, 2));

  return {
    sourceFiles,
    accounts,
    allTrades: allTradeRecords,
    recentTrades: allTradeRecords.slice(-250).reverse(),
    allClosedTrades: closedTrades,
    recentClosedTrades: closedTrades.slice(-250).reverse(),
    performanceClosedTrades,
    recentPerformanceClosedTrades: performanceClosedTrades.slice(-250).reverse(),
    strategyClosedTrades,
    recentStrategyClosedTrades: strategyClosedTrades.slice(-250).reverse(),
    dailyNetProfitLossDollars: latestAccountMonitor?.dailyNetProfitLossDollars ?? latestAccountMonitor?.dailyProfitLossDollars ?? null,
    dailyNetProfitLossDateUtc: latestAccountMonitor?.updatedAtUtc ?? null,
    dailyNetProfitLossSourceFile: latestAccountMonitor?.sourceFile ?? null,
    openPositions,
    fullLedgerFile: outputFile,
    summary: ledger.summary,
    accountMonitor,
    dtcSnapshot,
    reconciliation,
    reconciliationReportFile: reconciliation.reportFile,
  };
}

function buildResearchHistory() {
  return [
    {
      date: "2026-05-15",
      title: "Sierra Strategy Batch: Lunchy IFVG and RubberBand Scalp",
      latest: true,
      sourceFiles: [
        path.join(OCEAN_TRADING_DIR, "oce-22_strategy_batch_handoff_2026-05-15.md"),
        path.join(OCEAN_TRADING_DIR, "oce-23_backtest_report_2026-05-15.md"),
      ],
      researched: [
        "Ocean Trading NQ Lunchy Model 12:35 IFVG 2R",
        "Ocean Trading NQ RubberBand Scalp 2R",
      ],
      results: [
        "Lunchy: 48 trades, 54.17% win rate, $3,695 net PnL, 1.7281 profit factor, $1,275 max drawdown.",
        "RubberBand: 1,780 trades, 49.38% win rate, $18,526.80 frictionless net PnL, but only 1.0161 profit factor and $52,817.74 max drawdown.",
      ],
      chosen: ["Ocean Trading NQ Lunchy Model 12:35 IFVG 2R"],
      rejected: [
        {
          strategy: "Ocean Trading NQ RubberBand Scalp 2R",
          reason: "Rejected because a one-tick-per-fill sensitivity pass flipped it negative and drawdown was far too large for the edge.",
        },
      ],
    },
    {
      date: "2026-05-14",
      title: "Approved Paper-Trading Bundle: ORB and VWAP Momentum Reclaim",
      latest: false,
      sourceFiles: [
        path.join(STRATEGIES_DIR, "paper_trading_handoff_2026-05-14.md"),
        path.join(STRATEGIES_DIR, "paper_trading_status_2026-05-14.md"),
      ],
      researched: [
        "Ocean Trading MNQ Opening Range Breakout 2R",
        "VWAP Momentum Reclaim 2R Capped grid_s5_st25_cd10_sw4000_mt6_b025",
      ],
      results: [
        "ORB MNQ baseline: 134 trades, 57.46% win rate, $9,429 net PnL, 1.83 profit factor, $1,449 max drawdown.",
        "VWAP optimized grid: 2,037 trades, 46.20% win rate, $104,587.86 net PnL, 1.37 profit factor, $9,590.99 max drawdown, worst completed trade -$1,966.40.",
      ],
      chosen: [
        "Ocean Trading MNQ Opening Range Breakout 2R",
        "VWAP Momentum Reclaim 2R Capped grid_s5_st25_cd10_sw4000_mt6_b025",
      ],
      rejected: [],
    },
    {
      date: "2026-05-13",
      title: "VWAP Wave Pullback vs VWAP Reclaim Investigation",
      latest: false,
      sourceFiles: [
        path.join(BACKTEST_DIR, "vwap-wave-vs-reclaim-investigation.md"),
        path.join(BACKTEST_DIR, "vwap-momentum-reclaim-combo-report.md"),
      ],
      researched: [
        "VWAP Wave Pullback",
        "VWAP Reclaim Pullback",
        "Combined VWAP Momentum Reclaim",
      ],
      results: [
        "Investigated whether the two VWAP approaches could be combined into one Sierra strategy.",
        "Final selected working candidate became the capped VWAP Momentum Reclaim grid used in the paper-trading handoff.",
      ],
      chosen: ["VWAP Momentum Reclaim 2R Capped grid_s5_st25_cd10_sw4000_mt6_b025"],
      rejected: [
        {
          strategy: "Separate VWAP Wave Pullback / Reclaim variants",
          reason: "Not used as separate paper strategies because the goal shifted to one optimized combined VWAP candidate.",
        },
      ],
    },
  ].filter((entry) => entry.sourceFiles.some((file) => fs.existsSync(file)));
}

function buildResearchFinds() {
  return [
    {
      id: "lunchy-ifvg-1235",
      foundDate: "2026-05-15",
      cycle: "Latest research/build cycle",
      strategyName: "Ocean Trading NQ Lunchy Model 12:35 IFVG 2R",
      market: "NQ/MNQ",
      style: "ICT / fair value gap / time-window setup",
      evidenceLevel: "Backtested candidate; paper setup blocked",
      popularitySignal: "Identified in the weekly Sierra strategy batch as one of the stronger testable candidates.",
      status: "paper_candidate_setup_blocked",
      decision: "Backtested candidate only; not approved or active on the paper-trading page.",
      reason: "Baseline backtest was promising, but the follow-up paper review found no valid Lunchy paper observation because the wrong strategy was active. Setup must be corrected before any forward-test approval.",
      sourceFiles: [
        path.join(OCEAN_TRADING_DIR, "oce-22_strategy_batch_handoff_2026-05-15.md"),
        path.join(OCEAN_TRADING_DIR, "oce-23_backtest_report_2026-05-15.md"),
        path.join(OCEAN_TRADING_DIR, "oce-26_papertrade_daily_2026-05-15.md"),
      ],
      sourceSystem: "paperclip",
      sourceDetail: "Paperclip research/backtest issue reports and attached artifacts",
    },
    {
      id: "rubberband-scalp",
      foundDate: "2026-05-15",
      cycle: "Latest research/build cycle",
      strategyName: "Ocean Trading NQ RubberBand Scalp 2R",
      market: "NQ/MNQ",
      style: "Mean reversion / scalping",
      evidenceLevel: "Backtested and rejected",
      popularitySignal: "Included in the same latest Sierra strategy batch for comparison.",
      status: "rejected_after_backtest",
      decision: "Rejected.",
      reason: "Baseline profit was friction-sensitive; one-tick-per-fill sensitivity flipped the strategy negative and max drawdown was far too high.",
      sourceFiles: [
        path.join(OCEAN_TRADING_DIR, "oce-22_strategy_batch_handoff_2026-05-15.md"),
        path.join(OCEAN_TRADING_DIR, "oce-23_backtest_report_2026-05-15.md"),
      ],
      sourceSystem: "paperclip",
      sourceDetail: "Paperclip research/backtest issue reports and attached artifacts",
    },
    {
      id: "opening-range-breakout-2r",
      foundDate: "2026-05-14",
      cycle: "Earlier approved paper bundle",
      strategyName: "Ocean Trading MNQ Opening Range Breakout 2R",
      market: "MNQ/NQ",
      style: "Opening range breakout",
      evidenceLevel: "Backtested paper candidate",
      popularitySignal: "Classic futures day-trading setup with clear Sierra implementation path.",
      status: "approved_for_paper_trading",
      decision: "Accepted into paper-trading bundle.",
      reason: "Backtest showed 134 trades, 57.46% win rate, $9,429 net PnL, 1.83 profit factor, and $1,449 max drawdown.",
      sourceFiles: [
        path.join(STRATEGIES_DIR, "paper_trading_handoff_2026-05-14.md"),
        path.join(BACKTEST_DIR, "oce-8-report.md"),
      ],
      sourceSystem: "paperclip",
      sourceDetail: "Paperclip approval and Sierra backtest artifact",
    },
    {
      id: "vwap-momentum-reclaim",
      foundDate: "2026-05-14",
      cycle: "Earlier approved paper bundle",
      strategyName: "VWAP Momentum Reclaim 2R Capped",
      market: "MNQ/NQ",
      style: "VWAP reclaim / pullback continuation",
      evidenceLevel: "Optimized backtest candidate",
      popularitySignal: "VWAP reclaim/pullback ideas recur across retail futures and chart-based strategy research.",
      status: "approved_for_paper_trading",
      decision: "Accepted into paper-trading bundle.",
      reason: "Selected grid `grid_s5_st25_cd10_sw4000_mt6_b025` for >40% win-rate preference and worst completed trade under the $2,000 threshold.",
      sourceFiles: [
        path.join(BACKTEST_DIR, "vwap-grid-optimization-win40-summary.md"),
        path.join(BACKTEST_DIR, "vwap-momentum-reclaim-combo-report.md"),
      ],
      sourceSystem: "paperclip",
      sourceDetail: "Paperclip approval and Sierra backtest artifact",
    },
    {
      id: "vwap-wave-pullback",
      foundDate: "2026-05-13",
      cycle: "VWAP comparison cycle",
      strategyName: "VWAP Wave Pullback",
      market: "NQ/MNQ",
      style: "VWAP wave / pullback filter",
      evidenceLevel: "Investigated",
      popularitySignal: "Related to VWAP pullback/reclaim strategy family already being tested.",
      status: "merged_into_vwap_reclaim",
      decision: "Not kept as a separate active strategy.",
      reason: "Useful ideas were folded into the combined VWAP Momentum Reclaim direction rather than maintained as a separate paper candidate.",
      sourceFiles: [
        path.join(BACKTEST_DIR, "vwap-wave-vs-reclaim-investigation.md"),
      ],
      sourceSystem: "paperclip",
      sourceDetail: "Paperclip VWAP investigation artifact",
    },
  ].filter((find) => find.sourceFiles.some((file) => fs.existsSync(file)));
}

function readPaperclipSync() {
  if (!fs.existsSync(PAPERCLIP_SYNC_FILE)) {
    return { syncedAtUtc: null, issues: [], reports: [], backtestRequests: [], artifactPaths: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(PAPERCLIP_SYNC_FILE, "utf8"));
  } catch {
    return { syncedAtUtc: null, issues: [], reports: [], backtestRequests: [], artifactPaths: [] };
  }
}

function buildPaperclipNativeSync() {
  const sync = readPaperclipSync();
  const reports = (sync.reports || []).map((report) => ({
    ...report,
    source: "paperclip_native",
  }));
  return {
    syncedAtUtc: sync.syncedAtUtc || null,
    source: sync.source || null,
    companyId: sync.companyId || null,
    projectId: sync.projectId || null,
    issueCount: (sync.issues || []).length,
    reportCount: reports.length,
    backtestRequestCount: (sync.backtestRequests || []).length,
    issues: sync.issues || [],
    reports,
    backtestRequests: sync.backtestRequests || [],
    artifactPaths: sync.artifactPaths || [],
  };
}

function sourceSystemForPath(filePath) {
  const text = String(filePath || "");
  if (!text) return "unknown";
  if (text === PAPERCLIP_SYNC_FILE || text.includes("paperclip-sync.json")) return "paperclip";
  if (/SierraChart-(LiveTrading|PaperTrading)|TradeActivityLogs|\.data$/i.test(text)) return "sierra";
  if (/backtest|research|strategy|papertrade|daily|ledger|handoff|status|\.md$|\.json$/i.test(text)) return "paperclip_artifact";
  if (/OceanTrading\.cpp|ACS_Source|\.dll|\.cht$/i.test(text)) return "sierra_strategy_artifact";
  return "local_artifact";
}

function sourceRecord(filePath, consumers = []) {
  const exists = Boolean(filePath && fs.existsSync(filePath));
  const stat = exists ? fs.statSync(filePath) : null;
  const ageHours = stat ? (Date.now() - stat.mtimeMs) / 36e5 : null;
  const sourceSystem = sourceSystemForPath(filePath);
  const stale = !exists || (ageHours !== null && ageHours > 48 && sourceSystem !== "sierra");
  return {
    path: filePath,
    basename: basename(filePath),
    sourceSystem,
    exists,
    lastModifiedUtc: stat ? stat.mtime.toISOString() : null,
    ageHours: ageHours === null ? null : Number(ageHours.toFixed(1)),
    stale,
    consumers,
  };
}

function addDataSource(row, sourceSystem, sourceDetail, extra = {}) {
  return {
    ...row,
    sourceSystem,
    sourceDetail,
    ...extra,
  };
}

function parseMetricsFromBacktestResult(json) {
  if (!json) return { metrics: [], provenance: [] };
  const strategyMap = new Map();
  if (json.bestVariant && typeof json.bestVariant === "object") {
    const best = json.bestVariant;
    return {
      metrics: [{
        strategy: json.strategyLabel || json.strategy || "Cached Backtest",
        variant: best.name || best.params?.name || "best",
        trades: best.trades ?? null,
        wins: best.wins ?? null,
        losses: best.losses ?? null,
        longTrades: best.longTrades ?? null,
        shortTrades: best.shortTrades ?? null,
        netProfitDollars: best.netProfitDollars ?? null,
        winRate: best.winRate ?? (best.trades && best.wins !== undefined ? best.wins / best.trades : null),
        profitFactor: best.profitFactor ?? null,
        maxDrawdownDollars: best.maxDrawdownDollars ?? null,
        sourceFile: json.artifactPath || null,
      }],
    };
  }
  if (Array.isArray(json.summary)) {
    return {
      metrics: json.summary.map((entry) => ({
        strategy: entry.strategy || entry.name || "Unknown strategy",
        variant: entry.variant || null,
        trades: entry.trades ?? entry.tradeCount ?? null,
        wins: entry.wins ?? null,
        losses: entry.losses ?? null,
        longTrades: entry.longTrades ?? null,
        shortTrades: entry.shortTrades ?? null,
        netProfitDollars: entry.netDollars ?? entry.netProfitDollars ?? null,
        winRate: entry.winRate ?? (entry.trades && entry.wins !== undefined ? entry.wins / entry.trades : null),
        profitFactor: entry.profitFactor ?? null,
        maxDrawdownDollars: entry.maxDrawdownDollars ?? null,
        sourceFile: json.report || null,
      })),
    };
  }
  if (Array.isArray(json.results)) {
    for (const entry of json.results) {
      if (!entry?.strategy) continue;
      const existing = strategyMap.get(entry.strategy) || {
        strategy: entry.strategy,
        trades: null,
        wins: null,
        losses: null,
        longTrades: null,
        shortTrades: null,
        netProfitDollars: null,
        winRate: entry.winRate ?? null,
        profitFactor: null,
        maxDrawdownDollars: null,
      };
      if ((entry.variant || "").toLowerCase() === "baseline") {
        existing.trades = entry.tradeCount ?? existing.trades;
        existing.wins = entry.wins ?? existing.wins;
        existing.losses = entry.losses ?? existing.losses;
        existing.longTrades = entry.longTrades ?? existing.longTrades;
        existing.shortTrades = entry.shortTrades ?? existing.shortTrades;
        existing.netProfitDollars = entry.netProfitDollars ?? existing.netProfitDollars;
        existing.winRate = entry.winRate ?? existing.winRate;
        existing.profitFactor = entry.profitFactor ?? existing.profitFactor;
        existing.maxDrawdownDollars = entry.maxDrawdownDollars ?? existing.maxDrawdownDollars;
      }
      strategyMap.set(entry.strategy, existing);
    }
  }

  if (strategyMap.size > 0) {
    return {
      metrics: [...strategyMap.values()],
    };
  }

  if (json.instruments && typeof json.instruments === "object") {
    for (const [instrument, payload] of Object.entries(json.instruments)) {
      if (!payload || typeof payload !== "object" || !payload.scenarios) continue;
      for (const [scenarioName, scenario] of Object.entries(payload.scenarios)) {
        if (!scenario || typeof scenario !== "object") continue;
        const strategy = `${instrument} ${scenarioName}`;
        strategyMap.set(`${instrument}.${scenarioName}`, {
          strategy,
          trades: scenario.tradeCount ?? null,
          wins: scenario.totalWins ?? null,
          losses: scenario.totalLosses ?? null,
          longTrades: scenario.byDirection?.long?.tradeCount ?? null,
          shortTrades: scenario.byDirection?.short?.tradeCount ?? null,
          netProfitDollars: scenario.netPnl ?? null,
          winRate: scenario.winRate ?? null,
          profitFactor: scenario.profitFactor ?? null,
          maxDrawdownDollars: scenario.maxDrawdown ?? null,
        });
      }
    }
  }
  return {
    metrics: [...strategyMap.values()],
  };
}

function normalizeStrategyName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^ocean trading\s+/, "")
    .replace(/\b(nq|mnq)\b/g, "")
    .replace(/\b2r\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function strategyMatches(candidate, target) {
  const left = normalizeStrategyName(candidate);
  const right = normalizeStrategyName(target);
  if (!left || !right) return false;
  if (right.includes("opening range breakout") && /\borb\b/.test(left)) return true;
  if (left.includes("opening range breakout") && /\borb\b/.test(right)) return true;
  return left.includes(right) || right.includes(left) || left.split(" ").some((word) => word.length > 4 && right.includes(word));
}

function extractBacktestEntries(json) {
  const entries = [];
  if (!json || typeof json !== "object") return entries;
  for (const collection of ["summary", "results"]) {
    if (!Array.isArray(json[collection])) continue;
    for (const entry of json[collection]) {
      if (!entry || typeof entry !== "object") continue;
      const strategy = entry.strategy || entry.name || entry.params?.name;
      const variant = entry.variant || entry.params?.scenario || entry.params?.name || entry.name;
      if (strategy || variant) entries.push({ strategy: strategy || variant, variant: variant || "baseline" });
    }
  }
  if (json.instruments && typeof json.instruments === "object") {
    for (const [instrument, payload] of Object.entries(json.instruments)) {
      for (const scenarioName of Object.keys(payload?.scenarios || {})) {
        entries.push({ strategy: `${instrument} ${scenarioName}`, variant: scenarioName });
      }
    }
  }
  return entries;
}

function buildBacktestCoverage(researchFinds) {
  const jsonFiles = [
    ...listFiles(BACKTEST_DIR, (entry) => entry.name.endsWith(".json")),
    ...listFiles(OCEAN_TRADING_DIR, (entry) => entry.name.endsWith(".json")),
  ];
  return (researchFinds || []).map((find) => {
    const matchedFiles = [];
    const variants = new Set();
    const baselines = new Set();
    for (const file of jsonFiles) {
      const json = parseBacktestJson(file.absPath);
      const entries = extractBacktestEntries(json).filter((entry) => strategyMatches(entry.strategy, find.strategyName) || strategyMatches(entry.variant, find.strategyName));
      if (!entries.length && !strategyMatches(file.name, find.strategyName)) continue;
      matchedFiles.push(file.absPath);
      for (const entry of entries.length ? entries : [{ strategy: file.name, variant: "unknown" }]) {
        const variant = String(entry.variant || "baseline");
        variants.add(variant);
        if (/baseline/i.test(variant)) baselines.add(variant);
      }
    }
    const backtestRuns = matchedFiles.length;
    const testedVariants = variants.size;
    const optimizationIterations = Math.max(0, testedVariants - Math.max(1, baselines.size || (testedVariants ? 1 : 0)));
    return {
      strategyName: find.strategyName,
      backtestRuns,
      testedVariants,
      baselineRuns: baselines.size,
      optimizationIterations,
      status: backtestRuns ? (optimizationIterations ? "optimized_or_variant_tested" : "baseline_tested") : "not_tested",
      latestArtifact: matchedFiles[0] || null,
      sourceFiles: matchedFiles,
    };
  });
}

function numberFromText(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function humanizeStatusText(value) {
  if (!value) return "n/a";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contractMultiplier(symbol) {
  const normalized = String(symbol || "").replace("[M]", "").toUpperCase();
  const root = normalized.match(/^([A-Z0-9]+)/)?.[1] || "";
  if (root.startsWith("MNQ")) return 2;
  if (root.startsWith("NQ")) return 20;
  if (root.startsWith("MES")) return 5;
  if (root.startsWith("ES")) return 50;
  if (root.startsWith("MGC")) return 10;
  if (root.startsWith("GC")) return 100;
  if (root.startsWith("MCL")) return 100;
  if (root.startsWith("CL")) return 1000;
  if (root.startsWith("M2K")) return 5;
  if (root.startsWith("RTY")) return 50;
  return 1;
}

function normalizeTradePrice(symbol, rawPrice) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const normalized = String(symbol || "").replace("[M]", "").toUpperCase();
  const root = normalized.match(/^([A-Z0-9]+)/)?.[1] || "";
  if ((root.startsWith("CL") || root.startsWith("MCL")) && price > 1000) return price / 1000;
  if (root.startsWith("NG") && price > 100) return price / 1000;
  if ((root.startsWith("ES") || root.startsWith("MES")) && (price < 1000 || price > 10000)) return null;
  if ((root.startsWith("NQ") || root.startsWith("MNQ")) && (price < 1000 || price > 100000)) return null;
  if ((root.startsWith("GC") || root.startsWith("MGC")) && (price < 1000 || price > 10000)) return null;
  return price;
}

function normalizeSymbolKey(symbol) {
  return String(symbol || "")
    .replace(/\[M\]/gi, "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== "") return object[key];
  }
  return null;
}

function firstFiniteNumber(object, keys) {
  const value = firstDefined(object, keys);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readDtcPositionSnapshot(mode) {
  const payload = readJson(DTC_POSITION_SNAPSHOT_FILE, null);
  const snapshot = payload?.snapshots?.[mode];
  if (!snapshot) return null;
  return {
    ...snapshot,
    generatedAtUtc: payload.generatedAtUtc || snapshot.completedAtUtc || null,
  };
}

function extractDtcBalance(message, generatedAtUtc) {
  if (Number(message?.NoAccountBalances || message?.noAccountBalances || 0) === 1) return null;
  const account = String(firstDefined(message, ["TradeAccount", "Account", "AccountIdentifier", "account", "tradeAccount"]) || "").trim();
  const balanceDollars = firstFiniteNumber(message, [
    "CurrentBalance",
    "AccountBalance",
    "CashBalance",
    "NetLiquidationValue",
    "NetLiquidatingValue",
    "TotalCashValue",
    "Balance",
    "currentBalance",
    "accountBalance",
    "cashBalance",
    "netLiquidationValue",
    "balance",
  ]);
  if (!account || balanceDollars === null) return null;
  return {
    account,
    balanceDollars: Number(balanceDollars.toFixed(2)),
    generatedAtUtc,
    sourceFile: DTC_POSITION_SNAPSHOT_FILE,
  };
}

function readDtcAccountBalances(mode) {
  const snapshot = readDtcPositionSnapshot(mode);
  if (!snapshot?.ok || !Array.isArray(snapshot.balances)) return [];
  return snapshot.balances.map((message) => extractDtcBalance(message, snapshot.generatedAtUtc)).filter(Boolean);
}

function parseSierraTlvFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const fields = new Map();
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const field = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > buffer.length) break;
    const value = buffer.subarray(offset, offset + length);
    fields.set(field, value);
    offset += length;
  }
  return fields;
}

function tlvString(fields, field) {
  const value = fields.get(field);
  return value ? value.toString("latin1").replace(/\0/g, "").trim() || null : null;
}

function tlvDouble(fields, field) {
  const value = fields.get(field);
  return value?.length === 8 ? Number(value.readDoubleLE(0).toFixed(2)) : null;
}

function readTradeAccountMonitor(sourceRoot, sourceDir, outputFile, options = {}) {
  const expectedAccount = options.expectedAccount || null;
  const files = listFiles(
    sourceDir,
    (entry) => /^TradeAccountData_.+\.data$/i.test(entry.name),
  );
  const rows = [];
  const parseErrors = [];
  const ignoredSourceFiles = [];
  for (const file of files) {
    try {
      const fields = parseSierraTlvFile(file.absPath);
      const account = tlvString(fields, 2001) || file.name.replace(/^TradeAccountData_|\.data$/gi, "");
      if (expectedAccount && account.toLowerCase() !== expectedAccount.toLowerCase()) {
        ignoredSourceFiles.push({
          file: file.absPath,
          account,
          reason: `Ignored because paper account monitor is configured for ${expectedAccount}.`,
        });
        continue;
      }
      rows.push({
        account,
        currencyCode: tlvString(fields, 2002),
        currentCashBalanceDollars: tlvDouble(fields, 2004),
        availableFundsForNewPositionsDollars: tlvDouble(fields, 2005),
        marginRequirementDollars: tlvDouble(fields, 2006),
        accountValueDollars: tlvDouble(fields, 2007),
        openPositionsProfitLossDollars: tlvDouble(fields, 2008),
        dailyProfitLossDollars: tlvDouble(fields, 2009),
        sourceFile: file.absPath,
        updatedAtUtc: fs.statSync(file.absPath).mtime.toISOString(),
      });
    } catch (error) {
      parseErrors.push({ file: file.absPath, error: String(error?.message || error) });
    }
  }
  const payload = {
    generatedAtUtc: new Date().toISOString(),
    sourceRoot,
    sourceDir,
    sourceFiles: files.map((file) => file.absPath),
    activeSourceFiles: rows.map((row) => row.sourceFile),
    expectedAccount,
    ignoredSourceFiles,
    rows,
    parseErrors,
    warning: expectedAccount && !rows.length
      ? `No Sierra TradeAccountData file was found for the configured paper simulation account ${expectedAccount}. Non-matching account files are ignored.`
      : null,
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));
  return payload;
}

function readLiveTradeAccountMonitor() {
  return readTradeAccountMonitor(LIVE_SIERRA_ROOT, LIVE_TRADE_ACCOUNT_DATA_DIR, LIVE_ACCOUNT_MONITOR_OUTPUT_FILE);
}

function readPaperTradeAccountMonitor() {
  const sierraConfig = readSierraSymbolConfig();
  const expectedAccount = sierraConfig.paper.account || "Sim1";
  const monitor = readTradeAccountMonitor(
    PAPER_SIERRA_ROOT,
    PAPER_TRADE_ACCOUNT_DATA_DIR,
    PAPER_ACCOUNT_MONITOR_OUTPUT_FILE,
    { expectedAccount },
  );
  const dtcBalance = readDtcAccountBalances("paper").find(
    (balance) => balance.account.toLowerCase() === expectedAccount.toLowerCase(),
  );
  if (dtcBalance && !monitor.rows.some((row) => row.account.toLowerCase() === expectedAccount.toLowerCase())) {
    monitor.rows.push({
      account: dtcBalance.account,
      currencyCode: null,
      currentCashBalanceDollars: dtcBalance.balanceDollars,
      availableFundsForNewPositionsDollars: null,
      marginRequirementDollars: null,
      accountValueDollars: dtcBalance.balanceDollars,
      openPositionsProfitLossDollars: null,
      dailyProfitLossDollars: null,
      sourceFile: dtcBalance.sourceFile,
      sourceSystem: "dtc_snapshot",
      updatedAtUtc: dtcBalance.generatedAtUtc,
    });
    monitor.activeSourceFiles.push(dtcBalance.sourceFile);
    monitor.warning = null;
  } else if (!monitor.rows.length) {
    const snapshot = readDtcPositionSnapshot("paper");
    const noAccountBalance = snapshot?.balances?.some((message) => Number(message?.NoAccountBalances || 0) === 1);
    if (noAccountBalance) {
      monitor.warning = `DTC is connected to the paper Sierra instance and Sim1 is visible, but Sierra returned NoAccountBalances for the paper simulation account. The website will not invent a balance from closed fills or brokerage data.`;
    }
  }
  fs.writeFileSync(PAPER_ACCOUNT_MONITOR_OUTPUT_FILE, JSON.stringify(monitor, null, 2));
  return monitor;
}

function configuredStartingBalance(account) {
  const cleanStart = readJson(LIVE_TRADING_CLEAN_START_FILE, {});
  const configured = firstDefined(cleanStart?.accounts?.[account], ["startingBalanceDollars", "baselineBalanceDollars", "cleanStartBalanceDollars"])
    ?? cleanStart?.startingBalancesDollars?.[account]
    ?? cleanStart?.accountBalances?.[account];
  const configuredNumber = Number(configured);
  if (Number.isFinite(configuredNumber)) return configuredNumber;
  if (/^(LFE|LTE|LFF|LTF)/i.test(String(account || ""))) return 50000;
  return null;
}

function buildAccountProfitReconciliation(closedTrades, accountMonitor = null) {
  const realizedByAccount = new Map();
  const realizedByDateByAccount = new Map();
  const tradeCountByAccount = new Map();
  const latestTradeDateByAccount = new Map();
  for (const trade of closedTrades || []) {
    const account = trade.account || "unknown";
    const realizedPnlDollars = Number(trade.realizedPnlDollars) || 0;
    realizedByAccount.set(account, (realizedByAccount.get(account) || 0) + realizedPnlDollars);
    tradeCountByAccount.set(account, (tradeCountByAccount.get(account) || 0) + 1);
    const tradeDate = datePart(trade.exitAtUtc || trade.tradeDateUtc);
    if (tradeDate) {
      const accountDateKey = `${account}\t${tradeDate}`;
      realizedByDateByAccount.set(accountDateKey, (realizedByDateByAccount.get(accountDateKey) || 0) + realizedPnlDollars);
    }
    const latestDate = latestTradeDateByAccount.get(account);
    if (tradeDate && (!latestDate || tradeDate > latestDate)) latestTradeDateByAccount.set(account, tradeDate);
  }

  const balances = new Map(readDtcAccountBalances("live").map((balance) => [balance.account, balance]));
  const monitors = new Map((accountMonitor?.rows || []).map((row) => [row.account, row]));
  const accounts = [...realizedByAccount.keys()].sort();
  const rows = accounts.map((account) => {
    const balance = balances.get(account) || null;
    const monitor = monitors.get(account) || null;
    const startingBalanceDollars = configuredStartingBalance(account);
    const closedFillProfitAllTimeDollars = Number((realizedByAccount.get(account) || 0).toFixed(2));
    const balanceDeltaDollars = balance && Number.isFinite(startingBalanceDollars)
      ? Number((balance.balanceDollars - startingBalanceDollars).toFixed(2))
      : null;
    const closedTradeCount = tradeCountByAccount.get(account) || 0;
    const latestTradeDate = latestTradeDateByAccount.get(account) || null;
    const monitorDate = datePart(monitor?.updatedAtUtc);
    const monitorDailyProfitLossDollars = Number(monitor?.dailyProfitLossDollars);
    const accountMonitorDateMatchesClosedTrades = !latestTradeDate || monitorDate === latestTradeDate;
    const closedFillComparisonDate = accountMonitorDateMatchesClosedTrades ? monitorDate || latestTradeDate : latestTradeDate;
    const closedFillProfitForMonitorDollars = closedFillComparisonDate
      ? Number((realizedByDateByAccount.get(`${account}\t${closedFillComparisonDate}`) || 0).toFixed(2))
      : closedFillProfitAllTimeDollars;
    const monitorLooksLikeZeroPlaceholder =
      closedTradeCount > 0
      && closedFillProfitForMonitorDollars !== 0
      && monitorDailyProfitLossDollars === 0;
    const canUseAccountMonitor = Number.isFinite(monitorDailyProfitLossDollars)
      && accountMonitorDateMatchesClosedTrades;
    const canUseBalanceDelta = balanceDeltaDollars !== null && closedTradeCount > 0;
    const canUseNonPlaceholderAccountMonitor = canUseAccountMonitor && !monitorLooksLikeZeroPlaceholder;
    const closedFillProfitDollars = canUseAccountMonitor
      ? closedFillProfitForMonitorDollars
      : closedFillProfitAllTimeDollars;
    const trueProfitDollars = canUseBalanceDelta
      ? balanceDeltaDollars
      : canUseNonPlaceholderAccountMonitor
        ? Number(monitorDailyProfitLossDollars.toFixed(2))
        : closedFillProfitDollars;
    const trueProfitSource = canUseBalanceDelta
      ? "account_balance_delta"
      : canUseNonPlaceholderAccountMonitor
        ? "trade_account_monitor"
        : "closed_fill_pnl";
    return {
      account,
      startingBalanceDollars,
      accountBalanceDollars: balance?.balanceDollars ?? null,
      monitorCurrentCashBalanceDollars: monitor?.currentCashBalanceDollars ?? null,
      monitorAvailableFundsDollars: monitor?.availableFundsForNewPositionsDollars ?? null,
      monitorDailyProfitLossDollars: Number.isFinite(monitorDailyProfitLossDollars)
        ? Number(monitorDailyProfitLossDollars.toFixed(2))
        : null,
      monitorDailyProfitLossDateUtc: monitor?.updatedAtUtc || null,
      closedFillProfitDollars,
      closedFillProfitScope: canUseAccountMonitor ? "daily" : "all_time",
      closedFillProfitDateUtc: canUseAccountMonitor ? closedFillComparisonDate : null,
      closedFillProfitAllTimeDollars,
      trueProfitDollars,
      trueProfitSource,
      trueProfitSourceDetail: canUseBalanceDelta
        ? (canUseNonPlaceholderAccountMonitor
          ? "DTC account balance minus configured/known starting balance. Trade Account Monitor daily P/L is kept as a same-day slice, not as the month/account total."
          : monitorLooksLikeZeroPlaceholder
            ? "DTC account balance minus configured/known starting balance. Used because the Trade Account Monitor daily P/L is a zero placeholder while closed Sierra fills exist."
            : "DTC account balance minus configured/known starting balance. Used because the Trade Account Monitor daily P/L is unavailable or not suitable as a cumulative account total.")
        : canUseNonPlaceholderAccountMonitor
          ? "Sierra Trade Account Monitor daily profit/loss for the same date as the latest imported closed trade, including account-level adjustments available to Sierra."
          : monitorLooksLikeZeroPlaceholder
            ? "Sierra Trade Account Monitor reported a same-day zero daily P/L while closed Sierra fills exist for this account, so the website uses closed-fill P&L from Sierra TradeActivityLogs instead of the placeholder monitor value."
            : "Trade Account Monitor and DTC balance are unavailable, so this falls back to closed-fill P&L from Sierra TradeActivityLogs.",
      balanceAsOfUtc: monitor?.updatedAtUtc || balance?.generatedAtUtc || null,
      sourceFile: monitor?.sourceFile || balance?.sourceFile || LIVE_TRADE_OUTPUT_FILE,
    };
  });
  return {
    generatedAtUtc: new Date().toISOString(),
    rows,
    totalClosedFillProfitDollars: Number(rows.reduce((sum, row) => sum + row.closedFillProfitDollars, 0).toFixed(2)),
    totalClosedFillProfitAllTimeDollars: Number(rows.reduce((sum, row) => sum + row.closedFillProfitAllTimeDollars, 0).toFixed(2)),
    totalTrueProfitDollars: Number(rows.reduce((sum, row) => sum + row.trueProfitDollars, 0).toFixed(2)),
    hasAccountBalanceDelta: rows.some((row) => row.trueProfitSource === "account_balance_delta"),
    hasTradeAccountMonitor: rows.some((row) => row.trueProfitSource === "trade_account_monitor"),
  };
}

function extractDtcPosition(message, mode, generatedAtUtc) {
  const rawQuantity = firstDefined(message, [
    "PositionQuantity",
    "Quantity",
    "Position",
    "positionQuantity",
    "quantity",
    "position",
  ]);
  const quantitySigned = Number(rawQuantity);
  if (!Number.isFinite(quantitySigned) || quantitySigned === 0) return null;
  const symbol = String(firstDefined(message, ["Symbol", "symbol", "ExchangeSymbol", "exchangeSymbol"]) || "unknown");
  const account = String(firstDefined(message, ["TradeAccount", "Account", "AccountIdentifier", "account", "tradeAccount"]) || "unknown");
  const avgPrice = normalizeTradePrice(
    symbol,
    firstDefined(message, ["AveragePrice", "AveragePriceOfPosition", "AverageFillPrice", "averagePrice", "avgPrice"]),
  );
  const latestPrice = normalizeTradePrice(
    symbol,
    firstDefined(message, ["LastTradePrice", "CurrentPrice", "MarketPrice", "SettlementPrice", "lastPrice", "currentPrice"]),
  );
  const accountInfo = classifyLiveAccount(account);
  const side = quantitySigned > 0 ? "Long" : "Short";
  const quantity = Math.abs(quantitySigned);
  const suppliedPnl = Number(firstDefined(message, ["OpenProfitLoss", "UnrealizedProfitLoss", "OpenPnL", "unrealizedPnl"]));
  const calculatedPoints =
    avgPrice !== null && latestPrice !== null ? (side === "Long" ? latestPrice - avgPrice : avgPrice - latestPrice) : null;
  const calculatedPnl =
    calculatedPoints === null ? null : Number((calculatedPoints * quantity * contractMultiplier(symbol)).toFixed(2));
  const unrealizedPnlDollars = Number.isFinite(suppliedPnl) ? Number(suppliedPnl.toFixed(2)) : calculatedPnl;
  return {
    mode,
    account,
    accountType: accountInfo.accountType,
    accountFamily: accountInfo.accountFamily,
    symbol,
    tradeSource: "manual",
    strategyName: "Manual Trade",
    side,
    quantity,
    averageEntryPrice: avgPrice,
    latestPrice,
    unrealizedPnlDollars,
    openedAtUtc: null,
    lastUpdatedUtc: generatedAtUtc,
    sourceFile: DTC_POSITION_SNAPSHOT_FILE,
    sourceSystem: "dtc_snapshot",
    profitTreatment: accountInfo.profitTreatment,
    status: "Open",
  };
}

function mergeDtcSnapshotPositions(openPositions, mode) {
  const snapshot = readDtcPositionSnapshot(mode);
  if (!snapshot) return { openPositions, dtcSnapshot: { available: false, status: "not_run" } };
  const sierraConfig = readSierraSymbolConfig();
  const activePaperSymbol = normalizeSymbolKey(sierraConfig.paper?.symbol || "");
  const status = {
    available: Boolean(snapshot.ok),
    status: snapshot.ok ? "ok" : "unavailable",
    generatedAtUtc: snapshot.generatedAtUtc,
    completedAtUtc: snapshot.completedAtUtc,
    host: snapshot.host,
    port: snapshot.port,
    error: snapshot.error || null,
    positions: Array.isArray(snapshot.positions) ? snapshot.positions.length : 0,
    balances: Array.isArray(snapshot.balances) ? snapshot.balances.length : 0,
  };
  if (!snapshot.ok) return { openPositions, dtcSnapshot: status };
  let extracted = (snapshot.positions || [])
    .map((message) => extractDtcPosition(message, mode, snapshot.generatedAtUtc))
    .filter(Boolean);
  if (mode === "paper" && activePaperSymbol) {
    extracted = extracted.filter((position) => normalizeSymbolKey(position.symbol) === activePaperSymbol);
  }
  if (!extracted.length) return { openPositions, dtcSnapshot: status };

  const byKey = new Map(openPositions.map((position) => [`${position.account}|${normalizeSymbolKey(position.symbol)}`, position]));
  const merged = extracted.map((position) => {
    const existing = byKey.get(`${position.account}|${normalizeSymbolKey(position.symbol)}`);
    return existing
      ? {
          ...existing,
          ...position,
          tradeSource: existing.tradeSource || position.tradeSource,
          strategyName: existing.strategyName || position.strategyName,
          openedAtUtc: existing.openedAtUtc || position.openedAtUtc,
          sourceFile: position.sourceFile,
          sourceSystem: "dtc_snapshot",
        }
      : position;
  });
  return { openPositions: merged, dtcSnapshot: status };
}

function classifyLiveAccount(account) {
  const value = String(account || "").toUpperCase();
  if (!value) return { accountType: "Unknown", accountFamily: "Unknown", profitTreatment: "excluded_pending_review" };
  if (/^SIM\d*/.test(value)) {
    return { accountType: "Paper Simulation", accountFamily: "Sierra Sim", profitTreatment: "paper_test" };
  }
  if (/^\d+[A-Z]$/.test(value)) {
    return { accountType: "Brokerage", accountFamily: "Brokerage", profitTreatment: "real_account_pnl" };
  }
  if (/^(LFE|LTE)/.test(value) || /-TEST\d+/.test(value)) {
    return { accountType: "Prop Evaluation", accountFamily: value.startsWith("LF") || value.startsWith("LT") ? "Lucid" : "Prop Firm", profitTreatment: "qualification_cycle" };
  }
  if (/^(LFF|LTF)/.test(value) || /-PRO\d+/.test(value)) {
    return { accountType: "Prop Funded/Live", accountFamily: value.startsWith("LF") || value.startsWith("LT") ? "Lucid" : "Prop Firm", profitTreatment: "funded_cycle" };
  }
  if (/^APEX-/.test(value) || /^EXPRESS/.test(value) || /^S1/.test(value)) {
    return { accountType: "Prop Evaluation", accountFamily: value.startsWith("APEX") ? "Apex" : "Prop Firm", profitTreatment: "qualification_cycle" };
  }
  if (/^PA-APEX/.test(value)) {
    return { accountType: "Prop Funded/Live", accountFamily: "Apex", profitTreatment: "funded_cycle" };
  }
  if (/^PRACTICE/.test(value)) {
    return { accountType: "Practice", accountFamily: "Practice", profitTreatment: "excluded_practice" };
  }
  return { accountType: "Unclassified", accountFamily: "Unknown", profitTreatment: "excluded_pending_review" };
}

function updatePerformanceDrawdown(summary, realizedPnl) {
  summary.netProfitDollars += realizedPnl;
  summary.equityHigh = Math.max(summary.equityHigh, summary.netProfitDollars);
  summary.maxDrawdownDollars = Math.max(summary.maxDrawdownDollars, summary.equityHigh - summary.netProfitDollars);
}

function isDateOnlyTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function timestampToMs(value) {
  if (!value || isDateOnlyTimestamp(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function datePart(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function readOpenPositionsBaseline() {
  const baseline = readJson(OPEN_POSITIONS_BASELINE_FILE, null);
  if (!baseline?.effectiveAtUtc) return null;
  return {
    ...baseline,
    effectiveDateUtc: baseline.effectiveDateUtc || datePart(baseline.effectiveAtUtc),
  };
}

function isPositionAfterBaseline(position, baseline) {
  if (!baseline?.effectiveAtUtc) return true;
  const opened = position.openedAtUtc;
  if (!opened) return false;
  const openedMs = timestampToMs(opened);
  const baselineMs = timestampToMs(baseline.effectiveAtUtc);
  if (openedMs !== null && baselineMs !== null) return openedMs >= baselineMs;
  const openedDate = datePart(opened);
  return Boolean(openedDate && baseline.effectiveDateUtc && openedDate >= baseline.effectiveDateUtc);
}

function durationMinutesBetween(start, end) {
  const startMs = timestampToMs(start);
  const endMs = timestampToMs(end);
  if (startMs === null || endMs === null || endMs < startMs) return null;
  return Number(((endMs - startMs) / 60000).toFixed(2));
}

function closedTradeEntryKey(trade) {
  return [
    trade.account || "unknown",
    trade.symbol || "unknown",
    trade.tradeSource || "unknown",
    trade.strategyName || "Unknown strategy",
    trade.side || "n/a",
    trade.entryAtUtc || trade.tradeDateUtc || "unknown-entry",
    Number(trade.entryPrice).toFixed(4),
  ].join("|");
}

function aggregateClosedTradeLegs(legs) {
  const grouped = new Map();
  for (const leg of legs || []) {
    const key = closedTradeEntryKey(leg);
    const existing = grouped.get(key);
    const exitLeg = {
      exitAtUtc: leg.exitAtUtc,
      tradeDateUtc: leg.tradeDateUtc,
      quantity: leg.quantity,
      exitPrice: leg.exitPrice,
      points: leg.points,
      realizedPnlDollars: leg.realizedPnlDollars,
      internalOrderId: leg.internalOrderId,
      sourceFile: leg.sourceFile,
      status: leg.status,
    };
    if (!existing) {
      grouped.set(key, {
        ...leg,
        quantity: Number(leg.quantity) || 0,
        realizedPnlDollars: Number(leg.realizedPnlDollars) || 0,
        exitLegs: [exitLeg],
        exitLegCount: 1,
        status: "Closed / reduced",
      });
      continue;
    }
    existing.quantity += Number(leg.quantity) || 0;
    existing.realizedPnlDollars += Number(leg.realizedPnlDollars) || 0;
    existing.exitLegs.push(exitLeg);
    existing.exitLegCount = existing.exitLegs.length;
    existing.exitAtUtc = [existing.exitAtUtc, leg.exitAtUtc].filter(Boolean).sort().at(-1) || existing.exitAtUtc;
    existing.tradeDateUtc = existing.exitAtUtc || existing.tradeDateUtc;
    existing.durationMinutes = durationMinutesBetween(existing.entryAtUtc, existing.exitAtUtc);
    existing.internalOrderId = [...new Set([existing.internalOrderId, leg.internalOrderId].filter(Boolean))].join(", ");
    existing.sourceFile = [...new Set([existing.sourceFile, leg.sourceFile].filter(Boolean))].join("; ");
  }

  return [...grouped.values()]
    .map((trade) => {
      const quantity = Number(trade.quantity) || 0;
      const multiplier = contractMultiplier(trade.symbol);
      const weightedExit = quantity
        ? trade.exitLegs.reduce((sum, leg) => sum + (Number(leg.exitPrice) || 0) * (Number(leg.quantity) || 0), 0) / quantity
        : Number(trade.exitPrice);
      const realized = Number(trade.realizedPnlDollars) || 0;
      const points = quantity && multiplier ? realized / (quantity * multiplier) : Number(trade.points);
      return {
        ...trade,
        quantity: Number(quantity.toFixed(4)),
        exitPrice: Number(weightedExit.toFixed(4)),
        points: Number(points.toFixed(4)),
        realizedPnlDollars: Number(realized.toFixed(2)),
        exitLegCount: trade.exitLegs.length,
        status: trade.exitLegs.length > 1 ? `Closed / reduced (${trade.exitLegs.length} exit legs)` : "Closed / reduced",
      };
    })
    .sort((a, b) => String(a.exitAtUtc || a.tradeDateUtc || "").localeCompare(String(b.exitAtUtc || b.tradeDateUtc || "")));
}

function paperPerformanceTradeKey(trade) {
  return [
    trade.account || "unknown",
    trade.symbol || "unknown",
    trade.tradeSource || "unknown",
    trade.strategyName || "Unknown strategy",
    trade.side || "n/a",
    trade.entryAtUtc || trade.tradeDateUtc || "unknown-entry",
    trade.chartbook || "unknown-chartbook",
    trade.dashboardBucket || "",
    trade.approvalStatus || "",
  ].join("|");
}

function aggregatePaperPerformanceClosedTrades(closedTrades) {
  const grouped = new Map();
  for (const trade of closedTrades || []) {
    const key = paperPerformanceTradeKey(trade);
    const quantity = Number(trade.quantity) || 0;
    const realizedPnlDollars = Number(trade.realizedPnlDollars) || 0;
    const exitLegs = Array.isArray(trade.exitLegs) && trade.exitLegs.length
      ? trade.exitLegs.map((leg) => ({ ...leg }))
      : [{
          exitAtUtc: trade.exitAtUtc,
          tradeDateUtc: trade.tradeDateUtc,
          quantity: trade.quantity,
          exitPrice: trade.exitPrice,
          points: trade.points,
          realizedPnlDollars: trade.realizedPnlDollars,
          internalOrderId: trade.internalOrderId,
          sourceFile: trade.sourceFile,
          status: trade.status,
        }];
    const existing = grouped.get(key) || {
      ...trade,
      quantity: 0,
      realizedPnlDollars: 0,
      exitLegs: [],
      exitLegCount: 0,
      entryPriceWeighted: 0,
      exitPriceWeighted: 0,
      weightTotal: 0,
      sourceFileSet: new Set(),
      orderIdSet: new Set(),
    };
    existing.quantity += quantity;
    existing.realizedPnlDollars += realizedPnlDollars;
    existing.weightTotal += quantity;
    existing.entryPriceWeighted += (Number(trade.entryPrice) || 0) * quantity;
    existing.exitPriceWeighted += (Number(trade.exitPrice) || 0) * quantity;
    existing.exitLegs.push(...exitLegs);
    existing.exitLegCount = existing.exitLegs.length;
    if (trade.entryAtUtc && (!existing.entryAtUtc || trade.entryAtUtc < existing.entryAtUtc)) existing.entryAtUtc = trade.entryAtUtc;
    if (trade.exitAtUtc && (!existing.exitAtUtc || trade.exitAtUtc > existing.exitAtUtc)) existing.exitAtUtc = trade.exitAtUtc;
    existing.tradeDateUtc = existing.exitAtUtc || trade.tradeDateUtc || existing.tradeDateUtc;
    if (trade.sourceFile) existing.sourceFileSet.add(trade.sourceFile);
    if (trade.internalOrderId) existing.orderIdSet.add(trade.internalOrderId);
    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .map((trade) => {
      const quantity = Number(trade.quantity) || 0;
      const multiplier = contractMultiplier(trade.symbol);
      const weightedQuantity = Number(trade.weightTotal) || quantity;
      const entryPrice = weightedQuantity ? trade.entryPriceWeighted / weightedQuantity : Number(trade.entryPrice) || 0;
      const exitPrice = weightedQuantity ? trade.exitPriceWeighted / weightedQuantity : Number(trade.exitPrice) || 0;
      const realized = Number(trade.realizedPnlDollars) || 0;
      const points = quantity && multiplier ? realized / (quantity * multiplier) : Number(trade.points) || 0;
      return {
        ...trade,
        quantity: Number(quantity.toFixed(4)),
        entryPrice: Number(entryPrice.toFixed(4)),
        exitPrice: Number(exitPrice.toFixed(4)),
        points: Number(points.toFixed(4)),
        realizedPnlDollars: Number(realized.toFixed(2)),
        exitLegCount: trade.exitLegs.length,
        internalOrderId: [...trade.orderIdSet].join(", "),
        sourceFile: [...trade.sourceFileSet].join("; "),
        status: trade.exitLegs.length > 1 ? `Closed / reduced (${trade.exitLegs.length} exit legs)` : "Closed / reduced",
      };
    })
    .sort((a, b) => String(a.exitAtUtc || a.tradeDateUtc || "").localeCompare(String(b.exitAtUtc || b.tradeDateUtc || "")));
}

function fillStrategyStateKey(fill) {
  return [
    fill.account || "unknown",
    fill.symbol || "unknown",
    fill.tradeSource || "manual",
    fill.strategyName || fill.strategyStudy || fill.chartbook || "Manual Trade",
    fill.dashboardBucket || "",
  ].join("|");
}

function buildClosedTradesFromFills(fills, options = {}) {
  const separateStrategies = options.separateStrategies === true;
  const states = new Map();
  const closedTradeLegs = [];

  for (const fill of fills) {
    const price = normalizeTradePrice(fill.symbol, fill.price);
    const qty = fill.quantity === null || fill.quantity === undefined ? NaN : Number(fill.quantity);
    const accountInfo = classifyLiveAccount(fill.account);
    fill.accountType = accountInfo.accountType;
    fill.accountFamily = accountInfo.accountFamily;
    fill.profitTreatment = accountInfo.profitTreatment;
    fill.realizedPnlDollars = null;

    if (price === null || !Number.isFinite(qty) || qty <= 0 || !["Buy", "Sell"].includes(fill.side)) {
      continue;
    }

    const key = separateStrategies ? fillStrategyStateKey(fill) : `${fill.account || "unknown"}|${fill.symbol || "unknown"}`;
    const previousPosition = Number(fill.previousPosition);
    const positionAfter = Number(fill.positionAfter);
    const initialPosition = separateStrategies ? 0 : Number.isFinite(previousPosition) ? previousPosition : 0;
    const state = states.get(key) || {
      position: initialPosition,
      avgPrice: 0,
      avgKnown: initialPosition === 0,
      openedAtUtc: initialPosition === 0 ? null : fill.tradeDateUtc,
      tradeSource: fill.tradeSource,
      strategyName: fill.strategyName,
      strategyStudy: fill.strategyStudy,
      approvalStatus: fill.approvalStatus,
      dashboardBucket: fill.dashboardBucket,
      chartbook: fill.chartbook,
    };
    const signedQty = fill.side === "Buy" ? qty : -qty;
    const inferredPositionAfter = separateStrategies
      ? state.position + signedQty
      : Number.isFinite(positionAfter)
        ? positionAfter
        : state.position + signedQty;

    if (!separateStrategies && Number.isFinite(previousPosition) && previousPosition !== state.position) {
      state.position = previousPosition;
      state.avgPrice = previousPosition === 0 ? 0 : price;
      state.avgKnown = previousPosition === 0;
      state.openedAtUtc = previousPosition === 0 ? null : fill.tradeDateUtc;
    }

    if (state.position === 0 || Math.sign(state.position) === Math.sign(signedQty)) {
      const newAbs = Math.abs(state.position) + qty;
      state.avgPrice = state.avgKnown && newAbs ? (Math.abs(state.position) * state.avgPrice + qty * price) / newAbs : price;
      state.position = inferredPositionAfter;
      state.avgKnown = true;
      if (!state.openedAtUtc || Math.abs(state.position) === qty) {
        state.openedAtUtc = fill.tradeDateUtc;
        state.tradeSource = fill.tradeSource;
        state.strategyName = fill.strategyName;
        state.strategyStudy = fill.strategyStudy;
        state.approvalStatus = fill.approvalStatus;
        state.dashboardBucket = fill.dashboardBucket;
        state.chartbook = fill.chartbook;
      }
      states.set(key, state);
      continue;
    }

    if (!state.avgKnown) {
      state.position = inferredPositionAfter;
      if (state.position === 0) {
        state.avgPrice = 0;
        state.avgKnown = true;
      }
      states.set(key, state);
      continue;
    }

    const closingQty = Math.min(Math.abs(state.position), qty);
    const wasLong = state.position > 0;
    const entryPrice = state.avgPrice;
    const exitPrice = price;
    const points = wasLong ? exitPrice - entryPrice : entryPrice - exitPrice;
    const realizedPnl = points * closingQty * contractMultiplier(fill.symbol);
    const entryAtUtc = state.openedAtUtc || fill.tradeDateUtc;
    const exitAtUtc = fill.tradeDateUtc;
    fill.realizedPnlDollars = Number(realizedPnl.toFixed(2));
    closedTradeLegs.push({
      tradeDateUtc: fill.tradeDateUtc,
      entryAtUtc,
      exitAtUtc,
      durationMinutes: durationMinutesBetween(entryAtUtc, exitAtUtc),
      account: fill.account,
      accountType: accountInfo.accountType,
      accountFamily: accountInfo.accountFamily,
      profitTreatment: accountInfo.profitTreatment,
      symbol: fill.symbol,
      tradeSource: state.tradeSource || fill.tradeSource,
      strategyName: state.strategyName || fill.strategyName,
      strategyStudy: state.strategyStudy || fill.strategyStudy,
      approvalStatus: state.approvalStatus || fill.approvalStatus,
      dashboardBucket: state.dashboardBucket || fill.dashboardBucket,
      chartbook: state.chartbook || fill.chartbook,
      side: wasLong ? "Long" : "Short",
      quantity: closingQty,
      entryPrice: Number(entryPrice.toFixed(4)),
      exitPrice: Number(exitPrice.toFixed(4)),
      points: Number(points.toFixed(4)),
      realizedPnlDollars: Number(realizedPnl.toFixed(2)),
      internalOrderId: fill.internalOrderId,
      sourceFile: fill.sourceFile,
      status: "Closed / reduced",
    });

    const remainingSigned = signedQty + (wasLong ? closingQty : -closingQty);
    if (remainingSigned === 0) {
      state.position = inferredPositionAfter;
      if (state.position === 0) {
        state.avgPrice = 0;
        state.openedAtUtc = null;
        state.tradeSource = null;
        state.strategyName = null;
        state.strategyStudy = null;
        state.approvalStatus = null;
        state.dashboardBucket = null;
        state.chartbook = null;
      }
    } else {
      state.position = separateStrategies
        ? remainingSigned
        : Number.isFinite(positionAfter)
          ? positionAfter
          : remainingSigned;
      state.avgPrice = price;
      state.openedAtUtc = fill.tradeDateUtc;
      state.tradeSource = fill.tradeSource;
      state.strategyName = fill.strategyName;
      state.strategyStudy = fill.strategyStudy;
      state.approvalStatus = fill.approvalStatus;
      state.dashboardBucket = fill.dashboardBucket;
      state.chartbook = fill.chartbook;
    }
    state.avgKnown = true;
    states.set(key, state);
  }

  return aggregateClosedTradeLegs(closedTradeLegs);
}

function buildOpenPositionsFromFills(fills, mode = "live", options = {}) {
  const separateStrategies = options.separateStrategies === true;
  const states = new Map();
  const baseline = readOpenPositionsBaseline();

  for (const fill of fills) {
    const price = normalizeTradePrice(fill.symbol, fill.price);
    const qty = fill.quantity === null || fill.quantity === undefined ? NaN : Number(fill.quantity);
    const accountInfo = classifyLiveAccount(fill.account);
    if (price === null || !Number.isFinite(qty) || qty <= 0 || !["Buy", "Sell"].includes(fill.side)) {
      continue;
    }

    const key = separateStrategies ? fillStrategyStateKey(fill) : `${fill.account || "unknown"}|${fill.symbol || "unknown"}`;
    const previousPosition = Number(fill.previousPosition);
    const positionAfter = Number(fill.positionAfter);
    const initialPosition = separateStrategies ? 0 : Number.isFinite(previousPosition) ? previousPosition : 0;
    const state = states.get(key) || {
      mode,
      account: fill.account,
      accountType: accountInfo.accountType,
      accountFamily: accountInfo.accountFamily,
      symbol: fill.symbol,
      tradeSource: fill.tradeSource,
      strategyName: fill.strategyName,
      strategyStudy: fill.strategyStudy,
      approvalStatus: fill.approvalStatus,
      dashboardBucket: fill.dashboardBucket,
      chartbook: fill.chartbook,
      position: initialPosition,
      avgPrice: 0,
      avgKnown: initialPosition === 0,
      latestPrice: price,
      openedAtUtc: fill.tradeDateUtc,
      lastUpdatedUtc: fill.tradeDateUtc,
      sourceFile: fill.sourceFile,
      profitTreatment: accountInfo.profitTreatment,
    };
    const signedQty = fill.side === "Buy" ? qty : -qty;
    const inferredPositionAfter = separateStrategies
      ? state.position + signedQty
      : Number.isFinite(positionAfter)
        ? positionAfter
        : state.position + signedQty;

    if (!separateStrategies && Number.isFinite(previousPosition) && previousPosition !== state.position) {
      state.position = previousPosition;
      state.avgPrice = previousPosition === 0 ? 0 : price;
      state.avgKnown = previousPosition === 0;
      if (previousPosition === 0) state.openedAtUtc = fill.tradeDateUtc;
    }

    state.latestPrice = price;
    state.lastUpdatedUtc = fill.tradeDateUtc;
    state.sourceFile = fill.sourceFile;
    state.tradeSource = fill.tradeSource;
    state.strategyName = fill.strategyName;
    state.strategyStudy = fill.strategyStudy;
    state.approvalStatus = fill.approvalStatus;
    state.dashboardBucket = fill.dashboardBucket;
    state.chartbook = fill.chartbook;
    state.accountType = accountInfo.accountType;
    state.accountFamily = accountInfo.accountFamily;
    state.profitTreatment = accountInfo.profitTreatment;

    if (state.position === 0 || Math.sign(state.position) === Math.sign(signedQty)) {
      const newAbs = Math.abs(state.position) + qty;
      state.avgPrice = state.avgKnown && newAbs ? (Math.abs(state.position) * state.avgPrice + qty * price) / newAbs : price;
      state.position = inferredPositionAfter;
      state.avgKnown = true;
      if (Math.abs(state.position) === qty) state.openedAtUtc = fill.tradeDateUtc;
      states.set(key, state);
      continue;
    }

    const wasLong = state.position > 0;
    const closingQty = Math.min(Math.abs(state.position), qty);
    const remainingSigned = signedQty + (wasLong ? closingQty : -closingQty);
    if (remainingSigned === 0) {
      state.position = inferredPositionAfter;
      if (state.position === 0) state.avgPrice = 0;
    } else {
      state.position = separateStrategies
        ? remainingSigned
        : Number.isFinite(positionAfter)
          ? positionAfter
          : remainingSigned;
      state.avgPrice = price;
      state.openedAtUtc = fill.tradeDateUtc;
    }
    state.avgKnown = true;
    states.set(key, state);
  }

  return [...states.values()]
    .filter((state) => state.position !== 0)
    .map((state) => {
      const side = state.position > 0 ? "Long" : "Short";
      const quantity = Math.abs(state.position);
      const points = state.avgKnown
        ? side === "Long"
          ? state.latestPrice - state.avgPrice
          : state.avgPrice - state.latestPrice
        : null;
      const unrealizedPnlDollars = points === null ? null : Number((points * quantity * contractMultiplier(state.symbol)).toFixed(2));
      return {
        mode: state.mode,
        account: state.account,
        accountType: state.accountType,
        accountFamily: state.accountFamily,
        symbol: state.symbol,
        tradeSource: state.tradeSource,
        strategyName: state.strategyName,
        strategyStudy: state.strategyStudy,
        approvalStatus: state.approvalStatus,
        dashboardBucket: state.dashboardBucket,
        chartbook: state.chartbook,
        side,
        quantity,
        averageEntryPrice: state.avgKnown ? Number(state.avgPrice.toFixed(4)) : null,
        latestPrice: Number(state.latestPrice.toFixed(4)),
        unrealizedPnlDollars,
        openedAtUtc: state.openedAtUtc,
        lastUpdatedUtc: state.lastUpdatedUtc,
        sourceFile: state.sourceFile,
        profitTreatment: state.profitTreatment,
        status: "Open",
      };
    })
    .filter((position) => isPositionAfterBaseline(position, baseline));
}

function summarizeLiveClosedTradePerformance(label, trades, source = "manual", accountType = "All") {
  const summary = {
    strategy: label,
    source,
    accountType,
    trades: 0,
    wins: 0,
    losses: 0,
    longTrades: 0,
    shortTrades: 0,
    netProfitDollars: 0,
    winRate: null,
    profitFactor: null,
    maxDrawdownDollars: 0,
    equityHigh: 0,
    grossProfitDollars: 0,
    grossLossDollars: 0,
    accounts: [],
    pricedFills: 0,
    unreconciledFills: 0,
    firstTradeDateUtc: null,
    lastTradeDateUtc: null,
    sourceFile: LIVE_TRADE_OUTPUT_FILE,
  };
  const accounts = new Set();

  for (const trade of trades) {
    const realizedPnl = Number(trade.realizedPnlDollars);
    if (trade.account) accounts.add(trade.account);
    if (!summary.firstTradeDateUtc || trade.tradeDateUtc < summary.firstTradeDateUtc) summary.firstTradeDateUtc = trade.tradeDateUtc;
    if (!summary.lastTradeDateUtc || trade.tradeDateUtc > summary.lastTradeDateUtc) summary.lastTradeDateUtc = trade.tradeDateUtc;
    summary.trades += 1;
    if (trade.side === "Long") summary.longTrades += 1;
    else summary.shortTrades += 1;
    if (realizedPnl > 0) {
      summary.wins += 1;
      summary.grossProfitDollars += realizedPnl;
    } else if (realizedPnl < 0) {
      summary.losses += 1;
      summary.grossLossDollars += Math.abs(realizedPnl);
    }
    updatePerformanceDrawdown(summary, realizedPnl);
  }

  summary.winRate = summary.trades ? summary.wins / summary.trades : null;
  summary.profitFactor = summary.grossLossDollars
    ? Number((summary.grossProfitDollars / summary.grossLossDollars).toFixed(2))
    : summary.grossProfitDollars > 0
      ? "Inf"
      : null;
  summary.netProfitDollars = Number(summary.netProfitDollars.toFixed(2));
  summary.maxDrawdownDollars = Number(summary.maxDrawdownDollars.toFixed(2));
  summary.grossProfitDollars = Number(summary.grossProfitDollars.toFixed(2));
  summary.grossLossDollars = Number(summary.grossLossDollars.toFixed(2));
  summary.accounts = [...accounts].sort();
  return summary;
}

function applyTrueProfitToLiveRow(row, trades, liveTrading) {
  const accountRows = liveTrading.profitReconciliation?.rows || [];
  const tradeAccounts = [...new Set((trades || []).map((trade) => trade.account).filter(Boolean))].sort();
  const allClosedTradesForAccounts = (liveTrading.performanceClosedTrades || []).filter((trade) => tradeAccounts.includes(trade.account));
  const tradeDates = [...new Set((trades || []).map((trade) => datePart(trade.exitAtUtc || trade.tradeDateUtc)).filter(Boolean))];
  const latestTradeDate = tradeDates.sort().at(-1) || null;
  const rowCoversWholeAccount =
    tradeAccounts.length > 0 &&
    allClosedTradesForAccounts.length === trades.length &&
    allClosedTradesForAccounts.every((trade) => trades.includes(trade));
  const reconciledRows = accountRows.filter((account) => tradeAccounts.includes(account.account));
  const canUseAccountActual =
    rowCoversWholeAccount &&
    reconciledRows.some((account) => {
      if (account.trueProfitSource === "account_balance_delta") return true;
      if (account.trueProfitSource !== "trade_account_monitor") return false;
      return tradeDates.length === 1 && datePart(account.balanceAsOfUtc) === latestTradeDate;
    });
  const trueProfitDollars = canUseAccountActual
    ? reconciledRows.reduce((sum, account) => sum + (Number(account.trueProfitDollars) || 0), 0)
    : row.netProfitDollars;
  const source = canUseAccountActual
    ? reconciledRows.some((account) => account.trueProfitSource === "trade_account_monitor")
      ? "trade_account_monitor"
      : "account_balance_delta"
    : "closed_fill_pnl";
  return {
    ...row,
    trueProfitDollars: Number(trueProfitDollars.toFixed(2)),
    trueProfitSource: source,
    trueProfitSourceDetail: canUseAccountActual
      ? source === "trade_account_monitor"
        ? "Sierra Trade Account Monitor daily profit/loss is available and this row covers the full account activity."
        : "Account balance delta is available and this row covers the full account activity."
      : "Using closed-fill P&L because account-level actuals are unavailable, daily-only, or cannot be allocated to only this strategy/owner row.",
  };
}

function buildPerformanceGroups({ ledger, daily, paperTrading, liveTrading, activePaperMetrics, parsedBacktest }) {
  const latestLedger = ledger.latestLedger || {};
  const latestDaily = daily.latestDaily || {};
  const backtestRows = activePaperMetrics.length ? activePaperMetrics : parsedBacktest.metrics;
  const candidateRows = parsedBacktest.metrics.filter(
    (candidate) => !backtestRows.some((row) => row.strategy === candidate.strategy),
  );
  const liveFills = liveTrading.performanceTrades || liveTrading.trades || [];
  const liveClosedTrades = liveTrading.performanceClosedTrades || [];
  const groupedClosedTrades = new Map();
  for (const trade of liveClosedTrades) {
    const key = `${trade.tradeSource || "manual"}|${trade.accountType || "Unclassified"}|${trade.strategyName || "Manual Trade"}`;
    if (!groupedClosedTrades.has(key)) groupedClosedTrades.set(key, []);
    groupedClosedTrades.get(key).push(trade);
  }
  const liveRows = [...groupedClosedTrades.entries()].map(([key, trades]) => {
    const [source, accountType, strategyName] = key.split("|");
    const row = summarizeLiveClosedTradePerformance(strategyName, trades, source, accountType);
    const relatedFills = liveFills.filter(
      (fill) =>
        (fill.tradeSource || "manual") === source &&
        (fill.accountType || classifyLiveAccount(fill.account).accountType) === accountType &&
        (fill.strategyName || "Manual Trade") === strategyName,
    );
    row.pricedFills = relatedFills.filter((fill) => fill.price !== null && fill.price !== undefined && Number.isFinite(Number(fill.price))).length;
    row.unreconciledFills = relatedFills.length - row.pricedFills;
    return applyTrueProfitToLiveRow(row, trades, liveTrading);
  });
  const strategyRows = liveRows.filter((row) => row.source === "strategy");
  if (!strategyRows.length) {
    liveRows.push({
      strategy: "Ocean Trading Strategy Live",
      source: "strategy",
      sourceSystem: "sierra",
      sourceDetail: "Sierra Chart live TradeActivityLogs",
      accountType: "n/a",
      trades: 0,
      wins: 0,
      losses: 0,
      longTrades: 0,
      shortTrades: 0,
      netProfitDollars: 0,
      winRate: null,
      profitFactor: null,
      maxDrawdownDollars: 0,
      accounts: [],
      trueProfitDollars: 0,
      trueProfitSource: "no_closed_trades",
      trueProfitSourceDetail: "No live strategy closed trades have been imported yet.",
      pricedFills: 0,
      unreconciledFills: 0,
      firstTradeDateUtc: liveTrading.importSummary?.firstTradeDateUtc || null,
      lastTradeDateUtc: liveTrading.importSummary?.lastTradeDateUtc || null,
      sourceFile: liveTrading.fullLedgerFile || null,
    });
  }

  return {
    backtesting: {
      label: "Backtesting Performance",
      summary: "Historical Sierra Chart/DTC backtest and optimization metrics. These are not live or paper fills.",
      rows: backtestRows,
      candidateRows,
    },
    paperTrading: {
      label: "Paper Trading Performance",
      summary: "Approved paper-trading strategies only. Setup/preflight reports are shown separately when they do not belong to the active paper bundle.",
      status: paperTrading.status,
      account: paperTrading.account,
      symbol: paperTrading.symbol,
      dataHygiene: paperTrading.dataHygiene,
      rows: paperTrading.strategies.map((strategy) => {
        const closedTrades = (paperTrading.performanceClosedTrades || []).filter(
          (trade) => (trade.strategyName || "") === strategy.name || (trade.strategyName || "") === strategy.sierraStudy,
        );
        const wins = closedTrades.filter((trade) => Number(trade.realizedPnlDollars) > 0).length;
        const losses = closedTrades.filter((trade) => Number(trade.realizedPnlDollars) < 0).length;
        const longTrades = closedTrades.filter((trade) => trade.side === "Long").length;
        const shortTrades = closedTrades.filter((trade) => trade.side === "Short").length;
        const grossProfit = closedTrades.reduce((sum, trade) => {
          const pnl = Number(trade.realizedPnlDollars) || 0;
          return pnl > 0 ? sum + pnl : sum;
        }, 0);
        const grossLoss = closedTrades.reduce((sum, trade) => {
          const pnl = Number(trade.realizedPnlDollars) || 0;
          return pnl < 0 ? sum + Math.abs(pnl) : sum;
        }, 0);
        const realizedPnl = closedTrades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0);
        const drawdownState = {
          netProfitDollars: 0,
          equityHigh: 0,
          maxDrawdownDollars: 0,
        };
        closedTrades.forEach((trade) => updatePerformanceDrawdown(drawdownState, Number(trade.realizedPnlDollars) || 0));
        return {
          strategy: strategy.name,
          sourceSystem: "paperclip",
          sourceDetail: "Paperclip-approved paper strategy with Sierra paper SIM execution observations",
          paperTradingPerformed: humanizeStatusText(strategy.status),
          trades: closedTrades.length,
          tradesObserved: closedTrades.length,
          wins,
          losses,
          longTrades,
          shortTrades,
          fillsObserved: closedTrades.reduce((sum, trade) => sum + (Number(trade.quantity) || 0), 0),
          missedSignals: 0,
          netProfitDollars: Number(realizedPnl.toFixed(2)),
          winRate: closedTrades.length ? Number((wins / closedTrades.length).toFixed(4)) : null,
          profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? "Inf" : null,
          maxDrawdownDollars: Number((drawdownState.maxDrawdownDollars || 0).toFixed(2)),
          pnl: closedTrades.length ? `$${realizedPnl.toFixed(2)}` : "n/a",
          recommendation: strategy.reason,
          sourceFile: strategy.backtestReport || strategy.sourceFile || null,
        };
      }),
      offBundleRows: (paperTrading.separation?.otherStrategies?.rows || []).map((row) => ({
        ...row,
        sourceSystem: row.sourceSystem || "sierra",
        sourceDetail: row.sourceDetail || "Sierra connector paper attribution outside the approved bundle",
      })),
      reviewReports: [
        {
          strategy: latestLedger.strategy || latestDaily.strategy || "Paper trading bundle",
          sourceSystem: "paperclip_artifact",
          sourceDetail: "Historical Paper Trader setup/preflight report",
          status: "setup_or_preflight_report_not_active_bundle",
          paperTradingPerformed: latestLedger.paperTradingPerformed || "unknown",
          tradesObserved: numberFromText(latestLedger.tradesObserved ?? latestDaily.validTrades),
          fillsObserved: numberFromText(latestLedger.fillsObserved ?? latestDaily.validTrades),
          missedSignals: numberFromText(latestDaily.missedSignals ?? latestLedger.missedSignalsReconstructed),
          pnl: latestDaily.realizedPnL || latestLedger.pnl || "n/a",
          recommendation: latestDaily.recommendation || latestLedger.recommendation || "n/a",
          sourceFile: latestDaily.path || latestLedger.path || null,
        },
      ].filter((report) => report.strategy && report.strategy !== "Paper trading bundle"),
    },
    liveTrading: {
      label: "Live Trading Performance",
      summary: liveFills.length || liveTrading.importSummary?.closedTrades || liveTrading.importSummary?.eventsImported
        ? "Imported Sierra Chart live account activity. Net PnL is cumulative closed-fill P&L; daily account-monitor P/L is only used when it can be matched to a single-day whole-account row."
        : "No live Sierra Chart activity is currently imported after the clean start reset.",
      status: liveTrading.status,
      rows: liveRows.map((row) => ({
        ...row,
        sourceSystem: row.sourceSystem || "sierra",
        sourceDetail: row.sourceDetail || "Sierra Chart live TradeActivityLogs",
      })),
      importSummary: liveTrading.importSummary,
    },
  };
}

function pickLatestResearchRuns() {
  const jsonRuns = listFiles(BACKTEST_DIR, (entry) => entry.name.endsWith(".json")).slice(0, 10);
  const latest = jsonRuns.slice(0, 2);
  return latest.map((runFile, index) => {
    const content = parseBacktestJson(runFile.absPath);
    const parsed = parseMetricsFromBacktestResult(content);
    const title = runFile.name.replace(/\.json$/i, "");
    const runDate = content?.generatedAt || null;
    const metricsSummary = parsed.metrics.map((m) => ({
      strategy: m.strategy,
      tradeCount: m.trades,
      netProfitDollars: m.netProfitDollars,
      winRate: m.winRate,
      longTrades: m.longTrades,
      shortTrades: m.shortTrades,
    }));
    return {
      slot: index + 1,
      title,
      runDate,
      sourceFile: runFile.absPath,
      strategies: metricsSummary,
      provenance: {
        sourceFiles: [runFile.absPath],
      },
    };
  });
}

function latestBacktestCandidateRows(activePaperMetrics) {
  const activeNames = new Set(activePaperMetrics.map((row) => normalizeStrategyName(row.strategy)));
  const files = [
    ...listFiles(OCEAN_TRADING_DIR, (entry) => entry.name.endsWith(".json")),
    ...listFiles(CACHED_BACKTEST_RESULTS_DIR, (entry) => entry.name.endsWith(".json")),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const rowsByStrategy = new Map();
  const newestStrategyFile = new Map();

  for (const file of files) {
    const parsed = parseMetricsFromBacktestResult(parseBacktestJson(file.absPath));
    const rows = parsed.metrics
      .filter((row) => row.strategy && !activeNames.has(normalizeStrategyName(row.strategy)))
      .map((row) => addDataSource(
        { ...row, sourceFile: row.sourceFile || file.absPath },
        "paperclip_artifact",
        "latest Ocean Trading backtest JSON artifact",
      ));
    if (!rows.length) continue;
    for (const row of rows) {
      const strategyKey = normalizeStrategyName(row.strategy);
      if (!strategyKey) continue;
      if (newestStrategyFile.has(strategyKey) && newestStrategyFile.get(strategyKey) !== file.absPath) continue;
      newestStrategyFile.set(strategyKey, file.absPath);
      if (!rowsByStrategy.has(strategyKey)) rowsByStrategy.set(strategyKey, []);
      const variantKey = String(row.variant || "baseline").toLowerCase();
      if (!rowsByStrategy.get(strategyKey).some((existing) => String(existing.variant || "baseline").toLowerCase() === variantKey)) {
        rowsByStrategy.get(strategyKey).push(row);
      }
    }
  }

  return [...rowsByStrategy.values()].flat();
}

function parseCachedBacktestStrategyCatalog() {
  const files = listFiles(CACHED_BACKTEST_RESULTS_DIR, (entry) => entry.name.endsWith(".json"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const byStrategy = new Map();
  for (const file of files) {
    const json = parseBacktestJson(file.absPath);
    const parsed = parseMetricsFromBacktestResult(json);
    for (const row of parsed.metrics || []) {
      const strategyKey = normalizeStrategyName(row.strategy);
      if (!strategyKey || byStrategy.has(strategyKey)) continue;
      byStrategy.set(strategyKey, {
        name: row.strategy,
        functionName: json?.strategy || row.variant || "cached_backtest",
        sourceFile: row.sourceFile || file.absPath,
        sourceSystem: "paperclip_artifact",
        sourceDetail: "Cached backtest strategy artifact; not an active Sierra Chart paper-trading study unless separately promoted.",
        platform: "Ocean Trading cached backtest engine",
        status: "backtested_not_active_paper_trading",
      });
    }
  }
  return [...byStrategy.values()];
}

function buildStrategyLifecycle({ researchFinds, backtestCoverage, paperTrading, liveTrading, strategyCatalog }) {
  const strategies = new Map();
  const ensure = (name) => {
    const key = normalizeStrategyName(name);
    if (!key) return null;
    if (!strategies.has(key)) {
      strategies.set(key, {
        strategyName: name,
        sourceSystem: "paperclip",
        stages: [],
        currentStage: "tracked",
        decision: "n/a",
        blockers: [],
      });
    }
    return strategies.get(key);
  };
  const addStage = (name, stage, status, detail, sourceSystem = "paperclip") => {
    const item = ensure(name);
    if (!item) return;
    item.stages.push({ stage, status, detail, sourceSystem });
    item.currentStage = stage;
  };

  for (const find of researchFinds || []) {
    addStage(find.strategyName, "researched", "complete", find.cycle, "paperclip");
    const item = ensure(find.strategyName);
    if (item) item.decision = find.decision || item.decision;
  }
  for (const coverage of backtestCoverage || []) {
    addStage(
      coverage.strategyName,
      "backtested",
      coverage.backtestRuns ? "complete" : "not_started",
      `${coverage.backtestRuns || 0} run(s), ${coverage.optimizationIterations || 0} optimization iteration(s)`,
      "paperclip_artifact",
    );
    if (coverage.optimizationIterations) {
      addStage(coverage.strategyName, "optimized", "complete", `${coverage.optimizationIterations} iteration(s)`, "paperclip_artifact");
    }
  }
  for (const strategy of paperTrading?.strategies || []) {
    addStage(strategy.name, "paper_trading", strategy.status || "configured", strategy.reason || "Approved paper strategy", "paperclip");
    const item = ensure(strategy.name);
    if (item && String(strategy.status || "").includes("blocked")) item.blockers.push(strategy.status);
  }
  for (const strategy of strategyCatalog || []) {
    const item = ensure(strategy.name);
    if (!item) continue;
    item.sourceSystem = strategy.sourceSystem || "sierra_strategy_artifact";
    if (!item.stages.some((stage) => stage.stage === "created")) {
      item.stages.unshift({
        stage: "created",
        status: strategy.status || "created",
        detail: `Sierra ACSIL study ${strategy.functionName || strategy.name} is present in ${basename(strategy.sourceFile)}`,
        sourceSystem: strategy.sourceSystem || "sierra_strategy_artifact",
      });
    }
    if (item.currentStage === "tracked") item.currentStage = "created";
    if (item.decision === "n/a") item.decision = "pending backtest";
  }
  const liveStrategyRows = (liveTrading?.performanceClosedTrades || []).filter((trade) => trade.tradeSource === "strategy");
  for (const trade of liveStrategyRows) {
    addStage(trade.strategyName, "live_trading", "observed", `${trade.accountType || "Account"} trade activity imported`, "sierra");
  }
  return [...strategies.values()].map((item) => ({
    ...item,
    stages: item.stages.filter((stage, index, stages) =>
      stages.findIndex((candidate) => candidate.stage === stage.stage && candidate.status === stage.status) === index,
    ),
  }));
}

function buildSourceAudit(manifestDraft, paperclipNative) {
  const knownSourceFiles = manifestDraft.sourceFiles || [];
  const records = knownSourceFiles.map((file) => sourceRecord(file));
  const known = new Set(knownSourceFiles.map((file) => path.normalize(String(file)).toLowerCase()));
  const missingPaperclipArtifacts = [];
  const reportsWithoutArtifacts = [];
  for (const report of paperclipNative.reports || []) {
    const artifacts = report.artifactPaths || [];
    if (!artifacts.length) {
      reportsWithoutArtifacts.push(report);
      continue;
    }
    for (const artifact of artifacts) {
      const normalized = path.normalize(String(artifact)).toLowerCase();
      if (!known.has(normalized)) {
        missingPaperclipArtifacts.push({
          reportId: report.id,
          identifier: report.identifier,
          reportTitle: report.title,
          reportType: report.type,
          path: artifact,
          exists: fs.existsSync(artifact),
        });
      }
    }
  }
  const counts = records.reduce((acc, record) => {
    acc[record.sourceSystem] = (acc[record.sourceSystem] || 0) + 1;
    return acc;
  }, {});
  return {
    summary: {
      totalSourceFiles: records.length,
      bySourceSystem: counts,
      staleSourceFiles: records.filter((record) => record.stale).length,
      paperclipIssues: paperclipNative.issueCount || 0,
      paperclipReports: paperclipNative.reportCount || 0,
      paperclipBacktestRequests: paperclipNative.backtestRequestCount || 0,
      reportsWithoutArtifacts: reportsWithoutArtifacts.length,
      untrackedPaperclipArtifacts: missingPaperclipArtifacts.length,
    },
    records,
    reportsWithoutArtifacts,
    untrackedPaperclipArtifacts: missingPaperclipArtifacts,
    contract: [
      "Paperclip is the source of truth for research, strategy decisions, backtest requests, backtest summaries, optimization status, reports, blockers, and agent activity.",
      "Sierra Chart is the source of truth for trade fills, open positions, closed trades, symbols, accounts, execution P&L, and live/paper monitoring.",
      "Local strategy files are implementation artifacts only; they should not override Paperclip decisions or Sierra trade records.",
    ],
  };
}

function summarizeReplayArtifact(filePath) {
  const json = readJson(filePath, null);
  if (!json || typeof json !== "object") return null;

  const artifact = {
    title: basename(filePath).replace(/\.json$/i, ""),
    sourceFile: filePath,
    generatedAtUtc: firstPresent(json.generatedAtUtc, json.generated_utc),
    strategy: firstPresent(json.strategy, json.strategyLabel, json.strategy_module ? basename(json.strategy_module) : null),
    sessionOrPurpose: firstPresent(json.session, json.purpose, json.scenario, json.note),
    expectedCount: null,
    replayCount: null,
    backtestCount: null,
    matchedCount: null,
    exactCount: null,
    mismatchCount: null,
    replayNetPnl: null,
    backtestNetPnl: null,
    status: "observed",
    fixesApplied: Array.isArray(json.fixesApplied) ? json.fixesApplied : Array.isArray(json.fix_summary) ? json.fix_summary : [],
    gaps: Array.isArray(json.remainingGaps) ? json.remainingGaps : [],
    note: firstPresent(json.note, json.assumptions?.note),
  };

  if (json.summary || json.artifactType === "ocean_trading.replay_backtest_validation") {
    const summary = json.summary || {};
    artifact.replayCount = firstPresent(summary.replayCount, Array.isArray(json.replayEvents) ? json.replayEvents.length : null);
    artifact.backtestCount = firstPresent(summary.backtestCount, Array.isArray(json.backtestTrades) ? json.backtestTrades.length : null);
    artifact.matchedCount = firstPresent(summary.matchedCount, Array.isArray(json.comparisons) ? json.comparisons.length : null);
    artifact.exactCount = firstPresent(
      summary.exactCount,
      Array.isArray(json.comparisons) ? json.comparisons.filter((item) => item?.status === "exact").length : null,
    );
    artifact.mismatchCount = firstPresent(
      summary.mismatchCount,
      Array.isArray(json.comparisons) ? json.comparisons.filter((item) => item?.status === "mismatch").length : null,
    );
    artifact.expectedCount = firstPresent(summary.backtestCount, artifact.backtestCount, artifact.replayCount);
    artifact.replayNetPnl = Array.isArray(json.replayEvents)
      ? Number(json.replayEvents.reduce((sum, item) => sum + (Number(item?.outcome?.pnl) || 0), 0).toFixed(2))
      : null;
    artifact.backtestNetPnl = Array.isArray(json.backtestTrades)
      ? Number(json.backtestTrades.reduce((sum, item) => sum + (Number(item?.outcome?.pnl) || 0), 0).toFixed(2))
      : null;
  } else if (
    typeof json.matched_count === "number"
    || typeof json.expected_count === "number"
    || Array.isArray(json.sierra_expected_entries)
  ) {
    artifact.expectedCount = firstPresent(json.expected_count, Array.isArray(json.sierra_expected_entries) ? json.sierra_expected_entries.length : null);
    artifact.replayCount = firstPresent(json.python_count, Array.isArray(json.python_backtest_entries) ? json.python_backtest_entries.length : null);
    artifact.backtestCount = artifact.replayCount;
    artifact.matchedCount = firstPresent(json.matched_count, Array.isArray(json.exact_time_matches) ? json.exact_time_matches.length : null);
    artifact.exactCount = Array.isArray(json.exact_time_matches) ? json.exact_time_matches.length : null;
    artifact.mismatchCount = (Array.isArray(json.missing_from_python) ? json.missing_from_python.length : 0)
      + (Array.isArray(json.extra_in_python) ? json.extra_in_python.length : 0);
    artifact.backtestNetPnl = Array.isArray(json.python_backtest_entries)
      ? Number(json.python_backtest_entries.reduce((sum, item) => sum + (Number(item?.pnl) || 0), 0).toFixed(2))
      : null;
  } else if (json.entryTimeMatch || json.paperSummary || json.replayParityBacktestSummary) {
    const timeMatch = json.entryTimeMatch || {};
    artifact.expectedCount = firstPresent(timeMatch.totalMarkers, Array.isArray(json.paperTrades) ? json.paperTrades.length : null);
    artifact.replayCount = firstPresent(json.paperSummary?.trades, Array.isArray(json.paperTrades) ? json.paperTrades.length : null);
    artifact.backtestCount = firstPresent(
      json.replayParityBacktestSummary?.trades,
      json.continuousBacktestSummary?.trades,
      Array.isArray(json.replayParityBacktestTrades) ? json.replayParityBacktestTrades.length : null,
    );
    artifact.matchedCount = timeMatch.exactMatches ?? null;
    artifact.exactCount = timeMatch.exactMatches ?? null;
    artifact.mismatchCount = artifact.expectedCount !== null && artifact.exactCount !== null
      ? Math.max(artifact.expectedCount - artifact.exactCount, 0)
      : null;
    artifact.replayNetPnl = firstPresent(json.paperSummary?.netPnl, Array.isArray(json.paperTrades)
      ? json.paperTrades.reduce((sum, item) => sum + (Number(item?.pnl) || 0), 0)
      : null);
    artifact.backtestNetPnl = firstPresent(
      json.replayParityBacktestSummary?.netPnl,
      json.continuousBacktestSummary?.netPnl,
      Array.isArray(json.replayParityBacktestTrades)
        ? json.replayParityBacktestTrades.reduce((sum, item) => sum + (Number(item?.pnl) || 0), 0)
        : null,
    );
  } else {
    return null;
  }

  const mismatchCount = Number(artifact.mismatchCount);
  if (Number.isFinite(mismatchCount) && mismatchCount > 0) {
    artifact.status = "mismatch";
  } else if (
    artifact.expectedCount !== null
    && artifact.exactCount !== null
    && Number(artifact.expectedCount) === Number(artifact.exactCount)
  ) {
    artifact.status = "aligned";
  } else if (artifact.matchedCount !== null || artifact.replayCount !== null || artifact.backtestCount !== null) {
    artifact.status = "partial";
  }

  return artifact;
}

function buildReplayMonitor() {
  const contractFile = path.join(BACKTEST_DIR, "replay-vs-backtest-validation-contract.md");
  const monitorState = readJson(DASHBOARD_MONITOR_STATE_FILE, { running: false, status: "unknown" });
  const replaySession = buildReplaySessionState();
  const artifacts = listFiles(BACKTEST_DIR, (entry) => /replay/i.test(entry.name) && /\.json$/i.test(entry.name))
    .map((entry) => summarizeReplayArtifact(entry.absPath))
    .filter(Boolean)
    .sort((a, b) => {
      const left = Date.parse(a.generatedAtUtc || "") || fs.statSync(a.sourceFile).mtimeMs;
      const right = Date.parse(b.generatedAtUtc || "") || fs.statSync(b.sourceFile).mtimeMs;
      return right - left;
    })
    .slice(0, 8);
  return {
    monitorState,
    currentSession: replaySession.currentSession,
    persistedState: replaySession.persistedState,
    latestArtifact: artifacts[0] || null,
    artifacts,
    contractFile,
    sourceFiles: [
      DASHBOARD_MONITOR_STATE_FILE,
      ...(replaySession.sourceFiles || []),
      contractFile,
      ...artifacts.map((artifact) => artifact.sourceFile),
    ].filter(Boolean).filter((file, index, files) => files.indexOf(file) === index),
  };
}

function buildDashboardManifest() {
  const ledger = parseLedger();
  const daily = parseDailyReport();
  const researchRuns = pickLatestResearchRuns();
  const strategyCatalog = [
    ...parseSierraStudyCatalog(),
    ...parseCachedBacktestStrategyCatalog(),
  ];
  const paperTrading = parsePaperTradingPlan();
  const liveTrading = buildLiveTradingPlan();
  const paperclipNative = buildPaperclipNativeSync();
  const regimeEngine = buildRegimeEngine();
  const propFirms = buildPropFirmConfig(liveTrading, paperTrading);
  const lucidRules = buildLucidFlexRules();
  writeLucidRulesArtifact(lucidRules);
  const replayMonitor = buildReplayMonitor();
  const researchHistory = buildResearchHistory();
  const researchFinds = buildResearchFinds();
  const backtestCoverage = buildBacktestCoverage(researchFinds);
  const paperSummaryFile = findLatestByPattern(OCEAN_TRADING_DIR, /^oce-23_backtest_report_.*\.md$/i);
  const strategyBatchFile = findLatestByPattern(OCEAN_TRADING_DIR, /^oce-22_strategy_batch_handoff_.*\.md$/i);
  const metricsBacktest = parseBacktestJson(findLatestByPattern(OCEAN_TRADING_DIR, /^oce-23_backtest_results_.*\.json$/i));
  const parsedBacktest = parseMetricsFromBacktestResult(metricsBacktest);
  const activePaperMetrics = paperTrading.strategies.map((strategy) => addDataSource({
    strategy: strategy.name,
    trades: strategy.trades,
    wins: strategy.winRate && strategy.trades ? Math.round(strategy.winRate * strategy.trades) : null,
    losses: strategy.winRate && strategy.trades ? strategy.trades - Math.round(strategy.winRate * strategy.trades) : null,
    longTrades: strategy.longTrades,
    shortTrades: strategy.shortTrades,
    netProfitDollars: strategy.netProfitDollars,
    winRate: strategy.winRate,
    profitFactor: strategy.profitFactor,
    maxDrawdownDollars: strategy.maxDrawdownDollars,
    status: strategy.status,
    decision: strategy.decision,
    sourceFile: strategy.backtestReport || strategy.sourceFile,
  }, "paperclip", "Paperclip-approved strategy record with metrics from Sierra backtest artifact"));
  const performance = buildPerformanceGroups({
    ledger,
    daily,
    paperTrading,
    liveTrading,
    activePaperMetrics,
    parsedBacktest,
  });
  performance.backtesting.candidateRows = latestBacktestCandidateRows(activePaperMetrics);

  const strategyLifecycle = buildStrategyLifecycle({ researchFinds, backtestCoverage, paperTrading, liveTrading, strategyCatalog });
  const manifest = {
    generatedAtUtc: new Date().toISOString(),
    database: {
      sqliteFile: SQLITE_FILE,
      persistence: "dashboard manifest, Sierra trade fills, closed trades, performance, research, reports, strategy catalog, source files, and uploads are persisted to SQLite on each manifest rebuild.",
    },
    sourceFiles: [
      ...(ledger.sourceFiles || []),
      ...(daily.sourceFiles || []),
      ...(paperTrading.sourceFiles || []),
      paperTrading.dataHygiene?.artifactPath,
      ...(liveTrading.sourceFiles || []),
      LUCID_RULES_ARTIFACT,
      PROP_FIRM_RULE_SETS_FILE,
      PROP_FIRM_ACCOUNTS_FILE,
      ...(researchRuns.flatMap((r) => r.provenance.sourceFiles)),
      ...(researchHistory.flatMap((r) => r.sourceFiles)),
      ...(researchFinds.flatMap((r) => r.sourceFiles)),
      ...(backtestCoverage.flatMap((r) => r.sourceFiles)),
      PAPERCLIP_SYNC_FILE,
      ...(paperclipNative.artifactPaths || []),
      ...(paperclipNative.reports || []).flatMap((report) => report.artifactPaths || []),
      ...(regimeEngine.sourceFiles || []),
      ...(replayMonitor.sourceFiles || []),
      ...(strategyCatalog.map((s) => s.sourceFile)),
      ...(paperSummaryFile ? [paperSummaryFile] : []),
      ...(strategyBatchFile ? [strategyBatchFile] : []),
    ].filter(Boolean).filter((file, index, files) => files.indexOf(file) === index),
    tradingModes: {
      paper: paperTrading,
      live: liveTrading,
    },
    riskProfiles: {
      lucidFlex50k: {
        ...lucidRules,
        artifactPath: LUCID_RULES_ARTIFACT,
      },
    },
    propFirms,
    strategyCatalog,
    strategyLifecycle,
    ledger,
    ledgers: {
      paper: ledger,
      live: {
        sourceFiles: liveTrading.sourceFiles,
        latestLedger: null,
        status: liveTrading.status,
        message: liveTrading.summary,
      },
    },
    performance,
    regimeEngine,
    replayMonitor,
    dailyReport: {
      ...(daily.latestDaily || {}),
      paperclipReports: paperclipNative.reports || [],
    },
    paperclipNative,
    researchRuns,
    researchHistory,
    researchFinds,
    backtestCoverage,
    perStrategyMetrics: activePaperMetrics.length ? activePaperMetrics : parsedBacktest.metrics,
    backtestCandidateMetrics: parsedBacktest.metrics,
    note: "Local dashboard contract from Ocean Trading Sierra markdown/json artifacts.",
  };
  manifest.dataSources = buildSourceAudit(manifest, paperclipNative);

  writeJsonAtomic(OUTPUT_FILE, manifest);
  persistManifestToSqlite();
  return manifest;
}

function persistManifestToSqlite() {
  if (!fs.existsSync(SQLITE_PERSIST_SCRIPT)) {
    console.warn(`SQLite persist script missing: ${SQLITE_PERSIST_SCRIPT}`);
    return;
  }
  if (!fs.existsSync(PYTHON_EXECUTABLE)) {
    console.warn(`SQLite persistence skipped because Python was not found: ${PYTHON_EXECUTABLE}`);
    return;
  }
  fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
  execFileSync(PYTHON_EXECUTABLE, [SQLITE_PERSIST_SCRIPT, OUTPUT_FILE, SQLITE_FILE], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 30000,
    windowsHide: true,
  });
}

const manifest = await withManifestBuildLock(path.join(ROOT, "dashboard", "data", "manifest-build.lock"), buildDashboardManifest);
console.log(`Generated dashboard manifest -> ${OUTPUT_FILE}`);
console.log(`Ledger file: ${manifest.ledger.sourceFiles[0] || "missing"}`);
console.log(`Daily file: ${manifest.dailyReport?.path || "missing"}`);
console.log(`Research runs tracked: ${manifest.researchRuns.length}`);
