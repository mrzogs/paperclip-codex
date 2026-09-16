import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { clearReplayAccount } from "./replay-session-scope.mjs";
import { workflowFromEnvironment } from "./workflow/backend.mjs";
import { installWebsiteControl } from "./workflow/process-control.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_DIR = path.dirname(__dirname);
const UPLOAD_DIR = path.join(__dirname, "uploads");
const SQLITE_FILE = process.env.OCEAN_WEBSITE_DB || "D:\\OceanTradingData\\website\\ocean-trading-website.sqlite";
const SQLITE_QUERY_SCRIPT = path.join(__dirname, "query-sqlite.py");
const MONITOR_STATE_FILE = path.join(__dirname, "data", "monitor-state.json");
const REPLAY_MONITOR_STATE_FILE = path.join(__dirname, "data", "replay-monitor-state.json");
const REPLAY_MONITOR_CLEARS_FILE = path.join(__dirname, "data", "replay-monitor-clears.json");
const MONITOR_SCRIPT = path.join(__dirname, "monitor.mjs");
const PATRADING_LIVE_SQLITE_FILE =
  process.env.PATRADING_LIVE_SQLITE_FILE ||
  "E:\\SierraChart-LiveTrading\\Data\\TradeTelemetry\\Live\\TradeTelemetry_Live.sqlite";
const PATRADING_PAPER_SQLITE_FILE =
  process.env.PATRADING_PAPER_SQLITE_FILE ||
  "D:\\Trading\\SierraChart-PaperTrading\\Data\\TradeTelemetry\\PaperTrading\\TradeTelemetry_PaperTrading.sqlite";
const PROP_FIRM_ACCOUNTS_FILE = path.join(__dirname, "data", "prop-firm-accounts.json");
const BACKTEST_REQUESTS_FILE = path.join(__dirname, "data", "backtest-requests.json");
const PAPERCLIP_SYNC_FILE = path.join(__dirname, "data", "paperclip-sync.json");
const CEO_CHAT_STATE_FILE = path.join(__dirname, "data", "ceo-chat-state.json");
const SIERRA_SYMBOL_CONFIG_FILE = path.join(__dirname, "config", "sierra-symbols.json");
const INSTRUMENT_CONTRACTS_FILE = path.join(__dirname, "config", "instrument-contracts.json");
const STRATEGY_TEMPLATE_FILE = path.join(__dirname, "config", "strategy-template.json");
const VWAP_PAPER_SIM1_EMAIL_CONFIG_FILE = path.join(__dirname, "config", "vwap-paper-sim1-email-alerts.json");
const CME_HOLIDAY_CALENDAR_FILE = path.join(__dirname, "config", "cme-holiday-calendar.merged.json");
const BACKTEST_CACHE_SCRIPT = path.join(ROOT_DIR, "backtesting", "cache_platform.py");
const REGIME_ENGINE_SCRIPT = path.join(ROOT_DIR, "backtesting", "regime_engine.py");
const AGGREGATE_TIMEFRAMES_SCRIPT = path.join(ROOT_DIR, "backtesting", "aggregate_timeframes.py");
const BACKTEST_CACHE_DB = process.env.OCEAN_HISTORICAL_DB || "D:\\OceanTradingData\\market\\sierra-historical.sqlite";
const PAPERCLIP_REPO_DIR = process.env.PAPERCLIP_REPO_DIR || "D:\\Paperclip-codex";
const CONFLUENCE_REPORT_DIR = path.join(PAPERCLIP_REPO_DIR, "reports", "confluence_strategy_paper");
const CONFLUENCE_PREDICTION_REPORT_FILE = path.join(CONFLUENCE_REPORT_DIR, "requested_timeframes_prediction_report.json");
const CONFLUENCE_WALK_FORWARD_FILE = path.join(CONFLUENCE_REPORT_DIR, "walk_forward_w19_predict_w20_combo_study_clean.json");
const CONFLUENCE_HISTORY_FILE = path.join(CONFLUENCE_REPORT_DIR, "confluence_forecast_history.json");
const CONFLUENCE_FORECAST_ACCURACY_FILE = path.join(CONFLUENCE_REPORT_DIR, "confluence_forecast_accuracy.json");
const CONFLUENCE_SESSION_LEARNER_FILE = path.join(CONFLUENCE_REPORT_DIR, "confluence_session_accuracy_learner.json");
const CONFLUENCE_SCOPE_FILE = path.join(__dirname, "config", "confluence-scope.json");
const CONFLUENCE_ASOF_SCRIPT = path.join(PAPERCLIP_REPO_DIR, "scripts", "build_confluence_asof_report.py");
const CONFLUENCE_SCID_IMPORT_SCRIPT = path.join(PAPERCLIP_REPO_DIR, "scripts", "market_data", "import_sierra_replay_scid.py");
const CONFLUENCE_LIVE_ROOT = process.env.OCEAN_CONFLUENCE_LIVE_ROOT || "E:\\SierraChart-LiveTrading";
const CONFLUENCE_LIVE_DATA_DIR = process.env.OCEAN_CONFLUENCE_LIVE_DATA_DIR || path.join(CONFLUENCE_LIVE_ROOT, "Data");
const CONFLUENCE_ROOT_SYMBOL = process.env.OCEAN_CONFLUENCE_ROOT_SYMBOL || "MNQ";
const CONFLUENCE_SYMBOL = process.env.OCEAN_CONFLUENCE_SYMBOL || null;
const CONFLUENCE_CONTRACT_CACHE_FILE = path.join(__dirname, "data", "cme-mnq-contracts.json");
const CONFLUENCE_IMPORT_PYTHON = process.env.OCEAN_CONFLUENCE_IMPORT_PYTHON || "C:\\Users\\wayne\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const CONFLUENCE_YESTERDAY_FORECAST_FILE = path.join(CONFLUENCE_REPORT_DIR, "yesterday_forecast_for_today.json");
const CONFLUENCE_ACCURACY_WORKER = path.join(__dirname, "confluence-accuracy.mjs");
const CONFLUENCE_ALLOWED_COVERAGE_MINUTES = new Set([1, 5, 15, 60, 1440]);
const CONFLUENCE_ALLOWED_ROW_TIMEFRAMES = new Set(["5m", "15m", "60m", "daily", "weekly"]);
const REGIME_TIMEFRAMES = [
  { label: "Daily", minutes: 1440 },
  { label: "Hourly", minutes: 60 },
  { label: "15-minute", minutes: 15 },
  { label: "5-minute", minutes: 5 },
];
const MARKOV_SESSIONS = [
  { label: "Asian", startMinute: 0, endMinute: 8 * 60 },
  { label: "London", startMinute: 8 * 60, endMinute: 13 * 60 + 30 },
  { label: "US", startMinute: 13 * 60 + 30, endMinute: 21 * 60 },
];
const PYTHON_EXE =
  process.env.OCEAN_TRADING_PYTHON ||
  process.env.PYTHON ||
  path.join(process.env.LOCALAPPDATA || "C:\\Users\\wayne\\AppData\\Local", "Programs", "Python", "Python312", "python.exe");
const PORT = Number(process.env.DASHBOARD_PORT || 3102);
let workflowBackend = null;
let workflowStartupFailed = false;
let workflowEnrollmentRequired = false;
try {
  workflowBackend = workflowFromEnvironment(process.env, PYTHON_EXE);
} catch (error) {
  workflowStartupFailed = true;
  workflowEnrollmentRequired = error.code === 'WAYNE_LOCAL_ENROLLMENT_REQUIRED';
}
const PAPERCLIP_API = process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api";
const PAPERCLIP_WEB_BASE_URL = resolvePaperclipWebBaseUrl();
const PAPERCLIP_SYNC_TTL_MS = Number(process.env.PAPERCLIP_SYNC_TTL_MS || 300_000);
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "17102cf9-5b22-4347-ae14-74ffc15f35cc";
const PROJECT_ID = process.env.PAPERCLIP_PROJECT_ID || "";
const HERMES_MARKOV_PROJECT_ID = process.env.HERMES_MARKOV_PROJECT_ID || PROJECT_ID;
const HERMES_MARKOV_OWNER_AGENT_ID = process.env.HERMES_MARKOV_OWNER_AGENT_ID || "cde12a42-5d9b-4054-abde-b2f52fd76ff2";
const HERMES_MARKOV_STAGE_STATUS_FILE = path.join(PAPERCLIP_REPO_DIR, "state", "stage_status.json");
const HERMES_MARKOV_REPORT_DATA_DIR = path.join(PAPERCLIP_REPO_DIR, "reports", "data");
const HERMES_MARKOV_S5_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-s5");
const HERMES_MARKOV_S6_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-s6");
const HERMES_MARKOV_S8_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-s8");
const HERMES_MARKOV_S9_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-s9");
const HERMES_MARKOV_S12_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-s12");
const HERMES_MARKOV_WORKFLOW_B_DIR = path.join(HERMES_MARKOV_REPORT_DATA_DIR, "hermes-markov-hmm-workflow-b");
const BACKTESTER_AGENT_ID = process.env.STRATEGY_BUILDER_AGENT_ID || "f8f58820-0594-470b-ae50-2b6fc9cca35b";
const CEO_AGENT_ID = process.env.CEO_AGENT_ID || "957251c9-a5ff-4337-9c45-2ccc833ed9b4";
const CEO_CHAT_TITLE = "Ocean Trading CEO Chat Terminal v2";
let monitorProcess = null;
let lastPaperclipSyncAt = 0;
let cachedManifestPayload = null;
let cachedManifestSignature = null;
const hmmStatusOnlySuppressionCache = new Set();

function resolvePaperclipWebBaseUrl() {
  const configured = process.env.PAPERCLIP_WEB_BASE_URL || process.env.PAPERCLIP_UI_URL || process.env.PAPERCLIP_BASE_URL;
  const source = configured || PAPERCLIP_API;
  try {
    const url = new URL(source);
    url.pathname = url.pathname.replace(/\/api\/?$/i, "").replace(/\/+$/g, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/g, "");
  } catch {
    return "http://127.0.0.1:3100";
  }
}

function paperclipWebUrl(pathname = "") {
  const suffix = String(pathname || "").replace(/^\/+/, "");
  return suffix ? `${PAPERCLIP_WEB_BASE_URL}/${suffix}` : PAPERCLIP_WEB_BASE_URL;
}

function optionalProject(projectId) {
  return projectId ? { projectId } : {};
}

function companyIssuesPath({ limit = 100, projectId = "" } = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (projectId) params.set("projectId", projectId);
  return `/companies/${COMPANY_ID}/issues${params.size ? `?${params}` : ""}`;
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function isTradeActivityLogName(name) {
  return /^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(name);
}

function listWatchedTradeLogs(dir, mode) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isTradeActivityLogName(entry.name))
    .filter((entry) => {
      if (mode === "paper") return /\.Sim[1-5](\.simulated)?\.data$/i.test(entry.name);
      if (mode === "replay") return /\.Sim\d+\.simulated\.data$/i.test(entry.name);
      return !/Sim1|simulated|\.None\.data$/i.test(entry.name);
    })
    .map((entry) => path.join(dir, entry.name));
}

function isVolatileManifestInput(filePath) {
  if (!filePath) return false;
  return path.resolve(filePath).toLowerCase() === path.resolve(MONITOR_STATE_FILE).toLowerCase();
}

function sqliteInputFiles(filePath) {
  if (!filePath) return [];
  return [filePath, `${filePath}-wal`, `${filePath}-shm`];
}

function manifestInputFiles(manifestPath) {
  const files = new Set([
    SIERRA_SYMBOL_CONFIG_FILE,
    INSTRUMENT_CONTRACTS_FILE,
    STRATEGY_TEMPLATE_FILE,
    CME_HOLIDAY_CALENDAR_FILE,
    PROP_FIRM_ACCOUNTS_FILE,
    BACKTEST_REQUESTS_FILE,
    PAPERCLIP_SYNC_FILE,
    REPLAY_MONITOR_STATE_FILE,
    REPLAY_MONITOR_CLEARS_FILE,
  ]);
  try {
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const source of existing.sourceFiles || []) {
      if (!isVolatileManifestInput(source)) files.add(source);
    }
  } catch {
    // A missing or partially-written manifest will be rebuilt below.
  }
  const sierraConfig = readSierraSymbolConfig();
  const liveLogDir = sierraConfig.live?.tradeActivityLogDir || path.join(sierraConfig.live?.root || "E:\\SierraChart-LiveTrading", "TradeActivityLogs");
  const paperLogDir = sierraConfig.paper?.tradeActivityLogDir || path.join(sierraConfig.paper?.root || "D:\\Trading\\SierraChart-PaperTrading", "TradeActivityLogs");
  const replayLogDir = sierraConfig.replay?.tradeActivityLogDir || path.join(sierraConfig.replay?.root || "D:\\Trading\\SierraChart-Replay", "TradeActivityLogs");
  for (const file of sqliteInputFiles(sierraConfig.live?.patradingSqliteFile || PATRADING_LIVE_SQLITE_FILE)) files.add(file);
  for (const file of sqliteInputFiles(sierraConfig.paper?.patradingSqliteFile || PATRADING_PAPER_SQLITE_FILE)) files.add(file);
  for (const file of sqliteInputFiles(sierraConfig.replay?.patradingSqliteFile || path.join(sierraConfig.replay?.root || "D:\\Trading\\SierraChart-Replay", "Data", "TradeTelemetry", "Replay", "TradeTelemetry_Replay.sqlite"))) files.add(file);
  for (const file of listWatchedTradeLogs(liveLogDir, "live")) files.add(file);
  for (const file of listWatchedTradeLogs(paperLogDir, "paper")) files.add(file);
  for (const file of listWatchedTradeLogs(replayLogDir, "replay")) files.add(file);
  return [...files].filter(Boolean).filter((file) => !isVolatileManifestInput(file));
}

function shouldRebuildManifest(manifestPath) {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(SQLITE_FILE)) return true;
  const manifestMtime = fileMtimeMs(manifestPath);
  return manifestInputFiles(manifestPath).some((file) => fileMtimeMs(file) > manifestMtime + 1);
}

function readLatestManifestSnapshot() {
  if (!fs.existsSync(SQLITE_FILE) || !fs.existsSync(SQLITE_QUERY_SCRIPT)) return null;
  const signature = `${fileMtimeMs(SQLITE_FILE)}:${fileMtimeMs(path.join(ROOT_DIR, "dashboard", "dashboard-data.json"))}`;
  if (cachedManifestPayload && cachedManifestSignature === signature) return cachedManifestPayload;
  try {
    const payload = execFileSync(PYTHON_EXE, [SQLITE_QUERY_SCRIPT, SQLITE_FILE, "latest-manifest"], {
      cwd: __dirname,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
    });
    cachedManifestPayload = payload;
    cachedManifestSignature = signature;
    return payload;
  } catch {
    return null;
  }
}

