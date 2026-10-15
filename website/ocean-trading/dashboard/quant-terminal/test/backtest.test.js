import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backtest, EXAMPLE_STRATEGIES, tradesCsv } from '../public/lib/backtest.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));

test('fills on the next bar open, never the signal bar', () => {
  const r = backtest(bars, EXAMPLE_STRATEGIES['EMA cross (9/21)']);
  assert.ok(r.trades.length > 5);
  for (const t of r.trades) {
    const i = bars.findIndex((b) => b.time === t.entryTime);
    assert.ok(i > 0);
    assert.ok(Math.abs(t.entryPrice - bars[i].open * 1.0005) < 1e-6, 'entry = open x (1 + slippage)');
  }
});

test('equity curve accounts for every trade', () => {
  const s = EXAMPLE_STRATEGIES['RSI mean reversion (30/55)'];
  const r = backtest(bars, { ...s, initialCapital: 10000 });
  const sumPnl = r.trades.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(10000 + sumPnl - r.equity.at(-1).value) < 1e-6);
  assert.equal(r.stats.totalTrades, r.trades.length);
});

test('stops cap the loss of a losing trade', () => {
  const r = backtest(bars, { ...EXAMPLE_STRATEGIES['EMA cross (9/21)'], stopLossPct: 2, feePct: 0, slippagePct: 0 });
  const stopped = r.trades.filter((t) => t.exitReason === 'Stop');
  assert.ok(stopped.length > 0);
  for (const t of stopped) assert.ok(t.pnlPct >= -2 - 15, 'gap through the stop is the only way past -2%');
});

test('shorts make money when price falls', () => {
  const down = Array.from({ length: 60 }, (_, i) => ({ time: i * 86400, open: 100 - i, high: 101 - i, low: 99 - i, close: 100 - i, volume: 1 }));
  const r = backtest(down, { indicators: {}, entryShort: [{ left: 'close', op: '<', right: 95 }], exitShort: [{ left: 'close', op: '<', right: 50 }], feePct: 0, slippagePct: 0 });
  assert.equal(r.trades[0].side, 'short');
  assert.ok(r.trades[0].pnl > 0);
});

test('every example strategy runs and the trades export to CSV', () => {
  for (const [name, s] of Object.entries(EXAMPLE_STRATEGIES)) {
    const r = backtest(bars, s);
    assert.ok(r.equity.length === bars.length, name);
    assert.ok(tradesCsv(r.trades).startsWith('side,'));
  }
});

import { linePrice, conditionFn } from '../public/lib/backtest.js';

test('a drawn line gives its price at any time, within its reach', () => {
  const trend = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'none' });
  assert.equal(trend(150), 15);
  assert.ok(Number.isNaN(trend(250)), 'a trend line stops at its second point');
  const ray = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'right' });
  assert.equal(ray(300), 30);
  assert.ok(Number.isNaN(ray(50)), 'a ray has nothing behind its start');
  const ext = linePrice({ t1: 100, p1: 10, t2: 200, p2: 20, extend: 'both' });
  assert.equal(ext(0), 0);
});

test('price crossing a drawn line is detected bar by bar', () => {
  const series = [5, 6, 7, 12, 13].map((c, i) => ({ time: i * 10, open: c, high: c, low: c, close: c, volume: 1 }));
  const rising = { line: { t1: 0, p1: 8, t2: 40, p2: 12, extend: 'right' } }; // 8, 9, 10, 11, 12
  const test = conditionFn(series, {})({ left: 'close', op: 'crossesAbove', right: rising });
  assert.deepEqual(series.map((_, i) => test(i)), [false, false, false, true, false]);
});
