import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadVwapPaperSim1EmailConfig,
  scanVwapPaperSim1EmailEvents,
} from "./vwap-paper-sim1-email-monitor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "monitor-state.json");
const CLOSED_TRADE_EMAIL_STATE_FILE = path.join(DATA_DIR, "closed-trade-email-state.json");
const CLOSED_TRADE_EMAIL_LOG_FILE = path.join(DATA_DIR, "closed-trade-email-alerts.json");
const CLOSED_TRADE_EMAIL_PENDING_FILE = path.join(DATA_DIR, "closed-trade-email-pending.json");
const LAST_CLOSED_TRADE_EMAIL_REQUEST_FILE = path.join(DATA_DIR, "last-closed-trade-email-request.json");
const CLOSED_TRADE_EMAIL_CONFIG_FILE = path.join(__dirname, "config", "closed-trade-email-alerts.json");
const VWAP_PAPER_SIM1_EMAIL_CONFIG_FILE = path.join(__dirname, "config", "vwap-paper-sim1-email-alerts.json");
const VWAP_PAPER_SIM1_EMAIL_STATE_FILE = path.join(DATA_DIR, "vwap-paper-sim1-email-state.json");
const DASHBOARD_DATA_FILE = path.join(__dirname, "dashboard-data.json");
const BUILD_SCRIPT = path.join(__dirname, "build-manifest.mjs");
const DTC_SNAPSHOT_SCRIPT = path.join(__dirname, "dtc-snapshot.mjs");
const SIERRA_SYMBOL_CONFIG_FILE = path.join(__dirname, "config", "sierra-symbols.json");
const PATRADING_LIVE_SQLITE_FILE =
  process.env.PATRADING_LIVE_SQLITE_FILE ||
  "E:\\SierraChart-LiveTrading\\Data\\TradeTelemetry\\Live\\TradeTelemetry_Live.sqlite";
const PATRADING_PAPER_SQLITE_FILE =
  process.env.PATRADING_PAPER_SQLITE_FILE ||
  "D:\\Trading\\SierraChart-PaperTrading\\Data\\TradeTelemetry\\PaperTrading\\TradeTelemetry_PaperTrading.sqlite";
const PATRADING_REPLAY_SQLITE_FILE =
  process.env.PATRADING_REPLAY_SQLITE_FILE ||
  "D:\\Trading\\SierraChart-Replay\\Data\\TradeTelemetry\\Replay\\TradeTelemetry_Replay.sqlite";
const LIVE_TRADING_CLEAN_START_FILE = path.join(DATA_DIR, "live-trading-clean-start.json");
const EXCLUDED_LIVE_TRADE_FILES_FILE = path.join(DATA_DIR, "excluded-live-trade-files.json");
const INTERVAL_MS = Number(process.env.OCEAN_MONITOR_INTERVAL_MS || 5000);
const EMAIL_QUEUE_FILE = path.join(DATA_DIR, "outbound-email-queue.json");
const EMAIL_LOG_FILE = path.join(DATA_DIR, "outbound-email-log.json");
const MAX_RECENT_EVENTS = 20;

let lastSignature = "";
let scanCount = 0;
let importCount = 0;
let stopping = false;
let scanInFlight = false;

