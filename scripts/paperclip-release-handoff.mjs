import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const hash = (value) => createHash("sha256").update(value).digest("hex");
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function validateManifest(manifest) {
  requireThat(manifest?.version === 1 && manifest.flow === "vwap-release", "VWAP release manifest required");
  for (const key of ["companyId", "projectId", "sourceIssueId", "assigneeAgentId"]) {
    requireThat(uuid.test(manifest[key]), `Invalid ${key}`);
  }
  requireThat(/^[a-z0-9-]{1,64}$/.test(manifest.handoffKey), "Invalid handoffKey");
  requireThat(["ready", "awaiting_inputs"].includes(manifest.mode), "Invalid handoff mode");
  requireThat(typeof manifest.title === "string" && manifest.title.trim().length > 0, "Title required");
  requireThat(typeof manifest.instructions === "string" && manifest.instructions.trim().length > 0, "Instructions required");
  requireThat(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "Immutable artifacts required");
  for (const artifact of manifest.artifacts) {
    requireThat(uuid.test(artifact.attachmentId) && /^[\da-f]{64}$/.test(artifact.sha256), "Invalid artifact identity");
  }
  if (manifest.mode === "awaiting_inputs") {
    requireThat(Array.isArray(manifest.missingInputs) && manifest.missingInputs.length > 0
      && manifest.missingInputs.every((item) => typeof item === "string" && item.trim()), "Missing inputs required");
  } else {
    requireThat(!manifest.missingInputs?.length && !manifest.existingBacklogIssueId, "Ready handoff cannot adopt parked work");
  }
  requireThat(!manifest.existingBacklogIssueId || uuid.test(manifest.existingBacklogIssueId), "Invalid backlog issue");
  // An observed 403 is evidence only. It never authorizes impersonation or a second PATCH.
  requireThat(manifest.activationErrorStatus === undefined || manifest.activationErrorStatus === 403,
    "Only observed cross-owner 403 evidence is supported");
  return hash(JSON.stringify(canonical(manifest)));
}

