import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CONFIG_SCHEMA = 'ocean-replay-run-bridge/v2';

function fail(code) {
  throw new Error(code);
}

function readConfig(filename) {
  if (!path.isAbsolute(filename) || !fs.statSync(filename).isFile()) fail('CONFIG_FILE_REQUIRED');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const required = [
    'schema_version', 'base_url', 'workflow_db', 'telemetry_db', 'handoff_path',
    'strategy_id', 'instance_id', 'identity_id', 'credential_ref', 'account_alias', 'expected_symbol',
    'expected_strategy_version', 'expected_sierra_exe',
    'poll_seconds', 'state_file',
  ];
  if (Object.keys(value).sort().join('\n') !== required.sort().join('\n')) fail('CONFIG_FIELDS_REJECTED');
  if (value.schema_version !== CONFIG_SCHEMA || value.base_url !== 'http://127.0.0.1:3102') fail('CONFIG_SCOPE_REJECTED');
  for (const key of ['workflow_db', 'telemetry_db', 'handoff_path', 'expected_sierra_exe', 'state_file']) {
    if (!path.isAbsolute(value[key]) || String(value[key]).startsWith('\\\\')) fail('LOCAL_PATH_REQUIRED');
  }
  if (!/^test-[A-Za-z0-9_.:-]+$/.test(value.instance_id) || !/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value.strategy_id)) fail('IDENTITY_SCOPE_REJECTED');
  if (value.identity_id !== `${value.instance_id}-telemetry` || !/^OCEAN_[A-Z0-9_]+_TOKEN$/.test(value.credential_ref)) fail('TELEMETRY_IDENTITY_REJECTED');
  if (!/^MNQ[A-Z][0-9]{2}_FUT_CME$/.test(value.expected_symbol) || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value.expected_strategy_version)) fail('PHYSICAL_BINDING_REJECTED');
  if (!Number.isInteger(value.poll_seconds) || value.poll_seconds < 5 || value.poll_seconds > 20) fail('POLL_INTERVAL_REJECTED');
  return value;
}

function latest(db, table, order) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order} DESC LIMIT 1`).get() || null;
}

function count(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

function runCount(db, table, runId, extra = '') {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id=? ${extra}`).get(runId).n);
}

function discoverRun(config) {
  const db = new DatabaseSync(config.workflow_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    return db.prepare(`
      SELECT id, state, revision
      FROM ow_runs
      WHERE strategy_id=? AND instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')
      ORDER BY rowid DESC LIMIT 1
    `).get(config.strategy_id, config.instance_id) || null;
  } finally {
    db.close();
  }
}

function telemetry(config) {
  if (!fs.existsSync(config.telemetry_db)) return { verified: false, reason: 'TELEMETRY_DB_MISSING' };
  const db = new DatabaseSync(config.telemetry_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    const schemaVersion = Number(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version || 0);
    const logger = latest(db, 'logger_health', 'health_id');
    const account = latest(db, 'account_snapshot', 'account_snapshot_id');
    const instrument = latest(db, 'instrument_snapshot', 'instrument_snapshot_id');
    const replay = latest(db, 'replay_runs', 'created_utc');
    const instance = latest(db, 'sierra_instance', 'last_seen_utc');
    const expectedExe = path.normalize(config.expected_sierra_exe).toLowerCase();
    const observedExe = path.normalize(instance?.sierra_exe_path || '').toLowerCase();
    const observedSymbol = String(instrument?.symbol || '').replace(/\[M\]$/, '');
    const verified = schemaVersion >= 7
      && logger?.message?.startsWith('logger_started version=v0.5.26')
      && account?.trade_account === config.account_alias
      && Number(account?.is_simulated) === 1
      && replay?.strategy_id === config.strategy_id
      && replay?.strategy_version === config.expected_strategy_version
      && replay?.instance_role === 'replay'
      && instance?.instance_role === 'replay'
      && observedExe === expectedExe
      && observedSymbol === config.expected_symbol;
    return {
      verified,
      reason: verified ? null : 'TELEMETRY_BINDING_NOT_VERIFIED',
      source_schema_version: `sierra-telemetry-sqlite/${schemaVersion}`,
      logger_started_utc: logger?.created_utc || null,
      account_snapshot_utc: account?.snapshot_utc || null,
      replay_run_id: replay?.run_id || null,
      physical_strategy_version: replay?.strategy_version || null,
      instrument_symbol: instrument?.symbol || null,
      instance_id: instance?.instance_id || null,
      counts: {
        fills: replay?.run_id ? runCount(db, 'fills', replay.run_id) : 0,
        orders: replay?.run_id ? runCount(db, 'orders', replay.run_id) : 0,
        trades: replay?.run_id ? runCount(db, 'trades', replay.run_id) : 0,
        open_trades: replay?.run_id ? runCount(db, 'trades', replay.run_id, "AND LOWER(status)<>'closed'") : 0,
      },
      database_mtime_utc: fs.statSync(config.telemetry_db).mtime.toISOString(),
    };
  } finally {
    db.close();
  }
}

try {
  const config = readConfig(process.argv[2]);
  console.log(JSON.stringify({
    schema_version: CONFIG_SCHEMA,
    observed_at_utc: new Date().toISOString(),
    run: discoverRun(config),
    telemetry: telemetry(config),
  }));
} catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED', error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_FAILED' }));
  process.exitCode = 2;
}
