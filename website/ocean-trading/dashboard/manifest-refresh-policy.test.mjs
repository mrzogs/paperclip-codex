import assert from "node:assert/strict";
import test from "node:test";

import { shouldWebsiteScheduleManifestRebuild } from "./manifest-refresh-policy.mjs";

test("website defers manifest publication while the monitor owns refreshes", () => {
  assert.equal(shouldWebsiteScheduleManifestRebuild({
    manifestExists: true,
    inputChanged: true,
    monitorRunning: true,
  }), false);
});

test("website refreshes changed inputs when the monitor is stopped", () => {
  assert.equal(shouldWebsiteScheduleManifestRebuild({
    manifestExists: true,
    inputChanged: true,
    monitorRunning: false,
  }), true);
});

test("website creates a missing manifest when the monitor is stopped", () => {
  assert.equal(shouldWebsiteScheduleManifestRebuild({
    manifestExists: false,
    inputChanged: false,
    monitorRunning: false,
  }), true);
});
