import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  combineVwapMonitorStatus,
  createManifestRebuildPolicy,
  dtcSnapshotProcessTimeoutMs,
  runBoundedProcess,
  stoppedMonitorState,
  terminateProcessTree,
} from "./manifest-rebuild-runtime.mjs";
import {
  coalesceClosedTradeNotificationCheckpoint,
  manifestBuildEnvironment,
  manifestBuildIdentity,
  manifestRebuildInitialState,
  reconcileClosedTradeNotifications,
} from "./monitor.mjs";

test("manifest build identity changes when a build input changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-manifest-identity-"));
  const input = path.join(directory, "build-input.mjs");
  try {
    fs.writeFileSync(input, "export const version = 1;\n");
    const first = manifestBuildIdentity([input]);
    fs.writeFileSync(input, "export const version = 2;\n");
    const second = manifestBuildIdentity([input]);
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.match(second, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(second, first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest build identity changes with the immutable deployment revision", () => {
  const files = [new URL("./build-manifest.mjs", import.meta.url).pathname];
  const first = manifestBuildIdentity(files, { sourceCommit: "a".repeat(40) });
  const second = manifestBuildIdentity(files, { sourceCommit: "b".repeat(40) });
  assert.notEqual(second, first);
});

test("manifest build identity includes effective build environment", () => {
  const files = [new URL("./build-manifest.mjs", import.meta.url).pathname];
  const first = manifestBuildIdentity(files, manifestBuildEnvironment({ OCEAN_WEBSITE_DB: "D:\\first.sqlite" }));
  const second = manifestBuildIdentity(files, manifestBuildEnvironment({ OCEAN_WEBSITE_DB: "D:\\second.sqlite" }));
  assert.notEqual(second, first);
});

test("missing published output invalidates only hydrated success", () => {
  const persisted = {
    lastSuccessfulSignatureSha256: "sha256:success",
    pendingSignatureSha256: "sha256:pending",
    consecutiveFailures: 2,
    blockedReason: "termination not verified",
  };
  const invalidated = manifestRebuildInitialState(persisted, false);
  assert.equal(invalidated.lastSuccessfulSignatureSha256, "");
  assert.equal(invalidated.pendingSignatureSha256, persisted.pendingSignatureSha256);
  assert.equal(invalidated.consecutiveFailures, 2);
  assert.equal(invalidated.blockedReason, persisted.blockedReason);
  assert.equal(manifestRebuildInitialState(persisted, true), persisted);
});

test("stopping the monitor preserves durable retry and notification checkpoints", () => {
  const previous = {
    running: true,
    status: "degraded",
    pid: 4242,
    manifestRebuild: { blockedReason: "termination not verified", consecutiveFailures: 3 },
    closedTradeNotificationPending: { attempts: 2, nextAttemptAtUtc: "2026-10-23T18:00:00.000Z" },
  };
  const stopped = stoppedMonitorState(previous, "2026-10-23T17:00:00.000Z");
  assert.equal(stopped.running, false);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.pid, null);
  assert.deepEqual(stopped.manifestRebuild, previous.manifestRebuild);
  assert.deepEqual(stopped.closedTradeNotificationPending, previous.closedTradeNotificationPending);
});

test("failed signatures wait for backoff and coalesce newer signatures without overlap", () => {
  const policy = createManifestRebuildPolicy({
    minimumIntervalMs: 100,
    baseBackoffMs: 200,
    maximumBackoffMs: 800,
  });

  const first = policy.observe("signature-a", 1_000);
  assert.equal(first.action, "rebuild");
  assert.equal(policy.observe("signature-b", 1_001).action, "coalesced");

  const failure = policy.fail("signature-a", 1_010);
  assert.equal(failure.consecutiveFailures, 1);
  assert.equal(failure.nextAllowedAtMs, 1_210);
  assert.equal(policy.observe("signature-b", 1_100).action, "deferred");

  const retry = policy.observe("signature-b", 1_210);
  assert.equal(retry.action, "rebuild");
  policy.succeed(retry.signature, 1_220);
  assert.equal(policy.observe("signature-b", 1_221).action, "no_change");
});

