import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { digest, objectHash, sealedHash } from './common.mjs';
import { decodeRunnerFields } from './operational-attempt-failure.mjs';

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
  'expected_chartbook_sha256', 'time_basis', 'session_calendar_revision',
  'fill_model_version', 'managed_candidate_id', 'expected_session_name',
  'expected_session_timezone',
  'expected_bar_period_seconds', 'expected_strategy_module_path',
  'expected_strategy_module_sha256', 'expected_telemetry_module_path',
  'expected_telemetry_module_sha256', 'source_preflight_status_path',
];

function fail(code) {
  throw new Error(code);
}

export function readReplayBridgeConfig(filename) {
  if (!path.isAbsolute(filename) || !fs.statSync(filename).isFile()) fail('CONFIG_FILE_REQUIRED');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const operational = value.schema_version === OPERATIONAL_CONFIG_SCHEMA;
  const required = operational ? OPERATIONAL_FIELDS : BASE_FIELDS;
  if (Object.keys(value).sort().join('\n') !== required.sort().join('\n')) fail('CONFIG_FIELDS_REJECTED');
  if (![TEST_CONFIG_SCHEMA, OPERATIONAL_CONFIG_SCHEMA].includes(value.schema_version) || value.base_url !== 'http://127.0.0.1:3102') fail('CONFIG_SCOPE_REJECTED');
  const pathFields = ['workflow_db', 'telemetry_db', 'handoff_path', 'expected_sierra_exe', 'state_file'];
  if (operational) pathFields.push('expected_chartbook_path', 'expected_strategy_module_path', 'expected_telemetry_module_path', 'source_preflight_status_path');
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
    for (const key of ['expected_chartbook_sha256', 'expected_strategy_module_sha256', 'expected_telemetry_module_sha256']) {
      if (!/^sha256:[a-f0-9]{64}$/.test(value[key])) fail('MODULE_HASH_REJECTED');
    }
    for (const key of ['time_basis', 'session_calendar_revision', 'fill_model_version']) {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 500) fail('RUN_SETTINGS_REJECTED');
    }
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value.managed_candidate_id)) fail('MANAGED_CANDIDATE_REJECTED');
    if (!/^[A-Za-z0-9_. -]{1,100}$/.test(value.expected_session_name)
      || !/^[A-Za-z0-9_./+-]{1,100}$/.test(value.expected_session_timezone)) fail('SESSION_IDENTITY_REJECTED');
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

