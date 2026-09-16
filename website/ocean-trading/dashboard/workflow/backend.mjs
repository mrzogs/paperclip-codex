import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { API_VERSION, RELEASE, MAX_BODY_BYTES, WorkflowError, canonical, digest, exactKeys, future, id, noSecrets, objectHash, requireThat, sealedHash, strategyId } from "./common.mjs";
import { OceanAuth } from "./auth.mjs";
import { WorkflowStore } from "./store.mjs";
import { readWorkflowView, recordManualAcknowledgement } from "./ui-api.mjs";
import { RunManager } from "./run-manager.mjs";
import { attachMaintenance } from './maintenance.mjs';
import { orderedSetup, knownSetupTask } from './setup-operator.mjs';
import { TestCommunication, TEST_PREFIX } from './test-communication.mjs';
import { integrationStatus } from './integration.mjs';
import { OperationalTransition, OPERATIONAL_PREFIX, operationalPolicy } from './operational-transition.mjs';
import { OperationalPreparation } from './operational-preparation.mjs';

export const TABLE = JSON.parse(fs.readFileSync(new URL("./workflow-transition-table.json", import.meta.url), "utf8"));
const GATES = { ONBOARDING: "DISCOVERY", DEVELOPMENT: "DEVELOPMENT_REVIEW", SHADOW: "SHADOW_REVIEW", PRODUCTION: "DEPLOYMENT_REVIEW", ROLLBACK: "ROLLBACK_REVIEW" };
const ARTIFACT_KINDS = new Set(["EVIDENCE", "RECOMMENDATION", "CANDIDATE", "BACKTEST", "ROBUSTNESS", "WALK_FORWARD", "OOS_HOLDOUT", "EVALUATION", "FORWARD_RESULT", "FORWARD_EVALUATION", "DEPLOYMENT_PLAN", "ROLLBACK_PLAN", "VALIDATION_REPORT", "OUTCOME", "LESSON", "NO_BENEFIT"]);
const HUMAN_OPERATIONS = new Set(["profile.register", "strategy.register", "instance.register", "dataset.register", "plan.register", "run.register", "case.register", "approval.decide", "approval.revoke", "setup.register", "outbox.retry", "handoff.create"]);
export const ROUTES = {
  profiles: "profile.register", strategies: "strategy.register", instances: "instance.register", datasets: "dataset.register", "dataset-plans": "plan.register",
  runs: "run.register", cases: "case.register", artifacts: "artifact.write", approvals: "approval.request", decisions: "approval.decide", revocations: "approval.revoke",
  transitions: "case.transition", tasks: "task.result", handoffs: "handoff.create", "handoff-events": "handoff.event", "handoff-confirmations": "handoff.manual-confirmation", "run-events": "run.event",
  events: "event.write", health: "health.write", "setup-receipts": "setup.register", "outbox/claim": "outbox.claim", "outbox/ack": "outbox.ack", "outbox/fail": "outbox.fail", "outbox/retry": "outbox.retry",
};
for (const action of ["version","settings","permission","preview","prepare","preset","end","claim","renew","activate","pin","progress","evidence","finish"]) {
  ROUTES[`run-manager/${action}`] = `run-manager.${action}`;
  if (["version","settings","permission","preview","prepare","preset","end"].includes(action)) HUMAN_OPERATIONS.add(`run-manager.${action}`);
}

