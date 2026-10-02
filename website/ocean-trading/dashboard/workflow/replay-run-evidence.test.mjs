import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const script = fileURLToPath(new URL('./replay-run-evidence.mjs', import.meta.url));
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(80, 1)]);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-replay-evidence-'));
  const workflowDb = path.join(root, 'workflow.sqlite');
  const telemetryDb = path.join(root, 'telemetry.sqlite');
  const runId = 'test-run-1';
  const context = { context_hash: 'sha256:' + '1'.repeat(64) };
  const plan = { scored_intervals: [{ start_utc: '2025-05-01T00:00:00.000Z', end_utc: '2025-06-01T00:00:00.000Z' }] };
  const workflow = new DatabaseSync(workflowDb);
  workflow.exec(`
    CREATE TABLE ow_runs (id TEXT, strategy_id TEXT, instance_id TEXT, revision INTEGER, state TEXT, context_json TEXT);
    CREATE TABLE ow_run_plans (id TEXT, coverage_key TEXT, payload_json TEXT);
    CREATE TABLE ow_trade_pins (id TEXT, run_id TEXT, context_hash TEXT, state TEXT);
    CREATE TABLE ow_evidence_revisions (id INTEGER PRIMARY KEY, run_id TEXT, event_id TEXT, canonical_id TEXT, market_id TEXT, payload_json TEXT);
  `);
  workflow.prepare('INSERT INTO ow_runs VALUES (?,?,?,?,?,?)').run(runId, 'cicd-vwap-pull-back-strategy', 'test-cicd-vwap-pull-back-replay-two-v012', 2, 'ACTIVE', JSON.stringify(context));
  workflow.prepare('INSERT INTO ow_run_plans VALUES (?,?,?)').run(runId, 'coverage', JSON.stringify(plan));
  workflow.close();
  const telemetry = new DatabaseSync(telemetryDb);
  telemetry.exec(`
    CREATE TABLE replay_runs (run_id TEXT, strategy_id TEXT, strategy_version TEXT, instance_role TEXT, instance_id TEXT);
    CREATE TABLE trades (trade_id INTEGER, run_id TEXT, instance_id TEXT, trade_account TEXT, is_simulated INTEGER, symbol TEXT, status TEXT, final_quantity REAL, opening_order_id INTEGER, closing_order_id INTEGER, entry_datetime TEXT, exit_datetime TEXT, direction TEXT, average_entry_price REAL, average_exit_price REAL, max_quantity REAL, initial_quantity REAL, net_profit_loss REAL, gross_currency_value REAL);
    CREATE TABLE trade_legs (leg_id INTEGER, trade_id INTEGER, internal_order_id INTEGER, fill_datetime TEXT, quantity REAL, fill_price REAL);
    INSERT INTO replay_runs VALUES ('test-run-1','cicd-vwap-pull-back-strategy','v0.6.227','replay','instance-physical');
    INSERT INTO trades VALUES (7,'test-run-1','instance-physical','Sim1',1,'MNQM25_FUT_CME','closed',0,101,102,'45778.5','45778.75','long',20000,20010,1,1,18.86,20);
    INSERT INTO trade_legs VALUES (1,7,101,'2025-05-01T12:00:00Z',1,20000);
    INSERT INTO trade_legs VALUES (2,7,102,'2025-05-01T18:00:00Z',1,20010);
  `);
  telemetry.close();
  const config = { workflow_db: workflowDb, telemetry_db: telemetryDb, strategy_id: 'cicd-vwap-pull-back-strategy', instance_id: 'test-cicd-vwap-pull-back-replay-two-v012', account_alias: 'Sim1', expected_symbol: 'MNQM25_FUT_CME', expected_strategy_version: 'v0.6.227' };
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { root, configFile, runId, telemetryDb, workflowDb };
}

function run(value) {
  return JSON.parse(execFileSync(process.execPath, [script, value.configFile, value.runId], { encoding: 'utf8' }));
}

