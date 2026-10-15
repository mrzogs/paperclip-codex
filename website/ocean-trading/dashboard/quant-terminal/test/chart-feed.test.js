import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.window = { LightweightCharts: {} };
const { ChartPane } = await import("../public/js/chart.js");
const { api } = await import("../public/js/api.js");

test("failed initial chart load schedules a recovery and removes old feed labels", async (t) => {
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { timers.push({ fn, ms }); return 1; });
  t.mock.method(api, "candles", async () => { throw new Error("provider unavailable"); });
  const pane = {
    app: { settings: {} }, cfg: { symbol: "YAHOO:NQ=F", tf: "4h" },
    marketData: { contract: "old contract" }, notes: ["old note"], provider: "old",
    stopLive() {}, showMsg(s) { this.message = s; }, render() {},
    load: ChartPane.prototype.load,
  };
  await pane.load();
  assert.match(pane.message, /provider unavailable/);
  assert.equal(pane.marketData, null);
  assert.deepEqual(pane.notes, []);
  assert.equal(timers[0].ms, 60000);
  assert.equal(typeof timers[0].fn, "function");
});

test("delayed polling is throttled and update failures are visible", async (t) => {
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { timers.push({ fn, ms }); return 1; });
  t.mock.method(api, "candles", async () => { throw new Error("provider unavailable"); });
  const pane = {
    cfg: { symbol: "YAHOO:ES=F", tf: "1h" }, marketData: { kind: "delayed" },
    updateLegend() { this.legendUpdated = true; },
  };
  ChartPane.prototype.poll.call(pane);
  assert.equal(timers[0].ms, 60000);
  await timers[0].fn();
  assert.equal(pane.feedError, true);
  assert.equal(pane.legendUpdated, true);
  assert.equal(timers[1].ms, 60000);
});
