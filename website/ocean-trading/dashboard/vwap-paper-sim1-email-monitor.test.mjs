import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseVwapPaperSim1Event,
  scanVwapPaperSim1EmailEvents,
} from "./vwap-paper-sim1-email-monitor.mjs";

const TEST_CONFIG = {
  enabled: true,
  recipient: "wayne.vanheerden@gmail.com",
  subjectPrefix: "Ocean Trading Paper Sim1",
  deliveryPath: "reporter_gmail_connector",
  deliveryAgent: "Kai - Connection Manager",
  paperclipEmailRelayRoutineId: "fa42e0f2-f4dd-4bf3-aa5d-343ec1ceeb2d",
  paperclipImmediateReporterRun: true,
  version: "v0.4.58",
  symbol: "MNQU26_FUT_CME",
  symbolAliases: ["MNQU6.CME"],
  account: "Sim1",
  strategyName: "VWAP Wave Pullback Balanced",
  strategyId: "vwap_wave_pullback_balanced_nasdaq_v0434",
  profile: "nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5",
  profileIndex: 6,
  accountBalanceDollars: 50082.5,
  accountBalanceAvailable: true,
  oqlCompanyId: "49d243c6-0dda-4adb-878c-2ef8ed0be6ac",
  oqlIssuePrefix: "OCEA",
  sourceSystem: "ocean_trading_website_monitor",
  logFileLimit: 5,
  baselineExistingLogBytesOnFirstRun: true,
};

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vwap-paper-sim1-email-monitor-"));
  const logsDir = path.join(root, "Logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return { root, logsDir, stateFile: path.join(root, "state.json") };
}

function appendLog(logFile, lines) {
  fs.appendFileSync(logFile, `${lines.join("\n")}\n`);
}

function writePaperTradesFixture(filePath) {
  fs.writeFileSync(filePath, JSON.stringify({
    accountMonitor: {
      rows: [{ account: "Sim1", accountBalanceDollars: 50082.5 }],
  },
  summary: {
    dailyNetProfitLossDollars: 1221.5,
  },
  strategyClosedTrades: [
      {
        tradeDateUtc: "2026-06-17T20:00:00",
        entryAtUtc: "2026-06-17T19:00:00",
        exitAtUtc: "2026-06-17T20:00:00",
        account: "Sim1",
        symbol: "MNQU6.CME",
        strategyName: "VWAP Wave Pullback",
        side: "Long",
        quantity: 5,
        entryPrice: 31000.25,
        exitPrice: 31065.275,
        realizedPnlDollars: 650.25,
        sourceFile: "paper-trades-fixture.json",
      },
    ],
    openPositions: [
      {
        account: "Sim1",
        symbol: "MNQU26_FUT_CME",
        latestPrice: 31001.25,
        sourceFile: "paper-trades-fixture.json",
      },
    ],
  }, null, 2));
}

function writeManualPaperTradesFixture(filePath) {
  fs.writeFileSync(filePath, JSON.stringify({
    accountMonitor: {
      rows: [{ account: "Sim1", accountBalanceDollars: 49980 }],
    },
    performanceClosedTrades: [
      {
        tradeDateUtc: "2026-07-20T08:00:00Z",
        entryAtUtc: "2026-07-20T07:55:00Z",
        exitAtUtc: "2026-07-20T08:00:00Z",
        account: "Sim1",
        symbol: "MNQU26_FUT_CME",
        strategyName: "Manual Trade",
        side: "Short",
        quantity: 1,
        entryPrice: 29100,
        exitPrice: 29110,
        realizedPnlDollars: -20,
        sourceFile: "paper-sqlite",
        internalOrderId: 1002,
      },
      {
        tradeDateUtc: "2026-07-21T04:56:41.038Z",
        entryAtUtc: "2026-07-21T04:49:59.823Z",
        exitAtUtc: "2026-07-21T04:56:41.038Z",
        account: "Sim1",
        symbol: "MNQU26_FUT_CME",
        strategyName: "Manual Trade",
        side: "Long",
        quantity: 1,
        entryPrice: 29072.5,
        exitPrice: 29051,
        realizedPnlDollars: -43,
        sourceFile: "paper-sqlite",
        internalOrderId: 37528,
      },
    ],
  }, null, 2));
}

test("VWAP Paper Sim1 parser detects successful v0.4.58 open events", () => {
  const event = parseVwapPaperSim1Event(
    "2026-06-17 19:01:00 | VWAP Wave Pullback Balanced v0.4.58 order intent: version=v0.4.58 profile=nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5 direction=long bar_time=2026-06-17 19:00:00 qty=5 entry=31000.25 stop=30900.25 actual_risk_dollars=997.50 max_risk_dollars=1100 result=5",
    TEST_CONFIG,
  );

  assert.equal(event.kind, "open");
  assert.equal(event.account, "Sim1");
  assert.equal(event.version, "v0.4.58");
  assert.equal(event.direction, "long");
  assert.equal(event.quantity, "5");
  assert.equal(event.entry, "31000.25");
  assert.equal(event.stop, "30900.25");
  assert.equal(event.riskDollars, "997.50");
});