function writeReplayMonitorClears(payload) {
  fs.mkdirSync(path.dirname(REPLAY_MONITOR_CLEARS_FILE), { recursive: true });
  const tempPath = `${REPLAY_MONITOR_CLEARS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, REPLAY_MONITOR_CLEARS_FILE);
}

function normalizeReplayAccountId(value) {
  const text = String(value || "").trim();
  const match = text.match(/^sim\s*(\d+)$/i);
  return match ? `Sim${match[1]}` : text || "Sim1";
}

async function clearReplayMonitorSession(accountId = null) {
  await rebuildManifestAsync();
  const manifest = JSON.parse(buildManifest({ skipRebuildCheck: true, preferFile: true }));
  const requestedAccountId = normalizeReplayAccountId(accountId || manifest?.replayMonitor?.currentSession?.defaultReplayAccountId || "Sim1");
  if (!/^Sim\d+$/.test(requestedAccountId)) throw new Error("A simulation account is required.");
  const existing = fs.existsSync(REPLAY_MONITOR_CLEARS_FILE)
    ? JSON.parse(fs.readFileSync(REPLAY_MONITOR_CLEARS_FILE, "utf8")) : { accounts: {} };
  const currentSessionId = manifest?.replayMonitor?.currentSession?.sessionId || null;
  const clearedAtUtc = new Date().toISOString();
  const trades = manifest?.replayMonitor?.currentSession?.groupedTrades || [];
  writeReplayMonitorClears(clearReplayAccount(existing, requestedAccountId, trades, clearedAtUtc));
  await rebuildManifestAsync();
  const refreshed = JSON.parse(buildManifest({ skipRebuildCheck: true, preferFile: true }));
  return {
    ok: true,
    clearedReplayAccountId: requestedAccountId,
    clearedSessionId: currentSessionId,
    clearedAtUtc,
    replaySession: refreshed?.replayMonitor?.currentSession || null,
  };
}

function rebuildManifestAsync() {
  // Builder processes share a lock, including monitor-triggered publications.
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, "build-manifest.mjs")], {
      cwd: __dirname, windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    }, (error, output) => {
      cachedManifestPayload = null;
      cachedManifestSignature = null;
      if (error) reject(error);
      else resolve(output);
    });
  });
}

function buildManifest(options = {}) {
  const manifestPath = path.join(ROOT_DIR, "dashboard", "dashboard-data.json");
  const needsRebuild = !options.skipRebuildCheck && (options.forceRebuild || shouldRebuildManifest(manifestPath));
  if (needsRebuild) {
    const builderPath = path.join(ROOT_DIR, "dashboard", "build-manifest.mjs");
    execFileSync(process.execPath, [builderPath], {
      stdio: "inherit",
      cwd: ROOT_DIR,
      encoding: "utf8",
      timeout: 90000,
      windowsHide: true,
    });
    cachedManifestPayload = null;
    cachedManifestSignature = null;
  }
  if (options.preferFile === true) return fs.readFileSync(manifestPath, "utf8");
  const snapshotPayload = readLatestManifestSnapshot();
  if (snapshotPayload) return snapshotPayload;
  return fs.readFileSync(manifestPath, "utf8");
}

async function buildManifestWithPaperclipSync(options = {}) {
  let paperclipSyncWarning = null;
  try {
    await syncPaperclipNative({ force: options.forcePaperclipSync === true });
  } catch (error) {
    paperclipSyncWarning = String(error?.message || error);
    console.warn(`Paperclip native sync skipped: ${paperclipSyncWarning}`);
  }

  const manifest = JSON.parse(buildManifest({ forceRebuild: options.rebuild === true }));
  if (paperclipSyncWarning) {
    manifest.paperclipSyncWarning = paperclipSyncWarning;
    manifest.dataFreshness = {
      ...(manifest.dataFreshness || {}),
      paperclipSyncWarning,
    };
  }
  return JSON.stringify(manifest);
}

function databaseInfo() {
  if (fs.existsSync(SQLITE_QUERY_SCRIPT) && fs.existsSync(SQLITE_FILE)) {
    try {
      return JSON.parse(execFileSync(PYTHON_EXE, [SQLITE_QUERY_SCRIPT, SQLITE_FILE, "database-summary"], {
        cwd: __dirname,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      // Fall back to file-level information below.
    }
  }
  const exists = fs.existsSync(SQLITE_FILE);
  const stat = exists ? fs.statSync(SQLITE_FILE) : null;
  return {
    sqliteFile: SQLITE_FILE,
    exists,
    sizeBytes: stat?.size || 0,
    updatedAtUtc: stat ? stat.mtime.toISOString() : null,
    tables: [
      "manifest_snapshots",
      "source_files",
      "strategy_catalog",
      "performance_rows",
      "closed_trades",
      "trade_fills",
      "research_finds",
      "research_runs",
      "daily_reports",
      "uploaded_artifacts",
      "open_positions",
      "monitor_events",
      "paperclip_native_issues",
      "paperclip_native_reports",
      "strategy_lifecycle",
      "source_audit",
    ],
  };
}

function dashboardCalendarFreshnessInfo(mode = "paper") {
  const normalizedMode = mode === "live" ? "live" : "paper";
  const manifest = JSON.parse(buildManifest({ skipRebuildCheck: true, preferFile: true }));
  const tradingMode = manifest?.tradingModes?.[normalizedMode] || {};
  const trades = Array.isArray(tradingMode.performanceClosedTrades) ? tradingMode.performanceClosedTrades : [];
  const latestTrade = trades
    .map((trade) => ({
      account: trade?.account || null,
      exitAtUtc: trade?.exitAtUtc || trade?.tradeDateUtc || trade?.entryAtUtc || null,
      realizedPnlDollars: Number.isFinite(Number(trade?.realizedPnlDollars)) ? Number(trade.realizedPnlDollars) : null,
      sourceFile: trade?.sourceFile || null,
    }))
    .filter((trade) => trade.exitAtUtc)
    .sort((a, b) => String(b.exitAtUtc).localeCompare(String(a.exitAtUtc)))[0] || null;
  const dashboardDataFile = path.join(ROOT_DIR, "dashboard", "dashboard-data.json");
  const dashboardStat = fs.existsSync(dashboardDataFile) ? fs.statSync(dashboardDataFile) : null;
  const sourceFiles = Array.isArray(tradingMode.sourceFiles) ? tradingMode.sourceFiles : [];
  const latestSourceMtimeMs = sourceFiles.reduce((latest, filePath) => Math.max(latest, fileMtimeMs(filePath)), 0);
  const sierraConfig = readSierraSymbolConfig();
  const telemetrySqliteFile = sierraConfig?.[normalizedMode]?.patradingSqliteFile
    || (normalizedMode === "live" ? PATRADING_LIVE_SQLITE_FILE : PATRADING_PAPER_SQLITE_FILE);
  const latestTelemetryMtimeMs = sqliteInputFiles(telemetrySqliteFile)
    .reduce((latest, filePath) => Math.max(latest, fileMtimeMs(filePath)), 0);
  const latestSnapshot = Array.isArray(tradingMode.accountSnapshots)
    ? tradingMode.accountSnapshots[0] || null
    : null;
  const signature = [
    manifest.generatedAtUtc || "",
    trades.length,
    latestTrade?.exitAtUtc || "",
    latestTrade?.realizedPnlDollars ?? "",
    Math.round(latestSourceMtimeMs),
    Math.round(latestTelemetryMtimeMs),
    latestSnapshot?.accountSnapshotId || "",
    latestSnapshot?.accountValueDollars ?? "",
    Math.round(dashboardStat?.mtimeMs || 0),
  ].join("|");
  return {
    ok: true,
    mode: normalizedMode,
    generatedAtUtc: new Date().toISOString(),
    manifestGeneratedAtUtc: manifest.generatedAtUtc || null,
    dashboardDataUpdatedAtUtc: dashboardStat ? dashboardStat.mtime.toISOString() : null,
    tradeCount: trades.length,
    latestTrade,
    latestSourceUpdatedAtUtc: Math.max(latestSourceMtimeMs, latestTelemetryMtimeMs)
      ? new Date(Math.max(latestSourceMtimeMs, latestTelemetryMtimeMs)).toISOString()
      : null,
    latestAccountSnapshot: latestSnapshot,
    monitor: monitorState(),
    signature,
  };
}

function readSierraSymbolConfig() {
  const fallback = {
    paper: {
      symbol: "MNQM26_FUT_CME",
      displaySymbol: "MNQM26_FUT_CME[M]",
      dataFile: "D:\\Trading\\SierraChart-PaperTrading\\Data\\MNQM26_FUT_CME.scid",
      account: "Sim1",
      dataPort: 11298,
      tradingPort: 11299,
    },
  };
  if (!fs.existsSync(SIERRA_SYMBOL_CONFIG_FILE)) return fallback;
  const configured = JSON.parse(fs.readFileSync(SIERRA_SYMBOL_CONFIG_FILE, "utf8"));
  return {
    ...fallback,
    ...configured,
    paper: {
      ...fallback.paper,
      ...(configured.paper || {}),
    },
  };
}

function readInstrumentContracts() {
  if (!fs.existsSync(INSTRUMENT_CONTRACTS_FILE)) return { contracts: [] };
  return JSON.parse(fs.readFileSync(INSTRUMENT_CONTRACTS_FILE, "utf8"));
}

function readStrategyTemplate() {
  if (!fs.existsSync(STRATEGY_TEMPLATE_FILE)) return { requiredFields: [] };
  return JSON.parse(fs.readFileSync(STRATEGY_TEMPLATE_FILE, "utf8"));
}

function contractForInstrumentOrSymbol(instrument, symbol) {
  const registry = readInstrumentContracts();
  const wantedInstrument = String(instrument || "").toUpperCase();
  const wantedSymbol = String(symbol || "").toUpperCase();
  return (registry.contracts || []).find((contract) => String(contract.instrument || "").toUpperCase() === wantedInstrument)
    || (registry.contracts || []).find((contract) =>
      (contract.symbolPatterns || []).some((pattern) => wantedSymbol.includes(String(pattern || "").toUpperCase()))
    )
    || null;
}

function missingStrategyTemplateQuestions(input) {
  const template = readStrategyTemplate();
  const aliases = {
    entryRules: ["entryRules", "suggestedStrategy"],
    exitRules: ["exitRules", "suggestedStrategy"],
    stopRules: ["stopRules", "rulesSummary", "suggestedStrategy"],
    targetRules: ["targetRules", "rulesSummary", "suggestedStrategy"],
    indicators: ["indicators", "indicatorInstructions"],
    instrument: ["instrument"],
    timeframe: ["timeframe"],
    strategyName: ["strategyName"],
    tradeDirection: ["tradeDirection"],
    sessionWindows: ["sessionWindows"],
    userTimezone: ["userTimezone"],
    strategyTimezone: ["strategyTimezone"],
    maximumRiskDollars: ["maximumRiskDollars", "riskRules"],
    contractQuantity: ["contractQuantity"],
  };
  return (template.requiredFields || [])
    .filter((field) => {
      if (field.default !== undefined) return false;
      const keys = aliases[field.key] || [field.key];
      return !keys.some((key) => String(input[key] || "").trim());
    })
    .map((field) => field.question || `Please provide ${field.label || field.key}.`);
}

function historicalCacheInfo() {
  if (!fs.existsSync(BACKTEST_CACHE_SCRIPT)) {
    return {
      ok: false,
      error: "Historical cache script not found.",
      script: BACKTEST_CACHE_SCRIPT,
      db: BACKTEST_CACHE_DB,
      datasets: [],
    };
  }
  const output = execFileSync(PYTHON_EXE, [BACKTEST_CACHE_SCRIPT, "--db", BACKTEST_CACHE_DB, "info", "--limit", "50"], {
    cwd: path.dirname(BACKTEST_CACHE_SCRIPT),
    encoding: "utf8",
    windowsHide: true,
  });
  const payload = JSON.parse(output);
  return {
    ok: true,
    ...payload,
    db: BACKTEST_CACHE_DB,
    updatedAtUtc: fs.existsSync(BACKTEST_CACHE_DB) ? fs.statSync(BACKTEST_CACHE_DB).mtime.toISOString() : null,
  };
}

function backtestEngineRuns() {
  if (!fs.existsSync(BACKTEST_CACHE_SCRIPT)) {
    return { ok: false, error: "Historical cache script not found.", runs: [] };
  }
  const output = execFileSync(PYTHON_EXE, [BACKTEST_CACHE_SCRIPT, "--db", BACKTEST_CACHE_DB, "list-backtests", "--limit", "25"], {
    cwd: path.dirname(BACKTEST_CACHE_SCRIPT),
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(output);
}

function isoDateDaysAgo(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function regimeSummaryFile(instrument = "MNQ", symbol = "MNQM26_FUT_CME", timeframe = 5) {
  return path.join(
    ROOT_DIR,
    "backtesting",
    "results",
    `regime-summary-${String(instrument).toLowerCase()}-${String(symbol).toLowerCase()}-${timeframe}m.json`,
  );
}

function readRegimeSummary(summaryFile, timeframeInfo) {
  if (!fs.existsSync(summaryFile)) {
    return {
      ok: false,
      timeframe: timeframeInfo,
      summaryFile,
      error: "Summary has not been built yet.",
    };
  }
  return {
    ok: true,
    timeframe: timeframeInfo,
    summaryFile,
    summary: JSON.parse(fs.readFileSync(summaryFile, "utf8")),
  };
}

function markovRiskFactorsFromRegime(label, confidence = 0) {
  const lower = String(label || "").toLowerCase();
  const strong = Number(confidence || 0) >= 0.55;
  if (lower.includes("chop")) return { long: "0.25", short: "0.25", range: "0.25" };
  if (lower.includes("breakout")) return { long: "1.00", short: "1.00", range: "0.25" };
  if (lower.includes("range") || lower.includes("balance")) return { long: "0.50", short: "0.50", range: strong ? "1.25" : "1.00" };
  if (lower.includes("trend up")) return { long: strong ? "1.25" : "1.00", short: "0.50", range: "0.50" };
  if (lower.includes("trend down")) return { long: "0.50", short: strong ? "1.25" : "1.00", range: "0.50" };
  return { long: "1.00", short: "1.00", range: "1.00" };
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function readRegimeLabels(labelsFile) {
  if (!fs.existsSync(labelsFile)) return [];
  const lines = fs.readFileSync(labelsFile, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? "";
    });
    return row;
  });
}

function minuteFromTime(value) {
  const [hour, minute] = String(value || "00:00:00").split(":").map((part) => Number(part));
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function sessionForMinute(minute) {
  return MARKOV_SESSIONS.find((session) => minute >= session.startMinute && minute < session.endMinute) || null;
}

function latestSessionRiskForSummary(item) {
  const summary = item.summary;
  if (!item.ok || !summary) {
    return MARKOV_SESSIONS.map((session) => ({
      session: session.label,
      timeframe: item.timeframe,
      status: "not_built",
    }));
  }
  if (Number(item.timeframe.minutes) === 1440) {
    const risks = markovRiskFactorsFromRegime(summary.currentRegime?.label, summary.currentRegime?.confidence);
    return MARKOV_SESSIONS.map((session) => ({
      session: session.label,
      timeframe: item.timeframe,
      regime: summary.currentRegime?.label || "n/a",
      confidence: summary.currentRegime?.confidence ?? null,
      longRisk: risks.long,
      shortRisk: risks.short,
      rangeRisk: risks.range,
      barKey: summary.source?.coverage?.lastBarKey || "n/a",
      note: "Daily context",
    }));
  }
  const labels = readRegimeLabels(summary.artifacts?.labelsCsv);
  const latestBySession = new Map();
  for (const row of labels) {
    const session = sessionForMinute(minuteFromTime(row.time));
    if (!session) continue;
    latestBySession.set(session.label, row);
  }
  return MARKOV_SESSIONS.map((session) => {
    const row = latestBySession.get(session.label);
    if (!row) {
      return {
        session: session.label,
        timeframe: item.timeframe,
        status: "no_session_bar",
      };
    }
    const confidence = Number(row.confidence || 0);
    const risks = markovRiskFactorsFromRegime(row.regime, confidence);
    return {
      session: session.label,
      timeframe: item.timeframe,
      regime: row.regime || "n/a",
      confidence,
      longRisk: risks.long,
      shortRisk: risks.short,
      rangeRisk: risks.range,
      barKey: row.bar_key || `${row.date || ""} ${row.time || ""}`.trim(),
      note: "",
    };
  });
}

function markovRegimeInfo(extra = {}) {
  const symbols = readSierraSymbolConfig();
  const paper = symbols.paper || {};
  const instrument = "MNQ";
  const symbol = paper.symbol || "MNQM26_FUT_CME";
  const summaries = REGIME_TIMEFRAMES.map((timeframe) => readRegimeSummary(
    regimeSummaryFile(instrument, symbol, timeframe.minutes),
    timeframe,
  ));
  const primary = summaries.find((item) => item.timeframe.minutes === 5 && item.ok) || summaries.find((item) => item.ok);
  const sessionRisk = summaries.flatMap((item) => latestSessionRiskForSummary(item));
  return {
    ok: Boolean(primary?.summary),
    summary: primary?.summary || null,
    summaryFile: primary?.summaryFile || regimeSummaryFile(instrument, symbol, 5),
    summaries,
    sessionRisk,
    sessions: MARKOV_SESSIONS,
    cacheDb: BACKTEST_CACHE_DB,
    engineScript: REGIME_ENGINE_SCRIPT,
    ...extra,
  };
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function parseJsonOutput(output, fallback = {}) {
  const text = String(output || "").trim();
  if (!text) return fallback;
  return JSON.parse(text);
}

function readConfluenceScope() {
  return readJsonFile(CONFLUENCE_SCOPE_FILE, {
    name: "Ocean Trading Confluence scope lock",
    status: "active",
    allowedConsumers: [
      "GET /confluence.html",
      "GET /api/confluence-report",
      "POST /api/confluence-report/rebuild",
      "GET /api/confluence-accuracy",
      "POST /api/confluence-accuracy/backfill",
    ],
    blockedConsumers: [
      "GET /hmm-strategy.html",
      "GET /api/hmm-strategy-monitor",
      "POST /api/hmm-strategy-monitor/evaluations",
      "POST /api/hmm-strategy-monitor/workflow-b/resolve-blocker",
      "GET /api/markov-regime",
      "POST /api/markov-regime/rebuild",
    ],
    notes: [
      "Hegel's Hermes and Markov artifacts are consumed only by the Ocean Trading Confluence page.",
      "No other Ocean Trading page or API should read, publish, or depend on those artifacts.",
      "The standalone HMM Strategy Monitor route is retired to avoid cross-contamination.",
    ],
  });
}

function hermesArtifactFile(relativePath) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(PAPERCLIP_REPO_DIR, relativePath);
}

function hermesArtifactMeta(filePath) {
  if (!filePath) return { path: null, exists: false, updatedAtUtc: null };
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      updatedAtUtc: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  } catch {
    return { path: filePath, exists: false, updatedAtUtc: null };
  }
}

function readHermesArtifactJson(relativePath, fallback = null) {
  return readJsonFile(hermesArtifactFile(relativePath), fallback);
}

function sanitizeHmmStrategyName(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function slugifyHmmStrategyName(value) {
  const slug = sanitizeHmmStrategyName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "strategy";
}

function readManifestForHmmMonitor() {
  try {
    return JSON.parse(buildManifest({ skipRebuildCheck: true, preferFile: true }));
  } catch (error) {
    return {
      generatedAtUtc: null,
      monitorError: String(error?.message || error),
    };
  }
}

function knownStrategyCandidates(manifest) {
  const candidates = new Map();
  function add(name, source, status = "") {
    const strategyName = sanitizeHmmStrategyName(name);
    if (!strategyName) return;
    const key = strategyName.toLowerCase();
    if (!candidates.has(key)) {
      candidates.set(key, {
        strategyName,
        strategyId: slugifyHmmStrategyName(strategyName),
        source,
        status,
      });
    }
  }
  for (const row of manifest.strategyLifecycle || []) add(row.strategyName, "strategy_lifecycle", row.currentStage || row.decision || "");
  for (const row of manifest.strategyCatalog || []) add(row.name || row.strategyName, "strategy_catalog", row.status || "");
  for (const row of manifest.perStrategyMetrics || []) add(row.strategy || row.strategyName, "strategy_metrics", row.status || "");
  for (const section of Object.values(manifest.performance || {})) {
    for (const row of section?.rows || []) add(row.strategy || row.strategyName, "performance", row.source || "");
  }
  return [...candidates.values()].sort((a, b) => a.strategyName.localeCompare(b.strategyName));
}

function summarizeHmmSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const probabilities = snapshot.combined_state_probabilities || snapshot.state_probabilities || {};
  const dominantState = snapshot.dominant_state
    || snapshot.dominantStates?.["5m"]
    || snapshot.dominant_states?.["5m"]
    || snapshot.dominant_states?.["15m"]
    || null;
  return {
    symbol: snapshot.symbol || "n/a",
    timestamp: snapshot.timestamp || null,
    timeframe: snapshot.timeframe || [snapshot.lower_timeframe, snapshot.higher_timeframe].filter(Boolean).join(" / ") || "n/a",
    modelVersion: snapshot.model_version || Object.values(snapshot.model_versions || {}).join(" / ") || "n/a",
    dominantState,
    confidence: snapshot.confidence ?? snapshot.snapshots?.["5m"]?.confidence ?? null,
    expectedReturnTicks: snapshot.expected_return_ticks ?? snapshot.htf_bias?.expected_return_ticks ?? null,
    expectedVolatilityTicks: snapshot.expected_volatility_ticks ?? snapshot.htf_bias?.expected_volatility_ticks ?? null,
    recommendedStrategyMode: snapshot.recommended_strategy_mode || snapshot.ltf_execution_context?.recommended_strategy_mode || "n/a",
    alignment: snapshot.alignment || null,
    conflict: snapshot.conflict || null,
    htfBias: snapshot.htf_bias || null,
    ltfExecutionContext: snapshot.ltf_execution_context || null,
    stateProbabilities: probabilities,
    warnings: snapshot.warnings || [],
  };
}

function workflowBStageCounts(stageBoard) {
  const counts = {
    total: 0,
    complete: 0,
    waiting: 0,
    locked: 0,
    runnable: 0,
  };
  for (const stage of stageBoard?.stages || []) {
    counts.total += 1;
    const status = String(stage.status || "");
    if (/complete|passed/i.test(status)) counts.complete += 1;
    if (/waiting/i.test(status)) counts.waiting += 1;
    if (/locked/i.test(status)) counts.locked += 1;
    if (stage.can_run_now) counts.runnable += 1;
  }
  return counts;
}

function hmmMonitorSourceFiles() {
  return {
    stageStatus: hermesArtifactMeta(HERMES_MARKOV_STAGE_STATUS_FILE),
    s12Manifest: hermesArtifactMeta(path.join(HERMES_MARKOV_S12_DIR, "manifest.json")),
    s12Readiness: hermesArtifactMeta(path.join(HERMES_MARKOV_S12_DIR, "readiness_report.json")),
    s5ModelRegistry: hermesArtifactMeta(path.join(HERMES_MARKOV_S5_DIR, "model_registry.json")),
    s5Latest5mSnapshot: hermesArtifactMeta(path.join(HERMES_MARKOV_S5_DIR, "snapshots", "MNQM26_FUT_CME_5m_latest_snapshot.json")),
    s5Latest15mSnapshot: hermesArtifactMeta(path.join(HERMES_MARKOV_S5_DIR, "snapshots", "MNQM26_FUT_CME_15m_latest_snapshot.json")),
    s6LatestCrossSnapshot: hermesArtifactMeta(path.join(HERMES_MARKOV_S6_DIR, "snapshots", "MNQM26_FUT_CME_5m_15m_latest_cross_timeframe_snapshot.json")),
    s8ComparisonReport: hermesArtifactMeta(path.join(HERMES_MARKOV_S8_DIR, "comparison_report.json")),
    s9WalkForwardReport: hermesArtifactMeta(path.join(HERMES_MARKOV_S9_DIR, "walk_forward_report.json")),
    workflowBStageBoard: hermesArtifactMeta(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "workflow_b_stage_board.json")),
    strategyScorecardTemplate: hermesArtifactMeta(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "strategy_scorecard_template.json")),
    dummyValidationScorecard: hermesArtifactMeta(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "dummy_validation_scorecard.json")),
  };
}

async function recentHmmEvaluationIssues() {
  try {
  const issues = await paperclipGet(companyIssuesPath({ limit: 80, projectId: HERMES_MARKOV_PROJECT_ID }));
    return {
      ok: true,
      issues: (Array.isArray(issues) ? issues : [])
        .filter((issue) => /workflow b|markov|hmm|strategy/i.test(`${issue.title || ""}\n${issue.description || ""}`))
        .slice(0, 12)
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          assigneeAgentId: issue.assigneeAgentId,
          activeRunId: issue.activeRun?.id || issue.executionRunId || null,
          activeRunStatus: issue.activeRun?.status || null,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          completedAt: issue.completedAt,
          url: paperclipIssueUrl(issue),
        })),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      issues: [],
    };
  }
}

function extractHmmIssueStrategyName(issue, knownStrategies = []) {
  const haystack = `${issue?.title || ""}\n${issue?.description || ""}`.toLowerCase();
  const known = [...(knownStrategies || [])]
    .filter((candidate) => candidate.strategyName && haystack.includes(String(candidate.strategyName).toLowerCase()))
    .sort((a, b) => String(b.strategyName).length - String(a.strategyName).length)[0];
  if (known?.strategyName) return known.strategyName;
  const intakeMatch = String(issue?.title || "").match(/workflow b strategy intake:\s*(.+)$/i);
  if (intakeMatch?.[1]) return intakeMatch[1].trim();
  const registerMatch = String(issue?.title || "").match(/register\s+(.+?)\s+strategy plugin/i);
  if (registerMatch?.[1]) return registerMatch[1].trim();
  return null;
}

function hmmEvaluationIssueRank(issue) {
  const status = String(issue?.status || "").toLowerCase();
  if (issue?.activeRunStatus === "running" || status === "in_progress") return 6;
  if (status === "blocked") return 5;
  if (status === "todo") return 4;
  if (status === "backlog") return 2;
  if (status === "done") return 1;
  return 3;
}

function workflowPhaseFromIssue(issue) {
  const title = String(issue?.title || "");
  const phase = title.match(/Workflow B\s+([^:]+):/i)?.[1]?.trim();
  return phase || "Workflow B";
}

function summarizeHmmEvaluationJob(paperclip = {}, knownStrategies = []) {
  const issues = Array.isArray(paperclip.issues) ? paperclip.issues : [];
  const workflowIssues = issues
    .filter((issue) => /workflow b/i.test(`${issue.title || ""}\n${issue.description || ""}`))
    .map((issue) => ({
      ...issue,
      strategyName: extractHmmIssueStrategyName(issue, knownStrategies),
    }))
    .filter((issue) => issue.strategyName);
  if (!workflowIssues.length) return null;

  const intakeIssues = workflowIssues.filter((issue) => /strategy intake/i.test(issue.title || ""));
  const canonicalIntake = [...intakeIssues].sort((a, b) =>
    (hmmEvaluationIssueRank(b) - hmmEvaluationIssueRank(a))
    || String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
  )[0] || null;
  const strategyName = canonicalIntake?.strategyName || workflowIssues[0]?.strategyName || null;
  const strategyIssues = workflowIssues.filter((issue) => issue.strategyName === strategyName);
  const currentIssue = [...strategyIssues]
    .filter((issue) => !/strategy intake/i.test(issue.title || ""))
    .sort((a, b) =>
      (hmmEvaluationIssueRank(b) - hmmEvaluationIssueRank(a))
      || String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
    )[0] || canonicalIntake;
  const duplicateIntakes = intakeIssues
    .filter((issue) => issue.strategyName === strategyName && issue.id !== canonicalIntake?.id)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const status = currentIssue?.status || canonicalIntake?.status || "n/a";
  const statusLower = String(status).toLowerCase();
  const paused = ["blocked", "backlog"].includes(statusLower);
  const running = currentIssue?.activeRunStatus === "running" || statusLower === "in_progress";
  const blockerSummary = statusLower === "blocked"
    ? "Blocked in Paperclip. Open the current issue for the blocker detail before moving to the next Workflow B stage."
    : statusLower === "backlog"
      ? "Waiting in backlog. Use Start evaluation job to assign and wake the governed Paperclip owner."
      : running
        ? "A Paperclip agent run is active now."
        : "No active blocker reported by the current issue status.";

  const evaluation = {
    strategyName,
    strategyId: strategyName ? slugifyHmmStrategyName(strategyName) : null,
    status,
    running,
    paused,
    phase: workflowPhaseFromIssue(currentIssue),
    parentIssue: canonicalIntake ? summarizeHmmStrategyEvaluationIssue(canonicalIntake) : null,
    currentIssue: currentIssue ? summarizeHmmStrategyEvaluationIssue(currentIssue) : null,
    duplicateIssue: duplicateIntakes[0] ? summarizeHmmStrategyEvaluationIssue(duplicateIntakes[0]) : null,
    blockerSummary,
    updatedAt: currentIssue?.updatedAt || canonicalIntake?.updatedAt || null,
  };
  evaluation.blockerAction = summarizeHmmWorkflowBlockerAction(evaluation);
  return evaluation;
}

function summarizeHmmWorkflowBlockerAction(evaluation = {}) {
  const current = evaluation.currentIssue || null;
  const parent = evaluation.parentIssue || null;
  const currentBlocked = String(current?.status || "").toLowerCase() === "blocked";
  const parentBlocked = String(parent?.status || "").toLowerCase() === "blocked";
  if (!currentBlocked && !parentBlocked) return null;
  const target = currentBlocked ? current : parent;
  const resumesParent = Boolean(parentBlocked && current?.id && parent?.id && current.id !== parent.id);
  const phase = evaluation.phase || "Workflow B";
  const hasBackendHandler = /A2\/A3/i.test(String(phase || "")) && currentBlocked;
  return {
    available: true,
    label: hasBackendHandler
      ? `Run ${phase} checks and continue`
      : target?.id === parent?.id
        ? `Resume ${target?.identifier || "blocked issue"}`
        : `Clear ${target?.identifier || "blocked issue"}`,
    description: hasBackendHandler
      ? "Runs the registered backend validation for this stage, then updates Paperclip only if it passes."
      : "Updates the blocked Paperclip issue to the next safe workflow status with an audit comment.",
    targetIssue: target ? summarizeHmmStrategyEvaluationIssue(target) : null,
    parentIssue: parent ? summarizeHmmStrategyEvaluationIssue(parent) : null,
    phase,
    backendHandler: hasBackendHandler ? "a2_a3_contract_validation" : "paperclip_status_only",
    resumesParent,
  };
}

function tailText(value, maxLength = 4000) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function runHmmA2A3ContractValidation() {
  const args = [
    "-m",
    "unittest",
    "paperclip.tests.test_vwap_wave_pullback_plugin",
    "paperclip.tests.test_strategy_interface",
    "paperclip.tests.test_workflow_b_stage_manager",
  ];
  const result = spawnSync(PYTHON_EXE, args, {
    cwd: PAPERCLIP_REPO_DIR,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) {
    const error = new Error(`A2/A3 validation failed to launch: ${result.error.message}`);
    error.validation = {
      command: `${PYTHON_EXE} ${args.join(" ")}`,
      exitCode: result.status,
      output: tailText(output),
      passed: false,
    };
    throw error;
  }
  const validation = {
    command: `${PYTHON_EXE} ${args.join(" ")}`,
    exitCode: result.status,
    output: tailText(output),
    passed: result.status === 0,
    completedAtUtc: new Date().toISOString(),
  };
  updateHmmA2A3ValidationArtifact(validation);
  if (!validation.passed) {
    const error = new Error(`A2/A3 validation failed with exit code ${result.status}`);
    error.validation = validation;
    throw error;
  }
  return validation;
}

function updateHmmA2A3ValidationArtifact(validation) {
  const validationPath = path.join(
    HERMES_MARKOV_REPORT_DATA_DIR,
    "hermes-markov-hmm-workflow-b-vwap-wave-pullback",
    "vwap_wave_pullback_v1_contract_validation.json",
  );
  const artifact = readJsonFile(validationPath, {});
  const next = {
    ...artifact,
    validation_status: {
      ...(artifact.validation_status || {}),
      python_contract_tests_executed: true,
      python_contract_tests_not_run_reason: "",
      runtime_validation_expected_command: validation.command,
      runtime_validation_result: validation.passed ? "passed" : "failed",
      runtime_validation_exit_code: validation.exitCode,
      runtime_validation_completed_at_utc: validation.completedAtUtc,
    },
    runtime_validation: {
      command: validation.command,
      exit_code: validation.exitCode,
      passed: validation.passed,
      completed_at_utc: validation.completedAtUtc,
      output_tail: validation.output,
    },
  };
  fs.mkdirSync(path.dirname(validationPath), { recursive: true });
  fs.writeFileSync(validationPath, JSON.stringify(next, null, 2));
}

function buildHmmWorkflowStageSuccessComment(action, validation, operatorNote = "") {
  return [
    `Workflow B blocker cleared from the Ocean Trading HMM Strategy page.`,
    "",
    `Stage/phase: ${action.phase || "Workflow B"}`,
    `Backend handler: ${action.backendHandler || "paperclip_status_only"}`,
    validation?.command ? `Command run:\n${validation.command}` : "",
    validation ? `Result: ${validation.passed ? "passed" : "failed"}${Number.isFinite(validation.exitCode) ? ` (exit code ${validation.exitCode})` : ""}` : "",
    validation?.output ? `Output:\n${validation.output}` : "",
    "",
    "Paperclip update:",
    action.targetIssue?.identifier ? `- Current blocked issue: ${action.targetIssue.identifier}` : "",
    action.resumesParent && action.parentIssue?.identifier ? `- Parent intake resumed: ${action.parentIssue.identifier}` : "",
    "",
    "Safety confirmed:",
    "- No paper shadow was enabled.",
    "- No paper trading was enabled.",
    "- No live trading was enabled.",
    "- No broker orders were placed.",
    "- No Sierra execution, DTC, or order-routing settings were changed.",
    operatorNote ? `\nOperator note:\n${operatorNote}` : "",
  ].filter(Boolean).join("\n");
}

function buildHmmWorkflowStageResumeComment(action, operatorNote = "") {
  return [
    `Workflow B parent issue resumed from the Ocean Trading HMM Strategy page.`,
    "",
    `Reason: blocker action completed for ${action.phase || "Workflow B"}.`,
    "Next work should continue under Workflow B governance and keep all trading gates closed unless a later explicit approval gate allows otherwise.",
    operatorNote ? `\nOperator note:\n${operatorNote}` : "",
  ].filter(Boolean).join("\n");
}

function unresolvedPaperclipBlockers(issue = {}) {
  return (Array.isArray(issue.blockedBy) ? issue.blockedBy : [])
    .filter((blocker) => String(blocker?.status || "").toLowerCase() !== "done");
}

function hmmBlockerStateSignature(issue = {}) {
  return unresolvedPaperclipBlockers(issue)
    .map((blocker) => `${blocker.id || blocker.identifier || "unknown"}:${String(blocker.status || "unknown").toLowerCase()}`)
    .sort()
    .join("|") || "clear";
}

function rememberHmmStatusOnlySuppression(issue, action, kind) {
  const key = [
    kind,
    issue?.id || "unknown",
    action?.phase || "Workflow B",
    action?.backendHandler || "paperclip_status_only",
    hmmBlockerStateSignature(issue),
  ].join("::");
  if (hmmStatusOnlySuppressionCache.has(key)) return true;
  hmmStatusOnlySuppressionCache.add(key);
  return false;
}

function summarizeHmmSuppressedStatusOnlyResume(issue, action, kind) {
  const blockers = unresolvedPaperclipBlockers(issue);
  return {
    kind,
    issue: issue?.identifier || issue?.id || null,
    phase: action?.phase || "Workflow B",
    backendHandler: action?.backendHandler || "paperclip_status_only",
    reason: "unresolved_paperclip_blockers",
    blockerState: hmmBlockerStateSignature(issue),
    deduped: rememberHmmStatusOnlySuppression(issue, action, kind),
    unresolvedBlockers: blockers.map((blocker) => ({
      id: blocker.id || null,
      identifier: blocker.identifier || null,
      title: blocker.title || null,
      status: blocker.status || null,
    })),
  };
}

async function readHmmWorkflowIssueDetail(issueSummary) {
  if (!issueSummary?.id) return null;
  return paperclipGet(`/issues/${issueSummary.id}`);
}

async function resolveHmmWorkflowBlocker(input = {}) {
  const monitor = await hmmStrategyMonitorInfo();
  const action = monitor.strategyIntake?.currentEvaluation?.blockerAction;
  const operatorNote = sanitizeHmmStrategyName(input?.note);
  const dryRun = Boolean(input?.dryRun);
  if (!action?.available || !action.targetIssue?.id) {
    throw new Error("No blocked Workflow B Paperclip issue is available to resolve.");
  }
  const plannedActions = [];
  if (action.backendHandler === "a2_a3_contract_validation") {
    plannedActions.push({
      kind: "run_backend_validation",
      handler: action.backendHandler,
      issue: action.targetIssue.identifier,
      command: `${PYTHON_EXE} -m unittest paperclip.tests.test_vwap_wave_pullback_plugin paperclip.tests.test_strategy_interface paperclip.tests.test_workflow_b_stage_manager`,
    });
  }
  if (String(action.targetIssue.status || "").toLowerCase() === "blocked") {
    plannedActions.push({
      kind: "patch_issue",
      issue: action.targetIssue.identifier,
      nextStatus: action.targetIssue.id === action.parentIssue?.id ? "todo" : "done",
    });
  }
  if (action.resumesParent && action.parentIssue?.id) {
    plannedActions.push({
      kind: "patch_issue",
      issue: action.parentIssue.identifier,
      nextStatus: "todo",
    });
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      action,
      plannedActions,
    };
  }

  let validation = null;
  if (action.backendHandler === "a2_a3_contract_validation") {
    validation = runHmmA2A3ContractValidation();
  }

  const updatedIssues = [];
  const suppressedActions = [];
  const statusOnlyAction = action.backendHandler === "paperclip_status_only";
  if (String(action.targetIssue.status || "").toLowerCase() === "blocked") {
    if (statusOnlyAction) {
      const targetDetail = await readHmmWorkflowIssueDetail(action.targetIssue);
      const unresolvedTargetBlockers = unresolvedPaperclipBlockers(targetDetail);
      if (unresolvedTargetBlockers.length) {
        suppressedActions.push(summarizeHmmSuppressedStatusOnlyResume(targetDetail, action, "target_issue_resume"));
        return {
          ok: true,
          dryRun: false,
          action,
          plannedActions,
          validation,
          updatedIssues,
          suppressedActions,
        };
      }
    }
    const nextStatus = action.targetIssue.id === action.parentIssue?.id ? "todo" : "done";
    const updated = await paperclipPatch(`/issues/${action.targetIssue.id}`, {
      status: nextStatus,
      comment: buildHmmWorkflowStageSuccessComment(action, validation, operatorNote),
    }, { timeoutMs: 30000 });
    updatedIssues.push(summarizeHmmStrategyEvaluationIssue(updated));
  }
  if (action.resumesParent && action.parentIssue?.id) {
    if (statusOnlyAction) {
      const parentDetail = await readHmmWorkflowIssueDetail(action.parentIssue);
      const unresolvedParentBlockers = unresolvedPaperclipBlockers(parentDetail);
      if (unresolvedParentBlockers.length) {
        suppressedActions.push(summarizeHmmSuppressedStatusOnlyResume(parentDetail, action, "parent_issue_resume"));
        return {
          ok: true,
          dryRun: false,
          action,
          plannedActions,
          validation,
          updatedIssues,
          suppressedActions,
        };
      }
    }
    const updatedParent = await paperclipPatch(`/issues/${action.parentIssue.id}`, {
      status: "todo",
      comment: buildHmmWorkflowStageResumeComment(action, operatorNote),
    }, { timeoutMs: 30000 });
    updatedIssues.push(summarizeHmmStrategyEvaluationIssue(updatedParent));
  }
  return {
    ok: true,
    dryRun: false,
    action,
    plannedActions,
    validation,
    updatedIssues,
    suppressedActions,
  };
}

async function hmmStrategyMonitorInfo() {
  const manifest = readManifestForHmmMonitor();
  const stageStatus = readJsonFile(HERMES_MARKOV_STAGE_STATUS_FILE, {});
  const s12Manifest = readJsonFile(path.join(HERMES_MARKOV_S12_DIR, "manifest.json"), {});
  const s12Readiness = readJsonFile(path.join(HERMES_MARKOV_S12_DIR, "readiness_report.json"), {});
  const governanceGate = readJsonFile(path.join(HERMES_MARKOV_S12_DIR, "governance_gate_status.json"), {});
  const readyForStrategyStatus = readJsonFile(path.join(HERMES_MARKOV_S12_DIR, "ready_for_strategy_status.json"), {});
  const intakeTemplate = readJsonFile(path.join(HERMES_MARKOV_S12_DIR, "strategy_intake_template.json"), {});
  const modelRegistry = readJsonFile(path.join(HERMES_MARKOV_S5_DIR, "model_registry.json"), {});
  const latest5mSnapshot = readJsonFile(path.join(HERMES_MARKOV_S5_DIR, "snapshots", "MNQM26_FUT_CME_5m_latest_snapshot.json"), null);
  const latest15mSnapshot = readJsonFile(path.join(HERMES_MARKOV_S5_DIR, "snapshots", "MNQM26_FUT_CME_15m_latest_snapshot.json"), null);
  const latestCrossSnapshot = readJsonFile(path.join(HERMES_MARKOV_S6_DIR, "snapshots", "MNQM26_FUT_CME_5m_15m_latest_cross_timeframe_snapshot.json"), null);
  const comparisonReport = readJsonFile(path.join(HERMES_MARKOV_S8_DIR, "comparison_report.json"), {});
  const walkForwardReport = readJsonFile(path.join(HERMES_MARKOV_S9_DIR, "walk_forward_report.json"), {});
  const workflowBManifest = readJsonFile(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "manifest.json"), {});
  const workflowBStageBoard = readJsonFile(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "workflow_b_stage_board.json"), {});
  const scorecardTemplate = readJsonFile(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "strategy_scorecard_template.json"), {});
  const dummyScorecard = readJsonFile(path.join(HERMES_MARKOV_WORKFLOW_B_DIR, "dummy_validation_scorecard.json"), {});
  const paperclip = await recentHmmEvaluationIssues();
  const knownStrategies = knownStrategyCandidates(manifest);
  const currentEvaluation = summarizeHmmEvaluationJob(paperclip, knownStrategies);
  const stageCounts = workflowBStageCounts(workflowBStageBoard);
  const nextWorkflowStage = (workflowBStageBoard.stages || []).find((stage) => stage.can_run_now)
    || (workflowBStageBoard.stages || []).find((stage) => /waiting/i.test(String(stage.status || "")))
    || null;
  return {
    ok: true,
    generatedAtUtc: new Date().toISOString(),
    sourceSystem: "paperclip_artifact",
    hermesProject: {
      companyId: COMPANY_ID,
      projectId: HERMES_MARKOV_PROJECT_ID,
      boardUrl: paperclipWebUrl("/OCE/dashboard"),
    },
    platform: {
      project: stageStatus.project || s12Manifest.project || "Hermes Markov/HMM Strategy Evaluation Agent",
      designVersion: stageStatus.design_version || "v2.1_strategy_plugin_architecture",
      currentStageId: stageStatus.current_stage_id || s12Manifest.stage || "n/a",
      currentStageStatus: stageStatus.current_stage_status || s12Manifest.status || "n/a",
      previousStageId: stageStatus.previous_stage_id || "n/a",
      previousStageStatus: stageStatus.previous_stage_status || "n/a",
      nextStageId: stageStatus.next_stage_id || "n/a",
      nextStageStatus: stageStatus.next_stage_status || "n/a",
      firstMajorStopPoint: stageStatus.first_major_stop_point || s12Manifest.exit_gate || "n/a",
      platformReadyForStrategy: Boolean(stageStatus.platform_ready_for_strategy || s12Manifest.platform_ready_for_strategy),
      activeStrategyId: stageStatus.active_strategy_id || s12Manifest.active_strategy_id || null,
      strategyEvaluationActive: Boolean(stageStatus.strategy_evaluation_active || s12Manifest.strategy_evaluation_active),
      blockers: stageStatus.blockers || s12Manifest.blocking_issues || [],
      dataGaps: stageStatus.data_gaps || s12Manifest.data_gaps || [],
      acceptanceItemsTotal: s12Manifest.acceptance_items_total ?? s12Readiness.acceptance_items_total ?? null,
      acceptanceItemsPassed: s12Manifest.acceptance_items_passed ?? s12Readiness.acceptance_items_passed ?? null,
      acceptanceItems: s12Manifest.acceptance_items || [],
      featureFlags: stageStatus.feature_flags || {},
      stageHistory: stageStatus.stage_history || [],
      governance: s12Manifest.governance || governanceGate || {},
      readyForStrategyStatus,
      reviewedAtUtc: s12Manifest.reviewed_at_utc || s12Readiness.reviewed_at_utc || null,
      nextRequiredAction: s12Manifest.next_required_action || stageStatus.next_required_action || "Add a strategy plugin when ready.",
    },
    safety: {
      ...(stageStatus.safety || s12Manifest.safety || {}),
      paper_trading_allowed: Boolean(stageStatus.paper_trading_allowed || s12Manifest.paper_trading_allowed),
      paper_shadow_mode_enabled: Boolean(stageStatus.paper_shadow_mode_enabled || s12Manifest.paper_shadow_mode_enabled),
      live_trading_allowed: Boolean(stageStatus.live_trading_allowed || s12Manifest.live_trading_allowed),
      broker_orders_allowed: Boolean(stageStatus.broker_orders_allowed || s12Manifest.broker_orders_allowed),
      sierra_execution_changes_allowed: Boolean(stageStatus.sierra_execution_changes_allowed || s12Manifest.sierra_execution_changes_allowed),
    },
    strategyIntake: {
      template: intakeTemplate,
      knownStrategies,
      currentEvaluation,
      issueActionLabel: "Start evaluation job",
      enabled: Boolean(stageStatus.platform_ready_for_strategy || s12Manifest.platform_ready_for_strategy),
      activeStrategyId: stageStatus.active_strategy_id || null,
    },
    workflowB: {
      manifest: workflowBManifest,
      board: workflowBStageBoard,
      stageCounts,
      nextStage: nextWorkflowStage,
      enabled: Boolean(stageStatus.feature_flags?.workflow_b_enabled),
    },
    regimeEngine: {
      modelRegistry,
      latest5mSnapshot: summarizeHmmSnapshot(latest5mSnapshot),
      latest15mSnapshot: summarizeHmmSnapshot(latest15mSnapshot),
      latestCrossSnapshot: summarizeHmmSnapshot(latestCrossSnapshot),
      rawCrossSnapshot: latestCrossSnapshot,
      stageSummaries: {
        s5: stageStatus.s5_outputs?.summary || {},
        s6: stageStatus.s6_outputs?.summary || {},
      },
    },
    scorecard: {
      template: scorecardTemplate,
      dummyValidation: dummyScorecard,
      comparisonSummary: dummyScorecard.comparison_summary || comparisonReport.summary || comparisonReport.comparison_summary || {},
      walkForwardSummary: dummyScorecard.walk_forward_summary || walkForwardReport.summary || {},
    },
    paperclip,
    sourceFiles: hmmMonitorSourceFiles(),
  };
}

function summarizeHmmStrategyEvaluationIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId || null,
    activeRunId: issue.activeRunId || issue.activeRun?.id || issue.executionRunId || null,
    activeRunStatus: issue.activeRunStatus || issue.activeRun?.status || null,
    url: paperclipIssueUrl(issue),
  };
}

function isClosedHmmStrategyIssueStatus(status) {
  return ["cancelled", "done"].includes(String(status || "").toLowerCase());
}

function hmmStrategyIssueReuseRank(issue) {
  const status = String(issue?.status || "").toLowerCase();
  if (issue?.activeRun?.status === "running" || status === "in_progress") return 5;
  if (status === "blocked") return 4;
  if (issue?.assigneeAgentId && status === "todo") return 3;
  if (status === "backlog") return 2;
  return 1;
}

function shouldStartHmmStrategyEvaluationIssue(issue) {
  const status = String(issue?.status || "").toLowerCase();
  if (!issue || isClosedHmmStrategyIssueStatus(status)) return false;
  if (issue.activeRun?.status === "running" || status === "in_progress") return false;
  return status === "backlog" || status === "todo" || !issue.assigneeAgentId;
}

function buildHmmStrategyEvaluationDescription(strategyName, strategyId, stageStatus, notes = "") {
  return [
    `Start Workflow B strategy evaluation intake for: ${strategyName}.`,
    "",
    "Source: Ocean Trading website HMM Strategy Monitor.",
    `Requested strategy_id candidate: ${strategyId}`,
    `Hermes stage gate: ${stageStatus.current_stage_id || "n/a"} / ${stageStatus.current_stage_status || "n/a"}.`,
    "Workflow B current expected stage: A1_ADD_STRATEGY_INSTRUCTION_RECEIVED.",
    "",
    "Mandatory boundaries:",
    "- Treat this as strategy evaluation intake only.",
    "- Do not enable paper shadow mode.",
    "- Do not enable paper trading.",
    "- Do not enable live trading.",
    "- Do not place broker orders.",
    "- Do not change Sierra execution, DTC, or order-routing settings.",
    "- Do not mark a strategy active until the Workflow B gates record the required evidence.",
    "",
    "Required next work:",
    "- Read state/stage_status.json and the v2.1 Hermes Markov/HMM instruction pack before acting.",
    "- Validate the real strategy plugin/instruction contract before any backtest comparison.",
    "- Run the Workflow B stage manager and scorecard process only after the strategy contract is clear.",
    "- Keep the Ocean Trading website sourced from persisted Paperclip/Hermes artifacts only.",
    "- Include the required ChatGPT progress update block in executive/stage reports.",
    notes ? `\nOperator notes:\n${notes}` : "",
  ].filter(Boolean).join("\n");
}

function buildHmmStrategyEvaluationWakeComment(strategyName, notes = "") {
  return [
    `Start or continue the governed Workflow B strategy evaluation job for ${strategyName}.`,
    "",
    "This dashboard action is an evaluation workflow kickoff, not a trading activation.",
    "",
    "Safety locks remain in force:",
    "- Do not enable paper shadow mode.",
    "- Do not enable paper trading.",
    "- Do not enable live trading.",
    "- Do not place broker orders.",
    "- Do not change Sierra execution, DTC, or order-routing settings.",
    "",
    "First action: read state/stage_status.json and the v2.1 Hermes Markov/HMM instruction pack, then proceed through Workflow B with persisted stage reports and the required ChatGPT progress update block.",
    notes ? `\nLatest operator notes:\n${notes}` : "",
  ].filter(Boolean).join("\n");
}

async function startHmmStrategyEvaluationIssue(issue, strategyName, notes = "") {
  if (!shouldStartHmmStrategyEvaluationIssue(issue)) {
    return { issue, started: false };
  }
  const status = String(issue.status || "").toLowerCase();
  const patch = {
    assigneeAgentId: HERMES_MARKOV_OWNER_AGENT_ID,
    assigneeUserId: null,
    comment: buildHmmStrategyEvaluationWakeComment(strategyName, notes),
  };
  if (status === "backlog" || status === "todo" || !status) {
    patch.status = "todo";
  }
  const updated = await paperclipPatch(`/issues/${issue.id}`, patch, { timeoutMs: 20000 });
  return { issue: updated, started: true };
}

async function createHmmStrategyEvaluationIssue(input) {
  const strategyName = sanitizeHmmStrategyName(input?.strategyName);
  if (!strategyName) throw new Error("Missing strategy name");
  const stageStatus = readJsonFile(HERMES_MARKOV_STAGE_STATUS_FILE, {});
  if (!stageStatus.platform_ready_for_strategy) {
    throw new Error("Hermes Markov/HMM platform is not marked ready for strategy.");
  }
  const strategyId = slugifyHmmStrategyName(strategyName);
  const notes = sanitizeHmmStrategyName(input?.notes);
  const existingIssues = await paperclipGet(companyIssuesPath({ limit: 120, projectId: HERMES_MARKOV_PROJECT_ID })).catch(() => []);
  const existingIssue = (Array.isArray(existingIssues) ? existingIssues : [])
    .filter((issue) =>
      String(issue.title || "").trim().toLowerCase() === `workflow b strategy intake: ${strategyName}`.toLowerCase()
      && !isClosedHmmStrategyIssueStatus(issue.status),
    )
    .sort((a, b) =>
      (hmmStrategyIssueReuseRank(b) - hmmStrategyIssueReuseRank(a))
      || String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    )[0];
  if (existingIssue) {
    const started = await startHmmStrategyEvaluationIssue(existingIssue, strategyName, notes);
    return {
      ok: true,
      reused: true,
      started: started.started,
      ownerAgentId: HERMES_MARKOV_OWNER_AGENT_ID,
      strategyName,
      strategyId,
      issue: summarizeHmmStrategyEvaluationIssue(started.issue),
    };
  }
  const issue = await paperclipPost(`/companies/${COMPANY_ID}/issues`, {
    ...optionalProject(HERMES_MARKOV_PROJECT_ID),
    title: `Workflow B strategy intake: ${strategyName}`,
    description: buildHmmStrategyEvaluationDescription(strategyName, strategyId, stageStatus, notes),
    priority: "high",
    status: "todo",
    assigneeAgentId: HERMES_MARKOV_OWNER_AGENT_ID,
    assigneeUserId: null,
  }, { timeoutMs: 20000 });
  return {
    ok: true,
    reused: false,
    started: true,
    ownerAgentId: HERMES_MARKOV_OWNER_AGENT_ID,
    strategyName,
    strategyId,
    issue: summarizeHmmStrategyEvaluationIssue(issue),
  };
}

function ukDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function zonedDateKey(date = new Date(), timeZone = "Europe/London") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function zonedTimeMinutes(date = new Date(), timeZone = "Europe/London") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateKeyWeekday(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

function cmeHolidayByDate(dateKey) {
  const calendar = readJsonFile(CME_HOLIDAY_CALENDAR_FILE, null);
  const holidays = Array.isArray(calendar?.holidays) ? calendar.holidays : [];
  return holidays.find((holiday) => holiday?.date === dateKey) || null;
}

function isCmeTradingDate(dateKey) {
  const weekday = dateKeyWeekday(dateKey);
  if (weekday === 0 || weekday === 6) return false;
  return cmeHolidayByDate(dateKey)?.closedAllDay !== true;
}

function previousCmeTradingDateKey(dateKey) {
  let candidate = shiftDateKey(dateKey, -1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (isCmeTradingDate(candidate)) return candidate;
    candidate = shiftDateKey(candidate, -1);
  }
  return candidate;
}

function nextCmeTradingDateKey(dateKey) {
  let candidate = shiftDateKey(dateKey, 1);
  for (let guard = 0; guard < 14; guard += 1) {
    if (isCmeTradingDate(candidate)) return candidate;
    candidate = shiftDateKey(candidate, 1);
  }
  return candidate;
}

function currentCmeTradingDateKey(date = new Date()) {
  const etDateKey = zonedDateKey(date, "America/New_York");
  const etMinutes = zonedTimeMinutes(date, "America/New_York");
  const weekday = dateKeyWeekday(etDateKey);
  let candidate = etDateKey;
  if (weekday === 6) candidate = previousCmeTradingDateKey(etDateKey);
  else if (weekday === 0) candidate = etMinutes >= 18 * 60 ? nextCmeTradingDateKey(etDateKey) : previousCmeTradingDateKey(etDateKey);
  else if (weekday >= 1 && weekday <= 4 && etMinutes >= 18 * 60) candidate = nextCmeTradingDateKey(etDateKey);
  else if (weekday === 5 && etMinutes >= 17 * 60) candidate = etDateKey;
  if (!isCmeTradingDate(candidate)) return previousCmeTradingDateKey(candidate);
  return candidate;
}

function cmeTradingContext(date = new Date()) {
  const current = currentCmeTradingDateKey(date);
  return {
    exchange: "CME_EQUITY_INDEX",
    sourceTimezone: "America/New_York",
    displayTimezone: "Europe/London",
    rule: "CME equity-index Globex trades Sunday 18:00 ET through Friday 17:00 ET, with Saturday/Sunday skipped and full-closure holidays skipped from labels.",
    previous: previousCmeTradingDateKey(current),
    current,
    next: nextCmeTradingDateKey(current),
    generatedAtUtc: new Date().toISOString(),
  };
}

function sanitizeConfluencePrediction(prediction) {
  if (!prediction || typeof prediction !== "object") return prediction;
  return {
    ...prediction,
    coverage: Array.isArray(prediction.coverage)
      ? prediction.coverage.filter((item) => CONFLUENCE_ALLOWED_COVERAGE_MINUTES.has(Number(item?.timeframeMinutes)))
      : [],
    rows: Array.isArray(prediction.rows)
      ? prediction.rows.filter((row) => CONFLUENCE_ALLOWED_ROW_TIMEFRAMES.has(String(row?.timeframe || "").toLowerCase()))
      : [],
    timeframeBias: Array.isArray(prediction.timeframeBias)
      ? prediction.timeframeBias.filter((row) => CONFLUENCE_ALLOWED_ROW_TIMEFRAMES.has(String(row?.timeframe || "").toLowerCase()))
      : [],
  };
}

function sanitizeConfluenceHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    prediction: sanitizeConfluencePrediction(entry.prediction),
  };
}

function readConfluenceHistory() {
  const history = readJsonFile(CONFLUENCE_HISTORY_FILE, []);
  return Array.isArray(history) ? history.map((entry) => sanitizeConfluenceHistoryEntry(entry)) : [];
}

function buildConfluenceReportForDate(dateKey) {
  if (!fs.existsSync(CONFLUENCE_ASOF_SCRIPT)) return null;
  const outputFile = path.join(__dirname, "data", `confluence-history-backfill-${dateKey}.json`);
  execFileSync(PYTHON_EXE, [
    CONFLUENCE_ASOF_SCRIPT,
    "--cutoff", dateKey,
    "--output", outputFile,
    "--report-only",
  ], {
    cwd: PAPERCLIP_REPO_DIR,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  return sanitizeConfluencePrediction(readJsonFile(outputFile, null));
}

function confluencePredictionHasCompleteSessions(prediction) {
  if (prediction?.dataStatus?.status === "missing") return false;
  const requestedDate = String(prediction?.dataStatus?.requestedDate || prediction?.asOfDateLondon || "");
  if (prediction?.dataStatus?.status === "partial" && requestedDate && requestedDate < cmeTradingContext().current) return false;
  const requiredSystems = new Set([
    "Confluence engine",
    "Markov regime",
    "Trend/Momentum",
    "Volume/Order Flow",
    "Factor/Regression",
    "Mean Reversion",
    "Volatility",
  ]);
  const requiredTimeframes = new Set(["5m", "15m", "60m", "daily", "weekly"]);
  for (const sessionName of ["Asian", "London", "US"]) {
    const rows = Array.isArray(prediction?.sessions?.[sessionName]?.rows)
      ? prediction.sessions[sessionName].rows
      : [];
    if (!rows.some((row) => row?.source === "market_cache_bars")) return false;
    const keys = new Set(rows.map((row) => `${row?.timeframe}|${row?.system}`));
    for (const timeframe of requiredTimeframes) {
      for (const system of requiredSystems) {
        if (!keys.has(`${timeframe}|${system}`)) return false;
      }
    }
  }
  return true;
}

function ensureRecentConfluenceActualHistory(tradingDates = cmeTradingContext()) {
  const yesterdayDate = tradingDates.previous;
  const previousDate = previousCmeTradingDateKey(yesterdayDate);
  const dayBeforePreviousDate = previousCmeTradingDateKey(previousDate);
  const requiredDates = [dayBeforePreviousDate, previousDate, yesterdayDate].filter(Boolean);
  const history = readConfluenceHistory();
  const byDate = new Map(history.filter((entry) => entry?.dateKey).map((entry) => [entry.dateKey, entry]));
  let changed = false;
  for (const dateKey of requiredDates) {
    const existing = byDate.get(dateKey);
    if (existing?.prediction?.sessions && existing?.markovSummary && confluencePredictionHasCompleteSessions(existing.prediction)) continue;
    const prediction = buildConfluenceReportForDate(dateKey);
    if (!prediction) continue;
    byDate.set(dateKey, {
      ...(existing || {}),
      dateKey,
      capturedAtUtc: existing?.capturedAtUtc || `${dateKey}T22:00:00Z`,
      prediction,
      markovSummary: prediction.markovSummary || existing?.markovSummary || null,
      note: "Backfilled by Hegel Confluence-only recovery so recent actual session cards have source snapshots.",
      source: "hegel_confluence_history_backfill",
      ownerAgent: "Hegel - Markov HMM for OT Web",
      isolationScope: "Ocean Trading Confluence page only",
    });
    changed = true;
  }
  if (!changed) return history;
  const merged = [...byDate.values()]
    .sort((a, b) => String(a.dateKey || "").localeCompare(String(b.dateKey || "")))
    .slice(-60);
  writeJsonFileAtomic(CONFLUENCE_HISTORY_FILE, merged);
  return merged;
}

function ensureYesterdayConfluenceForecast() {
  const cutoff = cmeTradingContext().previous;
  const existing = sanitizeConfluencePrediction(readJsonFile(CONFLUENCE_YESTERDAY_FORECAST_FILE, null));
  if (existing?.asOfDateLondon === cutoff) return existing;
  if (!fs.existsSync(CONFLUENCE_ASOF_SCRIPT)) return existing;
  execFileSync(PYTHON_EXE, [
    CONFLUENCE_ASOF_SCRIPT,
    "--cutoff", cutoff,
    "--output", CONFLUENCE_YESTERDAY_FORECAST_FILE,
  ], {
    cwd: PAPERCLIP_REPO_DIR,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  return sanitizeConfluencePrediction(readJsonFile(CONFLUENCE_YESTERDAY_FORECAST_FILE, existing));
}

function rebuildConfluencePredictionReport(symbol = CONFLUENCE_SYMBOL || mnqContractForDate().canonicalSymbol) {
  if (!fs.existsSync(CONFLUENCE_ASOF_SCRIPT)) throw new Error("Confluence as-of report script not found.");
  const cutoff = cmeTradingContext().current;
  const output = execFileSync(PYTHON_EXE, [
    CONFLUENCE_ASOF_SCRIPT,
    "--cutoff", cutoff,
    "--output", CONFLUENCE_PREDICTION_REPORT_FILE,
  ], {
    cwd: PAPERCLIP_REPO_DIR,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, OCEAN_CONFLUENCE_SYMBOL: symbol },
  });
  return {
    cutoff,
    output: parseJsonOutput(output, { ok: true, mode: "file_output_only" }),
    report: sanitizeConfluencePrediction(readJsonFile(CONFLUENCE_PREDICTION_REPORT_FILE, null)),
  };
}

function addDaysToDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function thirdFridayUtc(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const firstFridayOffset = (5 - date.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + firstFridayOffset + 14));
}

function mnqContractForDate(dateKey = cmeTradingContext().current) {
  const asOf = new Date(`${dateKey}T12:00:00Z`);
  const year = asOf.getUTCFullYear();
  const quarters = [
    { code: "H", monthIndex: 2 },
    { code: "M", monthIndex: 5 },
    { code: "U", monthIndex: 8 },
    { code: "Z", monthIndex: 11 },
  ];
  for (const quarter of quarters) {
    const expiry = thirdFridayUtc(year, quarter.monthIndex);
    if (asOf <= expiry) {
      return {
        root: CONFLUENCE_ROOT_SYMBOL,
        code: quarter.code,
        year,
        year2: String(year).slice(-2),
        year1: String(year).slice(-1),
        expiryDate: expiry.toISOString().slice(0, 10),
        canonicalSymbol: `${CONFLUENCE_ROOT_SYMBOL}${quarter.code}${String(year).slice(-2)}_FUT_CME`,
        lucidSymbol: `${CONFLUENCE_ROOT_SYMBOL}${quarter.code}${String(year).slice(-1)}.CME`,
      };
    }
  }
  const nextYear = year + 1;
  const expiry = thirdFridayUtc(nextYear, 2);
  return {
    root: CONFLUENCE_ROOT_SYMBOL,
    code: "H",
    year: nextYear,
    year2: String(nextYear).slice(-2),
    year1: String(nextYear).slice(-1),
    expiryDate: expiry.toISOString().slice(0, 10),
    canonicalSymbol: `${CONFLUENCE_ROOT_SYMBOL}H${String(nextYear).slice(-2)}_FUT_CME`,
    lucidSymbol: `${CONFLUENCE_ROOT_SYMBOL}H${String(nextYear).slice(-1)}.CME`,
  };
}

function refreshCmeMnqContractCache(dateKey = cmeTradingContext().current) {
  const currentMonth = dateKey.slice(0, 7);
  const existing = readJsonFile(CONFLUENCE_CONTRACT_CACHE_FILE, null);
  if (existing?.refreshMonth === currentMonth) return existing;
  const contract = mnqContractForDate(dateKey);
  const url = "https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.calendar.html";
  let sourceStatus = "unavailable";
  let sourceBytes = 0;
  let error = null;
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri '${url}').Content.Length`,
    ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.status === 0) {
      sourceStatus = "connected";
      sourceBytes = Number(String(result.stdout || "").trim()) || 0;
    } else {
      error = String(result.stderr || result.stdout || "").trim();
    }
  } catch (err) {
    error = err?.message || String(err);
  }
  const cache = {
    refreshMonth: currentMonth,
    refreshedAtUtc: new Date().toISOString(),
    source: url,
    sourceStatus,
    sourceBytes,
    error,
    rule: "MNQ uses quarterly CME futures months H, M, U, Z; contract expiry is the third Friday of the contract month.",
    activeContract: contract,
  };
  writeJsonFileAtomic(CONFLUENCE_CONTRACT_CACHE_FILE, cache);
  return cache;
}