test("rebuild policy applies exponential backoff bounded by the configured maximum", () => {
  const policy = createManifestRebuildPolicy({
    minimumIntervalMs: 10,
    baseBackoffMs: 20,
    maximumBackoffMs: 50,
  });

  assert.equal(policy.observe("a", 0).action, "rebuild");
  assert.equal(policy.fail("a", 1).backoffMs, 20);
  assert.equal(policy.observe("a", 21).action, "rebuild");
  assert.equal(policy.fail("a", 22).backoffMs, 40);
  assert.equal(policy.observe("a", 62).action, "rebuild");
  assert.equal(policy.fail("a", 63).backoffMs, 50);
});

test("rebuild policy hydrates a persisted failure cooldown across process restart", () => {
  const firstProcess = createManifestRebuildPolicy({
    minimumIntervalMs: 100,
    baseBackoffMs: 200,
    maximumBackoffMs: 800,
  });
  const attempt = firstProcess.observe("sha256:failed-signature", 1_000);
  const failed = firstProcess.fail(attempt.signature, 1_010);

  const restarted = createManifestRebuildPolicy({
    minimumIntervalMs: 100,
    baseBackoffMs: 200,
    maximumBackoffMs: 800,
    nowMs: 1_100,
    initialState: {
      pendingSignatureSha256: failed.pendingSignature,
      lastAttemptAtUtc: new Date(failed.lastAttemptAtMs).toISOString(),
      lastFailureAtUtc: new Date(failed.lastFailureAtMs).toISOString(),
      nextAttemptAtUtc: new Date(failed.nextAllowedAtMs).toISOString(),
      consecutiveFailures: failed.consecutiveFailures,
      inFlight: false,
    },
  });

  assert.equal(restarted.observe("sha256:failed-signature", 1_100).action, "deferred");
  assert.equal(restarted.observe("sha256:failed-signature", 1_209).action, "deferred");
  assert.equal(restarted.observe("sha256:failed-signature", 1_210).action, "rebuild");
});

test("rebuild policy converts an interrupted persisted attempt into a fresh cooldown", () => {
  const restarted = createManifestRebuildPolicy({
    minimumIntervalMs: 100,
    baseBackoffMs: 200,
    maximumBackoffMs: 800,
    nowMs: 2_000,
    initialState: {
      pendingSignatureSha256: "sha256:pending",
      attemptSignatureSha256: "sha256:pending",
      lastAttemptAtUtc: new Date(1_900).toISOString(),
      consecutiveFailures: 1,
      inFlight: true,
    },
  });

  const state = restarted.snapshot();
  assert.equal(state.inFlight, false);
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.nextAllowedAtMs, 2_400);
  assert.equal(restarted.observe("sha256:pending", 2_399).action, "deferred");
  assert.equal(restarted.observe("sha256:pending", 2_400).action, "rebuild");
});

test("a persisted process-tree termination block remains fail closed after restart", () => {
  const restarted = createManifestRebuildPolicy({
    nowMs: 5_000,
    initialState: {
      pendingSignatureSha256: "sha256:blocked",
      blockedReason: "taskkill failed",
      blockedAtUtc: new Date(4_000).toISOString(),
      consecutiveFailures: 1,
    },
  });

  const decision = restarted.observe("sha256:new-wal-signature", 10_000);
  assert.equal(decision.action, "blocked");
  assert.equal(decision.blockedReason, "taskkill failed");
  assert.equal(decision.pendingSignature, "sha256:new-wal-signature");
  assert.equal(decision.nextAllowedAtMs, 0);
});

test("bounded child execution does not block the Node event loop", async () => {
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 120)"], {
      timeoutMs: 2_000,
    });
    assert.equal(result.exitCode, 0);
    assert.ok(ticks >= 4, `expected event-loop progress while child ran, observed ${ticks} ticks`);
  } finally {
    clearInterval(interval);
  }
});

test("bounded child timeout terminates and reaps the child", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
      timeoutMs: 75,
      killGraceMs: 250,
    }),
    (error) => error?.code === "ETIMEDOUT",
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

test("process-tree termination failure is surfaced and cannot look like a reaped timeout", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  let hardKillCount = 0;
  child.kill = () => {
    hardKillCount += 1;
    child.signalCode = "SIGKILL";
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  };

  await assert.rejects(
    runBoundedProcess("synthetic-child", [], {
      timeoutMs: 10,
      killGraceMs: 50,
      spawnImpl: () => child,
      terminateImpl: async () => {
        throw new Error("taskkill denied");
      },
    }),
    (error) => error?.code === "PROCESS_TREE_TERMINATION_FAILED"
      && error?.terminationReason === "timeout"
      && error?.pid === 4242,
  );
  assert.equal(hardKillCount, 1);
});

