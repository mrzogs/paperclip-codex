import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const VWAP_PAPER_SIM1_EMAIL_MONITOR_TAG = "OCEAN-TRADING-VWAP-PAPER-SIM1-EMAIL-MONITOR-v0458-002";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  enabled: true,
  recipient: "wayne.vanheerden@gmail.com",
  subjectPrefix: "Ocean Trading Paper Sim1",
  deliveryPath: "reporter_gmail_connector",
  deliveryAgent: "Riley - Connection Manager",
  paperclipTrigger: "enabled_via_riley_gmail_connector",
  paperclipEmailRelayRoutineId: "fa42e0f2-f4dd-4bf3-aa5d-343ec1ceeb2d",
  paperclipImmediateReporterRun: true,
  paperclipTriggerTimeoutMs: 10000,
  paperclipApiBaseUrl: "http://127.0.0.1:3100/api",
  paperRoot: "D:\\Trading\\SierraChart-PaperTrading",
  logsDir: "D:\\Trading\\SierraChart-PaperTrading\\Logs",
  account: "Sim1",
  version: "v0.4.58",
  symbol: "MNQU26_FUT_CME",
  strategyName: "VWAP Wave Pullback Balanced",
  strategyId: "vwap_wave_pullback_balanced_nasdaq_v0434",
  profile: "nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5",
  profileIndex: 6,
  paperclipCompanyName: "Ocean Quant Lab",
  paperclipCompanyId: "49d243c6-0dda-4adb-878c-2ef8ed0be6ac",
  oqlCompanyId: "49d243c6-0dda-4adb-878c-2ef8ed0be6ac",
  oqlIssuePrefix: "OCEA",
  sourceSystem: "ocean_trading_website_monitor",
  logFileLimit: 5,
  baselineExistingLogBytesOnFirstRun: true,
  emailEventKinds: ["open", "close"],
};

const PAPER_TRADES_FILE = path.join(__dirname, "data", "paper-trades.json");
const DASHBOARD_DATA_FILE = path.join(__dirname, "dashboard-data.json");