function readCorrelatedRunningStart(config, run, db, replay, status, statusBytes) {
  const rejected = reason => ({ verified: false, reason });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='replay_run_attempts'").get()) return rejected('SOURCE_RUNNING_ATTEMPT_MISSING');
  const attempt = latest(db, 'replay_run_attempts', 'attempt_id');
  if (!Number.isSafeInteger(attempt?.attempt_id) || attempt.attempt_id < 1 || attempt.run_id !== run?.id
    || attempt.attempt_ended_utc != null || attempt.stop_command_id != null
    || attempt.start_command_id !== status.commandId) return rejected('SOURCE_RUNNING_ATTEMPT_CONFLICT');
  const managed = db.prepare('SELECT * FROM replay_run_context WHERE run_id=?').get(run.id);
  const commandPath = path.join(path.dirname(config.source_preflight_status_path), 'vwap-replay-command.txt');
  // This is the existing managed runner's exact independent controller channel.
  const controllerRoot = path.join(path.dirname(config.expected_sierra_exe), 'connector-control', 'patrading-tp');
  const controllerPath = path.join(controllerRoot, 'replay-status.json');
  const controllerCommandPath = path.join(controllerRoot, 'replay-command.json');
  const norm = value => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value).toLowerCase() : null;
  const read = filename => {
    const before = fs.statSync(filename), bytes = fs.readFileSync(filename), after = fs.statSync(filename);
    if (!before.isFile() || before.size > 32768 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('SOURCE_RUNNING_RECEIPT_CHANGED');
    return { filename, bytes, modified: after.mtimeMs };
  };
  try {
    const command = read(commandPath), controller = read(controllerPath), controllerCommand = read(controllerCommandPath);
    const start = decodeRunnerFields(command.bytes);
    const rawHash = value => String(value || '').replace(/^sha256:/, '').toLowerCase();
    if (start.action !== 'start' || start.commandId !== attempt.start_command_id
      || start.telemetryRunId !== run.id || start.telemetryStrategyId !== config.strategy_id
      || start.telemetryStrategyVersion !== config.expected_strategy_version
      || start.tradeAccount !== config.account_alias || start.expectedSymbol !== config.expected_symbol
      || start.telemetryRunStartedUtc !== attempt.attempt_started_utc
      || rawHash(start.telemetryDllSha256) !== rawHash(config.expected_strategy_module_sha256)
      || rawHash(replay.dll_hash) !== rawHash(config.expected_strategy_module_sha256)
      || start.telemetryContextHash !== run.release_context_hash
      || start.telemetryCandidateId !== managed.candidate_id || start.telemetryDatasetId !== managed.dataset_id
      || start.telemetryDatasetRole !== managed.dataset_role
      || !['StrategyProfileId','StrategyProfileVersion','StrategyCodeHash','StrategyConfigHash','SessionName','SessionTimezone'].every(key => {
        const field = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).slice(1);
        return start[`telemetry${key}`] === managed[field];
      })
      || (start.telemetrySessionObservationMode || null) !== (managed.session_observation_mode || null)) return rejected('SOURCE_RUNNING_START_CONTEXT_CONFLICT');
    const parts = status.detail.split('; '), detail = Object.create(null);
    if (!/^StartChartReplay(?:New)? result=[1-9][0-9]*$/.test(parts.shift())) return rejected('SOURCE_RUNNING_START_NOT_CONFIRMED');
    for (const part of parts) {
      const separator = part.indexOf('=');
      if (separator < 1 || Object.hasOwn(detail, part.slice(0, separator))) return rejected('SOURCE_RUNNING_START_NOT_CONFIRMED');
      detail[part.slice(0, separator)] = part.slice(separator + 1);
    }
    if (detail.transition_confirmed !== 'true' || status.controllerLifecycleActive !== 'true'
      || !['startDateTime','endDateTime','tradeStartDateTime'].every(key => start[key] && detail[key] === start[key])
      || (detail.effectiveReplayEndDateTime && detail.effectiveReplayEndDateTime !== start.endDateTime)) return rejected('SOURCE_RUNNING_START_NOT_CONFIRMED');
    const chartTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value);
    if (!['startDateTime','endDateTime','tradeStartDateTime'].every(key => chartTime(start[key]))
      || start.startDateTime >= start.endDateTime || start.tradeStartDateTime < start.startDateTime
      || start.tradeStartDateTime >= start.endDateTime || !chartTime(detail.effectiveStartDateTime)
      || detail.effectiveStartDateTime < start.startDateTime || detail.effectiveStartDateTime >= start.endDateTime) return rejected('SOURCE_RUNNING_START_NOT_CONFIRMED');
    const startTime = asUtcMillis(start.telemetryRunStartedUtc);
    const hookTime = fs.statSync(config.source_preflight_status_path).mtimeMs;
    if (!Number.isFinite(startTime) || hookTime < startTime - 1000 || hookTime > Date.now() + 5000
      || command.modified < startTime - 1000 || command.modified > hookTime + 1000) return rejected('SOURCE_RUNNING_START_TIME_CONFLICT');
    const receipt = JSON.parse(controller.bytes.toString('utf8'));
    const request = JSON.parse(controllerCommand.bytes.toString('utf8'));
    if (!freshTimestamp(new Date(controller.modified).toISOString(), config.freshness_seconds)
      || !freshTimestamp(new Date(controllerCommand.modified).toISOString(), config.freshness_seconds)) return rejected('SOURCE_RUNNING_CONTROLLER_STALE');
    if (receipt.schema !== 'ocean-trading.sierra-replay-controller.status.v1'
      || receipt.controllerVersion !== 'v0.2.1-cicd-vwap-time-basis'
      || request.schema !== 'ocean-trading.sierra-replay-controller.command.v1'
      || request.action !== 'status' || request.saveChartbook !== false
      || typeof request.commandId !== 'string' || !/^oql-managed-status-[a-f0-9]{32}$/.test(request.commandId)
      || receipt.commandId !== request.commandId || receipt.action !== 'status' || receipt.status !== 'status'
      || receipt.error != null || receipt.isReplayRunning !== true || receipt.replayStatus !== 1 || receipt.chartReplayStatus !== 1
      || receipt.chartNumber !== config.expected_chart_number || request.chartNumber !== config.expected_chart_number
      || norm(receipt.chartbookPath) !== norm(config.expected_chartbook_path)
      || norm(receipt.statusFilePath) !== norm(controllerPath)
      || norm(receipt.instanceDataFolder) !== norm(path.join(path.dirname(config.expected_sierra_exe), 'Data'))
      || norm(request.expectedInstanceDataFolder) !== norm(receipt.instanceDataFolder)
      || controller.modified < controllerCommand.modified - 1000
      || !chartTime(receipt.currentChartDateTime) || receipt.currentChartDateTime < start.startDateTime
      || receipt.currentChartDateTime > start.endDateTime) return rejected('SOURCE_RUNNING_CONTROLLER_CONFLICT');
    if (![command, controller, controllerCommand].every(file => fs.readFileSync(file.filename).equals(file.bytes))
      || !fs.readFileSync(config.source_preflight_status_path).equals(statusBytes)) return rejected('SOURCE_RUNNING_RECEIPT_CHANGED');
    const currentAttempt = latest(db, 'replay_run_attempts', 'attempt_id');
    if (currentAttempt?.attempt_id !== attempt.attempt_id || currentAttempt.attempt_ended_utc != null
      || currentAttempt.stop_command_id != null) return rejected('SOURCE_RUNNING_ATTEMPT_CONFLICT');
    return { verified: true, reason: null, verification_basis: 'EXACT_START_ATTEMPT_AND_FRESH_CONTROLLER',
      attempt_id: attempt.attempt_id, context_hash: run.release_context_hash,
      start_command_sha256: digest(command.bytes), start_receipt_sha256: digest(statusBytes),
      controller_command_sha256: digest(controllerCommand.bytes), controller_receipt_sha256: digest(controller.bytes),
      controller_command_id: receipt.commandId,
      current_chart_datetime: receipt.currentChartDateTime,
      start_chart_datetime: start.startDateTime, trade_start_chart_datetime: start.tradeStartDateTime,
      end_chart_datetime: start.endDateTime,
      controller_command_mtime_utc: new Date(controllerCommand.modified).toISOString(),
      controller_status_mtime_utc: new Date(controller.modified).toISOString() };
  } catch (error) {
    return rejected(/^[A-Z0-9_]+$/.test(error.code || error.message) ? error.code || error.message : 'SOURCE_RUNNING_RECEIPT_NOT_VERIFIED');
  }
}