test("a fallback kill error cannot mask an unverified process-tree termination", async () => {
  const child = new EventEmitter();
  child.pid = 4243;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    queueMicrotask(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
    return false;
  };

  await assert.rejects(
    runBoundedProcess("synthetic-child", [], {
      timeoutMs: 10,
      killGraceMs: 50,
      spawnImpl: () => child,
      terminateImpl: async () => {
        throw new Error("taskkill denied");
      },
    }),
    (error) => error?.code === "PROCESS_TREE_TERMINATION_FAILED"
      && error?.terminationReason === "timeout"
      && error?.pid === 4243,
  );
});

test("Windows taskkill not-found is accepted only after the child close is observed", async () => {
  const child = new EventEmitter();
  child.pid = 4244;
  child.exitCode = null;
  child.signalCode = null;
  const runTaskkill = async () => {
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
    throw new Error('taskkill failed: ERROR: The process "4244" not found.');
  };

  await terminateProcessTree(child, { runTaskkill });
  assert.equal(child.exitCode, 0);
});

test("timeout waits for asynchronous tree-termination verification before settling", async () => {
  const child = new EventEmitter();
  child.pid = 4343;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;

  await assert.rejects(
    runBoundedProcess("synthetic-racing-child", [], {
      timeoutMs: 10,
      killGraceMs: 50,
      spawnImpl: () => child,
      terminateImpl: () => new Promise((resolve, reject) => {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit("close", 1, null);
        });
        setTimeout(() => reject(new Error("late taskkill failure")), 20);
      }),
    }),
    (error) => error?.code === "PROCESS_TREE_TERMINATION_FAILED"
      && error?.terminationReason === "timeout"
      && /late taskkill failure/.test(error.message),
  );
});

test("DTC process timeout covers two sequential socket waits plus publication overhead", () => {
  assert.equal(dtcSnapshotProcessTimeoutMs(1_000), 30_000);
  assert.equal(dtcSnapshotProcessTimeoutMs(30_000), 70_000);
  assert.equal(dtcSnapshotProcessTimeoutMs(30_000, 90_000), 90_000);
});

test("continuous WAL-style signature churn cannot create overlapping rebuild children", async () => {
  const policy = createManifestRebuildPolicy({
    minimumIntervalMs: 200,
    baseBackoffMs: 200,
    maximumBackoffMs: 800,
  });
  const first = policy.observe("wal-1", 1_000);
  assert.equal(first.action, "rebuild");

  let activeChildren = 0;
  let maximumActiveChildren = 0;
  const build = (async () => {
    activeChildren += 1;
    maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
    try {
      return await runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 150)"], {
        timeoutMs: 2_000,
      });
    } finally {
      activeChildren -= 1;
    }
  })();

  for (let index = 2; index <= 8; index += 1) {
    assert.equal(policy.observe(`wal-${index}`, 1_000 + index).action, "coalesced");
  }
  await build;
  policy.succeed(first.signature, 1_160);

  assert.equal(maximumActiveChildren, 1);
  assert.equal(policy.observe("wal-8", 1_161).action, "deferred");
  assert.equal(policy.observe("wal-9", 1_359).action, "deferred");
  assert.equal(policy.observe("wal-9", 1_360).action, "rebuild");
});

test("a timed-out build keeps changing signatures behind one global retry boundary", async () => {
  const policy = createManifestRebuildPolicy({
    minimumIntervalMs: 50,
    baseBackoffMs: 250,
    maximumBackoffMs: 1_000,
  });
  const first = policy.observe("wal-a", 5_000);
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
      timeoutMs: 50,
      killGraceMs: 250,
    }),
    (error) => error?.code === "ETIMEDOUT",
  );
  const failure = policy.fail(first.signature, 5_060);
  assert.equal(failure.nextAllowedAtMs, 5_310);
  assert.equal(policy.observe("wal-b", 5_100).action, "deferred");
  assert.equal(policy.observe("wal-c", 5_200).action, "deferred");
  assert.equal(policy.observe("wal-d", 5_309).action, "deferred");
  assert.equal(policy.observe("wal-d", 5_310).action, "rebuild");
});