function writeOperationalCompletion(value) {
  const directory = path.join(value.root, 'evidence');
  const image = fs.readFileSync(path.join(directory, `${value.runId}-sierra.png`));
  fs.writeFileSync(path.join(directory, `${value.runId}-completion.json`), JSON.stringify({
    schema_version: 'ocean-replay-completion/v1',
    run_id: value.runId,
    status: 'COMPLETED',
    replay_start_utc: '2025-04-17T00:00:00.000Z',
    scored_start_utc: '2025-05-01T00:00:00.000Z',
    end_exclusive_utc: '2025-06-01T00:00:00.000Z',
    completed_at_utc: new Date().toISOString(),
    evidence_image_sha256: `sha256:${createHash('sha256').update(image).digest('hex')}`,
    lifecycle_sha256: `sha256:${'2'.repeat(64)}`,
    candidate_sha256: `sha256:${'3'.repeat(64)}`,
    simulation_account: 'Sim1',
    live_real: 'DISABLED',
  }));
}

test('waits for a genuine Sierra evidence image before exposing trade evidence', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const result = run(value);
  assert.equal(result.status, 'AWAITING_SIERRA_EVIDENCE_IMAGE');
  assert.equal(result.run_id, value.runId);
});

test('builds deterministic pin, evidence and close actions for a scoped simulated trade', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const directory = path.join(value.root, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${value.runId}-sierra.png`), png);
  const result = run(value);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.actions.map(action => action.type), ['pin-open','evidence','pin-close']);
  assert.equal(result.actions[1].data.symbol, 'MNQM25_FUT_CME');
  assert.equal(result.actions[1].data.side, 'LONG');
  assert.match(result.actions[1].data.facts.screenshot_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.metrics.closed_trades, 1);
  assert.equal(result.metrics.net_profit_loss, 18.86);
});

test('rejects a trade from the wrong contract', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const directory = path.join(value.root, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${value.runId}-sierra.png`), png);
  const db = new DatabaseSync(value.telemetryDb);
  db.exec("UPDATE trades SET symbol='MNQH26_FUT_CME'");
  db.close();
  assert.throws(() => run(value), /TRADE_SCOPE_MISMATCH/);
});

test('uses non-test evidence identities for an operational bridge', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(value.configFile, 'utf8'));
  config.schema_version = 'ocean-replay-run-bridge/v4';
  fs.writeFileSync(value.configFile, JSON.stringify(config));
  const directory = path.join(value.root, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${value.runId}-sierra.png`), png);
  writeOperationalCompletion(value);
  const result = run(value);
  assert.equal(result.actions[0].data.trade_id, 'sierra-trade-7');
  assert.equal(result.actions[1].data.event_id, 'sierra-event-7');
  assert.equal(result.actions[1].data.legacy_trade_id, 'sierra-legacy-7');
});

test('operational evidence waits for the post-validation completion receipt', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(value.configFile, 'utf8'));
  config.schema_version = 'ocean-replay-run-bridge/v4';
  fs.writeFileSync(value.configFile, JSON.stringify(config));
  const directory = path.join(value.root, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${value.runId}-sierra.png`), png);
  const result = run(value);
  assert.equal(result.status, 'AWAITING_REPLAY_COMPLETION');
  assert.match(result.completion_receipt, /test-run-1-completion\.json$/);
});

test('uses the sealed operational selection interval when scored_intervals is absent', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const workflow = new DatabaseSync(value.workflowDb);
  workflow.prepare('UPDATE ow_run_plans SET payload_json=? WHERE id=?').run(JSON.stringify({
    selection: {
      interval: {
        start_utc: '2025-05-01T00:00:00.000Z',
        end_utc: '2025-06-01T00:00:00.000Z',
      },
    },
  }), value.runId);
  workflow.close();
  const directory = path.join(value.root, 'evidence');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `${value.runId}-sierra.png`), png);
  const result = run(value);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.scored_intervals, [{
    start_utc: '2025-05-01T00:00:00.000Z',
    end_utc: '2025-06-01T00:00:00.000Z',
  }]);
  assert.equal(result.watermark, '2025-06-01T00:00:00.000Z');
});