test("VWAP Paper Sim1 parser detects v0.4.58 close events with signed side and P/L", () => {
  const event = parseVwapPaperSim1Event(
    "2026-06-17 20:01:00 | VWAP Wave Pullback Balanced v0.4.58 position closed: version=v0.4.58 profile=nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5 prior_qty=-3 bar_time=2026-06-17 20:00:00 entry=31050.25 active_stop=31120.25 last_trade_pnl=-450.75",
    TEST_CONFIG,
  );

  assert.equal(event.kind, "close");
  assert.equal(event.side, "short");
  assert.equal(event.priorQty, "-3");
  assert.equal(event.pnl, -450.75);
});

test("VWAP Paper Sim1 monitor baselines existing logs on first run", async () => {
  const workspace = tempWorkspace();
  const logFile = path.join(workspace.logsDir, "Message Log 2026-06-17.log");
  appendLog(logFile, [
    "2026-06-17 19:01:00 | VWAP Wave Pullback Balanced v0.4.58 order intent: version=v0.4.58 profile=nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5 direction=long bar_time=2026-06-17 19:00:00 qty=5 entry=31000.25 stop=30900.25 actual_risk_dollars=997.50 max_risk_dollars=1100 result=5",
  ]);

  const queued = [];
  const result = await scanVwapPaperSim1EmailEvents({
    config: { ...TEST_CONFIG, logsDir: workspace.logsDir, paperTradesFile: path.join(workspace.root, "missing-paper-trades.json") },
    stateFile: workspace.stateFile,
    queueEmailRequest: (request) => {
      queued.push(request);
      return { request };
    },
    triggerReporterEmailRelay: async () => ({ triggered: true }),
    reason: "test_baseline",
  });

  assert.equal(result.events.length, 0);
  assert.equal(queued.length, 0);
  const state = JSON.parse(fs.readFileSync(workspace.stateFile, "utf8"));
  assert.equal(state.files[logFile].offset, fs.statSync(logFile).size);
});

test("VWAP Paper Sim1 monitor queues the latest ledger close during migration without backfilling history", async () => {
  const workspace = tempWorkspace();
  const paperTradesFile = path.join(workspace.root, "paper-trades.json");
  writePaperTradesFixture(paperTradesFile);
  fs.writeFileSync(workspace.stateFile, JSON.stringify({
    createdAtUtc: "2026-06-17T19:30:00.000Z",
    files: {},
    queuedEventIds: [],
    performance: {},
  }, null, 2));

  const queued = [];
  const reporterRuns = [];
  const queueEmailRequest = (request) => {
    queued.push(request);
    return { request };
  };
  const triggerReporterEmailRelay = async (_config, requestIds, reason) => {
    reporterRuns.push({ requestIds, reason });
    return { triggered: true, requestIds, reason };
  };
  const config = { ...TEST_CONFIG, logsDir: workspace.logsDir, paperTradesFile, emailEventKinds: ["close"] };

  const firstScan = await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest,
    triggerReporterEmailRelay,
    reason: "migration_repair",
  });
  const secondScan = await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest,
    triggerReporterEmailRelay,
    reason: "periodic_scan",
  });

  assert.equal(firstScan.events.length, 1);
  assert.equal(secondScan.events.length, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].requestType, "vwap_paper_trade_close");
  assert.match(queued[0].body, /Trade P\/L: \$650.25/);
  assert.match(queued[0].body, /Closed trades: 1/);
  assert.match(queued[0].body, /Quantity: 5/);
  assert.match(queued[0].body, /Exit: 31065.275/);
  assert.equal(reporterRuns.length, 1);
});