test("abort stops an active child cleanly", async () => {
  const controller = new AbortController();
  const child = runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(child, (error) => error?.code === "ABORT_ERR");
});

test("website monitor degradation is reflected in the combined VWAP status", () => {
  const combined = combineVwapMonitorStatus(
    { status: "HEALTHY", observed_trade_count: 1196, eligible_trade_count: 0, last_error: null },
    { status: "degraded", error: "manifest timeout", lastImportAtUtc: "2026-10-23T16:02:40.066Z" },
  );
  assert.equal(combined.status, "DEGRADED");
  assert.equal(combined.last_error, "manifest timeout");
  assert.equal(combined.observed_trade_count, 1196);
  assert.equal(combined.website_monitor.lastImportAtUtc, "2026-10-23T16:02:40.066Z");
});

test("an unresolved manifest failure remains degraded while its retry is running", () => {
  const combined = combineVwapMonitorStatus(
    { status: "HEALTHY", last_error: null },
    { status: "running", manifestRebuild: { inFlight: true, consecutiveFailures: 1 } },
  );
  assert.equal(combined.status, "DEGRADED");
  assert.match(combined.last_error, /manifest monitor is degraded/i);
});

test("closed-trade notification reconciliation retains and retries its durable checkpoint", async () => {
  const writes = [];
  const checkpoint = {
    signatureSha256: "sha256:published-manifest",
    reason: "file_change",
    attempts: 0,
    firstQueuedAtUtc: new Date(1_000).toISOString(),
    nextAttemptAtUtc: new Date(1_000).toISOString(),
  };
  const policy = { snapshot: () => ({ consecutiveFailures: 0, blockedReason: "" }) };
  const persist = (patch, event) => writes.push({ patch, event });
  const failed = await reconcileClosedTradeNotifications(checkpoint, {
    notify: async () => { throw new Error("queue temporarily unavailable"); },
    persist,
    policy,
    nowMs: 2_000,
    eventFactory: (level, action) => ({ level, action }),
  });
  assert.equal(failed.action, "deferred_after_failure");
  assert.equal(failed.checkpoint.attempts, 1);
  assert.ok(Number.isFinite(Date.parse(failed.checkpoint.nextAttemptAtUtc)));
  assert.equal(writes.at(-1).patch.status, "degraded");
  assert.deepEqual(writes.at(-1).patch.closedTradeNotificationPending, failed.checkpoint);

  let calls = 0;
  const deferred = await reconcileClosedTradeNotifications(failed.checkpoint, {
    notify: async () => { calls += 1; }, persist, policy, nowMs: 2_001,
  });
  assert.equal(deferred.action, "deferred");
  assert.equal(calls, 0);

  const completed = await reconcileClosedTradeNotifications(failed.checkpoint, {
    notify: async () => { calls += 1; },
    persist,
    policy,
    nowMs: Date.parse(failed.checkpoint.nextAttemptAtUtc),
    eventFactory: (level, action) => ({ level, action }),
  });
  assert.equal(completed.action, "complete");
  assert.equal(calls, 1);
  assert.equal(writes.at(-1).patch.closedTradeNotificationPending, null);
  assert.equal(writes.at(-1).patch.status, "running");
});

test("a newly published manifest preserves an existing notification retry backoff", () => {
  const existing = {
    signatureSha256: "sha256:older-manifest",
    reason: "file_change",
    attempts: 3,
    firstQueuedAtUtc: new Date(1_000).toISOString(),
    lastAttemptAtUtc: new Date(2_000).toISOString(),
    nextAttemptAtUtc: new Date(10_000).toISOString(),
    lastError: "connector unavailable",
  };
  const coalesced = coalesceClosedTradeNotificationCheckpoint(
    existing,
    "sha256:newer-manifest",
    "file_change",
    3_000,
  );

  assert.equal(coalesced.signatureSha256, "sha256:newer-manifest");
  assert.equal(coalesced.attempts, 3);
  assert.equal(coalesced.firstQueuedAtUtc, existing.firstQueuedAtUtc);
  assert.equal(coalesced.lastAttemptAtUtc, existing.lastAttemptAtUtc);
  assert.equal(coalesced.nextAttemptAtUtc, existing.nextAttemptAtUtc);
  assert.equal(coalesced.lastError, existing.lastError);
});
