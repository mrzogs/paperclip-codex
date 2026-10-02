import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TEST_CONFIG_SCHEMA = 'ocean-replay-run-bridge/v3';
const OPERATIONAL_CONFIG_SCHEMA = 'ocean-replay-run-bridge/v4';
const BASE_FIELDS = [
  'schema_version', 'base_url', 'workflow_db', 'telemetry_db', 'handoff_path',
  'strategy_id', 'instance_id', 'identity_id', 'credential_ref', 'account_alias', 'expected_symbol',
  'expected_strategy_version', 'expected_telemetry_version', 'expected_sierra_exe',
  'poll_seconds', 'state_file',
];
const OPERATIONAL_FIELDS = [
  ...BASE_FIELDS, 'namespace', 'factual_binding_hash', 'minimum_schema_version',
  'freshness_seconds', 'expected_chartbook_path', 'expected_chart_number',
  'expected_bar_period_seconds', 'expected_strategy_module_path',
  'expected_strategy_module_sha256', 'expected_telemetry_module_path',
  'expected_telemetry_module_sha256',
];

function fail(code) {
  throw new Error(code);
}

function readConfig(filename) {
  if (!path.isAbsolute(filename) || !fs.statSync(filename).isFile()) fail('CONFIG_FILE_REQUIRED');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const operational = value.schema_version === OPERATIONAL_CONFIG_SCHEMA;
  const required = operational ? OPERATIONAL_FIELDS : BASE_FIELDS;
  if (Object.keys(value).sort().join('\n') !== required.sort().join('\n')) fail('CONFIG_FIELDS_REJECTED');
  if (![TEST_CONFIG_SCHEMA, OPERATIONAL_CONFIG_SCHEMA].includes(value.schema_version) || value.base_url !== 'http://127.0.0.1:3102') fail('CONFIG_SCOPE_REJECTED');
  const pathFields = ['workflow_db', 'telemetry_db', 'handoff_path', 'expected_sierra_exe', 'state_file'];
  if (operational) pathFields.push('expected_chartbook_path', 'expected_strategy_module_path', 'expected_telemetry_module_path');
  for (const key of pathFields) {
    if (!path.isAbsolute(value[key]) || String(value[key]).startsWith('\\\\')) fail('LOCAL_PATH_REQUIRED');
  }
  if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value.strategy_id)) fail('IDENTITY_SCOPE_REJECTED');
  if (operational) {
    if (value.namespace !== 'OPERATIONAL' || value.instance_id.startsWith('test-') || !/^[A-Za-z0-9_.:-]+$/.test(value.instance_id)) fail('IDENTITY_SCOPE_REJECTED');
    if (!/^sha256:[a-f0-9]{64}$/.test(value.factual_binding_hash)) fail('FACTUAL_BINDING_HASH_REQUIRED');
    if (!Number.isInteger(value.minimum_schema_version) || value.minimum_schema_version < 9) fail('SCHEMA_FLOOR_REJECTED');
    if (!Number.isInteger(value.freshness_seconds) || value.freshness_seconds < 30 || value.freshness_seconds > 300) fail('FRESHNESS_WINDOW_REJECTED');
    if (!Number.isInteger(value.expected_chart_number) || value.expected_chart_number < 1) fail('CHART_NUMBER_REJECTED');
    if (!Number.isInteger(value.expected_bar_period_seconds) || value.expected_bar_period_seconds !== 300) fail('BAR_PERIOD_REJECTED');
    for (const key of ['expected_strategy_module_sha256', 'expected_telemetry_module_sha256']) {
      if (!/^sha256:[a-f0-9]{64}$/.test(value[key])) fail('MODULE_HASH_REJECTED');
    }
  } else if (!/^test-[A-Za-z0-9_.:-]+$/.test(value.instance_id)) fail('IDENTITY_SCOPE_REJECTED');
  if ((!operational && value.identity_id !== `${value.instance_id}-telemetry`) || !/^[A-Za-z0-9_.:-]+$/.test(value.identity_id) || !/^OCEAN_[A-Z0-9_]+_TOKEN$/.test(value.credential_ref)) fail('TELEMETRY_IDENTITY_REJECTED');
  if (!/^MNQ[A-Z][0-9]{2}_FUT_CME$/.test(value.expected_symbol) || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value.expected_strategy_version)) fail('PHYSICAL_BINDING_REJECTED');
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value.expected_telemetry_version)) fail('TELEMETRY_VERSION_REJECTED');
  if (!Number.isInteger(value.poll_seconds) || value.poll_seconds < 5 || value.poll_seconds > 20) fail('POLL_INTERVAL_REJECTED');
  return value;
}

function asUtcMillis(value) {
  if (typeof value !== 'string' || !value) return Number.NaN;
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
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
    const run = db.prepare(`
      SELECT id, state, revision
      FROM ow_runs
      WHERE strategy_id=? AND instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')
      ORDER BY rowid DESC LIMIT 1
    `).get(config.strategy_id, config.instance_id) || null;
    if (!run || config.schema_version !== OPERATIONAL_CONFIG_SCHEMA) return run;
    const release = db.prepare('SELECT context_hash FROM ow_operational_releases WHERE run_id=?').get(run.id);
    return { ...run, release_context_hash: release?.context_hash || null };
  } finally {
    db.close();
  }
}

function telemetry(config, expectedRunId) {
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
    const operational = config.schema_version === OPERATIONAL_CONFIG_SCHEMA;
    const schemaFloor = operational ? config.minimum_schema_version : 7;
    const accountFresh = !operational || (Number.isFinite(asUtcMillis(account?.snapshot_utc)) && Date.now() - asUtcMillis(account.snapshot_utc) <= config.freshness_seconds * 1000 && asUtcMillis(account.snapshot_utc) <= Date.now() + 5000);
    const preflightVerified = schemaVersion >= schemaFloor
      && logger?.message?.startsWith(`logger_started version=${config.expected_telemetry_version}`)
      && account?.trade_account === config.account_alias
      && Number(account?.is_simulated) === 1
      && instance?.instance_role === 'replay'
      && observedExe === expectedExe
      && observedSymbol === config.expected_symbol
      && accountFresh;
    const replayVerified = Boolean(replay)
      && replay.strategy_id === config.strategy_id
      && replay.run_id === expectedRunId
      && replay.strategy_version === config.expected_strategy_version
      && replay.instance_role === 'replay'
      && (!operational || (path.normalize(replay.chartbook || '').toLowerCase() === path.normalize(config.expected_chartbook_path).toLowerCase()
        && Number(replay.chart_number) === config.expected_chart_number
        && String(replay.bar_period || '').includes(`seconds=${config.expected_bar_period_seconds}`)));
    const verified = preflightVerified && replayVerified;
    return {
      verified,
      preflight_verified: preflightVerified,
      run_verified: verified,
      reason: verified ? null : !operational ? 'TELEMETRY_BINDING_NOT_VERIFIED' : !preflightVerified ? 'TELEMETRY_PREFLIGHT_NOT_VERIFIED' : 'AWAITING_MATCHING_REPLAY_RUN',
      source_schema_version: `sierra-telemetry-sqlite/${schemaVersion}`,
      logger_started_utc: logger?.created_utc || null,
      expected_telemetry_version: config.expected_telemetry_version,
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
  const run = discoverRun(config);
  console.log(JSON.stringify({
    schema_version: config.schema_version,
    observed_at_utc: new Date().toISOString(),
    run,
    telemetry: telemetry(config, run?.id || null),
  }));
} catch (error) {
  console.error(JSON.stringify({ status: 'BLOCKED', error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_FAILED' }));
  process.exitCode = 2;
}
