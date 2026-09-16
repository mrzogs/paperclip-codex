import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WorkflowBackend, TABLE, workflowFromEnvironment } from "./backend.mjs";
import { WorkflowStore } from "./store.mjs";
import { issueOceanIdentity, issueTestBrowserSecret } from "./auth.mjs";
import { digest, objectHash, sealedHash } from "./common.mjs";

const examples = JSON.parse(fs.readFileSync(new URL("./contracts/2.1.0/shared-contracts/examples/positive-examples.json", import.meta.url), "utf8"));
const STRATEGY = "vwap_wave_pullback_balanced_nasdaq_v0434";
const INSTANCE = "test-s20-instance";
const EVIDENCE_TYPES = ["BACKTEST", "ROBUSTNESS", "WALK_FORWARD", "OOS_HOLDOUT"];
const results = [];
let sequence = 0;
const nextId = (kind) => `test-${kind}-${++sequence}`;
const clone = (value) => structuredClone(value);

async function app(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.OCEAN_S20_PRIVATE_DIR || os.tmpdir(), "ocean-s20-"));
  const environment = {};
  const server = http.createServer((request, response) => void backend.handle(request, response, new URL(request.url, `http://${request.headers.host}`)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    db_file: path.join(directory, "ocean-workflow-test.sqlite"), test_only: true, contract_release: "2.1.0", allowed_origins: [base], lease_ms: 30000,
    python_executable: process.env.OCEAN_TRADING_PYTHON || "python", browser: { subject_id: "wayne-ocean-ui", credential_ref: "OCEAN_WAYNE_BROWSER_SECRET" },
    identities: ["BRAIN", "TELEMETRY", "STRATEGY"].map((role) => issueOceanIdentity({ identity_id: `ocean-test-${role.toLowerCase()}`, role, namespace: "TEST", credential_ref: `OCEAN_${role}_TOKEN`, strategy_ids: [STRATEGY], instance_ids: [INSTANCE] }, environment, new Date(Date.now() + 3600000).toISOString())), ...overrides,
  };
  issueTestBrowserSecret(environment, config.browser.credential_ref);
  let backend = new WorkflowBackend(config, environment);
  const tokens = Object.values(environment);
  async function fetchJson(route, { role = "HUMAN", data, messageId = nextId("message"), rawBody, headers = {}, method = data === undefined && rawBody === undefined ? "GET" : "POST" } = {}) {
    const requestHeaders = { ...headers };
    if (role === "HUMAN") {
      Object.assign(requestHeaders, { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf });
      Object.assign(requestHeaders, headers);
    } else if (role) requestHeaders.Authorization = `Bearer ${environment[`OCEAN_${role}_TOKEN`]}`;
    if (method === "POST") requestHeaders["Content-Type"] ||= "application/json";
    const response = await fetch(`${base}/api/workflow/${route}`, { method, headers: requestHeaders, body: rawBody ?? (data === undefined ? undefined : JSON.stringify({ message_id: messageId, data })), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert.ok(tokens.every((token) => !text.includes(token)), "response must never expose issued credential values");
    return { status: response.status, value: JSON.parse(text), headers: response.headers };
  }
  const login = await fetch(`${base}/api/workflow/session`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ credential: environment.OCEAN_WAYNE_BROWSER_SECRET }) });
  assert.equal(login.status, 200); const session = await login.json(); const csrf = session.csrf_token; const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const profile = { ...clone(examples["strategy-profile"]), strategy_id: STRATEGY, profile_id: "test-s20-profile" };
  profile.profile_hash = sealedHash(profile, "profile_hash");
  const registry = { ...clone(examples["strategy-registry"]), strategy_id: STRATEGY, profile_id: profile.profile_id, profile_version: profile.profile_version, profile_hash: profile.profile_hash, activation_status: "PENDING_ONBOARDING", activation_decision_id: null, production_version: null, execution_instances: [] };
  const instance = { execution_instance_id: INSTANCE, strategy_id: STRATEGY, source_installation_id: "test-s20-installation", chartbook_id: "test-s20-chartbook", chart_id: "test-s20-chart", source_study_instance_id: "test-s20-study", telemetry_producer_id: "ocean-test-telemetry", version_binding: profile.baseline_version, config_hash: profile.strategy_config_hash, account_alias: "Sim1", capabilities: ["REPLAY"], status: "DRAFT", lease_run_id: null };
  const dataset = { ...clone(examples["dataset-manifest"]), dataset_manifest_id: "test-s20-dataset" };
  dataset.manifest_hash = sealedHash(dataset, "manifest_hash");
  const post = async (route, data, options = {}) => { const result = await fetchJson(route, { data, ...options }); assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.value)}`); return result.value; };
  await post("profiles", { profile, file_sha256: digest(JSON.stringify(profile)) });
  await post("strategies", { registry, baseline_hash: profile.strategy_code_hash });
  await post("instances", { strategy_id: STRATEGY, instance });
  await post("datasets", { strategy_id: STRATEGY, manifest: dataset });
  const contextInput = { ...clone(examples["run-context"]), strategy_id: STRATEGY, run_id: "test-s20-run", execution_instance_id: INSTANCE, source_installation_id: instance.source_installation_id, strategy_version: instance.version_binding, strategy_code_hash: profile.strategy_code_hash, strategy_config_hash: instance.config_hash, strategy_profile_id: profile.profile_id, strategy_profile_version: profile.profile_version, dataset_manifest_id: dataset.dataset_manifest_id, dataset_manifest_revision: dataset.revision, dataset_manifest_hash: dataset.manifest_hash, expected_environment: "REPLAY", evidence_purpose: "NOT_ELIGIBLE", historical_build_mode: null };
  delete contextInput.learner_permission; delete contextInput.permission_reason; delete contextInput.context_hash;
  const run = await post("runs", { context: contextInput });
  let caseSequence = 0;
  const newCase = async () => post("cases", { case_id: `test-case-${++caseSequence}`, run_id: run.context.run_id });
  const getCase = async (caseId) => (await fetchJson(`cases/${caseId}`)).value;
  const change = async (caseId, fields, role = "HUMAN") => post("transitions", { case_id: caseId, expected_revision: (await getCase(caseId)).revision, ...fields }, { role });
  const artifact = async (caseId, kind, fields = {}, role = "BRAIN") => {
    const row = await getCase(caseId);
    const content = fields.content || JSON.stringify({ kind, status: "PASS", candidate_hash: row.candidate_hash, ...fields.payload });
    const data = { artifact_id: nextId("artifact"), case_id: caseId, run_id: run.context.run_id, recipient_id: "ocean-test-strategy", kind, media_type: "application/json", content, content_hash: digest(content), candidate_hash: row.candidate_hash, dependency_ids: [], ...fields };
    delete data.payload;
    return post("artifacts", data, { role });
  };
  const reviewCase = async () => {
    const row = await newCase(); await change(row.case_id, { action: "advance", to_stage: "EVIDENCE" });
    const evidence = await artifact(row.case_id, "EVIDENCE"); await change(row.case_id, { action: "advance", to_stage: "RESEARCH", artifact_id: evidence.manifest.artifact_id });
    const recommendation = await artifact(row.case_id, "RECOMMENDATION"); await change(row.case_id, { action: "advance", to_stage: "DEVELOPMENT_REVIEW", artifact_id: recommendation.manifest.artifact_id });
    return { row: await getCase(row.case_id), recommendation };
  };
  const requestApproval = async (caseId, artifactId, gate = "DEVELOPMENT", expiry = new Date(Date.now() + 3600000).toISOString()) => post("approvals", { request_id: nextId("request"), case_id: caseId, expected_revision: (await getCase(caseId)).revision, gate, artifact_id: artifactId, recipient_id: "ocean-test-strategy", authorized_tests: EVIDENCE_TYPES, expires_at_utc: expiry }, { role: "BRAIN" });
  const decide = async (request, action = "APPROVED", options = {}) => post("decisions", { decision_id: nextId("decision"), case_id: request.case_id, request_id: request.request_id, expected_revision: (await getCase(request.case_id)).revision, snapshot_hash: request.snapshot_hash, decision: action, reason: "S20 synthetic acceptance; no operational approval", ...options });
  return { base, server, environment, config, backend: () => backend, fetchJson, post, profile, registry, instance, dataset, contextInput, run, newCase, getCase, change, artifact, reviewCase, requestApproval, decide,
    restart: () => { backend.close(); backend = new WorkflowBackend(config, environment); },
    close: async () => { await new Promise((resolve) => server.close(resolve)); backend.close(); }, directory };
}

async function check(name, action) {
  const started = Date.now();
  await test(name, { timeout: 120000 }, async () => {
    try { await action(); results.push({ name, status: "PASS", elapsed_ms: Date.now() - started, type: "ACTUAL_ISOLATED_NODE_HTTP_SQLITE_RUNTIME_WITH_SYNTHETIC_TEST_DATA" }); }
    catch (error) { results.push({ name, status: "FAILED", error: error.message, type: "ACTUAL_ISOLATED_RUNTIME" }); throw error; }
  });
}

await check("GOV-01 CFG-02: authentication failures, role separation, browser CSRF/origin and no token responses", async () => {
  const a = await app();
  try {
    assert.equal((await a.fetchJson("status", { role: null, headers: { Host: new URL(a.base).host } })).status, 401);
    for (const token of ["invalid", "brain-general-credential", "ocean_service_v1.ocean-test-brain.forged", a.environment.OCEAN_WAYNE_BROWSER_SECRET]) {
      const response = await fetch(`${a.base}/api/workflow/status`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(response.status, 401);
    }
    assert.equal((await a.fetchJson("status", { role: "BRAIN", headers: { "x-role": "HUMAN" } })).status, 403);
    assert.equal((await a.fetchJson("status", { role: "BRAIN", headers: { Origin: a.base } })).status, 403);
    assert.equal((await a.fetchJson("cases", { data: { case_id: "test-forged", run_id: a.run.context.run_id }, headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    assert.equal((await a.fetchJson("cases", { data: { case_id: "test-cross-site", run_id: a.run.context.run_id }, headers: { Origin: "https://attacker.invalid" } })).status, 403);
    const review = await a.reviewCase(); const request = await a.requestApproval(review.row.case_id, review.recommendation.manifest.artifact_id);
    for (const role of ["BRAIN", "TELEMETRY", "STRATEGY"]) assert.equal((await a.fetchJson("decisions", { role, data: { request_id: request.request_id, decision_by: "Wayne" } })).status, 403);
    assert.equal((await a.fetchJson("decisions", { data: { decision_by: "Wayne" } })).status, 422);
    const token = a.config.identities.find((entry) => entry.role === "BRAIN"); token.expires_at_utc = "2000-01-01T00:00:00Z";
    a.backend().db.prepare("UPDATE ow_identities SET metadata_json=? WHERE id=?").run(JSON.stringify(token), token.identity_id);
    assert.equal((await a.fetchJson("status", { role: "BRAIN" })).status, 401);
    token.expires_at_utc = new Date(Date.now()+3600000).toISOString(); token.revoked = true; a.backend().db.prepare("UPDATE ow_identities SET metadata_json=? WHERE id=?").run(JSON.stringify(token), token.identity_id);
    assert.equal((await a.fetchJson("status", { role: "BRAIN" })).status, 401);
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_decisions").get().n, 0);
  } finally { await a.close(); }
});

await check("GOV-01 GOV-09: exact strategy/instance/recipient restrictions and unsafe artifacts", async () => {
  const a = await app();
  try {
    const row = await a.newCase(); const art = await a.artifact(row.case_id, "EVIDENCE");
    assert.equal((await a.fetchJson(`artifacts/${art.manifest.artifact_id}/download`, { role: "TELEMETRY" })).status, 403);
    const identity = a.config.identities.find((entry) => entry.role === "BRAIN"); identity.strategy_ids = ["unrelated-strategy"];
    a.backend().db.prepare("UPDATE ow_identities SET metadata_json=? WHERE id=?").run(JSON.stringify(identity), identity.identity_id);
    assert.equal((await a.fetchJson(`cases/${row.case_id}`, { role: "BRAIN" })).status, 403);
    identity.strategy_ids = [STRATEGY]; identity.instance_ids = ["test-another-instance"]; a.backend().db.prepare("UPDATE ow_identities SET metadata_json=? WHERE id=?").run(JSON.stringify(identity), identity.identity_id);
    assert.equal((await a.fetchJson(`cases/${row.case_id}`, { role: "BRAIN" })).status, 403);
    for (const [media, content] of [["text/html", "<script>alert(1)</script>"], ["text/markdown", "[bad](javascript:alert(1))"], ["text/plain", a.environment.OCEAN_STRATEGY_TOKEN]]) {
      const r = await a.fetchJson("artifacts", { data: { artifact_id: nextId("bad"), case_id: row.case_id, run_id: a.run.context.run_id, recipient_id: "ocean-test-strategy", kind: "EVIDENCE", media_type: media, content, content_hash: digest(content), dependency_ids: [] } }); assert.equal(r.status, 422);
    }
    assert.equal((await a.fetchJson("artifacts", { rawBody: "x".repeat(300000) })).status, 413);
    assert.equal((await a.fetchJson("artifacts", { rawBody: "not-json" })).status, 400);
    assert.equal((await a.fetchJson(`artifacts/${art.manifest.artifact_id}?path=D:/private`, {})).status, 400);
    const response = await fetch(`${a.base}/api/workflow/artifacts/${art.manifest.artifact_id}/download`, { headers: { Authorization: `Bearer ${a.environment.OCEAN_STRATEGY_TOKEN}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/octet-stream"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_artifacts").get().n, 1);
  } finally { await a.close(); }
});

