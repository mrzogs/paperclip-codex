import { requireThat, id } from './common.mjs';
import { orderedSetup } from './setup-operator.mjs';
import { operationalPolicy } from './operational-transition.mjs';

export const UI_API_VERSION = 'ocean-workflow-ui/v1';
const PAGE_SIZE = 50;
const parse = (row, field = 'payload_json') => JSON.parse(row[field]);
const pageOf = (db, table, offset, order = 'rowid DESC') => ({
  rows: db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`).all(PAGE_SIZE, offset),
  total: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
  offset, page_size: PAGE_SIZE,
});

// These human-only projections omit credential metadata and private source paths.
export function readWorkflowView(backend, actor, route) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  const db = backend.db;
  const parts = route.split('/');
  const collection = parts[1];
  const key = parts[2];
  const offset = parts[2] === 'page' ? Number(parts[3]) : 0;
  requireThat(parts.length <= 4 && Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000, 400, 'INVALID_VIEW_PAGE');
  const stamp = { view_version: UI_API_VERSION, namespace: 'TEST', refreshed_at_utc: new Date().toISOString() };
  const strategyName = (value) => parse(backend.one('ow_strategies', value)).strategy_name;
  const caseRow = (value) => ({ ...backend.readCase(actor, value.id), strategy_name: strategyName(value.strategy_id), priority: value.stage === 'ROLLBACK_REVIEW' ? 'URGENT_REVIEW' : null });
  const runRow = (value) => ({ ...backend.readRun(actor, value.id), strategy_name: strategyName(value.strategy_id) });
  const artifactRow = (value) => ({ artifact_id: value.id, case_id: value.case_id, kind: value.kind, producer_id: value.producer_id, recipient_id: value.recipient_id, candidate_hash: value.candidate_hash, dependency_ids: JSON.parse(value.dependencies_json), manifest: JSON.parse(value.manifest_json) });
  const setupRows = () => orderedSetup(db.prepare('SELECT payload_json FROM ow_setup_receipts').all()).map(row => {
    const receipt = parse(row);
    const status = receipt.status || receipt.final_status || 'UNKNOWN';
    const members = receipt.verified_members ? Object.keys(receipt.verified_members) : [];
    return {
      task_id: receipt.task_id,
      status,
      owner: receipt.owner || receipt.project || 'Not recorded',
      classification: 'HISTORICAL_SETUP_NOT_APPROVAL',
      verified_bundle_sha256: receipt.verified_bundle_sha256 || null,
      verified_member_count: members.length,
      diagnostic_preserved: ['S23', 'S23.1', 'S24', 'S26.1'].includes(receipt.task_id),
    };
  });
  const approvalRow = (value) => {
    backend.verifySnapshot(value);
    const row = backend.one('ow_cases', value.case_id);
    const decision = db.prepare('SELECT id FROM ow_decisions WHERE request_id=?').get(value.id);
    let reason = null;
    try {
      backend.active(row); backend.baseline(row); backend.artifactFor(row, value.artifact_id);
      requireThat(value.state === 'PENDING' && Date.parse(value.expires_at_utc) > Date.now(), 409, 'APPROVAL_NOT_PENDING_OR_EXPIRED');
      const gateStage = { ONBOARDING: 'DISCOVERY', DEVELOPMENT: 'DEVELOPMENT_REVIEW', SHADOW: 'SHADOW_REVIEW', PRODUCTION: 'DEPLOYMENT_REVIEW', ROLLBACK: 'ROLLBACK_REVIEW' };
      requireThat(gateStage[value.gate] === row.stage, 409, 'WRONG_GATE_STAGE');
    } catch (error) { reason = error.code || 'EVIDENCE_UNAVAILABLE'; }
    return { request_id: value.id, case_id: row.id, strategy_id: row.strategy_id, execution_instance_id: row.instance_id, strategy_name: strategyName(row.strategy_id), state: value.state, gate: value.gate, snapshot: JSON.parse(value.snapshot_json), snapshot_hash: value.snapshot_hash, expires_at_utc: value.expires_at_utc, case_revision: row.revision, actionable: !reason, blocked_reason: reason, decision: decision ? backend.readDecision(actor, decision.id) : null };
  };
  const strategyRow = (value) => {
    const registry = parse(value);
    const profile = parse(backend.one('ow_profiles', value.profile_id));
    return { strategy_id: value.id, strategy_name: registry.strategy_name, registry_revision: value.revision, activation_status: registry.activation_status, activation_decision_id: registry.activation_decision_id, baseline_version: registry.baseline_version, baseline_hash: value.baseline_hash, production_version: registry.production_version, profile: { profile_id: profile.profile_id, profile_version: profile.profile_version, profile_hash: profile.profile_hash, strategy_code_hash: profile.strategy_code_hash, strategy_config_hash: profile.strategy_config_hash }, cases: db.prepare('SELECT id FROM ow_cases WHERE strategy_id=? ORDER BY rowid DESC LIMIT 200').all(value.id).map(row => caseRow(backend.one('ow_cases', row.id))), cases_total: db.prepare('SELECT COUNT(*) AS n FROM ow_cases WHERE strategy_id=?').get(value.id).n };
  };
  if (collection === 'dashboard' && parts.length === 2) {
    const pending = db.prepare("SELECT * FROM ow_approval_requests WHERE state='PENDING' ORDER BY rowid DESC").all().map(approvalRow);
    const counts = {
      action_required: pending.filter(row => row.actionable).length,
      pending_gates: pending.length,
      urgent_reviews: db.prepare("SELECT COUNT(*) AS n FROM ow_cases WHERE stage='ROLLBACK_REVIEW' AND work_status<>'CANCELLED'").get().n,
      active_cases: db.prepare("SELECT COUNT(*) AS n FROM ow_cases WHERE stage<>'CLOSED' AND work_status NOT IN ('CANCELLED','BLOCKED','FAILED','PAUSED')").get().n,
      blocked_cases: db.prepare("SELECT COUNT(*) AS n FROM ow_cases WHERE work_status IN ('BLOCKED','FAILED')").get().n,
      active_runs: db.prepare("SELECT COUNT(*) AS n FROM ow_runs WHERE state IN ('READY','ACTIVE','COMPLETING')").get().n,
      pending_sync: db.prepare("SELECT COUNT(*) AS n FROM ow_outbox WHERE state<>'ACKNOWLEDGED'").get().n,
    };
    const health = db.prepare('SELECT payload_json FROM ow_health ORDER BY rowid DESC LIMIT 50').all().map(row => { const data = parse(row); return { ...data, stale: Date.now() - Date.parse(data.observed_at_utc) > 120000 }; });
    const setup = setupRows();
    const receipt = taskId => setup.find(row => row.task_id === taskId) || { task_id: taskId, status: 'NOT_IMPORTED', owner: 'Not recorded', classification: 'HISTORICAL_SETUP_NOT_APPROVAL', verified_bundle_sha256: null, verified_member_count: 0, diagnostic_preserved: ['S23', 'S23.1', 'S24', 'S26.1'].includes(taskId) };
    const policy = operationalPolicy(backend.config);
    const pendingOperational = backend.operational.pending(actor);
    return {
      ...stamp, counts, pending: pending.slice(0, 10),
      cases: db.prepare("SELECT * FROM ow_cases WHERE stage<>'CLOSED' ORDER BY CASE WHEN work_status IN ('BLOCKED','FAILED') THEN 0 ELSE 1 END, rowid DESC LIMIT 10").all().map(caseRow),
      health,
      history: db.prepare('SELECT payload_json FROM ow_events ORDER BY id DESC LIMIT 12').all().map(row => parse(row)),
      ...backend.auth.readiness(),
      provider_binding: {
        current_amended_provider: receipt('S23.3'),
        immutable_machine_foundation: receipt('S23.2'),
        persisted_receipts_total: setup.length,
        historical_diagnostics: ['S23', 'S23.1', 'S24', 'S26.1', 'S26.2', 'S31.2', 'S32.2'].map(receipt),
        receipt_order: 'setup-task-map sequence with literal amended IDs; diagnostics remain separate',
      },
      operational_readiness: {
        schema_version: policy.schema_version,
        replay_enabled: policy.modes.REPLAY.enabled,
        paper_forward_enabled: policy.modes.PAPER_FORWARD.enabled,
        live_real: policy.live_real,
        normal_ingestion: policy.normal_ingestion,
        future_owners: policy.future_owners,
        pending_items: pendingOperational.items.slice(0, 10),
        pending_total: pendingOperational.items.length,
      },
      setup_receipts: setup.slice(0, 12),
      dispatch_worker: 'OFF', brain_submission: 'OFF', live_real: 'DISABLED',
    };
  }
  const tables = { strategies: 'ow_strategies', cases: 'ow_cases', runs: 'ow_runs', approvals: 'ow_approval_requests', history: 'ow_events' };
  if (tables[collection] && (!key || key === 'page')) {
    requireThat(!key || /^\d+$/.test(parts[3] || ''), 400, 'INVALID_VIEW_PAGE');
    const page = pageOf(db, tables[collection], offset, collection === 'history' ? 'id DESC' : 'rowid DESC');
    const formatter = { strategies: strategyRow, cases: caseRow, runs: runRow, approvals: approvalRow, history: row => ({ event_id: row.id, ...parse(row) }) }[collection];
    const setup = collection === 'history' ? orderedSetup(db.prepare('SELECT payload_json FROM ow_setup_receipts').all()).map(row => {
      const receipt=parse(row);return {task_id:receipt.task_id,status:receipt.status,project:receipt.project,operator_id:receipt.operator_id || 'Historical operator',classification:'HISTORICAL_SETUP_NOT_APPROVAL'};
    }) : undefined;
    return { ...stamp, ...page, rows: undefined, items: page.rows.map(formatter), setup };
  }
  requireThat(key && parts.length === 3, 404, 'UNKNOWN_VIEW'); id(key);
  if (collection === 'strategies') {
    const strategy = strategyRow(backend.one('ow_strategies', key));
    const runs = db.prepare('SELECT * FROM ow_runs WHERE strategy_id=? ORDER BY rowid DESC LIMIT 200').all(key).map(runRow);
    const instances = db.prepare('SELECT payload_json FROM ow_instances WHERE strategy_id=?').all(key).map(row => parse(row));
    return { ...stamp, ...strategy, runs, runs_total: db.prepare('SELECT COUNT(*) AS n FROM ow_runs WHERE strategy_id=?').get(key).n, instances };
  }
  if (collection === 'runs') return { ...stamp, ...runRow(backend.one('ow_runs', key)) };
  if (collection === 'approvals') return { ...stamp, ...approvalRow(backend.one('ow_approval_requests', key)) };
  if (collection === 'cases') {
    const row = backend.one('ow_cases', key);
    const handoffs = db.prepare('SELECT * FROM ow_handoffs WHERE case_id=? ORDER BY rowid DESC LIMIT 200').all(key).map(handoff => {
      const data = parse(handoff);
      let authority = null;
      try { backend.readHandoff(actor, handoff.id); } catch (error) { authority = error.code || 'UNAVAILABLE'; }
      return { handoff_id: handoff.id, state: handoff.state, revision: handoff.revision, recipient_id: handoff.recipient_id, gate: data.gate, decision_id: handoff.decision_id, authorized_test: data.authorized_test, result_artifact_id: data.result_artifact_id || null, delivery_error: data.delivery_error || null, blocked_reason: authority };
    });
    return { ...stamp, ...caseRow(row), strategy: strategyRow(backend.one('ow_strategies', row.strategy_id)), run: runRow(backend.one('ow_runs', row.run_id)), artifacts: db.prepare('SELECT * FROM ow_artifacts WHERE case_id=? ORDER BY rowid DESC LIMIT 200').all(key).map(artifactRow), artifacts_total: db.prepare('SELECT COUNT(*) AS n FROM ow_artifacts WHERE case_id=?').get(key).n, approvals: db.prepare('SELECT * FROM ow_approval_requests WHERE case_id=? ORDER BY rowid DESC LIMIT 200').all(key).map(approvalRow), handoffs, history: db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? ORDER BY id DESC LIMIT 200').all(key).map(row => parse(row)), recipients: backend.config.identities.filter(entry => entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id)).map(entry => ({ identity_id: entry.identity_id, role: entry.role })), outbox: db.prepare('SELECT id,recipient_id,state,attempts,last_error FROM ow_outbox WHERE entity_id=? ORDER BY rowid DESC LIMIT 50').all(key) };
  }
  requireThat(false, 404, 'UNKNOWN_VIEW');
}

export function recordManualAcknowledgement(backend, actor, data) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  requireThat(Object.keys(data).every(key => ['handoff_id', 'expected_revision', 'note'].includes(key)), 422, 'UNKNOWN_OR_AUTHORITY_FIELD');
  const handoff = backend.one('ow_handoffs', data.handoff_id);
  backend.expect(handoff, data.expected_revision);
  backend.readHandoff(actor, handoff.id);
  requireThat(handoff.state === 'DISPATCHED', 409, 'HANDOFF_NOT_DISPATCHED');
  requireThat(typeof data.note === 'string' && data.note.trim().length > 0 && data.note.length <= 1000, 422, 'MANUAL_CONFIRMATION_NOTE_REQUIRED');
  const payload = { handoff_id: handoff.id, recipient_id: handoff.recipient_id, confirmation_type: 'MANUAL_OPERATOR_REPORT', note: data.note, recipient_authenticated: false, state_unchanged: handoff.state };
  backend.event(handoff.case_id, 'handoff.manual-confirmation', actor, payload);
  return payload;
}
