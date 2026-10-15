import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
let failSearch = false;
let failCharts = false;
const at = 1792065600;
const fixture = (symbol = "NQ=F") => ({ chart: { result: [{
  meta: { instrumentType: "FUTURE", shortName: "Test futures Dec 26", symbol, regularMarketTime: at + 65 },
  timestamp: [at, at + 65],
  indicators: { quote: [{ open: [100, 102], high: [105, 102], low: [99, 102], close: [101, 102], volume: [200, 0] }] },
}], error: null } });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ url: u, headers: opts.headers });
  if (u.pathname.includes("/finance/search")) return new Response("limited", { status: failSearch ? 429 : 404 });
  if (u.pathname.includes("/finance/chart/")) {
    if (failCharts) return new Response("limited", { status: 429 });
    // Reproduce the failing request contract, not a blanket network success.
    if (opts.headers["User-Agent"] !== "QuantTerminal/1.0") return new Response("rejected headers", { status: 429 });
    return Response.json(fixture(decodeURIComponent(u.pathname.split("/").at(-1))));
  }
  return new Response("not mocked", { status: 404 });
};
const P = await import("../lib/providers.js");

test("futures load with identified client headers and explicit delayed metadata", async () => {
  const r = await P.getCandles("YAHOO:NQ=F", "1h", 20);
  assert.equal(r.provider, "Yahoo");
  assert.equal(r.marketData.kind, "delayed");
  assert.equal(r.marketData.executionEligible, false);
  assert.equal(r.marketData.lastTradeTime, at + 65);
  assert.match(r.notes.join(" "), /DELAYED.*not a live execution feed/);
  assert.equal(r.candles.length, 1);
});

test("latest-quote stub updates close but preserves futures OHLC and volume", () => {
  assert.deepEqual(P.parseYahoo(fixture(), "1h"), [
    { time: at, open: 100, high: 105, low: 99, close: 102, volume: 200 },
  ]);
});

test("small polls request a bounded lookback rather than two years", () => {
  assert.equal(P.yahooRange("1h", "1h", 10), "5d");
  assert.equal(P.yahooRange("1m", "1m", 20000), "7d");
  assert.equal(P.yahooRange("15m", "15m", 20000), "60d");
  assert.equal(P.yahooRange("1h", "4h", 3000), "730d");
});

test("autocomplete rate limits cannot switch off working chart requests", async () => {
  failSearch = true;
  await P.search("Nasdaq");
  assert.equal(P.yahooAvailable(), true);
  const r = await P.getCandles("YAHOO:ES=F", "15m", 20);
  assert.ok(r.candles.length);
  const searchCalls = calls.filter((r) => r.url.pathname.includes("/finance/search")).length;
  const hits = await P.search("S&P 500");
  assert.ok(hits.some((r) => r.symbol === "YAHOO:ES=F" && r.type === "futures"));
  assert.equal(calls.filter((r) => r.url.pathname.includes("/finance/search")).length, searchCalls);
});

test("actual chart rate limits still back off instead of hammering the provider", async () => {
  failCharts = true;
  await assert.rejects(P.getCandles("YAHOO:GC=F", "5m", 20), /429/);
  assert.equal(P.yahooAvailable(), false);
  const count = calls.length;
  await assert.rejects(P.getCandles("YAHOO:GC=F", "1h", 20), /rate limiting/);
  assert.equal(calls.length, count);
});
