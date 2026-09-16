import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

function replayTradeSessionDay(trade) {
  const explicit = String(trade?.lucidSessionDay || trade?.sessionDay || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const entryKey = String(trade?.entryKey || "");
  return /^\d{4}-\d{2}-\d{2}/.test(entryKey) ? entryKey.slice(0, 10) : null;
}

function replayPeriods(trades) {
  const grouped = new Map();
  for (const trade of trades) {
    const period = replayTradeSessionDay(trade);
    const pnl = Number(trade?.realizedPnlDollars);
    if (!period || !Number.isFinite(pnl)) continue;
    grouped.set(period, (grouped.get(period) || 0) + pnl);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

test("replay calendar grouping prefers Lucid session day over entry date", () => {
  const grouped = replayPeriods([
    { entryKey: "2026-05-01T23:05", lucidSessionDay: "2026-05-02", realizedPnlDollars: 100 },
    { entryKey: "2026-05-02T00:15", lucidSessionDay: "2026-05-02", realizedPnlDollars: -25 },
  ]);

  assert.deepEqual(grouped, [["2026-05-02", 75]]);
});

test("replay calendar grouping still falls back to entry date when no session-day field exists", () => {
  const grouped = replayPeriods([
    { entryKey: "2026-05-01T10:00", realizedPnlDollars: 10 },
    { entryKey: "2026-05-01T11:00", realizedPnlDollars: -4 },
  ]);

  assert.deepEqual(grouped, [["2026-05-01", 6]]);
});

test("dashboard sources wire the replay session-day field end to end", () => {
  const appSource = fs.readFileSync(path.join(dashboardDir, "public", "app.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");

  assert.match(appSource, /trade\?\.lucidSessionDay/);
  assert.match(manifestSource, /lucidSessionDay:\s*cleanText\(event\?\.lucidSessionDay \|\| event\?\.sessionDay\)/);
});

test("replay closed trades use chart date and preceding Sierra position rows", () => {
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");

  assert.match(manifestSource, /function replayChartDateKeyFromUtc/);
  assert.match(manifestSource, /lucidSessionDay:\s*replayChartDateKeyFromUtc\(trade\.entryAtUtc \|\| trade\.tradeDateUtc\)/);
  assert.match(manifestSource, /const observedPositionKey = recordAccount && symbol/);
  assert.match(manifestSource, /recordType !== 2 && observedPositionKey && Number\.isFinite\(recordedPosition\)/);
});

test("replay monitor discovers and watches all simulated replay accounts", () => {
  const appSource = fs.readFileSync(path.join(dashboardDir, "public", "app.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");
  const monitorSource = fs.readFileSync(path.join(dashboardDir, "monitor.mjs"), "utf8");

  assert.match(manifestSource, /function isReplayAccountId/);
  assert.ok(manifestSource.includes("(?!None\\.)"));
  const filePredicate = manifestSource.match(/function isReplayTradeActivityFile\(entry\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(filePredicate);
  const acceptsFile = new Function("entry", filePredicate);
  for (const account of ["Sim1", "Sim2", "Sim7"]) {
    assert.equal(acceptsFile({ name: `TradeActivityLog_2026-09-04_UTC.${account}.simulated.data` }), true);
    assert.equal(acceptsFile({ name: `TradeActivityLog_2026-09-04_UTC.${account}.data` }), true);
  }
  assert.equal(acceptsFile({ name: "TradeActivityLog_2026-09-04_UTC.None.data" }), false);
  assert.match(appSource, /function isReplayAccountId/);
  assert.match(monitorSource, /function isReplayLog/);
  assert.match(monitorSource, /mode: "replay"/);
});

test("replay monitor prefers OQL lifecycle CSV for replay report P/L", () => {
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");

  assert.match(manifestSource, /function buildReplayClosedTradesFromLifecycleCsv/);
  assert.match(manifestSource, /oql_replay_lifecycle_csv/);
  assert.match(manifestSource, /lifecycleClosedTrades/);
  assert.match(manifestSource, /pnlSource: replayTradeSource/);
});

test("replay attribution recognizes OQL VCB strategy evidence", () => {
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");
  const classifierBody = manifestSource.match(/function classifyTradeFromContext\(context\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(classifierBody);
  const classify = new Function("context", "paperTradeAttribution", classifierBody);

  assert.equal(
    classify(["OQL VCB D4.2 (Diagnostic Margins / Unchanged D4 Rules / Native Brackets)"], null).strategyName,
    "OQL VCB D4.2",
  );
  assert.equal(classify(["OQLVCBI8|5319|5373|5481"], null).strategyName, "OQL VCB D4.2");
  assert.equal(classify(["OQL_VCB_V2_3|S=119415|E=119662|Q=1"], null).strategyName, "OQL VCB Strategy v2.3");
  assert.equal(classify([], null).strategyName, "Manual Trade");
});

test("replay parser accepts recognized strategy evidence from the Sierra study field", () => {
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");

  assert.match(manifestSource, /if \(studyContext\) \{/);
  assert.match(manifestSource, /recordClassification\?\.tradeSource === "strategy"/);
});

test("calendar rerenders reconnect replay account and clear controls", () => {
  const appSource = fs.readFileSync(path.join(dashboardDir, "public", "app.js"), "utf8");
  const rerender = appSource.match(/function rerenderReplayDashboard\(target, session\) \{([\s\S]*?)\n\}/)?.[1];
  assert.match(rerender, /bindReplayMonitorActions\(nextTarget/);
  assert.match(rerender, /bindReplayPerformanceCalendar\(nextTarget/);
});