export class WorkflowBackend {
  constructor(config, environment = process.env) {
    this.config = config;
    this.environment = environment;
    requireThat(config.test_only === true && config.contract_release === RELEASE, 503, "S20_TEST_CONTRACT_REQUIRED");
    if (config.operator_managed) requireThat(config.brain_submission === 'OFF' && config.dispatch_worker === 'OFF' && config.live_real === 'DISABLED', 503, 'S231_EXECUTION_DISABLED_REQUIRED');
    const releaseRoot = fileURLToPath(new URL("./contracts/2.1.0/", import.meta.url));
    const releaseBytes = fs.readFileSync(path.join(releaseRoot, "shared-contracts-manifest.json"));
    requireThat(digest(releaseBytes) === "sha256:59902b6b788edfe7f2e643675e3cc569d945c1896475753f9add1b53d4564a96", 503, "CONTRACT_RELEASE_HASH_CONFLICT");
    for (const entry of JSON.parse(releaseBytes).files) {
      requireThat(!path.isAbsolute(entry.path) && !entry.path.split(/[\\/]/).includes("..") && digest(fs.readFileSync(path.join(releaseRoot, entry.path))) === `sha256:${entry.sha256}`, 503, "CONTRACT_MEMBER_HASH_CONFLICT");
    }
    requireThat(typeof config.python_executable === "string" && config.python_executable.length, 503, "PYTHON_BINDING_REQUIRED");
    this.leaseMs = config.lease_ms || 30_000;
    requireThat(this.leaseMs >= 20 && this.leaseMs <= 60_000, 503, "LEASE_BOUND_REJECTED");
    this.store = new WorkflowStore(config.db_file);
    this.db = this.store.db;
    this.runs = new RunManager(this);
    this.testCommunication = new TestCommunication(this);
    this.operational = new OperationalTransition(this);
    try { this.auth = new OceanAuth(config, this.store, environment); }
    catch (error) { this.store.close(); throw error; }
  }
  close() { this.stopMaintenance?.(); this.store.close(); }
  validate(kind, payload) {
    const result = spawnSync(this.config.python_executable, [fileURLToPath(new URL("./validate-contract.py", import.meta.url))], {
      input: JSON.stringify({ kind, payload }), encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 64 * 1024,
    });
    requireThat(!result.error && (result.status === 0 || result.status === 1), 503, "CONTRACT_VALIDATOR_UNAVAILABLE");
    requireThat(result.status === 0, 422, "SHARED_CONTRACT_REJECTED");
  }
  one(table, entityId) {
    id(entityId);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId);
    requireThat(row, 404, "ENTITY_NOT_FOUND");
    return row;
  }
  authorize(actor, scope, strategy, instance = null) {
    if (actor.role === "HUMAN") return;
    requireThat(actor.scopes.includes(scope), 403, "WRONG_ACTION_SCOPE");
    requireThat(actor.strategyIds.includes(strategy), 403, "WRONG_STRATEGY_SCOPE");
    requireThat(instance && actor.instanceIds.includes(instance), 403, "WRONG_INSTANCE_SCOPE");
    const binding = this.one("ow_instances", instance);
    requireThat(binding.strategy_id === strategy, 403, "INSTANCE_STRATEGY_MISMATCH");
  }
  caseFor(actor, caseId, scope) {
    const row = this.one("ow_cases", caseId);
    this.authorize(actor, scope, row.strategy_id, row.instance_id);
    return row;
  }
  baseline(row) {
    const current = this.one("ow_strategies", row.strategy_id);
    requireThat(current.baseline_hash === row.baseline_hash && current.revision === JSON.parse(row.payload_json).registry_revision, 409, "BLOCKED_RECONCILIATION");
  }
  expect(row, revision) { requireThat(Number.isInteger(revision) && row.revision === revision, 409, "REVISION_CONFLICT"); }
  active(row) { requireThat(!["PAUSED", "CANCELLED", "BLOCKED", "FAILED"].includes(row.work_status) && row.stage !== "CLOSED", 409, "CASE_NOT_EXECUTABLE"); }
  event(entity, operation, actor, payload, recipient = null) {
    const event = { schema_version: API_VERSION, namespace: "TEST", operational_action_allowed: false, entity_id: entity, action: operation, actor_id: actor.id, actor_role: actor.role, created_at_utc: new Date().toISOString(), payload };
    const record = this.db.prepare("INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)").run(entity, operation, actor.id, actor.role, event.created_at_utc, JSON.stringify(event));
    if (recipient) {
      requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM ow_outbox WHERE state NOT IN ('ACKNOWLEDGED','DEAD_LETTER')").get().n < 1000, 429, "OUTBOX_BACKPRESSURE");
      const outboxId = `test-outbox-${record.lastInsertRowid}`;
      this.db.prepare("INSERT INTO ow_outbox(id,entity_id,recipient_id,payload_hash,payload_json,state,next_attempt_ms) VALUES(?,?,?,?,?,'PENDING',?)").run(outboxId, entity, recipient, objectHash(event), JSON.stringify(event), Date.now());
    }
    return event;
  }
  mutate(operation, actor, input) {
    exactKeys(input, ["message_id", "data"]);
    id(input.message_id, true);
    noSecrets(input.data, this.environment);
    requireThat(input.data && typeof input.data === "object", 422, "DATA_REQUIRED");
    if (HUMAN_OPERATIONS.has(operation)) requireThat(actor.role === "HUMAN", 403, "WAYNE_BROWSER_ONLY");
    const hash = objectHash({ operation, data: input.data });
    const receiptKeys = operation === "event.write" ? [input.message_id, `event:${id(input.data.event?.event_id)}`] : [input.message_id];
    let previous;
    for (const key of receiptKeys) {
      const found = this.db.prepare("SELECT * FROM ow_inbox WHERE producer_id=? AND message_id=?").get(actor.id, key);
      if (!found) continue;
      if (found.payload_hash !== hash) {
        this.db.prepare("INSERT INTO ow_quarantine(producer_id,message_id,reason,payload_hash,created_at_utc) VALUES(?,?,?,?,?)").run(actor.id, key, "DUPLICATE_CONFLICT", hash, new Date().toISOString());
        throw new WorkflowError(409, "DUPLICATE_CONFLICT");
      }
      previous = found;
    }
    if (previous) {
      const result = JSON.parse(previous.result_json);
      this.authorizeReplay(operation, actor, input.data);
      this.store.transaction(() => {
        for (const key of receiptKeys) this.db.prepare("INSERT OR IGNORE INTO ow_inbox VALUES(?,?,?,?)").run(actor.id, key, hash, previous.result_json);
      });
      return result;
    }
    return this.store.transaction(() => {
      const result = this.perform(operation, actor, input.data);
      for (const key of receiptKeys) this.db.prepare("INSERT INTO ow_inbox VALUES(?,?,?,?)").run(actor.id, key, hash, JSON.stringify(result));
      return result;
    });
  }
  authorizeReplay(operation, actor, input) {
    if (actor.role === "HUMAN") return;
    if (operation.startsWith("run-manager.")) {
      const {run,plan} = this.runs.load(actor,input.run_id,"event.write");
      requireThat(actor.role === "TELEMETRY" && plan.instance.telemetry_producer_id === actor.id,403,"WRONG_TELEMETRY_PRODUCER");
      return;
    }
    if (input.handoff_id) { const handoff = this.one("ow_handoffs", input.handoff_id); this.caseFor(actor, handoff.case_id, "case.transition"); requireThat(handoff.recipient_id === actor.id, 403, "WRONG_RECIPIENT"); }
    else if (input.case_id) this.caseFor(actor, input.case_id, operation === "artifact.write" ? operation : operation === "approval.request" ? operation : "case.transition");
    else if (input.run_id) { const run = this.one("ow_runs", input.run_id); this.authorize(actor, operation === "artifact.write" ? operation : "event.write", run.strategy_id, run.instance_id); }
    else if (input.outbox_id) requireThat(this.one("ow_outbox", input.outbox_id).recipient_id === actor.id, 403, "WRONG_RECIPIENT");
    else this.authorize(actor, operation === "health.write" ? operation : "delivery", input.strategy_id, input.instance_id);
  }
  perform(operation, actor, data) {
    if (operation.startsWith("run-manager.")) return this.runs.perform(operation.slice(12),actor,data);
    switch (operation) {
      case "profile.register": {
        exactKeys(data, ["profile", "file_sha256"]);
        this.validate("strategy-profile", data.profile);
        requireThat(digest(Buffer.from(JSON.stringify(data.profile))) === data.file_sha256 && sealedHash(data.profile, "profile_hash") === data.profile.profile_hash, 422, "PROFILE_HASH_MISMATCH");
        const profile = data.profile;
        const key = `${profile.profile_id}:${profile.profile_version}`;
        const current = this.db.prepare("SELECT payload_json FROM ow_profiles WHERE id=?").get(key);
        const payload = JSON.stringify(profile);
        if (current) requireThat(current.payload_json === payload, 409, "IMMUTABLE_PROFILE_CONFLICT");
        else this.db.prepare("INSERT INTO ow_profiles VALUES(?,?,?,?,?)").run(key, profile.strategy_id, profile.profile_version, digest(payload), payload);
        this.event(key, operation, actor, { profile_hash: profile.profile_hash });
        return { id: key, immutable: true };
      }
      case "strategy.register": {
        exactKeys(data, ["registry", "baseline_hash", "expected_revision"]);
        this.validate("strategy-registry", data.registry);
        const registry = data.registry;
        strategyId(registry.strategy_id);
        requireThat(registry.activation_status === "PENDING_ONBOARDING" && registry.activation_decision_id === null && registry.production_version === null && registry.execution_instances.length === 0, 403, "S20_ACTIVATION_PROHIBITED");
        requireThat(/^sha256:[a-f0-9]{64}$/.test(data.baseline_hash), 422, "BASELINE_HASH_REQUIRED");
        const key = `${registry.profile_id}:${registry.profile_version}`;
        const profile = JSON.parse(this.one("ow_profiles", key).payload_json);
        requireThat(profile.strategy_id === registry.strategy_id && profile.profile_hash === registry.profile_hash, 409, "PROFILE_REGISTRY_MISMATCH");
        requireThat(data.baseline_hash === profile.strategy_code_hash && registry.baseline_version === profile.baseline_version, 409, "BASELINE_PROFILE_MISMATCH");
        const current = this.db.prepare("SELECT * FROM ow_strategies WHERE id=?").get(registry.strategy_id);
        if (current) {
          this.expect(current, data.expected_revision);
          requireThat(registry.registry_revision === current.revision + 1, 409, "REGISTRY_REVISION_REQUIRED");
          this.db.prepare("UPDATE ow_strategies SET profile_id=?,revision=?,baseline_hash=?,payload_json=? WHERE id=?").run(key, registry.registry_revision, data.baseline_hash, JSON.stringify(registry), registry.strategy_id);
        } else {
          requireThat(registry.registry_revision === 1, 422, "INITIAL_REVISION_REQUIRED");
          this.db.prepare("INSERT INTO ow_strategies VALUES(?,?,?,?,?)").run(registry.strategy_id, key, 1, data.baseline_hash, JSON.stringify(registry));
        }
        this.event(registry.strategy_id, operation, actor, { revision: registry.registry_revision, baseline_hash: data.baseline_hash });
        return { strategy_id: registry.strategy_id, revision: registry.registry_revision, activation_status: "PENDING_ONBOARDING" };
      }
      case "instance.register": {
        exactKeys(data, ["strategy_id", "instance"]);
        const instance = data.instance;
        this.validate("execution-instance", instance);
        id(instance.execution_instance_id, true);
        id(instance.source_installation_id, true);
        this.one("ow_strategies", strategyId(data.strategy_id));
        requireThat(instance.strategy_id === data.strategy_id && instance.status === "DRAFT" && instance.lease_run_id === null && !instance.capabilities.includes("LIVE_REAL") && this.config.identities.some((entry) => entry.role === "TELEMETRY" && entry.identity_id === instance.telemetry_producer_id && entry.strategy_ids.includes(data.strategy_id) && entry.instance_ids.includes(instance.execution_instance_id)), 403, "TEST_PRODUCER_BINDING_REQUIRED");
        this.runs.uniqueInstance(instance);
        this.db.prepare("INSERT INTO ow_instances VALUES(?,?,?)").run(instance.execution_instance_id, data.strategy_id, JSON.stringify(instance));
        this.event(instance.execution_instance_id, operation, actor, { namespace: "TEST", strategy_id: data.strategy_id });
        return { execution_instance_id: instance.execution_instance_id, namespace: "TEST" };
      }
      case "plan.register":
      case "dataset.register": {
        exactKeys(data, ["strategy_id", "manifest"]);
        this.one("ow_strategies", strategyId(data.strategy_id));
        const manifest = data.manifest;
        let manifestId;
        let hash;
        let revision;
        if (operation === "plan.register") {
          requireThat(manifest.schema_version === "brain-dataset-plan/v1" && manifest.strategy_id === data.strategy_id && manifest.runtime_manifest === null && manifest.plan_is_execution_authority === false && manifest.activation_status === "DISABLED" && manifest.permitted_intervals.length === 0, 422, "INACTIVE_PLAN_REQUIRED");
          requireThat(sealedHash(manifest, "plan_hash") === manifest.plan_hash, 422, "PLAN_HASH_MISMATCH");
          manifestId = manifest.plan_id; hash = manifest.plan_hash; revision = manifest.revision;
        } else {
          this.validate("dataset-manifest", manifest);
          id(manifest.dataset_manifest_id, true);
          requireThat(sealedHash(manifest, "manifest_hash") === manifest.manifest_hash, 422, "DATASET_HASH_MISMATCH");
          requireThat(manifest.partitions.every((part) => Date.parse(part.start_utc) < Date.parse(part.end_utc)), 422, "INVALID_DATASET_INTERVAL");
          manifestId = manifest.dataset_manifest_id; hash = manifest.manifest_hash; revision = manifest.revision;
        }
        const key = `${manifestId}:${revision}`;
        this.db.prepare("INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)").run(key, data.strategy_id, revision, hash, operation === "plan.register" ? "PENDING_PLAN" : "TEST_RUNTIME_MANIFEST", JSON.stringify(manifest));
        this.event(key, operation, actor, { learner_permission: "NONE" });
        return { id: key, runtime_eligible: operation !== "plan.register", learner_permission: "NONE" };
      }
      case "run.register": {
        exactKeys(data, ["context"]);
        const context = { ...data.context };
        requireThat(!("learner_permission" in context) && !("permission_reason" in context) && !("context_hash" in context), 422, "SERVER_PERMISSION_FIELDS_REJECTED");
        id(context.run_id, true);
        const instance = this.one("ow_instances", context.execution_instance_id);
        requireThat(instance.strategy_id === context.strategy_id, 403, "INSTANCE_STRATEGY_MISMATCH");
        const binding = JSON.parse(instance.payload_json);
        requireThat(context.source_installation_id === binding.source_installation_id && binding.capabilities.includes(context.expected_environment) && context.expected_environment !== "LIVE_REAL", 403, "SOURCE_BINDING_MISMATCH");
        const registry = JSON.parse(this.one("ow_strategies", context.strategy_id).payload_json);
        const profile = JSON.parse(this.one("ow_profiles", `${registry.profile_id}:${registry.profile_version}`).payload_json);
        requireThat(context.strategy_profile_id === registry.profile_id && context.strategy_profile_version === registry.profile_version && context.strategy_version === binding.version_binding && context.strategy_code_hash === profile.strategy_code_hash && context.strategy_config_hash === binding.config_hash, 409, "RUN_VERSION_MISMATCH");
        const dataset = this.one("ow_datasets", `${context.dataset_manifest_id}:${context.dataset_manifest_revision}`);
        requireThat(dataset.kind === "TEST_RUNTIME_MANIFEST" && dataset.strategy_id === context.strategy_id && dataset.content_hash === context.dataset_manifest_hash, 403, "DATASET_NOT_ELIGIBLE");
        context.learner_permission = "NONE";
        context.permission_reason = "S20 TEST namespace; Brain submission disabled";
        context.observed_source_state = { observed_at_utc: new Date().toISOString(), environment: "UNKNOWN", simulation: null, replay: null, account_alias: null, source_schema_version: null, quality: "UNKNOWN" };
        requireThat(context.evidence_purpose === "NOT_ELIGIBLE", 403, "S20_LEARNING_DISABLED");
        context.context_hash = sealedHash(context, "context_hash");
        this.validate("run-context", context);
        this.db.prepare("INSERT INTO ow_runs VALUES(?,?,?,?,'DRAFT',?)").run(context.run_id, context.strategy_id, context.execution_instance_id, 1, JSON.stringify(context));
        this.event(context.run_id, operation, actor, { context_hash: context.context_hash, namespace: "TEST" });
        return { context, state: "DRAFT", namespace: "TEST" };
      }
      case "run.event": {
        exactKeys(data, ["run_id", "expected_revision", "state", "observed_handshake", "completion", "open_pinned_trades", "pending_events"]);
        const run = this.one("ow_runs", data.run_id);
        requireThat(!this.runs.managed(run.id),409,"MANAGED_RUN_API_REQUIRED");
        requireThat(["HUMAN", "TELEMETRY"].includes(actor.role), 403, "OCEAN_OR_OBSERVED_PRODUCER_REQUIRED");
        this.authorize(actor, "event.write", run.strategy_id, run.instance_id);
        this.expect(run, data.expected_revision);
        requireThat(TABLE.run_transitions[run.state].includes(data.state), 409, "INVALID_RUN_TRANSITION");
        if (data.state === "READY") requireThat(!this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING') AND id<>?").get(run.instance_id, run.id), 409, "INSTANCE_ALREADY_RESERVED");
        if (["FAILED", "CANCELLED"].includes(data.state)) {
          requireThat(data.completion, 422, "INCOMPLETE_COVERAGE_REQUIRED");
          this.validate("run-completion", data.completion);
          const context = JSON.parse(run.context_json);
          requireThat(data.completion.run_id === run.id && data.completion.status === data.state && data.completion.run_context_hash === context.context_hash && data.completion.run_context_revision === context.revision && data.completion.dataset_manifest_hash === context.dataset_manifest_hash, 409, "RUN_COMPLETION_CONTEXT_MISMATCH");
        }
        if (data.state === "ACTIVE") {
          requireThat(actor.role === "TELEMETRY", 403, "OBSERVED_PRODUCER_HANDSHAKE_REQUIRED");
          const instance = JSON.parse(this.one("ow_instances", run.instance_id).payload_json);
          exactKeys(data.observed_handshake, ["instance", "source_state"]);
          this.validate("source-state", data.observed_handshake.source_state);
          const observed = data.observed_handshake.source_state; const context = JSON.parse(run.context_json);
          requireThat(objectHash(data.observed_handshake.instance) === objectHash(instance) && instance.telemetry_producer_id === actor.id && observed.environment === context.expected_environment && observed.quality === "VERIFIED" && observed.simulation === true && observed.replay === (context.expected_environment === "REPLAY") && observed.account_alias === instance.account_alias && observed.source_schema_version !== null && Date.now()-Date.parse(observed.observed_at_utc)<=120000 && Date.parse(observed.observed_at_utc)<=Date.now()+5000, 409, "SOURCE_HANDSHAKE_MISMATCH");
        }
        if (data.state === "COMPLETED") {
          requireThat(actor.role === "TELEMETRY", 403, "OBSERVED_COMPLETION_REQUIRED");
          this.validate("run-completion", data.completion);
          const context = JSON.parse(run.context_json);
          requireThat(data.completion.run_id === run.id && data.completion.run_context_hash === context.context_hash && data.completion.run_context_revision === context.revision && data.completion.dataset_manifest_hash === context.dataset_manifest_hash && data.open_pinned_trades === 0 && data.pending_events === 0 && data.completion.status === "COMPLETED" && data.completion.gaps.length === 0 && data.completion.failures.length === 0 && objectHash(data.completion.requested_coverage) === objectHash(data.completion.observed_coverage), 409, "RUN_NOT_DRAINED_OR_CONTEXT_MISMATCH");
        }
        this.db.prepare("UPDATE ow_runs SET state=?,revision=revision+1 WHERE id=?").run(data.state, run.id);
        this.event(run.id, operation, actor, { before: run.state, after: data.state, observed_handshake: data.observed_handshake || null, completion: data.completion || null });
        return { run_id: run.id, state: data.state, revision: run.revision + 1 };
      }
      case "case.register": {
        exactKeys(data, ["case_id", "run_id"]);
        id(data.case_id, true);
        const run = this.one("ow_runs", data.run_id);
        const strategy = this.one("ow_strategies", run.strategy_id);
        this.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'DISCOVERY','READY',?,NULL,?,NULL,?)").run(data.case_id, run.strategy_id, run.instance_id, run.id, strategy.baseline_hash, actor.id, JSON.stringify({ registry_revision: strategy.revision }));
        this.event(data.case_id, operation, actor, { namespace: "TEST", baseline_hash: strategy.baseline_hash });
        return this.readCase(actor, data.case_id);
      }
      case "artifact.write": return this.writeArtifact(actor, data);
      case "approval.request": return this.requestApproval(actor, data);
      case "approval.decide": return this.decide(actor, data);
      case "approval.revoke": {
        exactKeys(data, ["decision_id", "reason"]);
        const decision = this.one("ow_decisions", data.decision_id);
        requireThat(typeof data.reason === "string" && data.reason.length > 0, 422, "REASON_REQUIRED");
        this.db.prepare("INSERT INTO ow_decision_revocations VALUES(?,?,?,?)").run(decision.id, data.reason, new Date().toISOString(), actor.id);
        this.event(decision.case_id, operation, actor, { decision_id: decision.id, reason: data.reason });
        return { decision_id: decision.id, revoked: true };
      }
      case "case.transition": return this.transition(actor, data);
      case "task.result": {
        exactKeys(data, ["case_id", "expected_revision", "kind", "status", "artifact_id"]);
        const row = this.caseFor(actor, data.case_id, "case.transition");
        requireThat(["HUMAN", "STRATEGY"].includes(actor.role), 403, "TEST_RESULT_PRODUCER_REQUIRED");
        this.expect(row, data.expected_revision); this.active(row); this.baseline(row);
        requireThat(row.stage === "HISTORICAL_VALIDATION" && ["PASS", "FAIL", "NOT_RUN", "BLOCKED", "NOT_APPLICABLE"].includes(data.status), 409, "INVALID_SUBTEST_STATE");
        const task = this.db.prepare("SELECT * FROM ow_tasks WHERE case_id=? AND kind=?").get(row.id, data.kind);
        requireThat(task, 404, "SUBTEST_NOT_PLANNED");
        const artifact = this.artifactFor(row, data.artifact_id, data.kind);
        const payload = JSON.parse(Buffer.from(artifact.content).toString("utf8"));
        requireThat(payload.status === data.status && payload.candidate_hash === row.candidate_hash, 409, "SUBTEST_REPORT_MISMATCH");
        if (data.status === "NOT_APPLICABLE") {
          const plan = this.approved(row, "DEVELOPMENT");
          requireThat(payload.inapplicability_reason && payload.authorized_plan_hash === plan.payload.snapshot_hash && plan.binding.authorized_tests.includes(`NOT_APPLICABLE:${data.kind}:${digest(payload.inapplicability_reason)}`), 422, "PREDECLARED_SUBTEST_RATIONALE_REQUIRED");
        }
        this.db.prepare("UPDATE ow_tasks SET status=?,artifact_id=? WHERE id=?").run(data.status, artifact.id, task.id);
        this.db.prepare("UPDATE ow_cases SET revision=revision+1 WHERE id=?").run(row.id);
        this.event(row.id, operation, actor, { kind: data.kind, status: data.status });
        return { case_id: row.id, revision: row.revision + 1, kind: data.kind, status: data.status };
      }
      case "handoff.create": return this.createHandoff(actor, data);
      case "handoff.event": return this.handoffEvent(actor, data);
      case "handoff.manual-confirmation": return recordManualAcknowledgement(this, actor, data);
      case "event.write": {
        exactKeys(data, ["run_id", "event"]);
        const run = this.one("ow_runs", data.run_id);
        this.authorize(actor, operation, run.strategy_id, run.instance_id);
        const event = data.event;
        this.validate("workflow-event", event);
        const context = JSON.parse(run.context_json);
        requireThat(event.producer_id === actor.id && event.actor_role === actor.role && event.strategy_id === run.strategy_id && event.execution_instance_id === run.instance_id && event.run_id === run.id && event.run_context_hash === context.context_hash && event.run_context_revision === context.revision, 403, "EVENT_AUTHORITY_OR_CONTEXT_MISMATCH");
        requireThat(event.strategy_name === JSON.parse(this.one("ow_strategies", run.strategy_id).payload_json).strategy_name && ["strategy_version", "strategy_code_hash", "strategy_config_hash", "strategy_profile_id", "strategy_profile_version", "source_installation_id"].every((field) => event[field] === context[field]), 409, "EVENT_VERSION_MISMATCH");
        requireThat(sealedHash(event, "payload_hash") === event.payload_hash, 422, "EVENT_HASH_MISMATCH");
        this.event(run.id, operation, actor, { event_id: event.event_id, wire_event: event, persisted: true, eligible: false, analysis_complete: false });
        return { event_id: event.event_id, persisted: true, eligible: false, dispatch_state: "DISABLED", analysis_complete: false };
      }
      case "health.write": {
        exactKeys(data, ["strategy_id", "instance_id", "status", "next_owner", "next_action"]);
        this.authorize(actor, operation, data.strategy_id, data.instance_id);
        requireThat(actor.role === "TELEMETRY", 403, "OBSERVED_HEALTH_PRODUCER_REQUIRED");
        requireThat(["READY", "DEGRADED", "BLOCKED"].includes(data.status), 422, "INVALID_HEALTH_STATUS");
        const payload = { ...data, observed_at_utc: new Date().toISOString(), provider_id: actor.id };
        this.db.prepare("INSERT INTO ow_health VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json").run(`${actor.id}:${data.instance_id}`, actor.id, data.strategy_id, data.instance_id, JSON.stringify(payload));
        this.event(actor.id, operation, actor, payload);
        return payload;
      }
      case "setup.register": {
        exactKeys(data, ["receipt_id", "receipt", "content_hash"]);
        id(data.receipt_id);
        requireThat(objectHash(data.receipt) === data.content_hash && knownSetupTask(data.receipt.task_id) && data.receipt.task_id !== "S20", 422, "SETUP_RECEIPT_REJECTED");
        const existing = this.db.prepare("SELECT content_hash FROM ow_setup_receipts WHERE id=?").get(data.receipt_id);
        if (existing) requireThat(existing.content_hash === data.content_hash, 409, "SETUP_RECEIPT_CONFLICT");
        else this.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run(data.receipt_id, data.content_hash, JSON.stringify(data.receipt));
        this.event(data.receipt_id, operation, actor, { classification: "HISTORICAL_SETUP_NOT_APPROVAL", task_id: data.receipt.task_id, receipt_status: data.receipt.status });
        return { receipt_id: data.receipt_id, classification: "HISTORICAL_SETUP_NOT_APPROVAL" };
      }
      case "outbox.claim": return this.claim(actor, data);
      case "outbox.ack":
      case "outbox.fail": return this.finishDelivery(operation, actor, data);
      case "outbox.retry": {
        exactKeys(data, ["outbox_id"]);
        const box = this.one("ow_outbox", data.outbox_id);
        requireThat(["FAILED", "DEAD_LETTER"].includes(box.state), 409, "RETRY_NOT_REQUIRED");
        this.db.prepare("UPDATE ow_outbox SET state='PENDING',attempts=0,next_attempt_ms=?,lease_id=NULL,lease_until_ms=NULL WHERE id=?").run(Date.now(), box.id);
        this.event(box.id, operation, actor, {});
        return { outbox_id: box.id, state: "PENDING" };
      }
      default: throw new WorkflowError(404, "UNKNOWN_OPERATION");
    }
  }
  writeArtifact(actor, data) {
    exactKeys(data, ["artifact_id", "case_id", "run_id", "recipient_id", "kind", "media_type", "content", "content_encoding", "content_hash", "candidate_hash", "dependency_ids"]);
    id(data.artifact_id, true); id(data.recipient_id);
    const isImage = data.media_type === "image/png";
    requireThat(ARTIFACT_KINDS.has(data.kind) && ["text/markdown", "text/plain", "application/json", "image/png"].includes(data.media_type) && typeof data.content === "string", 422, "UNSAFE_ARTIFACT_TYPE_OR_SIZE");
    requireThat(isImage ? data.content_encoding === "base64" && data.kind === "EVIDENCE" : !data.content_encoding || data.content_encoding === "utf8", 422, "ARTIFACT_ENCODING_REJECTED");
    const contentBytes = Buffer.from(data.content, isImage ? "base64" : "utf8");
    requireThat(contentBytes.length <= 128 * 1024, 422, "UNSAFE_ARTIFACT_TYPE_OR_SIZE");
    if (isImage) {
      const result = spawnSync(this.config.python_executable, [fileURLToPath(new URL("./validate-image.py", import.meta.url))], { input: JSON.stringify({ base64: data.content }), encoding: "utf8", windowsHide: true, timeout: 4000, maxBuffer: 4096 });
      requireThat(!result.error && [0, 1].includes(result.status), 503, "IMAGE_VALIDATOR_UNAVAILABLE");
      requireThat(result.status === 0, 422, "UNSAFE_IMAGE_REJECTED");
    } else requireThat(!/<\s*(?:script|iframe|object|embed)|(?:javascript|file|data):|(?:^|[\s"'(])[A-Za-z]:[\\/]|\\\\[A-Za-z]/i.test(data.content), 422, "ACTIVE_ARTIFACT_CONTENT_REJECTED");
    if (data.media_type === "application/json") { try { JSON.parse(data.content); } catch { throw new WorkflowError(422, "INVALID_ARTIFACT_JSON"); } }
    requireThat(!data.candidate_hash || /^sha256:[a-f0-9]{64}$/.test(data.candidate_hash), 422, "INVALID_CANDIDATE_HASH");
    requireThat(digest(contentBytes) === data.content_hash, 422, "ARTIFACT_HASH_MISMATCH");
    const row = this.caseFor(actor, data.case_id, "artifact.write"); this.active(row); this.baseline(row);
    const requiredStage = { CANDIDATE: "CANDIDATE_DEVELOPMENT", BACKTEST: "HISTORICAL_VALIDATION", ROBUSTNESS: "HISTORICAL_VALIDATION", WALK_FORWARD: "HISTORICAL_VALIDATION", OOS_HOLDOUT: "HISTORICAL_VALIDATION", EVALUATION: "CANDIDATE_EVALUATION", FORWARD_RESULT: "FORWARD_VALIDATION", FORWARD_EVALUATION: "FORWARD_EVALUATION", DEPLOYMENT_PLAN: "DEPLOYMENT_REVIEW" }[data.kind];
    requireThat(!requiredStage || row.stage === requiredStage, 409, "ARTIFACT_STAGE_PREREQUISITE_REQUIRED");
    if (["CANDIDATE", "BACKTEST", "ROBUSTNESS", "WALK_FORWARD", "OOS_HOLDOUT"].includes(data.kind)) this.approved(row, "DEVELOPMENT", null, actor.role === "HUMAN" ? null : actor.id, data.kind === "CANDIDATE" ? null : data.kind);
    if (data.kind === "FORWARD_RESULT") this.approved(row, "SHADOW", null, actor.role === "HUMAN" ? null : actor.id);
    requireThat(data.run_id === row.run_id && this.config.identities.some((entry) => entry.identity_id === data.recipient_id && entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id)), 403, "ARTIFACT_RECIPIENT_OR_RUN_MISMATCH");
    requireThat(Array.isArray(data.dependency_ids), 422, "DEPENDENCIES_REQUIRED");
    data.dependency_ids.forEach((dependency) => this.artifactFor(row, dependency));
    const manifest = { schema_version: RELEASE, artifact_id: data.artifact_id, artifact_version: 1, content_hash: data.content_hash, media_type: data.media_type, bytes: contentBytes.length, created_at_utc: new Date().toISOString(), producer_id: actor.id, strategy_id: row.strategy_id, run_id: row.run_id, role: "REPORT", source_reference: `ocean-artifact:${data.artifact_id}`, known_at_utc: null, captured_at_utc: new Date().toISOString(), visible_market_cutoff_utc: null, chart_settings_hash: null, availability: "AVAILABLE", immutable: true, supersedes_artifact_id: null };
    this.validate("artifact-manifest", manifest);
    this.db.prepare("INSERT INTO ow_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(data.artifact_id, row.strategy_id, row.run_id, row.id, actor.id, data.recipient_id, data.kind, data.candidate_hash || null, row.baseline_hash, JSON.stringify(data.dependency_ids), JSON.stringify(manifest), contentBytes);
    this.event(row.id, "artifact.write", actor, { artifact_id: data.artifact_id, content_hash: data.content_hash });
    return { manifest, case_id: row.id, recipient_id: data.recipient_id, namespace: "TEST" };
  }
  artifactFor(row, artifactId, kind = null) {
    const artifact = this.one("ow_artifacts", artifactId);
    requireThat(artifact.case_id === row.id && artifact.strategy_id === row.strategy_id && artifact.run_id === row.run_id && artifact.baseline_hash === row.baseline_hash && (!kind || artifact.kind === kind), 409, "ARTIFACT_CASE_OR_KIND_MISMATCH");
    requireThat(digest(Buffer.from(artifact.content)) === JSON.parse(artifact.manifest_json).content_hash, 409, "IMMUTABLE_ARTIFACT_TAMPERED");
    if (row.candidate_hash && artifact.kind !== "RECOMMENDATION") requireThat(artifact.candidate_hash === row.candidate_hash, 409, "CANDIDATE_HASH_MISMATCH");
    return artifact;
  }
  requestApproval(actor, data) {
    exactKeys(data, ["request_id", "case_id", "expected_revision", "gate", "artifact_id", "recipient_id", "authorized_tests", "expires_at_utc"]);
    id(data.request_id, true);
    const row = this.caseFor(actor, data.case_id, "approval.request");
    this.expect(row, data.expected_revision); this.active(row); this.baseline(row);
    requireThat(GATES[data.gate] === row.stage, 409, "WRONG_GATE_STAGE");
    requireThat(future(data.expires_at_utc) && Array.isArray(data.authorized_tests) && data.authorized_tests.length > 0 && data.authorized_tests.every((value) => typeof value === "string" && value.length), 422, "GATE_TESTS_AND_EXPIRY_REQUIRED");
    const kind = { ONBOARDING: "EVIDENCE", DEVELOPMENT: "RECOMMENDATION", SHADOW: "EVALUATION", PRODUCTION: "DEPLOYMENT_PLAN", ROLLBACK: "ROLLBACK_PLAN" }[data.gate];
    const artifact = this.artifactFor(row, data.artifact_id, kind);
    requireThat(artifact.recipient_id === data.recipient_id, 409, "WRONG_RECIPIENT");
    const requestHash = objectHash({ case_id: row.id, gate: data.gate, artifact_hash: JSON.parse(artifact.manifest_json).content_hash, baseline_hash: row.baseline_hash, candidate_hash: row.candidate_hash, recipient_id: data.recipient_id, authorized_tests: data.authorized_tests });
    requireThat(!this.db.prepare("SELECT id FROM ow_approval_requests WHERE request_hash=? AND state IN ('PENDING','MORE_EVIDENCE')").get(requestHash), 409, "UNCHANGED_REQUEST_ALREADY_SUBMITTED");
    const snapshot = { ...data, strategy_id: row.strategy_id, baseline_hash: row.baseline_hash, candidate_hash: row.candidate_hash, content_hash: JSON.parse(artifact.manifest_json).content_hash, namespace: "TEST" };
    this.db.prepare("INSERT INTO ow_approval_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(data.request_id, row.id, data.gate, artifact.id, objectHash(snapshot), row.baseline_hash, row.candidate_hash, data.recipient_id, JSON.stringify(data.authorized_tests), TABLE.gate_scope_categories[data.gate], 1, "PENDING", data.expires_at_utc, requestHash, JSON.stringify(snapshot));
    this.db.prepare("UPDATE ow_cases SET revision=revision+1,owner_id='wayne-ocean-ui',waiting_on='HUMAN_DECISION' WHERE id=?").run(row.id);
    this.event(row.id, "approval.request", actor, { request_id: data.request_id, snapshot });
    return { request_id: data.request_id, case_id: row.id, snapshot_hash: objectHash(snapshot), state: "PENDING", revision: row.revision + 1, authorizes_work: false };
  }
  decide(actor, data) {
    exactKeys(data, ["decision_id", "request_id", "case_id", "expected_revision", "snapshot_hash", "decision", "reason"]);
    id(data.decision_id, true);
    requireThat(actor.role === "HUMAN" && actor.id === "wayne-ocean-ui", 403, "WAYNE_BROWSER_ONLY");
    const row = this.caseFor(actor, data.case_id, "read"); this.expect(row, data.expected_revision); this.active(row); this.baseline(row);
    const request = this.one("ow_approval_requests", data.request_id);
    this.verifySnapshot(request);
    requireThat(request.case_id === row.id && request.state === "PENDING" && request.snapshot_hash === data.snapshot_hash && GATES[request.gate] === row.stage && future(request.expires_at_utc), 409, "APPROVAL_REQUEST_STALE_OR_MISMATCH");
    this.artifactFor(row, request.artifact_id);
    requireThat(["APPROVED", "REJECTED", "MORE_EVIDENCE"].includes(data.decision) && typeof data.reason === "string" && data.reason.length > 0, 422, "DECISION_AND_REASON_REQUIRED");
    if (data.decision !== "MORE_EVIDENCE") {
      const decision = { schema_version: RELEASE, decision_id: data.decision_id, request_id: request.id, decision: data.decision, scope: request.scope, snapshot_hash: request.snapshot_hash, decided_by: "Wayne", decided_via: "AUTHORISED_OCEAN_UI", decided_at_utc: new Date().toISOString(), reason: data.reason, expires_at_utc: request.expires_at_utc };
      this.validate("approval-decision", decision);
      const binding = { case_id: row.id, strategy_id: row.strategy_id, instance_id: row.instance_id, gate: request.gate, artifact_id: request.artifact_id, baseline_hash: row.baseline_hash, candidate_hash: row.candidate_hash, recipient_id: request.recipient_id, authorized_tests: JSON.parse(request.tests_json), namespace: "TEST", operational_action_allowed: false };
      this.db.prepare("INSERT INTO ow_decisions VALUES(?,?,?,?,?)").run(decision.decision_id, request.id, row.id, JSON.stringify(binding), JSON.stringify(decision));
    }
    if (data.decision === "MORE_EVIDENCE") this.db.prepare("INSERT INTO ow_tasks VALUES(?,?,?,'NOT_RUN',NULL,1) ON CONFLICT(case_id,kind) DO UPDATE SET status='NOT_RUN',artifact_id=NULL").run(`${row.id}:RESEARCH_MORE_EVIDENCE`, row.id, "RESEARCH_MORE_EVIDENCE");
    this.db.prepare("UPDATE ow_approval_requests SET state=?,revision=revision+1 WHERE id=?").run(data.decision, request.id);
    const nextStage = data.decision === "REJECTED" ? "RETROSPECTIVE" : data.decision === "MORE_EVIDENCE" ? "RESEARCH" : row.stage;
    this.db.prepare("UPDATE ow_cases SET stage=?,revision=revision+1,owner_id=?,waiting_on=NULL WHERE id=?").run(nextStage, data.decision === "APPROVED" ? actor.id : this.config.identities.find((entry) => entry.role === "BRAIN").identity_id, row.id);
    this.event(row.id, "approval.decide", actor, { request_id: request.id, decision_id: data.decision === "MORE_EVIDENCE" ? null : data.decision_id, action: data.decision, snapshot_hash: data.snapshot_hash, reason: data.reason }, request.recipient_id);
    return { request_id: request.id, decision_id: data.decision === "MORE_EVIDENCE" ? null : data.decision_id, action: data.decision, stage: nextStage, revision: row.revision + 1, namespace: "TEST", actual_strategy_activation: false };
  }
  approved(row, gate, decisionId = null, recipientId = null, test = null) {
    this.baseline(row);
    const decision = decisionId ? this.one("ow_decisions", decisionId) : this.db.prepare("SELECT d.* FROM ow_decisions d JOIN ow_approval_requests r ON d.request_id=r.id WHERE d.case_id=? AND r.gate=? AND r.state='APPROVED' ORDER BY d.rowid DESC LIMIT 1").get(row.id, gate);
    requireThat(decision, 409, "GATE_APPROVAL_REQUIRED");
    const payload = JSON.parse(decision.payload_json); const binding = JSON.parse(decision.binding_json); const request = this.one("ow_approval_requests", decision.request_id);
    this.verifySnapshot(request);
    requireThat(payload.decision === "APPROVED" && request.state === "APPROVED" && request.snapshot_hash === payload.snapshot_hash && future(payload.expires_at_utc) && !this.db.prepare("SELECT decision_id FROM ow_decision_revocations WHERE decision_id=?").get(decision.id), 409, "APPROVAL_NOT_CURRENT");
    requireThat(binding.case_id === row.id && binding.strategy_id === row.strategy_id && binding.instance_id === row.instance_id && binding.gate === gate && binding.baseline_hash === row.baseline_hash && (gate === "DEVELOPMENT" || binding.candidate_hash === row.candidate_hash) && (!recipientId || binding.recipient_id === recipientId) && (!test || binding.authorized_tests.includes(test)), 409, "APPROVAL_SCOPE_MISMATCH");
    this.artifactFor(row, binding.artifact_id);
    return { decision, payload, binding };
  }
  verifySnapshot(request) {
    const snapshot = JSON.parse(request.snapshot_json);
    requireThat(objectHash(snapshot) === request.snapshot_hash && snapshot.request_id === request.id && snapshot.case_id === request.case_id && snapshot.gate === request.gate && snapshot.artifact_id === request.artifact_id && snapshot.baseline_hash === request.baseline_hash && snapshot.candidate_hash === request.candidate_hash && snapshot.recipient_id === request.recipient_id && objectHash(snapshot.authorized_tests) === objectHash(JSON.parse(request.tests_json)) && snapshot.expires_at_utc === request.expires_at_utc, 409, "APPROVAL_SNAPSHOT_TAMPERED");
  }
  transition(actor, data) {
    exactKeys(data, ["case_id", "expected_revision", "action", "to_stage", "artifact_id", "artifact_ids", "decision_id", "owner_id", "next_action"]);
    const row = this.caseFor(actor, data.case_id, "case.transition"); this.expect(row, data.expected_revision);
    requireThat(row.stage !== "CLOSED" && row.work_status !== "CANCELLED", 409, "CASE_TERMINAL");
    let stage = row.stage; let status = row.work_status; let owner = row.owner_id; let waiting = null; let candidate = row.candidate_hash;
    if (data.action === "advance") {
      this.active(row); this.baseline(row);
      const rule = TABLE.normal_transitions.find((entry) => entry.from === row.stage && entry.to === data.to_stage);
      requireThat(rule && rule.roles.includes(actor.role), 409, "INVALID_OR_UNAUTHORIZED_TRANSITION");
      if (rule.artifact) {
        const artifact = this.artifactFor(row, data.artifact_id, rule.artifact);
        if (rule.artifact === "CANDIDATE") {
          const development = this.approved(row, "DEVELOPMENT");
          requireThat(JSON.parse(artifact.dependencies_json).includes(development.binding.artifact_id), 409, "CANDIDATE_RECOMMENDATION_DEPENDENCY_REQUIRED");
          requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.candidate_hash || ""), 422, "CANDIDATE_HASH_REQUIRED");
          candidate = artifact.candidate_hash;
        }
      }
      if (rule.artifacts) {
        requireThat(Array.isArray(data.artifact_ids), 422, "CLOSURE_ARTIFACTS_REQUIRED");
        for (const kind of rule.artifacts) requireThat(data.artifact_ids.some((key) => this.artifactFor(row, key).kind === kind), 409, "FINAL_OUTCOME_AND_LESSON_REQUIRED");
      }
      if (rule.gate) this.approved(row, rule.gate, data.decision_id);
      if (rule.handoff_gate) {
        const handed = this.db.prepare("SELECT * FROM ow_handoffs WHERE case_id=? AND state IN ('ACKNOWLEDGED','WORK_IN_PROGRESS','RESULT_RETURNED','CLOSED')").all(row.id);
        requireThat(handed.filter((handoff) => JSON.parse(handoff.payload_json).gate === rule.handoff_gate).some((handoff) => {
          const verified = this.approved(row, rule.handoff_gate, handoff.decision_id, handoff.recipient_id);
          return verified && (actor.role === "HUMAN" || handoff.recipient_id === actor.id);
        }), 409, "RECIPIENT_ACKNOWLEDGEMENT_REQUIRED");
      }
      if (rule.subtests) {
        const tasks = this.db.prepare("SELECT * FROM ow_tasks WHERE case_id=?").all(row.id);
        requireThat(rule.subtests.every((kind) => tasks.some((task) => task.kind === kind && ["PASS", "NOT_APPLICABLE"].includes(task.status) && task.artifact_id)), 409, "REQUIRED_SUBTESTS_INCOMPLETE");
      }
      stage = rule.to; status = stage === "CLOSED" ? "COMPLETED" : "READY";
      const ownerRole = { EVIDENCE: "BRAIN", RESEARCH: "BRAIN", CANDIDATE_DEVELOPMENT: "STRATEGY", HISTORICAL_VALIDATION: "STRATEGY", CANDIDATE_EVALUATION: "BRAIN", FORWARD_VALIDATION: "STRATEGY", FORWARD_EVALUATION: "BRAIN", POST_DEPLOYMENT_VALIDATION: "STRATEGY", RETROSPECTIVE: "BRAIN" }[stage];
      owner = ownerRole ? this.config.identities.find((entry) => entry.role === ownerRole && entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id))?.identity_id : "wayne-ocean-ui";
      requireThat(owner, 409, "NEXT_OWNER_BINDING_REQUIRED");
      if (stage === "HISTORICAL_VALIDATION") for (const kind of ["BACKTEST", "ROBUSTNESS", "WALK_FORWARD", "OOS_HOLDOUT"]) this.db.prepare("INSERT INTO ow_tasks VALUES(?,?,?,'NOT_RUN',NULL,1)").run(`${row.id}:${kind}`, row.id, kind);
    } else {
      const branch = TABLE.branches[data.action];
      requireThat(branch && branch.roles.includes(actor.role), 403, "BRANCH_ACTOR_REJECTED");
      if (["no_benefit", "rollback_review"].includes(data.action)) { this.active(row); this.baseline(row); }
      if (["resume", "retry"].includes(data.action)) {
        requireThat(["PAUSED", "BLOCKED", "FAILED"].includes(row.work_status), 409, "RESUME_NOT_REQUIRED");
        this.baseline(row);
        const latest = this.db.prepare("SELECT * FROM ow_decisions WHERE case_id=? ORDER BY rowid DESC LIMIT 1").get(row.id);
        if (latest) this.approved(row, JSON.parse(latest.binding_json).gate, latest.id);
      }
      if (branch.requires_artifact) this.artifactFor(row, data.artifact_id, branch.requires_artifact);
      if (data.action === "block") {
        id(data.owner_id); requireThat(typeof data.next_action === "string" && data.next_action.length > 0, 422, "BLOCKER_OWNER_AND_ACTION_REQUIRED");
        owner = data.owner_id; waiting = data.next_action;
        this.db.prepare("INSERT INTO ow_blockers VALUES(?,?,?,?,'OPEN')").run(`test-blocker-${randomUUID()}`, row.id, owner, waiting);
      }
      stage = branch.to || stage;
      status = { pause: "PAUSED", resume: "READY", cancel: "CANCELLED", fail: "FAILED", block: "BLOCKED", retry: "READY", no_benefit: "READY", rollback_review: "READY" }[data.action];
      if (["resume", "retry"].includes(data.action)) this.db.prepare("UPDATE ow_blockers SET state='RESOLVED' WHERE case_id=? AND state='OPEN'").run(row.id);
    }
    this.db.prepare("UPDATE ow_cases SET revision=revision+1,stage=?,work_status=?,candidate_hash=?,owner_id=?,waiting_on=? WHERE id=?").run(stage, status, candidate, owner, waiting, row.id);
    this.event(row.id, "case.transition", actor, { action: data.action, before: { stage: row.stage, work_status: row.work_status }, after: { stage, work_status: status }, affects_trading_controls: false });
    return this.readCase(actor, row.id);
  }
  createHandoff(actor, data) {
    exactKeys(data, ["handoff_id", "case_id", "decision_id", "gate", "recipient_id", "authorized_test"]);
    id(data.handoff_id, true);
    const row = this.caseFor(actor, data.case_id, "case.transition"); this.active(row);
    const approval = this.approved(row, data.gate, data.decision_id, data.recipient_id, data.authorized_test);
    requireThat(row.stage === { DEVELOPMENT: "DEVELOPMENT_HANDOFF", SHADOW: "SHADOW_HANDOFF", PRODUCTION: "DEPLOYMENT_HANDOFF", ROLLBACK: "ROLLBACK_HANDOFF" }[data.gate], 409, "WRONG_HANDOFF_STAGE");
    const strategy = this.one("ow_strategies", row.strategy_id);
    const artifact = this.artifactFor(row, approval.binding.artifact_id);
    const manifest = JSON.parse(artifact.manifest_json);
    const instruction = ["# Ocean Approved TEST Handoff", "", "S20 synthetic acceptance only. No actual candidate changes, Sierra commands or live-money actions are authorised.", "", `Case: ${row.id}`, `Strategy: ${row.strategy_id}`, `Profile reference: ${strategy.profile_id}`, `Instance: ${row.instance_id}`, `Run: ${row.run_id}`, `Gate: ${data.gate}`, `Recommendation/artifact: ${artifact.id}`, `Artifact content hash: ${manifest.content_hash}`, `Request: ${approval.payload.request_id}`, `Decision: ${approval.decision.id}`, `Decision snapshot hash: ${approval.payload.snapshot_hash}`, `Baseline: ${row.baseline_hash}`, `Candidate: ${row.candidate_hash || "not yet developed"}`, `Intended recipient: ${data.recipient_id}`, `Permitted tests: ${approval.binding.authorized_tests.join(", ")}`, `Dependency artifact IDs: ${JSON.parse(artifact.dependencies_json).join(", ") || "none"}`, "", "## Verification Before Work", "Re-read the authenticated Ocean decision and immutable artifact. Refuse expired, revoked, changed-baseline, wrong-instance or wrong-recipient authority. Download is not acknowledgement. Existing chat/tooling binding remains PENDING S23; this TEST instruction is not a production handoff.", "", "## Approved Concept, Evidence, Risks And Scope", "The following is the exact approved snapshot; absent supporting/contradicting evidence or risks are not invented.", "", Buffer.from(artifact.content).toString("utf8"), ""].join("\n");
    const payload = { namespace: "TEST", gate: data.gate, authorized_test: data.authorized_test, download_is_acknowledgement: false, actual_execution_allowed: false, instruction_md: instruction, instruction_hash: digest(instruction) };
    this.db.prepare("INSERT INTO ow_handoffs VALUES(?,?,?,?,?,1,'CREATED',?)").run(data.handoff_id, row.id, approval.binding.artifact_id, approval.decision.id, data.recipient_id, JSON.stringify(payload));
    this.event(row.id, "handoff.create", actor, { handoff_id: data.handoff_id });
    return { handoff_id: data.handoff_id, state: "CREATED", revision: 1, namespace: "TEST" };
  }
  handoffEvent(actor, data) {
    exactKeys(data, ["handoff_id", "expected_revision", "state", "result_artifact_id", "reason"]);
    const handoff = this.one("ow_handoffs", data.handoff_id);
    const row = this.caseFor(actor, handoff.case_id, "case.transition"); this.active(row); this.expect(handoff, data.expected_revision);
    const payload = JSON.parse(handoff.payload_json);
    this.approved(row, payload.gate, handoff.decision_id, handoff.recipient_id, payload.authorized_test);
    const path = TABLE.handoff_lifecycle; const position = path.indexOf(handoff.state);
    const retry = ["FAILED", "BLOCKED"].includes(handoff.state) && data.state === "READY";
    requireThat(data.state === path[position + 1] || retry || (["FAILED", "BLOCKED"].includes(data.state) && data.reason && handoff.state !== "CLOSED"), 409, "INVALID_HANDOFF_TRANSITION");
    if (["ACKNOWLEDGED", "WORK_IN_PROGRESS", "RESULT_RETURNED"].includes(data.state)) requireThat(actor.role !== "HUMAN" && actor.id === handoff.recipient_id, 403, "RECIPIENT_ACCEPTANCE_REQUIRED");
    else if (["FAILED", "BLOCKED"].includes(data.state)) requireThat(actor.role === "HUMAN" || actor.id === handoff.recipient_id, 403, "HANDOFF_FAILURE_REPORTER_REJECTED");
    else requireThat(actor.role === "HUMAN", 403, "HUMAN_TRANSPORT_REQUIRED");
    if (["FAILED", "BLOCKED"].includes(data.state)) payload.delivery_error = data.reason;
    if (retry) payload.delivery_error = null;
    if (data.state === "RESULT_RETURNED") {
      const artifact = this.artifactFor(row, data.result_artifact_id);
      requireThat(artifact.producer_id === actor.id, 403, "WRONG_RESULT_PRODUCER");
      payload.result_artifact_id = artifact.id;
    }
    if (data.state === "DISPATCHED") {
      const wire = { schema_version: RELEASE, handoff_id: handoff.id, correlation_id: handoff.id, strategy_id: row.strategy_id, run_id: row.run_id, sender_id: actor.id, recipient_id: handoff.recipient_id, status: "DISPATCHED", dispatched_at_utc: new Date().toISOString(), acknowledged_at_utc: null, completed_at_utc: null, artifact_ids: [handoff.artifact_id], result_id: null, error: null };
      this.validate("handoff", wire); payload.wire = wire;
    }
    this.db.prepare("UPDATE ow_handoffs SET revision=revision+1,state=?,payload_json=? WHERE id=?").run(data.state, JSON.stringify(payload), handoff.id);
    this.event(row.id, "handoff.event", actor, { handoff_id: handoff.id, before: handoff.state, after: data.state, reason: data.reason || null }, data.state === "DISPATCHED" ? handoff.recipient_id : null);
    return { handoff_id: handoff.id, state: data.state, revision: handoff.revision + 1 };
  }
  claim(actor, data) {
    exactKeys(data, ["strategy_id", "instance_id"]);
    this.authorize(actor, "delivery", data.strategy_id, data.instance_id);
    requireThat(actor.role !== "HUMAN", 403, "SERVICE_DELIVERY_IDENTITY_REQUIRED");
    const boxes = this.db.prepare("SELECT o.* FROM ow_outbox o JOIN ow_cases c ON c.id=o.entity_id WHERE o.recipient_id=? AND c.strategy_id=? AND c.instance_id=? AND o.state IN ('PENDING','FAILED','LEASED') AND o.next_attempt_ms<=? AND (o.lease_until_ms IS NULL OR o.lease_until_ms<=?) ORDER BY o.rowid LIMIT 20").all(actor.id, data.strategy_id, data.instance_id, Date.now(), Date.now());
    const claimed = [];
    for (const box of boxes) {
      const row = this.one("ow_cases", box.entity_id);
      if (row.strategy_id !== data.strategy_id || row.instance_id !== data.instance_id) continue;
      const event = JSON.parse(box.payload_json);
      requireThat(objectHash(event) === box.payload_hash, 409, "IMMUTABLE_OUTBOX_TAMPERED");
      if (event.action === "handoff.event" && event.payload.after === "DISPATCHED") {
        try {
          this.active(row);
          const handoff = this.one("ow_handoffs", event.payload.handoff_id); const payload = JSON.parse(handoff.payload_json);
          this.approved(row, payload.gate, handoff.decision_id, handoff.recipient_id, payload.authorized_test);
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          this.db.prepare("UPDATE ow_outbox SET state='DEAD_LETTER',lease_id=NULL,lease_until_ms=NULL,last_error=? WHERE id=?").run(error.code, box.id);
          continue;
        }
      }
      if (box.attempts >= 5) { this.db.prepare("UPDATE ow_outbox SET state='DEAD_LETTER' WHERE id=?").run(box.id); continue; }
      const lease = randomUUID();
      this.db.prepare("UPDATE ow_outbox SET state='LEASED',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?").run(lease, Date.now() + this.leaseMs, box.id);
      claimed.push({ outbox_id: box.id, lease_id: lease, payload_hash: box.payload_hash, payload: JSON.parse(box.payload_json), attempts: box.attempts + 1 });
    }
    return { items: claimed, namespace: "TEST" };
  }
  finishDelivery(operation, actor, data) {
    exactKeys(data, ["outbox_id", "lease_id", "payload_hash", "error"]);
    const box = this.one("ow_outbox", data.outbox_id); const row = this.one("ow_cases", box.entity_id);
    this.authorize(actor, "delivery", row.strategy_id, row.instance_id);
    requireThat(actor.role !== "HUMAN" && box.recipient_id === actor.id && box.state === "LEASED" && box.lease_id === data.lease_id && box.lease_until_ms > Date.now() && box.payload_hash === data.payload_hash, 409, "STALE_OR_FOREIGN_DELIVERY_LEASE");
    const failed = operation === "outbox.fail";
    if (failed) requireThat(typeof data.error === "string" && data.error.length > 0 && data.error.length <= 200, 422, "BOUNDED_ERROR_REQUIRED");
    const state = failed ? box.attempts >= 5 ? "DEAD_LETTER" : "FAILED" : "ACKNOWLEDGED";
    this.db.prepare("UPDATE ow_outbox SET state=?,next_attempt_ms=?,lease_id=NULL,lease_until_ms=NULL,last_error=? WHERE id=?").run(state, Date.now() + (failed ? Math.min(60_000, 1000 * 2 ** box.attempts) : 0), failed ? data.error : null, box.id);
    this.event(row.id, operation, actor, { outbox_id: box.id, state });
    return { outbox_id: box.id, state, analysis_complete: false };
  }
  readCase(actor, caseId) {
    const row = this.caseFor(actor, caseId, "read");
    return { case_id: row.id, strategy_id: row.strategy_id, execution_instance_id: row.instance_id, run_id: row.run_id, stage: row.stage, work_status: row.work_status, revision: row.revision, baseline_hash: row.baseline_hash, candidate_hash: row.candidate_hash, owner_id: row.owner_id, waiting_on: row.waiting_on, next_action: row.waiting_on || `Complete ${row.stage} prerequisites; propose a revision-checked transition`, namespace: "TEST", pending_sync: this.db.prepare("SELECT COUNT(*) AS n FROM ow_outbox WHERE entity_id=? AND state<>'ACKNOWLEDGED'").get(row.id).n, handoffs: this.db.prepare("SELECT id,recipient_id,state,revision FROM ow_handoffs WHERE case_id=?").all(row.id), tasks: this.db.prepare("SELECT kind,status,artifact_id,required FROM ow_tasks WHERE case_id=? ORDER BY kind").all(row.id), approvals: this.db.prepare("SELECT id,gate,state,snapshot_hash,expires_at_utc FROM ow_approval_requests WHERE case_id=? ORDER BY rowid").all(row.id), blockers: this.db.prepare("SELECT id,owner_id,action,state FROM ow_blockers WHERE case_id=?").all(row.id) };
  }
  readDecision(actor, decisionId) {
    const decision = this.one("ow_decisions", decisionId); const row = this.caseFor(actor, decision.case_id, "read"); const binding = JSON.parse(decision.binding_json);
    requireThat(actor.role === "HUMAN" || binding.recipient_id === actor.id, 403, "DECISION_RECIPIENT_REQUIRED");
    let current = false; let blockedReason = null;
    try { this.active(row); this.approved(row, binding.gate, decision.id, binding.recipient_id); current = true; }
    catch (error) { if (!(error instanceof WorkflowError)) throw error; blockedReason = error.code; }
    return { decision: JSON.parse(decision.payload_json), binding, current_test_authority: current, operational_action_allowed: false, blocked_reason: blockedReason, revoked: !!this.db.prepare("SELECT decision_id FROM ow_decision_revocations WHERE decision_id=?").get(decision.id), baseline_current: row.baseline_hash === this.one("ow_strategies", row.strategy_id).baseline_hash };
  }
  readRun(actor, runId) {
    const run = this.one("ow_runs", runId); this.authorize(actor, "read", run.strategy_id, run.instance_id);
    return { context: JSON.parse(run.context_json), state: run.state, revision: run.revision, namespace: "TEST", reservation_is_actual_sierra_start: false, manager: this.runs.managed(run.id) ? this.runs.read(actor,run.id) : null, events: this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? ORDER BY id DESC LIMIT 200").all(run.id).map((row) => JSON.parse(row.payload_json)) };
  }
  readStrategyEntity(actor, table, entityId) {
    const row = this.one(table, entityId);
    const strategy = table === "ow_strategies" ? row.id : row.strategy_id;
    if (actor.role !== "HUMAN") {
      const instance = table === "ow_instances" ? row.id : actor.instanceIds.find((key) => this.db.prepare("SELECT strategy_id FROM ow_instances WHERE id=?").get(key)?.strategy_id === strategy);
      this.authorize(actor, "read", strategy, instance);
    }
    return { payload: JSON.parse(row.payload_json), namespace: "TEST", immutable: ["ow_profiles", "ow_datasets"].includes(table), ...(row.revision ? { revision: row.revision } : {}), operational_action_allowed: false };
  }
  readHandoff(actor, handoffId) {
    const handoff = this.one("ow_handoffs", handoffId); const row = this.caseFor(actor, handoff.case_id, "read");
    requireThat(actor.role === "HUMAN" || actor.id === handoff.recipient_id, 403, "HANDOFF_RECIPIENT_REQUIRED");
    const payload = JSON.parse(handoff.payload_json);
    this.active(row); this.approved(row, payload.gate, handoff.decision_id, handoff.recipient_id, payload.authorized_test);
    requireThat(digest(payload.instruction_md) === payload.instruction_hash, 409, "IMMUTABLE_HANDOFF_TAMPERED");
    return { handoff_id: handoff.id, case_id: row.id, state: handoff.state, revision: handoff.revision, recipient_id: handoff.recipient_id, ...payload };
  }
  download(actor, artifactId) {
    const artifact = this.one("ow_artifacts", artifactId);
    const row = this.caseFor(actor, artifact.case_id, "read");
    requireThat(actor.role === "HUMAN" || actor.id === artifact.recipient_id || actor.id === artifact.producer_id, 403, "EVIDENCE_DOWNLOAD_DENIED");
    this.artifactFor(row, artifact.id);
    const manifest = JSON.parse(artifact.manifest_json);
    return { manifest, content: Buffer.from(artifact.content), preview_text: manifest.media_type === "image/png" ? null : Buffer.from(artifact.content).toString("utf8").replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ch])) };
  }
  async handle(request, response, requestUrl) {
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith("/api/workflow/") && pathname !== "/api/workflow") return false;
    response.setHeader("Content-Type", "application/json; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      requireThat(!requestUrl.search && !/%(?:2f|5c)|\.\./i.test(pathname), 400, "UNSAFE_ROUTE_OR_QUERY");
      const route = pathname.slice("/api/workflow/".length);
      if (route === 'readiness' && request.method === 'GET') {
        this.auth.browserOrigin(request);
        requireThat(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress),403,'LOOPBACK_REQUIRED');
        response.end(JSON.stringify({machine:this.maintenanceHealth?.state==='ERROR'?'DEGRADED':this.auth.readiness().machine_readiness,human:this.auth.human.state,integrations:'PENDING',execution:'TEST_ONLY',ingestion:'OFF',maintenance:this.maintenanceHealth?.state || 'NOT_INSTALLED_ISOLATED'}));return true;
      }
      if (route === "session" && request.method === "POST") {
        const input = await jsonBody(request); response.end(JSON.stringify(this.auth.login(request, input, response))); return true;
      }
      const mutation = request.method !== "GET";
      const actor = this.auth.authenticate(request, mutation);
      requireThat(actor.namespace!=='OPERATIONAL' || route.startsWith(`${OPERATIONAL_PREFIX}/`),403,'OPERATIONAL_IDENTITY_ON_TEST_ROUTE');
      if(route==='integrations/v1/status' && request.method==='GET') {
        response.end(JSON.stringify(integrationStatus(this,actor)));return true;
      }
      if(route.startsWith(`${OPERATIONAL_PREFIX}/`)) {
        const local=route.slice(OPERATIONAL_PREFIX.length+1);let result;
        requireThat(actor.role==='HUMAN' || actor.scopes.includes('read'),403,'WRONG_ACTION_SCOPE');
        if(local==='policy' && request.method==='GET')result=operationalPolicy(this.config);
        else if(local==='pending' && request.method==='GET')result=this.operational.pending(actor);
        else if((local==='runs' || local.startsWith('receipts/')) && request.method==='GET')result=this.operational.read(actor,local.startsWith('receipts/')?local.slice(9):null);
        else if(local==='dataset-manifests' && request.method==='POST')result=this.operational.manifest(actor,await jsonBody(request));
        else if(['reviews','decisions','decisions/revoke','runs/prepare'].includes(local) && request.method==='POST')result=new OperationalPreparation(this).perform(local,actor,await jsonBody(request));
        else if(['activate','context/resolve','events'].includes(local) && request.method==='POST')result=this.operational.perform(local,actor,await jsonBody(request));
        else throw new WorkflowError(404,'UNKNOWN_OPERATIONAL_ROUTE');
        response.end(JSON.stringify(result));return true;
      }
      if (route.startsWith(`${TEST_PREFIX}/`)) {
        const local=route.slice(TEST_PREFIX.length+1);
        let result;
        if(request.method==='GET' && local==='capabilities')result=this.testCommunication.readiness(actor);
        else if(request.method==='POST' && local==='receipts')result=this.testCommunication.write(actor,await jsonBody(request));
        else if(request.method==='GET' && /^(?:receipts|fixtures)\/[A-Za-z0-9_.:-]+(?:\/download)?$/.test(local)) {
          const [kind,key,download]=local.split('/');
          result=kind==='receipts'?this.testCommunication.receipt(actor,key):this.testCommunication.readFixture(actor,key);
          if(download) {
            const content=kind==='receipts'?result.data.content:result.handoff?.instruction_md;
            requireThat(typeof content==='string',404,'TEST_DOWNLOAD_NOT_AVAILABLE');
            response.setHeader('Content-Type','application/octet-stream');
            response.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
            response.setHeader('Content-Disposition',`attachment; filename="${key}.txt"`);
            response.end(content);return true;
          }
        } else throw new WorkflowError(404,'UNKNOWN_TEST_ROUTE');
        response.end(JSON.stringify(result));return true;
      }
      if (route === 'auth/probe' && request.method === 'POST') {
        requireThat(actor.role !== 'HUMAN',403,'SERVICE_ONLY');
        const input=await jsonBody(request);exactKeys(input,['strategy_id','instance_id','action']);
        requireThat(actor.scopes.includes(input.action),403,'WRONG_ACTION_SCOPE');
        requireThat(actor.strategyIds.includes(input.strategy_id),403,'WRONG_STRATEGY_SCOPE');
        requireThat(actor.instanceIds.includes(input.instance_id),403,'WRONG_INSTANCE_SCOPE');
        response.end(JSON.stringify({authenticated:true,identity_id:actor.id,namespace:'TEST',operational_action_allowed:false}));return true;
      }
      if (route === "session" && request.method === "GET") { response.end(JSON.stringify(this.auth.sessionInfo(request, actor))); return true; }
      if (route === "session/logout" && request.method === "POST") { this.auth.logout(request, actor, response); response.end(JSON.stringify({ signed_out: true })); return true; }
      if (request.method === "GET") {
        if (route === "run-manager/options") response.end(JSON.stringify(this.runs.options(actor)));
        else if (/^run-manager\/context\/[A-Za-z0-9_.:-]+$/.test(route)) response.end(JSON.stringify(this.runs.read(actor,route.split('/')[2])));
        else if (route.startsWith("view/")) response.end(JSON.stringify(readWorkflowView(this, actor, route)));
        else if (route === "status") response.end(JSON.stringify({ api_version: API_VERSION, contract_release: RELEASE, namespace: "TEST", brain_submission: "OFF", live_real: "DISABLED", dispatch_worker: "OFF", auth: "REQUIRED", schema_version: 6, identity: { id: actor.id, role: actor.role, scopes: actor.scopes, strategy_ids: actor.strategyIds, instance_ids: actor.instanceIds }, ...this.auth.readiness(), test_communication:this.testCommunication.readiness(actor), maintenance:this.maintenanceHealth || {state:'NOT_INSTALLED_ISOLATED'} }));
        else if (route === 'setup-receipts') {
          requireThat(actor.role === 'HUMAN',403,'WAYNE_BROWSER_ONLY');
          response.end(JSON.stringify({ items: orderedSetup(this.db.prepare('SELECT * FROM ow_setup_receipts').all()), order: 'declared setup-task-map sequence; literal amendment IDs; historical statuses preserved' }));
        }
        else if (/^cases\/[A-Za-z0-9_.:-]+$/.test(route)) response.end(JSON.stringify(this.readCase(actor, route.slice(6))));
        else if (route === "cases") {
          const rows = actor.role === "HUMAN" ? this.db.prepare("SELECT id FROM ow_cases ORDER BY rowid DESC LIMIT 200").all() : this.db.prepare(`SELECT id FROM ow_cases WHERE strategy_id IN (${actor.strategyIds.map(() => "?").join(",")}) AND instance_id IN (${actor.instanceIds.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 200`).all(...actor.strategyIds, ...actor.instanceIds);
          response.end(JSON.stringify({ items: rows.map((row) => this.readCase(actor, row.id)), limit: 200 }));
        }
        else if (/^runs\/[A-Za-z0-9_.:-]+$/.test(route)) response.end(JSON.stringify(this.readRun(actor, route.slice(5))));
        else if (/^(?:profiles|strategies|instances|datasets)\/[A-Za-z0-9_.:-]+$/.test(route)) {
          const [collection, key] = route.split("/"); const tables = { profiles: "ow_profiles", strategies: "ow_strategies", instances: "ow_instances", datasets: "ow_datasets" };
          response.end(JSON.stringify(this.readStrategyEntity(actor, tables[collection], key)));
        }
        else if (/^cases\/[A-Za-z0-9_.:-]+\/history$/.test(route)) {
          const row = this.caseFor(actor, route.split("/")[1], "read"); response.end(JSON.stringify({ items: this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? ORDER BY id DESC LIMIT 200").all(row.id).map((event) => JSON.parse(event.payload_json)), limit: 200 }));
        }
        else if (/^health\/[A-Za-z0-9_.:-]+$/.test(route)) {
          const instance = this.one("ow_instances", route.slice(7)); this.authorize(actor, "read", instance.strategy_id, instance.id);
          const items = this.db.prepare("SELECT payload_json FROM ow_health WHERE strategy_id=? AND instance_id=?").all(instance.strategy_id, instance.id).map((row) => { const health = JSON.parse(row.payload_json); return { ...health, stale: Date.now()-Date.parse(health.observed_at_utc)>120000 }; });
          response.end(JSON.stringify({ items, namespace: "TEST", readiness: items.length ? "OBSERVED_TEST_HEALTH_ONLY" : "PENDING_S23_PROVIDER_BINDING" }));
        }
        else if (/^approvals\/[A-Za-z0-9_.:-]+$/.test(route)) {
          const approval = this.one("ow_approval_requests", route.slice(10)); this.caseFor(actor, approval.case_id, "read"); this.verifySnapshot(approval);
          response.end(JSON.stringify({ request_id: approval.id, state: approval.state, snapshot: JSON.parse(approval.snapshot_json), snapshot_hash: approval.snapshot_hash, expires_at_utc: approval.expires_at_utc, namespace: "TEST" }));
        }
        else if (/^handoffs\/[A-Za-z0-9_.:-]+(?:\/download)?$/.test(route)) {
          const handoff = this.readHandoff(actor, route.split("/")[1]);
          if (route.endsWith("/download")) { response.setHeader("Content-Type", "application/octet-stream"); response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'"); response.setHeader("Content-Disposition", `attachment; filename="${handoff.handoff_id}.md"`); response.end(handoff.instruction_md); }
          else response.end(JSON.stringify(handoff));
        }
        else if (/^artifacts\/[A-Za-z0-9_.:-]+(?:\/download)?$/.test(route)) {
          const artifactId = route.split("/")[1]; const artifact = this.download(actor, artifactId);
          if (route.endsWith("/download")) {
            response.setHeader("Content-Type", "application/octet-stream"); response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'"); response.setHeader("Content-Disposition", `attachment; filename="${artifactId}.txt"`); response.end(artifact.content);
          } else response.end(JSON.stringify({ manifest: artifact.manifest, preview_text: artifact.preview_text }));
        } else if (/^decisions\/[A-Za-z0-9_.:-]+$/.test(route)) {
          response.end(JSON.stringify(this.readDecision(actor, route.split("/")[1])));
        } else throw new WorkflowError(404, "UNKNOWN_ROUTE");
      } else {
        requireThat(request.method === "POST" && ROUTES[route], 404, "UNKNOWN_ROUTE");
        const result = this.mutate(ROUTES[route], actor, await jsonBody(request));
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      response.statusCode = error instanceof WorkflowError ? error.status : 500;
      response.end(JSON.stringify({ error: { code: error instanceof WorkflowError ? error.code : "WORKFLOW_INTERNAL_ERROR", message: error instanceof WorkflowError ? error.message : "Workflow operation failed", retryable: response.statusCode === 503 }, api_version: API_VERSION }));
    }
    return true;
  }
}
async function jsonBody(request) {
  requireThat(/^application\/json(?:;|$)/i.test(request.headers["content-type"] || ""), 415, "JSON_CONTENT_TYPE_REQUIRED");
  requireThat(!request.headers["content-encoding"] && (!request.headers["content-length"] || Number(request.headers["content-length"]) <= MAX_BODY_BYTES), 413, "BODY_TOO_LARGE_OR_ENCODED");
  const timer = setTimeout(() => request.destroy(), 5000); timer.unref();
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; requireThat(size <= MAX_BODY_BYTES, 413, "BODY_TOO_LARGE"); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new WorkflowError(400, "MALFORMED_JSON"); }
  } finally { clearTimeout(timer); }
}
export function workflowFromEnvironment(environment, python) {
  if (environment.OCEAN_WORKFLOW_ENABLED !== "1") return null;
  requireThat(environment.OCEAN_WORKFLOW_CONFIG && path.isAbsolute(environment.OCEAN_WORKFLOW_CONFIG), 503, "WORKFLOW_CONFIG_REFERENCE_REQUIRED");
  let config;
  let resolvedEnvironment = environment;
  if (environment.OCEAN_WORKFLOW_CONFIG.endsWith('.dpapi')) {
    requireThat(fs.existsSync(environment.OCEAN_WORKFLOW_CONFIG), 503, 'MACHINE_BOOTSTRAP_REQUIRED');
    const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../../../scripts/ocean-workflow-operator.ps1', import.meta.url)),'-Action','Runtime','-Root',path.dirname(environment.OCEAN_WORKFLOW_CONFIG)], { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 256*1024 });
    requireThat(result.status === 0, 503, 'PROTECTED_OPERATOR_STATE_UNAVAILABLE');
    const state = JSON.parse(result.stdout.replace(/^\uFEFF/,''));
    config = state.config;
    resolvedEnvironment = { ...environment, ...state.environment };
  } else config = JSON.parse(fs.readFileSync(environment.OCEAN_WORKFLOW_CONFIG, "utf8"));
  const forbidden = [environment.OCEAN_WEBSITE_DB || "D:\\OceanTradingData\\website\\ocean-trading-website.sqlite", environment.PATRADING_LIVE_SQLITE_FILE, environment.PATRADING_PAPER_SQLITE_FILE, environment.PATRADING_REPLAY_SQLITE_FILE].filter(Boolean);
  requireThat(typeof config.db_file === "string" && forbidden.every((file) => path.resolve(config.db_file).toLowerCase() !== path.resolve(file).toLowerCase()) && !/^TradeTelemetry.*\.sqlite$/i.test(path.basename(config.db_file)), 503, "LEGACY_DATABASE_REUSE_PROHIBITED");
  const backend=new WorkflowBackend({ ...config, python_executable: python }, resolvedEnvironment);
  if(environment.OCEAN_WORKFLOW_CONFIG.endsWith('.dpapi'))attachMaintenance(backend,environment.OCEAN_WORKFLOW_CONFIG);
  return backend;
}
