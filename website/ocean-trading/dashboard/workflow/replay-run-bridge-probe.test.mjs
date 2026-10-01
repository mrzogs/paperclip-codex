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
      INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.26 test', '2026-10-01T09:22:25Z');
      CREATE TABLE account_snapshot (account_snapshot_id INTEGER PRIMARY KEY, trade_account TEXT, is_simulated INTEGER, snapshot_utc TEXT);
      INSERT INTO account_snapshot VALUES (1, 'Sim1', 1, '2026-10-01T09:23:24Z');
      CREATE TABLE instrument_snapshot (instrument_snapshot_id INTEGER PRIMARY KEY, symbol TEXT);
      INSERT INTO instrument_snapshot VALUES (1, 'MNQM25_FUT_CME');
      CREATE TABLE replay_runs (run_id TEXT, created_utc TEXT, strategy_id TEXT, instance_role TEXT, strategy_version TEXT);
      INSERT INTO replay_runs VALUES ('test-run-1', '2026-10-01T09:22:26Z', 'cicd-vwap-pull-back-strategy', 'replay', 'v0.6.228');
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
    schema_version: 'ocean-replay-run-bridge/v2',
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
    expected_strategy_version: 'v0.6.228',
    expected_sierra_exe: expectedExe,
    poll_seconds: 10,
    state_file: path.join(directory, 'state.json'),
  };
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { directory, configFile, telemetryDb };
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