test("VWAP Paper Sim1 monitor reads manual SQLite ledger closes and recovers empty ledger baseline", async () => {
  const workspace = tempWorkspace();
  const paperTradesFile = path.join(workspace.root, "paper-trades.json");
  writeManualPaperTradesFixture(paperTradesFile);
  fs.writeFileSync(workspace.stateFile, JSON.stringify({
    createdAtUtc: "2026-07-21T00:00:00.000Z",
    files: {},
    queuedEventIds: [],
    ledgerClosedTradeIds: [],
    lastLedgerClosedTradeCount: 0,
    performance: {},
  }, null, 2));

  const queued = [];
  const reporterRuns = [];
  const config = { ...TEST_CONFIG, logsDir: workspace.logsDir, paperTradesFile, emailEventKinds: ["close"] };

  const result = await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest: (request) => {
      queued.push(request);
      return { request };
    },
    triggerReporterEmailRelay: async (_config, requestIds, reason) => {
      reporterRuns.push({ requestIds, reason });
      return { triggered: true, requestIds, reason };
    },
    reason: "test_empty_ledger_baseline_recovery",
  });

  assert.equal(result.events.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].requestType, "vwap_paper_trade_close");
  assert.match(queued[0].subject, /^Ocean Trading Paper Sim1: trade closed LONG -\$43.00$/);
  assert.match(queued[0].body, /OCEAN TRADING PAPER TRADE CLOSED/);
  assert.match(queued[0].body, /Manual Trade \| Sim1 \| v0\.4\.58/);
  assert.doesNotMatch(queued[0].body, /OCEAN TRADING VWAP PAPER TRADE CLOSED/);
  assert.doesNotMatch(queued[0].body, /VWAP Wave Pullback Balanced \| Sim1/);
  assert.match(queued[0].body, /Trade P\/L: -\$43.00/);
  assert.match(queued[0].body, /Closed trades: 2/);
  assert.equal(reporterRuns.length, 1);
  const state = JSON.parse(fs.readFileSync(workspace.stateFile, "utf8"));
  assert.equal(state.ledgerCloseRecoveredEmptyBaselineCount, 1);
});

test("VWAP Paper Sim1 monitor queues appended open and close events exactly once", async () => {
  const workspace = tempWorkspace();
  const logFile = path.join(workspace.logsDir, "Message Log 2026-06-17.log");
  appendLog(logFile, ["historical line before monitor startup"]);

  const paperTradesFile = path.join(workspace.root, "paper-trades.json");
  writePaperTradesFixture(paperTradesFile);
  const config = { ...TEST_CONFIG, logsDir: workspace.logsDir, paperTradesFile };
  const queued = [];
  const reporterRuns = [];
  const queueEmailRequest = (request) => {
    queued.push(request);
    return { request };
  };
  const triggerReporterEmailRelay = async (_config, requestIds, reason) => {
    reporterRuns.push({ requestIds, reason });
    return { triggered: true, requestIds, reason };
  };

  await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest,
    triggerReporterEmailRelay,
    reason: "startup",
  });

  appendLog(logFile, [
    "2026-06-17 19:01:00 | VWAP Wave Pullback Balanced v0.4.58 order intent: version=v0.4.58 profile=nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5 direction=long bar_time=2026-06-17 19:00:00 qty=5 entry=31000.25 stop=30900.25 actual_risk_dollars=997.50 max_risk_dollars=1100 result=5",
    "2026-06-17 20:01:00 | VWAP Wave Pullback Balanced v0.4.58 position closed: version=v0.4.58 profile=nasdaq_v0458_hmm_freshness_candidate_audit_risk1100_qty5 prior_qty=5 bar_time=2026-06-17 20:00:00 entry=31000.25 active_stop=31080.25 last_trade_pnl=650.25",
  ]);

  const firstEventScan = await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest,
    triggerReporterEmailRelay,
    reason: "periodic_scan",
  });
  const secondEventScan = await scanVwapPaperSim1EmailEvents({
    config,
    stateFile: workspace.stateFile,
    queueEmailRequest,
    triggerReporterEmailRelay,
    reason: "periodic_scan",
  });

  assert.equal(firstEventScan.events.length, 2);
  assert.equal(secondEventScan.events.length, 0);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((request) => request.requestType), [
    "vwap_paper_trade_open",
    "vwap_paper_trade_close",
  ]);
  assert.match(queued[0].body, /SUMMARY/);
  assert.match(queued[0].body, /Total trade account balance: \$50082\.50/);
  assert.match(queued[0].body, /Long trades: 1/);
  assert.match(queued[0].body, /Short trades: 0/);
  assert.match(queued[0].body, /Realized long P\/L: \$650\.25/);
  assert.match(queued[0].body, /Realized short P\/L: \$0\.00/);
  assert.match(queued[0].body, /Closed trades: 1/);
  assert.match(queued[0].body, /Realized net P\/L: \$650.25/);
  assert.match(queued[0].body, /Trade net P\/L: \$10.00 unrealized/);
  assert.match(queued[0].body, /Account: Sim1/);
  assert.match(queued[0].body, /Risk: 997.50/);
  assert.match(queued[1].body, /Trade P\/L: \$650.25/);
  assert.match(queued[1].body, /Long trades: 1/);
  assert.match(queued[1].body, /Short trades: 0/);
  assert.match(queued[1].body, /Realized long P\/L: \$650\.25/);
  assert.match(queued[1].body, /Realized short P\/L: \$0\.00/);
  assert.match(queued[1].body, /Realized net P\/L: \$650.25/);
  assert.match(queued[1].body, /SUMMARY/);
  assert.equal(reporterRuns.length, 1);
  assert.equal(firstEventScan.performance.closedTrades, 1);
  assert.equal(firstEventScan.performance.netPnl, 650.25);
});
