import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash, requireThat, sealedHash } from './common.mjs';

const REASONS = new Set(['start_exception', 'start_status_error', 'managed_evidence_capture_failure',
  'managed_resume_identity_failure', 'completion_status_error', 'managed_completion_identity_failure',
  'managed_artifact_validation_failure', 'adopted_completion_status_error']);
const normPath = value => path.resolve(value).toLowerCase();
const rawHash = value => String(value || '').replace(/^sha256:/, '').toLowerCase();
const at = value => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value || '') ? value.replace(' ', 'T') + 'Z' : value);

// These are the runner's line-delimited command/status files, not STTL2 tags.
export function decodeRunnerFields(bytes) {
  requireThat(bytes.length <= 32768, 409, 'RUNNER_FIELDS_TOO_LARGE');
  const result = {};
  for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('=');
    requireThat(separator > 0, 409, 'RUNNER_FIELD_INVALID');
    const key = line.slice(0, separator);
    requireThat(/^[A-Za-z][A-Za-z0-9]*$/.test(key) && !Object.hasOwn(result, key), 409, 'RUNNER_FIELD_DUPLICATE_OR_INVALID');
    result[key] = line.slice(separator + 1);
  }
  return result;
}

function retainedBytes(value, hash) {
  requireThat(typeof value === 'string' && value.length <= 45000 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 409, 'FAILURE_RAW_BYTES_REQUIRED');
  const bytes = Buffer.from(value, 'base64');
  requireThat(bytes.toString('base64') === value && rawHash(digest(bytes)) === rawHash(hash), 409, 'FAILURE_RAW_HASH_CONFLICT');
  return bytes;
}

