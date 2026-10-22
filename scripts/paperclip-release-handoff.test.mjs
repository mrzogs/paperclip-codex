import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { releaseHandoffOnce, validateManifest } from "./paperclip-release-handoff.mjs";

async function fixture(t, changes = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-handoff-"));
  const stateDirectory = path.join(directory, "state");
  const companyId = randomUUID(), projectId = randomUUID(), sourceIssueId = randomUUID(), assigneeAgentId = randomUUID();
  const bytes = Buffer.from("immutable review patch\n");
  const attachmentId = randomUUID();
  const manifest = { version: 1, flow: "vwap-release", companyId, projectId, sourceIssueId, assigneeAgentId,
    handoffKey: "independent-review", mode: "ready", title: "Review frozen patch", instructions: "Review and accept or reject.",
    artifacts: [{ attachmentId, sha256: createHash("sha256").update(bytes).digest("hex") }], ...changes };
  const source = { id: sourceIssueId, companyId, projectId, goalId: randomUUID(), identifier: "OCE-776",
    status: "in_progress", priority: "high", blockedBy: [] };
  const issues = new Map([[source.id, source]]);
  const calls = [], runs = [];
  const controls = { autoRun: true, dropCreate: false, createStatus: 201, artifactCompany: companyId,
    assigneeStatus: "idle", searchDuplicates: false, sourcePatchStatus: 200 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString();
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers,
      body: body ? JSON.parse(body) : undefined });
    const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && url.pathname === `/api/agents/${assigneeAgentId}`) {
      return json({ id: assigneeAgentId, companyId, status: controls.assigneeStatus });
    }
    if (req.method === "GET" && url.pathname === `/api/issues/${source.id}/attachments`) {
      return json([{ id: attachmentId, issueId: source.id, companyId: controls.artifactCompany }]);
    }
    if (url.pathname === `/api/attachments/${attachmentId}/content`) { res.end(bytes); return; }
    if (req.method === "GET" && url.pathname === `/api/companies/${companyId}/heartbeat-runs`) return json(runs);
    if (url.pathname === `/api/companies/${companyId}/issues`) {
      if (req.method === "GET") {
        const matches = [...issues.values()].filter((issue) => issue.description?.includes(url.searchParams.get("q")));
        return json(controls.searchDuplicates && matches.length ? [...matches, { ...matches[0], id: randomUUID() }] : matches);
      }
      if (controls.createStatus !== 201) return json({ error: "Outside actor boundary" }, controls.createStatus);
      const input = JSON.parse(body);
      const issue = { ...input, id: randomUUID(), companyId, identifier: `OCE-${776 + issues.size}`, blockedBy: [] };
      issues.set(issue.id, issue);
      if (controls.autoRun && issue.status === "todo") runs.push({ id: randomUUID(), companyId, agentId: assigneeAgentId,
        status: "queued", contextSnapshot: { issueId: issue.id } });
      if (controls.dropCreate) { controls.dropCreate = false; req.socket.destroy(); return; }
      return json(issue, 201);
    }
    const issue = issues.get(url.pathname.replace("/api/issues/", ""));
    if (issue) {
      if (req.method === "GET") return json(issue);
      if (issue.id !== source.id) return json({ error: "Issue is outside this actor's authorization boundary" }, 403);
      if (controls.sourcePatchStatus !== 200) return json({ error: "Outside actor boundary" }, controls.sourcePatchStatus);
      const input = JSON.parse(body);
      Object.assign(source, input, { blockedBy: input.blockedByIssueIds.map((id) => ({ id })) });
      return json(source);
    }
    return json({ error: "Unknown fixture route" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), "release-handoff-")));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const options = { manifest, stateDirectory, apiUrl, apiKey: "fixture-credential", runId: randomUUID() };
  const invoke = () => releaseHandoffOnce(options);
  const cli = async () => {
    const manifestFile = path.join(directory, "manifest.json");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const child = spawn(process.execPath, [fileURLToPath(new URL("./paperclip-release-handoff.mjs", import.meta.url)), manifestFile, stateDirectory], {
      env: { ...process.env, PAPERCLIP_API_URL: apiUrl, PAPERCLIP_API_KEY: options.apiKey, PAPERCLIP_RUN_ID: options.runId },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { exitCode, stdout, stderr, receipt: stdout ? JSON.parse(stdout) : null };
  };
  const creates = () => calls.filter((call) => call.method === "POST");
  const addBacklog = () => {
    const child = { id: randomUUID(), identifier: "OCE-772", companyId, projectId, parentId: source.id,
      assigneeAgentId, assigneeUserId: null, status: "backlog", description: "Legacy parked review" };
    issues.set(child.id, child);
    return child;
  };
  return { manifest, source, issues, calls, controls, runs, options, invoke, cli, creates, addBacklog, directory };
}

test("ready handoff carries immutable inputs and todo in the first POST, preserves unrelated blockers", async (t) => {
  const f = await fixture(t);
  const unrelated = randomUUID();
  f.source.blockedBy.push({ id: unrelated });
  const receipt = await f.invoke();
  assert.equal(receipt.disposition, "dispatch_observed");
  assert.equal(receipt.run.status, "queued");
  assert.equal(f.creates().length, 1);
  assert.equal(f.creates()[0].body.status, "todo");
  assert.ok(f.creates()[0].body.description.includes(f.manifest.artifacts[0].sha256));
  assert.ok(f.source.blockedBy.some((issue) => issue.id === unrelated));
  assert.ok(f.source.blockedBy.some((issue) => issue.id === receipt.deliverableIssueId));
  assert.ok(f.calls.filter((call) => call.method !== "GET").every((call) => call.headers["x-paperclip-run-id"] === f.options.runId));
  assert.deepEqual(f.calls.filter((call) => call.method === "PATCH").map((call) => call.path), [`/api/issues/${f.source.id}`]);
});

test("parked child gets one assignee-owned activation task with actual running readback", async (t) => {
  const f = await fixture(t, { mode: "awaiting_inputs", missingInputs: ["Upload classified test evidence"] });
  const receipt = await f.invoke();
  assert.deepEqual(f.creates().map((call) => call.body.status), ["backlog", "todo"]);
  assert.notEqual(receipt.nextIssueId, receipt.deliverableIssueId);
  assert.ok(f.source.blockedBy.some((issue) => issue.id === receipt.nextIssueId));
  f.runs[0].status = "running";
  const again = await f.invoke();
  assert.equal(again.run.status, "running");
  assert.equal(f.creates().length, 2);
});

test("cross-owner activation 403 routes to assignee, never retries PATCH or expands permissions", async (t) => {
  const f = await fixture(t, { mode: "awaiting_inputs", missingInputs: ["Frozen classification links"] });
  const child = f.addBacklog();
  const rejected = await fetch(`${f.options.apiUrl}/api/issues/${child.id}`, { method: "PATCH", body: JSON.stringify({ status: "todo" }) });
  assert.equal(rejected.status, 403);
  f.manifest.existingBacklogIssueId = child.id;
  f.manifest.activationErrorStatus = rejected.status;
  const receipt = await f.invoke();
  await f.invoke();
  assert.equal(receipt.deliverableIssueId, child.id);
  assert.equal(child.status, "backlog");
  assert.equal(f.creates().length, 1);
  assert.equal(f.creates()[0].body.assigneeAgentId, child.assigneeAgentId);
  assert.ok(f.creates()[0].body.description.includes("Creator activation returned 403"));
  assert.equal(f.calls.filter((call) => call.path === `/api/issues/${child.id}` && call.method === "PATCH").length, 1);
});

test("two fresh CLI processes retain identities and do not duplicate alert/recovery", async (t) => {
  const f = await fixture(t, { mode: "awaiting_inputs", missingInputs: ["Patch upload"] });
  const first = await f.cli(), second = await f.cli();
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(first.receipt.deliverableIssueId, second.receipt.deliverableIssueId);
  assert.equal(first.receipt.nextIssueId, second.receipt.nextIssueId);
  assert.equal(f.creates().length, 2);
  const saved = fs.readFileSync(path.join(f.options.stateDirectory, fs.readdirSync(f.options.stateDirectory)[0]), "utf8");
  assert.ok(!saved.includes(f.options.apiKey));
});

test("restart reconciles a committed create whose response was lost", async (t) => {
  const f = await fixture(t);
  f.controls.dropCreate = true;
  assert.equal((await f.cli()).exitCode, 1);
  const recovered = await f.cli();
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.equal(f.creates().length, 1);
  assert.equal(f.issues.size, 2);
});

test("403 on create is durable and cannot become repeated global escalation noise", async (t) => {
  const f = await fixture(t);
  f.controls.createStatus = 403;
  await assert.rejects(f.invoke(), /HTTP 403/);
  f.controls.createStatus = 201;
  await assert.rejects(f.invoke(), /uncertain or rejected/);
  assert.equal(f.creates().length, 1);
});

test("missing or historical/wrong-task runs never count as queued execution", async (t) => {
  const f = await fixture(t);
  f.controls.autoRun = false;
  const first = await f.cli();
  assert.equal(first.exitCode, 2);
  const common = { id: randomUUID(), companyId: f.manifest.companyId, agentId: f.manifest.assigneeAgentId,
    contextSnapshot: { issueId: first.receipt.nextIssueId } };
  f.runs.push({ ...common, status: "succeeded" }, { ...common, status: "running", agentId: randomUUID() },
    { ...common, status: "queued", companyId: randomUUID() }, { ...common, status: "running", contextSnapshot: { issueId: randomUUID() } });
  const again = await f.cli();
  assert.equal(again.exitCode, 2);
  assert.equal(again.receipt.run, null);
  assert.equal(f.creates().length, 1);
});

test("immutable manifest drift and issue description drift stop before new mutations", async (t) => {
  const f = await fixture(t);
  const first = await f.invoke();
  f.manifest.instructions = "Changed instructions";
  await assert.rejects(f.invoke(), /Immutable handoff changed/);
  f.manifest.instructions = "Review and accept or reject.";
  f.issues.get(first.deliverableIssueId).description += "changed";
  await assert.rejects(f.invoke(), /identity or frozen inputs changed/);
  assert.equal(f.creates().length, 1);
});

test("wrong company, wrong project, wrong artifact bytes and paused agent fail before creation", async (t) => {
  const f = await fixture(t);
  f.source.companyId = randomUUID();
  await assert.rejects(f.invoke(), /outside the manifest/);
  f.source.companyId = f.manifest.companyId;
  f.source.projectId = randomUUID();
  await assert.rejects(f.invoke(), /outside the manifest/);
  f.source.projectId = f.manifest.projectId;
  f.controls.artifactCompany = randomUUID();
  await assert.rejects(f.invoke(), /Artifact must belong/);
  f.controls.artifactCompany = f.manifest.companyId;
  f.manifest.artifacts[0].sha256 = "0".repeat(64);
  await assert.rejects(f.invoke(), /SHA256 mismatch/);
  f.controls.assigneeStatus = "paused";
  await assert.rejects(f.invoke(), /not invokable/);
  assert.equal(f.creates().length, 0);
});

test("duplicate reconciliation markers fail closed", async (t) => {
  const f = await fixture(t);
  f.controls.dropCreate = true;
  await assert.rejects(f.invoke());
  f.controls.searchDuplicates = true;
  await assert.rejects(f.invoke(), /Duplicate handoff marker/);
  assert.equal(f.creates().length, 1);
});

test("source mutation 403 is surfaced, never retried using board identity", async (t) => {
  const f = await fixture(t);
  f.controls.sourcePatchStatus = 403;
  await assert.rejects(f.invoke(), /HTTP 403: PATCH/);
  assert.equal(f.creates().length, 1);
  assert.equal(f.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("no source review/terminal resumption or cancelled-child replacement", async (t) => {
  const f = await fixture(t);
  for (const status of ["in_review", "done", "cancelled"]) {
    f.source.status = status;
    await assert.rejects(f.invoke(), /no automatic resume/);
  }
  f.source.status = "in_progress";
  const receipt = await f.invoke();
  f.issues.get(receipt.deliverableIssueId).status = "cancelled";
  await assert.rejects(f.invoke(), /Cancelled handoff/);
  assert.equal(f.creates().length, 1);
});

test("adopted handoff survives authorized activation without silently promoting child", async (t) => {
  const f = await fixture(t, { mode: "awaiting_inputs", missingInputs: ["Upload"] });
  const child = f.addBacklog();
  f.manifest.existingBacklogIssueId = child.id;
  const first = await f.invoke();
  child.status = "todo"; // Authorized assignee action, outside helper.
  f.issues.get(first.nextIssueId).status = "done";
  f.runs.push({ id: randomUUID(), companyId: child.companyId, agentId: child.assigneeAgentId,
    status: "running", contextSnapshot: { issueId: child.id } });
  const next = await f.invoke();
  assert.equal(next.nextIssueId, child.id);
  assert.equal(next.run.status, "running");
  assert.equal(f.creates().length, 1);
});

test("journal lock excludes concurrent writers and state cannot be stored under Git", async (t) => {
  const f = await fixture(t);
  await f.invoke();
  const journal = fs.readdirSync(f.options.stateDirectory)[0];
  const lock = path.join(f.options.stateDirectory, `${journal}.lock`);
  fs.writeFileSync(lock, "other writer");
  await assert.rejects(f.invoke(), /EEXIST/);
  assert.equal(fs.readFileSync(lock, "utf8"), "other writer");
  fs.mkdirSync(path.join(f.directory, ".git"));
  await assert.rejects(f.invoke(), /outside a Git checkout/);
});

test("invalid ready manifests require frozen inputs and cannot hide parked work", () => {
  assert.throws(() => validateManifest({ version: 1, flow: "other" }), /VWAP release/);
});
