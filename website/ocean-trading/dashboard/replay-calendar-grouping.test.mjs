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

test("replay monitor discovers and watches all simulated replay accounts", () => {
  const appSource = fs.readFileSync(path.join(dashboardDir, "public", "app.js"), "utf8");
  const manifestSource = fs.readFileSync(path.join(dashboardDir, "build-manifest.mjs"), "utf8");
  const monitorSource = fs.readFileSync(path.join(dashboardDir, "monitor.mjs"), "utf8");

  assert.match(manifestSource, /function isReplayAccountId/);
  assert.ok(manifestSource.includes("(?!None\\.)"));
  assert.ok(manifestSource.includes("([^.]+)\\.simulated\\.data"));
  assert.match(appSource, /function isReplayAccountId/);
  assert.match(monitorSource, /function isReplayLog/);
  assert.match(monitorSource, /mode: "replay"/);
});
