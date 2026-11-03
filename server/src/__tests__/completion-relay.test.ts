import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { completionRelayMappingSchema } from "@paperclipai/shared";
import { assets, boardApiKeys, companies, companyMemberships, heartbeatRuns, issueAttachments, issueExecutionDecisions, issues, issueWorkProducts, type Db } from "@paperclipai/db";
import { completionRelayService, relayAcceptanceHash, relayBindingHash, relayHash, validateRelaySnapshot, verifyRelayAuthority } from "../services/completion-relay.js";
import type { StorageService } from "../storage/types.js";

// Unit fixtures exercise the production eligibility checks. They do not simulate
// SQL transactions or claim DB/API durability; those require the generated migration.
function fixture() {
  const sourceCompanyId = randomUUID(), destinationCompanyId = randomUUID(), sourceIssueId = randomUUID(), destinationIssueId = randomUUID();
  const runId = randomUUID(), agentId = randomUUID(), reviewerAgentId = randomUUID(), projectId = randomUUID();
  const finishedAt = new Date("2026-10-22T10:00:00Z"), acceptedAt = new Date("2026-10-22T11:00:00Z"), updatedAt = new Date("2026-10-22T12:00:00Z");
  const acceptance = { id: randomUUID(), companyId: sourceCompanyId, issueId: sourceIssueId, stageId: randomUUID(), stageType: "review",
    actorAgentId: reviewerAgentId, actorUserId: null, outcome: "approved", body: "Accepted bound evidence", createdByRunId: randomUUID(), createdAt: acceptedAt, updatedAt: acceptedAt };
  const attachmentId = randomUUID(), workProductId = randomUUID(), assetId = randomUUID();
  const binding = completionRelayMappingSchema.parse({ projectId, domain: "platform", strategy: "synthetic", sourceCompanyId,
    sourceIssueId, destinationCompanyId, destinationIssueId, destinationGate: "synthetic-proof", sourceStatus: "done",
    sourceVersion: updatedAt.toISOString(), sourceAssigneeAgentId: agentId, sourceAssigneeUserId: null, sourceRunId: runId,
    acceptanceId: acceptance.id, acceptanceHash: relayAcceptanceHash(acceptance), reviewerAgentId, reviewerUserId: null,
    evidence: [{ workProductId, attachmentId, sha256: relayHash("evidence") }], authorizeOriginalCopies: true, mappingRevision: 1, idempotencyKey: randomUUID() });
  const source = { id: sourceIssueId, companyId: sourceCompanyId, projectId, status: "done", updatedAt,
    assigneeAgentId: agentId, assigneeUserId: null, hiddenAt: null };
  const destination = { id: destinationIssueId, companyId: destinationCompanyId, status: "blocked", hiddenAt: null };
  const run = { id: runId, companyId: sourceCompanyId, agentId, status: "succeeded", finishedAt };
  const wp = { id: workProductId, companyId: sourceCompanyId, issueId: sourceIssueId, createdByRunId: runId,
    metadata: { attachmentId }, reviewState: "approved", updatedAt: finishedAt };
  const attachment = { id: attachmentId, companyId: sourceCompanyId, issueId: sourceIssueId, assetId };
  const asset = { id: assetId, companyId: sourceCompanyId, sha256: binding.evidence[0].sha256, byteSize: 8 };
  const tables = new Map<unknown, unknown[]>([[issues, [source, destination]], [heartbeatRuns, [run]], [issueExecutionDecisions, [acceptance]],
    [issueWorkProducts, [wp]], [issueAttachments, [attachment]], [assets, [asset]]]);
  const tx = { select: () => ({ from: (table: unknown) => {
    const rows = tables.get(table) ?? [];
    const query = { where: () => query, orderBy: () => query, for: () => Promise.resolve(rows) };
    return query;
  } }) } as unknown as Parameters<typeof validateRelaySnapshot>[0];
  const mapping = { id: randomUUID(), sourceCompanyId, destinationCompanyId, sourceIssueId, destinationIssueId,
    ownerUserId: "synthetic-board", ownerKeyId: randomUUID(), binding, bindingHash: relayBindingHash(binding),
    idempotencyKey: binding.idempotencyKey, enabled: true, createdAt: updatedAt };
  return { tx, mapping, binding, source, destination, run, wp, attachment, asset, acceptance, tables };
}

