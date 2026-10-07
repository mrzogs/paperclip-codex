import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sealedHash } from './common.mjs';

const probe = fileURLToPath(new URL('./replay-run-bridge-probe.mjs', import.meta.url));

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-replay-bridge-'));
  const workflowDb = path.join(directory, 'workflow.sqlite');
  const telemetryDb = path.join(directory, 'telemetry.sqlite');
  const expectedExe = path.join(directory, 'SierraChart_64.exe');
  const workflow = new DatabaseSync(workflowDb);
  const telemetry = new DatabaseSync(telemetryDb);
  try {
    workflow.exec(`
      CREATE TABLE ow_runs (id TEXT, strategy_id TEXT, instance_id TEXT, revision INTEGER, state TEXT);
      INSERT INTO ow_runs VALUES ('test-run-1', 'cicd-vwap-pull-back-strategy', 'test-cicd-vwap-pull-back-replay-two-v013', 2, 'ACTIVE');
    `);
    telemetry.exec(`
      CREATE TABLE schema_version (version INTEGER);
      INSERT INTO schema_version VALUES (7);
      CREATE TABLE logger_health (health_id INTEGER PRIMARY KEY, message TEXT, created_utc TEXT);
      INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.29 test', '2026-10-01T09:22:25Z');
      CREATE TABLE account_snapshot (account_snapshot_id INTEGER PRIMARY KEY, trade_account TEXT, is_simulated INTEGER, snapshot_utc TEXT);
      INSERT INTO account_snapshot VALUES (1, 'Sim1', 1, '2026-10-01T09:23:24Z');
      CREATE TABLE instrument_snapshot (instrument_snapshot_id INTEGER PRIMARY KEY, symbol TEXT);
      INSERT INTO instrument_snapshot VALUES (1, 'MNQM25_FUT_CME');
      CREATE TABLE replay_runs (run_id TEXT, created_utc TEXT, strategy_id TEXT, instance_role TEXT, strategy_version TEXT);
      INSERT INTO replay_runs VALUES ('test-run-1', '2026-10-01T09:22:26Z', 'cicd-vwap-pull-back-strategy', 'replay', 'v0.6.229');
      CREATE TABLE sierra_instance (instance_id TEXT, last_seen_utc TEXT, instance_role TEXT, sierra_exe_path TEXT);
      CREATE TABLE fills (id INTEGER, run_id TEXT);
      CREATE TABLE orders (id INTEGER, run_id TEXT);
      CREATE TABLE trades (id INTEGER, run_id TEXT, status TEXT);
    `);
    telemetry.prepare('INSERT INTO sierra_instance VALUES (?, ?, ?, ?)').run('Replay_Two_fixture', '2026-10-01T09:23:24Z', 'replay', expectedExe);
  } finally {
    workflow.close();
    telemetry.close();
  }
  const config = {
    schema_version: 'ocean-replay-run-bridge/v3',
    base_url: 'http://127.0.0.1:3102',
    workflow_db: workflowDb,
    telemetry_db: telemetryDb,
    handoff_path: path.join(directory, 'handoff.dpapi'),
    strategy_id: 'cicd-vwap-pull-back-strategy',
    instance_id: 'test-cicd-vwap-pull-back-replay-two-v013',
    identity_id: 'test-cicd-vwap-pull-back-replay-two-v013-telemetry',
    credential_ref: 'OCEAN_VWAP_PULLBACK_REPLAY_TWO_V013_TELEMETRY_TOKEN',
    account_alias: 'Sim1',
    expected_symbol: 'MNQM25_FUT_CME',
    expected_strategy_version: 'v0.6.229',
    expected_telemetry_version: 'v0.5.29',
    expected_sierra_exe: expectedExe,
    poll_seconds: 10,
    state_file: path.join(directory, 'state.json'),
  };
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { directory, configFile, telemetryDb, workflowDb, config };
}

