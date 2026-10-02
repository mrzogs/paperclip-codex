import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dashboardDir, "public", "broker-account-balance.js"), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context);
const { resolve } = context.window.OceanBrokerAccountBalance;

test("uses the latest settled Sierra account snapshot", () => {
  const result = resolve({
    selectedAccounts: ["2367A"],
    snapshots: [
      {
        accountSnapshotId: 10,
        account: "2367A",
        accountValueDollars: 1700,
        cashBalanceDollars: 1700,
        openPositionsProfitLossDollars: 0,
        marginRequirementDollars: 0,
        accountDataAvailable: true,
        snapshotAtUtc: "2026-09-02T14:35:00Z",
      },
      {
        accountSnapshotId: 11,
        account: "2367A",
        accountValueDollars: 1750.989996,
        cashBalanceDollars: 1750.989996,
        openPositionsProfitLossDollars: 0,
        marginRequirementDollars: 0,
        accountDataAvailable: true,
        snapshotAtUtc: "2026-09-02T14:36:29Z",
      },
    ],
  });

  assert.equal(result.value, 1750.99);
  assert.equal(result.rows[0].source, "settled_snapshot");
});

test("does not expose a transient post-close account value as the broker total", () => {
  const result = resolve({
    selectedAccounts: ["2367A"],
    snapshots: [
      {
        account: "2367A",
        accountValueDollars: 1759.059996,
        cashBalanceDollars: 1750.489996,
        openPositionsProfitLossDollars: 7.999999,
        marginRequirementDollars: 232.484986,
        accountDataAvailable: true,
        snapshotAtUtc: "2026-09-02T14:35:44Z",
      },
      {
        account: "2367A",
        accountValueDollars: 1736.189996,
        cashBalanceDollars: 1736.189996,
        openPositionsProfitLossDollars: 0,
        marginRequirementDollars: 0,
        accountDataAvailable: true,
        snapshotAtUtc: "2026-09-02T14:34:11Z",
      },
    ],
    closedTrades: [{
      account: "2367A",
      exitAtUtc: "2026-09-02T14:35:44.946Z",
      realizedPnlDollars: 14.8,
    }],
    openPositions: [],
  });

  assert.equal(result.value, 1750.99);
  assert.equal(result.rows[0].source, "settled_snapshot_plus_closed_trades");
});

test("keeps account value including unrealised P&L while a position is genuinely open", () => {
  const result = resolve({
    selectedAccounts: ["2367A"],
    snapshots: [{
      account: "2367A",
      accountValueDollars: 1760.56,
      cashBalanceDollars: 1751.06,
      openPositionsProfitLossDollars: 9.5,
      marginRequirementDollars: 232.48,
      accountDataAvailable: true,
      snapshotAtUtc: "2026-09-02T14:35:36Z",
    }],
    openPositions: [{ account: "2367A", openQuantity: 1 }],
  });

  assert.equal(result.value, 1760.56);
  assert.equal(result.rows[0].source, "account_snapshot");
});

test("sums the latest resolved value for every selected live account", () => {
  const result = resolve({
    selectedAccounts: ["2367A", "SECOND"],
    snapshots: [
      { account: "2367A", accountValueDollars: 1750.99, openPositionsProfitLossDollars: 0, marginRequirementDollars: 0 },
      { account: "SECOND", accountValueDollars: 500, openPositionsProfitLossDollars: 0, marginRequirementDollars: 0 },
    ],
  });

  assert.equal(result.value, 2250.99);
});