function readSourcePreflight(config, lifecycleBindingVerified, run, db, replay) {
  if (!fs.existsSync(config.source_preflight_status_path)) return { verified: false, reason: 'SOURCE_PREFLIGHT_STATUS_MISSING' };
  const stat = fs.statSync(config.source_preflight_status_path);
  const ageMs = Date.now() - stat.mtimeMs;
  const fresh = ageMs >= -5000 && ageMs <= config.freshness_seconds * 1000;
  const values = Object.create(null);
  const statusBytes = fs.readFileSync(config.source_preflight_status_path);
  for (const line of statusBytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) fail('SOURCE_PREFLIGHT_STATUS_MALFORMED');
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) fail('SOURCE_PREFLIGHT_STATUS_MALFORMED');
    values[key] = line.slice(separator + 1);
  }
  const symbol = String(values.symbol || '').replace(/\[M\]$/, '');
  const detail = String(values.detail || '');
  const chartVerified = Boolean(values.commandId)
    && Number(values.chartNumber) === config.expected_chart_number
    && symbol === config.expected_symbol
    && Number(values.secondsPerBar) === config.expected_bar_period_seconds;
  const prepared = chartVerified
    && values.action === 'prepare_contract'
    && values.status === 'contract_prepared'
    && values.isReplayRunning === 'false'
    && Number(values.replayStatus) === 0
    && detail.includes(`requested_symbol=${config.expected_symbol}`)
    && detail.includes(`requested_intraday_bar_seconds=${config.expected_bar_period_seconds}`)
    && detail.includes('historical_open_chart_result=1')
    && detail.includes('historical_recalculate_chart_result=1')
    && detail.includes('intraday_open_chart_result=1')
    && detail.includes('intraday_recalculate_chart_result=1')
    && detail.includes('session_read_result=1');
  // Routine producer polls replace the preparation receipt; they are proof only
  // when current telemetry independently binds the exact released managed run.
  const running = values.isReplayRunning === 'true' && values.replayStatus === '1';
  const inactive = values.isReplayRunning === 'false' && values.replayStatus === '0';
  const lifecycleStatus = chartVerified
    && values.action === 'status' && values.status === 'status'
    && Number(values.chartDataType) === 2
    && detail === 'VWAP replay hook active.'
    && (running || inactive);
  const runningStart = chartVerified && running && Number(values.chartDataType) === 2
    && values.action === 'start' && values.status === 'running';
  if (!fresh && !runningStart) return { verified: false, reason: 'SOURCE_PREFLIGHT_STATUS_STALE', status_mtime_utc: stat.mtime.toISOString() };
  const startProof = runningStart && lifecycleBindingVerified === true
    ? readCorrelatedRunningStart(config, run, db, replay, values, statusBytes) : null;
  const verified = (fresh && (prepared || (lifecycleStatus && lifecycleBindingVerified === true))) || startProof?.verified === true;
  return {
    verified,
    reason: verified ? null : startProof?.reason || (lifecycleStatus || runningStart ? 'SOURCE_PREFLIGHT_STATUS_NOT_CORRELATED' : 'SOURCE_PREFLIGHT_STATUS_NOT_VERIFIED'),
    verification_basis: !verified ? null : startProof?.verified ? startProof.verification_basis : prepared ? 'CONTRACT_PREPARED' : running ? 'CORRELATED_RUNNING_STATUS' : 'CORRELATED_INACTIVE_STATUS',
    ...(startProof ? { managed_start_proof: startProof } : {}),
    command_id: values.commandId || null,
    symbol: values.symbol || null,
    chart_number: Number.isFinite(Number(values.chartNumber)) ? Number(values.chartNumber) : null,
    seconds_per_bar: Number.isFinite(Number(values.secondsPerBar)) ? Number(values.secondsPerBar) : null,
    replay_running: values.isReplayRunning === 'true',
    status_mtime_utc: stat.mtime.toISOString(),
  };
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

