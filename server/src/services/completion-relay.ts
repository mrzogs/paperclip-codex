import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, assets, boardApiKeys, companies, companyMemberships, completionRelayInbox,
  completionRelayMappings, completionRelayOutbox, heartbeatRuns, issueAttachments, issueComments,
  issueExecutionDecisions, issues, issueWorkProducts, type Db } from "@paperclipai/db";
import { completionRelayMappingSchema, type CompletionRelayBinding } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import type { AuthorizationActor } from "./authorization.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Mapping = typeof completionRelayMappings.$inferSelect;
type BoardActor = AuthorizationActor & { keyId?: string };
export const relayHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Canonical object keys for stable identity, independent of caller JSON key order.
export function relayBindingHash(binding: CompletionRelayBinding): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return relayHash(JSON.stringify(canonical(binding)));
}
export function relayAcceptanceHash(acceptance: typeof issueExecutionDecisions.$inferSelect) {
  return relayHash(JSON.stringify({ id: acceptance.id, companyId: acceptance.companyId, issueId: acceptance.issueId,
    stageId: acceptance.stageId, stageType: acceptance.stageType, actorAgentId: acceptance.actorAgentId,
    actorUserId: acceptance.actorUserId, outcome: acceptance.outcome, body: acceptance.body,
    createdByRunId: acceptance.createdByRunId, createdAt: acceptance.createdAt.toISOString(), updatedAt: acceptance.updatedAt.toISOString() }));
}
class RelayBlocked extends HttpError { constructor(reason: string) { super(422, reason); } }
function requireRelay(ok: unknown, reason: string): asserts ok { if (!ok) throw new RelayBlocked(reason); }

/** No stored bearer tokens or implicit Board impersonation. A persistent Board key
 * plus explicit writable memberships in BOTH companies is required, even for admins.
 * Lock these rows until delivery commits so revocation and delivery serialize. */
export async function verifyRelayAuthority(tx: Tx, ownerUserId: string, ownerKeyId: string, companyIds: string[]) {
  const [key] = await tx.select().from(boardApiKeys).where(eq(boardApiKeys.id, ownerKeyId)).for("update");
  requireRelay(key && key.userId === ownerUserId && !key.revokedAt && (!key.expiresAt || key.expiresAt > new Date()), "Board key revoked, expired or mismatched; owner must create a new mapping");
  const memberships = await tx.select().from(companyMemberships).where(and(
    eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, ownerUserId),
    inArray(companyMemberships.companyId, companyIds))).orderBy(companyMemberships.companyId).for("update");
  requireRelay(companyIds.every(id => memberships.some(m => m.companyId === id && m.status === "active" && ["owner", "admin", "member", "operator"].includes(m.membershipRole ?? ""))), "Board no longer has explicit mutation memberships in both companies");
  const scopes = await tx.select().from(companies).where(inArray(companies.id, companyIds)).for("update");
  requireRelay(scopes.length === 2 && scopes.every(c => c.status === "active"), "Source or destination company unavailable");
}
function boardIdentity(actor: BoardActor) {
  if (actor.type !== "board" || actor.source !== "board_key" || !actor.userId || !actor.keyId) {
    throw forbidden("A persistent Board key with explicit writable memberships in both companies is required");
  }
  return { userId: actor.userId, keyId: actor.keyId };
}
async function audit(tx: Tx, m: Mapping, action: string, details: Record<string, unknown> = {}) {
  for (const companyId of [m.sourceCompanyId, m.destinationCompanyId]) {
    await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: `completion-relay:${m.ownerUserId}`,
      action, entityType: "completion_relay", entityId: m.id, details: { bindingHash: m.bindingHash, ...details } });
  }
}

