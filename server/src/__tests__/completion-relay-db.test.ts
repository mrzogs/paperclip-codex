import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  completionRelayInbox,
  completionRelayMappings,
  completionRelayOutbox,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueExecutionDecisions,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { completionRelayService, relayAcceptanceHash, relayHash } from "../services/completion-relay.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;
type Actor = Record<string, unknown>;

// Disposable two-company Board/API proof. Synthetic companies, issues and evidence
// only; real migrations, real SQL transactions/locks and real local-disk storage.
describeEmbeddedPostgres("completion relay durable DB/API flow", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir = "";
  let storage!: StorageService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-completion-relay-");
    db = createDb(tempDb.connectionString);
    storageDir = mkdtempSync(path.join(tmpdir(), "paperclip-relay-storage-"));
    storage = createStorageService(createLocalDiskStorageProvider(storageDir));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  async function seed(opts: { evidenceBytes?: string } = {}) {
    const now = Date.now();
    const finishedAt = new Date(now - 3_000), acceptedAt = new Date(now - 2_000), sourceUpdatedAt = new Date(now - 1_000);
    const userId = `board-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Synthetic Board", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    const [key] = await db.insert(boardApiKeys).values({ userId, name: "relay-proof", keyHash: relayHash(randomUUID()) }).returning();
    const mkCompany = async (label: string) => (await db.insert(companies).values({
      name: `Relay ${label} ${randomUUID()}`, issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning())[0]!;
    const source = await mkCompany("source"), destination = await mkCompany("destination");
    for (const c of [source, destination]) {
      await db.insert(companyMemberships).values({ companyId: c.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    }
    const [project] = await db.insert(projects).values({ companyId: source.id, name: "Synthetic relay project" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source.id, name: "Synthetic worker" }).returning();
    const [reviewer] = await db.insert(agents).values({ companyId: source.id, name: "Synthetic reviewer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: source.id, agentId: worker!.id, status: "succeeded", finishedAt }).returning();
    const [sourceIssue] = await db.insert(issues).values({ companyId: source.id, projectId: project!.id, title: "SECRET source title",
      description: "SECRET source body", status: "done", assigneeAgentId: worker!.id, createdAt: finishedAt, updatedAt: sourceUpdatedAt }).returning();
    const [destinationIssue] = await db.insert(issues).values({ companyId: destination.id, title: "Destination gate", status: "blocked" }).returning();
    const bytes = Buffer.from(opts.evidenceBytes ?? `synthetic evidence ${randomUUID()}`);
    const stored = await storage.putFile({ companyId: source.id, namespace: "issues/evidence", originalFilename: "secret-name.txt", contentType: "text/plain", body: bytes });
    const [asset] = await db.insert(assets).values({ companyId: source.id, ...stored }).returning();
    const [attachment] = await db.insert(issueAttachments).values({ companyId: source.id, issueId: sourceIssue!.id, assetId: asset!.id }).returning();
    const [workProduct] = await db.insert(issueWorkProducts).values({ companyId: source.id, issueId: sourceIssue!.id, type: "artifact", provider: "paperclip",
      title: "Evidence", status: "active", reviewState: "approved", createdByRunId: run!.id, metadata: { attachmentId: attachment!.id },
      createdAt: finishedAt, updatedAt: finishedAt }).returning();
    const [acceptance] = await db.insert(issueExecutionDecisions).values({ companyId: source.id, issueId: sourceIssue!.id, stageId: randomUUID(),
      stageType: "review", actorAgentId: reviewer!.id, outcome: "approved", body: "Accepted", createdAt: acceptedAt, updatedAt: acceptedAt }).returning();
    const binding = (overrides: Record<string, unknown> = {}) => ({
      projectId: project!.id, domain: "platform", strategy: "synthetic", sourceCompanyId: source.id, sourceIssueId: sourceIssue!.id,
      destinationCompanyId: destination.id, destinationIssueId: destinationIssue!.id, destinationGate: "synthetic-proof", sourceStatus: "done",
      sourceVersion: sourceUpdatedAt.toISOString(), sourceAssigneeAgentId: worker!.id, sourceAssigneeUserId: null, sourceRunId: run!.id,
      acceptanceId: acceptance!.id, acceptanceHash: relayAcceptanceHash(acceptance!), reviewerAgentId: reviewer!.id, reviewerUserId: null,
      evidence: [{ workProductId: workProduct!.id, attachmentId: attachment!.id, sha256: stored.sha256 }], authorizeOriginalCopies: true,
      mappingRevision: 1, idempotencyKey: randomUUID(), ...overrides,
    });
    const boardActor = (companyIds = [source.id, destination.id]): Actor => ({ type: "board", userId, source: "board_key", keyId: key!.id,
      companyIds, isInstanceAdmin: false, memberships: companyIds.map(companyId => ({ companyId, membershipRole: "owner", status: "active" })) });
    return { userId, key: key!, source, destination, project: project!, worker: worker!, reviewer: reviewer!, run: run!, sourceIssue: sourceIssue!,
      destinationIssue: destinationIssue!, asset: asset!, attachment: attachment!, stored, bytes, acceptance: acceptance!, binding, boardActor };
  }

  function app(actor: Actor, relayStorage: StorageService = storage) {
    return import("../routes/completion-relays.js").then(({ completionRelayRoutes }) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { (req as unknown as { actor: Actor }).actor = actor; next(); });
      a.use("/api", completionRelayRoutes(db, relayStorage));
      a.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.status ?? (err.name === "ZodError" ? 400 : 500)).json({ error: err.message });
      });
      return a;
    });
  }

  async function createAndEnable(s: Awaited<ReturnType<typeof seed>>, body = s.binding()) {
    const http = await app(s.boardActor());
    const created = await request(http).post("/api/completion-relays").send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.enabled).toBe(false);
    const enabled = await request(http).patch(`/api/completion-relays/${created.body.id}`).send({ enabled: true });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    return { http, mapping: enabled.body as { id: string }, body };
  }
  const rows = async (mappingId: string) => ({
    outbox: await db.select().from(completionRelayOutbox).where(eq(completionRelayOutbox.mappingId, mappingId)),
    inbox: await db.select().from(completionRelayInbox).where(eq(completionRelayInbox.mappingId, mappingId)),
  });
  const destinationArtifacts = async (issueId: string) => ({
    comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
    attachments: await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issueId)),
  });

  it("delivers once across two companies, replays idempotently and keeps the destination gate blocked", async () => {
    const s = await seed();
    const { http, mapping, body } = await createAndEnable(s);
    const relay = completionRelayService(db, storage);
    await relay.reconcile();
    const first = await rows(mapping.id);
    expect(first.outbox[0]!.state).toBe("delivered");
    expect(first.inbox).toHaveLength(1);

    // Duplicate replay: same idempotency key, repeated reconcile and direct deliver.
    const again = await request(http).post("/api/completion-relays").send(body);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(mapping.id);
    await relay.reconcile();
    await relay.deliver(mapping.id);
    const replay = await rows(mapping.id);
    expect(replay.inbox).toHaveLength(1);
    const dest = await destinationArtifacts(s.destinationIssue.id);
    expect(dest.comments).toHaveLength(1);
    expect(dest.attachments).toHaveLength(1);

    // Selected nonsecret fields only; no source title/body/filename/source URL.
    const comment = dest.comments[0]!.body;
    expect(comment).not.toMatch(/SECRET|secret-name/);
    expect(comment).not.toContain(s.attachment.id);
    expect(comment).toContain(dest.attachments[0]!.id);
    expect(comment).toContain(s.stored.sha256);

    // Copied original lives in destination company storage with a verified hash;
    // destination scope cannot read the source object key.
    const [copied] = await db.select().from(assets).where(eq(assets.id, dest.attachments[0]!.assetId));
    expect(copied!.companyId).toBe(s.destination.id);
    expect(copied!.sha256).toBe(s.stored.sha256);
    expect(copied!.objectKey.startsWith(`${s.destination.id}/`)).toBe(true);
    const download = await storage.getObject(s.destination.id, copied!.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(relayHash(Buffer.concat(chunks))).toBe(s.stored.sha256);
    await expect(storage.getObject(s.destination.id, s.asset.objectKey)).rejects.toThrow();

    // Eligible input, not gate approval.
    const [destIssue] = await db.select().from(issues).where(eq(issues.id, s.destinationIssue.id));
    expect(destIssue!.status).toBe("blocked");
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, mapping.id));
    expect(audit.filter(a => a.action === "completion_relay.delivered")).toHaveLength(2);
  });

  it("denies agents, foreign-company board actors and Board without both memberships", async () => {
    const s = await seed();
    const agentHttp = await app({ type: "agent", agentId: s.worker.id, companyId: s.source.id });
    expect((await request(agentHttp).post("/api/completion-relays").send(s.binding())).status).toBe(403);
    expect((await request(agentHttp).get(`/api/companies/${s.source.id}/completion-relays`)).status).toBe(403);

    const oneCompany = await app(s.boardActor([s.source.id]));
    expect((await request(oneCompany).post("/api/completion-relays").send(s.binding())).status).toBe(403);

    const sessionBoard = await app({ ...s.boardActor(), source: "session", keyId: undefined });
    expect((await request(sessionBoard).post("/api/completion-relays").send(s.binding())).status).toBe(403);

    // Route-level company access passes but durable membership is missing -> 422 fail closed.
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, s.destination.id));
    const res = await request(await app(s.boardActor())).post("/api/completion-relays").send(s.binding());
    expect(res.status).toBe(422);
    expect(await db.select().from(completionRelayMappings).where(eq(completionRelayMappings.sourceIssueId, s.sourceIssue.id))).toHaveLength(0);
  });

  it("dead-letters on Board key revocation or membership loss after enablement", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    await db.update(boardApiKeys).set({ revokedAt: new Date() }).where(eq(boardApiKeys.id, s.key.id));
    await completionRelayService(db, storage).reconcile();
    const r = await rows(mapping.id);
    expect(r.outbox[0]!.state).toBe("dead_letter");
    expect(r.outbox[0]!.failure).toMatch(/Board key revoked/);
    expect(r.outbox[0]!.failure).toContain(s.userId);
    expect(r.inbox).toHaveLength(0);
    expect((await destinationArtifacts(s.destinationIssue.id)).comments).toHaveLength(0);

    const s2 = await seed();
    const { mapping: m2 } = await createAndEnable(s2);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, s2.destination.id));
    await completionRelayService(db, storage).deliver(m2.id);
    expect((await rows(m2.id)).outbox[0]?.state ?? "none").not.toBe("delivered");
  });

  it.each([
    ["reopened source", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, s.sourceIssue.id)); }, /reopened/],
    ["reassigned source", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(issues).set({ assigneeAgentId: s.reviewer.id, updatedAt: new Date(s.binding().sourceVersion) }).where(eq(issues.id, s.sourceIssue.id)); }, /reassigned/],
    ["stale run", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, s.run.id)); }, /run missing, stale/],
    ["review rejection", async (s: Awaited<ReturnType<typeof seed>>) => { await db.insert(issueExecutionDecisions).values({ companyId: s.source.id, issueId: s.sourceIssue.id, stageId: randomUUID(), stageType: "review", actorAgentId: s.reviewer.id, outcome: "changes_requested", body: "Rejected" }); }, /acceptance missing, changed, stale or rejected/],
    ["missing evidence", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(issueWorkProducts).set({ reviewState: "none" }).where(eq(issueWorkProducts.issueId, s.sourceIssue.id)); }, /Evidence missing/],
    ["changed receipt hash", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(assets).set({ sha256: "0".repeat(64) }).where(eq(assets.id, s.asset.id)); }, /hash\/size\/company mismatch/],
    ["destination gate already released", async (s: Awaited<ReturnType<typeof seed>>) => { await db.update(issues).set({ status: "todo" }).where(eq(issues.id, s.destinationIssue.id)); }, /Destination gate must remain blocked/],
  ])("does not release a gate after %s", async (_label, mutate, reason) => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    await mutate(s);
    await completionRelayService(db, storage).reconcile();
    const r = await rows(mapping.id);
    expect(r.outbox[0]!.state).toBe("dead_letter");
    expect(r.outbox[0]!.failure).toMatch(reason);
    expect(r.inbox).toHaveLength(0);
    const dest = await destinationArtifacts(s.destinationIssue.id);
    expect(dest.comments).toHaveLength(0);
    expect(dest.attachments).toHaveLength(0);
  });

  it("does not deliver disabled mappings and rejects out-of-order / superseded revisions", async () => {
    const s = await seed();
    const http = await app(s.boardActor());
    const r1 = await request(http).post("/api/completion-relays").send(s.binding({ mappingRevision: 1 }));
    const r2 = await request(http).post("/api/completion-relays").send(s.binding({ mappingRevision: 2 }));
    expect([r1.status, r2.status]).toEqual([201, 201]);
    // Disabled (default) mappings are never enqueued.
    await completionRelayService(db, storage).reconcile();
    expect((await rows(r1.body.id)).outbox).toHaveLength(0);
    expect((await request(http).patch(`/api/completion-relays/${r2.body.id}`).send({ enabled: true })).status).toBe(200);
    const stale = await request(http).patch(`/api/completion-relays/${r1.body.id}`).send({ enabled: true });
    expect(stale.status).toBe(422);
    expect((await request(http).patch(`/api/completion-relays/${r2.body.id}`).send({ enabled: false })).status).toBe(200);
    const superseded = await request(http).patch(`/api/completion-relays/${r1.body.id}`).send({ enabled: true });
    expect(superseded.status).toBe(422);
    expect(superseded.body.error).toMatch(/superseded or out of order/);
    // Same idempotency key with a different binding is refused.
    const conflict = await request(http).post("/api/completion-relays").send({ ...s.binding({ mappingRevision: 3 }), idempotencyKey: r1.body.binding.idempotencyKey });
    expect(conflict.status).toBe(409);
  });

  it("refuses relay chains that could self-trigger", async () => {
    const a = await seed();
    const { mapping } = await createAndEnable(a);
    expect(mapping.id).toBeTruthy();
    // A second mapping whose source is the first mapping's destination issue cannot be enabled.
    const http = await app(a.boardActor());
    const chainId = randomUUID();
    await db.insert(completionRelayMappings).values({ id: chainId, sourceCompanyId: a.destination.id, destinationCompanyId: a.source.id,
      sourceIssueId: a.destinationIssue.id, destinationIssueId: a.sourceIssue.id, ownerUserId: a.userId, ownerKeyId: a.key.id,
      binding: a.binding() as never, bindingHash: "0".repeat(64), idempotencyKey: randomUUID() });
    const res = await request(http).patch(`/api/completion-relays/${chainId}`).send({ enabled: true });
    expect(res.status).toBe(422);
  });

  it("rolls back on storage crash, retries with backoff and survives restart reconciliation", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    let failPut = true;
    const flaky: StorageService = { ...storage, putFile: async (input) => {
      if (failPut) throw new Error("simulated crash during destination copy");
      return storage.putFile(input);
    } };
    await completionRelayService(db, flaky).reconcile();
    let r = await rows(mapping.id);
    expect(r.outbox[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect(r.outbox[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(r.inbox).toHaveLength(0);
    expect((await destinationArtifacts(s.destinationIssue.id)).attachments).toHaveLength(0);

    // Backoff respected: an immediate retry is a no-op.
    await completionRelayService(db, flaky).deliver(mapping.id);
    expect((await rows(mapping.id)).outbox[0]!.attempts).toBe(1);

    // "Restart": a fresh service instance after backoff elapses completes delivery.
    failPut = false;
    await db.update(completionRelayOutbox).set({ nextAttemptAt: new Date(Date.now() - 1) }).where(eq(completionRelayOutbox.mappingId, mapping.id));
    await completionRelayService(db, flaky).reconcile();
    r = await rows(mapping.id);
    expect(r.outbox[0]!.state).toBe("delivered");
    expect(r.inbox).toHaveLength(1);
  });

  it("dead-letters after bounded transient retries", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    const broken: StorageService = { ...storage, putFile: async () => { throw new Error("storage down"); } };
    for (let i = 0; i < 3; i += 1) {
      await db.update(completionRelayOutbox).set({ nextAttemptAt: new Date(Date.now() - 1) }).where(eq(completionRelayOutbox.mappingId, mapping.id));
      await completionRelayService(db, broken).reconcile();
    }
    const r = await rows(mapping.id);
    expect(r.outbox[0]).toMatchObject({ state: "dead_letter", attempts: 3 });
    expect(r.outbox[0]!.failure).toMatch(/Owner .*inspect immutable binding/);
  });

  it("recovers a completion whose enqueue was lost between source commit and outbox insert", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    // Enabled mapping with no outbox row == crash after commit, before enqueue.
    expect((await rows(mapping.id)).outbox).toHaveLength(0);
    await completionRelayService(db, storage).reconcile();
    expect((await rows(mapping.id)).inbox).toHaveLength(1);
  });

  it("serializes concurrent deliveries to a single receipt", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    await db.insert(completionRelayOutbox).values({ mappingId: mapping.id });
    const relay = completionRelayService(db, storage);
    await Promise.all([relay.deliver(mapping.id), relay.deliver(mapping.id), relay.deliver(mapping.id)]);
    expect((await rows(mapping.id)).inbox).toHaveLength(1);
    expect((await destinationArtifacts(s.destinationIssue.id)).attachments).toHaveLength(1);
  });

  it("does not block FK inserts in either company while delivery is stalled in storage I/O (OCE-957 R1)", async () => {
    const s = await seed();
    const { mapping } = await createAndEnable(s);
    await db.insert(completionRelayOutbox).values({ mappingId: mapping.id });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stalled!: () => void;
    const reachedStorage = new Promise<void>(resolve => { stalled = resolve; });
    const slow: StorageService = { ...storage, getObject: async (companyId, objectKey) => {
      stalled(); await gate; return storage.getObject(companyId, objectKey);
    } };
    const delivery = completionRelayService(db, slow).deliver(mapping.id);
    await reachedStorage;
    // Before the fix, companies/issues FOR UPDATE made these hit lock_timeout.
    for (const [companyId, issueId] of [[s.source.id, s.sourceIssue.id], [s.destination.id, s.destinationIssue.id]] as const) {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '1500ms'`);
        await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: "oce-957-probe", action: "probe", entityType: "issue", entityId: issueId });
        await tx.insert(issueComments).values({ companyId, issueId, authorType: "system", body: "concurrent probe" });
      });
    }
    release();
    await delivery;
    const r = await rows(mapping.id);
    expect(r.outbox[0]!.state).toBe("delivered");
    expect(r.inbox).toHaveLength(1);
  });

  it("rejects a binding whose source run was not made by the bound assignee agent", async () => {
    const s = await seed();
    const [other] = await db.insert(agents).values({ companyId: s.source.id, name: "Synthetic other" }).returning();
    await db.update(heartbeatRuns).set({ agentId: other!.id }).where(eq(heartbeatRuns.id, s.run.id));
    const res = await request(await app(s.boardActor())).post("/api/completion-relays").send(s.binding());
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/bound assignee/);
  });
});
