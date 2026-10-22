import { describe, expect, it, vi } from "vitest";
import { singleFlight } from "../services/single-flight.ts";

describe("interval single flight", () => {
  it("drops a burst of ticks during stalled IO and resumes after settlement", async () => {
    let release!: (value: number) => void;
    const operation = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const tick = singleFlight(operation, () => 0);
    const first = tick();
    expect(await Promise.all(Array.from({ length: 100 }, () => tick()))).toEqual(Array(100).fill(0));
    expect(operation).toHaveBeenCalledTimes(1);
    release(1);
    expect(await first).toBe(1);
    const next = tick();
    expect(operation).toHaveBeenCalledTimes(2);
    release(2);
    expect(await next).toBe(2);
  });

  it("releases on failure and forwards arguments", async () => {
    const operation = vi.fn(async (value: number) => {
      if (value === 1) throw new Error("stalled query failed");
      return value;
    });
    const tick = singleFlight(operation, () => 0);
    await expect(tick(1)).rejects.toThrow("stalled query failed");
    await expect(tick(2)).resolves.toBe(2);
  });
});
