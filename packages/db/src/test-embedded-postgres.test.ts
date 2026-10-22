import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const mocks = vi.hoisted(() => ({
  initialise: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("embedded-postgres", () => ({
  default: class {
    initialise = mocks.initialise;
    start = mocks.start;
    stop = mocks.stop;
  },
}));
vi.mock("./embedded-postgres-native.js", () => ({ prepareEmbeddedPostgresNativeRuntime: vi.fn() }));
vi.mock("./client.js", () => ({
  ensurePostgresDatabase: vi.fn(),
  applyPendingMigrations: vi.fn(),
}));

describe("embedded Postgres test database cleanup", () => {
  const dataDir = path.join(os.tmpdir(), "paperclip-cleanup-unit-test");

  beforeEach(() => {
    mocks.initialise.mockResolvedValue(undefined);
    mocks.start.mockResolvedValue(undefined);
    mocks.stop.mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdtempSync").mockReturnValue(dataDir);
    vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("waits for directory removal after stopping and requests bounded retries", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-test-");
    let finishRemoval!: () => void;
    vi.mocked(fs.promises.rm).mockImplementationOnce(async () => {
      expect(mocks.stop).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => { finishRemoval = resolve; });
    });
    let completed = false;
    const cleanup = database.cleanup().then(() => { completed = true; });
    await vi.waitFor(() => expect(fs.promises.rm).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    expect(fs.promises.rm).toHaveBeenCalledWith(dataDir, {
      recursive: true, force: true, maxRetries: 10, retryDelay: 100,
    });
    finishRemoval();
    await cleanup;
    expect(completed).toBe(true);
  });

  it("cleans up a failed startup and retains the startup error", async () => {
    mocks.start.mockRejectedValueOnce(new Error("startup failed"));
    await expect(startEmbeddedPostgresTestDatabase("paperclip-cleanup-test-"))
      .rejects.toThrow("Failed to start embedded PostgreSQL test database: startup failed");
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(fs.promises.rm).toHaveBeenCalledOnce();
  });

  it("cleans up the support probe before reporting support", async () => {
    await expect(getEmbeddedPostgresTestSupport()).resolves.toEqual({ supported: true });
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(fs.promises.rm).toHaveBeenCalledOnce();
  });

  it("surfaces persistent directory removal failures", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-test-");
    vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error("persistent EPERM"));
    await expect(database.cleanup()).rejects.toThrow("persistent EPERM");
  });
});