await check("GOV-02 GOV-03 GOV-04: immutable approval binding, duplicate/concurrent clicks and no automatic candidate", async () => {
  const a = await app();
  try {
    const review = await a.reviewCase(); const request = await a.requestApproval(review.row.case_id, review.recommendation.manifest.artifact_id);
    assert.equal((await a.getCase(review.row.case_id)).stage, "DEVELOPMENT_REVIEW");
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_handoffs").get().n, 0);
    const decisionData = { decision_id: "test-idempotent-decision", case_id: request.case_id, request_id: request.request_id, expected_revision: (await a.getCase(request.case_id)).revision, snapshot_hash: request.snapshot_hash, decision: "APPROVED", reason: "Synthetic test" };
    const [one, two] = await Promise.all([a.fetchJson("decisions", { data: decisionData, messageId: "test-idempotent-message" }), a.fetchJson("decisions", { data: decisionData, messageId: "test-idempotent-message" })]);
    assert.equal(one.status, 200); assert.equal(two.status, 200); assert.deepEqual(one.value, two.value);
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_decisions").get().n, 1);
    const conflict = await a.fetchJson("decisions", { data: { ...decisionData, decision: "REJECTED" }, messageId: "test-idempotent-message" }); assert.equal(conflict.status, 409);
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_quarantine").get().n, 1);
    assert.throws(() => a.backend().db.prepare("UPDATE ow_decisions SET payload_json='{}'").run(), /immutable/);
    assert.throws(() => a.backend().db.prepare("DELETE FROM ow_artifacts").run(), /immutable/);
    assert.equal((await a.getCase(request.case_id)).stage, "DEVELOPMENT_REVIEW");
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_artifacts WHERE kind='CANDIDATE'").get().n, 0);
    await a.post("revocations", { decision_id: "test-idempotent-decision", reason: "Synthetic revocation" });
    assert.equal((await a.fetchJson("transitions", { data: { case_id: request.case_id, expected_revision: (await a.getCase(request.case_id)).revision, action: "advance", to_stage: "DEVELOPMENT_HANDOFF", decision_id: "test-idempotent-decision" } })).status, 409);
    const b = await a.reviewCase(); const request2 = await a.requestApproval(b.row.case_id, b.recommendation.manifest.artifact_id);
    const badCase = await a.newCase();
    assert.equal((await a.fetchJson("decisions", { data: { ...decisionData, decision_id: nextId("decision"), case_id: badCase.case_id, request_id: request2.request_id, expected_revision: badCase.revision, snapshot_hash: request2.snapshot_hash } })).status, 409);
    assert.equal((await a.fetchJson("decisions", { data: { ...decisionData, decision_id: nextId("decision"), case_id: request2.case_id, request_id: request2.request_id, expected_revision: (await a.getCase(request2.case_id)).revision, snapshot_hash: digest("tampered") } })).status, 409);
  } finally { await a.close(); }
});

