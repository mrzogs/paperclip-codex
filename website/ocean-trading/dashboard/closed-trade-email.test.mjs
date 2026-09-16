import assert from "node:assert/strict";
import test from "node:test";

import { buildClosedTradeEmail } from "./closed-trade-email.mjs";

const CONFIG = {
  subjectPrefix: "Ocean Trading closed trade",
  recipient: "wayne.vanheerden@gmail.com",
};

const TRADE = {
  account: "Sim1",
  strategyName: "VWAP Wave Pullback",
  side: "Long",
  symbol: "MNQU26_FUT_CME",
  quantity: 133,
  entryAtUtc: "2026-06-18 08:40:00 UTC",
  exitAtUtc: "2026-06-18 08:45:07 UTC",
  entryPrice: 30396.3575,
  exitPrice: 30402.0808,
  realizedPnlDollars: 1522.4,
  sourceFile: "TradeActivityLog_2026-06-18_UTC.Sim1.simulated.data",
};

test("paper closed-trade email uses the reconciled daily P/L override", () => {
  const manifest = {
    tradingModes: {
      paper: {
        dailyNetProfitLossDollars: 1201,
        performanceClosedTrades: [TRADE, TRADE, TRADE, TRADE],
      },
    },
  };

  const email = buildClosedTradeEmail("paper", TRADE, null, CONFIG, manifest);

  assert.match(email.subject, /\$1201\.00$/);
  assert.match(email.body, /Trade P\/L: \$1201\.00/);
  assert.match(email.body, /Closed trades in stream: 4/);
  assert.match(email.body, /Long trades: 4/);
  assert.match(email.body, /Realized long P\/L: \$1201\.00/);
  assert.match(email.body, /Realized net P\/L: \$1201\.00/);
  assert.match(email.body, /SUMMARY/);
});

test("live closed-trade email keeps the raw trade P/L", () => {
  const manifest = {
    tradingModes: {
      live: {
        closedTrades: [TRADE],
      },
    },
  };

  const email = buildClosedTradeEmail("live", TRADE, null, CONFIG, manifest);

  assert.match(email.subject, /\$1522\.40$/);
  assert.match(email.body, /Trade P\/L: \$1522\.40/);
  assert.match(email.body, /Realized net P\/L: \$1522\.40/);
});