function privateDirectory(directory) {
  requireThat(path.isAbsolute(directory), "Absolute private state directory required");
  let current = path.resolve(directory);
  for (;;) {
    requireThat(!fs.existsSync(path.join(current, ".git")), "State must be outside a Git checkout");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// One bounded pass; the release owner invokes this at handoff and on continuation.
// No daemon, scheduler, global graph scan, elevated token, or direct DB access.
export async function releaseHandoffOnce({ manifest, stateDirectory, apiUrl, apiKey, runId, fetcher = fetch }) {
  const digest = validateManifest(manifest);
  const api = new URL(apiUrl);
  requireThat(["http:", "https:"].includes(api.protocol) && !api.username && !api.password
    && api.pathname === "/" && !api.search && !api.hash, "API origin required");
  requireThat(api.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname),
    "Remote API requires HTTPS");
  requireThat(apiKey && uuid.test(runId), "Run credential and run ID required");
  privateDirectory(stateDirectory);
  const name = `${manifest.companyId}-${manifest.sourceIssueId}-${manifest.handoffKey}`;
  const stateFile = path.join(stateDirectory, `${name}.json`);
  const lockFile = `${stateFile}.lock`;
  // Never steal a stale lock automatically: another host/process may still be writing.
  const lock = fs.openSync(lockFile, "wx", 0o600);
  try {
    fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: process.pid, runId }));
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {
      version: 1, api: api.origin, digest, stages: {},
    };
    requireThat(state.version === 1 && state.api === api.origin && state.digest === digest,
      "Immutable handoff changed; use a new handoffKey and review the prior blockers");
    const save = () => {
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    };
    const request = async (route, method = "GET", body) => {
      const response = await fetcher(`${api.origin}/api${route}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${apiKey}`, "X-Paperclip-Run-Id": runId,
          ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${method} ${route}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    };
    const scopedIssue = async (id) => {
      const issue = await request(`/issues/${id}`);
      requireThat(issue.id === id && issue.companyId === manifest.companyId && issue.projectId === manifest.projectId,
        "Issue is outside the manifest company/project");
      return issue;
    };
    const source = await scopedIssue(manifest.sourceIssueId);
    requireThat(!["done", "cancelled", "in_review"].includes(source.status), "Source is terminal or awaiting review; no automatic resume");
    const assignee = await request(`/agents/${manifest.assigneeAgentId}`);
    requireThat(assignee.companyId === manifest.companyId, "Assignee belongs to another company");
    // Match shared/agent-eligibility.ts: error is retryable, unlike pause/termination.
    // Full reporting-chain/budget/admission eligibility remains the server's decision.
    requireThat(["idle", "active", "running", "error"].includes(assignee.status), "Assignee is not invokable; owner must resolve the gate");
    // Attachment metadata proves tenancy; content proves the frozen bytes. Never follow redirects with credentials.
    const attachments = await request(`/issues/${source.id}/attachments`);
    for (const artifact of manifest.artifacts) {
      const metadata = attachments.find((item) => item.id === artifact.attachmentId);
      requireThat(metadata?.companyId === manifest.companyId && metadata.issueId === source.id,
        "Artifact must belong to this source issue and company");
      const response = await fetcher(`${api.origin}/api/attachments/${artifact.attachmentId}/content`, {
        redirect: "error", signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${apiKey}` },
      });
      requireThat(response.ok, `Artifact content HTTP ${response.status}`);
      requireThat(hash(Buffer.from(await response.arrayBuffer())) === artifact.sha256, "Artifact SHA256 mismatch");
    }
    save();
    const prefix = source.identifier?.split("-")[0];
    requireThat(/^[A-Z0-9]+$/.test(prefix), "Issue prefix required");
    const link = (issue) => `[${issue.identifier}](/${prefix}/issues/${issue.identifier})`;
    const inputs = manifest.artifacts.map((artifact) =>
      `- [${artifact.attachmentId}](/api/attachments/${artifact.attachmentId}/content) SHA256 ${artifact.sha256}`).join("\n");
    const common = `Source: ${link(source)}\n\n${manifest.instructions}\n\nFrozen inputs:\n${inputs}\n\n`
      + `Manifest SHA256: ${digest}\n\nIndependent review is required before integration. Preserve all approval, budget, pause and actor boundaries. `
      + "No Stage/Replay/Paper/Live, baseline/LIVE_REAL or real routing changes.\n";
    const ensureIssue = async (stage, fields) => {
      const marker = `release-handoff:${manifest.sourceIssueId}:${manifest.handoffKey}:${stage}`;
      const description = `${common}\n${fields.description ?? ""}\n\n${marker}\n`;
      const verify = (issue) => {
        requireThat(issue.companyId === manifest.companyId && issue.projectId === manifest.projectId
          && issue.parentId === source.id && issue.assigneeAgentId === manifest.assigneeAgentId
          && !issue.assigneeUserId && issue.description === description, "Handoff issue identity or frozen inputs changed");
        return issue;
      };
      if (state.stages[stage]?.id) return verify(await scopedIssue(state.stages[stage].id));
      // Search reconciles a create whose successful response was lost before journal commit.
      const matches = (await request(`/companies/${manifest.companyId}/issues?q=${encodeURIComponent(marker)}`))
        .filter((issue) => issue.description?.includes(marker));
      requireThat(matches.length <= 1, "Duplicate handoff marker; owner must reconcile");
      if (matches.length === 1) {
        const issue = verify(await scopedIssue(matches[0].id));
        state.stages[stage] = { id: issue.id, reconciled: true };
        save();
        return issue;
      }
      requireThat(!state.stages[stage], "Prior create is uncertain or rejected; owner must reconcile before retry");
      state.stages[stage] = { intent: true };
      save();
      let issue;
      try {
        issue = await request(`/companies/${manifest.companyId}/issues`, "POST", {
          title: fields.title, description, status: fields.status, priority: source.priority,
          projectId: manifest.projectId, goalId: source.goalId,
          parentId: source.id, assigneeAgentId: manifest.assigneeAgentId,
        });
      } catch (error) {
        state.stages[stage].errorStatus = error.status ?? "transport_unknown";
        save();
        throw error;
      }
      verify(issue);
      state.stages[stage] = { id: issue.id };
      save();
      return issue;
    };

    let deliverable;
    if (manifest.existingBacklogIssueId) {
      deliverable = await scopedIssue(manifest.existingBacklogIssueId);
      requireThat(deliverable.parentId === source.id && deliverable.assigneeAgentId === manifest.assigneeAgentId
        && !deliverable.assigneeUserId && (state.stages.adopted?.id === deliverable.id || deliverable.status === "backlog"),
      "Only the specified assigned backlog child can be adopted");
      state.stages.adopted = { id: deliverable.id };
      save();
    } else {
      deliverable = await ensureIssue("deliverable", {
        title: manifest.title, status: manifest.mode === "ready" ? "todo" : "backlog",
        description: manifest.mode === "ready" ? "Ready for execution using the frozen inputs above."
          : `Parked pending inputs:\n${manifest.missingInputs.map((item) => `- ${item}`).join("\n")}`,
      });
    }
    let next = deliverable;
    if (manifest.mode === "awaiting_inputs" && (deliverable.status === "backlog" || state.stages.activation)) {
      next = await ensureIssue("activation", {
        title: `Resolve inputs and activate: ${manifest.title}`, status: "todo",
        description: `You own ${link(deliverable)}. Resolve these missing inputs:\n`
          + manifest.missingInputs.map((item) => `- ${item}`).join("\n")
          + `\n\n${manifest.activationErrorStatus === 403 ? "Creator activation returned 403; do not retry as creator. " : ""}`
          + "Use your own authorized actor boundary to attach frozen inputs and explicitly activate that child when ready. "
          + "If a board gate is required, create a typed interaction and wait. Before closing this activation task, "
          + "record an actual queued/running child run ID, or complete/remove the obsolete blocker with evidence. "
          + "A todo status or comment alone is not dispatch proof. Do not complete this task while the child remains silently parked.",
      });
      if (next.status === "done" && deliverable.status !== "backlog") next = deliverable;
    }
    requireThat(deliverable.status !== "cancelled" && next.status !== "cancelled", "Cancelled handoff requires explicit owner disposition");
    const latest = await scopedIssue(source.id);
    requireThat(latest.status === source.status, "Source changed concurrently; owner must reconcile blockers");
    const blockers = new Set((latest.blockedBy ?? []).map((issue) => issue.id));
    if (deliverable.status !== "done") blockers.add(deliverable.id);
    if (next.status !== "done") blockers.add(next.id);
    if (blockers.size && (latest.status !== "blocked" || blockers.size !== (latest.blockedBy ?? []).length)) {
      // Only the source is updated; existing unrelated blocker relations are preserved.
      await request(`/issues/${source.id}`, "PATCH", { status: "blocked", blockedByIssueIds: [...blockers] });
    }
    // The live endpoint avoids materializing a large historical transcript list.
    // Its server cap is 50; absence remains unverified, never inferred as dispatch.
    const runs = await request(`/companies/${manifest.companyId}/live-runs?limit=50`);
    const observed = runs.find((run) => run.companyId === manifest.companyId && run.agentId === manifest.assigneeAgentId
      && (run.issueId ?? run.contextSnapshot?.issueId) === next.id && ["queued", "running"].includes(run.status));
    const completed = deliverable.status === "done" && next.status === "done";
    const receipt = {
      digest, deliverableIssueId: deliverable.id, nextIssueId: next.id, ownerAgentId: manifest.assigneeAgentId,
      observedAt: new Date().toISOString(),
      disposition: completed ? "completed" : observed ? "dispatch_observed" : "needs_owner_action",
      run: observed ? { id: observed.id, status: observed.status } : null,
      action: completed ? "Handoff completed; source owner retains review/integration and release gates"
        : observed ? "Await owned task completion through first-class blockers"
        : "Assignee must inspect task admission, pause/budget/approval gates and record queued/running run readback; no dispatch proven",
    };
    state.receipt = receipt;
    save();
    return receipt;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [manifestFile, stateDirectory, ...extra] = process.argv.slice(2);
    requireThat(manifestFile && stateDirectory && extra.length === 0,
      "Usage: node scripts/paperclip-release-handoff.mjs <manifest.json> <absolute-private-state-directory>");
    const receipt = await releaseHandoffOnce({ manifest: JSON.parse(fs.readFileSync(manifestFile, "utf8")),
      stateDirectory, apiUrl: process.env.PAPERCLIP_API_URL, apiKey: process.env.PAPERCLIP_API_KEY,
      runId: process.env.PAPERCLIP_RUN_ID });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.disposition === "needs_owner_action") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
