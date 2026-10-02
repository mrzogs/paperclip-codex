import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.OCEAN_REPLAY_HTTP_TEST === "1";
const base = process.env.OCEAN_TEST_URL || "http://127.0.0.1:3102";
const get = (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(95000), ...options });

test("refresh stays responsive and concurrent publications preserve replay scope", { skip: !enabled, timeout: 120000 }, async () => {
  const before = await (await get("/api/manifest")).json();
  const requests = [get("/api/monitor/reconcile", { method: "POST" }), get("/api/rebuild")];
  const started = performance.now();
  const page = await get("/replay-monitor.html");
  assert.equal(page.status, 200);
  assert.ok(performance.now() - started < 2000, "static frontend must not wait for rebuilds");
  for (const request of requests) {
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const after = await (await get("/api/manifest")).json();
  const previousScopes = before.replayMonitor.currentSession.audit.telemetryRunScopes;
  const currentScopes = after.replayMonitor.currentSession.audit.telemetryRunScopes;
  for (const [account, scope] of Object.entries(previousScopes)) {
    if (scope.lastId === currentScopes[account]?.lastId) {
      assert.equal(currentScopes[account].runId, scope.runId);
    }
  }
  const monitor = await (await get("/api/monitor/status")).json();
  assert.equal(monitor.running, true);
  assert.equal(monitor.error, null);
});
