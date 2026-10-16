import { execFileSync } from "node:child_process";

function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessTimeout(error) {
  return error?.code === "ETIMEDOUT"
    || error?.errno === "ETIMEDOUT"
    || /ETIMEDOUT/i.test(String(error?.message || ""));
}

export function publishSqliteWithRetry({
  executable,
  args,
  cwd,
  env = process.env,
  totalTimeoutMs = 180000,
  attemptTimeoutMs = 45000,
  maxAttempts = 3,
  run = execFileSync,
  sleep = defaultSleep,
  now = Date.now,
  warn = console.warn,
}) {
  const startedAt = now();
  const deadline = startedAt + totalTimeoutMs;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs < 1000) {
      throw new Error(`SQLite publication exhausted its ${totalTimeoutMs}ms process budget before attempt ${attempt}.`);
    }
    const timeout = Math.max(1000, Math.min(attemptTimeoutMs, remainingMs));
    try {
      run(executable, args, {
        cwd,
        env,
        stdio: "inherit",
        timeout,
        windowsHide: true,
      });
      return { attempt, elapsedMs: now() - startedAt };
    } catch (error) {
      const retryable = isProcessTimeout(error);
      const remainingAfterAttemptMs = Math.max(0, deadline - now());
      if (!retryable || attempt >= maxAttempts || remainingAfterAttemptMs < 2000) throw error;
      const backoffMs = Math.min(attempt * 1000, remainingAfterAttemptMs - 1000);
      warn(
        `[sqlite-publication] attempt ${attempt}/${maxAttempts} exceeded ${timeout}ms; `
        + `retrying within the existing ${totalTimeoutMs}ms process budget after ${backoffMs}ms.`,
      );
      sleep(backoffMs);
    }
  }
  throw new Error("SQLite publication retry loop ended unexpectedly.");
}
