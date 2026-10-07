import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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
