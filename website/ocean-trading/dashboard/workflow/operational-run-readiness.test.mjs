import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from './common.mjs';
import { reconcileOperationalReplayRunSettings } from './operational-run-readiness.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-run-readiness-'));
  const chartbook = path.join(root, 'Replay.Cht');
  const dbFile = path.join(root, 'workflow.sqlite');
  fs.writeFileSync(chartbook, 'verified chart settings');
  const instance = { execution_instance_id:'operational-replay', strategy_id:'strategy', source_installation_id:'sierra', chartbook_id:'chartbook', chart_id:'1', source_study_instance_id:'study', telemetry_producer_id:'telemetry', version_binding:'v1', config_hash:`sha256:${'1'.repeat(64)}`, account_alias:'Sim1', capabilities:['REPLAY'], status:'DRAFT', lease_run_id:null };
  const binding = { instance, strategy_id:'strategy', state:'VERIFIED_FACTS_ONLY', binding_hash:`sha256:${'2'.repeat(64)}` };
  const config = {
    schema_version:'ocean-replay-run-bridge/v4', base_url:'http://127.0.0.1:3102', workflow_db:dbFile,
    telemetry_db:path.join(root,'telemetry.sqlite'), handoff_path:path.join(root,'token.dpapi'), strategy_id:'strategy',
    instance_id:instance.execution_instance_id, identity_id:'telemetry', credential_ref:'OCEAN_TEST_TOKEN', account_alias:'Sim1',
    expected_symbol:'MNQZ25_FUT_CME', expected_strategy_version:'v1.0.0', expected_telemetry_version:'v1.0.0',
    expected_sierra_exe:path.join(root,'SierraChart_64.exe'), poll_seconds:10, state_file:path.join(root,'state.json'),
    namespace:'OPERATIONAL', factual_binding_hash:binding.binding_hash, minimum_schema_version:13, freshness_seconds:120,
    expected_chartbook_path:chartbook, expected_chart_number:1, expected_chartbook_sha256:digest(fs.readFileSync(chartbook)),
    time_basis:'UTC source records', session_calendar_revision:'calendar-v1', fill_model_version:'Sierra native replay',
    expected_bar_period_seconds:300, expected_strategy_module_path:path.join(root,'strategy.dll'),
    expected_strategy_module_sha256:`sha256:${'3'.repeat(64)}`, expected_telemetry_module_path:path.join(root,'telemetry.dll'),
    expected_telemetry_module_sha256:`sha256:${'4'.repeat(64)}`, source_preflight_status_path:path.join(root,'status.txt'),
  };
  const configFile = path.join(root, 'bridge.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE ow_instances(id TEXT PRIMARY KEY,strategy_id TEXT,payload_json TEXT); CREATE TABLE ow_run_settings(id TEXT PRIMARY KEY,payload_json TEXT);');
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(instance.execution_instance_id,instance.strategy_id,JSON.stringify(instance));
  const backend = { config:{ db_file:dbFile, operational_factual_bindings:[binding] }, db, runs:{ perform(action,actor,data){ assert.equal(action,'settings'); assert.equal(actor.id,'wayne-ocean-ui'); db.prepare('INSERT INTO ow_run_settings VALUES(?,?)').run(data.instance_id,JSON.stringify(data)); } } };
  return {root,chartbook,configFile,config,backend,db};
}

test('registers verified operational Replay settings once and reuses them', t => {
  const f=fixture();t.after(()=>{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});});
  assert.equal(reconcileOperationalReplayRunSettings(f.backend,f.configFile).idempotent,false);
  assert.equal(reconcileOperationalReplayRunSettings(f.backend,f.configFile).idempotent,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ow_run_settings').get().n,1);
});

test('fails closed when the physical chartbook changes', t => {
  const f=fixture();t.after(()=>{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});});
  fs.writeFileSync(f.chartbook,'changed chart settings');
  assert.throws(()=>reconcileOperationalReplayRunSettings(f.backend,f.configFile),/OPERATIONAL_CHARTBOOK_HASH_CONFLICT/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ow_run_settings').get().n,0);
});

test('rejects conflicting immutable settings', t => {
  const f=fixture();t.after(()=>{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});});
  f.db.prepare('INSERT INTO ow_run_settings VALUES(?,?)').run(f.config.instance_id,JSON.stringify({instance_id:f.config.instance_id,chart_settings_hash:`sha256:${'f'.repeat(64)}`,time_basis:'other',session_calendar_revision:'other',fill_model_version:'other'}));
  assert.throws(()=>reconcileOperationalReplayRunSettings(f.backend,f.configFile),/OPERATIONAL_RUN_SETTINGS_CONFLICT/);
});
