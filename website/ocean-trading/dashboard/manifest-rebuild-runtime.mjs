import { execFile, spawn } from "node:child_process";

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function persistedSignature(state, runtimeKey, persistedKey) {
  return String(state?.[runtimeKey] || state?.[persistedKey] || "");
}

export function dtcSnapshotProcessTimeoutMs(socketTimeoutMs = 3_000, configuredTotalTimeoutMs = null) {
  const socketTimeout = positiveInteger(socketTimeoutMs, 3_000);
  return positiveInteger(configuredTotalTimeoutMs, Math.max(30_000, (socketTimeout * 2) + 10_000));
}

export function stoppedMonitorState(previousState, updatedAtUtc = new Date().toISOString()) {
  const previous = previousState && typeof previousState === "object" ? previousState : {};
  const rebuildBlocked = Boolean(previous.manifestRebuild?.blockedReason || previous.manifestRebuild?.blocked);
  return {
    ...previous,
    running: false,
    status: rebuildBlocked ? "blocked" : "stopped",
    pid: null,
    updatedAtUtc,
  };
}

export async function settleActiveRebuildForStop({
  activeRebuildPromise = null,
  abort = null,
  timeoutMs = 5_000,
} = {}) {
  try {
    abort?.();
  } catch (error) {
    return {
      terminationVerified: false,
      error: processError(
        `Unable to request manifest rebuild termination: ${error?.message || error}`,
        "PROCESS_TREE_TERMINATION_FAILED",
        { cause: error, terminationReason: "shutdown_abort" },
      ),
    };
  }
  if (!activeRebuildPromise) return { terminationVerified: true, error: null };

  const boundedTimeoutMs = positiveInteger(timeoutMs, 5_000);
  let timeoutTimer = null;
  const settled = Promise.resolve(activeRebuildPromise).then(
    () => ({ settled: true, error: null }),
    (error) => ({ settled: true, error }),
  );
  const timedOut = new Promise((resolve) => {
    timeoutTimer = setTimeout(() => resolve({
      settled: false,
      error: processError(
        `Manifest rebuild termination was not verified within ${boundedTimeoutMs} ms.`,
        "PROCESS_TREE_TERMINATION_FAILED",
        { terminationReason: "shutdown_timeout", timeoutMs: boundedTimeoutMs },
      ),
    }), boundedTimeoutMs);
    timeoutTimer.unref?.();
  });
  const outcome = await Promise.race([settled, timedOut]);
  clearTimeout(timeoutTimer);
  if (!outcome.settled || outcome.error?.code === "PROCESS_TREE_TERMINATION_FAILED") {
    return { terminationVerified: false, error: outcome.error };
  }
  return { terminationVerified: true, error: outcome.error || null };
}

