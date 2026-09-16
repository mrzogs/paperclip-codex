(function attachBrokerAccountBalance(root) {
  const EPSILON = 0.005;

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timestampMs(value) {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function accountKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function snapshotBalance(snapshot, preferCash = false) {
    const accountValue = finiteNumber(snapshot?.accountValueDollars);
    const cashBalance = finiteNumber(snapshot?.cashBalanceDollars);
    return preferCash ? cashBalance ?? accountValue : accountValue ?? cashBalance;
  }

  function snapshotIsFlat(snapshot) {
    const openPnl = finiteNumber(snapshot?.openPositionsProfitLossDollars);
    const margin = finiteNumber(snapshot?.marginRequirementDollars);
    return openPnl !== null
      && margin !== null
      && Math.abs(openPnl) < EPSILON
      && Math.abs(margin) < EPSILON;
  }

  function positionIsOpen(position) {
    const quantity = finiteNumber(position?.openQuantity ?? position?.quantity ?? position?.positionQuantity);
    return quantity === null || Math.abs(quantity) >= EPSILON;
  }

  function closedTradesAfter(closedTrades, account, afterUtc) {
    const afterMs = timestampMs(afterUtc);
    if (afterMs === null) return [];
    const key = accountKey(account);
    return (closedTrades || []).filter((trade) => {
      if (accountKey(trade?.account ?? trade?.tradeAccount) !== key) return false;
      const exitMs = timestampMs(trade?.exitAtUtc ?? trade?.tradeDateUtc ?? trade?.timestampUtc);
      return exitMs !== null && exitMs > afterMs && finiteNumber(trade?.realizedPnlDollars) !== null;
    });
  }

  function resolveAccountBalance({ snapshots, openPositions, closedTrades, account }) {
    const key = accountKey(account);
    const rows = (snapshots || []).filter((snapshot) => {
      if (accountKey(snapshot?.account) !== key || snapshot?.accountDataAvailable === false) return false;
      return snapshotBalance(snapshot) !== null;
    }).sort((left, right) => {
      const idDelta = (finiteNumber(right?.accountSnapshotId) ?? -1) - (finiteNumber(left?.accountSnapshotId) ?? -1);
      if (idDelta) return idDelta;
      return (timestampMs(right?.snapshotAtUtc) ?? -1) - (timestampMs(left?.snapshotAtUtc) ?? -1);
    });
    if (!rows.length) return null;

    const latest = rows[0];
    const accountHasOpenPosition = (openPositions || []).some((position) => (
      accountKey(position?.account ?? position?.tradeAccount) === key && positionIsOpen(position)
    ));

    if (!accountHasOpenPosition && !snapshotIsFlat(latest)) {
      const settled = rows.find(snapshotIsFlat);
      const subsequentTrades = settled
        ? closedTradesAfter(closedTrades, account, settled.snapshotAtUtc)
        : [];
      const settledBalance = snapshotBalance(settled, true);
      if (settled && settledBalance !== null && subsequentTrades.length) {
        const closedPnl = subsequentTrades.reduce(
          (sum, trade) => sum + finiteNumber(trade.realizedPnlDollars),
          0,
        );
        return {
          account,
          balance: Number((settledBalance + closedPnl).toFixed(2)),
          snapshotAtUtc: latest.snapshotAtUtc || settled.snapshotAtUtc || null,
          source: "settled_snapshot_plus_closed_trades",
        };
      }
    }

    const balance = snapshotBalance(latest, !accountHasOpenPosition && !snapshotIsFlat(latest));
    return balance === null ? null : {
      account,
      balance: Number(balance.toFixed(2)),
      snapshotAtUtc: latest.snapshotAtUtc || null,
      source: snapshotIsFlat(latest) ? "settled_snapshot" : "account_snapshot",
    };
  }

  function resolve({ snapshots = [], selectedAccounts = [], openPositions = [], closedTrades = [] } = {}) {
    const rows = selectedAccounts
      .map((account) => resolveAccountBalance({ snapshots, openPositions, closedTrades, account }))
      .filter(Boolean);
    if (!rows.length) return { value: null, rows: [], source: "unavailable" };
    return {
      value: Number(rows.reduce((sum, row) => sum + row.balance, 0).toFixed(2)),
      rows,
      source: rows.some((row) => row.source === "settled_snapshot_plus_closed_trades")
        ? "reconciled_settled_snapshot"
        : "account_snapshot",
    };
  }

  root.OceanBrokerAccountBalance = Object.freeze({ resolve });
}(window));
