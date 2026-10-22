import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock } from "../services/agent-start-lock.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers a timed-out waiter without revoking the live owner", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    let release!: () => void;
    const firstStart = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const secondStart = vi.fn(async () => "started");

    const first = withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    const rejected = expect(secondStartResult).rejects.toThrow("still held");
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await rejected;
    expect(secondStart).not.toHaveBeenCalled();
    await expect(withAgentStartLock(agentId, secondStart)).rejects.toThrow("still held");
    release();
    await first;
    await expect(withAgentStartLock(agentId, secondStart)).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("serializes multiple waiters and releases after failure", async () => {
    const agentId = randomUUID();
    let active = 0;
    let maximum = 0;
    const start = () => withAgentStartLock(agentId, async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      --active;
    });
    await Promise.all([start(), start(), start()]);
    expect(maximum).toBe(1);
    await expect(withAgentStartLock(agentId, async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
    await start();
    expect(active).toBe(0);
  });
});