export function readAttemptFailure(config, { run, context, plan }) {
  if(!config.source_preflight_status_path) return null;
  const failurePath = path.join(path.dirname(config.source_preflight_status_path), 'managed-failure-stop.json');
  if (!fs.existsSync(failurePath)) return null;
  requireThat(config.schema_version === 'ocean-replay-run-bridge/v4' && config.namespace === 'OPERATIONAL'
    && plan.operational_review && config.strategy_id === run.strategy_id && config.instance_id === run.instance_id
    && config.factual_binding_hash === plan.operational_review.factual_binding_hash, 409, 'FAILURE_FACTUAL_SCOPE_CONFLICT');
  const bytes = fs.readFileSync(failurePath);
  requireThat(bytes.length <= 131072, 409, 'FAILURE_RECEIPT_TOO_LARGE');
  const failure = JSON.parse(bytes);
  if (failure.run_id !== run.id) return null;
  requireThat(sealedHash(context,'context_hash')===context.context_hash && plan.context_hash===context.context_hash,
    409,'FAILURE_FROZEN_CONTEXT_HASH_CONFLICT');
  requireThat(REASONS.has(failure.reason) && Number.isFinite(at(failure.observed_at_utc)), 409, 'RUNNER_FAILURE_REASON_REQUIRED');
  const raw = failure.hook_failure_evidence;
  requireThat(raw && raw.reason === failure.reason, 409, 'RETAINED_RUNNER_FAILURE_REQUIRED');
  const start = decodeRunnerFields(retainedBytes(raw.command_bytes_base64, raw.command_sha256));
  retainedBytes(raw.status_bytes_base64, raw.status_sha256);
  const identity = { telemetryRunId: run.id, telemetryStrategyId: context.strategy_id,
    telemetryStrategyCodeHash: context.strategy_code_hash, telemetryStrategyConfigHash: context.strategy_config_hash,
    telemetryContextHash: context.context_hash, telemetryDatasetId: `${context.dataset_manifest_id}:${context.dataset_manifest_revision}`,
    telemetryDatasetRole: context.dataset_partition, telemetryStrategyProfileId: context.strategy_profile_id,
    telemetryStrategyProfileVersion: context.strategy_profile_version, tradeAccount: plan.instance.account_alias,
    expectedSymbol: plan.symbol };
  requireThat(start.action === 'start' && Object.entries(identity).every(([key, value]) => start[key] === value),
    409, 'FAILURE_START_CONTEXT_CONFLICT');
  const controller = failure.controller_receipt;
  requireThat(controller?.schema === 'ocean-trading.sierra-replay-controller.status.v1'
    && controller.action === 'stop' && controller.isReplayRunning === false
    && Number(controller.replayStatus) === 0 && Number(controller.chartReplayStatus) === 0
    && Number(controller.chartNumber) === config.expected_chart_number
    && normPath(controller.chartbookPath) === normPath(config.expected_chartbook_path)
    && normPath(controller.instanceDataFolder) === normPath(path.join(path.dirname(config.expected_sierra_exe), 'Data')),
  409, 'FAILURE_PHYSICAL_STOP_NOT_VERIFIED');
  const statusBytes = fs.readFileSync(config.source_preflight_status_path), status = decodeRunnerFields(statusBytes);
  const stopId = start.commandId?.replace(/-start$/, '-failed-start-stop');
  requireThat(start.commandId?.endsWith('-start') && status.commandId === stopId && status.action === 'stop'
    && status.status === 'stopped' && status.isReplayRunning === 'false' && status.replayStatus === '0'
    && status.controllerLifecycleActive === 'false' && Number(status.chartNumber) === config.expected_chart_number
    && status.symbol === plan.symbol, 409, 'FAILURE_EXACT_HOOK_STOP_NOT_VERIFIED');
  const db = new DatabaseSync(config.telemetry_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN;');
    const replay = db.prepare('SELECT * FROM replay_runs WHERE run_id=?').get(run.id);
    const attempt = db.prepare('SELECT * FROM replay_run_attempts WHERE run_id=? ORDER BY attempt_id DESC LIMIT 1').get(run.id);
    const receipt = attempt && db.prepare('SELECT * FROM telemetry_run_receipts WHERE run_id=? AND attempt_id=?').get(run.id, attempt.attempt_id);
    const recorded = db.prepare('SELECT * FROM replay_run_context WHERE run_id=?').get(run.id);
    const physical = replay && db.prepare('SELECT * FROM sierra_instance WHERE instance_id=?').get(replay.instance_id);
    requireThat(replay && recorded && replay.strategy_id === run.strategy_id && replay.strategy_version === start.telemetryStrategyVersion
      && physical?.instance_role === 'replay' && normPath(physical.sierra_exe_path) === normPath(config.expected_sierra_exe)
      && replay.instance_role === 'replay' && replay.chart_number === config.expected_chart_number
      && normPath(replay.chartbook) === normPath(config.expected_chartbook_path)
      && rawHash(replay.dll_hash) === rawHash(start.telemetryDllSha256)
      && rawHash(replay.dll_hash) === rawHash(config.expected_strategy_module_sha256), 409, 'FAILURE_RECORDED_PHYSICAL_SCOPE_CONFLICT');
    const contextFields = { context_hash: context.context_hash, strategy_code_hash: context.strategy_code_hash,
      strategy_config_hash: context.strategy_config_hash, dataset_id: identity.telemetryDatasetId,
      dataset_role: context.dataset_partition, strategy_profile_id: context.strategy_profile_id,
      strategy_profile_version: context.strategy_profile_version, candidate_id: start.telemetryCandidateId,
      session_name: start.telemetrySessionName, session_timezone: start.telemetrySessionTimezone };
    requireThat(start.telemetryStrategyVersion===config.expected_strategy_version
      && start.telemetryCandidateId===config.managed_candidate_id
      && start.telemetrySessionName===config.expected_session_name
      && start.telemetrySessionTimezone===config.expected_session_timezone,409,'FAILURE_APPROVED_MAPPING_CONFLICT');
    requireThat(Object.entries(contextFields).every(([key, value]) => recorded[key] === value), 409, 'FAILURE_RECORDED_CONTEXT_CONFLICT');
    const ended = at(attempt?.attempt_ended_utc), observed = at(failure.observed_at_utc);
    requireThat(attempt && attempt.start_command_id === start.commandId && attempt.stop_command_id === stopId
      && Number.isFinite(ended) && ended >= at(attempt.attempt_started_utc)
      && Math.abs(ended - observed) <= 120000 && at(replay.run_ended_utc) === ended,
    409, 'FAILURE_LATEST_LOGGER_STOP_ACK_REQUIRED');
    requireThat(receipt && receipt.instance_id === replay.instance_id && receipt.strategy_id === run.strategy_id
      && receipt.strategy_version === replay.strategy_version && receipt.trade_account === plan.instance.account_alias
      && at(receipt.observation_started_utc) === at(attempt.attempt_started_utc)
      && at(receipt.observation_ended_utc) === ended, 409, 'FAILURE_TERMINAL_LOGGER_RECEIPT_REQUIRED');
    const trades = db.prepare('SELECT * FROM trades WHERE run_id=? AND trade_id>? ORDER BY trade_id').all(run.id, attempt.starting_trade_id);
    const fills = db.prepare('SELECT * FROM fills WHERE run_id=? AND fill_id>? ORDER BY fill_id').all(run.id, attempt.starting_fill_id);
    requireThat(trades.every(row => row.instance_id === replay.instance_id && row.trade_account === receipt.trade_account
      && row.strategy_id === run.strategy_id && row.is_simulated === 1 && String(row.status).toLowerCase() === 'closed'
      && Number(row.final_quantity) === 0) && fills.every(row => row.instance_id === replay.instance_id
      && row.trade_account === receipt.trade_account && row.is_simulated === 1), 409, 'FAILURE_OPEN_OR_FOREIGN_OBSERVATIONS');
    requireThat(receipt.trade_count === trades.length && receipt.closed_trade_count === trades.length && receipt.fill_count === fills.length,
      409, 'FAILURE_TERMINAL_COUNTS_CONFLICT');
    requireThat(fs.readFileSync(failurePath).equals(bytes) && fs.readFileSync(config.source_preflight_status_path).equals(statusBytes),
      409, 'FAILURE_SOURCE_CHANGED_DURING_READ');
    const proof = { schema_version: 'ocean-operational-attempt-failure/v1', run_id: run.id,
      context_hash: context.context_hash, plan_hash: plan.plan_hash, factual_binding_hash: config.factual_binding_hash,
      failure_reason: failure.reason, raw_failure_sha256: digest(bytes), raw_failure_bytes_base64: bytes.toString('base64'),
      terminal_hook_sha256: digest(statusBytes), terminal_hook_bytes_base64: statusBytes.toString('base64'),
      logger_run: replay, logger_attempt: attempt, logger_receipt: receipt, recorded_context: recorded,
      retained_trade_count: trades.length, retained_fill_count: fills.length,
      raw_observation_hash: objectHash({ trades, fills }),
      full_requested_coverage_verified: false, completed_coverage_granted: false };
    return { ...proof, proof_hash: objectHash(proof) };
  } finally { db.close(); }
}