await check("GOV-06: reject/more-evidence, unchanged resubmission, pause/resume, failure, blocker and cancellation history", async () => {
  const a = await app();
  try {
    const review = await a.reviewCase(); const request = await a.requestApproval(review.row.case_id, review.recommendation.manifest.artifact_id);
    await a.decide(request, "MORE_EVIDENCE"); assert.equal((await a.getCase(request.case_id)).stage, "RESEARCH");
    await a.change(request.case_id, { action: "advance", to_stage: "DEVELOPMENT_REVIEW", artifact_id: review.recommendation.manifest.artifact_id });
    assert.equal((await a.fetchJson("approvals", { role: "BRAIN", data: { request_id: nextId("request"), case_id: request.case_id, expected_revision: (await a.getCase(request.case_id)).revision, gate: "DEVELOPMENT", artifact_id: review.recommendation.manifest.artifact_id, recipient_id: "ocean-test-strategy", authorized_tests: EVIDENCE_TYPES, expires_at_utc: new Date(Date.now()+3600000).toISOString() } })).status, 409);
    const newer = await a.artifact(request.case_id, "RECOMMENDATION", { payload: { additional_evidence: true } }); const request2 = await a.requestApproval(request.case_id, newer.manifest.artifact_id); await a.decide(request2, "REJECTED"); assert.equal((await a.getCase(request.case_id)).stage, "RETROSPECTIVE");
    const c = await a.newCase(); await a.change(c.case_id, { action: "pause" }); assert.equal((await a.getCase(c.case_id)).stage, "DISCOVERY");
    assert.equal((await a.fetchJson("transitions", { role: "BRAIN", data: { case_id: c.case_id, expected_revision: (await a.getCase(c.case_id)).revision, action: "advance", to_stage: "EVIDENCE" } })).status, 409);
    await a.change(c.case_id, { action: "resume" }); await a.change(c.case_id, { action: "fail" }, "BRAIN"); await a.change(c.case_id, { action: "retry" });
    await a.change(c.case_id, { action: "block", owner_id: "ocean-test-brain", next_action: "Synthetic evidence retry" }, "BRAIN"); assert.equal((await a.getCase(c.case_id)).blockers.length, 1);
    await a.change(c.case_id, { action: "retry" }); await a.change(c.case_id, { action: "cancel" }); assert.equal((await a.getCase(c.case_id)).work_status, "CANCELLED");
    assert.ok(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_events WHERE entity_id=?").get(c.case_id).n >= 8);
    const stale = await a.newCase(); await a.change(stale.case_id, { action: "pause" }); const registry = { ...a.registry, registry_revision: 2 };
    await a.post("strategies", { registry, baseline_hash: a.profile.strategy_code_hash, expected_revision: 1 });
    assert.equal((await a.fetchJson("transitions", { data: { case_id: stale.case_id, expected_revision: (await a.getCase(stale.case_id)).revision, action: "resume" } })).status, 409);
  } finally { await a.close(); }
});

await check("GOV-02 GOV-06: normal stages enforce independent gates, named reports and real recipient acknowledgement", async () => {
  const a = await app();
  try {
    const review = await a.reviewCase(); const c = review.row.case_id; const request = await a.requestApproval(c, review.recommendation.manifest.artifact_id); const decision = await a.decide(request);
    await a.change(c, { action: "advance", to_stage: "DEVELOPMENT_HANDOFF", decision_id: decision.decision_id });
    const handoff = await a.post("handoffs", { handoff_id: nextId("handoff"), case_id: c, decision_id: decision.decision_id, gate: "DEVELOPMENT", recipient_id: "ocean-test-strategy", authorized_test: "BACKTEST" });
    await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 1, state: "READY" }); await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 2, state: "DISPATCHED" });
    await a.fetchJson(`artifacts/${review.recommendation.manifest.artifact_id}/download`, { role: "STRATEGY" });
    assert.equal((await a.fetchJson("transitions", { role: "STRATEGY", data: { case_id: c, expected_revision: (await a.getCase(c)).revision, action: "advance", to_stage: "CANDIDATE_DEVELOPMENT" } })).status, 409);
    assert.equal((await a.fetchJson("handoff-events", { data: { handoff_id: handoff.handoff_id, expected_revision: 3, state: "ACKNOWLEDGED" } })).status, 403);
    await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 3, state: "ACKNOWLEDGED" }, { role: "STRATEGY" });
    await a.change(c, { action: "advance", to_stage: "CANDIDATE_DEVELOPMENT" }, "STRATEGY");
    const candidate = await a.artifact(c, "CANDIDATE", { candidate_hash: digest("synthetic candidate"), dependency_ids: [review.recommendation.manifest.artifact_id] }, "STRATEGY");
    await a.change(c, { action: "advance", to_stage: "HISTORICAL_VALIDATION", artifact_id: candidate.manifest.artifact_id }, "STRATEGY");
    assert.equal((await a.fetchJson("transitions", { role: "STRATEGY", data: { case_id: c, expected_revision: (await a.getCase(c)).revision, action: "advance", to_stage: "CANDIDATE_EVALUATION" } })).status, 409);
    for (const kind of EVIDENCE_TYPES) { const report = await a.artifact(c, kind, {}, "STRATEGY"); await a.post("tasks", { case_id: c, expected_revision: (await a.getCase(c)).revision, kind, status: "PASS", artifact_id: report.manifest.artifact_id }, { role: "STRATEGY" }); }
    await a.change(c, { action: "advance", to_stage: "CANDIDATE_EVALUATION" }, "STRATEGY"); const evaluation = await a.artifact(c, "EVALUATION"); await a.change(c, { action: "advance", to_stage: "SHADOW_REVIEW", artifact_id: evaluation.manifest.artifact_id }, "BRAIN");
    assert.equal((await a.fetchJson("transitions", { data: { case_id: c, expected_revision: (await a.getCase(c)).revision, action: "advance", to_stage: "SHADOW_HANDOFF", decision_id: decision.decision_id } })).status, 409);
    const shadow = await a.requestApproval(c, evaluation.manifest.artifact_id, "SHADOW"); const shadowDecision = await a.decide(shadow); await a.change(c, { action: "advance", to_stage: "SHADOW_HANDOFF", decision_id: shadowDecision.decision_id });
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_runs WHERE state='ACTIVE'").get().n, 0);
  } finally { await a.close(); }
});