function resolveConfluenceLiveScid(dateKey = cmeTradingContext().current) {
  const cmeCache = refreshCmeMnqContractCache(dateKey);
  const contract = cmeCache.activeContract || mnqContractForDate(dateKey);
  const symbols = [
    process.env.OCEAN_CONFLUENCE_SCID_PATH ? { path: process.env.OCEAN_CONFLUENCE_SCID_PATH, symbol: CONFLUENCE_SYMBOL || contract.canonicalSymbol, type: "override" } : null,
    { path: path.join(CONFLUENCE_LIVE_DATA_DIR, `${contract.canonicalSymbol}.scid`), symbol: contract.canonicalSymbol, type: "teton_stage5" },
    { path: path.join(CONFLUENCE_LIVE_DATA_DIR, `${contract.lucidSymbol}.scid`), symbol: contract.canonicalSymbol, type: "lucid" },
    { path: path.join(CONFLUENCE_LIVE_DATA_DIR, `${contract.root}${contract.code}${contract.year2}.scid`), symbol: contract.canonicalSymbol, type: "generic" },
  ].filter(Boolean);
  const candidates = symbols
    .map((candidate) => {
      try {
        const stat = fs.statSync(candidate.path);
        return { ...candidate, exists: true, bytes: stat.size, lastWriteTimeUtc: stat.mtime.toISOString(), lastWriteTimeMs: stat.mtimeMs };
      } catch {
        return { ...candidate, exists: false, bytes: 0, lastWriteTimeUtc: null, lastWriteTimeMs: 0 };
      }
    });
  const found = candidates
    .filter((candidate) => candidate.exists && candidate.bytes > 56)
    .sort((a, b) => {
      if (a.type === "override" && b.type !== "override") return -1;
      if (b.type === "override" && a.type !== "override") return 1;
      return (b.lastWriteTimeMs || 0) - (a.lastWriteTimeMs || 0);
    })[0] || null;
  return {
    ok: Boolean(found),
    liveRoot: CONFLUENCE_LIVE_ROOT,
    liveDataDir: CONFLUENCE_LIVE_DATA_DIR,
    contract,
    cmeCache,
    selected: found || null,
    candidates,
  };
}

