const BACKTRACK_MS = 5 * 60 * 1000;
const TRADE_LOG_FALLBACK_GRACE_MS = 60 * 1000;

const captureKey = (row) => `${row.telemetryTradeId}:${row.capturedAtUtc}`;
const streamKey = (row) => `${row.instanceId || ""}|${row.symbol || ""}`;

// Ingestion IDs advance in real time; entry timestamps advance in replay time.
// Never use the wall-clock account-snapshot date as the replay clock.
export function scopeReplayTelemetry(rows, previousAccounts = {}) {
  const ordered = rows.filter((row) => row.telemetryTradeId > 0 && Number.isFinite(Date.parse(row.entryAtUtc)))
    .sort((a, b) => a.telemetryTradeId - b.telemetryTradeId);
  const latest = [...ordered].sort((a, b) => String(a.capturedAtUtc).localeCompare(String(b.capturedAtUtc))).at(-1);
  const activeAccountId = latest?.account || null;
  const scopes = {};
  for (const accountId of new Set([...Object.keys(previousAccounts), ...ordered.map((row) => row.account)])) {
    const accountRows = ordered.filter((row) => row.account === accountId);
    const previous = previousAccounts[accountId]?.telemetryScope || null;
    if (!accountRows.length) {
      if (previous) scopes[accountId] = previous;
      continue;
    }
    const previousCursor = accountRows.find((row) => row.telemetryTradeId === previous?.lastId);
    const replaced = previous && (!previousCursor || captureKey(previousCursor) !== previous.lastCaptureKey);
    let scope = previous && !replaced
      ? { ...previous, clocks: { ...previous.clocks } }
      : { lastId: 0, lastCaptureKey: null, clocks: {}, startId: null, runId: null };
    const bootstrapActive = !previous && accountId === activeAccountId;
    for (const row of accountRows) {
      if (row.telemetryTradeId <= scope.lastId) continue;
      const clock = Date.parse(row.entryAtUtc);
      const key = streamKey(row);
      const rewind = scope.clocks[key] != null && clock < scope.clocks[key] - BACKTRACK_MS;
      if ((rewind && (previous || bootstrapActive)) || ((bootstrapActive || replaced) && !scope.runId)) {
        scope.startId = row.telemetryTradeId;
        scope.runId = `telemetry-${accountId}-${captureKey(row)}`;
        scope.reason = rewind ? "telemetry_entry_clock_rewound" : replaced ? "telemetry_source_replaced" : "telemetry_initial_run";
        scope.clocks = {};
      }
      scope.clocks[key] = clock;
      scope.lastId = row.telemetryTradeId;
      scope.lastCaptureKey = captureKey(row);
    }
    scopes[accountId] = scope;
  }
  const includes = (row) => !scopes[row.account]?.runId || row.telemetryTradeId >= scopes[row.account].startId;
  return { scopes, activeAccountId, rows: rows.filter(includes) };
}

export function selectReplayTradeLogFallbackAccounts({
  latestLogMtimeByAccount = {},
  telemetryRows = [],
  telemetryScopes = {},
  graceMs = TRADE_LOG_FALLBACK_GRACE_MS,
} = {}) {
  const latestCaptureByAccount = new Map();
  for (const row of telemetryRows) {
    const accountId = String(row?.account || "").trim();
    const captureMs = Date.parse(row?.capturedAtUtc);
    if (!accountId || !Number.isFinite(captureMs)) continue;
    latestCaptureByAccount.set(accountId, Math.max(latestCaptureByAccount.get(accountId) || 0, captureMs));
  }

  const fallbackAccounts = [];
  for (const [accountId, value] of Object.entries(latestLogMtimeByAccount || {})) {
    const logMtimeMs = Number(value);
    if (!accountId || !Number.isFinite(logMtimeMs)) continue;
    const latestCaptureMs = latestCaptureByAccount.get(accountId);
    const hasScopedTelemetry = Boolean(telemetryScopes?.[accountId]?.runId);
    if (!hasScopedTelemetry || !Number.isFinite(latestCaptureMs) || logMtimeMs > latestCaptureMs + Math.max(0, Number(graceMs) || 0)) {
      fallbackAccounts.push(accountId);
    }
  }
  return fallbackAccounts.sort();
}

export function replayTradeIdentity(trade) {
  if (trade.sourceTradeId) return JSON.stringify([trade.replayAccountId, trade.sourceTradeId, trade.capturedAtUtc || ""]);
  return JSON.stringify([trade.replayAccountId, trade.sourceFile, trade.entryKey, trade.observedAtUtc, trade.direction, trade.entry]);
}