function readJson(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function normalizeRecentEvents(events) {
  return Array.isArray(events) ? events.slice(-MAX_RECENT_EVENTS) : [];
}

function createMonitorEvent(level, action, message, details = {}) {
  return {
    atUtc: new Date().toISOString(),
    level,
    action,
    message,
    ...details,
  };
}

function readMonitorState() {
  return readJson(STATE_FILE, { running: false, status: "stopped", recentEvents: [] }) || { running: false, status: "stopped", recentEvents: [] };
}

function closedTradeEmailConfig() {
  const fallback = {
    enabled: false,
    modes: ["paper", "live"],
    recipient: "wayne.vanheerden@gmail.com",
    owner: "Wayne van Heerden",
    subjectPrefix: "Ocean Trading closed trade",
    deliveryPath: "immediate_reporter_with_hourly_retry",
    deliveryAgent: "Riley - Connection Manager",
    paperclipApiBaseUrl: "http://127.0.0.1:3100/api",
    paperclipEmailRelayRoutineId: "fa42e0f2-f4dd-4bf3-aa5d-343ec1ceeb2d",
    paperclipImmediateReporterRun: true,
    paperclipTriggerTimeoutMs: 10000,
    baselineExistingTradesOnFirstRun: true,
    baselineExistingTradesOnModeEnable: true,
  };
  return { ...fallback, ...(readJson(CLOSED_TRADE_EMAIL_CONFIG_FILE, {}) || {}) };
}

function tradeActivityLogDir(instance) {
  if (!instance) return null;
  return instance.tradeActivityLogDir || (instance.root ? path.join(instance.root, "TradeActivityLogs") : null);
}

function readSierraInstances({ configFile }) {
  const configured = readJson(configFile, {}) || {};
  return {
    replay: {
      root: "D:\\Trading\\SierraChart-Replay",
      tradeActivityLogDir: "D:\\Trading\\SierraChart-Replay\\TradeActivityLogs",
      patradingSqliteFile: PATRADING_REPLAY_SQLITE_FILE,
      ...(configured.replay || {}),
    },
    paper: {
      root: "D:\\Trading\\SierraChart-PaperTrading",
      tradeActivityLogDir: "D:\\Trading\\SierraChart-PaperTrading\\TradeActivityLogs",
      patradingSqliteFile: PATRADING_PAPER_SQLITE_FILE,
      ...(configured.paper || {}),
    },
    live: {
      root: "E:\\SierraChart-LiveTrading",
      tradeActivityLogDir: "E:\\SierraChart-LiveTrading\\TradeActivityLogs",
      patradingSqliteFile: PATRADING_LIVE_SQLITE_FILE,
      ...(configured.live || {}),
    },
  };
}

function loadEmailConnectorState() {
  const queue = readJson(EMAIL_QUEUE_FILE, { requests: [] }) || { requests: [] };
  const log = readJson(EMAIL_LOG_FILE, { requests: [] }) || { requests: [] };
  return {
    queueFile: EMAIL_QUEUE_FILE,
    logFile: EMAIL_LOG_FILE,
    queue: { requests: Array.isArray(queue.requests) ? queue.requests : [] },
    log: { requests: Array.isArray(log.requests) ? log.requests : [] },
  };
}

function queueEmailRequest(request) {
  const state = loadEmailConnectorState();
  const existing = state.queue.requests.find((item) => item?.id === request.id);
  const queued = {
    ...request,
    deliveryPath: request.deliveryPath || "local_queue_requires_gmail_configuration",
    deliveryAgent: request.deliveryAgent || "Ocean - Website",
    status: "queued",
    createdAtUtc: request.createdAtUtc || new Date().toISOString(),
    note: "Prepared locally by the website monitor. Gmail delivery requires explicit operator approval and connector configuration.",
  };
  const nextRequests = existing
    ? state.queue.requests.map((item) => (item?.id === request.id ? { ...item, ...queued } : item))
    : [...state.queue.requests, queued];
  writeJson(EMAIL_QUEUE_FILE, { updatedAtUtc: new Date().toISOString(), requests: nextRequests.slice(-500) });
  return { request: queued, queueFile: EMAIL_QUEUE_FILE, logFile: EMAIL_LOG_FILE };
}

function accountBalanceForClosedTradeEmail(manifest, mode, trade) {
  const modeData = manifest?.tradingModes?.[mode] || {};
  const account = trade?.account || null;
  const accountRows = [
    ...(Array.isArray(modeData.accountMonitor?.rows) ? modeData.accountMonitor.rows : []),
    ...(Array.isArray(modeData.dtcSnapshot?.balances) ? modeData.dtcSnapshot.balances : []),
  ];
  const match = accountRows.find((row) => String(row?.account || row?.tradeAccount || "") === String(account || ""));
  return match || null;
}

function paperTradeAccountBalance(manifest, account) {
  const rows = manifest?.tradingModes?.paper?.accountMonitor?.rows;
  if (!Array.isArray(rows)) return null;
  const match = rows.find((row) => String(row?.account || row?.tradeAccount || "") === String(account || ""));
  if (!match) return null;
  const candidates = [
    match.currentCashBalanceDollars,
    match.accountValueDollars,
    match.availableFundsForNewPositionsDollars,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

function accountValue(accountTotal) {
  if (accountTotal === null || accountTotal === undefined) return null;
  if (typeof accountTotal === "number" && Number.isFinite(accountTotal)) return accountTotal;
  const candidates = [
    accountTotal.currentCashBalanceDollars,
    accountTotal.accountValueDollars,
    accountTotal.availableFundsForNewPositionsDollars,
    accountTotal.balanceDollars,
    accountTotal.dailyProfitLossDollars,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function closedTradeHistoryForMode(manifest, mode) {
  const modeData = manifest?.tradingModes?.[mode] || {};
  if (mode === "paper") return modeData.performanceClosedTrades || modeData.strategyClosedTrades || modeData.closedTrades || [];
  return modeData.performanceClosedTrades || modeData.closedTrades || [];
}

function summarizeClosedTradeHistory(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const longTrades = list.filter((trade) => String(trade?.side || "").toLowerCase() === "long");
  const shortTrades = list.filter((trade) => String(trade?.side || "").toLowerCase() === "short");
  const longPnl = longTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const shortPnl = shortTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const netPnl = list.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const wins = list.filter((trade) => Number(trade?.realizedPnlDollars) > 0).length;
  const losses = list.filter((trade) => Number(trade?.realizedPnlDollars) < 0).length;
  return {
    count: list.length,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    wins,
    losses,
    longPnl,
    shortPnl,
    netPnl,
  };
}

function resolvedClosedTradePnl(mode, trade, manifest = null) {
  const raw = Number(trade?.realizedPnlDollars ?? trade?.pnl ?? 0);
  if (String(mode || "").toLowerCase() !== "paper") return raw;
  const paperDaily = Number(manifest?.tradingModes?.paper?.dailyNetProfitLossDollars);
  if (Number.isFinite(paperDaily)) return Number(paperDaily.toFixed(2));
  return raw;
}

function buildClosedTradeEmail(mode, trade, accountTotal, config, manifest = null) {
  const realized = resolvedClosedTradePnl(mode, trade, manifest);
  const subject = `${config.subjectPrefix || "Ocean Trading closed trade"}: ${String(mode || "").toUpperCase()} ${trade?.symbol || "unknown"} ${money(realized)}`;
  const history = closedTradeHistoryForMode(manifest, mode);
  const summary = summarizeClosedTradeHistory(history);
  if (String(mode || "").toLowerCase() === "paper" && Number.isFinite(realized)) {
    summary.netPnl = Number(realized.toFixed(2));
    if (summary.shortTrades === 0 && summary.longTrades > 0) {
      summary.longPnl = Number(realized.toFixed(2));
    }
  }
  const balance = accountValue(accountTotal);
  const body = [
    "OCEAN TRADING CLOSED TRADE REPORT",
    `${String(mode || "unknown").toUpperCase()} | ${trade?.symbol || "unknown"} | ${trade?.strategyName || "Manual Trade"}`,
    `Trade P/L: ${money(realized)}`,
    "",
    "TRADE DETAILS",
    `Mode: ${mode || "unknown"}`,
    `Account: ${trade?.account || "unknown"}`,
    `Side: ${trade?.side || "unknown"}`,
    `Quantity: ${trade?.quantity ?? "unknown"}`,
    `Open time: ${trade?.entryAtUtc || "unknown"}`,
    `Closed time: ${trade?.exitAtUtc || trade?.tradeDateUtc || "unknown"}`,
    `Entry price: ${trade?.entryPrice ?? "unknown"}`,
    `Exit price: ${trade?.exitPrice ?? "unknown"}`,
    "",
    "SUMMARY",
    `Total trade account balance: ${balance === null ? "n/a" : money(balance)}`,
    `Closed trades in stream: ${summary.count}`,
    `Long trades: ${summary.longTrades}`,
    `Short trades: ${summary.shortTrades}`,
    `Realized long P/L: ${money(summary.longPnl)}`,
    `Realized short P/L: ${money(summary.shortPnl)}`,
    `Realized net P/L: ${money(summary.netPnl)}`,
    "",
    "ACCOUNT SNAPSHOT",
    accountTotal ? JSON.stringify(accountTotal, null, 2) : "No account snapshot available.",
    "",
    "SOURCE",
    trade?.sourceFile || "unknown",
    "",
    String(mode || "").toLowerCase() === "paper"
      ? "Note: paper mode uses the dashboard-reconciled daily net P/L override for the top-line trade P/L and net summary; the side splits still reflect the raw Sierra trade stream."
      : "Note: summary totals are taken from the raw Sierra trade stream for this mode.",
    "",
    "Prepared locally by the Ocean Trading website monitor. Delivery requires explicit approval.",
  ].join("\n");
  return { subject, body, recipient: config.recipient || null };
}

function writeState(patch, event = null) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previous = readMonitorState();
  const recentEvents = normalizeRecentEvents(previous.recentEvents);
  const nextEvents = event ? normalizeRecentEvents([...recentEvents, event]) : recentEvents;
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        ...previous,
        pid: process.pid,
        intervalMs: INTERVAL_MS,
        updatedAtUtc: new Date().toISOString(),
        ...patch,
        recentEvents: nextEvents,
      },
      null,
      2,
    ),
  );
}

function hashTrade(mode, trade) {
  return createHash("sha256")
    .update([
      mode,
      trade.account || "",
      trade.symbol || "",
      trade.strategyName || "",
      trade.side || "",
      trade.entryAtUtc || "",
      trade.exitAtUtc || trade.tradeDateUtc || "",
      trade.entryPrice ?? "",
      trade.exitPrice ?? "",
      trade.quantity ?? "",
      trade.realizedPnlDollars ?? "",
      trade.internalOrderId || "",
      trade.sourceFile || "",
    ].join("|"))
    .digest("hex");
}

function closedTradesFromManifest(manifest, modes) {
  const rows = [];
  for (const mode of modes) {
    const performanceClosedTrades = manifest?.tradingModes?.[mode]?.performanceClosedTrades;
    const closedTrades = manifest?.tradingModes?.[mode]?.closedTrades;
    const trades = [
      ...(Array.isArray(performanceClosedTrades) ? performanceClosedTrades : []),
      ...(Array.isArray(closedTrades) ? closedTrades : []),
    ];
    for (const trade of trades) {
      if (!trade?.exitAtUtc && !trade?.tradeDateUtc) continue;
      rows.push({
        mode,
        id: hashTrade(mode, trade),
        sortTime: trade.exitAtUtc || trade.tradeDateUtc || "",
        trade,
      });
    }
  }
  return rows.sort((a, b) => String(a.sortTime).localeCompare(String(b.sortTime)));
}

function queueClosedTradeEmailFallback(config, entry, accountTotal, email, reason, error = null) {
  const pending = readJson(CLOSED_TRADE_EMAIL_PENDING_FILE, { alerts: [] }) || { alerts: [] };
  const alerts = pending.alerts || [];
  const existingIndex = alerts.findIndex((alert) => alert.id === entry.id);
  const fallbackAlert = {
    id: entry.id,
    createdAtUtc: new Date().toISOString(),
    queuedBy: "website_monitor",
    queueReason: reason,
    mode: entry.mode,
    trade: entry.trade,
    accountTotal,
    recipient: config.recipient,
    deliveryPath: config.deliveryPath,
    deliveryAgent: config.deliveryAgent,
    email,
    lastError: error ? String(error?.message || error) : null,
  };
  if (existingIndex >= 0) {
    alerts[existingIndex] = {
      ...alerts[existingIndex],
      ...fallbackAlert,
      createdAtUtc: alerts[existingIndex]?.createdAtUtc || fallbackAlert.createdAtUtc,
    };
  } else {
    alerts.push({
      ...fallbackAlert,
    });
  }
  writeJson(CLOSED_TRADE_EMAIL_PENDING_FILE, {
    updatedAtUtc: new Date().toISOString(),
    alerts: alerts.slice(-500),
  });
  return {
    sent: false,
    queued: true,
    reason: "connector_queue_handoff_failed",
    deliveryPath: config.deliveryPath,
    deliveryAgent: config.deliveryAgent,
    error: error ? String(error?.message || error) : null,
  };
}

function removePendingClosedTradeAlert(alertId) {
  const pending = readJson(CLOSED_TRADE_EMAIL_PENDING_FILE, { alerts: [] }) || { alerts: [] };
  const alerts = Array.isArray(pending.alerts) ? pending.alerts : [];
  const nextAlerts = alerts.filter((alert) => alert?.id !== alertId);
  if (nextAlerts.length === alerts.length && pending.updatedAtUtc) return;
  writeJson(CLOSED_TRADE_EMAIL_PENDING_FILE, {
    updatedAtUtc: new Date().toISOString(),
    alerts: nextAlerts.slice(-500),
  });
}

function upsertClosedTradeEmailLog(entry) {
  const log = readJson(CLOSED_TRADE_EMAIL_LOG_FILE, { alerts: [] }) || { alerts: [] };
  log.updatedAtUtc = new Date().toISOString();
  const alerts = Array.isArray(log.alerts) ? log.alerts : [];
  const existingIndex = alerts.findIndex((alert) => alert?.id === entry.id);
  if (existingIndex >= 0) {
    alerts[existingIndex] = {
      ...alerts[existingIndex],
      ...entry,
      createdAtUtc: alerts[existingIndex]?.createdAtUtc || entry.createdAtUtc,
    };
  } else {
    alerts.push(entry);
  }
  log.alerts = alerts.slice(-500);
  writeJson(CLOSED_TRADE_EMAIL_LOG_FILE, log);
}

function queueClosedTradeEmailViaConnector(config, entry, accountTotal, email, reason) {
  const connectorState = loadEmailConnectorState();
  const queuedRequest = connectorState.queue.requests.find((request) => request?.id === entry.id);
  const loggedRequest = connectorState.log.requests.find((request) => request?.id === entry.id);
  const existingRequest = queuedRequest || loggedRequest || null;
  if (existingRequest) {
    removePendingClosedTradeAlert(entry.id);
    return {
      sent: existingRequest.status === "delivered",
      queued: existingRequest.status !== "delivered",
      reason: existingRequest.status === "delivered"
        ? "already_delivered_via_connector_queue"
        : "already_queued_via_connector_queue",
      deliveryPath: existingRequest.deliveryPath || config.deliveryPath,
      deliveryAgent: existingRequest.deliveryAgent || config.deliveryAgent,
      requestId: existingRequest.id,
      status: existingRequest.status || null,
      queueFile: connectorState.queueFile,
      logFile: connectorState.logFile,
    };
  }

  const payload = queueEmailRequest({
    id: entry.id,
    requestType: "closed_trade",
    sourceSystem: "ocean_trading_website_monitor",
    recipient: email.recipient || config.recipient || null,
    subject: email.subject,
    body: email.body,
    deliveryPath: config.deliveryPath,
    deliveryAgent: config.deliveryAgent,
    paperclipTrigger: config.paperclipTrigger || "enabled_via_kai_gmail_connector",
    paperclipEmailRelayRoutineId: config.paperclipEmailRelayRoutineId || null,
    metadata: {
      mode: entry.mode,
      queueReason: reason,
      tradeId: entry.id,
      trade: entry.trade,
      accountTotal,
      paperclipApiBaseUrl: config.paperclipApiBaseUrl || null,
      deliveryOwner: config.deliveryAgent || null,
      approvalRequired: true,
    },
  });
  writeJson(LAST_CLOSED_TRADE_EMAIL_REQUEST_FILE, {
    requestId: payload.request.id,
    subject: payload.request.subject,
    body: payload.request.body,
    trade: entry.trade,
    queueFile: payload.queueFile,
    logFile: payload.logFile,
    queuedAtUtc: payload.request.createdAtUtc,
  });
  removePendingClosedTradeAlert(entry.id);
  return {
    sent: false,
    queued: true,
    reason: "queued_via_connector_queue",
    deliveryPath: payload.request.deliveryPath,
    deliveryAgent: payload.request.deliveryAgent,
    requestId: payload.request.id,
    status: payload.request.status,
    queueFile: payload.queueFile,
    logFile: payload.logFile,
  };
}

function handoffClosedTradeEmail(config, entry, accountTotal, email, reason) {
  try {
    return queueClosedTradeEmailViaConnector(config, entry, accountTotal, email, reason);
  } catch (error) {
    return queueClosedTradeEmailFallback(config, entry, accountTotal, email, reason, error);
  }
}

function bridgeLegacyClosedTradeQueue(config, reason) {
  const pending = readJson(CLOSED_TRADE_EMAIL_PENDING_FILE, { alerts: [] }) || { alerts: [] };
  const alerts = Array.isArray(pending.alerts) ? pending.alerts : [];
  let bridged = 0;
  let failed = 0;
  const requestIds = [];
  for (const alert of alerts) {
    if (!alert?.id || !alert?.trade || !alert?.email) continue;
    const delivery = handoffClosedTradeEmail(
      config,
      { id: alert.id, mode: alert.mode || "paper", trade: alert.trade },
      alert.accountTotal || null,
      alert.email,
      reason,
    );
    upsertClosedTradeEmailLog({
      ...alert,
      updatedAtUtc: new Date().toISOString(),
      delivery,
    });
    if (delivery.reason === "connector_queue_handoff_failed") failed += 1;
    else {
      bridged += 1;
      if (delivery.requestId && delivery.queued) requestIds.push(delivery.requestId);
    }
  }
  return { bridged, failed, requestIds };
}

function immediateReporterIdempotencyKey(requestIds, reason, keyPrefix = "closed-trade-email") {
  return `${keyPrefix}:${createHash("sha256")
    .update([reason, ...requestIds].join("|"))
    .digest("hex")}`;
}

function relayEmailPayloadsForRequestIds(requestIds) {
  const ids = new Set((Array.isArray(requestIds) ? requestIds : []).filter(Boolean));
  if (!ids.size) return [];
  const queue = loadEmailConnectorState().queue.requests;
  return queue
    .filter((request) => ids.has(request?.id))
    .map((request) => ({
      requestId: request.id,
      requestType: request.requestType || null,
      recipient: request.recipient || null,
      subject: request.subject || null,
      body: request.body || null,
      mode: request.metadata?.mode || null,
      createdAtUtc: request.createdAtUtc || null,
      deliveryAgent: request.deliveryAgent || null,
      queueFile: EMAIL_QUEUE_FILE,
      ackCommand: `node ${path.join(__dirname, "process-outbound-email-queue.mjs")} ack-delivered --id ${request.id} --actor "Riley - Connection Manager" --message-id <gmail-message-id>`,
      failCommand: `node ${path.join(__dirname, "process-outbound-email-queue.mjs")} ack-failed --id ${request.id} --actor "Riley - Connection Manager" --error <error>`,
    }));
}

async function triggerReporterEmailRelay(config, requestIds, reason) {
  const uniqueRequestIds = [...new Set((Array.isArray(requestIds) ? requestIds : []).filter(Boolean))];
  if (!uniqueRequestIds.length) return { triggered: false, reason: "no_queued_closed_trade_requests" };
  if (config.paperclipImmediateReporterRun === false) return { triggered: false, reason: "disabled" };
  const routineId = config.paperclipEmailRelayRoutineId;
  if (!routineId) return { triggered: false, reason: "missing_routine_id" };
  if (typeof fetch !== "function") return { triggered: false, reason: "fetch_unavailable" };

  const apiBaseUrl = String(config.paperclipApiBaseUrl || "http://127.0.0.1:3100/api").replace(/\/+$/, "");
  const triggerName = config.paperclipRelayTrigger || "closed_trade_detected";
  const relayNote = config.paperclipRelayNote || "Immediate Reporter/Gmail delivery attempt for newly queued Ocean Trading closed-trade email requests. Hourly schedule remains the retry sweep.";
  const idempotencyKeyPrefix = config.paperclipRelayIdempotencyKeyPrefix || "closed-trade-email";
  const emailRequests = relayEmailPayloadsForRequestIds(uniqueRequestIds);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.paperclipTriggerTimeoutMs || 10000));
  try {
    const response = await fetch(`${apiBaseUrl}/routines/${routineId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "api",
        idempotencyKey: immediateReporterIdempotencyKey(uniqueRequestIds, reason, idempotencyKeyPrefix),
        payload: {
          trigger: triggerName,
          reason,
          requestIds: uniqueRequestIds,
          emailRequests,
          requestedAtUtc: new Date().toISOString(),
          note: `${relayNote} Send each emailRequests[] item via Gmail when approved, then run the ackCommand with the Gmail message id. If Gmail is unavailable, run failCommand with the exact error.`,
        },
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let responseBody = null;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = responseText.slice(0, 500);
    }
    if (!response.ok) {
      throw new Error(`Paperclip routine run failed ${response.status}: ${responseText.slice(0, 500)}`);
    }
    return {
      triggered: true,
      routineId,
      requestIds: uniqueRequestIds,
      statusCode: response.status,
      runId: responseBody?.id || null,
    };
  } catch (error) {
    return {
      triggered: false,
      routineId,
      requestIds: uniqueRequestIds,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyNewClosedTrades(reason) {
  const config = closedTradeEmailConfig();
  if (!config.enabled) return;
  const manifest = readJson(DASHBOARD_DATA_FILE, null);
  if (!manifest) return;
  const bridgedLegacy = bridgeLegacyClosedTradeQueue(config, `legacy_${reason}`);
  const queuedRequestIds = Array.isArray(bridgedLegacy.requestIds) ? [...bridgedLegacy.requestIds] : [];
  const modeSet = new Set(config.modes || ["paper"]);
  const closedTrades = closedTradesFromManifest(manifest, [...modeSet]);
  const state = readJson(CLOSED_TRADE_EMAIL_STATE_FILE, null);
  if (!state && config.baselineExistingTradesOnFirstRun) {
    writeJson(CLOSED_TRADE_EMAIL_STATE_FILE, {
      initializedAtUtc: new Date().toISOString(),
      baselineReason: reason,
      enabledModes: [...modeSet],
      notifiedTradeIds: closedTrades.map((entry) => entry.id),
      lastClosedTradeAtUtc: closedTrades.at(-1)?.sortTime || null,
      note: "Existing closed trades were baselined to avoid emailing historical trades.",
    });
    return;
  }

  const notified = new Set(state?.notifiedTradeIds || []);
  const enabledModesBeforeThisRun = new Set(Array.isArray(state?.enabledModes) ? state.enabledModes : ["paper"]);
  const newlyEnabledModes = config.baselineExistingTradesOnModeEnable === false
    ? []
    : [...modeSet].filter((mode) => !enabledModesBeforeThisRun.has(mode));
  if (newlyEnabledModes.length) {
    const newlyEnabledModeSet = new Set(newlyEnabledModes);
    for (const entry of closedTrades) {
      if (newlyEnabledModeSet.has(entry.mode)) notified.add(entry.id);
    }
  }
  const fresh = closedTrades.filter((entry) => !notified.has(entry.id));
  for (const entry of fresh) {
    const accountTotal = accountBalanceForClosedTradeEmail(manifest, entry.mode, entry.trade);
    const email = buildClosedTradeEmail(entry.mode, entry.trade, accountTotal, config, manifest);
    const delivery = handoffClosedTradeEmail(config, entry, accountTotal, email, reason);
    const alert = {
      id: entry.id,
      createdAtUtc: new Date().toISOString(),
      mode: entry.mode,
      trade: entry.trade,
      accountTotal,
      email,
      delivery,
    };
    upsertClosedTradeEmailLog(alert);
    if (delivery.requestId && delivery.queued) queuedRequestIds.push(delivery.requestId);
    notified.add(entry.id);
  }
  const immediateReporterRun = await triggerReporterEmailRelay(config, queuedRequestIds, reason);
  writeJson(CLOSED_TRADE_EMAIL_STATE_FILE, {
    initializedAtUtc: state?.initializedAtUtc || new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    enabledModes: [...modeSet],
    lastBaselinedNewModes: newlyEnabledModes,
    notifiedTradeIds: [...notified].slice(-1000),
    lastClosedTradeAtUtc: closedTrades.at(-1)?.sortTime || null,
    lastNewClosedTradeCount: fresh.length,
    lastImmediateReporterRun: immediateReporterRun,
  });
  if (fresh.length || bridgedLegacy.bridged || bridgedLegacy.failed || immediateReporterRun.triggered || immediateReporterRun.error) {
    const pendingCount = (readJson(CLOSED_TRADE_EMAIL_PENDING_FILE, { alerts: [] })?.alerts || []).length;
    const connectorPendingCount = loadEmailConnectorState().queue.requests
      .filter((request) => request?.requestType === "closed_trade")
      .length;
    writeState({
      lastClosedTradeEmailAtUtc: new Date().toISOString(),
      lastClosedTradeEmailCount: fresh.length,
      lastClosedTradeEmailBridgeReason: reason,
      lastClosedTradeEmailDelivery: readJson(CLOSED_TRADE_EMAIL_LOG_FILE, { alerts: [] })?.alerts?.at(-1)?.delivery || null,
      closedTradeEmailPendingCount: pendingCount,
      closedTradeEmailConnectorPendingCount: connectorPendingCount,
      closedTradeEmailBridgedLegacyCount: bridgedLegacy.bridged,
      closedTradeEmailBridgeFailureCount: bridgedLegacy.failed,
      closedTradeEmailImmediateReporterRun: immediateReporterRun,
      closedTradeEmailDeliveryMode: "immediate_reporter_with_hourly_retry",
      closedTradeEmailDeliveryHandoffDisabled: false,
      closedTradeEmailDeliveryNote: pendingCount
        ? "Closed-trade email handoff queues through the shared connector, wakes Reporter for immediate Gmail delivery, and leaves legacy dashboard pending items only if connector queueing failed."
        : "Closed-trade email handoff queues through the shared connector, wakes Reporter for immediate Gmail delivery, and uses the hourly routine only as a retry sweep.",
    });
  }
}

async function notifyVwapPaperSim1Events(reason) {
  try {
    const config = loadVwapPaperSim1EmailConfig(VWAP_PAPER_SIM1_EMAIL_CONFIG_FILE);
    const manifest = readJson(DASHBOARD_DATA_FILE, null);
    const paperAccountValueAvailable = manifest?.tradingModes?.paper?.reconciliation?.accountValueAvailable === true;
    const accountBalanceDollars = paperAccountValueAvailable ? paperTradeAccountBalance(manifest, config.account) : null;
    const result = await scanVwapPaperSim1EmailEvents({
      config: {
        ...config,
        accountBalanceDollars,
        accountBalanceAvailable: paperAccountValueAvailable && Number.isFinite(Number(accountBalanceDollars)),
      },
      stateFile: VWAP_PAPER_SIM1_EMAIL_STATE_FILE,
      queueEmailRequest,
      triggerReporterEmailRelay,
      reason,
    });
    const eventCount = Array.isArray(result.events) ? result.events.length : 0;
    if (eventCount || result.reporterRun?.triggered || result.reporterRun?.error) {
      writeState({
        lastVwapPaperSim1EmailAtUtc: new Date().toISOString(),
        lastVwapPaperSim1EmailCount: eventCount,
        lastVwapPaperSim1EmailQueuedRequestIds: result.queuedRequestIds || [],
        lastVwapPaperSim1EmailReporterRun: result.reporterRun || null,
        vwapPaperSim1EmailStateFile: VWAP_PAPER_SIM1_EMAIL_STATE_FILE,
        vwapPaperSim1EmailDeliveryMode: "ocean_trading_dashboard_riley_queue",
        vwapPaperSim1EmailCodexMonitoringDisabled: true,
      }, createMonitorEvent("info", "vwap-paper-sim1-email-scan", "VWAP Paper Sim1 email monitor queued events", {
        reason,
        eventCount,
      }));
    }
    return result;
  } catch (error) {
    writeState({
      lastVwapPaperSim1EmailErrorAtUtc: new Date().toISOString(),
      lastVwapPaperSim1EmailError: String(error?.message || error),
      vwapPaperSim1EmailStateFile: VWAP_PAPER_SIM1_EMAIL_STATE_FILE,
      vwapPaperSim1EmailDeliveryMode: "ocean_trading_dashboard_riley_queue",
      vwapPaperSim1EmailCodexMonitoringDisabled: true,
    }, createMonitorEvent("warn", "vwap-paper-sim1-email-error", "VWAP Paper Sim1 email monitor scan failed", {
      reason,
      error: String(error?.message || error),
    }));
    return { enabled: false, events: [], queuedRequestIds: [], error: String(error?.message || error) };
  }
}

function isTradeLog(name) {
  return /^TradeActivityLog_\d{4}-\d{2}-\d{2}_UTC\..+\.data$/i.test(name);
}

function tradeLogDate(name) {
  return name.match(/^TradeActivityLog_(\d{4}-\d{2}-\d{2})_UTC\./i)?.[1] || null;
}

function isLiveLog(entryPath, name) {
  if (!isTradeLog(name) || /Sim1|simulated|\.None\.data$/i.test(name)) return false;
  const cleanStart = readJson(LIVE_TRADING_CLEAN_START_FILE, {});
  const fileDate = tradeLogDate(name);
  if (cleanStart.effectiveDateUtc && fileDate && fileDate < cleanStart.effectiveDateUtc) return false;
  const excluded = readJson(EXCLUDED_LIVE_TRADE_FILES_FILE, {});
  const excludedFiles = new Set((excluded.files || []).map((file) => path.resolve(file).toLowerCase()));
  return !excludedFiles.has(path.resolve(entryPath).toLowerCase());
}

function isPaperLog(name) {
  return isTradeLog(name) && /\.Sim1(\.simulated)?\.data$/i.test(name);
}

function isReplayLog(name) {
  return isTradeLog(name) && /\.(?!None\.)([^.]+)\.simulated\.data$/i.test(name);
}

function listLogs(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (!entry.isFile() || !predicate(fullPath, entry.name)) return null;
      const stat = fs.statSync(fullPath);
      return {
        path: fullPath,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
}

function fileSignature(filePath, mode, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    size: stat.size,
    mtimeMs: options.includeMtime === false ? 0 : Math.round(stat.mtimeMs),
    mode,
  };
}

function sqliteSignatures(filePath, mode) {
  const signatures = [];
  for (const candidate of [
    { path: filePath, includeMtime: true },
    { path: `${filePath}-wal`, includeMtime: true },
    { path: `${filePath}-shm`, includeMtime: false },
  ]) {
    const signature = fileSignature(candidate.path, mode, { includeMtime: candidate.includeMtime });
    if (signature) signatures.push(signature);
  }
  return signatures;
}

function signatureForLogs() {
  const config = readSierraInstances({ configFile: SIERRA_SYMBOL_CONFIG_FILE });
  const liveLogDir = tradeActivityLogDir(config.live);
  const paperLogDir = tradeActivityLogDir(config.paper);
  const replayLogDir = tradeActivityLogDir(config.replay);
  const liveSqliteFile = config.live?.patradingSqliteFile || PATRADING_LIVE_SQLITE_FILE;
  const paperSqliteFile = config.paper?.patradingSqliteFile || PATRADING_PAPER_SQLITE_FILE;
  const replaySqliteFile = config.replay?.patradingSqliteFile || PATRADING_REPLAY_SQLITE_FILE;
  const liveSqliteSignatures = sqliteSignatures(liveSqliteFile, "live_sqlite");
  const paperSqliteSignatures = sqliteSignatures(paperSqliteFile, "paper_sqlite");
  const replaySqliteSignatures = sqliteSignatures(replaySqliteFile, "replay_sqlite");
  const logs = [
    fileSignature(path.join(__dirname, "data", "replay-monitor-clears.json"), "replay_clear"),
    ...liveSqliteSignatures,
    ...paperSqliteSignatures,
    ...replaySqliteSignatures,
    ...listLogs(replayLogDir, (_entryPath, name) => isReplayLog(name)).map((item) => ({ ...item, mode: "replay" })),
  ].filter(Boolean);
  return {
    logs,
    liveLogDir,
    liveSqliteFile,
    paperLogDir,
    paperSqliteFile,
    replayLogDir,
    replaySqliteFile,
    paperSymbol: config.paper.displaySymbol || config.paper.symbol || null,
    signature: logs.map((item) => `${item.mode}:${item.path}:${item.size}:${item.mtimeMs}`).join("\n"),
  };
}

function snapshotDtc(reason) {
  try {
    execFileSync(process.execPath, [DTC_SNAPSHOT_SCRIPT, "--reason", reason], {
      cwd: __dirname,
      stdio: "ignore",
      env: process.env,
    });
    writeState({
      lastSnapshotAtUtc: new Date().toISOString(),
      lastSnapshotReason: reason,
      lastSnapshotError: null,
    });
  } catch (error) {
    writeState({
      lastSnapshotAtUtc: new Date().toISOString(),
      lastSnapshotReason: reason,
      lastSnapshotError: String(error?.message || error),
    }, createMonitorEvent("warn", "snapshot-error", `DTC snapshot failed during ${reason}`, {
      reason,
      error: String(error?.message || error),
    }));
  }
}

async function rebuild(reason) {
  writeState({
    running: true,
    status: "running",
    lastImportReason: reason,
  }, createMonitorEvent("info", "rebuild-start", `Monitor rebuild started for ${reason}`, { reason, scanCount }));
  snapshotDtc(reason);
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    cwd: __dirname,
    stdio: "ignore",
    env: process.env,
    timeout: 90000,
    windowsHide: true,
  });
  await notifyNewClosedTrades(reason);
  importCount += 1;
  writeState({
    running: true,
    status: "running",
    lastImportAtUtc: new Date().toISOString(),
    lastImportReason: reason,
    importCount,
    error: null,
  }, createMonitorEvent("info", "rebuild-complete", `Monitor rebuild finished for ${reason}`, {
    reason,
    importCount,
    scanCount,
  }));
}

async function scan() {
  if (stopping || scanInFlight) return;
  scanInFlight = true;
  scanCount += 1;
  try {
    const { logs, signature, liveLogDir, liveSqliteFile, paperLogDir, paperSqliteFile, replayLogDir, replaySqliteFile, paperSymbol } = signatureForLogs();
    const changed = signature !== lastSignature;
    writeState({
      running: true,
      status: "running",
      scanCount,
      watchedFiles: logs.length,
      liveLogDir,
      liveSqliteFile,
      paperLogDir,
      paperSqliteFile,
      replayLogDir,
      replaySqliteFile,
      paperSymbol,
      lastScanAtUtc: new Date().toISOString(),
      error: null,
    });
    if (changed) {
      await rebuild(scanCount === 1 ? "startup_reconcile" : "file_change");
      lastSignature = signature;
    }
    await notifyVwapPaperSim1Events(changed ? "file_change_scan_after_rebuild" : "periodic_scan");
  } catch (error) {
    writeState({
      running: true,
      status: "error",
      error: String(error?.message || error),
      lastErrorAtUtc: new Date().toISOString(),
    }, createMonitorEvent("error", "scan-error", "Monitor scan failed", {
      error: String(error?.message || error),
      scanCount,
    }));
  } finally {
    scanInFlight = false;
  }
}

function stop() {
  stopping = true;
  writeState({
    running: false,
    status: "stopped",
    stoppedAtUtc: new Date().toISOString(),
  }, createMonitorEvent("info", "stop", "Monitor worker stopped"));
  process.exit(0);
}

export {
  buildClosedTradeEmail,
  closedTradeEmailConfig,
  handoffClosedTradeEmail,
  notifyNewClosedTrades,
  notifyVwapPaperSim1Events,
  queueClosedTradeEmailViaConnector,
};

function startMonitor() {
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (error) => {
    writeState({ running: false, status: "error", error: String(error?.message || error) }, createMonitorEvent("error", "uncaught-exception", "Monitor worker crashed", {
      error: String(error?.message || error),
    }));
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    writeState({ running: false, status: "error", error: String(error?.message || error) }, createMonitorEvent("error", "unhandled-rejection", "Monitor worker rejected a promise", {
      error: String(error?.message || error),
    }));
    process.exit(1);
  });

writeState({
  running: true,
  status: "starting",
  startedAtUtc: new Date().toISOString(),
  error: null,
}, createMonitorEvent("info", "startup", "Monitor worker starting", { scanIntervalMs: INTERVAL_MS }));
scan();
setInterval(() => {
  void scan();
}, INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMonitor();
}
