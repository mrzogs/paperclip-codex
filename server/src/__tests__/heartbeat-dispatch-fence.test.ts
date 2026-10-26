import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { healthRoutes } from "../routes/health.js";
import {
  HeartbeatDispatchFence,
  heartbeatDispatchFence,
} from "../services/heartbeat-dispatch-fence.js";

afterEach(() => {
  if (heartbeatDispatchFence.isLeaseValid("route-lease-token-that-is-long-enough")) {
    heartbeatDispatchFence.exit("route-lease-token-that-is-long-enough");
  }
  delete process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN;
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

    const enter = fence.enter("unit-admission-lease", 5_000);
    let acknowledged = false;
    void enter.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();

    expect(acknowledged).toBe(false);
    expect(fence.snapshot()).toMatchObject({ fenced: true, activeAdmissions: 1 });

    releaseAdmission();
    await expect(admission).resolves.toEqual({ admitted: true, value: "claimed-and-launched" });
    await expect(enter).resolves.toMatchObject({ fenced: true, activeAdmissions: 0 });
  });

  it("rejects new dispatch admissions until the supervisor releases the fence", async () => {
    const fence = new HeartbeatDispatchFence();
    const work = vi.fn(async () => "started");

    await expect(fence.enter("unit-release-lease", 5_000)).resolves.toMatchObject({ fenced: true, activeAdmissions: 0 });
    await expect(fence.run(work)).resolves.toEqual({ admitted: false, reason: "supervisor_fence" });
    expect(work).not.toHaveBeenCalled();

    expect(fence.exit("unit-release-lease")).toEqual({ fenced: false, activeAdmissions: 0, leaseExpiresAt: null });
    await expect(fence.run(work)).resolves.toEqual({ admitted: true, value: "started" });
    expect(work).toHaveBeenCalledOnce();
  });

  it("auto-expires a lost-acknowledgement lease", async () => {
    const fence = new HeartbeatDispatchFence();
    const onExpired = vi.fn(async () => undefined);
    await fence.enter("lost-ack-lease", 15, onExpired);
    expect(fence.isLeaseValid("lost-ack-lease")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fence.snapshot()).toEqual({ fenced: false, activeAdmissions: 0, leaseExpiresAt: null });
    expect(onExpired).toHaveBeenCalledOnce();
    await expect(fence.run(async () => "resumed")).resolves.toEqual({ admitted: true, value: "resumed" });
  });

  it("does not strand dispatch when admission drain outlives the lease", async () => {
    const fence = new HeartbeatDispatchFence();
    let releaseAdmission!: () => void;
    const admission = fence.run(async () => {
      await new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      return "finished";
    });
    const enter = fence.enter("slow-admission-lost-ack-lease", 15);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fence.snapshot()).toEqual({ fenced: false, activeAdmissions: 1, leaseExpiresAt: null });

    releaseAdmission();
    await expect(admission).resolves.toEqual({ admitted: true, value: "finished" });
    await expect(enter).resolves.toEqual({ fenced: false, activeAdmissions: 0, leaseExpiresAt: null });
    await expect(fence.run(async () => "new-dispatch")).resolves.toEqual({ admitted: true, value: "new-dispatch" });
  });
});

describe("supervisor dispatch fence route", () => {
  it("acknowledges enter and exit only for the private local-trusted server", async () => {
    process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN = "route-control-token";
    const app = express();
    app.use("/api/health", healthRoutes(undefined, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }));

    const enter = await request(app)
      .post("/api/health/supervisor-dispatch-fence/enter")
      .set("x-paperclip-supervisor-token", "route-control-token")
      .set("x-paperclip-supervisor-lease", "route-lease-token-that-is-long-enough")
      .expect(200);
    expect(enter.body).toMatchObject({ status: "ok", acknowledged: true, fenced: true, activeAdmissions: 0 });

    await request(app)
      .post("/api/health/supervisor-dispatch-fence/exit")
      .set("x-paperclip-supervisor-token", "wrong-token")
      .set("x-paperclip-supervisor-lease", "route-lease-token-that-is-long-enough")
      .expect(401, { error: "supervisor_control_unauthorized" });
    expect(heartbeatDispatchFence.isLeaseValid("route-lease-token-that-is-long-enough")).toBe(true);

    await request(app)
      .post("/api/health/supervisor-dispatch-fence/exit")
      .set("x-paperclip-supervisor-token", "route-control-token")
      .set("x-paperclip-supervisor-lease", "wrong-route-lease-token-that-is-long-enough")
      .expect(409, { error: "supervisor_fence_lease_invalid" });
    expect(heartbeatDispatchFence.isLeaseValid("route-lease-token-that-is-long-enough")).toBe(true);

    const check = await request(app)
      .post("/api/health/supervisor-dispatch-fence/check")
      .set("x-paperclip-supervisor-token", "route-control-token")
      .set("x-paperclip-supervisor-lease", "route-lease-token-that-is-long-enough")
      .expect(200);
    expect(check.body).toMatchObject({ status: "ok", acknowledged: true, leaseValid: true, fenced: true });

    const exit = await request(app)
      .post("/api/health/supervisor-dispatch-fence/exit")
      .set("x-paperclip-supervisor-token", "route-control-token")
      .set("x-paperclip-supervisor-lease", "route-lease-token-that-is-long-enough")
      .expect(200);
    expect(exit.body).toMatchObject({ status: "ok", acknowledged: true, fenced: false, activeAdmissions: 0 });
  });

  it("rejects the supervisor route outside private local-trusted mode", async () => {
    process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN = "route-control-token";
    const app = express();
    app.use("/api/health", healthRoutes(undefined, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    }));

    await request(app)
      .post("/api/health/supervisor-dispatch-fence/enter")
      .set("x-paperclip-supervisor-token", "route-control-token")
      .set("x-paperclip-supervisor-lease", "route-lease-token-that-is-long-enough")
      .expect(403, { error: "local_supervisor_only" });
  });
});