describe("completion relay eligibility", () => {
  it("accepts independently reviewed evidence while preserving a blocked destination", async () => {
    const f = fixture();
    await expect(validateRelaySnapshot(f.tx, f.mapping)).resolves.toMatchObject({ binding: f.binding });
    expect(f.destination.status).toBe("blocked");
  });
  it.each([
    ["reopened", (f: ReturnType<typeof fixture>) => { f.source.status = "in_progress"; }],
    ["new source version", f => { f.source.updatedAt = new Date(); }],
    ["reassignment", f => { f.source.assigneeAgentId = randomUUID(); }],
    ["stale evidence run", f => { f.wp.createdByRunId = randomUUID(); }],
    ["failed run", f => { f.run.status = "failed"; }],
    ["run by unbound agent", f => { f.run.agentId = randomUUID(); }],
    ["source company mismatch", f => { f.source.companyId = randomUUID(); }],
    ["destination company mismatch", f => { f.destination.companyId = randomUUID(); }],
    ["missing evidence", f => { f.tables.set(issueAttachments, []); }],
    ["changed artifact hash", f => { f.asset.sha256 = relayHash("different"); }],
    ["foreign artifact", f => { f.asset.companyId = randomUUID(); }],
    ["review rejection", f => { f.acceptance.outcome = "changes_requested"; }],
    ["changed acceptance receipt", f => { f.acceptance.stageId = randomUUID(); }],
    ["self-review", f => { f.acceptance.actorAgentId = f.run.agentId; }],
    ["already released gate", f => { f.destination.status = "todo"; }],
  ] as Array<[string, (f: ReturnType<typeof fixture>) => void]>)("blocks %s", async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await expect(validateRelaySnapshot(f.tx, f.mapping)).rejects.toMatchObject({ status: 422 });
  });
  it("rejects source self-trigger and missing explicit original-copy authorization", () => {
    const { binding } = fixture();
    expect(completionRelayMappingSchema.safeParse({ ...binding, destinationCompanyId: binding.sourceCompanyId }).success).toBe(false);
    expect(completionRelayMappingSchema.safeParse({ ...binding, authorizeOriginalCopies: false }).success).toBe(false);
  });
  it("makes equivalent JSON field order idempotent, and binds changed revisions", () => {
    const { binding } = fixture();
    expect(relayBindingHash(binding)).toBe(relayBindingHash(Object.fromEntries(Object.entries(binding).reverse()) as typeof binding));
    expect(relayBindingHash(binding)).not.toBe(relayBindingHash({ ...binding, mappingRevision: 2 }));
  });
  it.each([{ type: "agent", source: "agent_key", agentId: randomUUID() }, { type: "board", source: "local_implicit" },
    { type: "board", source: "session", userId: "human" }, { type: "none" }] as const)("rejects unbound authority %j before DB access", async actor => {
    const service = completionRelayService({} as Db, {} as StorageService);
    await expect(service.create(actor, fixture().binding)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["valid", "revoked key", "expired key", "foreign key owner", "viewer destination", "revoked source", "archived destination"])("rechecks persisted Board authority: %s", async condition => {
    const f = fixture();
    const key = { userId: f.mapping.ownerUserId, revokedAt: condition === "revoked key" ? new Date() : null,
      expiresAt: condition === "expired key" ? new Date(0) : null };
    if (condition === "foreign key owner") key.userId = "other-board";
    f.tables.set(boardApiKeys, [key]);
    f.tables.set(companyMemberships, [
      { companyId: f.binding.sourceCompanyId, status: condition === "revoked source" ? "archived" : "active", membershipRole: "owner" },
      { companyId: f.binding.destinationCompanyId, status: "active", membershipRole: condition === "viewer destination" ? "viewer" : "operator" },
    ]);
    f.tables.set(companies, [{ id: f.binding.sourceCompanyId, status: "active" },
      { id: f.binding.destinationCompanyId, status: condition === "archived destination" ? "archived" : "active" }]);
    const result = verifyRelayAuthority(f.tx, f.mapping.ownerUserId, f.mapping.ownerKeyId, [f.binding.sourceCompanyId, f.binding.destinationCompanyId]);
    if (condition === "valid") await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toMatchObject({ status: 422 });
  });
});
