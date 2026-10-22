import { logger } from "../middleware/logger.js";

const AGENT_START_LOCK_STALE_MS = 30_000;
const startLocksByAgent = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

export class AgentStartLockBusyError extends Error {
  constructor(agentId: string) {
    super(`Agent start lock is still held for ${agentId}; retry on the next recovery tick`);
    this.name = "AgentStartLockBusyError";
  }
}

async function waitForAgentStartLock(agentId: string, lock: { promise: Promise<void>; startedAtMs: number }) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = AGENT_START_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    throw new AgentStartLockBusyError(agentId);
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn({ agentId, staleMs: AGENT_START_LOCK_STALE_MS }, "agent start lock timed out; deferring queued-run start");
    throw new AgentStartLockBusyError(agentId);
  }
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  // A timeout cannot revoke an in-flight owner's ability to claim runs. Keep
  // ownership until it settles, and recheck after waiting because another waiter
  // may already have acquired the lock.
  while (true) {
    const previous = startLocksByAgent.get(agentId);
    if (!previous) break;
    await waitForAgentStartLock(agentId, previous);
  }
  const run = Promise.resolve().then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}