function createOperationalFixture() {
  const fixture = createFixture();
  const runId = 'cicd-vwap-operational-run-1';
  const instanceId = 'cicd-vwap-pull-back-strategy:replay-two:chart1';
  const identityId = `${instanceId}:telemetry-study2`;
  const chartbook = path.join(fixture.directory, 'CICD - VWAP Pull Back Strategy.Cht');
  const strategyModule = path.join(fixture.directory, 'CICD_VWAPPullback_v228_64.dll');
  const telemetryModule = path.join(fixture.directory, 'CICD_VWAPPullback_Telemetry_v0526_64.dll');
  const sourcePreflightStatus = path.join(fixture.directory, 'vwap-replay-status.txt');
  fs.writeFileSync(chartbook, 'fixture');
  fs.writeFileSync(strategyModule, 'fixture');
  fs.writeFileSync(telemetryModule, 'fixture');
  fs.writeFileSync(sourcePreflightStatus, [
    'commandId=operational-preflight-fixture',
    'action=prepare_contract',
    'status=contract_prepared',
    'chartNumber=1',
    'symbol=MNQH26_FUT_CME',
    'isReplayRunning=false',
    'replayStatus=0',
    'secondsPerBar=300',
    'detail=requested_symbol=MNQH26_FUT_CME; historical_open_chart_result=1; historical_recalculate_chart_result=1; intraday_open_chart_result=1; intraday_recalculate_chart_result=1; requested_intraday_bar_seconds=300; session_read_result=1',
    '',
  ].join('\n'));

  const workflow = new DatabaseSync(fixture.workflowDb);
  workflow.exec('CREATE TABLE ow_operational_releases (run_id TEXT, context_hash TEXT, payload_json TEXT)');
  workflow.prepare('UPDATE ow_runs SET id=?, instance_id=?, state=?, revision=?').run(runId, instanceId, 'READY', 1);
  workflow.close();
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec(`
    UPDATE schema_version SET version=9;
    UPDATE logger_health SET message='logger_started version=v0.5.31';
    UPDATE account_snapshot SET snapshot_utc=strftime('%Y-%m-%d %H:%M:%S','now');
    UPDATE instrument_snapshot SET symbol='MNQH26_FUT_CME';
    ALTER TABLE replay_runs ADD COLUMN chartbook TEXT;
    ALTER TABLE replay_runs ADD COLUMN chart_number INTEGER;
    ALTER TABLE replay_runs ADD COLUMN bar_period TEXT;
  `);
  telemetry.prepare('UPDATE replay_runs SET run_id=?, strategy_version=?, chartbook=?, chart_number=?, bar_period=?')
    .run(runId, 'v0.6.234', chartbook, 1, 'intraday_type=0;p1=300;seconds=300');
  telemetry.close();
  const config = {
    ...fixture.config,
    schema_version: 'ocean-replay-run-bridge/v4',
    namespace: 'OPERATIONAL',
    factual_binding_hash: `sha256:${'6'.repeat(64)}`,
    minimum_schema_version: 9,
    freshness_seconds: 120,
    instance_id: instanceId,
    identity_id: identityId,
    credential_ref: 'OCEAN_CICD_VWAP_REPLAY_TELEMETRY_V1_TOKEN',
    expected_symbol: 'MNQH26_FUT_CME',
    expected_strategy_version: 'v0.6.234',
    expected_telemetry_version: 'v0.5.31',
    expected_chartbook_path: chartbook,
    expected_chart_number: 1,
    expected_chartbook_sha256: `sha256:${'9'.repeat(64)}`,
    time_basis: 'UTC source records; Sierra chart display time preserved',
    session_calendar_revision: 'observed-mnq-maintenance-2100-2200z-20260928',
    fill_model_version: 'Sierra Chart Replay native simulation',
    managed_candidate_id: 'v0.6.234-managed-lineage',
    expected_session_name: 'All',
    expected_session_timezone: 'Europe/London',
    expected_bar_period_seconds: 300,
    expected_strategy_module_path: strategyModule,
    expected_strategy_module_sha256: `sha256:${'7'.repeat(64)}`,
    expected_telemetry_module_path: telemetryModule,
    expected_telemetry_module_sha256: `sha256:${'8'.repeat(64)}`,
    source_preflight_status_path: sourcePreflightStatus,
  };
  fs.writeFileSync(fixture.configFile, JSON.stringify(config));
  return { ...fixture, runId, instanceId, config };
}

function updateDatabase(filename, sql) {
  const db = new DatabaseSync(filename);
  try { db.exec(sql); } finally { db.close(); }
}