await check("GOV-08: transactional outbox survives restart, expired leases, duplicate ack and outage retry", async () => {
  const a = await app({ lease_ms: 500 });
  try {
    const review = await a.reviewCase(); const request = await a.requestApproval(review.row.case_id, review.recommendation.manifest.artifact_id); await a.decide(request);
    const claimed = await a.post("outbox/claim", { strategy_id: STRATEGY, instance_id: INSTANCE }, { role: "STRATEGY" }); assert.equal(claimed.items.length, 1); const first = claimed.items[0];
    a.restart(); await new Promise((resolve) => setTimeout(resolve, 600)); const recovered = await a.post("outbox/claim", { strategy_id: STRATEGY, instance_id: INSTANCE }, { role: "STRATEGY" }); const second = recovered.items[0];
    assert.equal(second.outbox_id, first.outbox_id); assert.notEqual(second.lease_id, first.lease_id);
    assert.equal((await a.fetchJson("outbox/ack", { role: "STRATEGY", data: { outbox_id: first.outbox_id, lease_id: first.lease_id, payload_hash: first.payload_hash } })).status, 409);
    const failed = await a.post("outbox/fail", { outbox_id: second.outbox_id, lease_id: second.lease_id, payload_hash: second.payload_hash, error: "Synthetic recipient outage" }, { role: "STRATEGY" }); assert.equal(failed.state, "FAILED");
    await a.post("outbox/retry", { outbox_id: second.outbox_id }); const third = (await a.post("outbox/claim", { strategy_id: STRATEGY, instance_id: INSTANCE }, { role: "STRATEGY" })).items[0];
    const data = { outbox_id: third.outbox_id, lease_id: third.lease_id, payload_hash: third.payload_hash }; const messageId = nextId("ack-message");
    const one = await a.fetchJson("outbox/ack", { role: "STRATEGY", data, messageId }); const two = await a.fetchJson("outbox/ack", { role: "STRATEGY", data, messageId }); assert.equal(one.status, 200); assert.deepEqual(one.value, two.value);
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_outbox WHERE state='ACKNOWLEDGED'").get().n, 1);
  } finally { await a.close(); }
});

