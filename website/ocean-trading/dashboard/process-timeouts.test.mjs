import assert from "node:assert/strict";
import test from "node:test";

import { configuredProcessTimeoutMs } from "./process-timeouts.mjs";

test("uses the fallback for missing and invalid timeout configuration", () => {
  const key = "OCEAN_TEST_PROCESS_TIMEOUT_MS";
  const original = process.env[key];
  try {
    delete process.env[key];
    assert.equal(configuredProcessTimeoutMs(key, 120000), 120000);
    process.env[key] = "not-a-number";
    assert.equal(configuredProcessTimeoutMs(key, 120000), 120000);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

test("accepts bounded timeout overrides", () => {
  const key = "OCEAN_TEST_PROCESS_TIMEOUT_MS";
  const original = process.env[key];
  try {
    process.env[key] = "240000";
    assert.equal(configuredProcessTimeoutMs(key, 120000), 240000);
    process.env[key] = "10";
    assert.equal(configuredProcessTimeoutMs(key, 120000), 1000);
    process.env[key] = "9999999";
    assert.equal(configuredProcessTimeoutMs(key, 120000), 900000);
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});