function readJson(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function utcNow() {
  return new Date().toISOString();
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

export function loadVwapPaperSim1EmailConfig(configFile) {
  return {
    ...DEFAULT_CONFIG,
    ...(readJson(configFile, {}) || {}),
  };
}

function newestMessageLogs(logsDir, limit) {
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Message Log .+\.log$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(logsDir, entry.name);
      const stat = fs.statSync(fullPath);
      return { path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.path);
}

function readNewText(logPath, state, baselineOnly) {
  const fileState = state.files[logPath] || {};
  const size = fs.statSync(logPath).size;
  let offset = Number(fileState.offset || 0);
  if (!Number.isFinite(offset) || offset < 0 || offset > size) offset = 0;
  if (baselineOnly) {
    state.files[logPath] = {
      offset: size,
      lastSize: size,
      lastScanAtUtc: utcNow(),
      baselined: true,
    };
    return "";
  }
  const handle = fs.openSync(logPath, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(Math.max(0, length));
    if (length > 0) fs.readSync(handle, buffer, 0, length, offset);
    state.files[logPath] = {
      offset: size,
      lastSize: size,
      lastScanAtUtc: utcNow(),
      baselined: Boolean(fileState.baselined),
    };
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

function parseKeyValues(text) {
  const values = {};
  const re = /([A-Za-z0-9_]+)=([\s\S]*?)(?=\s+[A-Za-z0-9_]+=|$)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    values[match[1]] = String(match[2] || "").trim().replace(/[,\s]+$/, "");
  }
  return values;
}

function eventId(kind, line) {
  return createHash("sha256").update(`${kind}|${line}`).digest("hex");
}

function ledgerEventId(trade) {
  return createHash("sha256")
    .update([
      trade?.account,
      trade?.symbol,
      trade?.entryAtUtc,
      trade?.exitAtUtc || trade?.tradeDateUtc,
      trade?.side,
      trade?.quantity,
      trade?.entryPrice,
      trade?.exitPrice,
      trade?.realizedPnlDollars,
      trade?.sourceFile,
      trade?.internalOrderId,
    ].map((value) => value ?? "").join("|"))
    .digest("hex");
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tradeMultiplier(symbol) {
  return String(symbol || "").toUpperCase().includes("MNQ") ? 2 : 1;
}

function loadPaperDashboardSnapshot(config) {
  if (config.paperTradesFile) return readJson(config.paperTradesFile, null);
  const manifest = readJson(DASHBOARD_DATA_FILE, null);
  if (manifest?.tradingModes?.paper) return manifest.tradingModes.paper;
  return readJson(PAPER_TRADES_FILE, null);
}

function closedTradeRowsFromSnapshot(snapshot) {
  if (Array.isArray(snapshot?.strategyClosedTrades) && snapshot.strategyClosedTrades.length) return snapshot.strategyClosedTrades;
  if (Array.isArray(snapshot?.performanceClosedTrades) && snapshot.performanceClosedTrades.length) return snapshot.performanceClosedTrades;
  if (Array.isArray(snapshot?.closedTrades)) return snapshot.closedTrades;
  return [];
}

function ledgerTradeMatchesConfig(trade, config) {
  const accountMatches = String(trade?.account || "").toLowerCase() === String(config.account || "").toLowerCase();
  const acceptedSymbols = [config.symbol, ...(Array.isArray(config.symbolAliases) ? config.symbolAliases : [])]
    .filter(Boolean)
    .map((symbol) => String(symbol).toUpperCase());
  const tradeSymbol = String(trade?.symbol || "").toUpperCase();
  const symbolMatches = !acceptedSymbols.length || acceptedSymbols.includes(tradeSymbol);
  if (config.requireLedgerStrategyMatch !== true) return accountMatches && symbolMatches;
  const strategyText = `${trade?.strategyName || ""} ${trade?.strategyStudy || ""} ${trade?.dashboardBucket || ""}`;
  return accountMatches && symbolMatches && /VWAP Wave Pullback/i.test(strategyText);
}

function ledgerCloseEvents(config) {
  const snapshot = loadPaperDashboardSnapshot(config);
  return closedTradeRowsFromSnapshot(snapshot)
    .filter((trade) => ledgerTradeMatchesConfig(trade, config))
    .map((trade) => ({
      id: `vwap-paper-sim1-close-ledger-${ledgerEventId(trade)}`,
      kind: "close",
      detectedAtUtc: utcNow(),
      sourceLine: `paper-trades ledger close ${trade?.exitAtUtc || trade?.tradeDateUtc || "unknown"}`,
      sourceLog: trade?.sourceFile || config.paperTradesFile || PAPER_TRADES_FILE,
      account: trade?.account || config.account,
      strategyName: trade?.strategyName || trade?.strategyStudy || config.strategyName,
      version: config.version,
      profile: config.profile,
      side: trade?.side || "unknown",
      priorQty: trade?.quantity == null ? "" : String(trade.quantity),
      quantity: trade?.quantity == null ? "" : String(trade.quantity),
      barTime: trade?.exitAtUtc || trade?.tradeDateUtc || "",
      openTime: trade?.entryAtUtc || "",
      closeTime: trade?.exitAtUtc || trade?.tradeDateUtc || "",
      entry: trade?.entryPrice == null ? "" : String(trade.entryPrice),
      exit: trade?.exitPrice == null ? "" : String(trade.exitPrice),
      activeStop: "",
      pnl: asNumber(trade?.realizedPnlDollars),
    }))
    .sort((a, b) => String(a.closeTime || a.barTime).localeCompare(String(b.closeTime || b.barTime)));
}

function accountBalanceFromSnapshot(snapshot, account) {
  const rows = snapshot?.accountMonitor?.rows;
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => String(entry?.account || "").toLowerCase() === String(account || "").toLowerCase());
  if (!row) return null;
  for (const key of ["accountBalanceDollars", "totalTradeAccountBalance", "tradeAccountBalance", "balanceDollars", "balance", "accountValue"]) {
    const value = finiteNumber(row[key]);
    if (value !== null) return value;
  }
  return null;
}

function dashboardSummaryFromSnapshot(snapshot, account) {
  const rows = closedTradeRowsFromSnapshot(snapshot);
  const accountRows = rows.filter((trade) => !account || String(trade.account || "").toLowerCase() === String(account).toLowerCase());
  const longRows = accountRows.filter((trade) => String(trade.side || "").toLowerCase() === "long");
  const shortRows = accountRows.filter((trade) => String(trade.side || "").toLowerCase() === "short");
  const rawLongPnl = longRows.reduce((total, trade) => total + asNumber(trade.realizedPnlDollars), 0);
  const rawShortPnl = shortRows.reduce((total, trade) => total + asNumber(trade.realizedPnlDollars), 0);
  const netPnl = Number((rawLongPnl + rawShortPnl).toFixed(2));

  return {
    accountBalance: accountBalanceFromSnapshot(snapshot, account),
    accountBalanceAvailable: accountBalanceFromSnapshot(snapshot, account) !== null,
    longTrades: longRows.length,
    shortTrades: shortRows.length,
    closedTrades: accountRows.length,
    longPnl: Number(rawLongPnl.toFixed(2)),
    shortPnl: Number(rawShortPnl.toFixed(2)),
    netPnl: Number(netPnl.toFixed(2)),
    netSource: "reconciled closed trades",
  };
}

function openEventNetPnl(event, snapshot, config) {
  if (event.kind !== "open") return null;
  const openPositions = Array.isArray(snapshot?.openPositions) ? snapshot.openPositions : [];
  const matchingPosition = openPositions.find((position) =>
    String(position.account || "").toLowerCase() === String(event.account || config.account || "").toLowerCase()
    && String(position.symbol || "").toUpperCase() === String(config.symbol || "").toUpperCase()
  );
  const latestPrice = finiteNumber(matchingPosition?.latestPrice);
  const entry = finiteNumber(event.entry);
  const quantity = finiteNumber(event.quantity);
  if (latestPrice === null || entry === null || quantity === null) return null;
  const direction = String(event.direction || "").toLowerCase();
  const signedPoints = direction === "short" ? entry - latestPrice : latestPrice - entry;
  return {
    value: Number((signedPoints * quantity * tradeMultiplier(config.symbol)).toFixed(2)),
    latestPrice,
    source: matchingPosition?.sourceFile || snapshot?.summary?.dailyNetProfitLossSourceFile || null,
  };
}

function shouldQueueEmailForEvent(event, config) {
  const allowed = Array.isArray(config.emailEventKinds) && config.emailEventKinds.length
    ? config.emailEventKinds
    : ["open", "close"];
  return allowed.map((kind) => String(kind).toLowerCase()).includes(String(event.kind || "").toLowerCase());
}

function sideFromPriorQty(value) {
  const qty = asNumber(value);
  if (qty > 0) return "long";
  if (qty < 0) return "short";
  return "unknown";
}

export function parseVwapPaperSim1Event(line, config = DEFAULT_CONFIG) {
  if (!line.includes("VWAP Wave Pullback") || !line.includes(config.version)) return null;
  if (line.includes("order intent:")) {
    const values = parseKeyValues(line);
    const result = asNumber(values.result);
    if (result <= 0) return null;
    return {
      id: `vwap-paper-sim1-open-${eventId("open", line)}`,
      kind: "open",
      detectedAtUtc: utcNow(),
      sourceLine: line,
      account: config.account,
      version: values.version || config.version,
      profile: values.profile || config.profile,
      direction: values.direction || "unknown",
      barTime: values.bar_time || "",
      quantity: values.qty || String(result),
      entry: values.entry || "",
      stop: values.stop || "",
      riskDollars: values.actual_risk_dollars || values.risk_dollars || "",
      maxRiskDollars: values.max_risk_dollars || "",
      result,
    };
  }
  if (line.includes("position closed:")) {
    const values = parseKeyValues(line);
    const pnl = asNumber(values.last_trade_pnl);
    return {
      id: `vwap-paper-sim1-close-${eventId("close", line)}`,
      kind: "close",
      detectedAtUtc: utcNow(),
      sourceLine: line,
      account: config.account,
      version: values.version || config.version,
      profile: values.profile || config.profile,
      side: sideFromPriorQty(values.prior_qty),
      priorQty: values.prior_qty || "",
      barTime: values.bar_time || "",
      entry: values.entry || "",
      activeStop: values.active_stop || "",
      pnl,
    };
  }
  return null;
}

function initialPerformance() {
  return {
    openedTrades: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    longTrades: 0,
    shortTrades: 0,
    longPnl: 0,
    shortPnl: 0,
    netPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: null,
    winRatePct: null,
  };
}

function updatePerformance(performance, event) {
  if (event.kind === "open") {
    performance.openedTrades = Number(performance.openedTrades || 0) + 1;
    const direction = String(event.direction || "").toLowerCase();
    if (direction === "long") performance.longTrades = Number(performance.longTrades || 0) + 1;
    if (direction === "short") performance.shortTrades = Number(performance.shortTrades || 0) + 1;
    return performance;
  }
  const pnl = asNumber(event.pnl);
  performance.closedTrades = Number(performance.closedTrades || 0) + 1;
  performance.netPnl = Number((Number(performance.netPnl || 0) + pnl).toFixed(2));
  const side = String(event.side || "").toLowerCase();
  if (side === "long") performance.longPnl = Number((Number(performance.longPnl || 0) + pnl).toFixed(2));
  if (side === "short") performance.shortPnl = Number((Number(performance.shortPnl || 0) + pnl).toFixed(2));
  if (pnl >= 0) {
    performance.wins = Number(performance.wins || 0) + 1;
    performance.grossProfit = Number((Number(performance.grossProfit || 0) + pnl).toFixed(2));
  } else {
    performance.losses = Number(performance.losses || 0) + 1;
    performance.grossLoss = Number((Number(performance.grossLoss || 0) + pnl).toFixed(2));
  }
  const grossLossAbs = Math.abs(Number(performance.grossLoss || 0));
  performance.profitFactor = grossLossAbs ? Number((Number(performance.grossProfit || 0) / grossLossAbs).toFixed(3)) : null;
  performance.winRatePct = performance.closedTrades
    ? Number(((100 * Number(performance.wins || 0)) / performance.closedTrades).toFixed(1))
    : null;
  return performance;
}

export function buildEmail(event, config, performance) {
  const snapshot = loadPaperDashboardSnapshot(config);
  const dashboardSummary = dashboardSummaryFromSnapshot(snapshot, event.account || config.account);
  const eventNetPnl = event.kind === "open" ? openEventNetPnl(event, snapshot, config) : { value: event.pnl };
  const eventTitle = event.kind === "open" ? "TRADE OPENED" : "TRADE CLOSED";
  const direction = event.direction || event.side || "unknown";
  const strategyName = event.strategyName || config.strategyName || "Paper Trade";
  const configuredAccountBalance = Number(config.accountBalanceDollars);
  const accountBalance = dashboardSummary.accountBalanceAvailable ? dashboardSummary.accountBalance : configuredAccountBalance;
  const hasAccountBalance = dashboardSummary.accountBalanceAvailable || (config.accountBalanceAvailable === true && Number.isFinite(configuredAccountBalance));
  const subject = event.kind === "open"
    ? `${config.subjectPrefix}: trade opened ${String(direction).toUpperCase()} qty ${event.quantity || "?"}`
    : `${config.subjectPrefix}: trade closed ${String(direction).toUpperCase()} ${money(event.pnl)}`;
  const detailLines = event.kind === "open"
    ? [
      `Direction: ${event.direction || "unknown"}`,
      `Quantity: ${event.quantity || "unknown"}`,
      `Entry: ${event.entry || "unknown"}`,
      `Stop: ${event.stop || "unknown"}`,
      `Trade net P/L: ${eventNetPnl ? `${money(eventNetPnl.value)} unrealized` : "unavailable until Sierra publishes a current price/fill"}`,
      `Risk: ${event.riskDollars || "unknown"}`,
      `Max risk: ${event.maxRiskDollars || "unknown"}`,
    ]
    : [
      `Side: ${event.side || "unknown"}`,
      `Quantity: ${event.quantity || event.priorQty || "unknown"}`,
      `Open time: ${event.openTime || "unknown"}`,
      `Closed time: ${event.closeTime || event.barTime || "unknown"}`,
      `Entry: ${event.entry || "unknown"}`,
      `Exit: ${event.exit || "unknown"}`,
      `Trade P/L: ${money(event.pnl)}`,
    ];
  const body = [
    `OCEAN TRADING PAPER ${eventTitle}`,
    `${strategyName} | ${config.account} | ${config.version}`,
    "",
    "PAPERCLIP / OQL",
    `Source system: ${config.sourceSystem}`,
    `Company: ${config.paperclipCompanyName || "Ocean Quant Lab"}`,
    `Company id: ${config.paperclipCompanyId || config.oqlCompanyId}`,
    `OQL company id: ${config.oqlCompanyId}`,
    `OQL issue prefix: ${config.oqlIssuePrefix}`,
    `Strategy id: ${config.strategyId}`,
    `Profile: ${event.profile || config.profile}`,
    `Profile index: ${config.profileIndex}`,
    "",
    "SUMMARY",
    `Total trade account balance: ${hasAccountBalance ? money(accountBalance) : "unavailable from Sierra Sim1 account monitor"}`,
    `Closed trades: ${dashboardSummary.closedTrades}`,
    `Long trades: ${dashboardSummary.longTrades}`,
    `Short trades: ${dashboardSummary.shortTrades}`,
    `Realized long P/L: ${money(dashboardSummary.longPnl)}`,
    `Realized short P/L: ${money(dashboardSummary.shortPnl)}`,
    `Realized net P/L: ${money(dashboardSummary.netPnl)}`,
    `Realized net source: ${dashboardSummary.netSource}`,
    ...(event.kind === "close" ? [`Trade P/L: ${money(event.pnl)}`] : []),
    "",
    "EVENT DETAILS",
    `Account: ${event.account || config.account}`,
    `Event type: ${event.kind}`,
    `Bar time: ${event.barTime || "unknown"}`,
    ...detailLines,
    "",
    "SOURCE",
    event.sourceLog || "unknown",
    "",
    "Prepared locally by the Ocean Trading website monitor and routed through the Paperclip/Riley Gmail connector queue.",
  ].join("\n");
  return { subject, body, recipient: config.recipient };
}

function requestForEvent(event, config, performance, reason) {
  const email = buildEmail(event, config, performance);
  return {
    id: event.id,
    requestType: `vwap_paper_trade_${event.kind}`,
    sourceSystem: config.sourceSystem,
    recipient: email.recipient,
    subject: email.subject,
    body: email.body,
    deliveryPath: config.deliveryPath,
    deliveryAgent: config.deliveryAgent,
    paperclipTrigger: config.paperclipTrigger,
    paperclipEmailRelayRoutineId: config.paperclipEmailRelayRoutineId,
    metadata: {
      mode: "paper",
      queueReason: reason,
      eventType: event.kind,
      account: config.account,
      version: event.version,
      profile: event.profile || config.profile,
      profileIndex: config.profileIndex,
      strategyName: config.strategyName,
      strategyId: config.strategyId,
      paperclipCompanyName: config.paperclipCompanyName,
      paperclipCompanyId: config.paperclipCompanyId || config.oqlCompanyId,
      oqlCompanyId: config.oqlCompanyId,
      oqlIssuePrefix: config.oqlIssuePrefix,
      sourceLog: event.sourceLog,
      sourceLine: event.sourceLine,
      performance,
      deliveryOwner: config.deliveryAgent,
      approvalRequired: true,
    },
  };
}

export async function scanVwapPaperSim1EmailEvents({
  config,
  stateFile,
  queueEmailRequest,
  triggerReporterEmailRelay,
  reason = "paper_log_scan",
} = {}) {
  const effectiveConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  const stateExists = fs.existsSync(stateFile);
  const state = readJson(stateFile, null) || {
    createdAtUtc: utcNow(),
    files: {},
    queuedEventIds: [],
    performance: initialPerformance(),
  };
  state.files = state.files || {};
  state.queuedEventIds = Array.isArray(state.queuedEventIds) ? state.queuedEventIds : [];
  state.performance = { ...initialPerformance(), ...(state.performance || {}) };

  if (!effectiveConfig.enabled) {
    state.updatedAtUtc = utcNow();
    state.lastScanReason = "disabled";
    writeJson(stateFile, state);
    return { enabled: false, events: [], queuedRequestIds: [], stateFile };
  }

  const logs = newestMessageLogs(effectiveConfig.logsDir, Number(effectiveConfig.logFileLimit || 5));
  const queued = new Set(state.queuedEventIds);
  const events = [];
  const queuedRequestIds = [];
  const baselineOnly = !stateExists && effectiveConfig.baselineExistingLogBytesOnFirstRun !== false;
  const ledgerEvents = ledgerCloseEvents(effectiveConfig);

  if (!Array.isArray(state.ledgerClosedTradeIds)) {
    state.ledgerClosedTradeIds = [];
    const ledgerIds = ledgerEvents.map((event) => event.id);
    const queueLatestOnMigration = stateExists && ledgerIds.length && effectiveConfig.queueLatestLedgerCloseOnFirstLedgerScan !== false;
    const baselineIds = queueLatestOnMigration ? ledgerIds.slice(0, -1) : ledgerIds;
    for (const id of baselineIds) queued.add(id);
    state.ledgerCloseInitializedAtUtc = utcNow();
    state.ledgerCloseBaselineCount = baselineIds.length;
    state.ledgerCloseInitialLatestQueued = queueLatestOnMigration ? ledgerIds.at(-1) : null;
  }

  if (
    stateExists
    && Array.isArray(state.ledgerClosedTradeIds)
    && state.ledgerClosedTradeIds.length === 0
    && Number(state.lastLedgerClosedTradeCount || 0) === 0
    && ledgerEvents.length
    && effectiveConfig.queueLatestLedgerCloseWhenRecoveredFromEmptyBaseline !== false
  ) {
    const ledgerIds = ledgerEvents.map((event) => event.id);
    const baselineIds = ledgerIds.slice(0, -1);
    for (const id of baselineIds) queued.add(id);
    state.ledgerCloseRecoveredEmptyBaselineAtUtc = utcNow();
    state.ledgerCloseRecoveredEmptyBaselineCount = baselineIds.length;
    state.ledgerCloseRecoveredLatestQueued = ledgerIds.at(-1) || null;
  }

  for (const logPath of [...logs].reverse()) {
    const text = readNewText(logPath, state, baselineOnly);
    for (const line of text.split(/\r?\n/)) {
      const event = parseVwapPaperSim1Event(line, effectiveConfig);
      if (!event || queued.has(event.id)) continue;
      event.sourceLog = logPath;
      updatePerformance(state.performance, event);
      if (shouldQueueEmailForEvent(event, effectiveConfig)) {
        const request = requestForEvent(event, effectiveConfig, state.performance, reason);
        const delivery = queueEmailRequest(request);
        events.push({ ...event, emailRequestId: delivery?.request?.id || request.id });
        queuedRequestIds.push(delivery?.request?.id || request.id);
      } else {
        events.push({ ...event, emailRequestId: null, emailSkipped: true, skipReason: "event_kind_disabled" });
      }
      queued.add(event.id);
    }
  }

  for (const event of ledgerEvents) {
    if (queued.has(event.id)) continue;
    updatePerformance(state.performance, event);
    if (shouldQueueEmailForEvent(event, effectiveConfig)) {
      const request = requestForEvent(event, effectiveConfig, state.performance, reason);
      const delivery = queueEmailRequest(request);
      events.push({ ...event, emailRequestId: delivery?.request?.id || request.id });
      queuedRequestIds.push(delivery?.request?.id || request.id);
    } else {
      events.push({ ...event, emailRequestId: null, emailSkipped: true, skipReason: "event_kind_disabled" });
    }
    queued.add(event.id);
  }

  let reporterRun = null;
  if (queuedRequestIds.length && typeof triggerReporterEmailRelay === "function") {
    reporterRun = await triggerReporterEmailRelay(effectiveConfig, queuedRequestIds, reason);
  }

  state.queuedEventIds = [...queued].slice(-1000);
  state.lastScanAtUtc = utcNow();
  state.lastScanReason = reason;
  state.lastLogsScanned = logs;
  state.ledgerClosedTradeIds = ledgerEvents.map((event) => event.id).slice(-1000);
  state.lastLedgerClosedTradeCount = ledgerEvents.length;
  state.lastEventCount = events.length;
  state.lastQueuedRequestIds = queuedRequestIds;
  state.lastReporterRun = reporterRun;
  state.updatedAtUtc = utcNow();
  writeJson(stateFile, state);

  return {
    enabled: true,
    tag: VWAP_PAPER_SIM1_EMAIL_MONITOR_TAG,
    logsScanned: logs,
    events,
    queuedRequestIds,
    reporterRun,
    performance: state.performance,
    stateFile,
  };
}