await check("CFG-02 CFG-04: imported contracts validate, pending plan is not runtime authority, identity preserved and migration rollback", async () => {
  const a = await app();
  try {
    assert.equal(a.registry.strategy_id, STRATEGY);
    assert.equal((await a.fetchJson("runs", { data: { context: { ...a.contextInput, run_id: nextId("run"), learner_permission: "SCOPED_LEARNING" } } })).status, 422);
    assert.equal((await a.fetchJson("runs", { data: { context: { ...a.contextInput, run_id: nextId("run"), expected_environment: "LIVE_REAL" } } })).status, 403);
    if (process.env.OCEAN_S20_PLAN_FILE) {
      const manifest = JSON.parse(fs.readFileSync(process.env.OCEAN_S20_PLAN_FILE, "utf8")); const result = await a.post("dataset-plans", { strategy_id: STRATEGY, manifest }); assert.equal(result.runtime_eligible, false);
      assert.equal((await a.fetchJson("datasets", { data: { strategy_id: STRATEGY, manifest } })).status, 422);
    } else assert.fail("Verified S19 pending plan is required for this acceptance suite");
    assert.equal(workflowFromEnvironment({}, "python"), null);
    assert.throws(() => workflowFromEnvironment({ OCEAN_WORKFLOW_ENABLED: "1" }, "python"), /WORKFLOW_CONFIG_REFERENCE_REQUIRED/);
    const empty = new WorkflowStore(path.join(a.directory, "empty.sqlite")); empty.revertEmptyMigration(); assert.equal(empty.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'ow_%'").get().n, 0); empty.close();
    assert.throws(() => a.backend().store.revertEmptyMigration(), /POPULATED_WORKFLOW/);
    const receipt = { task_id: "S13", final_status: "PASS", status_scope: "construction-time intake" }; const content_hash = objectHash(receipt);
    const setup = await a.post("setup-receipts", { receipt_id: "S13-TEST-REGISTRATION", receipt, content_hash }); assert.equal(setup.classification, "HISTORICAL_SETUP_NOT_APPROVAL");
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_decisions").get().n, 0);
  } finally { await a.close(); }
});

await check("GOV-02 GOV-06 GOV-09: remaining normal/rollback paths, immutable approved MD and recipient lifecycle", async () => {
  const a = await app();
  try {
    const review = await a.reviewCase(); const c = review.row.case_id;
    async function handoffGate(gate, artifactId, toStage) {
      const request = await a.requestApproval(c, artifactId, gate); const decision = await a.decide(request);
      await a.change(c, { action: "advance", to_stage: toStage, decision_id: decision.decision_id });
      const handoff = await a.post("handoffs", { handoff_id: nextId("handoff"), case_id: c, decision_id: decision.decision_id, gate, recipient_id: "ocean-test-strategy", authorized_test: "BACKTEST" });
      assert.equal((await a.fetchJson("handoffs", { data: { handoff_id: nextId("wrong-recipient"), case_id: c, decision_id: decision.decision_id, gate, recipient_id: "ocean-test-brain", authorized_test: "BACKTEST" } })).status, 409);
      assert.equal((await a.fetchJson("handoffs", { data: { handoff_id: nextId("wrong-test"), case_id: c, decision_id: decision.decision_id, gate, recipient_id: "ocean-test-strategy", authorized_test: "UNAPPROVED_TEST" } })).status, 409);
      const downloaded = await fetch(`${a.base}/api/workflow/handoffs/${handoff.handoff_id}/download`, { headers: { Authorization: `Bearer ${a.environment.OCEAN_STRATEGY_TOKEN}` } });
      assert.equal(downloaded.status, 200); const md = await downloaded.text(); assert.match(md, /No actual candidate changes/); assert.ok(md.includes(decision.decision_id)); assert.ok(md.includes(request.snapshot_hash));
      assert.equal((await a.fetchJson(`handoffs/${handoff.handoff_id}`, { role: "STRATEGY" })).value.state, "CREATED");
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 1, state: "READY" });
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 2, state: "BLOCKED", reason: "Synthetic transport outage" }, { role: "STRATEGY" });
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 3, state: "READY" });
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 4, state: "DISPATCHED" });
      const ack = { handoff_id: handoff.handoff_id, expected_revision: 5, state: "ACKNOWLEDGED" }; const messageId = nextId("ack");
      const one = await a.post("handoff-events", ack, { role: "STRATEGY", messageId }); const two = await a.post("handoff-events", ack, { role: "STRATEGY", messageId }); assert.deepEqual(one, two);
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 6, state: "WORK_IN_PROGRESS" }, { role: "STRATEGY" });
      const result = await a.artifact(c, gate === "DEVELOPMENT" ? "RECOMMENDATION" : "VALIDATION_REPORT", {}, "STRATEGY");
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 7, state: "RESULT_RETURNED", result_artifact_id: result.manifest.artifact_id }, { role: "STRATEGY" });
      await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 8, state: "CLOSED" });
    }
    await handoffGate("DEVELOPMENT", review.recommendation.manifest.artifact_id, "DEVELOPMENT_HANDOFF");
    await a.change(c, { action: "advance", to_stage: "CANDIDATE_DEVELOPMENT" }, "STRATEGY");
    const candidate = await a.artifact(c, "CANDIDATE", { candidate_hash: digest("isolated candidate"), dependency_ids: [review.recommendation.manifest.artifact_id] }, "STRATEGY");
    await a.change(c, { action: "advance", to_stage: "HISTORICAL_VALIDATION", artifact_id: candidate.manifest.artifact_id }, "STRATEGY");
    for (const kind of EVIDENCE_TYPES) { const report = await a.artifact(c, kind, {}, "STRATEGY"); await a.post("tasks", { case_id: c, expected_revision: (await a.getCase(c)).revision, kind, status: "PASS", artifact_id: report.manifest.artifact_id }, { role: "STRATEGY" }); }
    await a.change(c, { action: "advance", to_stage: "CANDIDATE_EVALUATION" }, "STRATEGY");
    const evalReport = await a.artifact(c, "EVALUATION"); await a.change(c, { action: "advance", to_stage: "SHADOW_REVIEW", artifact_id: evalReport.manifest.artifact_id }, "BRAIN");
    await handoffGate("SHADOW", evalReport.manifest.artifact_id, "SHADOW_HANDOFF");
    await a.change(c, { action: "advance", to_stage: "FORWARD_VALIDATION" }, "STRATEGY"); const forward = await a.artifact(c, "FORWARD_RESULT", {}, "STRATEGY");
    await a.change(c, { action: "advance", to_stage: "FORWARD_EVALUATION", artifact_id: forward.manifest.artifact_id }, "STRATEGY"); const fe = await a.artifact(c, "FORWARD_EVALUATION");
    await a.change(c, { action: "advance", to_stage: "DEPLOYMENT_REVIEW", artifact_id: fe.manifest.artifact_id }, "BRAIN"); const plan = await a.artifact(c, "DEPLOYMENT_PLAN");
    await handoffGate("PRODUCTION", plan.manifest.artifact_id, "DEPLOYMENT_HANDOFF");
    await a.change(c, { action: "advance", to_stage: "POST_DEPLOYMENT_VALIDATION" }, "STRATEGY"); const validation = await a.artifact(c, "VALIDATION_REPORT", {}, "STRATEGY");
    const rollback = await a.artifact(c, "ROLLBACK_PLAN"); await a.change(c, { action: "rollback_review", artifact_id: rollback.manifest.artifact_id });
    await handoffGate("ROLLBACK", rollback.manifest.artifact_id, "ROLLBACK_HANDOFF"); await a.change(c, { action: "advance", to_stage: "POST_DEPLOYMENT_VALIDATION" }, "STRATEGY");
    await a.change(c, { action: "advance", to_stage: "RETROSPECTIVE", artifact_id: validation.manifest.artifact_id }, "STRATEGY");
    assert.equal((await a.fetchJson("transitions", { data: { case_id: c, expected_revision: (await a.getCase(c)).revision, action: "advance", to_stage: "CLOSED", artifact_ids: [validation.manifest.artifact_id] } })).status, 409);
    const outcome = await a.artifact(c, "OUTCOME"); const lesson = await a.artifact(c, "LESSON"); await a.change(c, { action: "advance", to_stage: "CLOSED", artifact_ids: [outcome.manifest.artifact_id, lesson.manifest.artifact_id] });
    assert.equal((await a.getCase(c)).work_status, "COMPLETED"); assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_runs WHERE state='ACTIVE'").get().n, 0);
  } finally { await a.close(); }
});

