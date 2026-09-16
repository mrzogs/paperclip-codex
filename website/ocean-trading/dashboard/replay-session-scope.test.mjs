import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scopeReplayTelemetry,
  selectReplayTradeLogFallbackAccounts,
  clearReplayAccount,
  visibleReplayTrades,
} from "./replay-session-scope.mjs";
import { withManifestBuildLock } from "./manifest-build-lock.mjs";

const row = (id, day, account = "Sim1", overrides = {}) => ({
  telemetryTradeId: id, account, instanceId: "replay", symbol: "MNQU26",
  entryAtUtc: `2026-${day}T12:00:00Z`, capturedAtUtc: new Date(Date.UTC(2026, 8, 4, 12, id)).toISOString(),
  ...overrides,
});
const stateFrom = (result) => Object.fromEntries(Object.entries(result.scopes).map(([key, value]) => [key, { telemetryScope: value }]));

test("restart isolates current active SIM without retroactively clearing inactive accounts", () => {
  const rows = [row(1, "05-20", "Sim2"), row(2, "05-01", "Sim2"), row(3, "08-28"), row(4, "08-03"), row(5, "08-07")];
  const result = scopeReplayTelemetry(rows);
  assert.deepEqual(result.rows.map((r) => r.telemetryTradeId), [1, 2, 4, 5]);
  assert.equal(result.scopes.Sim1.reason, "telemetry_entry_clock_rewound");
  assert.equal(result.scopes.Sim2.runId, null);
});

test("refresh, process restart, day and month rollover retain the run", () => {
  let rows = [row(1, "05-01"), row(2, "05-31")];
  const first = scopeReplayTelemetry(rows);
  rows = [...rows, row(3, "06-01")];
  const next = scopeReplayTelemetry(rows, JSON.parse(JSON.stringify(stateFrom(first))));
  assert.equal(next.scopes.Sim1.runId, first.scopes.Sim1.runId);
  assert.equal(next.rows.length, 3);
  assert.deepEqual(scopeReplayTelemetry(rows, stateFrom(next)), next);
});

test("an open telemetry row detects a new run before the first trade closes", () => {
  const rows = [row(1, "05-20"), row(2, "05-25")];
  const first = scopeReplayTelemetry(rows);
  const open = row(3, "05-01", "Sim1", { telemetryStatus: "open" });
  const next = scopeReplayTelemetry([...rows, open], stateFrom(first));
  assert.deepEqual(next.rows, [open]);
  assert.notEqual(next.scopes.Sim1.runId, first.scopes.Sim1.runId);
  const closed = { ...open, telemetryStatus: "closed" };
  assert.equal(scopeReplayTelemetry([...rows, closed], stateFrom(next)).scopes.Sim1.runId, next.scopes.Sim1.runId);
});

test("a subsequently active second SIM resets only its own bucket", () => {
  const rows = [row(1, "05-20", "Sim2"), row(2, "08-03")];
  const first = scopeReplayTelemetry(rows);
  const next = scopeReplayTelemetry([...rows, row(3, "05-01", "Sim2")], stateFrom(first));
  assert.deepEqual(next.rows.map((r) => r.telemetryTradeId), [2, 3]);
  assert.equal(next.scopes.Sim1.runId, first.scopes.Sim1.runId);
});

test("separate symbols do not create false backtracks", () => {
  const rows = [row(1, "05-20"), row(2, "05-01", "Sim1", { symbol: "ESU26" })];
  assert.equal(scopeReplayTelemetry(rows).rows.length, 2);
});

test("source replacement with recycled IDs changes run identity", () => {
  const first = scopeReplayTelemetry([row(1, "05-20")]);
  const next = scopeReplayTelemetry([row(1, "06-20", "Sim1", { capturedAtUtc: "2026-09-05T12:00:00Z" })], stateFrom(first));
  assert.notEqual(next.scopes.Sim1.runId, first.scopes.Sim1.runId);
  assert.equal(next.scopes.Sim1.reason, "telemetry_source_replaced");
});

test("newer replay logs bypass only stale account telemetry scopes", () => {
  const telemetryRows = [
    row(1, "07-01", "Sim1", { capturedAtUtc: "2026-09-08T10:00:00Z" }),
    row(2, "07-01", "Sim2", { capturedAtUtc: "2026-09-08T10:05:00Z" }),
  ];
  const fallback = selectReplayTradeLogFallbackAccounts({
    latestLogMtimeByAccount: {
      Sim1: Date.parse("2026-09-08T10:10:00Z"),
      Sim2: Date.parse("2026-09-08T10:05:30Z"),
      Sim3: Date.parse("2026-09-08T10:06:00Z"),
    },
    telemetryRows,
    telemetryScopes: {
      Sim1: { runId: "sim1-run" },
      Sim2: { runId: "sim2-run" },
    },
  });

  assert.deepEqual(fallback, ["Sim1", "Sim3"]);
});

test("fresh scoped telemetry retains priority over replay logs", () => {
  const fallback = selectReplayTradeLogFallbackAccounts({
    latestLogMtimeByAccount: { Sim1: Date.parse("2026-09-08T10:00:30Z") },
    telemetryRows: [row(1, "07-01", "Sim1", { capturedAtUtc: "2026-09-08T10:00:00Z" })],
    telemetryScopes: { Sim1: { runId: "sim1-run" } },
  });

  assert.deepEqual(fallback, []);
});

test("Clear persists across generated session IDs, price corrections and historical replay dates", () => {
  const a = { replayAccountId: "Sim1", sourceTradeId: "sqlite-10", capturedAtUtc: "2026-09-04T12:00:00Z", observedAtUtc: "2026-05-01T12:00:00Z" };
  const b = { ...a, replayAccountId: "Sim2" };
  const clears = clearReplayAccount({ accounts: {} }, "Sim1", [a, b]);
  const newTrade = { ...a, sourceTradeId: "sqlite-11" };
  const accounts = {
    Sim1: { accountId: "Sim1", groupedTrades: [{ ...a, tradeId: "new-session-id", realizedPnlDollars: 200 }, newTrade] },
    Sim2: { accountId: "Sim2", groupedTrades: [b] },
  };
  assert.deepEqual(visibleReplayTrades(accounts, JSON.parse(JSON.stringify(clears))), [newTrade, b]);
  const twice = clearReplayAccount(clears, "Sim1", [a]);
  assert.equal(twice.accounts.Sim1.hiddenTradeKeys.length, 1);
});

test("new run of identical trade gets a new source ID and survives a previous clear", () => {
  const a = { replayAccountId: "Sim1", sourceTradeId: "sqlite-10", entryKey: "2026-05-01" };
  const clears = clearReplayAccount({}, "Sim1", [a]);
  const b = { ...a, sourceTradeId: "sqlite-11" };
  assert.deepEqual(visibleReplayTrades({ Sim1: { accountId: "Sim1", groupedTrades: [a, b] } }, clears), [b]);
});

test("concurrent manifest publications serialize and release their lock after failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-manifest-lock-"));
  const lock = path.join(directory, "build.lock");
  const events = [];
  try {
    const first = withManifestBuildLock(lock, async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 150));
      events.push("first-end");
    });
    const second = withManifestBuildLock(lock, () => events.push("second"));
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second"]);
    await assert.rejects(withManifestBuildLock(lock, () => { throw new Error("test failure"); }));
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
