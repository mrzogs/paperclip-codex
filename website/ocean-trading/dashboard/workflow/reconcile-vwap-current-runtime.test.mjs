import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkflowStore } from './store.mjs';
import { applyCurrentRuntimeReconciliation, PAPER_INSTANCE_ID, planCurrentRuntimeReconciliation, REPLAY_INSTANCE_ID, STRATEGY_ID } from './reconcile-vwap-current-runtime.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-current-runtime-'));
  const store = new WorkflowStore(path.join(directory, 'workflow.sqlite'));
  const profile = { strategy_id:STRATEGY_ID };
  store.db.prepare('INSERT INTO ow_profiles(id,strategy_id,version,content_hash,payload_json) VALUES(?,?,?,?,?)').run('profile:v0.1.2',STRATEGY_ID,'v0.1.2',`sha256:${'a'.repeat(64)}`,JSON.stringify(profile));
  store.db.prepare('INSERT INTO ow_strategies(id,profile_id,revision,baseline_hash,payload_json) VALUES(?,?,?,?,?)').run(STRATEGY_ID,'profile:v0.1.2',3,`sha256:${'b'.repeat(64)}`,JSON.stringify({ strategy_id:STRATEGY_ID, production_version:null }));
  store.db.prepare('INSERT INTO ow_instances(id,strategy_id,payload_json) VALUES(?,?,?)').run(REPLAY_INSTANCE_ID,STRATEGY_ID,JSON.stringify({ execution_instance_id:REPLAY_INSTANCE_ID, strategy_id:STRATEGY_ID, safety_state:{}, capabilities:['REPLAY'] }));
  const content = Buffer.from(JSON.stringify({
    schema_version:'cicd-vwap-runtime-reconciliation/v1', strategy_id:STRATEGY_ID, observed_at:'2026-10-02T17:35:00+01:00',
    identity:{ baseline_version:'v0.1.0', production_version:null, recommendations_enabled:false, automatic_approval_enabled:false, brain_submission:'OFF_UNTIL_ACTIVATION', live_real:'DISABLED', real_order_routing:'DISABLED' },
    supported_environments:['REPLAY','PAPER_SIM'], source_profile:{ configuration_hash:`sha256:${'c'.repeat(64)}` },
    execution_instances:[
      { execution_instance_id:REPLAY_INSTANCE_ID, status:'READY', sierra_root:'D:\\Replay Two', executable:'D:\\Replay Two\\SierraChart_64.exe', chartbook:'D:\\Replay Two\\Data\\VWAP.Cht', chartbook_sha256:`sha256:${'d'.repeat(64)}`, chartbook_bytes:1, chart:1, symbol:'MNQH26_FUT_CME', bar_period:'5 minutes', account_alias:'Sim1', simulation:true, telemetry_producer:'replay-telemetry', sqlite_database:'D:\\runtime\\replay.sqlite', sqlite_state:{open_trades:0}, brain_submission:'OFF', study_bindings:{ strategy:{study_id:6,dll:'D:\\Replay Two\\Data\\strategy.dll',loaded_version:'v0.6.234',sha256:`sha256:${'e'.repeat(64)}`}, telemetry:{study_id:2,dll:'D:\\Replay Two\\Data\\telemetry.dll',loaded_version:'v0.5.31',sha256:`sha256:${'f'.repeat(64)}`} } },
      { execution_instance_id:PAPER_INSTANCE_ID, status:'RUNNING_SAFE_CUTOVER_DEFERRED', sierra_root:'D:\\Paper', executable:'D:\\Paper\\SierraChart_64.exe', chartbook:'D:\\Paper\\Data\\VWAP Paper.Cht', chartbook_sha256:`sha256:${'1'.repeat(64)}`, chartbook_bytes:2, chart:1, symbol:'MNQZ26_FUT_CME[M]', bar_period:'5 minutes', account_alias:'Sim1', simulation:true, telemetry_producer:'paper-telemetry', sqlite_database:'D:\\runtime\\paper.sqlite', sqlite_state:{open_trades:1}, brain_submission:'OFF', study_bindings:{ strategy:{study_id:3,dll:'D:\\Paper\\Data\\strategy.dll',loaded_version:'v0.6.233',sha256:`sha256:${'2'.repeat(64)}`}, telemetry:{study_id:2,dll:'D:\\Paper\\Data\\telemetry.dll',loaded_version:'v0.5.30',sha256:`sha256:${'3'.repeat(64)}`} } },
    ],
  }));
  return { directory, store, content };
}

test('plans and applies an isolated Replay/Paper current-runtime reconciliation idempotently', () => {
  const { directory, store, content } = fixture();
  try {
    const plan = planCurrentRuntimeReconciliation(store.db, content);
    assert.equal(plan.paper_action, 'INSERT_NEW_BINDING');
    assert.equal(plan.paper.capabilities[0], 'PAPER_FORWARD');
    assert.equal(plan.paper.safe_cutover_pending, true);
    assert.equal(plan.safety.live_real, 'DISABLED');
    const result = applyCurrentRuntimeReconciliation(store, content);
    assert.equal(result.status, 'APPLIED');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ow_instances').get().n, 2);
    assert.equal(JSON.parse(store.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(PAPER_INSTANCE_ID).payload_json).account_alias, 'Sim1');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='onboarding.runtime-reconcile'").get().n, 1);
    const again = applyCurrentRuntimeReconciliation(store, content);
    assert.equal(again.event_action, 'ALREADY_RECORDED');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='onboarding.runtime-reconcile'").get().n, 1);
  } finally { store.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});

test('fails closed when LIVE_REAL or automatic approval is enabled', () => {
  const { directory, store, content } = fixture();
  try {
    const value = JSON.parse(content);
    value.identity.live_real = 'ENABLED';
    assert.throws(() => planCurrentRuntimeReconciliation(store.db, Buffer.from(JSON.stringify(value))), /CURRENT_RUNTIME_LIVE_REAL_PROHIBITED/);
    value.identity.live_real = 'DISABLED';
    value.identity.automatic_approval_enabled = true;
    assert.throws(() => planCurrentRuntimeReconciliation(store.db, Buffer.from(JSON.stringify(value))), /CURRENT_RUNTIME_AUTOMATIC_APPROVAL_PROHIBITED/);
  } finally { store.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});
