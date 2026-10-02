import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { activateStrategyOnboarding, deactivateStrategyOnboarding, loadStrategyOnboarding, ONBOARDING_STRATEGY_ID, pauseStrategyOnboarding, probeReplayTwoRuntime, readOnboardingActivationEvents, readOnboardingRegistration, readReplayCampaign, readStrategyOnboardingEvents, recordStrategyOnboarding, registerStrategyOnboarding } from './strategy-onboarding.mjs';
import { ROUTES, WorkflowBackend } from './backend.mjs';
import { readOnboardingBrainOutbox } from './onboarding-brain-sync.mjs';
import { WorkflowStore } from './store.mjs';

const files = {
  'strategy-registry.json': { strategy_id: ONBOARDING_STRATEGY_ID, strategy_name: 'VWAP Pullback', profile_id: 'profile-1', profile_version: 'v0.1.1', profile_hash: 'sha256:profile', baseline_version: 'v0.1.0', production_version: null, activation_status: 'PENDING_ONBOARDING', activation_decision_id: null },
  'strategy-profile.json': { strategy_id: ONBOARDING_STRATEGY_ID, strategy_name: 'VWAP Pullback', profile_id: 'profile-1', profile_version: 'v0.1.1', profile_hash: 'sha256:profile', baseline_version: 'v0.1.0', production_version: null, strategy_code_hash: 'sha256:code', strategy_config_hash: 'sha256:config', onboarding_status: 'PENDING_ONBOARDING' },
  'execution-instance.json': { strategy_id: ONBOARDING_STRATEGY_ID, execution_instance_id: 'test-replay-two', configuration_revision: 'v0.1.1-chart-alert-cleanup', account_alias: 'Sim1', symbol: 'MNQZ26_FUT_CME[M]', capabilities: [], status: 'PREPARED_NOT_REGISTERED', safety_state: { trade_simulation_mode: true, strategy_automated_order_placement: false, telemetry_logging: false, brain_submission: 'OFF', replay_started: false } },
  'replay-two-setup.json': { strategy_id: ONBOARDING_STRATEGY_ID, configuration_revision: 'v0.1.1-chart-alert-cleanup', status: 'PREPARED_NOT_ACTIVATED', last_verified_at: '2026-09-29T07:14:21Z', safety: { replay_started: false, paper_started: false, live_started: false } },
  'unresolved-items.json': { strategy_id: ONBOARDING_STRATEGY_ID, status: 'OPEN', items: [
    { id: 'U01', owner: 'Wayne', resolution_action: 'Assign owner.' }, { id: 'U03', owner: 'Wayne', resolution_action: 'Approve contract.' },
    { id: 'U18', owner: 'Wayne', resolution_action: 'Approve risk.' }, { id: 'U22', owner: 'Wayne/Ocean operator', resolution_action: 'Enroll telemetry.' },
    { id: 'U23', owner: 'Wayne/Ocean operator', resolution_action: 'Approve database policy.' }, { id: 'U27', owner: 'Wayne/strategy maintainer', resolution_action: 'Reconcile versions.' },
    { id: 'U24', owner: 'Wayne/Data owner', resolution_action: 'Qualify data.' }, { id: 'U25', owner: 'Wayne', resolution_action: 'Approve thresholds.' },
    { id: 'U26', owner: 'Wayne/Ocean operator', resolution_action: 'Approve non-live capabilities.' },
  ] },
  'replay-two-alert-remediation.json': { strategy_id: ONBOARDING_STRATEGY_ID, verified_through: '2026-09-29T07:14:21Z', diagnosis: { dll_rebuild_required: false }, fix: { alerts_enabled: false }, validation: { automated_order_placement: false, telemetry_logging: false } },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-onboarding-'));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  return root;
}

