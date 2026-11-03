import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { completionRelayMappingSchema } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { completionRelayService } from "../services/completion-relay.js";
import type { AuthorizationActor } from "../services/authorization.js";

// The immutable starting ref omits the repository's global Request augmentation.
const actor = (req: unknown) => (req as { actor: AuthorizationActor & { keyId?: string } }).actor;

export function completionRelayRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const relay = completionRelayService(db, storage);
  router.post("/completion-relays", async (req, res) => {
    assertBoard(req);
    const binding = completionRelayMappingSchema.parse(req.body);
    assertCompanyAccess(req, binding.sourceCompanyId);
    assertCompanyAccess(req, binding.destinationCompanyId);
    res.status(201).json(await relay.create(actor(req), binding));
  });
  router.patch("/completion-relays/:id", async (req, res) => {
    assertBoard(req);
    const id = z.string().uuid().parse(req.params.id);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    res.json(await relay.setEnabled(actor(req), id, enabled));
  });
  router.get("/companies/:companyId/completion-relays", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await relay.inspect(actor(req), companyId));
  });
  // No agent-accessible invoke endpoint. Reconciliation uses durable Board grants.
  return router;
}
