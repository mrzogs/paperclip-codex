import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthRoutes } from "../routes/health.js";
import {
  HeartbeatDispatchFence,
  heartbeatDispatchFence,
} from "../services/heartbeat-dispatch-fence.js";

afterEach(() => {
  heartbeatDispatchFence.exit();
});

describe("HeartbeatDispatchFence", () => {
  it("acknowledges only after an in-flight dispatch admission drains", async () => {
    const fence = new HeartbeatDispatchFence();
    let releaseAdmission!: () => void;
    const admissionBlocked = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });

    const admission = fence.run(async () => {
      await admissionBlocked;
      return "claimed-and-launched";
    });

    const enter = fence.enter();
    let acknowledged = false;
    void enter.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();

    expect(acknowledged).toBe(false);
    expect(fence.snapshot()).toEqual({ fenced: true, activeAdmissions: 1 });

    releaseAdmission();
    await expect(admission).resolves.toEqual({ admitted: true, value: "claimed-and-launched" });
    await expect(enter).resolves.toEqual({ fenced: true, activeAdmissions: 0 });
  });

  it("rejects new dispatch admissions until the supervisor releases the fence", async () => {
    const fence = new HeartbeatDispatchFence();
    const work = vi.fn(async () => "started");

    await expect(fence.enter()).resolves.toEqual({ fenced: true, activeAdmissions: 0 });
    await expect(fence.run(work)).resolves.toEqual({ admitted: false, reason: "supervisor_fence" });
    expect(work).not.toHaveBeenCalled();

    expect(fence.exit()).toEqual({ fenced: false, activeAdmissions: 0 });
    await expect(fence.run(work)).resolves.toEqual({ admitted: true, value: "started" });
    expect(work).toHaveBeenCalledOnce();
  });
});

describe("supervisor dispatch fence route", () => {
  it("acknowledges enter and exit only for the private local-trusted server", async () => {
    const app = express();
    app.use("/api/health", healthRoutes(undefined, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }));

    await request(app)
      .post("/api/health/supervisor-dispatch-fence/enter")
      .expect(200, { status: "ok", acknowledged: true, fenced: true, activeAdmissions: 0 });
    await request(app)
      .post("/api/health/supervisor-dispatch-fence/exit")
      .expect(200, { status: "ok", acknowledged: true, fenced: false, activeAdmissions: 0 });
  });

  it("rejects the supervisor route outside private local-trusted mode", async () => {
    const app = express();
    app.use("/api/health", healthRoutes(undefined, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }));

    await request(app)
      .post("/api/health/supervisor-dispatch-fence/enter")
      .expect(403, { error: "local_supervisor_only" });
  });
});