function readProbe(fixture) {
  return JSON.parse(execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8', stdio: 'pipe' }));
}

function writeProducerStatus(fixture, overrides = {}) {
  const values = {
    commandId: 'managed-run-start-progress-1',
    action: 'status',
    status: 'status',
    chartNumber: '1',
    symbol: fixture.config.expected_symbol,
    isReplayRunning: 'true',
    replayStatus: '1',
    chartDataType: '2',
    secondsPerBar: '300',
    detail: 'VWAP replay hook active.',
    ...overrides,
  };
  fs.writeFileSync(fixture.config.source_preflight_status_path, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function createManagedStatusFixture(t, overrides = {}) {
  const fixture = createOperationalFixture();
  t.after(() => {
    assert.ok(path.resolve(fixture.directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });
  const context = {
    schema_version: '2.1.0', run_id: fixture.runId, revision: 1,
    strategy_id: fixture.config.strategy_id, execution_instance_id: fixture.instanceId,
    expected_environment: 'REPLAY', candidate_id: null,
    strategy_code_hash: `sha256:${'1'.repeat(64)}`,
    strategy_config_hash: `sha256:${'2'.repeat(64)}`,
    dataset_manifest_id: 'cicd-vwap-discovery', dataset_manifest_revision: 3,
    dataset_partition: 'DISCOVERY', strategy_profile_id: 'cicd-vwap-source-bound',
    strategy_profile_version: 'v0.1.3',
  };
  context.context_hash = sealedHash(context, 'context_hash');
  const plan = {
    selection: { strategy_id: context.strategy_id, instance_id: fixture.instanceId },
    context_hash: context.context_hash,
    operational_review: { context, factual_binding_hash: fixture.config.factual_binding_hash },
  };
  plan.plan_hash = sealedHash(plan, 'plan_hash');
  const workflow = new DatabaseSync(fixture.workflowDb);
  try {
    workflow.exec('ALTER TABLE ow_runs ADD COLUMN context_json TEXT; CREATE TABLE ow_run_plans (id TEXT, payload_json TEXT)');
    workflow.prepare('UPDATE ow_runs SET context_json=?').run(JSON.stringify(context));
    workflow.prepare('INSERT INTO ow_run_plans VALUES (?,?)').run(fixture.runId, JSON.stringify(plan));
    workflow.prepare('INSERT INTO ow_operational_releases VALUES (?,?,?)').run(fixture.runId, context.context_hash, '{}');
  } finally { workflow.close(); }
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  try {
    telemetry.exec(`
      ALTER TABLE replay_runs ADD COLUMN instance_id TEXT;
      UPDATE replay_runs SET instance_id='Replay_Two_fixture';
      ALTER TABLE account_snapshot ADD COLUMN instance_id TEXT;
      UPDATE account_snapshot SET instance_id='Replay_Two_fixture';
      ALTER TABLE instrument_snapshot ADD COLUMN instance_id TEXT;
      ALTER TABLE instrument_snapshot ADD COLUMN trade_account TEXT;
      ALTER TABLE instrument_snapshot ADD COLUMN chart_number INTEGER;
      UPDATE instrument_snapshot SET instance_id='Replay_Two_fixture', trade_account='Sim1', chart_number=1;
      UPDATE sierra_instance SET last_seen_utc=strftime('%Y-%m-%d %H:%M:%S','now');
      CREATE TABLE replay_run_context (run_id TEXT, candidate_id TEXT, dataset_id TEXT, dataset_role TEXT,
        strategy_profile_id TEXT, strategy_profile_version TEXT, strategy_code_hash TEXT,
        strategy_config_hash TEXT, context_hash TEXT, session_name TEXT, session_timezone TEXT);
    `);
    telemetry.prepare('INSERT INTO replay_run_context VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      fixture.runId, fixture.config.managed_candidate_id,
      `${context.dataset_manifest_id}:${context.dataset_manifest_revision}`, context.dataset_partition,
      context.strategy_profile_id, context.strategy_profile_version, context.strategy_code_hash,
      context.strategy_config_hash, context.context_hash, fixture.config.expected_session_name,
      fixture.config.expected_session_timezone,
    );
  } finally { telemetry.close(); }
  writeProducerStatus(fixture, overrides);
  return { ...fixture, context, plan };
}

test('probe verifies the exact TEST Replay binding without claiming trade evidence', t => {
  const fixture = createFixture();
  t.after(() => {
    assert.ok(path.resolve(fixture.directory).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  const output = execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.deepEqual(result.run, { id: 'test-run-1', state: 'ACTIVE', revision: 2 });
  assert.equal(result.telemetry.verified, true);
  assert.equal(result.telemetry.source_schema_version, 'sierra-telemetry-sqlite/7');
  assert.deepEqual(result.telemetry.counts, { fills: 0, orders: 0, trades: 0, open_trades: 0 });
});

test('probe rejects a telemetry database bound to the wrong strategy', t => {
  const fixture = createFixture();
  t.after(() => {
    assert.ok(path.resolve(fixture.directory).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec("UPDATE replay_runs SET strategy_id='different-strategy'");
  telemetry.close();

  const output = execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.telemetry.verified, false);
  assert.equal(result.telemetry.reason, 'TELEMETRY_BINDING_NOT_VERIFIED');
});

test('probe rejects telemetry from a different MNQ contract', t => {
  const fixture = createFixture();
  t.after(() => {
    assert.ok(path.resolve(fixture.directory).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec("UPDATE instrument_snapshot SET symbol='MNQH26_FUT_CME'");
  telemetry.close();

  const output = execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.telemetry.verified, false);
  assert.equal(result.telemetry.reason, 'TELEMETRY_BINDING_NOT_VERIFIED');
});

test('probe rejects a stale logger context from a different Ocean run', t => {
  const fixture = createFixture();
  t.after(() => {
    assert.ok(path.resolve(fixture.directory).startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec("UPDATE replay_runs SET run_id='test-run-stale'");
  telemetry.close();

  const output = execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.run.id, 'test-run-1');
  assert.equal(result.telemetry.replay_run_id, 'test-run-stale');
  assert.equal(result.telemetry.verified, false);
  assert.equal(result.telemetry.reason, 'TELEMETRY_BINDING_NOT_VERIFIED');
});

test('v4 probe verifies the exact operational Replay preflight and run binding', t => {
  const fixture = createOperationalFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const result = JSON.parse(execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' }));
  assert.deepEqual(result.run, { id: fixture.runId, state: 'READY', revision: 1, release_context_hash: null });
  assert.equal(result.schema_version, 'ocean-replay-run-bridge/v4');
  assert.equal(result.telemetry.preflight_verified, true);
  assert.equal(result.telemetry.run_verified, true);
  assert.equal(result.telemetry.verified, true);
  assert.equal(result.telemetry.source_schema_version, 'sierra-telemetry-sqlite/9');
});

test('v4 probe keeps source preflight distinct from the not-yet-started Replay run', t => {
  const fixture = createOperationalFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec('DELETE FROM replay_runs');
  telemetry.close();
  const result = JSON.parse(execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' }));
  assert.equal(result.telemetry.preflight_verified, true);
  assert.equal(result.telemetry.run_verified, false);
  assert.equal(result.telemetry.reason, 'AWAITING_MATCHING_REPLAY_RUN');
});

test('v4 probe accepts stale idle telemetry when fresh strategy source preflight proves the current chart', t => {
  const fixture = createOperationalFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const telemetry = new DatabaseSync(fixture.telemetryDb);
  telemetry.exec("UPDATE account_snapshot SET snapshot_utc='2026-01-01 00:00:00'");
  telemetry.close();
  const result = JSON.parse(execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' }));
  assert.equal(result.telemetry.preflight_verified, true);
  assert.equal(result.telemetry.source_preflight.verified, true);
});

test('v4 probe rejects a stale strategy source preflight even when idle telemetry is otherwise bound', t => {
  const fixture = createOperationalFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const stale = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(fixture.config.source_preflight_status_path, stale, stale);
  const result = JSON.parse(execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8' }));
  assert.equal(result.telemetry.preflight_verified, false);
  assert.equal(result.telemetry.source_preflight.reason, 'SOURCE_PREFLIGHT_STATUS_STALE');
  assert.equal(result.telemetry.reason, 'TELEMETRY_PREFLIGHT_NOT_VERIFIED');
});

test('v4 probe rejects a test namespace instance', t => {
  const fixture = createOperationalFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.writeFileSync(fixture.configFile, JSON.stringify({ ...fixture.config, instance_id: 'test-cicd-vwap-pull-back-replay-two-v014' }));
  assert.throws(() => execFileSync(process.execPath, [probe, fixture.configFile], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.match(String(error.stderr), /IDENTITY_SCOPE_REJECTED/);
    return true;
  });
});

for (const [name, flags, basis] of [
  ['running', {}, 'CORRELATED_RUNNING_STATUS'],
  ['inactive', { isReplayRunning: 'false', replayStatus: '0' }, 'CORRELATED_INACTIVE_STATUS'],
]) {
  test(`v4 probe accepts fresh ${name} producer status only with the released managed run`, t => {
    const fixture = createManagedStatusFixture(t, flags);
    const result = readProbe(fixture);
    assert.equal(result.run.release_context_hash, fixture.context.context_hash);
    assert.equal(result.telemetry.source_preflight.verification_basis, basis);
    assert.equal(result.telemetry.source_preflight.verified, true);
    assert.equal(result.telemetry.preflight_verified, true);
    assert.equal(result.telemetry.run_verified, true);
    assert.equal(result.telemetry.verified, true);
    assert.equal(result.telemetry.reason, null);
  });
}

test('v4 probe remains blocked during warmup and verifies the first matching managed telemetry row', t => {
  const fixture = createManagedStatusFixture(t);
  updateDatabase(fixture.telemetryDb, "UPDATE replay_runs SET run_id='previous-z25-run'; UPDATE replay_run_context SET run_id='previous-z25-run'; UPDATE instrument_snapshot SET symbol='MNQZ25_FUT_CME'");
  assert.equal(readProbe(fixture).telemetry.preflight_verified, false);
  updateDatabase(fixture.telemetryDb, `UPDATE replay_runs SET run_id='${fixture.runId}'; UPDATE replay_run_context SET run_id='${fixture.runId}'; UPDATE instrument_snapshot SET symbol='${fixture.config.expected_symbol}'`);
  assert.equal(readProbe(fixture).telemetry.verified, true);
});

for (const [name, overrides] of [
  ['unknown action', { action: 'unknown' }],
  ['unknown status', { status: 'unknown' }],
  ['error', { status: 'error' }],
  ['unfinished preparation', { action: 'prepare_contract', status: 'status' }],
  ['running flag with stopped state', { replayStatus: '0' }],
  ['inactive flag with running state', { isReplayRunning: 'false' }],
  ['unknown replay state', { replayStatus: '9' }],
  ['paused state', { replayStatus: '2' }],
  ['missing replay state', { replayStatus: '' }],
  ['missing command', { commandId: '' }],
  ['different contract', { symbol: 'MNQZ25_FUT_CME' }],
  ['different chart', { chartNumber: '2' }],
  ['different bar period', { secondsPerBar: '60' }],
  ['historical chart', { chartDataType: '1' }],
  ['unknown producer detail', { detail: 'unknown' }],
  ['manual clear-only status', { detail: 'VWAP replay hook active; clear-only suppression released for manual replay.' }],
]) {
  test(`v4 probe rejects producer status with ${name}`, t => {
    const fixture = createManagedStatusFixture(t, overrides);
    const result = readProbe(fixture);
    assert.equal(result.telemetry.source_preflight.verified, false);
    assert.equal(result.telemetry.preflight_verified, false);
    assert.equal(result.telemetry.verified, false);
  });
}

for (const [name, sql] of [
  ['previous run', "UPDATE replay_runs SET run_id='previous-z25-run'"],
  ['different strategy', "UPDATE replay_runs SET strategy_id='other-strategy'"],
  ['different strategy version', "UPDATE replay_runs SET strategy_version='v0.6.233'"],
  ['different chartbook', "UPDATE replay_runs SET chartbook='other.Cht'"],
  ['different chart number', 'UPDATE replay_runs SET chart_number=2'],
  ['non-exact bar period', "UPDATE replay_runs SET bar_period='seconds=3000'"],
  ['missing managed context', 'DELETE FROM replay_run_context'],
  ['missing managed context table', 'DROP TABLE replay_run_context'],
  ['different managed candidate', "UPDATE replay_run_context SET candidate_id='other-candidate'"],
  ['different context hash', "UPDATE replay_run_context SET context_hash='sha256:wrong'"],
  ['different code hash', "UPDATE replay_run_context SET strategy_code_hash='sha256:wrong'"],
  ['different config hash', "UPDATE replay_run_context SET strategy_config_hash='sha256:wrong'"],
  ['different dataset revision', "UPDATE replay_run_context SET dataset_id='cicd-vwap-discovery:2'"],
  ['different dataset role', "UPDATE replay_run_context SET dataset_role='EVALUATION'"],
  ['different profile', "UPDATE replay_run_context SET strategy_profile_id='other-profile'"],
  ['different profile version', "UPDATE replay_run_context SET strategy_profile_version='v0.1.2'"],
  ['different session', "UPDATE replay_run_context SET session_name='London'"],
  ['different timezone', "UPDATE replay_run_context SET session_timezone='UTC'"],
  ['different telemetry instance', "UPDATE replay_runs SET instance_id='other-instance'"],
  ['different account instance', "UPDATE account_snapshot SET instance_id='other-instance'"],
  ['different instrument instance', "UPDATE instrument_snapshot SET instance_id='other-instance'"],
  ['different account', "UPDATE account_snapshot SET trade_account='Sim2'"],
  ['real account', 'UPDATE account_snapshot SET is_simulated=0'],
  ['different instrument account', "UPDATE instrument_snapshot SET trade_account='Sim2'"],
  ['different instrument contract', "UPDATE instrument_snapshot SET symbol='MNQZ25_FUT_CME'"],
  ['different instrument chart', 'UPDATE instrument_snapshot SET chart_number=2'],
  ['stale account', "UPDATE account_snapshot SET snapshot_utc='2026-01-01 00:00:00'"],
  ['future account', "UPDATE account_snapshot SET snapshot_utc='2099-01-01 00:00:00'"],
  ['stale instance', "UPDATE sierra_instance SET last_seen_utc='2026-01-01 00:00:00'"],
  ['wrong executable', "UPDATE sierra_instance SET sierra_exe_path='other.exe'"],
  ['wrong telemetry version', "UPDATE logger_health SET message='logger_started version=v0.5.30'"],
  ['version prefix collision', "UPDATE logger_health SET message='logger_started version=v0.5.310'"],
  ['schema below floor', 'UPDATE schema_version SET version=8'],
]) {
  test(`v4 probe rejects uncorrelated status with ${name}`, t => {
    const fixture = createManagedStatusFixture(t);
    updateDatabase(fixture.telemetryDb, sql);
    assert.equal(readProbe(fixture).telemetry.verified, false);
  });
}

for (const [name, mutate] of [
  ['missing release', fixture => updateDatabase(fixture.workflowDb, 'DELETE FROM ow_operational_releases')],
  ['release hash conflict', fixture => updateDatabase(fixture.workflowDb, "UPDATE ow_operational_releases SET context_hash='sha256:wrong'")],
  ['changed context', fixture => {
    const db = new DatabaseSync(fixture.workflowDb);
    try { db.prepare('UPDATE ow_runs SET context_json=?').run(JSON.stringify({ ...fixture.context, execution_instance_id: 'other-instance' })); } finally { db.close(); }
  }],
  ['changed plan', fixture => {
    const db = new DatabaseSync(fixture.workflowDb);
    try { db.prepare('UPDATE ow_run_plans SET payload_json=?').run(JSON.stringify({ ...fixture.plan, context_hash: 'sha256:wrong' })); } finally { db.close(); }
  }],
  ['missing run plan', fixture => updateDatabase(fixture.workflowDb, 'DELETE FROM ow_run_plans')],
  ['malformed context', fixture => updateDatabase(fixture.workflowDb, "UPDATE ow_runs SET context_json='not-json'")],
  ['different factual binding', fixture => fs.writeFileSync(fixture.configFile, JSON.stringify({ ...fixture.config, factual_binding_hash: `sha256:${'5'.repeat(64)}` }))],
  ['different execution identity', fixture => fs.writeFileSync(fixture.configFile, JSON.stringify({ ...fixture.config, instance_id: 'other-instance' }))],
]) {
  test(`v4 probe rejects lifecycle status with ${name}`, t => {
    const fixture = createManagedStatusFixture(t);
    mutate(fixture);
    assert.equal(readProbe(fixture).telemetry.verified, false);
  });
}

for (const [name, delta] of [['stale', -10 * 60 * 1000], ['future', 60 * 1000]]) {
  test(`v4 probe rejects ${name} lifecycle status despite a matching released managed run`, t => {
    const fixture = createManagedStatusFixture(t);
    const timestamp = new Date(Date.now() + delta);
    fs.utimesSync(fixture.config.source_preflight_status_path, timestamp, timestamp);
    const result = readProbe(fixture);
    assert.equal(result.telemetry.verified, false);
    assert.equal(result.telemetry.source_preflight.reason, 'SOURCE_PREFLIGHT_STATUS_STALE');
  });
}

test('v4 probe rejects a duplicate-key producer status instead of choosing a replay state', t => {
  const fixture = createManagedStatusFixture(t);
  fs.appendFileSync(fixture.config.source_preflight_status_path, 'replayStatus=0\n');
  assert.throws(() => readProbe(fixture), error => {
    assert.match(String(error.stderr), /SOURCE_PREFLIGHT_STATUS_MALFORMED/);
    return true;
  });
});
