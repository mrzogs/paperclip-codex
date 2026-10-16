import assert from "node:assert/strict";
import test from "node:test";

import { publishSqliteWithRetry } from "./sqlite-publication.mjs";

function timeoutError() {
  const error = new Error("spawnSync python ETIMEDOUT");
  error.code = "ETIMEDOUT";
  return error;
}

test("a stuck publisher is retried within the original total process budget", () => {
  let clock = 0;
  const attempts = [];
  const sleeps = [];
  const result = publishSqliteWithRetry({
    executable: "python",
    args: ["persist-sqlite.py"],
    cwd: "dashboard",
    totalTimeoutMs: 180000,
    attemptTimeoutMs: 45000,
    maxAttempts: 3,
    now: () => clock,
    run: (_executable, _args, options) => {
      attempts.push(options.timeout);
      if (attempts.length === 1) {
        clock += options.timeout;
        throw timeoutError();
      }
      clock += 2500;
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    warn: () => {},
  });
  assert.deepEqual(attempts, [45000, 45000]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(result.attempt, 2);
  assert.equal(result.elapsedMs, 48500);
  assert.ok(result.elapsedMs < 180000);
});

test("a non-timeout publication failure is never retried", () => {
  let attempts = 0;
  assert.throws(() => publishSqliteWithRetry({
    executable: "python",
    args: [],
    cwd: "dashboard",
    run: () => {
      attempts += 1;
      throw new Error("schema failure");
    },
    warn: () => {},
  }), /schema failure/);
  assert.equal(attempts, 1);
});

test("attempt timeout is capped by the remaining total process budget", () => {
  let clock = 0;
  const timeouts = [];
  assert.throws(() => publishSqliteWithRetry({
    executable: "python",
    args: [],
    cwd: "dashboard",
    totalTimeoutMs: 50000,
    attemptTimeoutMs: 45000,
    maxAttempts: 3,
    now: () => clock,
    run: (_executable, _args, options) => {
      timeouts.push(options.timeout);
      clock += options.timeout;
      throw timeoutError();
    },
    sleep: (milliseconds) => { clock += milliseconds; },
    warn: () => {},
  }), /ETIMEDOUT/);
  assert.deepEqual(timeouts, [45000, 4000]);
});