export async function validateRelaySnapshot(tx: Tx, m: Mapping) {
  const b = completionRelayMappingSchema.parse(m.binding);
  requireRelay(relayBindingHash(b) === m.bindingHash, "Mapping binding changed");
  const endpoints = await tx.select().from(issues).where(inArray(issues.id, [b.sourceIssueId, b.destinationIssueId])).orderBy(issues.id).for("update");
  const source = endpoints.find(i => i.id === b.sourceIssueId);
  const destination = endpoints.find(i => i.id === b.destinationIssueId);
  requireRelay(source && destination && source.companyId === b.sourceCompanyId && destination.companyId === b.destinationCompanyId, "Endpoint/company mismatch");
  requireRelay(!source.hiddenAt && !destination.hiddenAt && source.projectId === b.projectId, "Project or visibility mismatch");
  requireRelay(source.status === b.sourceStatus && source.updatedAt.toISOString() === b.sourceVersion
    && source.assigneeAgentId === b.sourceAssigneeAgentId && source.assigneeUserId === b.sourceAssigneeUserId, "Source reopened, version changed or reassigned");
  requireRelay(destination.status === "blocked", "Destination gate must remain blocked awaiting independent acceptance");
  const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, b.sourceRunId)).for("update");
  requireRelay(run && run.companyId === b.sourceCompanyId && run.status === "succeeded" && run.finishedAt && run.finishedAt <= source.updatedAt, "Source run missing, stale or incomplete");
  const decisions = await tx.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, b.sourceIssueId)).orderBy(sql`${issueExecutionDecisions.createdAt} desc`, sql`${issueExecutionDecisions.id} desc`).for("update");
  const acceptance = decisions[0];
  requireRelay(acceptance && acceptance.id === b.acceptanceId && acceptance.companyId === b.sourceCompanyId
    && acceptance.outcome === "approved" && acceptance.actorAgentId === b.reviewerAgentId && acceptance.actorUserId === b.reviewerUserId
    && acceptance.actorAgentId !== run.agentId && acceptance.createdAt >= run.finishedAt
    && ["review", "approval"].includes(acceptance.stageType)
    && acceptance.updatedAt <= source.updatedAt && relayAcceptanceHash(acceptance) === b.acceptanceHash, "Independent acceptance missing, changed, stale or rejected");
  const evidence = [];
  for (const e of b.evidence) {
    const [wp] = await tx.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, e.workProductId)).for("update");
    const [attachment] = await tx.select().from(issueAttachments).where(eq(issueAttachments.id, e.attachmentId)).for("update");
    requireRelay(wp && attachment && wp.companyId === b.sourceCompanyId && wp.issueId === b.sourceIssueId
      && wp.createdByRunId === b.sourceRunId && wp.metadata?.attachmentId === e.attachmentId
      && wp.reviewState === "approved" && wp.updatedAt <= acceptance.createdAt
      && attachment.companyId === b.sourceCompanyId && attachment.issueId === b.sourceIssueId, "Evidence missing or not accepted for bound source run");
    const [asset] = await tx.select().from(assets).where(eq(assets.id, attachment.assetId)).for("update");
    requireRelay(asset && asset.companyId === b.sourceCompanyId && asset.sha256 === e.sha256 && asset.byteSize <= 10 * 1024 * 1024, "Original artifact hash/size/company mismatch");
    evidence.push({ binding: e, asset });
  }
  return { binding: b, evidence };
}