export function createManifestRebuildPolicy({
  minimumIntervalMs = 60_000,
  baseBackoffMs = 60_000,
  maximumBackoffMs = 15 * 60_000,
  initialState = null,
  nowMs = Date.now(),
} = {}) {
  const minimumInterval = positiveInteger(minimumIntervalMs, 60_000);
  const baseBackoff = positiveInteger(baseBackoffMs, 60_000);
  const maximumBackoff = Math.max(baseBackoff, positiveInteger(maximumBackoffMs, 15 * 60_000));
  const hydratedState = initialState && typeof initialState === "object" ? initialState : {};
  let lastSuccessfulSignature = persistedSignature(hydratedState, "lastSuccessfulSignature", "lastSuccessfulSignatureSha256");
  let pendingSignature = persistedSignature(hydratedState, "pendingSignature", "pendingSignatureSha256");
  let attemptSignature = persistedSignature(hydratedState, "attemptSignature", "attemptSignatureSha256");
  let lastAttemptAtMs = timestampMs(hydratedState.lastAttemptAtMs ?? hydratedState.lastAttemptAtUtc);
  let lastSuccessAtMs = timestampMs(hydratedState.lastSuccessAtMs ?? hydratedState.lastSuccessAtUtc);
  let lastFailureAtMs = timestampMs(hydratedState.lastFailureAtMs ?? hydratedState.lastFailureAtUtc);
  let nextAllowedAtMs = timestampMs(hydratedState.nextAllowedAtMs ?? hydratedState.nextAttemptAtUtc) ?? 0;
  let consecutiveFailures = nonNegativeInteger(hydratedState.consecutiveFailures);
  let inFlight = false;
  let blockedReason = String(hydratedState.blockedReason || "");
  let blockedAtMs = timestampMs(hydratedState.blockedAtMs ?? hydratedState.blockedAtUtc);

  // An in-flight attempt at process exit has an unknown outcome. Treat it as a
  // failed attempt and restart the cooldown from hydration time rather than
  // immediately launching the same expensive rebuild again.
  if (!blockedReason && (hydratedState.inFlight === true || attemptSignature)) {
    pendingSignature ||= attemptSignature;
    attemptSignature = "";
    consecutiveFailures += 1;
    lastFailureAtMs = Math.max(lastFailureAtMs ?? 0, nowMs);
    const interruptedBackoffMs = Math.min(maximumBackoff, baseBackoff * (2 ** Math.max(0, consecutiveFailures - 1)));
    nextAllowedAtMs = Math.max(nextAllowedAtMs, nowMs + interruptedBackoffMs, (lastAttemptAtMs ?? nowMs) + minimumInterval);
  }

  function snapshot() {
    return {
      lastSuccessfulSignature,
      pendingSignature,
      attemptSignature,
      lastAttemptAtMs,
      lastSuccessAtMs,
      lastFailureAtMs,
      nextAllowedAtMs,
      consecutiveFailures,
      inFlight,
      blockedReason,
      blockedAtMs,
      minimumIntervalMs: minimumInterval,
      baseBackoffMs: baseBackoff,
      maximumBackoffMs: maximumBackoff,
    };
  }

  function observe(signature, nowMs = Date.now()) {
    const observedSignature = String(signature || "");
    if (observedSignature !== lastSuccessfulSignature) pendingSignature = observedSignature;
    if (blockedReason) {
      return { action: "blocked", signature: pendingSignature, ...snapshot() };
    }
    if (!pendingSignature && observedSignature === lastSuccessfulSignature) {
      return { action: "no_change", signature: observedSignature, ...snapshot() };
    }
    if (inFlight) {
      return { action: "coalesced", signature: pendingSignature, ...snapshot() };
    }
    const intervalBoundary = lastAttemptAtMs === null ? 0 : lastAttemptAtMs + minimumInterval;
    const eligibleAtMs = Math.max(nextAllowedAtMs, intervalBoundary);
    if (nowMs < eligibleAtMs) {
      return { action: "deferred", signature: pendingSignature, eligibleAtMs, ...snapshot() };
    }
    inFlight = true;
    attemptSignature = pendingSignature;
    lastAttemptAtMs = nowMs;
    return { action: "rebuild", signature: attemptSignature, eligibleAtMs, ...snapshot() };
  }

  function succeed(signature, nowMs = Date.now()) {
    const completedSignature = String(signature || attemptSignature || "");
    lastSuccessfulSignature = completedSignature;
    if (pendingSignature === completedSignature) pendingSignature = "";
    attemptSignature = "";
    inFlight = false;
    consecutiveFailures = 0;
    lastSuccessAtMs = nowMs;
    nextAllowedAtMs = nowMs + minimumInterval;
    blockedReason = "";
    blockedAtMs = null;
    return snapshot();
  }

  function fail(signature, nowMs = Date.now()) {
    const failedSignature = String(signature || attemptSignature || "");
    if (!pendingSignature) pendingSignature = failedSignature;
    attemptSignature = "";
    inFlight = false;
    consecutiveFailures += 1;
    lastFailureAtMs = nowMs;
    const backoffMs = Math.min(maximumBackoff, baseBackoff * (2 ** Math.max(0, consecutiveFailures - 1)));
    nextAllowedAtMs = Math.max(nowMs + backoffMs, (lastAttemptAtMs ?? nowMs) + minimumInterval);
    return { ...snapshot(), failedSignature, backoffMs };
  }

  function block(signature, reason, nowMs = Date.now()) {
    const failedSignature = String(signature || attemptSignature || pendingSignature || "");
    if (failedSignature) pendingSignature = failedSignature;
    attemptSignature = "";
    inFlight = false;
    consecutiveFailures += 1;
    lastFailureAtMs = nowMs;
    blockedReason = String(reason || "Manifest rebuild process-tree termination could not be verified.");
    blockedAtMs = nowMs;
    nextAllowedAtMs = null;
    return { ...snapshot(), failedSignature };
  }

  return { observe, succeed, fail, block, snapshot };
}

function execFileChecked(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 2_000, killSignal: "SIGKILL" }, (error) => {
      if (error) {
        reject(processError(`${command} failed: ${error.message}`, "PROCESS_TREE_TERMINATION_FAILED", { cause: error }));
        return;
      }
      resolve();
    });
  });
}

function waitForChildExit(child, timeoutMs = 250) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
    timer = setTimeout(() => {
      child.removeListener?.("close", onClose);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function terminateProcessTree(child, {
  runTaskkill = execFileChecked,
  waitForExit = waitForChildExit,
} = {}) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      await runTaskkill("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"]);
    } catch (error) {
      if (/process .* not found|no running instance|cannot find the process/i.test(String(error?.message || error))
        && await waitForExit(child)) return;
      throw processError(`Unable to verify termination of process tree ${child.pid}: ${error.message}`, "PROCESS_TREE_TERMINATION_FAILED", {
        cause: error,
        pid: child.pid,
      });
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The close/error event remains the authoritative completion signal.
  }
}

