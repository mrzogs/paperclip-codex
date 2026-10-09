import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './store.mjs';

const migrations = new URL('./migrations/', import.meta.url);

function createVersion11Database(filename) {
  const db = new DatabaseSync(filename);
  for (let version = 1; version <= 11; version += 1) {
    db.exec(fs.readFileSync(new URL(`${String(version).padStart(3, '0')}-up.sql`, migrations), 'utf8'));
  }
  db.prepare('INSERT INTO ow_profiles(id,strategy_id,version,content_hash,payload_json) VALUES(?,?,?,?,?)')
    .run('test-profile', 'test-strategy', 'v1', 'sha256:test', '{}');
  db.prepare('INSERT INTO ow_strategies(id,profile_id,revision,baseline_hash,payload_json) VALUES(?,?,?,?,?)')
    .run('test-strategy', 'test-profile', 1, 'sha256:test', '{}');
  db.prepare('INSERT INTO ow_instances(id,strategy_id,payload_json) VALUES(?,?,?)')
    .run('test-instance', 'test-strategy', '{}');
  db.prepare('INSERT INTO ow_runs(id,strategy_id,instance_id,revision,state,context_json) VALUES(?,?,?,?,?,?)')
    .run('test-run', 'test-strategy', 'test-instance', 1, 'FAILED', '{}');
  const progress = db.prepare('INSERT INTO ow_run_progress(run_id,payload_json) VALUES(?,?)');
  const coverage = db.prepare('INSERT INTO ow_coverage_receipts(run_id,coverage_key,status,payload_json) VALUES(?,?,?,?)');
  const event = db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (let index = 0; index < 12_000; index += 1) progress.run('test-run', JSON.stringify({ index }));
    coverage.run('test-run', 'test-coverage', 'FAILED', '{}');
    event.run('test-run', 'run-manager.end', 'test-actor', 'TELEMETRY', '2026-10-09T00:00:00.000Z', '{}');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.close();
}

function planDetail(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('test-run').map(row => row.detail).join(' ');
}

test('v11 upgrade adds bounded run-read indexes and is idempotent', () => {
  const root = path.join(os.tmpdir(), 'ocean-workflow-index-migration-test');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(root);
  const filename = path.join(root, 'workflow.sqlite');
  try {
    createVersion11Database(filename);
    let store = new WorkflowStore(filename);
    assert.equal(store.db.prepare('SELECT MAX(version) version FROM ow_schema_migrations').get().version, 12);
    assert.match(planDetail(store.db, 'SELECT payload_json FROM ow_run_progress WHERE run_id=? ORDER BY id DESC LIMIT 1'), /ow_run_progress_run_latest/);
    assert.match(planDetail(store.db, 'SELECT payload_json FROM ow_coverage_receipts WHERE run_id=? ORDER BY id DESC LIMIT 1'), /ow_coverage_receipts_run_latest/);
    assert.match(planDetail(store.db, "SELECT payload_json FROM ow_events WHERE entity_id=? AND action='run-manager.end' ORDER BY id DESC LIMIT 1"), /ow_events_entity_action_latest/);
    const started = performance.now();
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT payload_json FROM ow_run_progress WHERE run_id=? ORDER BY id DESC LIMIT 1').get('test-run').payload_json), { index: 11_999 });
    assert.ok(performance.now() - started < 250, 'indexed latest-progress lookup must stay bounded');
    store.close();

    store = new WorkflowStore(filename);
    assert.equal(store.db.prepare('SELECT COUNT(*) count FROM ow_schema_migrations WHERE version=12').get().count, 1);
    store.close();
  } finally {
    // node:sqlite can retain the empty directory handle until process exit on Windows.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) {
      if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    }
  }
});
