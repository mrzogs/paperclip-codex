import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";
import { heartbeatDispatchFence } from "../services/heartbeat-dispatch-fence.js";
import { heartbeatService } from "../services/heartbeat.js";

const SUPERVISOR_FENCE_LEASE_TTL_MS = 60_000;

function isLoopbackRequest(remoteAddress: string | undefined) {
  const normalized = (remoteAddress ?? "").replace(/^::ffff:/, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

function hasSupervisorControlToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  const requireSupervisorControl = (req: Request, res: Response) => {
    if (
      opts.deploymentMode !== "local_trusted" ||
      opts.deploymentExposure !== "private" ||
      !isLoopbackRequest(req.socket.remoteAddress)
    ) {
      res.status(403).json({ error: "local_supervisor_only" });
      return false;
    }
    if (!process.env.PAPERCLIP_SUPERVISOR_CONTROL_TOKEN?.trim()) {
      res.status(503).json({ error: "supervisor_control_unconfigured" });
      return false;
    }
    if (!hasSupervisorControlToken(req.get("x-paperclip-supervisor-token"))) {
      res.status(401).json({ error: "supervisor_control_unauthorized" });
      return false;
    }
    return true;
  };

  const resumeQueuedRunsAfterFenceRelease = async (releaseReason: "explicit" | "expired") => {
    if (!db) return false;
    try {
      await heartbeatService(db).resumeQueuedRuns();
      return true;
    } catch (error) {
      logger.error({ err: error, releaseReason }, "Failed to resume queued runs after supervisor fence release");
      return false;
    }
  };

  router.post("/supervisor-dispatch-fence/enter", async (req, res) => {
    if (!requireSupervisorControl(req, res)) return;
    const leaseToken = req.get("x-paperclip-supervisor-lease")?.trim() ?? "";
    if (leaseToken.length < 32) {
      res.status(400).json({ error: "supervisor_fence_lease_required" });
      return;
    }
    try {
      const state = await heartbeatDispatchFence.enter(
        leaseToken,
        SUPERVISOR_FENCE_LEASE_TTL_MS,
        async () => {
          await resumeQueuedRunsAfterFenceRelease("expired");
        },
      );
      if (!heartbeatDispatchFence.isLeaseValid(leaseToken) || !state.fenced || state.activeAdmissions !== 0) {
        res.status(409).json({ error: "supervisor_fence_not_acknowledged", ...state });
        return;
      }
      res.json({ status: "ok", acknowledged: true, ...state });
    } catch {
      res.status(409).json({ error: "supervisor_fence_already_held" });
    }
  });

  router.post("/supervisor-dispatch-fence/exit", async (req, res) => {
    if (!requireSupervisorControl(req, res)) return;
    const leaseToken = req.get("x-paperclip-supervisor-lease")?.trim() ?? "";
    try {
      const state = heartbeatDispatchFence.exit(leaseToken);
      const resumedQueuedRuns = await resumeQueuedRunsAfterFenceRelease("explicit");
      res.json({ status: "ok", acknowledged: true, resumedQueuedRuns, ...state });
    } catch {
      res.status(409).json({ error: "supervisor_fence_lease_invalid" });
    }
  });

  router.post("/supervisor-dispatch-fence/check", (req, res) => {
    if (!requireSupervisorControl(req, res)) return;
    const leaseToken = req.get("x-paperclip-supervisor-lease")?.trim() ?? "";
    try {
      const state = heartbeatDispatchFence.renew(leaseToken, SUPERVISOR_FENCE_LEASE_TTL_MS);
      res.json({ status: "ok", acknowledged: true, leaseValid: true, ...state });
    } catch {
      res.status(409).json({ error: "supervisor_fence_lease_invalid", ...heartbeatDispatchFence.snapshot() });
    }
  });

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