function processError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export function runBoundedProcess(command, args = [], {
  cwd,
  env = process.env,
  stdio = "ignore",
  timeoutMs = 300_000,
  killGraceMs = 2_000,
  signal = null,
  spawnImpl = spawn,
  terminateImpl = terminateProcessTree,
} = {}) {
  const boundedTimeoutMs = positiveInteger(timeoutMs, 300_000);
  const boundedKillGraceMs = positiveInteger(killGraceMs, 2_000);
  if (signal?.aborted) {
    return Promise.reject(processError(`Process aborted before start: ${command}`, "ABORT_ERR"));
  }

  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    let terminationReason = null;
    let terminationFailure = null;
    let terminationPromise = null;
    let closed = false;
    let settled = false;
    let hardKillTimer = null;
    const child = spawnImpl(command, args, { cwd, env, stdio, windowsHide: true });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      signal?.removeEventListener?.("abort", abortHandler);
    };
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      handler(value);
    };
    const requestTermination = (reason) => {
      if (terminationReason || settled) return;
      terminationReason = reason;
      terminationPromise = Promise.resolve()
        .then(() => terminateImpl(child))
        .catch((error) => {
          terminationFailure = processError(
            `Unable to verify termination of process tree for ${command}: ${error?.message || error}`,
            "PROCESS_TREE_TERMINATION_FAILED",
            { cause: error, pid: child.pid, terminationReason: reason },
          );
          try {
            child.kill("SIGKILL");
          } catch {
            // The failure is surfaced when the child closes; callers must fail closed.
          }
        })
        .finally(() => {
          if (settled || closed) return;
          hardKillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // The close/error event remains the authoritative completion signal.
            }
          }, boundedKillGraceMs);
          hardKillTimer.unref?.();
        });
    };
    const abortHandler = () => requestTermination("abort");
    const timeoutTimer = setTimeout(() => requestTermination("timeout"), boundedTimeoutMs);
    timeoutTimer.unref?.();
    signal?.addEventListener?.("abort", abortHandler, { once: true });

    child.once("error", (error) => {
      const elapsedMs = Date.now() - startedAtMs;
      const settleErroredChild = () => {
        if (terminationFailure) {
          finish(reject, Object.assign(terminationFailure, { elapsedMs }));
          return;
        }
        if (terminationReason === "timeout") {
          finish(reject, processError(`Process timed out after ${boundedTimeoutMs} ms: ${command}`, "ETIMEDOUT", {
            cause: error,
            elapsedMs,
          }));
          return;
        }
        if (terminationReason === "abort") {
          finish(reject, processError(`Process aborted: ${command}`, "ABORT_ERR", {
            cause: error,
            elapsedMs,
          }));
          return;
        }
        finish(reject, processError(`Failed to start process: ${command}: ${error.message}`, error.code || "PROCESS_START_FAILED", {
          cause: error,
          elapsedMs,
        }));
      };
      if (terminationReason && terminationPromise) {
        void terminationPromise.then(settleErroredChild);
      } else {
        settleErroredChild();
      }
    });
    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      const elapsedMs = Date.now() - startedAtMs;
      const settleClosedChild = () => {
        if (terminationFailure) {
          finish(reject, Object.assign(terminationFailure, { elapsedMs, exitCode, signal: exitSignal }));
          return;
        }
        if (terminationReason === "timeout") {
          finish(reject, processError(`Process timed out after ${boundedTimeoutMs} ms: ${command}`, "ETIMEDOUT", {
            elapsedMs,
            exitCode,
            signal: exitSignal,
          }));
          return;
        }
        if (terminationReason === "abort") {
          finish(reject, processError(`Process aborted: ${command}`, "ABORT_ERR", {
            elapsedMs,
            exitCode,
            signal: exitSignal,
          }));
          return;
        }
        if (exitCode !== 0) {
          finish(reject, processError(`Process exited with code ${exitCode}: ${command}`, "PROCESS_EXIT_FAILED", {
            elapsedMs,
            exitCode,
            signal: exitSignal,
          }));
          return;
        }
        finish(resolve, { exitCode, signal: exitSignal, elapsedMs, pid: child.pid });
      };
      if (terminationReason && terminationPromise) {
        void terminationPromise.then(settleClosedChild);
      } else {
        settleClosedChild();
      }
    });
  });
}

export function combineVwapMonitorStatus(vwapState, websiteMonitorState) {
  const vwap = vwapState && typeof vwapState === "object" ? vwapState : {};
  const website = websiteMonitorState && typeof websiteMonitorState === "object" ? websiteMonitorState : {};
  const websiteStatus = String(website.status || "").toLowerCase();
  const rebuild = website.manifestRebuild && typeof website.manifestRebuild === "object"
    ? website.manifestRebuild
    : {};
  const websiteDegraded = websiteStatus === "degraded"
    || websiteStatus === "error"
    || Number(rebuild.consecutiveFailures || 0) > 0
    || rebuild.blocked === true;
  if (!websiteDegraded) return { ...vwap, website_monitor: website };
  return {
    ...vwap,
    status: "DEGRADED",
    last_error: vwap.last_error || website.error || "Ocean website manifest monitor is degraded; serving the last successful manifest.",
    website_monitor: website,
  };
}
