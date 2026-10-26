import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Dispatch resumed after supervisor fence release.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => null }));
vi.mock("@paperclipai/shared/telemetry", () => ({ trackAgentFirstHeartbeat: vi.fn() }));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import { heartbeatDispatchFence } from "../services/heartbeat-dispatch-fence.js";
import { healthRoutes } from "../routes/health.js";

const supervisorControlToken = "integration-supervisor-control-token";
const supervisorLeaseToken = "integration-supervisor-lease-token-long-enough";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat supervisor dispatch fence integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-dispatch-fence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (heartbeatDispatchFence.isLeaseValid(supervisorLeaseToken)) {
      heartbeatDispatchFence.exit(supervisorLeaseToken);
    }
    delete process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN;
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps a wake queued until an acknowledged fence is released", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fence Test",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fence Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN = supervisorControlToken;
    const app = express();
    app.use("/api/health", healthRoutes(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }));
    const enter = await request(app)
      .post("/api/health/supervisor-dispatch-fence/enter")
      .set("x-paperclip-supervisor-token", supervisorControlToken)
      .set("x-paperclip-supervisor-lease", supervisorLeaseToken)
      .expect(200);
    expect(enter.body).toMatchObject({ acknowledged: true, fenced: true, activeAdmissions: 0 });

    const queued = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "supervisor_fence_test",
      requestedByActorType: "system",
      requestedByActorId: "test-supervisor",
    });
    expect(queued?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const exit = await request(app)
      .post("/api/health/supervisor-dispatch-fence/exit")
      .set("x-paperclip-supervisor-token", supervisorControlToken)
      .set("x-paperclip-supervisor-lease", supervisorLeaseToken)
      .expect(200);
    expect(exit.body).toMatchObject({ acknowledged: true, fenced: false, resumedQueuedRuns: true });

    const deadline = Date.now() + 3_000;
    let settled = await heartbeat.getRun(queued!.id);
    while (settled && (settled.status === "queued" || settled.status === "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settled = await heartbeat.getRun(queued!.id);
    }

    expect(mockAdapterExecute).toHaveBeenCalledOnce();
    expect(settled?.status).toBe("succeeded");
  });
});
