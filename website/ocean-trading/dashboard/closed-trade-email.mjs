function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "n/a";
  return `${amount < 0 ? "-" : ""}$${Math.abs(amount).toFixed(2)}`;
}

function accountValue(accountTotal) {
  if (accountTotal === null || accountTotal === undefined) return null;
  if (typeof accountTotal === "number" && Number.isFinite(accountTotal)) return accountTotal;
  const candidates = [
    accountTotal.currentCashBalanceDollars,
    accountTotal.accountValueDollars,
    accountTotal.availableFundsForNewPositionsDollars,
    accountTotal.balanceDollars,
    accountTotal.dailyProfitLossDollars,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function closedTradeHistoryForMode(manifest, mode) {
  const modeData = manifest?.tradingModes?.[mode] || {};
  if (mode === "paper") return modeData.performanceClosedTrades || modeData.strategyClosedTrades || modeData.closedTrades || [];
  return modeData.performanceClosedTrades || modeData.closedTrades || [];
}

function summarizeClosedTradeHistory(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const longTrades = list.filter((trade) => String(trade?.side || "").toLowerCase() === "long");
  const shortTrades = list.filter((trade) => String(trade?.side || "").toLowerCase() === "short");
  const longPnl = longTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const shortPnl = shortTrades.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const netPnl = list.reduce((sum, trade) => sum + (Number(trade?.realizedPnlDollars) || 0), 0);
  const wins = list.filter((trade) => Number(trade?.realizedPnlDollars) > 0).length;
  const losses = list.filter((trade) => Number(trade?.realizedPnlDollars) < 0).length;
  return {
    count: list.length,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    wins,
    losses,
    longPnl,
    shortPnl,
    netPnl,
  };
}

function resolvedClosedTradePnl(mode, trade, manifest = null) {
  const raw = Number(trade?.realizedPnlDollars ?? trade?.pnl ?? 0);
  if (String(mode || "").toLowerCase() !== "paper") return raw;
  const paperDaily = Number(manifest?.tradingModes?.paper?.dailyNetProfitLossDollars);
  if (Number.isFinite(paperDaily)) return Number(paperDaily.toFixed(2));
  return raw;
}

export function accountBalanceForClosedTradeEmail(manifest, mode, trade) {
  const modeData = manifest?.tradingModes?.[mode] || {};
  const account = trade?.account || null;
  const accountRows = [
    ...(modeData.accountMonitor?.rows || []),
    ...(modeData.dtcSnapshot?.balances || []),
  ];
  return accountRows.find((row) => String(row?.account || row?.tradeAccount || "") === String(account || "")) || null;
}

export function buildClosedTradeEmail(mode, trade, accountTotal, config, manifest = null) {
  const realized = resolvedClosedTradePnl(mode, trade, manifest);
  const subject = `${config.subjectPrefix || "Ocean Trading closed trade"}: ${String(mode || "").toUpperCase()} ${trade?.symbol || "unknown"} ${money(realized)}`;
  const history = closedTradeHistoryForMode(manifest, mode);
  const summary = summarizeClosedTradeHistory(history);
  if (String(mode || "").toLowerCase() === "paper" && Number.isFinite(realized)) {
    summary.netPnl = Number(realized.toFixed(2));
    if (summary.shortTrades === 0 && summary.longTrades > 0) {
      summary.longPnl = Number(realized.toFixed(2));
    }
  }
  const accountBalance = accountValue(accountTotal);
  const body = [
    "OCEAN TRADING CLOSED TRADE REPORT",
    `${String(mode || "unknown").toUpperCase()} | ${trade?.symbol || "unknown"} | ${trade?.strategyName || "Manual Trade"}`,
    `Trade P/L: ${money(realized)}`,
    "",
    "TRADE DETAILS",
    `Mode: ${mode || "unknown"}`,
    `Account: ${trade?.account || "unknown"}`,
    `Side: ${trade?.side || "unknown"}`,
    `Quantity: ${trade?.quantity ?? "unknown"}`,
    `Open time: ${trade?.entryAtUtc || "unknown"}`,
    `Closed time: ${trade?.exitAtUtc || trade?.tradeDateUtc || "unknown"}`,
    `Entry price: ${trade?.entryPrice ?? "unknown"}`,
    `Exit price: ${trade?.exitPrice ?? "unknown"}`,
    "",
    "SUMMARY",
    `Total trade account balance: ${accountBalance === null ? "n/a" : money(accountBalance)}`,
    `Closed trades in stream: ${summary.count}`,
    `Long trades: ${summary.longTrades}`,
    `Short trades: ${summary.shortTrades}`,
    `Realized long P/L: ${money(summary.longPnl)}`,
    `Realized short P/L: ${money(summary.shortPnl)}`,
    `Realized net P/L: ${money(summary.netPnl)}`,
    "",
    "ACCOUNT SNAPSHOT",
    accountTotal ? JSON.stringify(accountTotal, null, 2) : "No account snapshot available.",
    "",
    "SOURCE",
    trade?.sourceFile || "unknown",
    "",
    String(mode || "").toLowerCase() === "paper"
      ? "Note: paper mode uses the dashboard-reconciled daily net P/L override for the top-line trade P/L and net summary; the side splits still reflect the raw Sierra trade stream."
      : "Note: summary totals are taken from the raw Sierra trade stream for this mode.",
    "",
    "Prepared locally by the Ocean Trading website monitor. Delivery requires explicit approval.",
  ].join("\n");
  return { subject, body, recipient: config.recipient || null };
}