await check("CFG-02 GOV-08: exact run reservation/handshake/drain and reordered/idempotent versioned wire receipts", async () => {
  const a = await app();
  try {
    const runId = a.run.context.run_id;
    const handshake = { instance: a.instance, source_state: { observed_at_utc: new Date().toISOString(), environment: "REPLAY", simulation: true, replay: true, account_alias: "Sim1", source_schema_version: "7", quality: "VERIFIED" } };
    await a.post("run-events", { run_id: runId, expected_revision: 1, state: "READY" });
    const other = await a.post("runs", { context: { ...a.contextInput, run_id: "test-other-run" } });
    assert.equal((await a.fetchJson("run-events", { data: { run_id: other.context.run_id, expected_revision: 1, state: "READY" } })).status, 409);
    assert.equal((await a.fetchJson("run-events", { data: { run_id: runId, expected_revision: 2, state: "ACTIVE", observed_handshake: handshake } })).status, 403);
    assert.equal((await a.fetchJson("run-events", { role: "TELEMETRY", data: { run_id: runId, expected_revision: 2, state: "ACTIVE", observed_handshake: { ...handshake, instance: { ...a.instance, config_hash: digest("wrong") } } } })).status, 409);
    assert.equal((await a.fetchJson("run-events", { role: "TELEMETRY", data: { run_id: runId, expected_revision: 2, state: "ACTIVE", observed_handshake: { ...handshake, source_state: { ...handshake.source_state, environment: "LIVE_REAL" } } } })).status, 409);
    await a.post("run-events", { run_id: runId, expected_revision: 2, state: "ACTIVE", observed_handshake: handshake }, { role: "TELEMETRY" });
    const event = { ...clone(examples["workflow-event"]), ...a.run.context, event_id: "test-wire-event", producer_id: "ocean-test-telemetry", actor_role: "TELEMETRY", run_context_hash: a.run.context.context_hash, run_context_revision: a.run.context.revision, source_sequence: 20 };
    for (const key of Object.keys(a.run.context)) if (!(key in examples["workflow-event"])) delete event[key];
    event.payload_hash = sealedHash(event, "payload_hash");
    const result = await a.post("events", { run_id: runId, event }, { role: "TELEMETRY", messageId: "test-event-message" }); assert.equal(result.eligible, false); assert.equal(result.dispatch_state, "DISABLED");
    const retry = await a.post("events", { run_id: runId, event }, { role: "TELEMETRY", messageId: "test-event-new-message" }); assert.deepEqual(retry, result);
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_events WHERE action='event.write'").get().n, 1);
    const conflicting = { ...event, source_sequence: 21 }; conflicting.payload_hash = sealedHash(conflicting, "payload_hash");
    assert.equal((await a.fetchJson("events", { role: "TELEMETRY", data: { run_id: runId, event: conflicting } })).status, 409);
    const reordered = { ...event, event_id: "test-wire-earlier", source_sequence: 10 }; reordered.payload_hash = sealedHash(reordered, "payload_hash"); await a.post("events", { run_id: runId, event: reordered }, { role: "TELEMETRY" });
    assert.equal((await a.fetchJson(`runs/${runId}`, { role: "TELEMETRY" })).value.state, "ACTIVE", "wire claims never auto-advance run state");
    const wrongVersion = { ...event, event_id: nextId("bad-wire"), strategy_code_hash: digest("other") }; wrongVersion.payload_hash = sealedHash(wrongVersion, "payload_hash");
    assert.equal((await a.fetchJson("events", { role: "TELEMETRY", data: { run_id: runId, event: wrongVersion } })).status, 409);
    const wrongRelease = { ...event, event_id: nextId("bad-release"), schema_version: "2.0.0" }; wrongRelease.payload_hash = sealedHash(wrongRelease, "payload_hash");
    assert.equal((await a.fetchJson("events", { role: "TELEMETRY", data: { run_id: runId, event: wrongRelease } })).status, 422);
    await a.post("run-events", { run_id: runId, expected_revision: 3, state: "COMPLETING" });
    const completion = { ...clone(examples["run-completion"]), run_id: runId, run_context_hash: a.run.context.context_hash, run_context_revision: a.run.context.revision, dataset_manifest_hash: a.dataset.manifest_hash, status: "COMPLETED", gaps: [], failures: [] }; completion.observed_coverage = clone(completion.requested_coverage);
    assert.equal((await a.fetchJson("run-events", { role: "TELEMETRY", data: { run_id: runId, expected_revision: 4, state: "COMPLETED", completion, open_pinned_trades: 1, pending_events: 0 } })).status, 409);
    await a.post("run-events", { run_id: runId, expected_revision: 4, state: "COMPLETED", completion, open_pinned_trades: 0, pending_events: 0 }, { role: "TELEMETRY" });
    await a.post("run-events", { run_id: other.context.run_id, expected_revision: 1, state: "READY" });
    assert.equal((await a.fetchJson(`runs/${runId}`, { role: "TELEMETRY" })).value.state, "COMPLETED");
  } finally { await a.close(); }
});