export function clearReplayAccount(clears, accountId, trades, clearedAtUtc = new Date().toISOString()) {
  const previous = clears.accounts?.[accountId] || {};
  return {
    ...clears,
    version: 1,
    accounts: {
      ...clears.accounts,
      [accountId]: {
        clearedAtUtc,
        hiddenTradeKeys: [...new Set([
          ...(previous.hiddenTradeKeys || []),
          ...trades.filter((trade) => trade.replayAccountId === accountId).map(replayTradeIdentity),
        ])],
      },
    },
  };
}

export function visibleReplayTrades(accounts, clears) {
  return Object.values(accounts).flatMap((account) => {
    const hidden = new Set(clears.accounts?.[account.accountId]?.hiddenTradeKeys || []);
    return (account.groupedTrades || []).filter((trade) => !hidden.has(replayTradeIdentity(trade)));
  });
}

const money = (value) => Number((Number(value) || 0).toFixed(2));

export function applyReplayClearsToSession(session, clears = { accounts: {} }) {
  if (!session) return session;
  const groupedTrades = Array.isArray(session.groupedTrades) ? session.groupedTrades : [];
  const openPositions = Array.isArray(session.openPositions) ? session.openPositions : [];
  const accountIds = new Set([
    ...(session.replayAccounts || []).map((account) => account.accountId),
    ...(session.replayAccountSummaries || []).map((account) => account.accountId),
    ...groupedTrades.map((trade) => trade.replayAccountId),
  ].filter(Boolean));
  const accounts = Object.fromEntries([...accountIds].map((accountId) => [accountId, {
    accountId,
    groupedTrades: groupedTrades.filter((trade) => trade.replayAccountId === accountId),
  }]));
  const visibleTrades = visibleReplayTrades(accounts, clears);
  const openPnl = (accountId = null) => money(openPositions
    .filter((position) => !accountId || String(position.account || "Sim1") === accountId)
    .reduce((sum, position) => sum + (Number(position.unrealizedPnlDollars) || 0), 0));
  const closedPnl = (trades) => money(trades.reduce((sum, trade) => sum + (Number(trade.realizedPnlDollars) || 0), 0));
  const summarize = (account) => {
    const accountId = account.accountId;
    const all = groupedTrades.filter((trade) => trade.replayAccountId === accountId);
    const visible = visibleTrades.filter((trade) => trade.replayAccountId === accountId);
    const accountOpenPnl = openPnl(accountId);
    return {
      ...account,
      groupedTradesCount: all.length,
      groupedTradesVisibleCount: visible.length,
      realizedTrades: visible.length,
      closedNetPnlDollars: closedPnl(visible),
      openPnlDollars: accountOpenPnl,
      netPnlDollars: money(closedPnl(visible) + accountOpenPnl),
    };
  };
  const replayAccounts = (session.replayAccounts || []).map(summarize);
  const summarySource = session.replayAccountSummaries?.length ? session.replayAccountSummaries : replayAccounts;
  const replayAccountSummaries = summarySource.map(summarize);
  const allClosedPnl = closedPnl(groupedTrades);
  const visibleClosedPnl = closedPnl(visibleTrades);
  const totalOpenPnl = openPnl();
  return {
    ...session,
    replayAccounts,
    replayAccountSummaries,
    groupedTradesVisible: visibleTrades,
    groupedTradesCount: groupedTrades.length,
    groupedTradesVisibleCount: visibleTrades.length,
    groupedTradesNetPnlDollars: money(visibleClosedPnl + totalOpenPnl),
    closedTradesNetPnlDollars: visibleClosedPnl,
    openPositionsNetPnlDollars: totalOpenPnl,
    lastClearedAtUtc: clears.accounts?.[session.activeReplayAccountId]?.clearedAtUtc || null,
    audit: {
      ...(session.audit || {}),
      groupedTradesFound: groupedTrades.length,
      groupedTradesVisible: visibleTrades.length,
      groupedTradesHiddenAfterClear: Math.max(groupedTrades.length - visibleTrades.length, 0),
      groupedTradesNetPnlDollars: money(allClosedPnl + totalOpenPnl),
      visibleNetPnlDollars: money(visibleClosedPnl + totalOpenPnl),
      closedNetPnlDollars: allClosedPnl,
      openNetPnlDollars: totalOpenPnl,
      accounts: replayAccountSummaries,
    },
  };
}