function refreshConfluenceSierraCache() {
  if (!fs.existsSync(CONFLUENCE_SCID_IMPORT_SCRIPT)) {
    return { ok: false, skipped: true, reason: "SCID importer not found", script: CONFLUENCE_SCID_IMPORT_SCRIPT };
  }
  const source = resolveConfluenceLiveScid();
  if (!source.ok) {
    return { ok: false, skipped: true, reason: "Active Live MNQ SCID not found", ...source };
  }
  const cutoff = cmeTradingContext().current;
  const startDate = addDaysToDateKey(cutoff, -14);
  const importPython = fs.existsSync(CONFLUENCE_IMPORT_PYTHON) ? CONFLUENCE_IMPORT_PYTHON : PYTHON_EXE;
  const output = execFileSync(importPython, [
    CONFLUENCE_SCID_IMPORT_SCRIPT,
    "--scid", source.selected.path,
    "--db", BACKTEST_CACHE_DB,
    "--symbol", source.selected.symbol,
    "--start-date", startDate,
    "--end-date", cutoff,
    "--timeframe-minutes", "5",
    "--price-scale", "100",
  ], {
    cwd: path.dirname(CONFLUENCE_SCID_IMPORT_SCRIPT),
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  return { ok: true, liveSource: source, ...JSON.parse(output) };
}

function ensureCurrentConfluencePrediction(tradingDates = cmeTradingContext()) {
  const existing = sanitizeConfluencePrediction(readJsonFile(CONFLUENCE_PREDICTION_REPORT_FILE, null));
  if (existing?.asOfDateLondon === tradingDates.current && confluencePredictionHasCompleteSessions(existing)) {
    return { report: existing, rebuilt: false };
  }
  const rebuilt = rebuildConfluencePredictionReport();
  return { report: rebuilt.report, rebuilt: true, rebuild: rebuilt };
}

function writeConfluenceSnapshot(payload) {
  const prediction = sanitizeConfluencePrediction(payload?.prediction || null);
  const markovSummary = payload?.markov?.summary || null;
  if (!prediction && !markovSummary) return readConfluenceHistory();
  const capturedAtUtc = new Date().toISOString();
  const dateKey = currentCmeTradingDateKey(new Date(capturedAtUtc));
  const history = readConfluenceHistory().filter((entry) => entry.dateKey !== dateKey);
  history.push({
    dateKey,
    capturedAtUtc,
    prediction,
    markovSummary,
    note: "Captured after confluence rebuild for next-session comparison.",
  });
  history.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  const trimmed = history.slice(-60);
  writeJsonFileAtomic(CONFLUENCE_HISTORY_FILE, trimmed);
  return trimmed;
}

function confluenceForecastNextRegime(summary) {
  const states = Array.isArray(summary?.model?.states) ? summary.model.states : [];
  const current = summary?.currentRegime?.probabilities || {};
  const matrix = summary?.transitionMatrix || {};
  const forecast = {};
  for (const state of states) forecast[state] = 0;
  for (const from of states) {
    for (const to of states) {
      forecast[to] += Number(current[from] || 0) * Number(matrix[from]?.[to] || 0);
    }
  }
  return Object.entries(forecast).sort((a, b) => b[1] - a[1]);
}

function confluenceRegimeBucket(label) {
  const value = String(label || "").toLowerCase();
  if (value.includes("down")) return "bearish";
  if (value.includes("up")) return "bullish";
  return "range";
}

function confluenceStanceBucket(row) {
  if (!row) return null;
  const system = String(row.system || "").toLowerCase();
  const summary = String(row.summary || "").toLowerCase();
  const bias = String(row.bias || "").toLowerCase();
  const score = Number(row.score);
  if (system.includes("markov")) {
    if (summary.includes("trend down")) return "bearish";
    if (summary.includes("trend up")) return "bullish";
    return "range";
  }
  if (system.includes("confluence") && summary.startsWith("flat")) return "range";
  if (Number.isFinite(score)) {
    if (score >= 0.18) return "bullish";
    if (score <= -0.18) return "bearish";
    return "range";
  }
  if (bias.includes("bearish")) return "bearish";
  if (bias.includes("bullish")) return "bullish";
  return "range";
}

function confluenceSessionProfile(sessionName) {
  const profiles = {
    Asian: { timeframeWeights: { "5m": 1.15, "15m": 1.05, "60m": 0.9, daily: 0.75, weekly: 0.6 } },
    London: { timeframeWeights: { "5m": 0.95, "15m": 1.2, "60m": 1.15, daily: 0.8, weekly: 0.65 } },
    US: { timeframeWeights: { "5m": 1.05, "15m": 1.1, "60m": 1.2, daily: 0.9, weekly: 0.7 } },
  };
  return profiles[sessionName] || profiles.London;
}

function confluenceApplyProbabilityFloor(percentages, floor = 8) {
  const bearish = Number(percentages?.bearish);
  const range = Number(percentages?.range);
  const bullish = Number(percentages?.bullish);
  if (![bearish, range, bullish].every(Number.isFinite)) return percentages;
  if (bearish >= floor && range >= floor && bullish >= floor) return percentages;
  const floored = {
    bearish: Math.max(floor, bearish),
    range: Math.max(floor, range),
    bullish: Math.max(floor, bullish),
  };
  const total = floored.bearish + floored.range + floored.bullish;
  return {
    bearish: (floored.bearish / total) * 100,
    range: (floored.range / total) * 100,
    bullish: (floored.bullish / total) * 100,
  };
}

function confluenceSessionStanceSummary(report, sessionName) {
  const profile = confluenceSessionProfile(sessionName);
  const sessionRows = Array.isArray(report?.sessions?.[sessionName]?.rows)
    ? report.sessions[sessionName].rows
    : null;
  const systemWeights = {
    "Volatility": 0.75,
    "Trend/Momentum": 1,
    "Mean Reversion": 1,
    "Factor/Regression": 1,
    "Volume/Order Flow": 1,
    "Confluence engine": 1.25,
    "Markov regime": 1.1,
  };
  const totals = { bearish: 0, range: 0, bullish: 0 };
  const rows = (sessionRows || report?.rows || []).filter((row) =>
    profile.timeframeWeights[row.timeframe] && systemWeights[row.system]
  );
  for (const row of rows) {
    const bucket = confluenceStanceBucket(row);
    if (!bucket) continue;
    const confidence = Number(row.confidence);
    const confidenceWeight = Number.isFinite(confidence) ? Math.max(0.25, Math.min(1, confidence)) : 0.5;
    totals[bucket] += (profile.timeframeWeights[row.timeframe] || 1)
      * (systemWeights[row.system] || 1)
      * confidenceWeight;
  }
  const total = totals.bearish + totals.range + totals.bullish;
  const rawPercentages = total > 0
    ? {
        bearish: (totals.bearish / total) * 100,
        range: (totals.range / total) * 100,
        bullish: (totals.bullish / total) * 100,
      }
    : { bearish: 33.3, range: 33.4, bullish: 33.3 };
  const percentages = confluenceApplyProbabilityFloor(rawPercentages);
  const dominant = Object.entries(percentages).sort((a, b) => b[1] - a[1])[0]?.[0] || "range";
  return { percentages, dominant };
}

function confluenceSessionTomorrowStanceSummary(report, markovSummary, sessionName) {
  const today = confluenceSessionStanceSummary(report, sessionName);
  const forecast = confluenceForecastNextRegime(markovSummary || {});
  if (!forecast.length) return today;
  const regimeTotals = { bearish: 0, range: 0, bullish: 0 };
  let total = 0;
  for (const [label, value] of forecast) {
    const probability = Number(value);
    if (!Number.isFinite(probability)) continue;
    regimeTotals[confluenceRegimeBucket(label)] += probability;
    total += probability;
  }
  const forecastPercentages = total > 0
    ? {
        bearish: (regimeTotals.bearish / total) * 100,
        range: (regimeTotals.range / total) * 100,
        bullish: (regimeTotals.bullish / total) * 100,
      }
    : today.percentages;
  const blended = {
    bearish: forecastPercentages.bearish * 0.6 + today.percentages.bearish * 0.4,
    range: forecastPercentages.range * 0.6 + today.percentages.range * 0.4,
    bullish: forecastPercentages.bullish * 0.6 + today.percentages.bullish * 0.4,
  };
  return {
    percentages: blended,
    dominant: Object.entries(blended).sort((a, b) => b[1] - a[1])[0]?.[0] || "range",
  };
}

function confluenceDominantDistance(forecast, actual) {
  const keys = ["bearish", "range", "bullish"];
  return keys.reduce((sum, key) => sum + Math.abs(Number(forecast?.[key] || 0) - Number(actual?.[key] || 0)), 0) / keys.length;
}

function confluenceAccuracyStatus(hitRate, samples) {
  if (samples < 5) return "unproven";
  if (hitRate >= 0.62) return "reliable";
  if (hitRate >= 0.45) return "watch";
  return "weak";
}

function confluenceAccuracyRecordKey(record) {
  return [
    record?.session,
    record?.actualDateKey,
    record?.forecastSourceDateKey,
  ].map((value) => String(value || "")).join("|");
}

function confluenceAccuracyRecordsFromHistory(history = []) {
  const byDate = new Map((history || [])
    .filter((entry) => entry?.dateKey && entry?.prediction)
    .map((entry) => [entry.dateKey, entry]));
  const records = [];
  for (const actual of history || []) {
    if (!actual?.dateKey || !actual?.prediction) continue;
    if (!confluencePredictionHasCompleteSessions(actual.prediction)) continue;
    const sourceDate = previousCmeTradingDateKey(actual.dateKey);
    const forecastSource = byDate.get(sourceDate);
    if (!forecastSource?.prediction) continue;
    if (!confluencePredictionHasCompleteSessions(forecastSource.prediction)) continue;
    for (const session of ["Asian", "London", "US"]) {
      const actualStance = confluenceSessionStanceSummary(actual.prediction, session);
      const forecastStance = confluenceSessionTomorrowStanceSummary(
        forecastSource.prediction,
        forecastSource.markovSummary || forecastSource.prediction?.markovSummary || null,
        session,
      );
      const error = confluenceDominantDistance(forecastStance.percentages, actualStance.percentages);
      const exactHit = forecastStance.dominant === actualStance.dominant;
      const nearMiss = !exactHit && error <= 18;
      records.push({
        session,
        actualDateKey: actual.dateKey,
        forecastSourceDateKey: sourceDate,
        actualCapturedAtUtc: actual.capturedAtUtc || null,
        forecastCapturedAtUtc: forecastSource.capturedAtUtc || null,
        forecastDominant: forecastStance.dominant,
        actualDominant: actualStance.dominant,
        errorPct: error,
        result: exactHit ? "hit" : nearMiss ? "near-miss" : "miss",
        forecastPercentages: forecastStance.percentages,
        actualPercentages: actualStance.percentages,
        learnedAtUtc: new Date().toISOString(),
        source: "confluence_forecast_history",
      });
    }
  }
  return records;
}

function aggregateConfluenceSessionRecords(records = []) {
  const sessions = ["Asian", "London", "US"];
  const sessionStats = new Map(sessions.map((session) => [session, {
    session,
    samples: 0,
    hits: 0,
    nearMisses: 0,
    errorTotal: 0,
    latestResult: "pending",
    latestActualDateKey: null,
  }]));
  for (const record of records) {
    const stat = sessionStats.get(record?.session);
    if (!stat) continue;
    const error = Number(record.errorPct);
    stat.samples += 1;
    stat.hits += record.result === "hit" ? 1 : 0;
    stat.nearMisses += record.result === "near-miss" ? 1 : 0;
    stat.errorTotal += Number.isFinite(error) ? error : 0;
    if (!stat.latestActualDateKey || String(record.actualDateKey || "").localeCompare(stat.latestActualDateKey) >= 0) {
      stat.latestActualDateKey = record.actualDateKey || null;
      stat.latestResult = record.result || "pending";
    }
  }
  return [...sessionStats.values()].map((stat) => {
    const hitRate = stat.samples ? stat.hits / stat.samples : 0;
    return {
      session: stat.session,
      hitRate,
      avgErrorPct: stat.samples ? stat.errorTotal / stat.samples : null,
      samples: stat.samples,
      nearMisses: stat.nearMisses,
      status: confluenceAccuracyStatus(hitRate, stat.samples),
      latestResult: stat.latestResult,
      latestActualDateKey: stat.latestActualDateKey,
    };
  });
}

function updateConfluenceSessionLearnerState(history = []) {
  const existing = readJsonFile(CONFLUENCE_SESSION_LEARNER_FILE, null);
  const existingRecords = Array.isArray(existing?.records) ? existing.records : [];
  const previousByKey = new Map(existingRecords
    .filter((record) => record?.session && record?.actualDateKey && record?.forecastSourceDateKey)
    .map((record) => [confluenceAccuracyRecordKey(record), record]));
  const byKey = new Map();
  for (const record of confluenceAccuracyRecordsFromHistory(history)) {
    const existingRecord = previousByKey.get(confluenceAccuracyRecordKey(record));
    byKey.set(confluenceAccuracyRecordKey(record), {
      ...record,
      firstLearnedAtUtc: existingRecord?.firstLearnedAtUtc || record.learnedAtUtc,
    });
  }
  const records = [...byKey.values()]
    .sort((a, b) =>
      String(a.actualDateKey || "").localeCompare(String(b.actualDateKey || ""))
      || String(a.session || "").localeCompare(String(b.session || ""))
    )
    .slice(-240);
  const sessions = aggregateConfluenceSessionRecords(records);
  const updatedAtUtc = new Date().toISOString();
  const state = {
    version: 1,
    updatedAtUtc,
    generatedAtUtc: updatedAtUtc,
    learnerId: "confluence-session-accuracy-learner",
    sourceHistoryFile: CONFLUENCE_HISTORY_FILE,
    recordCount: records.length,
    sessions,
    records,
    note: "Persistent per-session learner state. Records are keyed by session, actual trading date, and forecast source trading date so later rebuilds update rather than duplicate samples.",
  };
  writeJsonFileAtomic(CONFLUENCE_SESSION_LEARNER_FILE, state);
  return state;
}

function confluenceMethodStatsFromHistory(history = []) {
  const byDate = new Map((history || [])
    .filter((entry) => entry?.dateKey && entry?.prediction)
    .map((entry) => [entry.dateKey, entry]));
  const methodStats = new Map();
  for (const actual of history || []) {
    if (!actual?.dateKey || !actual?.prediction) continue;
    if (!confluencePredictionHasCompleteSessions(actual.prediction)) continue;
    const sourceDate = previousCmeTradingDateKey(actual.dateKey);
    const forecastSource = byDate.get(sourceDate);
    if (!forecastSource?.prediction) continue;
    if (!confluencePredictionHasCompleteSessions(forecastSource.prediction)) continue;

    const actualRows = new Map((actual.prediction.rows || []).map((row) => [`${row.timeframe}|${row.system}`, row]));
    for (const row of forecastSource.prediction.rows || []) {
      const actualRow = actualRows.get(`${row.timeframe}|${row.system}`);
      if (!actualRow) continue;
      const method = row.system || "Unknown";
      const stat = methodStats.get(method) || { method, samples: 0, hits: 0, actualDates: new Set() };
      stat.samples += 1;
      stat.hits += confluenceStanceBucket(row) === confluenceStanceBucket(actualRow) ? 1 : 0;
      stat.actualDates.add(actual.dateKey);
      methodStats.set(method, stat);
    }
  }
  return methodStats;
}

function buildConfluenceForecastAccuracyArtifact({ history = [], latestIssueIdentifier = "local-read-model", learnerState = null } = {}) {
  const state = learnerState || updateConfluenceSessionLearnerState(history);
  const sessionRows = Array.isArray(state?.sessions) ? state.sessions : aggregateConfluenceSessionRecords(state?.records || []);
  const totalSamples = sessionRows.reduce((sum, row) => sum + row.samples, 0);
  const totalHits = sessionRows.reduce((sum, row) => sum + Math.round(row.hitRate * row.samples), 0);
  const totalHitRate = totalSamples ? totalHits / totalSamples : 0;
  const actualDaySamples = new Set((state?.records || [])
    .map((record) => record?.actualDateKey)
    .filter(Boolean)).size;
  const sampleStatus = actualDaySamples < 5 ? "unproven" : confluenceAccuracyStatus(totalHitRate, totalSamples);
  const methods = [...confluenceMethodStatsFromHistory(history).values()].map((stat) => {
    const hitRate = stat.samples ? stat.hits / stat.samples : 0;
    const dateSamples = stat.actualDates?.size || 0;
    const enoughDates = dateSamples >= 5;
    return {
      method: stat.method,
      impact: !enoughDates ? "insufficient actual days" : hitRate >= 0.55 ? "helped" : hitRate <= 0.35 ? "hurt" : "neutral",
      hitRate: enoughDates ? hitRate : null,
      samples: stat.samples,
      actualDaySamples: dateSamples,
      note: !enoughDates ? `Only ${dateSamples} comparable actual day${dateSamples === 1 ? "" : "s"}; sample is too small to trust yet.` : `${Math.round(hitRate * 100)}% same-direction agreement.`,
    };
  }).sort((a, b) => b.samples - a.samples || String(a.method).localeCompare(String(b.method)));

  return {
    generatedAtUtc: new Date().toISOString(),
    learnerUpdatedAtUtc: state?.updatedAtUtc || null,
    learnerId: state?.learnerId || "confluence-session-accuracy-learner",
    routineId: "324350dd-3938-4f27-9157-fd817e58f139",
    latestIssueIdentifier,
    sampleStatus,
    samples: totalSamples,
    actualDaySamples,
    sessions: sessionRows,
    recentSessionRecords: Array.isArray(state?.records) ? state.records.slice(-9).reverse() : [],
    methods,
    recommendation: totalSamples < 15
      ? "Collect more comparable session forecasts before changing weights."
      : sampleStatus === "weak"
      ? "Treat the forecast as weak and have Hermes propose threshold or method-weight changes before production use."
      : "Continue monitoring; do not change production weights automatically.",
    sources: [
      CONFLUENCE_HISTORY_FILE,
      CONFLUENCE_SESSION_LEARNER_FILE,
      CONFLUENCE_PREDICTION_REPORT_FILE,
      CONFLUENCE_YESTERDAY_FORECAST_FILE,
    ],
    calculationOwner: "Ocean Trading read-model fallback for Hermes Strategy Learner artifact",
  };
}

function confluenceForecastAccuracyForReport(history = []) {
  const learnerState = updateConfluenceSessionLearnerState(history);
  const fallbackAccuracy = buildConfluenceForecastAccuracyArtifact({ history, learnerState });
  try {
    writeJsonFileAtomic(CONFLUENCE_FORECAST_ACCURACY_FILE, fallbackAccuracy);
  } catch (error) {
    console.warn(`Unable to persist Confluence forecast accuracy artifact: ${error?.message || error}`);
  }
  return fallbackAccuracy;
}

function runConfluenceAccuracyWorker(args = []) {
  if (!fs.existsSync(CONFLUENCE_ACCURACY_WORKER)) throw new Error("Confluence accuracy worker not found.");
  const output = execFileSync(process.execPath, [CONFLUENCE_ACCURACY_WORKER, ...args], {
    cwd: __dirname,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  return JSON.parse(output);
}

function confluenceMarkovFromPrediction(prediction) {
  const summary = prediction?.markovSummary || null;
  if (!summary) return markovRegimeInfo();
  return {
    ok: true,
    generatedAtUtc: summary.generatedAtUtc || prediction.generatedAtUtc || new Date().toISOString(),
    instrument: CONFLUENCE_ROOT_SYMBOL,
    symbol: summary.source?.symbol || prediction.dataStatus?.symbol || CONFLUENCE_SYMBOL || mnqContractForDate().canonicalSymbol,
    summary,
    summaries: [
      {
        label: "Confluence Live market-cache",
        timeframe: "Session blend",
        summary,
        sourceFile: CONFLUENCE_PREDICTION_REPORT_FILE,
      },
    ],
    sessionRisk: [],
    sessions: MARKOV_SESSIONS,
    source: "confluence_live_market_cache",
    isolationScope: "Ocean Trading Confluence page only",
  };
}

function confluenceReportInfo(extra = {}) {
  const tradingDates = cmeTradingContext();
  ensureRecentConfluenceActualHistory(tradingDates);
  const currentPrediction = ensureCurrentConfluencePrediction(tradingDates);
  const prediction = currentPrediction.report;
  const yesterdayForecast = ensureYesterdayConfluenceForecast();
  const walkForward = readJsonFile(CONFLUENCE_WALK_FORWARD_FILE, null);
  const history = readConfluenceHistory();
  const forecastAccuracy = confluenceForecastAccuracyForReport(history);
  const sessionLearner = readJsonFile(CONFLUENCE_SESSION_LEARNER_FILE, null);
  const markov = confluenceMarkovFromPrediction(prediction);
  const scope = readConfluenceScope();
  return {
    ok: Boolean(prediction || markov.ok),
    generatedAtUtc: new Date().toISOString(),
    prediction,
    yesterdayForecast,
    walkForward,
    forecastAccuracy,
    sessionLearner,
    markov,
    tradingDates,
    scope,
    history,
    autoRefresh: {
      currentPredictionRebuilt: currentPrediction.rebuilt,
      currentPredictionCutoff: tradingDates.current,
      recoveryAgent: "Hegel - Markov HMM for OT Web",
      refreshIntervalMs: 60_000,
    },
    sources: {
      predictionReport: CONFLUENCE_PREDICTION_REPORT_FILE,
      yesterdayForecast: CONFLUENCE_YESTERDAY_FORECAST_FILE,
      walkForwardStudy: CONFLUENCE_WALK_FORWARD_FILE,
      forecastHistory: CONFLUENCE_HISTORY_FILE,
      forecastAccuracy: CONFLUENCE_FORECAST_ACCURACY_FILE,
      sessionAccuracyLearner: CONFLUENCE_SESSION_LEARNER_FILE,
      cacheDb: BACKTEST_CACHE_DB,
      regimeEngine: REGIME_ENGINE_SCRIPT,
    },
    ...extra,
  };
}

function rebuildMarkovRegime() {
  const missingScripts = [
    ["historicalCache", BACKTEST_CACHE_SCRIPT],
    ["regimeEngine", REGIME_ENGINE_SCRIPT],
    ["timeframeAggregation", AGGREGATE_TIMEFRAMES_SCRIPT],
  ].filter(([, filePath]) => !fs.existsSync(filePath));
  const symbols = readSierraSymbolConfig();
  const paper = symbols.paper || {};
  const instrument = "MNQ";
  const symbol = paper.symbol || "MNQM26_FUT_CME";
  if (missingScripts.length) {
    if (!fs.existsSync(CONFLUENCE_ASOF_SCRIPT)) {
      throw new Error(`Confluence Markov recovery unavailable; missing ${missingScripts.map(([name]) => name).join(", ")} and as-of builder not found.`);
    }
    const cutoff = cmeTradingContext().current;
    const output = execFileSync(PYTHON_EXE, [
      CONFLUENCE_ASOF_SCRIPT,
      "--cutoff", cutoff,
      "--output", CONFLUENCE_PREDICTION_REPORT_FILE,
    ], {
      cwd: PAPERCLIP_REPO_DIR,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
    });
    return markovRegimeInfo({
      rebuild: {
        generatedAtUtc: new Date().toISOString(),
        mode: "hegel_confluence_markov_recovery",
        recoveryAgent: "Hegel - Markov Recovery",
        isolation: {
          allowedConsumer: "Ocean Trading Confluence page",
          forbiddenConsumers: ["Rowan - Markov HMM Strategy", "live trading", "paper trading execution"],
          writesOnly: [
            CONFLUENCE_PREDICTION_REPORT_FILE,
            CONFLUENCE_YESTERDAY_FORECAST_FILE,
            CONFLUENCE_WALK_FORWARD_FILE,
            regimeSummaryFile(instrument, symbol, 5),
            regimeSummaryFile(instrument, symbol, 15),
            regimeSummaryFile(instrument, symbol, 60),
            regimeSummaryFile(instrument, symbol, 1440),
          ],
        },
        missingScripts: missingScripts.map(([name, filePath]) => ({ name, filePath })),
        confluenceRecovery: parseJsonOutput(output, { ok: true, mode: "file_output_only" }),
      },
    });
  }
  const source = paper.dataFile || `D:\\Trading\\SierraChart-PaperTrading\\Data\\${symbol}.scid`;
  const cacheFrom = isoDateDaysAgo(186);
  const modelFrom = isoDateDaysAgo(186);
  const today = new Date().toISOString().slice(0, 10);
  const ensureOutput = execFileSync(PYTHON_EXE, [
    BACKTEST_CACHE_SCRIPT,
    "--db", BACKTEST_CACHE_DB,
    "ensure-range",
    "--instrument", instrument,
    "--symbol", symbol,
    "--timeframe", "5",
    "--from", cacheFrom,
    "--to", today,
    "--source", source,
    "--import-chunk-days", "30",
  ], {
    cwd: path.dirname(BACKTEST_CACHE_SCRIPT),
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });
  const aggregateOutput = execFileSync(PYTHON_EXE, [
    AGGREGATE_TIMEFRAMES_SCRIPT,
    "--db", BACKTEST_CACHE_DB,
    "--instrument", instrument,
    "--symbol", symbol,
    "--source-timeframe", "5",
    "--timeframes", "15,60,1440",
  ], {
    cwd: path.dirname(AGGREGATE_TIMEFRAMES_SCRIPT),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const runs = REGIME_TIMEFRAMES.map((timeframe) => {
    const regimeOutput = execFileSync(PYTHON_EXE, [
      REGIME_ENGINE_SCRIPT,
      "--db", BACKTEST_CACHE_DB,
      "--instrument", instrument,
      "--symbol", symbol,
      "--timeframe", String(timeframe.minutes),
      "--from", modelFrom,
      "--to", today,
    ], {
      cwd: path.dirname(REGIME_ENGINE_SCRIPT),
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
    });
    return {
      timeframe,
      regimeRun: JSON.parse(regimeOutput),
    };
  });
  return markovRegimeInfo({
    rebuild: {
      generatedAtUtc: new Date().toISOString(),
      ensureRange: JSON.parse(ensureOutput),
      aggregateTimeframes: JSON.parse(aggregateOutput),
      runs,
    },
  });
}

function rebuildConfluenceReport() {
  const sierraRefresh = refreshConfluenceSierraCache();
  const prediction = rebuildConfluencePredictionReport(sierraRefresh?.symbol || sierraRefresh?.liveSource?.selected?.symbol || undefined);
  const payload = confluenceReportInfo({
    rebuild: {
      generatedAtUtc: new Date().toISOString(),
      source: "confluence_live_market_cache",
      note: "Confluence rebuild is isolated from the standalone Markov page artifacts.",
    },
    sierraRefresh,
    predictionRebuild: {
      generatedAtUtc: new Date().toISOString(),
      cutoff: prediction.cutoff,
      output: prediction.output,
    },
  });
  const history = writeConfluenceSnapshot(payload);
  return {
    ...payload,
    history,
  };
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function monitorState() {
  const state = readJsonFile(MONITOR_STATE_FILE, { running: false, status: "stopped" });
  const running = monitorProcess && !monitorProcess.killed && monitorProcess.exitCode === null;
  const externalRunning = isProcessAlive(state.pid);
  const isRunning = Boolean(running || externalRunning);
  return {
    ...state,
    running: isRunning,
    status: isRunning ? state.status || "running" : "stopped",
    managedByServer: Boolean(running),
  };
}

function startMonitor() {
  if (monitorProcess && !monitorProcess.killed && monitorProcess.exitCode === null) return monitorState();
  const currentState = monitorState();
  if (currentState.running && currentState.pid && isProcessAlive(currentState.pid)) return currentState;
  monitorProcess = spawn(process.execPath, [MONITOR_SCRIPT], {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  monitorProcess.unref();
  return {
    running: true,
    status: "starting",
    pid: monitorProcess.pid,
    updatedAtUtc: new Date().toISOString(),
  };
}

function stopMonitor() {
  if (monitorProcess && !monitorProcess.killed && monitorProcess.exitCode === null) {
    monitorProcess.kill();
  }
  monitorProcess = null;
  fs.mkdirSync(path.dirname(MONITOR_STATE_FILE), { recursive: true });
  fs.writeFileSync(
    MONITOR_STATE_FILE,
    JSON.stringify({ running: false, status: "stopped", updatedAtUtc: new Date().toISOString() }, null, 2),
  );
  return monitorState();
}

function monitorStartsByDefault() {
  const flag = String(process.env.OCEAN_TRADING_MONITOR_DEFAULT_ON || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(flag)) return false;
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  const vwapConfig = readJsonFile(VWAP_PAPER_SIM1_EMAIL_CONFIG_FILE, {});
  return vwapConfig.enabled === true && vwapConfig.websiteMonitorAutostart !== false;
}

function openTradesPayload() {
  const manifest = JSON.parse(buildManifest({ skipRebuildCheck: true, preferFile: true }));
  const live = manifest.tradingModes?.live || {};
  const paper = manifest.tradingModes?.paper || {};
  const today = new Date().toISOString().slice(0, 10);
  const isTodayTrade = (trade) => String(trade.exitAtUtc || trade.tradeDateUtc || "").slice(0, 10) === today;
  return {
    generatedAtUtc: manifest.generatedAtUtc,
    monitor: monitorState(),
    propFirms: manifest.propFirms || {},
    live: {
      openPositions: live.openPositions || [],
      todayClosedTrades: (live.performanceClosedTrades || []).filter(isTodayTrade),
      profitReconciliation: live.profitReconciliation || null,
      accountMonitor: live.accountMonitor || null,
      dtcSnapshot: live.dtcSnapshot || null,
    },
    paper: {
      openPositions: paper.openPositions || [],
      closedTrades: paper.closedTrades || [],
      performanceClosedTrades: paper.performanceClosedTrades || paper.closedTrades || [],
      trades: paper.trades || [],
      performanceTrades: paper.performanceTrades || paper.trades || [],
      todayClosedTrades: (paper.performanceClosedTrades || []).filter(isTodayTrade),
      accountMonitor: paper.accountMonitor || null,
      dtcSnapshot: paper.dtcSnapshot || null,
      fullLedgerFile: paper.fullLedgerFile || null,
      account: paper.account || "Sim1",
    },
  };
}

function staticPath(urlPath) {
  const cleanPath = String(urlPath || "/").split("?")[0].split("#")[0] || "/";
  if (cleanPath === "/") return path.join(PUBLIC_DIR, "index.html");
  return path.join(PUBLIC_DIR, cleanPath.replace(/^\//, ""));
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] || "text/plain; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(fs.readFileSync(filePath));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function safeUploadName(name) {
  const base = path.basename(String(name || "strategy-upload.txt")).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base || "strategy-upload.txt";
}

function saveUploadedStrategyFile(file) {
  if (!file?.content) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${stamp}-${safeUploadName(file.name)}`;
  const fullPath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(fullPath, String(file.content), "utf8");
  return {
    name: file.name || fileName,
    type: file.type || "text/plain",
    size: file.size || Buffer.byteLength(String(file.content), "utf8"),
    path: fullPath,
    preview: String(file.content).slice(0, 4000),
  };
}

function readPropFirmAccounts() {
  if (!fs.existsSync(PROP_FIRM_ACCOUNTS_FILE)) {
    return {
      accounts: {},
      notes: "Confirmed prop-firm rule-set links are stored here. Unknown accounts can be confirmed from the website.",
    };
  }
  return JSON.parse(fs.readFileSync(PROP_FIRM_ACCOUNTS_FILE, "utf8"));
}

function savePropFirmAccountAssignment(payload) {
  const account = String(payload.account || "").trim();
  const ruleSetId = String(payload.ruleSetId || "").trim();
  if (!account || !ruleSetId) {
    const error = new Error("account and ruleSetId are required");
    error.statusCode = 400;
    throw error;
  }
  const current = readPropFirmAccounts();
  current.accounts = current.accounts || {};
  current.accounts[account] = {
    ruleSetId,
    provider: payload.provider || null,
    phase: payload.phase || null,
    status: payload.status || "active",
    notes: payload.notes || null,
    confirmedAtUtc: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(PROP_FIRM_ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(PROP_FIRM_ACCOUNTS_FILE, JSON.stringify(current, null, 2));
  const result = execFileSync(process.execPath, [path.join(ROOT_DIR, "dashboard", "build-manifest.mjs")], {
    encoding: "utf8",
  });
  return { ok: true, account, ruleSetId, output: result };
}

function readBacktestRequests() {
  const local = fs.existsSync(BACKTEST_REQUESTS_FILE)
    ? JSON.parse(fs.readFileSync(BACKTEST_REQUESTS_FILE, "utf8"))
    : { requests: [] };
  const synced = readPaperclipSync();
  const merged = [...(local.requests || [])];
  const existing = new Set(merged.map((request) => request.issueId || request.identifier || request.id));
  for (const request of synced.backtestRequests || []) {
    const key = request.issueId || request.identifier || request.id;
    if (key && existing.has(key)) continue;
    merged.push(request);
    if (key) existing.add(key);
  }
  merged.sort((a, b) => String(b.requestedAtUtc || "").localeCompare(String(a.requestedAtUtc || "")));
  return { requests: merged };
}

function appendBacktestRequest(input, issue) {
  const sierraConfig = readSierraSymbolConfig();
  const contract = contractForInstrumentOrSymbol(input.instrument || "MNQ", sierraConfig.paper.symbol);
  const current = readBacktestRequests();
  current.requests = current.requests || [];
  current.requests.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    strategyName: String(input.strategyName || "").trim(),
    duration: String(input.duration || "").trim(),
    timeframe: String(input.timeframe || "").trim(),
    indicatorInstructions: String(input.indicatorInstructions || "").trim(),
    optimization: input.optimization === true || input.optimization === "true",
    requestType: input.requestType || "research_find",
    backtestExecutionMode: "cache_native_sierra_historical_cache",
    cacheEngine: {
      script: BACKTEST_CACHE_SCRIPT,
      database: BACKTEST_CACHE_DB,
      instrument: contract?.instrument || input.instrument || "MNQ",
      symbol: sierraConfig.paper.symbol,
      displaySymbol: sierraConfig.paper.displaySymbol,
      source: sierraConfig.paper.dataFile,
      pointValue: contract?.pointValue ?? null,
      tickSize: contract?.tickSize ?? null,
    },
    strategyTemplateQuestions: missingStrategyTemplateQuestions(input),
    status: "requested",
    requestedAtUtc: new Date().toISOString(),
    issueId: issue.id,
    identifier: issue.identifier,
    url: paperclipWebUrl(`/OCE/issues/${issue.identifier || issue.id}`),
  });
  fs.mkdirSync(path.dirname(BACKTEST_REQUESTS_FILE), { recursive: true });
  fs.writeFileSync(BACKTEST_REQUESTS_FILE, JSON.stringify(current, null, 2));
  return current.requests[0];
}

function readPaperclipSync() {
  if (!fs.existsSync(PAPERCLIP_SYNC_FILE)) {
    return { syncedAtUtc: null, issues: [], reports: [], backtestRequests: [], artifactPaths: [] };
  }
  return JSON.parse(fs.readFileSync(PAPERCLIP_SYNC_FILE, "utf8"));
}

function isTradingWebsiteRelevant(issue, documents = []) {
  const text = [
    issue.title,
    issue.description,
    issue.identifier,
    ...documents.map((doc) => `${doc.title || ""}\n${doc.body || ""}`),
  ].join("\n").toLowerCase();
  return [
    "ocean trading",
    "sierra",
    "backtest",
    "paper trad",
    "live trad",
    "daily report",
    "ledger",
    "strategy",
    "research",
    "lucid",
    "vwap",
    "opening range",
    "rubberband",
    "lunchy",
  ].some((term) => text.includes(term));
}

function extractFirstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractArtifactPaths(text) {
  const paths = new Set();
  const source = String(text || "");
  const patterns = [
    /([A-Z]:[\\/][^\n\r`)\]]+\.(?:md|json|csv|cpp|cht|dll))/gi,
    /(?:artifact|report|file|path):\s*`?([^`\n\r]+\.(?:md|json|csv|cpp|cht|dll))`?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let candidate = String(match[1] || "").trim().replaceAll("%20", " ");
      candidate = candidate.replace(/^\[[^\]]+\]\(/, "").replace(/\)$/, "");
      candidate = candidate.replace(/^[a-z]:\s+/i, "");
      candidate = candidate.replace(/^[a-z]:\s*\[/i, "[");
      if (/^[A-Z]:[\\/]/i.test(candidate) || /^strategies[\\/]/i.test(candidate) || /^D:\//i.test(candidate)) {
        paths.add(candidate);
      }
    }
  }
  return [...paths];
}

function paperclipIssueUrl(issue) {
  return paperclipWebUrl(`/OCE/issues/${issue.identifier || issue.id}`);
}

function classifyPaperclipReport(issue, document) {
  const text = `${issue.title || ""}\n${issue.description || ""}\n${document?.title || ""}\n${document?.body || ""}`.toLowerCase();
  if (text.includes("daily report") || text.includes("paper trade daily")) return "daily_report";
  if (text.includes("backtest")) return "backtest_report";
  if (text.includes("research")) return "research_report";
  if (text.includes("ledger")) return "ledger";
  if (text.includes("strategy")) return "strategy_report";
  return "project_report";
}

function parseBacktestRequestIssue(issue) {
  const title = String(issue.title || "");
  const description = String(issue.description || "");
  const haystack = `${title}\n${description}`;
  const isBacktest =
    /backtest/i.test(title) ||
    /^Sierra Chart\/DTC backtest:/i.test(title) ||
    /run a sierra chart\/dtc backtest/i.test(description);
  if (!isBacktest) return null;
  const strategyName =
    extractFirstMatch(title, [
      /^Backtest research find:\s*(.+)$/i,
      /^Research\/backtest manual strategy:\s*(.+)$/i,
      /^Sierra Chart\/DTC backtest:\s*(.+)$/i,
    ]) ||
    extractFirstMatch(haystack, [
      /Strategy:\s*`([^`]+)`/i,
      /Strategy name\s*[-:\n]\s*`?([^\n`]+)/i,
      /research-found strategy:\s*([^\n.]+)/i,
    ]) ||
    title;
  const duration =
    extractFirstMatch(haystack, [/Requested duration:\s*([^\n.]+)/i, /Data range:\s*([^\n]+)/i]) || "";
  const timeframe =
    extractFirstMatch(haystack, [/Requested chart time frame:\s*([^\n.]+)/i, /Time ?frame:\s*([^\n.]+)/i]) || "";
  const optimization = /optimization requested[^:\n]*:\s*yes/i.test(haystack) || /optimization request/i.test(title);
  return {
    id: `paperclip-${issue.id}`,
    source: "paperclip_native",
    strategyName,
    duration,
    timeframe,
    optimization,
    requestType: /manual strategy/i.test(title) ? "manual_strategy" : "paperclip_native",
    status: issue.status || "unknown",
    requestedAtUtc: issue.createdAt || issue.startedAt || issue.updatedAt || null,
    completedAtUtc: issue.completedAt || null,
    issueId: issue.id,
    identifier: issue.identifier,
    title,
    url: paperclipIssueUrl(issue),
  };
}

async function paperclipGet(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetch(`${PAPERCLIP_API}${pathname}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Paperclip ${pathname} returned ${response.status}: ${payload?.error || payload?.message || "unknown error"}`);
  }
  return payload;
}

async function paperclipPost(pathname, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  let response;
  try {
    response = await fetch(`${PAPERCLIP_API}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Paperclip ${pathname} returned ${response.status}: ${payload?.error || payload?.message || "unknown error"}`);
  }
  return payload;
}

async function paperclipPatch(pathname, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const response = await fetch(`${PAPERCLIP_API}${pathname}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error || `Paperclip PATCH ${pathname} failed (${response.status})`);
      error.statusCode = response.status;
      error.body = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function readCeoChatState() {
  if (!fs.existsSync(CEO_CHAT_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CEO_CHAT_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCeoChatState(state) {
  fs.mkdirSync(path.dirname(CEO_CHAT_STATE_FILE), { recursive: true });
  fs.writeFileSync(CEO_CHAT_STATE_FILE, JSON.stringify(state, null, 2));
}

function ceoChatIssueUrl(issue) {
  return paperclipWebUrl(`/OCE/issues/${issue?.identifier || issue?.id}`);
}

function commentTimestampMs(comment) {
  return new Date(comment?.createdAt || comment?.createdAtUtc || 0).getTime();
}

function isCeoReplyComment(comment) {
  if (!comment) return false;
  if (comment.authorType === "agent" && comment.authorAgentId === CEO_AGENT_ID) return true;
  return comment.authorType === "user" && Boolean(comment.createdByRunId);
}

function isHumanCeoChatComment(comment) {
  return comment?.authorType === "user" && !isCeoReplyComment(comment);
}

function deriveCeoChatState(issue, comments, activeRun, liveRuns) {
  const latestRun = activeRun || liveRuns[0] || null;
  const humanComments = comments.filter(isHumanCeoChatComment);
  const latestHumanComment = humanComments[humanComments.length - 1] || null;
  const latestAgentComment = [...comments].reverse().find((comment) => isCeoReplyComment(comment)) || null;
  const agentRepliedAfterLatestHuman = latestHumanComment && latestAgentComment
    ? commentTimestampMs(latestAgentComment) > commentTimestampMs(latestHumanComment)
    : false;

  if (activeRun || latestRun?.status === "running" || latestRun?.status === "queued") {
    return {
      code: "running",
      label: latestRun?.status === "queued" ? "CEO queued" : "CEO running",
    };
  }
  if (latestRun?.status === "failed") {
    return {
      code: "run_failed",
      label: "CEO run failed; open Paperclip",
    };
  }
  if (issue.status === "in_review") {
    return {
      code: "in_review",
      label: "Waiting in Paperclip review",
    };
  }
  if (issue.status === "blocked") {
    return {
      code: "blocked",
      label: "Blocked in Paperclip",
    };
  }
  if (latestHumanComment && !agentRepliedAfterLatestHuman) {
    return {
      code: "waiting_for_reply",
      label: "Waiting for CEO response",
    };
  }
  if (agentRepliedAfterLatestHuman) {
    return {
      code: "replied",
      label: "CEO replied",
    };
  }
  return {
    code: "ready",
    label: "Ready",
  };
}

async function ensureCeoChatIssue() {
  const state = readCeoChatState();
  if (state.issueId) {
    try {
      const issue = await paperclipGet(`/issues/${state.issueId}`);
      const staleChatIssue = issue.status === "blocked" || issue.title !== CEO_CHAT_TITLE || issue.assigneeAgentId !== CEO_AGENT_ID;
      if (!staleChatIssue) {
        if (issue.status !== "done") {
          const normalized = await paperclipPatch(`/issues/${issue.id}`, {
            status: "done",
            assigneeAgentId: CEO_AGENT_ID,
          }).catch(() => issue);
          return { issue: normalized, created: false };
        }
        return { issue, created: false };
      }
    } catch {
      // Create a fresh chat issue if the stored issue id no longer resolves.
    }
  }

  const issue = await paperclipPost(`/companies/${COMPANY_ID}/issues`, {
    ...optionalProject(PROJECT_ID),
    title: CEO_CHAT_TITLE,
    description: [
      "Persistent CEO chat thread for the Ocean Trading website right-side terminal.",
      "",
      "Messages from the website are appended as comments here and wake the CEO for a concise response.",
      "Use this issue for board-level coordination, prioritisation, questions, and routing requests.",
      "",
      "This is a standing chat container. After replying to a website message, leave the issue in done state so it remains ready for the next website chat message.",
    ].join("\n"),
    priority: "medium",
    status: "done",
    assigneeAgentId: CEO_AGENT_ID,
  });
  const stableIssue = issue.status === "done"
    ? issue
    : await paperclipPatch(`/issues/${issue.id}`, { status: "done", assigneeAgentId: CEO_AGENT_ID }).catch(() => issue);
  writeCeoChatState({
    issueId: stableIssue.id,
    identifier: stableIssue.identifier,
    url: ceoChatIssueUrl(stableIssue),
    createdAtUtc: new Date().toISOString(),
  });
  return { issue: stableIssue, created: true };
}

async function ceoChatPayload() {
  const { issue, created } = await ensureCeoChatIssue();
  const issueId = issue.id || issue.identifier;
  const [commentsDesc, liveRuns, activeRun] = await Promise.all([
    paperclipGet(`/issues/${issueId}/comments?order=desc&limit=80`).catch(() => []),
    paperclipGet(`/issues/${issueId}/live-runs`).catch(() => []),
    paperclipGet(`/issues/${issueId}/active-run`).catch(() => null),
  ]);
  const comments = [...commentsDesc].reverse();
  const humanComments = comments.filter(isHumanCeoChatComment);
  const latestHumanComment = humanComments[humanComments.length - 1] || null;
  const agentRepliedAfterLatestHuman = latestHumanComment
    ? comments.some((comment) =>
        isCeoReplyComment(comment)
        && new Date(comment.createdAt || 0).getTime() > new Date(latestHumanComment.createdAt || 0).getTime()
      )
    : false;
  let normalizedIssue = issue;
  if ((issue.status !== "done" || issue.assigneeAgentId !== CEO_AGENT_ID) && (!activeRun || agentRepliedAfterLatestHuman)) {
    normalizedIssue = await paperclipPatch(`/issues/${issueId}`, {
      status: "done",
      assigneeAgentId: CEO_AGENT_ID,
    }).catch(() => issue);
  }
  return {
    ok: true,
    created,
    ceoAgentId: CEO_AGENT_ID,
    issue: {
      id: normalizedIssue.id,
      identifier: normalizedIssue.identifier,
      title: normalizedIssue.title,
      status: normalizedIssue.status,
      url: ceoChatIssueUrl(normalizedIssue),
    },
    chatState: deriveCeoChatState(normalizedIssue, comments, activeRun, liveRuns),
    comments,
    liveRuns,
    activeRun,
    fetchedAtUtc: new Date().toISOString(),
  };
}

async function postCeoChatMessage(input) {
  const body = String(input?.message || "").trim();
  if (!body) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }
  if (body.length > 4000) {
    const error = new Error("message must be 4000 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  const { issue } = await ensureCeoChatIssue();
  const issueId = issue.id || issue.identifier;
  const comment = await paperclipPost(`/issues/${issueId}/comments`, {
    body,
    reopen: true,
    interrupt: false,
  });
  let wakeup = null;
  let wakeupError = null;
  try {
    wakeup = await paperclipPost(`/agents/${CEO_AGENT_ID}/wakeup?companyId=${COMPANY_ID}`, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "ocean_trading_website_ceo_chat",
      payload: {
        issueId,
        commentId: comment.id,
        origin: "ocean-trading-dashboard",
      },
      idempotencyKey: `ceo-chat-${comment.id || Date.now()}`,
    }, { timeoutMs: 20000 });
  } catch (error) {
    wakeupError = String(error?.message || error);
  }
  const payload = await ceoChatPayload();
  return {
    ...payload,
    postedComment: comment,
    wakeup,
    wakeupError,
  };
}

async function syncPaperclipNative(options = {}) {
  const force = options.force === true;
  if (!force && Date.now() - lastPaperclipSyncAt < PAPERCLIP_SYNC_TTL_MS && fs.existsSync(PAPERCLIP_SYNC_FILE)) {
    return readPaperclipSync();
  }
  lastPaperclipSyncAt = Date.now();
  const issues = await paperclipGet(companyIssuesPath({ limit: 100, projectId: PROJECT_ID }));
  const syncedIssues = [];
  const reports = [];
  const artifactPaths = new Set();
  const backtestRequests = [];

  for (const issue of issues) {
    let documents = [];
    try {
      documents = await paperclipGet(`/issues/${issue.identifier || issue.id}/documents?includeSystem=true`);
    } catch {
      documents = [];
    }
    if (!isTradingWebsiteRelevant(issue, documents)) continue;
    const request = parseBacktestRequestIssue(issue);
    if (request) backtestRequests.push(request);
    const issueArtifacts = new Set(extractArtifactPaths(`${issue.description || ""}\n${documents.map((doc) => doc.body || "").join("\n")}`));
    for (const artifact of issueArtifacts) artifactPaths.add(artifact);
    syncedIssues.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId,
      assigneeAgentId: issue.assigneeAgentId,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      completedAt: issue.completedAt,
      url: paperclipIssueUrl(issue),
      artifactPaths: [...issueArtifacts],
      documents: documents.map((doc) => ({
        key: doc.key,
        title: doc.title,
        updatedAt: doc.updatedAt,
      })),
    });
    for (const doc of documents) {
      const body = String(doc.body || "");
      const reportType = classifyPaperclipReport(issue, doc);
      if (reportType === "project_report" && !/(report|backtest|research|ledger|daily|strategy)/i.test(`${doc.title || ""}\n${body}`)) continue;
      reports.push({
        id: `${issue.id}:${doc.key}`,
        issueId: issue.id,
        identifier: issue.identifier,
        issueTitle: issue.title,
        issueStatus: issue.status,
        documentKey: doc.key,
        title: doc.title,
        type: reportType,
        updatedAtUtc: doc.updatedAt,
        url: `${paperclipIssueUrl(issue)}#document-${doc.key}`,
        artifactPaths: extractArtifactPaths(body),
        textSnippet: body.slice(0, 1200),
      });
    }
  }

  const payload = {
    syncedAtUtc: new Date().toISOString(),
    source: PAPERCLIP_API,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    issues: syncedIssues,
    reports,
    backtestRequests,
    artifactPaths: [...artifactPaths],
  };
  fs.mkdirSync(path.dirname(PAPERCLIP_SYNC_FILE), { recursive: true });
  fs.writeFileSync(PAPERCLIP_SYNC_FILE, JSON.stringify(payload, null, 2));
  return payload;
}