export function completionRelayService(db: Db, storage: StorageService) {
  async function create(actor: BoardActor, input: unknown) {
    const identity = boardIdentity(actor);
    const binding = completionRelayMappingSchema.parse(input);
    return db.transaction(async tx => {
      // Mapping insert/enable takes the same global lock, preventing concurrent cycles.
      await tx.execute(sql`select pg_advisory_xact_lock(808808)`);
      await verifyRelayAuthority(tx, identity.userId, identity.keyId, [binding.sourceCompanyId, binding.destinationCompanyId]);
      const [existing] = await tx.select().from(completionRelayMappings).where(eq(completionRelayMappings.idempotencyKey, binding.idempotencyKey));
      if (existing) {
        if (existing.ownerUserId !== identity.userId || existing.bindingHash !== relayBindingHash(binding)) throw conflict("Idempotency key already bound to another immutable mapping");
        return existing;
      }
      const [m] = await tx.insert(completionRelayMappings).values({ sourceCompanyId: binding.sourceCompanyId,
        destinationCompanyId: binding.destinationCompanyId, sourceIssueId: binding.sourceIssueId,
        destinationIssueId: binding.destinationIssueId, ownerUserId: identity.userId, ownerKeyId: identity.keyId,
        binding, bindingHash: relayBindingHash(binding), idempotencyKey: binding.idempotencyKey }).returning();
      await validateRelaySnapshot(tx, m);
      await audit(tx, m, "completion_relay.created_disabled");
      return m;
    });
  }
  async function setEnabled(actor: BoardActor, id: string, enabled: boolean) {
    const identity = boardIdentity(actor);
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(808808)`);
      const [m] = await tx.select().from(completionRelayMappings).where(eq(completionRelayMappings.id, id)).for("update");
      if (!m) throw notFound("Relay mapping not found");
      if (m.ownerUserId !== identity.userId || m.ownerKeyId !== identity.keyId) throw forbidden("Only the creating Board identity/key can change this mapping");
      await verifyRelayAuthority(tx, identity.userId, identity.keyId, [m.sourceCompanyId, m.destinationCompanyId]);
      if (enabled) {
        await validateRelaySnapshot(tx, m);
        const all = await tx.select().from(completionRelayMappings);
        // Stronger than cycle detection: no relay chains and no competing revision may be enabled.
        requireRelay(!all.some(x => x.id !== id && x.enabled && (x.destinationIssueId === m.sourceIssueId || x.sourceIssueId === m.destinationIssueId
          || (x.sourceIssueId === m.sourceIssueId && x.destinationIssueId === m.destinationIssueId))), "Relay chain/cycle or competing revision; disable old mapping first");
        const previous = all.filter(x => x.id !== id && x.sourceIssueId === m.sourceIssueId && x.destinationIssueId === m.destinationIssueId);
        requireRelay(previous.every(x => x.binding.mappingRevision < m.binding.mappingRevision), "Mapping revision is superseded or out of order");
      }
      const [updated] = await tx.update(completionRelayMappings).set({ enabled }).where(eq(completionRelayMappings.id, id)).returning();
      await audit(tx, m, enabled ? "completion_relay.enabled" : "completion_relay.disabled");
      return updated;
    });
  }
  // Scanning committed immutable bindings closes the source-commit/enqueue crash gap.
  async function reconcile() {
    const mappings = await db.select({ id: completionRelayMappings.id }).from(completionRelayMappings).where(eq(completionRelayMappings.enabled, true));
    if (mappings.length) await db.insert(completionRelayOutbox).values(mappings.map(m => ({ mappingId: m.id }))).onConflictDoNothing();
    const due = await db.select().from(completionRelayOutbox).where(and(eq(completionRelayOutbox.state, "pending"), sql`${completionRelayOutbox.nextAttemptAt} <= now()`)).limit(20);
    for (const job of due) await deliver(job.mappingId);
    return { inspected: due.length };
  }
  async function deliver(id: string) {
    try {
      return await db.transaction(async tx => {
        const [m] = await tx.select().from(completionRelayMappings).where(eq(completionRelayMappings.id, id)).for("update");
        if (!m) throw notFound("Relay mapping not found");
        const [job] = await tx.select().from(completionRelayOutbox).where(eq(completionRelayOutbox.mappingId, id)).for("update");
        if (!job || job.state !== "pending" || job.nextAttemptAt > new Date()) return;
        requireRelay(m.enabled, "Mapping disabled; Board must inspect and create a fresh revision");
        await verifyRelayAuthority(tx, m.ownerUserId, m.ownerKeyId, [m.sourceCompanyId, m.destinationCompanyId]);
        const { binding: b, evidence } = await validateRelaySnapshot(tx, m);
        const [duplicate] = await tx.select().from(completionRelayInbox).where(eq(completionRelayInbox.mappingId, id));
        if (duplicate) return duplicate;
        const attachmentIds: string[] = [];
        for (const { asset, binding } of evidence) {
          const original = await storage.getObject(b.sourceCompanyId, asset.objectKey);
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of original.stream) {
            const bytes = Buffer.from(chunk); length += bytes.length;
            requireRelay(length <= asset.byteSize, "Original artifact exceeds recorded size"); chunks.push(bytes);
          }
          const body = Buffer.concat(chunks);
          requireRelay(length === asset.byteSize && relayHash(body) === binding.sha256, "Original download hash mismatch");
          // Only explicit originals; no source title/body/URL/filename or other unselected metadata.
          const copy = await storage.putFile({ companyId: b.destinationCompanyId, namespace: `completion-relay/${m.id}`,
            originalFilename: "accepted-evidence.bin", contentType: "application/octet-stream", body });
          requireRelay(copy.sha256 === binding.sha256 && copy.byteSize === length, "Destination copy hash mismatch");
          // Verify independently downloadable bytes before making a DB-visible receipt.
          const download = await storage.getObject(b.destinationCompanyId, copy.objectKey);
          const hash = createHash("sha256"); let downloaded = 0;
          for await (const chunk of download.stream) { downloaded += chunk.length; requireRelay(downloaded <= length, "Destination download size mismatch"); hash.update(chunk); }
          requireRelay(downloaded === length && hash.digest("hex") === binding.sha256, "Destination download hash mismatch");
          const [copiedAsset] = await tx.insert(assets).values({ companyId: b.destinationCompanyId, ...copy }).returning();
          const [copiedAttachment] = await tx.insert(issueAttachments).values({ companyId: b.destinationCompanyId, issueId: b.destinationIssueId, assetId: copiedAsset.id }).returning();
          attachmentIds.push(copiedAttachment.id);
        }
        const [comment] = await tx.insert(issueComments).values({ companyId: b.destinationCompanyId, issueId: b.destinationIssueId, authorType: "system",
          body: `Completion relay evidence received for gate ${b.destinationGate}. Binding ${m.bindingHash}; revision ${b.mappingRevision}. Independent destination acceptance, Brain-root attestation and physical-owner gates remain required.\n\n` + attachmentIds.map((a, i) => `[Original evidence ${i + 1}](/api/attachments/${a}/content?download=1) SHA256 ${b.evidence[i].sha256}`).join("\n") }).returning();
        const [receipt] = await tx.insert(completionRelayInbox).values({ mappingId: id, companyId: b.destinationCompanyId,
          issueId: b.destinationIssueId, bindingHash: m.bindingHash,
          receipt: { attachmentIds, hashes: b.evidence.map(e => e.sha256), commentId: comment.id } }).returning();
        await tx.update(completionRelayOutbox).set({ state: "delivered", failure: null }).where(eq(completionRelayOutbox.id, job.id));
        await audit(tx, m, "completion_relay.delivered", { receiptId: receipt.id });
        return receipt;
      });
    } catch (error) {
      // Failed transaction leaves no inbox/comment/attachment rows. Blob copies may
      // be orphaned but never become accessible through destination attachment APIs.
      await db.transaction(async tx => {
        const [m] = await tx.select().from(completionRelayMappings).where(eq(completionRelayMappings.id, id)).for("update");
        const [job] = await tx.select().from(completionRelayOutbox).where(eq(completionRelayOutbox.mappingId, id)).for("update");
        if (!m || !job || job.state !== "pending") return;
        const attempts = job.attempts + 1;
        const dead = error instanceof RelayBlocked || attempts >= 3;
        const failure = error instanceof RelayBlocked ? error.message : "Original/copy storage or transaction unavailable";
        await tx.update(completionRelayOutbox).set({ attempts, state: dead ? "dead_letter" : "pending",
          failure: `${failure}. Owner ${m.ownerUserId}: inspect immutable binding, authority and evidence; create a corrected revision.`,
          nextAttemptAt: new Date(Date.now() + [10_000, 60_000, 300_000][Math.min(attempts - 1, 2)]) }).where(eq(completionRelayOutbox.id, job.id));
        await audit(tx, m, dead ? "completion_relay.dead_letter" : "completion_relay.retry_scheduled", { failure, attempts });
      });
      return null;
    }
  }
  async function inspect(actor: BoardActor, companyId: string) {
    if (actor.type !== "board") throw forbidden("Board access required");
    if (!actor.userId) return [];
    const mappings = await db.select().from(completionRelayMappings).where(and(eq(completionRelayMappings.ownerUserId, actor.userId),
      sql`(${completionRelayMappings.sourceCompanyId} = ${companyId} or ${completionRelayMappings.destinationCompanyId} = ${companyId})`));
    const result = [];
    for (const m of mappings) {
      // Read-only owner inspection remains possible after key revocation so the
      // dead-letter is visible. Never use inspection as a delivery grant.
      const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.status, "active")));
      if (![m.sourceCompanyId, m.destinationCompanyId].every(id => memberships.some(x => x.companyId === id))) continue;
      result.push({ ...m, outbox: await db.select().from(completionRelayOutbox).where(eq(completionRelayOutbox.mappingId, m.id)) });
    }
    return result;
  }
  return { create, setEnabled, reconcile, deliver, inspect };
}
