import assert from "node:assert/strict";
import test from "node:test";

import { vwapImprovementScanOptions } from "./monitor.mjs";

test("the supervised monitor forces one database interrogation on startup only", () => {
  assert.deepEqual(vwapImprovementScanOptions(1), { force: true });
  assert.deepEqual(vwapImprovementScanOptions(2), { force: false });
  assert.deepEqual(vwapImprovementScanOptions(100), { force: false });
});
