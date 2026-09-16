import fs from "node:fs";
import { ROUTES } from "./backend.mjs";
import { API_VERSION, RELEASE, ROLES } from "./common.mjs";

const reportFile = process.env.OCEAN_S20_FRONTEND_REPORT;
const acceptance = reportFile ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
const dataKeys = {
  "profile.register": ["profile", "file_sha256"],
  "strategy.register": ["registry", "baseline_hash", "expected_revision"],
  "instance.register": ["strategy_id", "instance"],
  "dataset.register": ["strategy_id", "manifest"], "plan.register": ["strategy_id", "manifest"],
  "run.register": ["context"], "case.register": ["case_id", "run_id"],
  "artifact.write": ["artifact_id", "case_id", "run_id", "recipient_id", "kind", "media_type", "content", "content_hash", "candidate_hash", "dependency_ids"],
  "approval.request": ["request_id", "case_id", "expected_revision", "gate", "artifact_id", "recipient_id", "authorized_tests", "expires_at_utc"],
  "approval.decide": ["decision_id", "request_id", "case_id", "expected_revision", "snapshot_hash", "decision", "reason"],
  "approval.revoke": ["decision_id", "reason"],
  "case.transition": ["case_id", "expected_revision", "action", "to_stage", "artifact_id", "artifact_ids", "decision_id", "owner_id", "next_action"],
  "task.result": ["case_id", "expected_revision", "kind", "status", "artifact_id"],
  "handoff.create": ["handoff_id", "case_id", "decision_id", "gate", "recipient_id", "authorized_test"],
  "handoff.event": ["handoff_id", "expected_revision", "state", "result_artifact_id", "reason"],
  "run.event": ["run_id", "expected_revision", "state", "observed_handshake", "completion", "open_pinned_trades", "pending_events"],
  "event.write": ["run_id", "event"], "health.write": ["strategy_id", "instance_id", "status", "next_owner", "next_action"],
  "setup.register": ["receipt_id", "receipt", "content_hash"],
  "outbox.claim": ["strategy_id", "instance_id"], "outbox.ack": ["outbox_id", "lease_id", "payload_hash", "error"], "outbox.fail": ["outbox_id", "lease_id", "payload_hash", "error"], "outbox.retry": ["outbox_id"],
};
const scopes = { "artifact.write": "artifact.write", "approval.request": "approval.request", "case.transition": "case.transition", "task.result": "case.transition", "handoff.event": "case.transition", "run.event": "event.write", "event.write": "event.write", "health.write": "health.write", "outbox.claim": "delivery", "outbox.ack": "delivery", "outbox.fail": "delivery" };
const bindings = {
  schema_version: "ocean-provider-binding/v1", api_version: API_VERSION, contract_release: RELEASE, migration_version: 1,
  provider: "OCEAN_TRADING", project: "Ocean Trading Website", namespace: "TEST", binding_status: "INSTALLED_SOURCE_TEST_ACCEPTED_PRODUCTION_DISABLED",
  configured_production_base_url: null, production_binding_owner: "S23", production_strategy_instances: "PENDING_S23", gateway_receiver: "PENDING_S23", brain_receiver: "PENDING_S28", remote_adapter_acceptance: "NOT_DUE_S29",
  actual_isolated_acceptance_url: acceptance?.base_url || null, acceptance_url_state: acceptance ? "CLOSED_AFTER_TEST" : "NOT_EXECUTED",
  implementation: { entrypoint: "website/ocean-trading/dashboard/server.mjs", module: "website/ocean-trading/dashboard/workflow/backend.mjs", config_flag: "OCEAN_WORKFLOW_ENABLED", config_reference: "OCEAN_WORKFLOW_CONFIG", config_example: "website/ocean-trading/dashboard/workflow/config.example.json", default_enabled: false, persistent_production_db: null },
  safety: { actual_execution_allowed: false, brain_submission: "OFF", live_real: "DISABLED", dispatch_worker: "OFF", setup_receipt_registration_due: "S29", setup_is_approval: false },
  auth: { provider: "OCEAN_TRADING", service_transport: "Authorization bearer; server-issued environment-injected values only", roles: ROLES, exact_strategy_and_instance_allowlists: true, general_brain_credential: "REJECTED", browser: { subject: "wayne-ocean-ui", login: "POST /api/workflow/session", login_body_keys: ["credential"], session_cookie: "ocean_workflow_session", csrf_header: "X-CSRF-Token", origin_and_host_validation: true, service_tokens_in_browser: false }, test_reference_names: ["OCEAN_BRAIN_TOKEN", "OCEAN_TELEMETRY_TOKEN", "OCEAN_STRATEGY_TOKEN", "OCEAN_WAYNE_BROWSER_SECRET"], unresolved_example_reference_names: ["OCEAN_BRAIN_CALLBACK_TOKEN", "OCEAN_TELEMETRY_GATEWAY_TOKEN", "OCEAN_STRATEGY_TOOLING_TOKEN"] },
  requests: { envelope_keys: ["message_id", "data"], message_id: "ASCII ID with test- prefix", additional_keys: "REJECTED", query_tokens_or_paths: "REJECTED", shared_payload_schema: "contracts/2.1.0/shared-contracts/shared-contracts.schema.json", field_semantics: "allowed_data_keys are not a waiver of required fields, shared-schema validation, optimistic revision, exact actor binding or gate prerequisites" },
  post_routes: Object.entries(ROUTES).map(([route, operation]) => ({ method: "POST", path: `/api/workflow/${route}`, operation, allowed_data_keys: dataKeys[operation], scope: scopes[operation] || "HUMAN_ONLY", constraints: operation === "run.event" ? "Only human control or trusted Telemetry; ACTIVE/COMPLETED require observed scoped Telemetry" : operation === "health.write" ? "Telemetry only" : "Exact server-side role/state/version/recipient checks" })),
  get_routes: ["status", "cases", "cases/{id}", "cases/{id}/history", "runs/{id}", "profiles/{id}", "strategies/{id}", "instances/{id}", "datasets/{id}", "approvals/{id}", "decisions/{id}", "artifacts/{id}", "artifacts/{id}/download", "handoffs/{id}", "handoffs/{id}/download", "health/{instance_id}"].map((route) => ({ method: "GET", path: `/api/workflow/${route}`, scope: "read; exact strategy/instance and artifact/handoff/decision recipient restrictions" })),
  errors: { shape: { error: { code: "stable uppercase code", message: "redacted code or non-secret explanation", retryable: "boolean" }, api_version: API_VERSION }, statuses: { 400: "malformed JSON/unsafe query", 401: "absent/invalid/expired/revoked credential", 403: "wrong actor/role/scope/origin/CSRF/TEST authority", 404: "unknown entity/route", 409: "revision/gate/hash/dedup/lease/reconciliation conflict", 413: "upload bound", 415: "JSON required", 422: "schema/payload rejected", 429: "queue/session/login capacity", 500: "redacted internal failure", 503: "new workflow disabled/unresolved validator or binding" } },
  limitations: ["No running production provider URL or real external credential binding is claimed", "Wire workflow-event persistence is not automatic transition/dispatch/analysis", "S20 is synthetic TEST acceptance, not Wayne runtime approval"],
};
const text = `${JSON.stringify(bindings, null, 2)}\n`;
if (process.argv[2]) fs.writeFileSync(process.argv[2], text);
else process.stdout.write(text);
