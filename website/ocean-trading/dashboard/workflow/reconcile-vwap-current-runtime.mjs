import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { requireThat } from './common.mjs';

export const STRATEGY_ID = 'cicd-vwap-pull-back-strategy';
export const REPLAY_INSTANCE_ID = 'test-cicd-vwap-pull-back-replay-two-v013';
export const PAPER_INSTANCE_ID = 'test-cicd-vwap-pull-back-paper-primary';
export const DEFAULT_RECONCILIATION = 'C:\\Users\\wayne\\OneDrive\\Documents\\Brady - Optimization\\onboarding\\canonical-runtime-reconciliation-20261002.json';
export const DEFAULT_DB = 'D:\\OceanTradingData\\website\\workflow\\workflow.sqlite';

const digest = content => `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;

function exactInstance(reconciliation, id) {
  const matches = reconciliation.execution_instances.filter(item => item.execution_instance_id === id);
  requireThat(matches.length === 1, 422, 'CURRENT_RUNTIME_INSTANCE_REQUIRED');
  return matches[0];
}

function validateSafety(reconciliation) {
  requireThat(reconciliation.schema_version === 'cicd-vwap-runtime-reconciliation/v1', 422, 'CURRENT_RUNTIME_SCHEMA_INVALID');
  requireThat(reconciliation.strategy_id === STRATEGY_ID, 422, 'CURRENT_RUNTIME_STRATEGY_INVALID');
  requireThat(reconciliation.identity?.production_version === null, 422, 'CURRENT_RUNTIME_PRODUCTION_VERSION_PROHIBITED');
  requireThat(reconciliation.identity?.recommendations_enabled === false, 422, 'CURRENT_RUNTIME_RECOMMENDATIONS_PROHIBITED');
  requireThat(reconciliation.identity?.automatic_approval_enabled === false, 422, 'CURRENT_RUNTIME_AUTOMATIC_APPROVAL_PROHIBITED');
  requireThat(reconciliation.identity?.brain_submission?.startsWith('OFF'), 422, 'CURRENT_RUNTIME_BRAIN_SUBMISSION_PROHIBITED');
  requireThat(reconciliation.identity?.live_real === 'DISABLED', 422, 'CURRENT_RUNTIME_LIVE_REAL_PROHIBITED');
  requireThat(reconciliation.identity?.real_order_routing === 'DISABLED', 422, 'CURRENT_RUNTIME_REAL_ROUTING_PROHIBITED');
  requireThat(Array.isArray(reconciliation.supported_environments)
    && reconciliation.supported_environments.length === 2
    && reconciliation.supported_environments.includes('REPLAY')
    && reconciliation.supported_environments.includes('PAPER_SIM'), 422, 'CURRENT_RUNTIME_ENVIRONMENT_SCOPE_INVALID');
  for (const instance of reconciliation.execution_instances) {
    requireThat(instance.strategy_id === undefined || instance.strategy_id === STRATEGY_ID, 422, 'CURRENT_RUNTIME_INSTANCE_STRATEGY_INVALID');
    requireThat(instance.account_alias === 'Sim1' && instance.simulation === true, 422, 'CURRENT_RUNTIME_SIM1_REQUIRED');
    requireThat(instance.brain_submission === 'OFF', 422, 'CURRENT_RUNTIME_INSTANCE_BRAIN_SUBMISSION_PROHIBITED');
  }
}

function replayPayload(existing, source, reconciliationSha) {
  requireThat(existing.strategy_id === STRATEGY_ID, 409, 'CURRENT_RUNTIME_REPLAY_IDENTITY_CONFLICT');
  return {
    ...existing,
    chartbook_path: source.chartbook,
    chartbook_sha256: source.chartbook_sha256,
    chartbook_bytes: source.chartbook_bytes,
    symbol: source.symbol,
    bar_period: source.bar_period,
    account_alias: source.account_alias,
    source_binary_path: source.study_bindings.strategy.dll,
    source_binary_sha256: source.study_bindings.strategy.sha256,
    physical_artifact_version: source.study_bindings.strategy.loaded_version,
    telemetry_binary_path: source.study_bindings.telemetry.dll,
    telemetry_binary_sha256: source.study_bindings.telemetry.sha256,
    telemetry_version: source.study_bindings.telemetry.loaded_version,
    telemetry_database_path: source.sqlite_database,
    capabilities: ['REPLAY'],
    status: 'READY',
    lease_run_id: null,
    current_runtime_reconciliation_sha256: reconciliationSha,
    current_runtime_observed_at: source.status,
    safety_state: {
      ...(existing.safety_state || {}),
      trade_simulation_mode: true,
      connected: false,
      strategy_automated_order_placement: false,
      telemetry_logging: true,
      brain_submission: 'OFF',
      replay_started: false,
      paper_started: false,
      live_started: false,
      live_real: false,
      real_order_routing: false,
    },
  };
}

function paperPayload(source, reconciliation, reconciliationSha) {
  return {
    schema_version: 'cicd-execution-instance/v1',
    execution_instance_id: PAPER_INSTANCE_ID,
    strategy_id: STRATEGY_ID,
    configuration_revision: 'v0.1.2-current-runtime-reconciliation-20261002',
    source_installation_id: 'test-sierra-paper-cicd-vwap',
    installation_root: source.sierra_root,
    executable: source.executable,
    chartbook_id: path.basename(source.chartbook),
    chartbook_path: source.chartbook,
    chartbook_sha256: source.chartbook_sha256,
    chartbook_bytes: source.chartbook_bytes,
    chart_id: String(source.chart),
    symbol: source.symbol,
    contract: 'Micro E-Mini Nasdaq 100 - CME (Dec26)',
    bar_period: source.bar_period,
    source_study_instance_id: `StudyID${source.study_bindings.strategy.study_id}`,
    source_binary_path: source.study_bindings.strategy.dll,
    source_binary_sha256: source.study_bindings.strategy.sha256,
    physical_artifact_version: source.study_bindings.strategy.loaded_version,
    telemetry_study_instance_id: `StudyID${source.study_bindings.telemetry.study_id}`,
    telemetry_binary_path: source.study_bindings.telemetry.dll,
    telemetry_binary_sha256: source.study_bindings.telemetry.sha256,
    telemetry_version: source.study_bindings.telemetry.loaded_version,
    telemetry_producer_id: source.telemetry_producer,
    telemetry_database_path: source.sqlite_database,
    version_binding: reconciliation.identity.baseline_version,
    config_hash: reconciliation.source_profile.configuration_hash,
    account_alias: source.account_alias,
    capabilities: ['PAPER_FORWARD'],
    status: 'READY',
    lease_run_id: null,
    current_runtime_reconciliation_sha256: reconciliationSha,
    current_runtime_status: source.status,
    safe_cutover_pending: source.sqlite_state?.open_trades > 0,
    safety_state: {
      trade_simulation_mode: true,
      connected: true,
      strategy_automated_order_placement: false,
      telemetry_logging: true,
      brain_submission: 'OFF',
      replay_started: false,
      paper_started: true,
      live_started: false,
      live_real: false,
      real_order_routing: false,
    },
  };
}

export function planCurrentRuntimeReconciliation(db, content) {
  const reconciliation = JSON.parse(content.toString('utf8'));
  validateSafety(reconciliation);
  const strategy = db.prepare('SELECT id,payload_json FROM ow_strategies WHERE id=?').get(STRATEGY_ID);
  requireThat(strategy, 404, 'CURRENT_RUNTIME_STRATEGY_NOT_REGISTERED');
  const replayRow = db.prepare('SELECT strategy_id,payload_json FROM ow_instances WHERE id=?').get(REPLAY_INSTANCE_ID);
  requireThat(replayRow, 404, 'CURRENT_RUNTIME_REPLAY_NOT_REGISTERED');
  const reconciliationSha = digest(content);
  const replay = replayPayload(JSON.parse(replayRow.payload_json), exactInstance(reconciliation, REPLAY_INSTANCE_ID), reconciliationSha);
  const paper = paperPayload(exactInstance(reconciliation, PAPER_INSTANCE_ID), reconciliation, reconciliationSha);
  const currentPaper = db.prepare('SELECT strategy_id,payload_json FROM ow_instances WHERE id=?').get(PAPER_INSTANCE_ID);
  if (currentPaper) {
    requireThat(currentPaper.strategy_id === STRATEGY_ID, 409, 'CURRENT_RUNTIME_PAPER_IDENTITY_CONFLICT');
    const parsed = JSON.parse(currentPaper.payload_json);
    requireThat(parsed.account_alias === 'Sim1' && parsed.installation_root === paper.installation_root && parsed.chartbook_path === paper.chartbook_path, 409, 'CURRENT_RUNTIME_PAPER_BINDING_CONFLICT');
  }
  const duplicate = db.prepare("SELECT COUNT(*) AS n FROM ow_events WHERE entity_id=? AND action='onboarding.runtime-reconcile' AND json_extract(payload_json,'$.payload.reconciliation_sha256')=?")
    .get(STRATEGY_ID, reconciliationSha).n > 0;
  return {
    schema_version: 'ocean-vwap-current-runtime-plan/v1',
    strategy_id: STRATEGY_ID,
    reconciliation_sha256: reconciliationSha,
    observed_at: reconciliation.observed_at,
    replay,
    paper,
    paper_action: currentPaper ? 'UPDATE_CURRENT_BINDING' : 'INSERT_NEW_BINDING',
    event_action: duplicate ? 'ALREADY_RECORDED' : 'APPEND',
    safety: { live_real: 'DISABLED', real_order_routing: 'DISABLED', automatic_approval: false, production_version: null },
  };
}

export function applyCurrentRuntimeReconciliation(store, content, actorId = 'wayne-coordinator') {
  const plan = planCurrentRuntimeReconciliation(store.db, content);
  store.transaction(() => {
    store.db.prepare('UPDATE ow_instances SET payload_json=? WHERE id=?').run(JSON.stringify(plan.replay), REPLAY_INSTANCE_ID);
    const currentPaper = store.db.prepare('SELECT id FROM ow_instances WHERE id=?').get(PAPER_INSTANCE_ID);
    if (currentPaper) store.db.prepare('UPDATE ow_instances SET payload_json=? WHERE id=?').run(JSON.stringify(plan.paper), PAPER_INSTANCE_ID);
    else store.db.prepare('INSERT INTO ow_instances(id,strategy_id,payload_json) VALUES(?,?,?)').run(PAPER_INSTANCE_ID, STRATEGY_ID, JSON.stringify(plan.paper));
    if (plan.event_action === 'APPEND') {
      const created = new Date().toISOString();
      const payload = { entity_id:STRATEGY_ID, action:'onboarding.runtime-reconcile', actor_id:actorId, actor_role:'HUMAN', created_at_utc:created, payload:{ reconciliation_sha256:plan.reconciliation_sha256, observed_at:plan.observed_at, replay_instance_id:REPLAY_INSTANCE_ID, paper_instance_id:PAPER_INSTANCE_ID, paper_action:plan.paper_action, live_real:'DISABLED', real_order_routing:'DISABLED', automatic_approval:false, production_version:null } };
      store.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)').run(STRATEGY_ID,'onboarding.runtime-reconcile',actorId,'HUMAN',created,JSON.stringify(payload));
    }
  });
  return { ...plan, status:'APPLIED', event_action:plan.event_action === 'APPEND' ? 'APPENDED' : 'ALREADY_RECORDED' };
}

function cli(argv) {
  const apply = argv.includes('--apply');
  const arg = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
  const reconciliationPath = path.resolve(arg('--reconciliation') || DEFAULT_RECONCILIATION);
  const dbPath = path.resolve(arg('--db') || DEFAULT_DB);
  const content = fs.readFileSync(reconciliationPath);
  const store = new WorkflowStore(dbPath, { readOnly:!apply });
  try {
    const result = apply ? applyCurrentRuntimeReconciliation(store, content) : { ...planCurrentRuntimeReconciliation(store.db, content), status:'DRY_RUN' };
    console.log(JSON.stringify({ ...result, reconciliation_path:reconciliationPath, db_path:dbPath }, null, 2));
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