await check("GOV-02 GOV-04 GOV-08: expiry/revocation rechecked at dispatch and failed queue append rolls back decision atomically", async () => {
  const a = await app();
  try {
    const review = await a.reviewCase(); const c = review.row.case_id; const request = await a.requestApproval(c, review.recommendation.manifest.artifact_id); const decision = await a.decide(request);
    await a.change(c, { action: "advance", to_stage: "DEVELOPMENT_HANDOFF", decision_id: decision.decision_id });
    const handoff = await a.post("handoffs", { handoff_id: nextId("handoff"), case_id: c, decision_id: decision.decision_id, gate: "DEVELOPMENT", recipient_id: "ocean-test-strategy", authorized_test: "BACKTEST" });
    await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 1, state: "READY" }); await a.post("handoff-events", { handoff_id: handoff.handoff_id, expected_revision: 2, state: "DISPATCHED" });
    await a.post("revocations", { decision_id: decision.decision_id, reason: "Synthetic after-queue revocation" });
    const claim = await a.post("outbox/claim", { strategy_id: STRATEGY, instance_id: INSTANCE }, { role: "STRATEGY" }); assert.ok(claim.items.every((item) => item.payload.action !== "handoff.event"));
    assert.equal(a.backend().db.prepare("SELECT COUNT(*) AS n FROM ow_outbox WHERE last_error='APPROVAL_NOT_CURRENT'").get().n, 1);
    assert.equal((await a.fetchJson(`decisions/${decision.decision_id}`, { role: "STRATEGY" })).value.current_test_authority, false);
    const expiryReview = await a.reviewCase(); const expiring = await a.requestApproval(expiryReview.row.case_id, expiryReview.recommendation.manifest.artifact_id, "DEVELOPMENT", new Date(Date.now()+700).toISOString()); const expiredDecision = await a.decide(expiring);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal((await a.fetchJson("transitions", { data: { case_id: expiring.case_id, expected_revision: (await a.getCase(expiring.case_id)).revision, action: "advance", to_stage: "DEVELOPMENT_HANDOFF", decision_id: expiredDecision.decision_id } })).status, 409);
    const backlog = await a.reviewCase(); const br = await a.requestApproval(backlog.row.case_id, backlog.recommendation.manifest.artifact_id);
    const countsBefore = a.backend().db.prepare("SELECT (SELECT COUNT(*) FROM ow_decisions) AS d,(SELECT COUNT(*) FROM ow_events) AS e,(SELECT COUNT(*) FROM ow_inbox) AS i").get();
    a.backend().store.transaction(() => { const statement = a.backend().db.prepare("INSERT INTO ow_outbox(id,entity_id,recipient_id,payload_hash,payload_json,state,next_attempt_ms) VALUES(?,?,?,?,?,'PENDING',0)"); for (let n=0;n<1000;n++) statement.run(`test-capacity-${n}`, backlog.row.case_id, "ocean-test-strategy", digest("fixture"), "{}"); });
    assert.equal((await a.fetchJson("decisions", { data: { decision_id: nextId("blocked-decision"), request_id: br.request_id, case_id: br.case_id, expected_revision: (await a.getCase(br.case_id)).revision, snapshot_hash: br.snapshot_hash, decision: "APPROVED", reason: "Synthetic capacity test" } })).status, 429);
    assert.deepEqual(a.backend().db.prepare("SELECT (SELECT COUNT(*) FROM ow_decisions) AS d,(SELECT COUNT(*) FROM ow_events) AS e,(SELECT COUNT(*) FROM ow_inbox) AS i").get(), countsBefore);
    assert.equal((await a.fetchJson(`approvals/${br.request_id}`)).value.state, "PENDING");
    assert.throws(() => a.backend().db.prepare("UPDATE ow_approval_requests SET snapshot_hash=? WHERE id=?").run(digest("tamper"), br.request_id), /immutable/);
  } finally { await a.close(); }
});