test('projects a validated isolated Replay campaign without granting Live authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-campaign-'));
  const statePath = path.join(root, 'state.json');
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version:'cicd-vwap-replay-campaign-state/v1', strategy_id:ONBOARDING_STRATEGY_ID,
      execution_instance_id:'test-cicd-vwap-pull-back-replay-two-v013', status:'RUNNING',
      current_window_id:'july-2025-u25', completed_windows:[], failed_windows:[],
      next_action:'Wait for the sealed July window.', live_real:'DISABLED',
    }));
    const result = readReplayCampaign(statePath);
    assert.equal(result.state, 'AVAILABLE');
    assert.equal(result.status, 'RUNNING');
    assert.equal(result.current_window_id, 'july-2025-u25');
    assert.equal(result.live_real, 'DISABLED');
    assert.match(result.state_sha256, /^sha256:[a-f0-9]{64}$/);

    fs.writeFileSync(statePath, JSON.stringify({
      schema_version:'cicd-vwap-replay-campaign-state/v1', strategy_id:ONBOARDING_STRATEGY_ID,
      execution_instance_id:'test-cicd-vwap-pull-back-replay-two-v013', status:'FAILED_ACCOUNT_INTEGRITY_RETRY_PENDING',
      current_window_id:'july-2025-u25', completed_windows:[], failed_windows:[{window_id:'july-2025-u25',exit_code:2}],
      next_action:'Install v229 and retry the clean Sim1 window.', live_real:'DISABLED',
    }));
    const failed = readReplayCampaign(statePath);
    assert.equal(failed.state, 'ATTENTION_REQUIRED');
    assert.equal(failed.status, 'FAILED_ACCOUNT_INTEGRITY_RETRY_PENDING');
    assert.match(failed.next_action, /v229/);
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('projects the current onboarding state from read-only source files', () => {
  const root = fixture();
  try {
    const result = loadStrategyOnboarding({ root });
    assert.equal(result.source.status, 'AVAILABLE');
    assert.equal(result.profile.validity, 'VALID');
    assert.deepEqual(result.progress, { checks: result.progress.checks, complete: 1, total: 3 });
    assert.equal(result.next_action.priority, 1);
    assert.ok(result.gates.every(gate => gate.state === 'OFF'));
    assert.equal(result.source_read_only, true);
    assert.equal(result.workflow_writable, true);
    assert.equal(result.active_questionnaire_id, 'test-setup-confirmation');
    assert.ok(result.questionnaires.every(questionnaire => questionnaire.status === 'PENDING'));
    assert.ok(!JSON.stringify(result).includes(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reports Replay monitor, exact Sierra binding and chart replay as separate read-only states', () => {
  const root = fixture();
  try {
    const result = loadStrategyOnboarding({
      root,
      runtimeProbe: () => ({
        monitor:{ state:'AVAILABLE', url:'/replay-monitor.html' },
        sierra:{ state:'OPEN_EXACT_CHARTBOOK_VERIFIED', executable:'D:\\Trading\\SierraChart-Replay Two\\SierraChart_64.exe', chartbook_path:'D:\\Trading\\SierraChart-Replay Two\\Data\\CICD - VWAP Pull Back Strategy.Cht', chart_id:'1', process_id:123, window_title:'CICD - VWAP Pull Back Strategy' },
        chart_replay:{ state:'NOT_RUNNING_VERIFIED', started:false, observed_at_utc:'2026-09-30T09:00:00Z', source:'test-controller' },
        manual_launch:{ available:false, reason:'NO_SAFE_DESKTOP_LAUNCH_BRIDGE', executable:'D:\\Trading\\SierraChart-Replay Two\\SierraChart_64.exe', chartbook_path:'D:\\Trading\\SierraChart-Replay Two\\Data\\CICD - VWAP Pull Back Strategy.Cht', account_alias:'Sim1', chart_id:'1' },
      }),
    });
    assert.equal(result.replay_runtime.monitor.url, '/replay-monitor.html');
    assert.equal(result.replay_runtime.sierra.state, 'OPEN_EXACT_CHARTBOOK_VERIFIED');
    assert.equal(result.replay_runtime.chart_replay.state, 'NOT_RUNNING_VERIFIED');
    assert.equal(result.replay_runtime.manual_launch.available, false);
    assert.equal(result.activation.actual_source_started, false);
    assert.ok(result.gates.every(gate => gate.state === 'OFF'));
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('fails closed when Replay Two runtime binding is absent', () => {
  const runtime = probeReplayTwoRuntime({});
  assert.equal(runtime.monitor.state, 'AVAILABLE');
  assert.equal(runtime.sierra.state, 'NOT_CONFIGURED');
  assert.equal(runtime.chart_replay.started, null);
  assert.equal(runtime.manual_launch.available, false);
  assert.equal(runtime.manual_launch.reason, 'NO_SAFE_DESKTOP_LAUNCH_BRIDGE');
});

test('records append-only drafts and immutable submissions without changing execution gates', () => {
  const root = fixture();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ow_events(id INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT,action TEXT,actor_id TEXT,actor_role TEXT,created_at_utc TEXT,payload_json TEXT);
    CREATE TABLE ow_onboarding_brain_outbox(id TEXT PRIMARY KEY,strategy_id TEXT,milestone_type TEXT,milestone_id TEXT UNIQUE,payload_hash TEXT,payload_json TEXT,state TEXT,attempts INTEGER DEFAULT 0,next_attempt_ms INTEGER,lease_id TEXT,lease_until_ms INTEGER,brain_record_id TEXT,brain_relative_path TEXT,last_error TEXT,created_at_utc TEXT,acknowledged_at_utc TEXT);
  `);
  const backend = {
    config: { strategy_onboarding_root: root },
    db,
    event(entity, action, actor, payload) {
      const created = new Date().toISOString();
      const event = { entity_id: entity, action, actor_id: actor.id, actor_role: actor.role, created_at_utc: created, payload };
      db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)').run(entity, action, actor.id, actor.role, created, JSON.stringify(event));
      return event;
    },
  };
  const actor = { id: 'wayne', role: 'HUMAN' };
  try {
    const initial = loadStrategyOnboarding({ root });
    const base = { strategy_id: ONBOARDING_STRATEGY_ID, questionnaire_id: 'test-setup-confirmation', expected_revision: 0, source_fingerprint: initial.source.fingerprint };
    const draft = recordStrategyOnboarding(backend, actor, { ...base, receipt_id: 'test-onboarding-draft-1', answers: { confirm_setup: false } }, 'DRAFT');
    assert.equal(draft.state, 'DRAFT');
    let projected = loadStrategyOnboarding({ root, events: readStrategyOnboardingEvents(db) });
    assert.equal(projected.questionnaires[0].status, 'DRAFT');
    assert.equal(projected.progress.complete, 1);

    const submitted = recordStrategyOnboarding(backend, actor, {
      ...base,
      receipt_id: 'test-onboarding-submit-1',
      expected_revision: 1,
      answers: { confirm_setup: true },
    }, 'SUBMITTED');
    assert.match(submitted.receipt_hash, /^sha256:[a-f0-9]{64}$/);
    projected = loadStrategyOnboarding({ root, events: readStrategyOnboardingEvents(db) });
    assert.equal(projected.questionnaires[0].status, 'COMPLETE');
    assert.equal(projected.progress.complete, 2);
    assert.ok(projected.gates.every(gate => gate.state === 'OFF'));
    assert.equal(db.prepare("SELECT state FROM ow_onboarding_brain_outbox WHERE milestone_id='test-onboarding-submit-1'").get().state, 'PENDING');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses the existing mutation idempotency and human-only authorization path', () => {
  const root = fixture();
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ow_events(id INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT,action TEXT,actor_id TEXT,actor_role TEXT,created_at_utc TEXT,payload_json TEXT);
    CREATE TABLE ow_inbox(producer_id TEXT,message_id TEXT,payload_hash TEXT,result_json TEXT,PRIMARY KEY(producer_id,message_id));
    CREATE TABLE ow_quarantine(id INTEGER PRIMARY KEY AUTOINCREMENT,producer_id TEXT,message_id TEXT,reason TEXT,payload_hash TEXT,created_at_utc TEXT);
  `);
  const backend = Object.create(WorkflowBackend.prototype);
  backend.config = { strategy_onboarding_root: root };
  backend.environment = {};
  backend.db = db;
  backend.store = { transaction(action) { db.exec('BEGIN'); try { const result = action(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  const actor = { id: 'wayne', role: 'HUMAN', namespace: 'TEST' };
  try {
    assert.equal(ROUTES['onboarding/drafts'], 'onboarding.draft');
    assert.equal(ROUTES['onboarding/submissions'], 'onboarding.submit');
    const current = loadStrategyOnboarding({ root });
    const input = { message_id: 'test-onboarding-message-1', data: { strategy_id: ONBOARDING_STRATEGY_ID, questionnaire_id: 'test-setup-confirmation', receipt_id: 'test-onboarding-receipt-1', expected_revision: 0, source_fingerprint: current.source.fingerprint, answers: { confirm_setup: false } } };
    const first = backend.mutate('onboarding.draft', actor, input);
    const replay = backend.mutate('onboarding.draft', actor, input);
    assert.deepEqual(replay, first);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ow_events WHERE action='onboarding.draft'").get().n, 1);
    assert.throws(() => backend.mutate('onboarding.draft', { id: 'service', role: 'BRAIN', namespace: 'TEST' }, { ...input, message_id: 'test-onboarding-message-2' }), /WAYNE_BROWSER_ONLY/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a source is missing or belongs to another strategy', () => {
  const root = fixture();
  try {
    fs.rmSync(path.join(root, 'strategy-profile.json'));
    fs.writeFileSync(path.join(root, 'execution-instance.json'), JSON.stringify({ ...files['execution-instance.json'], strategy_id: 'another-strategy' }));
    const result = loadStrategyOnboarding({ root });
    assert.equal(result.source.status, 'PARTIAL');
    assert.equal(result.profile.validity, 'INVALID_OR_UNAVAILABLE');
    assert.equal(result.instance.execution_instance_id, null);
    assert.equal(result.source.files.find(file => file.filename === 'strategy-profile.json').state, 'MISSING');
    assert.equal(result.source.files.find(file => file.filename === 'execution-instance.json').state, 'REJECTED');
    assert.ok(result.gates.every(gate => gate.state === 'OFF'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registers a Brain-confirmed package and controls non-live lifecycle without starting a source', () => {
  const root = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-onboarding-db-'));
  const store = new WorkflowStore(path.join(directory, 'workflow.sqlite'));
  const backend = {
    config: { strategy_onboarding_root: root },
    db: store.db,
    store,
    event(entity, action, actor, payload) {
      const created = new Date().toISOString();
      const event = { entity_id: entity, action, actor_id: actor.id, actor_role: actor.role, created_at_utc: created, payload };
      store.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)').run(entity, action, actor.id, actor.role, created, JSON.stringify(event));
      return event;
    },
  };
  const actor = { id: 'wayne', role: 'HUMAN', namespace: 'TEST' };
  const answers = { 'test-setup-confirmation': { confirm_setup:true } };
  try {
    const importedProfile = files['strategy-profile.json'];
    const importedRegistry = files['strategy-registry.json'];
    const profileKey = `${importedProfile.profile_id}:${importedProfile.profile_version}`;
    const importedProfilePayload = JSON.stringify(importedProfile);
    const importedRegistryPayload = JSON.stringify(importedRegistry);
    store.db.prepare('INSERT INTO ow_profiles(id,strategy_id,version,content_hash,payload_json) VALUES(?,?,?,?,?)')
      .run(profileKey, ONBOARDING_STRATEGY_ID, importedProfile.profile_version, `sha256:${'a'.repeat(64)}`, importedProfilePayload);
    store.db.prepare('INSERT INTO ow_strategies(id,profile_id,revision,baseline_hash,payload_json) VALUES(?,?,?,?,?)')
      .run(ONBOARDING_STRATEGY_ID, profileKey, Number(importedRegistry.registry_revision || 1), importedProfile.strategy_code_hash, importedRegistryPayload);
    for (const [index, [questionnaireId, values]] of Object.entries(answers).entries()) {
      const current = loadStrategyOnboarding({ root, events: readStrategyOnboardingEvents(store.db), brainOutbox: readOnboardingBrainOutbox(store.db) });
      const questionnaire = current.questionnaires.find(item => item.id === questionnaireId);
      store.transaction(() => recordStrategyOnboarding(backend, actor, {
        strategy_id:ONBOARDING_STRATEGY_ID, questionnaire_id:questionnaireId, receipt_id:`test-onboarding-submit-${index + 1}`,
        expected_revision:questionnaire.revision, source_fingerprint:current.source.fingerprint, answers:values,
      }, 'SUBMITTED'));
      store.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='ACKNOWLEDGED',brain_record_id=?,brain_relative_path=?,acknowledged_at_utc=? WHERE milestone_id=?")
        .run(`reasoning-test-${index + 1}`, `reasoning/reasoning-test-${index + 1}.md`, new Date().toISOString(), `test-onboarding-submit-${index + 1}`);
    }
    let current = loadStrategyOnboarding({ root, events:readStrategyOnboardingEvents(store.db), brainOutbox:readOnboardingBrainOutbox(store.db) });
    assert.equal(current.registration.can_register, true);
    const registered = store.transaction(() => registerStrategyOnboarding(backend, actor, { strategy_id:ONBOARDING_STRATEGY_ID, registration_id:'test-onboarding-registration-1', expected_source_fingerprint:current.source.fingerprint, confirmed:true }));
    assert.equal(registered.state, 'REGISTERED_NOT_ACTIVATED');
    assert.equal(store.db.prepare('SELECT id FROM ow_profiles').get().id, profileKey);
    assert.equal(store.db.prepare('SELECT payload_json FROM ow_profiles WHERE id=?').get(profileKey).payload_json, importedProfilePayload);
    assert.equal(store.db.prepare('SELECT payload_json FROM ow_strategies WHERE id=?').get(ONBOARDING_STRATEGY_ID).payload_json, importedRegistryPayload);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ow_instances').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ow_datasets').get().n, 0);
    assert.equal(readOnboardingRegistration(store.db).id, 'test-onboarding-registration-1');
    store.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='ACKNOWLEDGED',brain_record_id='reasoning-registration',brain_relative_path='reasoning/reasoning-registration.md',acknowledged_at_utc=? WHERE milestone_id='test-onboarding-registration-1'").run(new Date().toISOString());
    current = loadStrategyOnboarding({ root, events:readStrategyOnboardingEvents(store.db), brainOutbox:readOnboardingBrainOutbox(store.db), registration:readOnboardingRegistration(store.db), activationEvents:readOnboardingActivationEvents(store.db) });
    assert.equal(current.registration.state, 'REGISTERED');
    assert.equal(current.progress.complete, 2);
    assert.equal(current.next_action.title, 'Finish Replay preparation');
    const activation = store.transaction(() => activateStrategyOnboarding(backend, actor, { strategy_id:ONBOARDING_STRATEGY_ID, activation_id:'test-onboarding-activation-1', environment:'REPLAY', expected_revision:0, confirmed:true }));
    assert.equal(activation.state, 'ACTIVATED_NOT_STARTED');
    assert.equal(activation.actual_source_started, false);
    current = loadStrategyOnboarding({ root, events:readStrategyOnboardingEvents(store.db), brainOutbox:readOnboardingBrainOutbox(store.db), registration:readOnboardingRegistration(store.db), activationEvents:readOnboardingActivationEvents(store.db) });
    assert.equal(current.progress.complete, 3);
    assert.equal(current.onboarding_status, 'COMPLETE');
    assert.equal(current.next_action.title, 'Build Replay history');
    assert.match(current.next_action.actions.join(' '), /never delays onboarding/);
    assert.throws(() => store.transaction(() => activateStrategyOnboarding(backend, actor, { strategy_id:ONBOARDING_STRATEGY_ID, activation_id:'test-onboarding-activation-live', environment:'LIVE', expected_revision:0, confirmed:true })), /LIVE_ACTIVATION_REQUIRES_PRODUCTION_PROMOTION/);
    store.transaction(() => pauseStrategyOnboarding(backend, actor, { strategy_id:ONBOARDING_STRATEGY_ID, activation_id:'test-onboarding-pause-1', environment:'REPLAY', expected_revision:1, confirmed:true }));
    store.transaction(() => deactivateStrategyOnboarding(backend, actor, { strategy_id:ONBOARDING_STRATEGY_ID, activation_id:'test-onboarding-deactivate-1', environment:'REPLAY', expected_revision:2, confirmed:true }));
    assert.deepEqual(readOnboardingActivationEvents(store.db).map(item => item.action), ['ACTIVATE','PAUSE','DEACTIVATE']);
  } finally {
    store.close();
    fs.rmSync(root, { recursive:true, force:true });
    fs.rmSync(directory, { recursive:true, force:true });
  }
});