async function createBacktestIssue(input) {
  const strategyName = String(input.strategyName || "").trim();
  if (!strategyName) throw new Error("Missing strategy name");
  const sierraConfig = readSierraSymbolConfig();
  const requestedInstrument = String(input.instrument || "MNQ").trim().toUpperCase();
  const contract = contractForInstrumentOrSymbol(requestedInstrument, sierraConfig.paper.symbol);
  const template = readStrategyTemplate();
  const templateQuestions = missingStrategyTemplateQuestions(input);
  const isManualStrategy = input.requestType === "manual_strategy";
  const duration = String(input.duration || "3 months").trim();
  const timeframe = String(input.timeframe || "1 minute").trim();
  const indicatorInstructions = String(input.indicatorInstructions || "").trim();
  const suggestedStrategy = String(input.suggestedStrategy || "").trim();
  const contractQuantity = String(input.contractQuantity || "").trim();
  const tradeDirection = String(input.tradeDirection || "").trim();
  const sessionWindows = String(input.sessionWindows || "").trim();
  const userTimezone = String(input.userTimezone || "Europe/London").trim();
  const strategyTimezone = String(input.strategyTimezone || "Europe/London chart time").trim();
  const maximumRiskDollars = String(input.maximumRiskDollars || "").trim();
  const rulesSummary = String(input.rulesSummary || "").trim();
  const optimization = input.optimization === true || input.optimization === "true";
  const notes = String(input.notes || "").trim();
  const uploaded = saveUploadedStrategyFile(input.uploadedFile);
  const description = [
    `Run a Sierra Chart/DTC backtest for ${isManualStrategy ? "manual strategy request" : "research-found strategy"}: ${strategyName}.`,
    "",
    `Backtest request source: Ocean Trading website ${isManualStrategy ? "Manual Strategy Request" : "Research Finds"} flow.`,
    "Backtest execution mode: use the Ocean Trading cache-native backtest platform, not the older one-off candidate metric files.",
    `Cache engine script: ${BACKTEST_CACHE_SCRIPT}`,
    `Cache engine database: ${BACKTEST_CACHE_DB}`,
    `Current paper data symbol: ${sierraConfig.paper.symbol} (${sierraConfig.paper.displaySymbol || sierraConfig.paper.symbol}).`,
    `Current Sierra source file for new imports: ${sierraConfig.paper.dataFile}.`,
    `Instrument contract registry: ${INSTRUMENT_CONTRACTS_FILE}.`,
    `Resolved contract: ${contract ? `${contract.instrument} - ${contract.name}; ${contract.pointValue} currency per point; tick ${contract.tickSize}; tick value ${contract.tickValue}` : `not found for ${requestedInstrument}/${sierraConfig.paper.symbol}; resolve before calculating P&L or risk`}.`,
    "Strategy source must specify contract quantity only. Do not add a manual value-per-point input to Sierra Chart strategies; resolve point value from the chart/import symbol and the instrument registry.",
    `Requested duration: ${duration}.`,
    `Requested chart time frame: ${timeframe}.`,
    `Requested instrument: ${requestedInstrument}.`,
    contractQuantity ? `Requested contract quantity: ${contractQuantity}.` : "Requested contract quantity: not supplied; ask before coding or backtesting if quantity cannot be inferred.",
    tradeDirection ? `Requested trade direction: ${tradeDirection}.` : "Requested trade direction: not supplied; ask whether the strategy is long-only, short-only, or both.",
    sessionWindows ? `Requested session/time window: ${sessionWindows}.` : "Requested session/time window: not supplied; ask before coding if the strategy depends on time of day.",
    `Operator living timezone: ${userTimezone}.`,
    `Requested strategy timezone: ${strategyTimezone}.`,
    "Timezone rule: use Europe/London chart-time inputs by default. If the trading idea references US market time, convert defaults to UK/London and handle US/UK daylight-saving mismatch weeks automatically inside the Sierra Chart strategy.",
    maximumRiskDollars ? `Maximum dollars the operator is willing to risk: $${maximumRiskDollars}.` : "Maximum dollar risk was not supplied; ask before coding or backtesting if risk cannot be inferred safely.",
    suggestedStrategy ? `Operator-suggested strategy/variation: ${suggestedStrategy}.` : "Operator-suggested strategy/variation: none.",
    rulesSummary ? `Operator entry/exit/stop/target summary: ${rulesSummary}.` : "Operator entry/exit/stop/target summary: not supplied; ask template questions if these are not clear from attached research.",
    indicatorInstructions ? `Operator indicator/parameter instructions: ${indicatorInstructions}.` : "Operator indicator/parameter instructions: use the strategy's current documented indicator set.",
    uploaded ? `Uploaded strategy/reference file: ${uploaded.path}` : "Uploaded strategy/reference file: none.",
    `Optimization requested through Strategy Builder: ${optimization ? "yes" : "no"}.`,
    "",
    "Ocean Trading strategy template:",
    `Template file: ${STRATEGY_TEMPLATE_FILE}`,
    `Required fields: ${(template.requiredFields || []).map((field) => field.label || field.key).join("; ")}.`,
    templateQuestions.length
      ? `Missing information to ask the operator before coding/promoting if it cannot be inferred safely:\n${templateQuestions.map((question) => `- ${question}`).join("\n")}`
      : "Template completeness check: no mandatory operator questions detected from the submitted request.",
    "",
    "Instructions:",
    "- Before backtesting, research any uploaded script or suggested strategy details enough to identify indicators, parameters, session filters, risk placement, and Sierra Chart implementation requirements.",
    "- Use `backtesting/cache_platform.py ensure-range` for the requested duration/timeframe/symbol. If the requested historical range is already cached, reuse it. If it is partially missing, import only the missing Sierra `.scid` range from the current source file.",
    "- Run strategy iterations through the cache-native backtest engine so parameter changes reuse the cached data rather than reloading Sierra data each time.",
    "- Persist the backtest run and iteration outputs through the cache engine/results artifacts so `/api/backtest-engine-runs` and the Strategies page can display them.",
    "- Apply Ocean Trading risk rules, Lucid Flex 50K governance, and the current strategy acceptance checks.",
    "- Report net profit, drawdown, win rate, profit factor, trade count, long/short split, and whether the strategy is rejected, needs revision, or can move toward paper trading.",
    optimization
      ? "- If the first result is poor, send one batched Sierra Chart strategy optimization request to Strategy Builder within the approved optimization budget."
      : "- Do not optimize unless the board later approves optimization.",
    uploaded
      ? `\nUploaded file preview:\n\`\`\`\n${uploaded.preview}\n\`\`\``
      : "",
    notes ? `\nOperator notes:\n${notes}` : "",
  ].filter(Boolean).join("\n");

  const response = await fetch(`${PAPERCLIP_API}/companies/${COMPANY_ID}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...optionalProject(PROJECT_ID),
      title: `${isManualStrategy ? "Research/backtest manual strategy" : "Backtest research find"}: ${strategyName}`,
      description,
      priority: "medium",
      assigneeAgentId: BACKTESTER_AGENT_ID,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Paperclip returned ${response.status}`);
  }
  return payload;
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (requestUrl.pathname === "/api/workflow" || requestUrl.pathname.startsWith("/api/workflow/")) {
    if (workflowBackend) {
      void workflowBackend.handle(req, res, requestUrl);
    } else {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: { code: workflowEnrollmentRequired ? 'WAYNE_LOCAL_ENROLLMENT_REQUIRED' : workflowStartupFailed ? "WORKFLOW_CONFIG_BLOCKED" : "WORKFLOW_DISABLED", message: "TEST workflow backend is unavailable; existing ledger remains independent." } }));
    }
    return;
  }
  const blockedConfluenceRoutes = new Set([
    "/hmm-strategy.html",
    "/api/hmm-strategy-monitor",
    "/api/hmm-strategy-monitor/evaluations",
    "/api/hmm-strategy-monitor/workflow-b/resolve-blocker",
    "/api/markov-regime",
    "/api/markov-regime/rebuild",
  ]);
  const routeKey = `${req.method || "GET"} ${requestUrl.pathname}`;
  if (blockedConfluenceRoutes.has(requestUrl.pathname) || blockedConfluenceRoutes.has(routeKey)) {
    if (requestUrl.pathname === "/hmm-strategy.html") {
      res.writeHead(302, { Location: "/confluence.html", "Cache-Control": "no-store" });
      res.end();
    } else {
      res.writeHead(410, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: false,
        error: "Retired route",
        message: "Hegel's Hermes and Markov artifacts are reserved for the Ocean Trading Confluence page only.",
        redirect: "/confluence.html",
      }));
    }
    return;
  }

  if (req.url === "/api/manifest") {
    Promise.resolve()
      .then(() => buildManifest({ skipRebuildCheck: true, preferFile: true }))
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: "Manifest build failed",
            message: String(error?.message || error),
          }),
        );
      });
    return;
  }

  if (req.url === "/api/rebuild") {
    Promise.resolve()
      .then(() => rebuildManifestAsync())
      .then(() => buildManifest({ skipRebuildCheck: true, preferFile: true }))
      .then((payload) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, manifest: JSON.parse(payload) }));
      })
      .catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: "Manifest rebuild failed",
          message: String(error?.message || error),
        }),
      );
      });
    return;
  }

  if (req.url === "/api/paperclip-sync") {
    Promise.resolve()
      .then(() => syncPaperclipNative({ force: true }))
      .then((sync) => {
        const result = execFileSync(process.execPath, [path.join(ROOT_DIR, "dashboard", "build-manifest.mjs")], {
          encoding: "utf8",
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, sync, output: result }));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/database") {
    try {
      buildManifest();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(databaseInfo()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  const calendarFreshnessMatch = req.url.match(/^\/api\/(paper|live)-calendar-freshness$/);
  if (calendarFreshnessMatch) {
    try {
      const payload = dashboardCalendarFreshnessInfo(calendarFreshnessMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }

  if (req.url === "/api/historical-cache") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(historicalCacheInfo()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error), datasets: [] }));
    }
    return;
  }

  if (req.url === "/api/backtest-engine-runs") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(backtestEngineRuns()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error), runs: [] }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/hmm-strategy-monitor" && req.method === "GET") {
    hmmStrategyMonitorInfo()
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (requestUrl.pathname === "/api/hmm-strategy-monitor/evaluations" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => createHmmStrategyEvaluationIssue(body))
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (requestUrl.pathname === "/api/hmm-strategy-monitor/workflow-b/resolve-blocker" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => resolveHmmWorkflowBlocker(body))
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: false,
          error: String(error?.message || error),
          validation: error?.validation || null,
        }));
      });
    return;
  }

  if (req.url === "/api/markov-regime") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(markovRegimeInfo()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/markov-regime/rebuild" && req.method === "POST") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rebuildMarkovRegime()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/confluence-report") {
    try {
      const payload = confluenceReportInfo();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/confluence-accuracy") {
    try {
      const payload = runConfluenceAccuracyWorker(["--mode", "latest", "--days", "10", "--end", "2026-06-02", "--exclude", "2026-06-03"]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/confluence-accuracy/backfill" && req.method === "POST") {
    try {
      const payload = runConfluenceAccuracyWorker(["--mode", "backfill", "--days", "10", "--end", "2026-06-02", "--exclude", "2026-06-03"]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/confluence-report/rebuild" && req.method === "POST") {
    try {
      const payload = rebuildConfluenceReport();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/instrument-contracts") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(readInstrumentContracts()));
    return;
  }

  if (req.url === "/api/strategy-template") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(readStrategyTemplate()));
    return;
  }

  if (req.url === "/api/cme-holiday-calendar") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(fs.existsSync(CME_HOLIDAY_CALENDAR_FILE)
      ? fs.readFileSync(CME_HOLIDAY_CALENDAR_FILE, "utf8")
      : JSON.stringify({ generatedAtUtc: null, holidays: [] }));
    return;
  }

  if (req.url === "/api/monitor/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(monitorState()));
    return;
  }

  if (req.url === "/api/monitor/start" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(startMonitor()));
    return;
  }

  if (req.url === "/api/monitor/stop" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(stopMonitor()));
    return;
  }

  if (req.url === "/api/monitor/reconcile" && req.method === "POST") {
    rebuildManifestAsync().then((result) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, output: result, monitor: monitorState() }));
    }).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    });
    return;
  }

  if (req.url === "/api/replay-monitor/clear" && req.method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        const payload = await clearReplayMonitorSession(body?.replayAccountId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/open-trades") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(openTradesPayload()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/site-config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      paperclip: {
        baseUrl: paperclipWebUrl(),
        dashboardUrl: paperclipWebUrl("/OCE/dashboard"),
      },
    }));
    return;
  }

  if (req.url === "/api/ceo-chat" && req.method === "GET") {
    ceoChatPayload()
      .then((payload) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(error.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/ceo-chat/message" && req.method === "POST") {
    readJsonBody(req)
      .then(postCeoChatMessage)
      .then((payload) => {
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
      })
      .catch((error) => {
        res.writeHead(error.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/backtest-requests") {
    Promise.resolve()
      .then(() => syncPaperclipNative({ force: false }))
      .catch((error) => {
        console.warn(`Paperclip native sync skipped: ${String(error?.message || error)}`);
      })
      .then(() => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readBacktestRequests()));
      })
      .catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/prop-firm-account-assignment" && req.method === "POST") {
    readJsonBody(req)
      .then(savePropFirmAccountAssignment)
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      })
      .catch((error) => {
        res.writeHead(error.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (req.url === "/api/backtest-request" && req.method === "POST") {
    readJsonBody(req)
      .then((input) => {
        req.backtestInput = input;
        return createBacktestIssue(input);
      })
      .then((issue) => {
        const requestRecord = appendBacktestRequest(req.backtestInput || {}, issue);
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: paperclipWebUrl(`/OCE/issues/${issue.identifier || issue.id}`),
          request: requestRecord,
        }));
      })
      .catch((error) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      });
    return;
  }

  if (requestUrl.pathname === "/improvement" || requestUrl.pathname.startsWith("/improvement/")) {
    if (!/^(?:GET|HEAD)$/.test(req.method || "GET") || !/^\/improvement(?:\/(?:dashboard|strategies|runs|cases|approvals|artifacts|history)(?:\/[A-Za-z0-9_.:-]+)?)?\/?$/.test(requestUrl.pathname)) {
      res.writeHead(404); res.end("Workflow page not found"); return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Referrer-Policy", "same-origin");
    sendFile(res, path.join(PUBLIC_DIR, "workflow/index.html"));
    return;
  }

  if (req.url.startsWith("/")) {
    const filePath = staticPath(req.url);
    sendFile(res, filePath);
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.on("close", () => workflowBackend?.close());
installWebsiteControl(server, __dirname, Boolean(workflowBackend));

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    console.log(`Ocean Trading local dashboard running on http://localhost:${PORT}`);
    console.log("Manifest endpoint: /api/manifest");
    console.log("Rebuild endpoint: /api/rebuild");
    if (monitorStartsByDefault()) {
      try {
        const state = startMonitor();
        console.log(`Monitor default: on${state.pid ? ` (pid ${state.pid})` : ""}`);
      } catch (error) {
        console.error(`Monitor default start failed: ${error?.message || error}`);
      }
    } else {
      console.log("Monitor default: off unless OCEAN_TRADING_MONITOR_DEFAULT_ON is enabled");
    }
  });
}

export {
  server,
  resolveHmmWorkflowBlocker,
  summarizeHmmEvaluationJob,
  summarizeHmmWorkflowBlockerAction,
  unresolvedPaperclipBlockers,
};