await check("GOV-01 GOV-03 CFG-02 CFG-04: unresolved/reference-forged credentials, version/hash preflights and legacy DB exclusion", async () => {
  const a = await app();
  try {
    assert.throws(() => new WorkflowBackend({ ...a.config, db_file: path.join(a.directory,"unresolved.sqlite") }, {}), /PROVIDER_CREDENTIAL_UNRESOLVED/);
    const forged = clone(a.config); forged.db_file = path.join(a.directory,"forged-provider.sqlite"); forged.identities[0].provider = "BRAIN_GENERAL";
    assert.throws(() => new WorkflowBackend(forged,a.environment), /INVALID_PROVIDER_IDENTITY/);
    const generalReference = clone(a.config); generalReference.db_file = path.join(a.directory,"general-ref.sqlite"); generalReference.identities[0].credential_ref = "BRAIN_GENERAL_API_TOKEN";
    assert.throws(() => new WorkflowBackend(generalReference,a.environment), /EXACT_SCOPE_REQUIRED/);
    const changedProfile = { ...a.profile, profile_id:"test-tampered-profile", profile_hash:digest("incorrect") };
    assert.equal((await a.fetchJson("profiles",{data:{profile:changedProfile,file_sha256:digest(JSON.stringify(changedProfile))}})).status,422);
    const oldRelease = { ...a.profile, schema_version:"2.0.1" };
    assert.equal((await a.fetchJson("profiles",{data:{profile:oldRelease,file_sha256:digest(JSON.stringify(oldRelease))}})).status,422);
    const row = await a.newCase();
    const content = "premature candidate";
    assert.equal((await a.fetchJson("artifacts",{role:"STRATEGY",data:{artifact_id:nextId("premature"),case_id:row.case_id,run_id:a.run.context.run_id,recipient_id:"ocean-test-brain",kind:"CANDIDATE",media_type:"text/plain",content,content_hash:digest(content),candidate_hash:digest("candidate"),dependency_ids:[]}})).status,409);
    for (const header of ["x-actor-id","x-role","x-scope","x-strategy-id","x-instance-id","x-decision-by"]) assert.equal((await a.fetchJson("status",{role:"TELEMETRY",headers:{[header]:"forged"}})).status,403);
    const probePath=path.join(a.directory,"unrelated.sqlite"); const probe=new WorkflowStore(probePath); probe.revertEmptyMigration(); probe.db.exec("CREATE TABLE legacy_ledger(value INTEGER); INSERT INTO legacy_ledger VALUES(42); PRAGMA journal_mode=DELETE;"); probe.close();
    const before=digest(fs.readFileSync(probePath)); assert.throws(()=>new WorkflowStore(probePath), /EXISTING_NON_WORKFLOW_DATABASE_REJECTED/); assert.equal(digest(fs.readFileSync(probePath)),before);
    assert.equal((await a.fetchJson(`runs/${a.run.context.run_id}`,{role:"BRAIN"})).value.context.observed_source_state.quality,"UNKNOWN");
    assert.equal((await a.fetchJson(`instances/${INSTANCE}`,{role:"TELEMETRY"})).value.payload.execution_instance_id,INSTANCE);
    assert.equal((await a.fetchJson(`profiles/${a.profile.profile_id}:${a.profile.profile_version}`,{role:"BRAIN"})).value.immutable,true);
    await a.post("health",{strategy_id:STRATEGY,instance_id:INSTANCE,status:"READY",next_owner:"ocean-test-telemetry",next_action:"Synthetic heartbeat only"},{role:"TELEMETRY"});
    assert.equal((await a.fetchJson(`health/${INSTANCE}`,{role:"BRAIN"})).value.items[0].stale,false);
    assert.equal((await a.fetchJson(`cases/${row.case_id}/history`,{role:"BRAIN"})).value.items[0].namespace,"TEST");
    const python=a.backend().config.python_executable; a.backend().config.python_executable=path.join(a.directory,"missing-validator.exe");
    assert.equal((await a.fetchJson("profiles",{data:{profile:a.profile,file_sha256:digest(JSON.stringify(a.profile))}})).status,503); a.backend().config.python_executable=python;
  } finally { await a.close(); }
});

if (process.env.OCEAN_S20_RESULT_FILE) fs.writeFileSync(process.env.OCEAN_S20_RESULT_FILE, JSON.stringify({ test_type: "ACTUAL_ISOLATED_NODE_HTTP_SQLITE_RUNTIME", data_type: "SYNTHETIC_TEST_FIXTURES_AND_VERIFIED_S19_PENDING_PLAN", mocks: "NONE", tests: results, status: results.every((entry) => entry.status === "PASS") ? "PASS" : "FAILED", table_transitions: TABLE.normal_transitions.length }, null, 2));