export function readBackendAttemptFailure(backend, workflow) {
  const file = backend.operationalLearning?.physicalBindingFile;
  requireThat(file, 409, 'FAILURE_PHYSICAL_BINDING_CONFIG_REQUIRED');
  return readAttemptFailure(JSON.parse(fs.readFileSync(file, 'utf8')), workflow);
}

export function verifyFrozenFailureBoundary(backend, proof) {
  const file=backend.operationalLearning?.physicalBindingFile;
  requireThat(file,409,'FAILURE_PHYSICAL_BINDING_CONFIG_REQUIRED');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  requireThat(config.factual_binding_hash===proof.factual_binding_hash,409,'FAILURE_FACTUAL_SCOPE_CONFLICT');
  const db=new DatabaseSync(config.telemetry_db,{readOnly:true,timeout:2000});
  try {
    const latest=db.prepare('SELECT * FROM replay_run_attempts WHERE run_id=? ORDER BY attempt_id DESC LIMIT 1').get(proof.run_id);
    requireThat(latest && latest.attempt_id===proof.logger_attempt.attempt_id
      && latest.start_command_id===proof.logger_attempt.start_command_id && latest.stop_command_id===proof.logger_attempt.stop_command_id
      && latest.attempt_ended_utc===proof.logger_attempt.attempt_ended_utc,409,'FAILURE_BOUNDARY_SUPERSEDED');
  }finally{db.close();}
}

export function failureReadView(proof, sourceRunId, runState) {
  const reconciled=runState==='FAILED';
  return { status: 'FAILED_STOP_VERIFIED', physical_execution: 'STOPPED_AT_VERIFIED_FAILURE_BOUNDARY', failure_reason: proof.failure_reason,
    terminal_observed_at_utc:proof.logger_attempt.attempt_ended_utc,
    proof_hash: proof.proof_hash, attempt_id: proof.logger_attempt.attempt_id,
    retained_trade_count: proof.retained_trade_count, retained_fill_count: proof.retained_fill_count,
    full_requested_coverage_verified: false, reconciliation_status:reconciled?'RECONCILED':'PENDING',
    next_owner: reconciled?'Existing governed operational run preparation':'Scoped ReplayBridge telemetry producer',
    next_action: sourceRunId
      ? `${reconciled?'Reserve':'Reconcile the verified failed attempt, then reserve'} fresh exact coverage from ${sourceRunId} with a new run/context and reviewed producer pins. Retain this attempt as failed observations, not completed learning coverage.`
      : `${reconciled?'Use':'Reconcile the verified failed attempt, then use'} the existing governed preparation route for fresh exact coverage. No completed coverage is granted.` };
}