function managedReplayVerified(config, run, telemetryDb) {
  if (!run?.release_context_hash || run.id.startsWith('test-')) return false;
  if (!telemetryDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='replay_run_context'").get()) return false;
  const managed = telemetryDb.prepare('SELECT * FROM replay_run_context WHERE run_id=?').get(run.id);
  if (!managed) return false;
  const db = new DatabaseSync(config.workflow_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    const row = db.prepare(`
      SELECT r.context_json, p.payload_json, release.context_hash AS release_hash
      FROM ow_runs r JOIN ow_run_plans p ON p.id=r.id
      JOIN ow_operational_releases release ON release.run_id=r.id
      WHERE r.id=? AND r.strategy_id=? AND r.instance_id=? AND r.state IN ('READY','ACTIVE','COMPLETING')
    `).get(run.id, config.strategy_id, config.instance_id);
    if (!row) return false;
    let context, plan;
    try { context = JSON.parse(row.context_json); plan = JSON.parse(row.payload_json); } catch { return false; }
    if (!context || !plan || !/^sha256:[a-f0-9]{64}$/.test(context.context_hash)
      || sealedHash(context, 'context_hash') !== context.context_hash
      || context.context_hash !== run.release_context_hash || context.context_hash !== row.release_hash
      || context.run_id !== run.id || context.strategy_id !== config.strategy_id
      || context.execution_instance_id !== config.instance_id || context.expected_environment !== 'REPLAY'
      || sealedHash(plan, 'plan_hash') !== plan.plan_hash || plan.context_hash !== context.context_hash
      || plan.selection?.strategy_id !== config.strategy_id || plan.selection?.instance_id !== config.instance_id
      || plan.operational_review?.context?.context_hash !== context.context_hash
      || sealedHash(plan.operational_review.context, 'context_hash') !== context.context_hash
      || plan.operational_review?.factual_binding_hash !== config.factual_binding_hash) return false;
    if (!Number.isInteger(context.dataset_manifest_revision) || context.dataset_manifest_revision < 1
      || ![context.dataset_manifest_id, context.dataset_partition, context.strategy_profile_id, context.strategy_profile_version].every(value => typeof value === 'string' && value.trim())
      || ![context.strategy_code_hash, context.strategy_config_hash].every(value => /^sha256:[a-f0-9]{64}$/.test(value))
      || (context.candidate_id != null && context.candidate_id !== config.managed_candidate_id)) return false;
    return managed.context_hash === context.context_hash
      && managed.candidate_id === config.managed_candidate_id
      && managed.dataset_id === `${context.dataset_manifest_id}:${context.dataset_manifest_revision}`
      && managed.dataset_role === context.dataset_partition
      && ['strategy_profile_id', 'strategy_profile_version', 'strategy_code_hash', 'strategy_config_hash'].every(key => managed[key] === context[key])
      && managed.session_name === config.expected_session_name
      && managed.session_timezone === config.expected_session_timezone;
  } finally { db.close(); }
}

function freshTimestamp(value, seconds) {
  const ageMs = Date.now() - asUtcMillis(value);
  return Number.isFinite(ageMs) && ageMs >= -5000 && ageMs <= seconds * 1000;
}

function telemetry(config, run) {
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
    const accountFresh = !operational || freshTimestamp(account?.snapshot_utc, config.freshness_seconds);
    const loggerStart = `logger_started version=${config.expected_telemetry_version}`;
    const staticBindingVerified = schemaVersion >= schemaFloor
      && (logger?.message === loggerStart || logger?.message?.startsWith(`${loggerStart} `))
      && account?.trade_account === config.account_alias
      && Number(account?.is_simulated) === 1
      && instance?.instance_role === 'replay'
      && observedExe === expectedExe;
    const replayVerified = Boolean(replay)
      && replay.strategy_id === config.strategy_id
      && replay.run_id === run?.id
      && replay.strategy_version === config.expected_strategy_version
      && replay.instance_role === 'replay'
      && (!operational || (path.normalize(replay.chartbook || '').toLowerCase() === path.normalize(config.expected_chartbook_path).toLowerCase()
        && Number(replay.chart_number) === config.expected_chart_number
        && String(replay.bar_period || '').split(';').includes(`seconds=${config.expected_bar_period_seconds}`)));
    // last_seen_utc records logger configuration, not callback liveness.
    const lifecycleBindingVerified = operational && staticBindingVerified && replayVerified && accountFresh
      && Boolean(instance?.instance_id) && replay.instance_id === instance.instance_id
      && account.instance_id === instance.instance_id && instrument?.instance_id === instance.instance_id
      && instrument.trade_account === config.account_alias && observedSymbol === config.expected_symbol
      && Number(instrument.chart_number) === config.expected_chart_number
      && managedReplayVerified(config, run, db);
    const sourcePreflight = operational ? readSourcePreflight(config, lifecycleBindingVerified, run, db, replay) : null;
    const preflightVerified = staticBindingVerified
      && (!operational ? observedSymbol === config.expected_symbol && accountFresh : sourcePreflight.verified);
    const verified = preflightVerified && replayVerified;
    return {
      verified,
      preflight_verified: preflightVerified,
      static_binding_verified: staticBindingVerified,
      source_preflight: sourcePreflight,
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

// Synchronous read-only view: reverify physical sources, never reuse the bridge
// service lease or cached status file as current execution/completion authority.
export function readCurrentReplayExecution(configFile, { run, plan, context, storedPlan=plan }) {
  const rejected = reason => ({ status:'CURRENT_EXECUTION_UNVERIFIED',reason,
    completed_coverage_granted:false,
    next_action:'Verify fresh exact run/attempt/controller execution proof; the service heartbeat and historical activation are not current replay proof. No completed coverage is granted.' });
  try {
    const configBytes=fs.readFileSync(configFile),config=readReplayBridgeConfig(configFile);
    // Logical version belongs to the sealed released context. The physical
    // version is independently pinned by telemetry and the exact start below.
    if(config.schema_version!==OPERATIONAL_CONFIG_SCHEMA || !plan.operational_review
      || !['READY','ACTIVE','COMPLETING'].includes(run.state) || context.expected_environment!=='REPLAY'
      || run.id!==context.run_id || run.strategy_id!==config.strategy_id || run.instance_id!==config.instance_id
      || context.strategy_id!==config.strategy_id || context.execution_instance_id!==config.instance_id
      || plan.symbol!==config.expected_symbol || plan.instance?.account_alias!==config.account_alias
      || plan.instance?.execution_instance_id!==config.instance_id
      || plan.operational_review.factual_binding_hash!==config.factual_binding_hash
      || plan.context_hash!==context.context_hash || sealedHash(context,'context_hash')!==context.context_hash
      || sealedHash(storedPlan,'plan_hash')!==storedPlan.plan_hash || plan.plan_hash!==storedPlan.plan_hash
      || objectHash(plan.operational_review)!==objectHash(storedPlan.operational_review)) return rejected('CURRENT_EXECUTION_SCOPE_CONFLICT');
    const source=telemetry(config,{...run,release_context_hash:context.context_hash});
    const proof=source.source_preflight?.managed_start_proof;
    if(!source.verified || !proof?.verified || proof.context_hash!==context.context_hash
      || proof.verification_basis!=='EXACT_START_ATTEMPT_AND_FRESH_CONTROLLER')
      return rejected(proof?.reason || source.source_preflight?.reason || source.reason || 'CURRENT_EXECUTION_EXACT_PROOF_REQUIRED');
    const workflow=new DatabaseSync(config.workflow_db,{readOnly:true,timeout:2000});
    try {
      const row=workflow.prepare(`SELECT r.state,r.revision,r.context_json,p.payload_json,release.context_hash AS release_hash
        FROM ow_runs r JOIN ow_run_plans p ON p.id=r.id JOIN ow_operational_releases release ON release.run_id=r.id WHERE r.id=?`).get(run.id);
      if(!row || row.state!==run.state || row.revision!==run.revision || row.release_hash!==context.context_hash
        || objectHash(JSON.parse(row.context_json))!==objectHash(context)
        || objectHash(JSON.parse(row.payload_json))!==objectHash(storedPlan))return rejected('CURRENT_EXECUTION_WORKFLOW_CHANGED');
    }finally{workflow.close();}
    if(!fs.readFileSync(configFile).equals(configBytes))return rejected('CURRENT_EXECUTION_CONFIG_CHANGED');
    const until=Math.min(...[proof.controller_status_mtime_utc,proof.controller_command_mtime_utc,source.account_snapshot_utc]
      .map(value=>asUtcMillis(value)+config.freshness_seconds*1000));
    if(!Number.isFinite(until) || until<=Date.now())return rejected('CURRENT_EXECUTION_PROOF_EXPIRED');
    const phase=proof.current_chart_datetime>=proof.end_chart_datetime?'END_BOUNDARY_AWAITING_STOP'
      :proof.current_chart_datetime<proof.trade_start_chart_datetime?'WARMUP':'SCORED_REPLAY';
    return {status:'CURRENT_RUNNING_VERIFIED',run_id:run.id,context_hash:context.context_hash,
      verification_basis:proof.verification_basis,phase,attempt_id:proof.attempt_id,
      observed_at_utc:proof.controller_status_mtime_utc,valid_until_utc:new Date(until).toISOString(),
      chart_time_basis:'NATIVE_CHART_DATETIME_NOT_ASSUMED_UTC',current_chart_datetime:proof.current_chart_datetime,
      trade_start_chart_datetime:proof.trade_start_chart_datetime,end_chart_datetime:proof.end_chart_datetime,
      controller_command_id:proof.controller_command_id,controller_receipt_sha256:proof.controller_receipt_sha256,
      start_command_sha256:proof.start_command_sha256,start_receipt_sha256:proof.start_receipt_sha256,
      completed_coverage_granted:false,
      next_action:phase==='END_BOUNDARY_AWAITING_STOP'?'Exact replay reached the requested end; await independent physical stop and terminal drain/coverage reconciliation. Running is not completion.'
        :run.state==='READY'?'Exact physical replay is running; await scoped Ocean activation. No completed coverage is granted.'
        :phase==='WARMUP'?'Warmup is physically running for the exact attempt; await the native trade-start boundary. Scored and completed coverage are not yet proven.'
        :'Scored replay is physically running for the exact attempt; await physical stop, drain and complete coverage verification. Running is not completed coverage.'};
  }catch(error){return rejected(/^[A-Z0-9_]+$/.test(error.code || error.message)?error.code || error.message:'CURRENT_EXECUTION_SOURCE_READ_FAILED');}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readReplayBridgeConfig(process.argv[2]);
    const run = discoverRun(config);
    console.log(JSON.stringify({
      schema_version: config.schema_version,
      observed_at_utc: new Date().toISOString(),
      run,
      telemetry: telemetry(config, run),
    }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_FAILED' }));
    process.exitCode = 2;
  }
}
