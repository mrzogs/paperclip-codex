import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exactKeys, id, objectHash, requireThat } from './common.mjs';
import { enqueueOnboardingBrain } from './onboarding-brain-sync.mjs';

export const ONBOARDING_STRATEGY_ID = 'cicd-vwap-pull-back-strategy';
export const DEFAULT_ONBOARDING_ROOT = process.env.OCEAN_STRATEGY_ONBOARDING_ROOT
  || 'C:\\Users\\wayne\\OneDrive\\Documents\\Brady - Optimization\\onboarding';
export const DEFAULT_REPLAY_CAMPAIGN_STATE = process.env.OCEAN_VWAP_REPLAY_CAMPAIGN_STATE
  || 'D:\\OceanTradingData\\website\\workflow\\cicd-vwap-pull-back-strategy\\replay-campaign-state.json';

const SOURCES = [
  ['registry', 'strategy-registry.json'],
  ['profile', 'strategy-profile.json'],
  ['instance', 'execution-instance.json'],
  ['setup', 'replay-two-setup.json'],
  ['unresolved', 'unresolved-items.json'],
  ['remediation', 'replay-two-alert-remediation.json'],
];

const option = (value, label = value) => ({ value, label });
export const QUESTIONNAIRES = [
  {
    id: 'test-setup-confirmation', step_id: 'test-setup', title: 'Confirm the detected test setup',
    description: 'Ocean reads the strategy and Sierra setup directly. Confirm only that this is the non-live setup you want to test.', resolves_ids: [],
    fields: [
      { key: 'strategy_summary', label: 'Strategy rules', type: 'readonly' },
      { key: 'test_environment', label: 'Test environment', type: 'readonly' },
      { key: 'instance', label: 'Sierra instance', type: 'readonly' },
      { key: 'account', label: 'Simulation account', type: 'readonly' },
      { key: 'symbol', label: 'Contract', type: 'readonly' },
      { key: 'version', label: 'Detected strategy version', type: 'readonly' },
      { key: 'confirm_setup', label: 'Use this detected setup for a non-live Replay test', type: 'checkbox', required_true: true },
    ],
  },
];

const DECISIONS = [
  { priority: 1, questionnaire_id: 'test-setup-confirmation', ids: [], title: 'Confirm the detected Replay setup' },
];

const fileDigest = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const booleanState = value => value === true ? 'ON' : 'OFF';

export function readOnboardingStrategyId(root = DEFAULT_ONBOARDING_ROOT) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'strategy-registry.json'), 'utf8'));
    id(value.strategy_id);
    return value.strategy_id;
  } catch {
    return ONBOARDING_STRATEGY_ID;
  }
}

function readSource(root, key, filename, strategyId) {
  const sourcePath = path.join(root, filename);
  try {
    const content = fs.readFileSync(sourcePath);
    const value = JSON.parse(content.toString('utf8'));
    if (value.strategy_id !== strategyId) return { key, filename, state: 'REJECTED', reason: 'STRATEGY_ID_MISMATCH', value: null };
    return { key, filename, state: 'AVAILABLE', reason: null, sha256: fileDigest(content), modified_at_utc: fs.statSync(sourcePath).mtime.toISOString(), value };
  } catch (error) {
    return { key, filename, state: error?.code === 'ENOENT' ? 'MISSING' : 'INVALID', reason: error?.code === 'ENOENT' ? 'SOURCE_FILE_MISSING' : 'SOURCE_FILE_INVALID', value: null };
  }
}

function gate(key, label, value) { return { key, label, state: booleanState(value), enabled: value === true }; }
function sourceFingerprint(sources) { return fileDigest(Buffer.from(sources.map(source => `${source.filename}:${source.sha256 || source.state}`).join('|'))); }

export function readReplayCampaign(statePath = DEFAULT_REPLAY_CAMPAIGN_STATE, strategyId = ONBOARDING_STRATEGY_ID) {
  try {
    const content = fs.readFileSync(statePath);
    const value = JSON.parse(content.toString('utf8'));
    requireThat(value.schema_version === 'cicd-vwap-replay-campaign-state/v1', 422, 'REPLAY_CAMPAIGN_SCHEMA_INVALID');
    requireThat(value.strategy_id === strategyId, 422, 'REPLAY_CAMPAIGN_STRATEGY_MISMATCH');
    requireThat(value.execution_instance_id === 'test-cicd-vwap-pull-back-replay-two-v013', 422, 'REPLAY_CAMPAIGN_INSTANCE_MISMATCH');
    requireThat(value.live_real === 'DISABLED', 422, 'REPLAY_CAMPAIGN_LIVE_REAL_INVALID');
    const completed = Array.isArray(value.completed_windows) ? value.completed_windows : [];
    const failed = Array.isArray(value.failed_windows) ? value.failed_windows : [];
    const status = String(value.status || 'UNKNOWN');
    const state = status === 'FAILED' || status.startsWith('FAILED_') ? 'ATTENTION_REQUIRED' : 'AVAILABLE';
    return {
      state, status, execution_instance_id: value.execution_instance_id,
      current_window_id: value.current_window_id || null, completed_windows: completed, completed_count: completed.length,
      failed_windows: failed, failed_count: failed.length, next_action: String(value.next_action || 'Review the campaign state.'),
      manifest_sha256: value.manifest_sha256 || null, last_exit_code: value.last_exit_code ?? null,
      last_stdout: value.last_stdout || null, last_stderr: value.last_stderr || null, live_real: 'DISABLED',
      state_path: statePath, state_sha256: fileDigest(content), observed_at_utc: fs.statSync(statePath).mtime.toISOString(),
    };
  } catch (error) {
    return {
      state: error?.code === 'ENOENT' ? 'NOT_CONFIGURED' : 'ATTENTION_REQUIRED', status: 'NOT_STARTED',
      execution_instance_id: 'test-cicd-vwap-pull-back-replay-two-v013', current_window_id: null,
      completed_windows: [], completed_count: 0, failed_windows: [], failed_count: 0,
      next_action: error?.code === 'ENOENT' ? 'Ocean is preparing the sealed Replay campaign.' : 'Ocean must repair the campaign state before Replay continues.',
      reason: error?.code === 'ENOENT' ? 'CAMPAIGN_STATE_MISSING' : (error?.code || error?.message || 'CAMPAIGN_STATE_INVALID'),
      live_real: 'DISABLED', state_path: statePath, observed_at_utc: null,
    };
  }
}

export function readPriorityProgram(root = DEFAULT_ONBOARDING_ROOT, strategyId = ONBOARDING_STRATEGY_ID) {
  const programPath = path.join(root, 'priority-completion-program.json');
  try {
    const content = fs.readFileSync(programPath);
    const value = JSON.parse(content.toString('utf8'));
    requireThat(value.schema_version === 'cicd-vwap-priority-completion-program/v1', 422, 'PRIORITY_PROGRAM_SCHEMA_INVALID');
    requireThat(value.strategy_id === strategyId, 422, 'PRIORITY_PROGRAM_STRATEGY_MISMATCH');
    requireThat(value.authorization?.live_real === 'PROHIBITED', 422, 'PRIORITY_PROGRAM_LIVE_REAL_INVALID');
    const workstreams = Array.isArray(value.workstreams) ? value.workstreams.map(item => ({
      id:item.id,
      name:item.name,
      owner:item.owner,
      status:item.status,
      next_action:item.next_action || null,
      exit:item.exit,
    })) : [];
    const pending = Array.isArray(value.current_acceptance_assessment?.pending)
      ? value.current_acceptance_assessment.pending.map(item => ({
        gate:String(item.gate || 'UNKNOWN'),
        title:String(item.title || 'Resolve the remaining acceptance gate'),
        blocker:String(item.blocker || 'The acceptance gate is not complete.'),
        owner:String(item.owner || 'Not recorded'),
        resolution_action:String(item.resolution_action || 'Review the durable program record.'),
      }))
      : [];
    const currentRuntimeContracts = value.current_runtime_contracts && typeof value.current_runtime_contracts === 'object'
      ? {
        replay:value.current_runtime_contracts.replay || null,
        paper:value.current_runtime_contracts.paper || null,
        display_suffix_policy:value.current_runtime_contracts.display_suffix_policy || null,
      }
      : null;
    const nextGovernedAction = value.next_governed_action && typeof value.next_governed_action === 'object'
      ? {
        title:String(value.next_governed_action.title || 'Review the next governed action'),
        owner:String(value.next_governed_action.owner || 'Not recorded'),
        action:String(value.next_governed_action.action || 'Review the durable program record.'),
        automatic_action:String(value.next_governed_action.automatic_action || 'NONE'),
        reason:String(value.next_governed_action.reason || 'No reason recorded.'),
      }
      : null;
    return {
      state:'AVAILABLE', program_id:value.program_id, status:value.status, priority:value.priority, workstreams,
      current_runtime_contracts:currentRuntimeContracts,
      next_governed_action:nextGovernedAction,
      current_acceptance_assessment:{
        assessed_at:value.current_acceptance_assessment?.assessed_at || null,
        promotion_disposition:value.current_acceptance_assessment?.promotion_disposition || null,
        pending,
      },
      path:programPath, sha256:fileDigest(content), observed_at_utc:fs.statSync(programPath).mtime.toISOString(), live_real:'DISABLED',
    };
  } catch (error) {
    return { state:error?.code === 'ENOENT' ? 'NOT_CONFIGURED' : 'ATTENTION_REQUIRED', status:'UNKNOWN', workstreams:[], path:programPath, reason:error?.code || error?.message || 'PRIORITY_PROGRAM_INVALID', live_real:'DISABLED' };
  }
}

export function readAutonomousImprovementProgram(root = DEFAULT_ONBOARDING_ROOT, strategyId = ONBOARDING_STRATEGY_ID) {
  const programPath = path.join(root, 'autonomous-continuous-improvement-program.json');
  try {
    const content = fs.readFileSync(programPath);
    const value = JSON.parse(content.toString('utf8'));
    requireThat(value.schema_version === 'cicd-vwap-autonomous-continuous-improvement-program/v1', 422, 'AUTONOMOUS_PROGRAM_SCHEMA_INVALID');
    requireThat(value.strategy_id === strategyId, 422, 'AUTONOMOUS_PROGRAM_STRATEGY_MISMATCH');
    requireThat(value.authorization?.live_real === 'PROHIBITED', 422, 'AUTONOMOUS_PROGRAM_LIVE_REAL_INVALID');
    requireThat(value.authorization?.real_order_routing === 'PROHIBITED', 422, 'AUTONOMOUS_PROGRAM_REAL_ROUTING_INVALID');
    requireThat(value.fixed_boundaries?.live_real_enabled === false, 422, 'AUTONOMOUS_PROGRAM_LIVE_BOUNDARY_INVALID');
    requireThat(value.fixed_boundaries?.automatic_approval_enabled === false, 422, 'AUTONOMOUS_PROGRAM_AUTO_APPROVAL_INVALID');
    requireThat(value.fixed_boundaries?.production_version === null, 422, 'AUTONOMOUS_PROGRAM_PRODUCTION_VERSION_INVALID');
    const pipeline = Array.isArray(value.pipeline) ? value.pipeline.map(item => ({
      id:String(item.id || 'UNKNOWN'), name:String(item.name || 'Unnamed phase'), status:String(item.status || 'UNKNOWN'),
      acceptance:String(item.acceptance || 'No acceptance condition recorded.'),
    })) : [];
    const blockers = Array.isArray(value.known_blockers) ? value.known_blockers.map(item => ({
      id:String(item.id || 'UNKNOWN'), status:String(item.status || 'UNKNOWN'),
      blocker:String(item.blocker || 'No blocker description recorded.'), resolution:String(item.resolution || 'No resolution recorded.'),
    })) : [];
    return {
      state:'AVAILABLE', program_id:value.program_id, status:String(value.status || 'UNKNOWN'), priority:value.priority || null,
      pipeline, acceptance_gates:value.acceptance_gates || null, controller:value.controller || null,
      blockers, owners:value.owners || {}, brain_evidence:value.brain_evidence || null,
      next_action:String(value.next_action || 'Review the continuous-improvement program.'),
      path:programPath, sha256:fileDigest(content), observed_at_utc:fs.statSync(programPath).mtime.toISOString(),
      live_real:'DISABLED', automatic_approval:'DISABLED', production_version:null,
    };
  } catch (error) {
    return {
      state:error?.code === 'ENOENT' ? 'NOT_CONFIGURED' : 'ATTENTION_REQUIRED', status:'UNKNOWN', pipeline:[], blockers:[],
      next_action:error?.code === 'ENOENT' ? 'Configure the autonomous continuous-improvement program.' : 'Repair the autonomous program safety contract before continuing.',
      path:programPath, reason:error?.code || error?.message || 'AUTONOMOUS_PROGRAM_INVALID', live_real:'DISABLED', automatic_approval:'DISABLED', production_version:null,
    };
  }
}

function questionnaireDefaults(questionnaire, records) {
  const profile = records.profile || {};
  const instance = records.instance || {};
  const setup = records.setup || {};
  const defaults = {};
  if (questionnaire.id === 'test-setup-confirmation') {
    defaults.strategy_summary = 'Use the entry, exit, stop, target, and sizing rules already encoded in the strategy.';
    defaults.test_environment = 'Replay (simulation only)';
    defaults.instance = setup.installation?.name || instance.source_installation_id || 'Replay instance';
    defaults.account = instance.account_alias || setup.chartbook?.simulation_account || 'Not recorded';
    defaults.symbol = instance.symbol || setup.chartbook?.symbol || 'Not recorded';
    defaults.version = instance.physical_artifact_version || profile.profile_version || instance.version_binding || 'Not recorded';
  }
  return defaults;
}

export function readStrategyOnboardingEvents(db, strategyId = ONBOARDING_STRATEGY_ID) {
  return db.prepare("SELECT id,payload_json FROM ow_events WHERE entity_id=? AND action IN ('onboarding.draft','onboarding.submit') ORDER BY id ASC")
    .all(strategyId)
    .map(row => ({ event_id: row.id, ...JSON.parse(row.payload_json) }));
}

export function readOnboardingRegistration(db, strategyId = ONBOARDING_STRATEGY_ID) {
  const row = db.prepare('SELECT * FROM ow_onboarding_registrations WHERE strategy_id=?').get(strategyId);
  return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
}

export function readOnboardingActivationEvents(db, strategyId = ONBOARDING_STRATEGY_ID) {
  return db.prepare('SELECT * FROM ow_onboarding_activation_events WHERE strategy_id=? ORDER BY rowid').all(strategyId)
    .map(row => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

function projectQuestionnaires(events, records, fingerprint, baseReady, brainOutbox) {
  const byQuestionnaire = new Map();
  for (const event of events) {
    const payload = event?.payload;
    if (!payload || !QUESTIONNAIRES.some(item => item.id === payload.questionnaire_id)) continue;
    const values = byQuestionnaire.get(payload.questionnaire_id) || [];
    values.push(event);
    byQuestionnaire.set(payload.questionnaire_id, values);
  }
  const completed = new Set();
  return QUESTIONNAIRES.map((definition, index) => {
    const history = byQuestionnaire.get(definition.id) || [];
    const latest = history.at(-1) || null;
    const latestSubmission = history.filter(event => event.action === 'onboarding.submit').at(-1) || null;
    const brainSync = latestSubmission ? brainOutbox.find(row => row.milestone_id === latestSubmission.payload.receipt_id) || null : null;
    const submissionCurrent = latestSubmission?.payload?.source_fingerprint === fingerprint;
    const finalReady = definition.id !== 'final-onboarding-decision' || latestSubmission?.payload?.answers?.decision === 'READY_FOR_REGISTRATION';
    const complete = Boolean(latestSubmission && submissionCurrent && finalReady);
    if (complete) completed.add(definition.id);
    const priorComplete = index === 0 || QUESTIONNAIRES.slice(0, index).every(item => completed.has(item.id));
    const locked = !baseReady || !priorComplete;
    const status = complete ? (latest?.action === 'onboarding.draft' && latest.event_id > latestSubmission.event_id ? 'COMPLETE_WITH_DRAFT' : 'COMPLETE')
      : latestSubmission && !submissionCurrent ? 'STALE'
        : latest?.action === 'onboarding.draft' ? 'DRAFT'
          : latestSubmission?.payload?.answers?.decision === 'MORE_EVIDENCE_REQUIRED' ? 'MORE_EVIDENCE_REQUIRED' : 'PENDING';
    const defaults = questionnaireDefaults(definition, records);
    return {
      ...definition, position: index + 1, total: QUESTIONNAIRES.length, status, locked,
      blocked_reason: !baseReady ? 'SOURCE_BASELINE_INCOMPLETE' : !priorComplete ? 'PRIOR_QUESTIONNAIRE_REQUIRED' : null,
      revision: Number(latest?.payload?.revision || 0), answers: { ...defaults, ...(latest?.payload?.answers || {}) },
      context: Object.fromEntries(definition.fields.filter(field => field.type === 'readonly').map(field => [field.key, defaults[field.key] || 'Not recorded'])),
      submission: latestSubmission ? { receipt_id: latestSubmission.payload.receipt_id, receipt_hash: latestSubmission.payload.receipt_hash, author: latestSubmission.actor_id, submitted_at_utc: latestSubmission.payload.recorded_at_utc || latestSubmission.created_at_utc, source_current: submissionCurrent } : null,
      brain_sync: brainSync ? { id: brainSync.id, state: brainSync.state, attempts: brainSync.attempts, brain_record_id: brainSync.brain_record_id, brain_relative_path: brainSync.brain_relative_path, last_error: brainSync.last_error, acknowledged_at_utc: brainSync.acknowledged_at_utc } : null,
    };
  });
}

function questionnaireState(questionnaires, idValue) { return questionnaires.find(questionnaire => questionnaire.id === idValue)?.status || 'PENDING'; }
function stepState(states) {
  if (states.every(state => state.startsWith('COMPLETE'))) return 'COMPLETE';
  if (states.some(state => state !== 'PENDING')) return 'IN_PROGRESS';
  return 'PENDING';
}

const REPLAY_MONITOR_URL = '/replay-monitor.html';
const REPLAY_STATUS_FRESH_MS = 120_000;
let replayRuntimeCache = { key: null, expires_at_ms: 0, value: null };

function replayRuntimeUnavailable({ executable, chartbookPath, chartId, accountAlias }, state = 'STATUS_UNAVAILABLE') {
  return {
    monitor: { state: 'AVAILABLE', url: REPLAY_MONITOR_URL },
    sierra: { state, executable, chartbook_path: chartbookPath, chart_id: chartId, process_id: null, window_title: null },
    chart_replay: { state: 'STATUS_UNAVAILABLE', started: null, observed_at_utc: null, source: 'Replay Two connector status' },
    manual_launch: { available: false, reason: 'NO_SAFE_DESKTOP_LAUNCH_BRIDGE', executable, chartbook_path: chartbookPath, account_alias: accountAlias, chart_id: chartId },
  };
}

export function probeReplayTwoRuntime({ executable, chartbook_path: chartbookPath, chart_id: chartId, account_alias: accountAlias, installation_root: installationRoot, now_ms: nowMs = Date.now() } = {}) {
  const base = replayRuntimeUnavailable({ executable, chartbookPath, chartId, accountAlias }, executable ? 'NOT_RUNNING' : 'NOT_CONFIGURED');
  if (!executable || !chartbookPath || !installationRoot) return base;
  const cacheKey = JSON.stringify([executable, chartbookPath, chartId, accountAlias]);
  if (replayRuntimeCache.key === cacheKey && replayRuntimeCache.expires_at_ms > nowMs) return structuredClone(replayRuntimeCache.value);

  let sierra = base.sierra;
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='Stop'",
      '$items = @(Get-CimInstance Win32_Process -Filter "Name=\'SierraChart_64.exe\'" | ForEach-Object {',
      '  $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue',
      '  [pscustomobject]@{ process_id=$_.ProcessId; executable_path=$_.ExecutablePath; command_line=$_.CommandLine; main_window_title=$process.MainWindowTitle }',
      '})',
      'ConvertTo-Json -InputObject @($items) -Compress -Depth 3',
    ].join('; ');
    const observed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 128 * 1024 });
    if (observed.status === 0) {
      try {
        const parsed = JSON.parse(observed.stdout.trim() || '[]');
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        const expectedExecutable = path.resolve(executable).toLowerCase();
        const expectedChartbook = path.basename(chartbookPath, path.extname(chartbookPath)).toLowerCase();
        const match = processes.find(item => item.executable_path && path.resolve(item.executable_path).toLowerCase() === expectedExecutable);
        if (match) {
          const evidence = `${match.command_line || ''}\n${match.main_window_title || ''}`.toLowerCase();
          const chartbookVerified = evidence.includes(expectedChartbook);
          sierra = {
            state: chartbookVerified ? 'OPEN_EXACT_CHARTBOOK_VERIFIED' : 'PROCESS_OPEN_CHARTBOOK_NOT_VERIFIED',
            executable,
            chartbook_path: chartbookPath,
            chart_id: chartId,
            process_id: Number(match.process_id) || null,
            window_title: match.main_window_title || null,
          };
        }
      } catch {
        sierra = { ...base.sierra, state: 'STATUS_UNAVAILABLE' };
      }
    } else sierra = { ...base.sierra, state: 'STATUS_UNAVAILABLE' };
  }

  let chartReplay = base.chart_replay;
  const statusPaths = [
    path.join(installationRoot, 'connector-control', 'patrading-tp', 'replay-status.json'),
    path.join(installationRoot, 'connector-control', 'ocean-replay-controller', 'replay-status.json'),
    path.join(installationRoot, 'connector-control', 'replay-status.json'),
  ];
  const statusPath = statusPaths.find(candidate => fs.existsSync(candidate));
  try {
    if (!statusPath) throw Object.assign(new Error('Replay status missing'), { code:'ENOENT' });
    const stat = fs.statSync(statusPath);
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    const observedAt = stat.mtime.toISOString();
    const chartMatches = String(status.chartNumber ?? '') === String(chartId ?? '');
    const fresh = nowMs - stat.mtimeMs <= REPLAY_STATUS_FRESH_MS;
    chartReplay = {
      state: !fresh ? 'STATUS_STALE' : !chartMatches ? 'CHART_NOT_VERIFIED' : status.isReplayRunning === true ? 'RUNNING_VERIFIED' : 'NOT_RUNNING_VERIFIED',
      started: fresh && chartMatches ? status.isReplayRunning === true : null,
      observed_at_utc: observedAt,
      source: statusPath,
    };
  } catch {
    chartReplay = base.chart_replay;
  }

  const value = { ...base, sierra, chart_replay: chartReplay };
  replayRuntimeCache = { key: cacheKey, expires_at_ms: nowMs + 2000, value };
  return structuredClone(value);
}

export function loadStrategyOnboarding({ root = DEFAULT_ONBOARDING_ROOT, events = [], brainOutbox = [], registration = null, activationEvents = [], runtimeProbe = probeReplayTwoRuntime, campaignStatePath = DEFAULT_REPLAY_CAMPAIGN_STATE } = {}) {
  const strategyId = readOnboardingStrategyId(root);
  const sources = SOURCES.map(([key, filename]) => readSource(root, key, filename, strategyId));
  const records = Object.fromEntries(sources.map(source => [source.key, source.value]));
  const { registry, profile, instance, setup, unresolved, remediation } = records;
  const availableCount = sources.filter(source => source.state === 'AVAILABLE').length;
  const sourceStatus = availableCount === sources.length ? 'AVAILABLE' : availableCount > 0 ? 'PARTIAL' : 'UNAVAILABLE';
  const fingerprint = sourceFingerprint(sources);

  const registryComplete = Boolean(registry?.profile_id && registry?.baseline_version && registry?.activation_status);
  const profileValid = Boolean(registryComplete && profile?.profile_id === registry.profile_id && profile?.profile_version === registry.profile_version && profile?.profile_hash === registry.profile_hash && profile?.baseline_version === registry.baseline_version && profile?.strategy_code_hash && profile?.strategy_config_hash && profile?.onboarding_status === registry.activation_status);
  const instancePrepared = Boolean(instance?.execution_instance_id && instance?.status === 'PREPARED_NOT_REGISTERED');
  const setupPrepared = Boolean(setup?.configuration_revision && setup?.status === 'PREPARED_NOT_ACTIVATED');
  const remediationComplete = Boolean(remediation?.fix?.alerts_enabled === false && remediation?.validation?.automated_order_placement === false && remediation?.validation?.telemetry_logging === false && remediation?.diagnosis?.dll_rebuild_required === false);
  const baseReady = sourceStatus === 'AVAILABLE' && registryComplete && profileValid && instancePrepared && setupPrepared && remediationComplete;
  const questionnaires = projectQuestionnaires(events, records, fingerprint, baseReady, brainOutbox);

  const openItems = new Map((unresolved?.items || []).map(item => [item.id, item]));
  const decisions = DECISIONS.map(spec => {
    const items = spec.ids.map(itemId => openItems.get(itemId)).filter(Boolean);
    const status = questionnaireState(questionnaires, spec.questionnaire_id);
    const complete = status.startsWith('COMPLETE');
    return { priority: spec.priority, questionnaire_id: spec.questionnaire_id, title: spec.title, item_ids: spec.ids, owner: [...new Set(items.map(item => item.owner).filter(Boolean))].join(' / ') || (spec.priority === 7 ? 'Wayne' : 'Recorded'), state: complete ? 'COMPLETE' : status, actions: complete ? [] : items.map(item => item.resolution_action) };
  });

  const setupConfirmation = questionnaires.find(item => item.id === 'test-setup-confirmation');
  const setupConfirmed = Boolean(setupConfirmation?.status.startsWith('COMPLETE'));
  const questionnaireSubmissions = questionnaires.map(item => item.submission).filter(Boolean);
  const requiredBrainRows = questionnaireSubmissions.map(submission => brainOutbox.find(row => row.milestone_id === submission.receipt_id)).filter(Boolean);
  const questionnaireBrainComplete = questionnaireSubmissions.length === QUESTIONNAIRES.length && requiredBrainRows.length === QUESTIONNAIRES.length && requiredBrainRows.every(row => row.state === 'ACKNOWLEDGED');
  const registrationBrain = registration ? brainOutbox.find(row => row.milestone_id === registration.id) || null : null;
  const registrationComplete = Boolean(registration && registrationBrain?.state === 'ACKNOWLEDGED');
  const latestReplayLifecycle = activationEvents.filter(item => item.environment === 'REPLAY').at(-1) || null;
  const replayReady = latestReplayLifecycle?.action === 'ACTIVATE';
  const instanceSafety = instance?.safety_state || {};
  const setupSafety = setup?.safety || {};
  const replayRuntime = runtimeProbe({
    executable: instance?.executable || setup?.installation?.executable || null,
    installation_root: instance?.installation_root || setup?.installation?.root || null,
    chartbook_path: instance?.chartbook_path || setup?.chartbook?.path || null,
    chart_id: instance?.chart_id || setup?.chartbook?.chart_number || null,
    account_alias: instance?.account_alias || setup?.chartbook?.simulation_account || null,
  });
  const checks = [
    { id: 'strategy-detected', label: 'Strategy detected', state: baseReady ? 'COMPLETE' : 'PENDING' },
    { id: 'test-setup', label: 'Replay setup confirmed', state: setupConfirmed ? 'COMPLETE' : 'PENDING' },
    { id: 'ready-to-test', label: 'Ready to test', state: replayReady ? 'COMPLETE' : registration || questionnaireBrainComplete ? 'IN_PROGRESS' : 'PENDING' },
  ];
  const completeCount = checks.filter(check => check.state === 'COMPLETE').length;
  const nextAction = !baseReady
    ? { priority: 1, title: 'Ocean needs to repair the detected setup', owner: 'Ocean', state: 'PENDING', actions: ['Review the failed system check. You do not need to supply hashes or technical policy fields.'] }
    : !setupConfirmed
      ? { priority: 1, title: 'Confirm the detected Replay setup', owner: 'Wayne', state: 'PENDING', actions: ['Review one short page and confirm that Ocean should use this non-live setup.'] }
      : !questionnaireBrainComplete
        ? { priority: 2, title: 'Ocean is recording the setup', owner: 'Ocean', state: 'IN_PROGRESS', actions: ['No action is required. Brain synchronization retries automatically.'] }
        : !registration
          ? { priority: 2, title: 'Prepare the Replay test', owner: 'Wayne', state: 'PENDING', actions: ['Click Prepare Replay test. This records the setup but does not start Sierra.'] }
          : !registrationComplete
            ? { priority: 3, title: 'Ocean is finishing the test setup', owner: 'Ocean', state: 'IN_PROGRESS', actions: ['No action is required. Registration is being confirmed automatically.'] }
            : !replayReady
              ? { priority: 3, title: 'Finish Replay preparation', owner: 'Wayne', state: 'PENDING', actions: ['Click Make Replay ready once. This completes onboarding without starting Sierra.'] }
              : { priority: 4, title: 'Build Replay history', owner: 'Wayne', state: 'COMPLETE', actions: ['Onboarding is complete. Start or continue Replay tests when you are ready.', 'Ocean keeps completed trade and no-trade periods as strategy evidence. Sierra runtime status is informational and never delays onboarding.'] };
  const activeQuestionnaire = questionnaires.find(questionnaire => !questionnaire.status.startsWith('COMPLETE') && !questionnaire.locked) || null;
  const capabilities = Array.isArray(instance?.capabilities) ? instance.capabilities : [];
  const gates = [
    gate('replay', 'Replay', instanceSafety.replay_started === true || setupSafety.replay_started === true), gate('paper', 'Paper', setupSafety.paper_started === true), gate('live', 'Live', setupSafety.live_started === true),
    gate('automated-ordering', 'Automated ordering', instanceSafety.strategy_automated_order_placement === true), gate('telemetry', 'Telemetry logging', instanceSafety.telemetry_logging === true), gate('brain-submission', 'Brain submission', instanceSafety.brain_submission === 'ON'), gate('live-real', 'LIVE_REAL', capabilities.includes('LIVE_REAL')),
  ];

  const approvedCapabilities = setupConfirmation?.answers || {};
  const latestActivationByEnvironment = Object.fromEntries(['REPLAY','PAPER','LIVE'].map(environment => [environment, activationEvents.filter(item => item.environment === environment).at(-1) || null]));
  const activationEnvironments = [
    { environment: 'REPLAY', label: 'Replay', permitted: approvedCapabilities.confirm_setup === true },
    { environment: 'PAPER', label: 'Paper', permitted: false, blocked_reason: 'PAPER_CAN_BE_ADDED_AFTER_REPLAY_IS_PROVEN' },
    { environment: 'LIVE', label: 'Live', permitted: false, blocked_reason: 'LIVE_REQUIRES_SEPARATE_PRODUCTION_PROMOTION' },
  ].map(item => {
    const latest = latestActivationByEnvironment[item.environment];
    const state = !latest ? 'INACTIVE' : latest.action === 'ACTIVATE' ? 'ACTIVATED_NOT_STARTED' : latest.action;
    return { ...item, state, revision: latest?.revision || 0, last_event_id: latest?.id || null, last_changed_at_utc: latest?.created_at_utc || null, can_activate: registrationComplete && item.permitted && state !== 'ACTIVATED_NOT_STARTED', actual_source_started: false };
  });
  const latestActive = activationEnvironments.find(item => item.state === 'ACTIVATED_NOT_STARTED') || null;
  const replayCampaign = readReplayCampaign(campaignStatePath, strategyId);
  const priorityProgram = readPriorityProgram(root, strategyId);
  const autonomousImprovement = readAutonomousImprovementProgram(root, strategyId);

  return {
    strategy_id: strategyId, strategy_name: registry?.strategy_name || profile?.strategy_name || setup?.strategy_name || 'Strategy onboarding',
    onboarding_status: replayReady ? 'COMPLETE' : registrationComplete ? 'READY_FOR_REPLAY' : setupConfirmed ? 'PREPARING' : 'SETUP_REQUIRED',
    activation_status: latestActive ? `ACTIVATED_${latestActive.environment}_NOT_STARTED` : registration ? 'REGISTERED_NOT_ACTIVATED' : setupConfirmed ? (questionnaireBrainComplete ? 'READY_FOR_REGISTRATION' : 'PREPARING') : (registry?.activation_status || profile?.onboarding_status || 'DATA_UNAVAILABLE'),
    activation_decision_id: setupConfirmed ? setupConfirmation?.submission?.receipt_id : (registry?.activation_decision_id || null),
    baseline_version: registry?.baseline_version || profile?.baseline_version || null, production_version: registry?.production_version || profile?.production_version || null,
    profile: { profile_id: profile?.profile_id || registry?.profile_id || null, profile_version: profile?.profile_version || registry?.profile_version || null, profile_hash: profile?.profile_hash || registry?.profile_hash || null, strategy_code_hash: profile?.strategy_code_hash || null, strategy_config_hash: profile?.strategy_config_hash || null, validity: profileValid ? 'VALID' : 'INVALID_OR_UNAVAILABLE' },
    instance: { execution_instance_id: instance?.execution_instance_id || null, configuration_revision: instance?.configuration_revision || setup?.configuration_revision || null, status: instance?.status || setup?.status || 'UNAVAILABLE', account_alias: instance?.account_alias || setup?.chartbook?.simulation_account || null, mode: instanceSafety.trade_simulation_mode === true ? 'Simulation' : 'Not recorded', symbol: instance?.symbol || setup?.chartbook?.symbol || null },
    progress: { checks, complete: completeCount, total: checks.length }, decisions, next_action: nextAction, questionnaires, active_questionnaire_id: activeQuestionnaire?.id || null, gates,
    brain_sync: {
      state: questionnaireBrainComplete && (!registration || registrationComplete) ? 'ACKNOWLEDGED' : brainOutbox.some(row => ['FAILED','DEAD_LETTER'].includes(row.state)) ? 'ATTENTION_REQUIRED' : brainOutbox.length ? 'PENDING' : 'NOT_DUE',
      required: questionnaireSubmissions.length + (registration ? 1 : 0),
      acknowledged: [...requiredBrainRows, ...(registrationBrain ? [registrationBrain] : [])].filter(row => row.state === 'ACKNOWLEDGED').length,
      items: brainOutbox,
    },
    registration: { state: registration ? (registrationComplete ? 'REGISTERED' : 'BRAIN_SYNC_PENDING') : questionnaireBrainComplete ? 'READY' : 'NOT_READY', can_register: questionnaireBrainComplete && !registration, receipt: registration ? { id: registration.id, package_hash: registration.package_hash, created_at_utc: registration.created_at_utc, brain_sync: registrationBrain } : null },
    activation: { state: latestActive ? latestActive.state : 'INACTIVE', environments: activationEnvironments, actual_source_started: replayRuntime.chart_replay.started === true, automated_ordering: false, live_real: false },
    replay_runtime: replayRuntime,
    continuous_delivery: { priority_program: priorityProgram, autonomous_improvement: autonomousImprovement, replay_campaign: replayCampaign },
    source: { status: sourceStatus, label: 'Ocean strategy and Sierra source records', fingerprint, last_verified_at_utc: setup?.last_verified_at || remediation?.verified_through || null, files: sources.map(({ filename, state, reason, sha256, modified_at_utc }) => ({ filename, state, reason, sha256, modified_at_utc })) },
    read_only: false, source_read_only: true, workflow_writable: true,
    safety: { affects_trading_controls: false, execution_authority: false, registration_automatic: false, activation_does_not_start_source: true },
  };
}

function normalizeAnswers(questionnaire, input, submit) {
  exactKeys(input, questionnaire.fields.filter(field => field.type !== 'readonly').map(field => field.key));
  const answers = {};
  for (const field of questionnaire.fields.filter(item => item.type !== 'readonly')) {
    let value = input[field.key];
    if (field.type === 'checkbox') value = value === true;
    else if (field.type === 'number' && value !== '' && value !== null && value !== undefined) value = Number(value);
    else if (typeof value === 'string') value = value.trim();
    const conditionRequired = field.required_when && input[field.required_when.key] === field.required_when.value;
    const required = field.required || conditionRequired;
    if (submit && required) requireThat(value !== undefined && value !== null && value !== '', 422, 'ONBOARDING_REQUIRED_FIELD');
    if (submit && field.required_true) requireThat(value === true, 422, 'ONBOARDING_CONFIRMATION_REQUIRED');
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'number') requireThat(Number.isFinite(value) && (!field.integer || Number.isInteger(value)) && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max), 422, 'ONBOARDING_NUMBER_INVALID');
    else if (field.type === 'select' || field.type === 'radio') requireThat(field.options.some(entry => entry.value === value), 422, 'ONBOARDING_OPTION_INVALID');
    else if (field.type !== 'checkbox') requireThat(typeof value === 'string' && (field.min_length === undefined || value.length >= field.min_length) && (field.max_length === undefined || value.length <= field.max_length) && (!field.pattern || new RegExp(field.pattern).test(value)), 422, 'ONBOARDING_TEXT_INVALID');
    answers[field.key] = value;
  }
  requireThat(JSON.stringify(answers).length <= 16 * 1024, 413, 'ONBOARDING_ANSWERS_TOO_LARGE');
  return answers;
}

export function recordStrategyOnboarding(backend, actor, data, kind) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  exactKeys(data, ['strategy_id', 'questionnaire_id', 'receipt_id', 'expected_revision', 'source_fingerprint', 'answers']);
  const root = backend.config?.strategy_onboarding_root || DEFAULT_ONBOARDING_ROOT;
  const strategyId = readOnboardingStrategyId(root);
  requireThat(data.strategy_id === strategyId, 422, 'ONBOARDING_STRATEGY_MISMATCH');
  id(data.receipt_id, true);
  requireThat(Number.isInteger(data.expected_revision) && data.expected_revision >= 0, 422, 'ONBOARDING_REVISION_REQUIRED');
  requireThat(/^sha256:[a-f0-9]{64}$/.test(data.source_fingerprint), 422, 'ONBOARDING_SOURCE_FINGERPRINT_REQUIRED');
  const current = loadStrategyOnboarding({ root, events: readStrategyOnboardingEvents(backend.db, strategyId) });
  requireThat(current.source.status === 'AVAILABLE', 409, 'ONBOARDING_SOURCE_INCOMPLETE');
  requireThat(current.source.fingerprint === data.source_fingerprint, 409, 'ONBOARDING_SOURCE_CHANGED');
  const questionnaire = current.questionnaires.find(item => item.id === data.questionnaire_id);
  requireThat(questionnaire, 404, 'ONBOARDING_QUESTIONNAIRE_NOT_FOUND');
  requireThat(!questionnaire.locked, 409, questionnaire.blocked_reason || 'ONBOARDING_QUESTIONNAIRE_LOCKED');
  requireThat(questionnaire.revision === data.expected_revision, 409, 'REVISION_CONFLICT');
  const submit = kind === 'SUBMITTED';
  const answers = normalizeAnswers(questionnaire, data.answers, submit);
  const receipt = { schema_version: 'ocean-strategy-onboarding-receipt/v1', kind, receipt_id: data.receipt_id, strategy_id: data.strategy_id, questionnaire_id: data.questionnaire_id, step_id: questionnaire.step_id, revision: data.expected_revision + 1, source_fingerprint: data.source_fingerprint, source_context: questionnaire.context, resolves_ids: submit ? questionnaire.resolves_ids : [], answers, actor_id: actor.id, recorded_at_utc: new Date().toISOString(), affects_trading_controls: false, execution_authority: false, registration_authority: false };
  receipt.receipt_hash = objectHash(receipt);
  backend.event(data.strategy_id, submit ? 'onboarding.submit' : 'onboarding.draft', actor, receipt);
  if (submit) enqueueOnboardingBrain(backend, {
    strategy_id: data.strategy_id,
    milestone_type: 'QUESTIONNAIRE',
    milestone_id: receipt.receipt_id,
    title: `${questionnaire.title} onboarding decision`,
    summary: `Ocean recorded questionnaire ${questionnaire.id} for ${data.strategy_id}. Answers: ${JSON.stringify(answers)}.`,
    conclusion: `This append-only Ocean onboarding decision resolves ${receipt.resolves_ids.join(', ') || 'the final registration decision'} without granting trading execution authority.`,
    source_fingerprint: data.source_fingerprint,
    receipt_hash: receipt.receipt_hash,
  });
  return { receipt_id: receipt.receipt_id, receipt_hash: receipt.receipt_hash, questionnaire_id: receipt.questionnaire_id, revision: receipt.revision, state: kind, affects_trading_controls: false };
}

function readOnboardingProjection(backend) {
  const root = backend.config?.strategy_onboarding_root || DEFAULT_ONBOARDING_ROOT;
  const strategyId = readOnboardingStrategyId(root);
  return loadStrategyOnboarding({
    root,
    events: readStrategyOnboardingEvents(backend.db, strategyId),
    brainOutbox: backend.db.prepare('SELECT * FROM ow_onboarding_brain_outbox ORDER BY rowid').all(),
    registration: readOnboardingRegistration(backend.db, strategyId),
    activationEvents: readOnboardingActivationEvents(backend.db, strategyId),
  });
}

function sourceRecordMap(root) {
  const strategyId = readOnboardingStrategyId(root);
  const sources = SOURCES.map(([key, filename]) => readSource(root, key, filename, strategyId));
  requireThat(sources.every(source => source.state === 'AVAILABLE'), 409, 'ONBOARDING_SOURCE_INCOMPLETE');
  return Object.fromEntries(sources.map(source => [source.key, source.value]));
}

function submissionAnswers(onboarding, questionnaireId) {
  const row = onboarding.questionnaires.find(item => item.id === questionnaireId);
  requireThat(row?.submission?.source_current && row.status.startsWith('COMPLETE'), 409, 'ONBOARDING_QUESTIONNAIRE_INCOMPLETE');
  return row.answers;
}

function insertImmutable(backend, table, key, columns, values, verifier, conflictCode = 'ONBOARDING_REGISTRATION_CONFLICT') {
  const existing = backend.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);
  if (existing) { requireThat(verifier(existing), 409, conflictCode); return false; }
  backend.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values);
  return true;
}

function compatiblePayload(row, expected, keys) {
  let current;
  try { current = JSON.parse(row.payload_json); } catch { return false; }
  return keys.every(key => expected[key] === undefined || current[key] === expected[key]);
}

export function registerStrategyOnboarding(backend, actor, data) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  exactKeys(data, ['strategy_id','registration_id','expected_source_fingerprint','confirmed']);
  requireThat(data.confirmed === true, 422, 'ONBOARDING_REGISTRATION_CONFIRMATION_REQUIRED');
  id(data.registration_id, true);
  requireThat(/^sha256:[a-f0-9]{64}$/.test(data.expected_source_fingerprint), 422, 'ONBOARDING_SOURCE_FINGERPRINT_REQUIRED');
  const onboarding = readOnboardingProjection(backend);
  requireThat(data.strategy_id === onboarding.strategy_id, 422, 'ONBOARDING_STRATEGY_MISMATCH');
  requireThat(onboarding.source.fingerprint === data.expected_source_fingerprint, 409, 'ONBOARDING_SOURCE_CHANGED');
  requireThat(onboarding.registration.can_register, 409, 'ONBOARDING_REGISTRATION_NOT_READY');
  const records = sourceRecordMap(backend.config?.strategy_onboarding_root || DEFAULT_ONBOARDING_ROOT);
  const confirmation = submissionAnswers(onboarding, 'test-setup-confirmation');
  const capabilities = confirmation.confirm_setup === true ? ['REPLAY'] : [];
  const profile = { ...records.profile, onboarding_status: 'REGISTERED_NOT_ACTIVATED', recommendations_enabled: false };
  const registry = { ...records.registry, registry_revision: Number(records.registry.registry_revision || 0) + 1, activation_status: 'REGISTERED_NOT_ACTIVATED', activation_decision_id: onboarding.questionnaires.at(-1).submission.receipt_id, execution_instances: [records.instance.execution_instance_id] };
  const instance = { ...records.instance, capabilities, status: 'REGISTERED_NOT_ACTIVATED', safety_state: { ...records.instance.safety_state, strategy_automated_order_placement: false, telemetry_logging: false, brain_submission: 'OFF', replay_started: false, paper_started: false, live_started: false } };
  const packagePayload = { schema_version: 'ocean-simple-onboarding-registration/v2', registration_id: data.registration_id, strategy_id: data.strategy_id, source_fingerprint: onboarding.source.fingerprint, profile, registry, instance, operator_confirmation_receipt: onboarding.questionnaires[0].submission.receipt_id, dataset_binding: 'SELECTED_PER_TEST_RUN', state: 'REGISTERED_NOT_ACTIVATED', execution_authority: false, actual_source_started: false };
  const packageHash = objectHash(packagePayload);
  const profileKey = `${profile.profile_id}:${profile.profile_version}`;
  const now = new Date().toISOString();
  const profileIdentity = ['strategy_id','profile_id','profile_version','profile_hash','strategy_code_hash','strategy_config_hash'];
  const registryIdentity = ['strategy_id','profile_id','profile_version','profile_hash','baseline_version','production_version'];
  const instanceIdentity = ['strategy_id','execution_instance_id','configuration_revision','source_installation_id','chartbook_id','chart_id','symbol','source_study_instance_id','source_binary_sha256','telemetry_study_instance_id','telemetry_binary_sha256','account_alias','config_hash','version_binding'];
  insertImmutable(
    backend,
    'ow_profiles',
    profileKey,
    ['id','strategy_id','version','content_hash','payload_json'],
    [profileKey,data.strategy_id,records.profile.profile_version,records.profile.profile_hash,JSON.stringify(records.profile)],
    row => row.strategy_id === data.strategy_id
      && row.version === records.profile.profile_version
      && compatiblePayload(row, records.profile, profileIdentity),
    'ONBOARDING_PROFILE_BASELINE_CONFLICT',
  );
  insertImmutable(
    backend,
    'ow_strategies',
    data.strategy_id,
    ['id','profile_id','revision','baseline_hash','payload_json'],
    [data.strategy_id,profileKey,Number(records.registry.registry_revision || 1),records.profile.strategy_code_hash,JSON.stringify(records.registry)],
    row => row.profile_id === profileKey
      && row.baseline_hash === records.profile.strategy_code_hash
      && compatiblePayload(row, records.registry, registryIdentity),
    'ONBOARDING_STRATEGY_BASELINE_CONFLICT',
  );
  insertImmutable(
    backend,
    'ow_instances',
    instance.execution_instance_id,
    ['id','strategy_id','payload_json'],
    [instance.execution_instance_id,data.strategy_id,JSON.stringify(instance)],
    row => row.strategy_id === data.strategy_id && compatiblePayload(row, instance, instanceIdentity),
    'ONBOARDING_INSTANCE_BINDING_CONFLICT',
  );
  backend.db.prepare('INSERT INTO ow_onboarding_registrations(id,strategy_id,source_fingerprint,package_hash,payload_json,actor_id,created_at_utc) VALUES(?,?,?,?,?,?,?)')
    .run(data.registration_id,data.strategy_id,onboarding.source.fingerprint,packageHash,JSON.stringify(packagePayload),actor.id,now);
  backend.event(data.strategy_id, 'onboarding.register', actor, { registration_id: data.registration_id, package_hash: packageHash, state: 'REGISTERED_NOT_ACTIVATED', execution_authority: false });
  enqueueOnboardingBrain(backend, { strategy_id:data.strategy_id, milestone_type:'REGISTRATION', milestone_id:data.registration_id, title:'Ocean simple strategy onboarding registration', summary:`Ocean prepared ${data.strategy_id} for a non-live Replay test with profile ${profile.profile_id} and instance ${instance.execution_instance_id}. The dataset is selected when a test run is created.`, conclusion:'The strategy setup is registered for Replay testing. No source was started and no trading, Paper, Live, or automated-order authority was granted.', source_fingerprint:onboarding.source.fingerprint, receipt_hash:packageHash });
  return { registration_id:data.registration_id, package_hash:packageHash, state:'REGISTERED_NOT_ACTIVATED', brain_sync:'PENDING', execution_authority:false, actual_source_started:false };
}

function currentActivation(onboarding, environment) {
  const row = onboarding.activation.environments.find(item => item.environment === environment);
  requireThat(row, 422, 'ONBOARDING_ACTIVATION_ENVIRONMENT_INVALID');
  return row;
}

function activationEvent(backend, actor, data, action) {
  requireThat(actor.role === 'HUMAN', 403, 'WAYNE_BROWSER_ONLY');
  const allowed = ['strategy_id','activation_id','environment','expected_revision','confirmed'];
  exactKeys(data, allowed);
  requireThat(data.confirmed === true, 422, 'ONBOARDING_ACTIVATION_CONFIRMATION_REQUIRED');
  id(data.activation_id, true);
  requireThat(['REPLAY','PAPER','LIVE'].includes(data.environment), 422, 'ONBOARDING_ACTIVATION_ENVIRONMENT_INVALID');
  const onboarding = readOnboardingProjection(backend);
  requireThat(data.strategy_id === onboarding.strategy_id, 422, 'ONBOARDING_STRATEGY_MISMATCH');
  requireThat(onboarding.registration.state === 'REGISTERED', 409, 'ONBOARDING_REGISTRATION_BRAIN_SYNC_REQUIRED');
  const current = currentActivation(onboarding, data.environment);
  requireThat(current.revision === data.expected_revision, 409, 'REVISION_CONFLICT');
  if (action === 'ACTIVATE') {
    requireThat(data.environment !== 'LIVE', 409, 'LIVE_ACTIVATION_REQUIRES_PRODUCTION_PROMOTION');
    requireThat(current.permitted, 409, 'ONBOARDING_CAPABILITY_NOT_APPROVED');
    requireThat(current.state !== 'ACTIVATED_NOT_STARTED', 409, 'ONBOARDING_ENVIRONMENT_ALREADY_ACTIVE');
  } else requireThat(current.state === 'ACTIVATED_NOT_STARTED' || (action === 'DEACTIVATE' && current.state === 'PAUSE'), 409, 'ONBOARDING_ENVIRONMENT_NOT_ACTIVE');
  const revision = current.revision + 1;
  const reason = `${action === 'ACTIVATE' ? 'Prepare' : action === 'PAUSE' ? 'Pause' : action === 'DEACTIVATE' ? 'Stop' : 'Emergency stop'} the ${data.environment} test lifecycle from the Ocean onboarding page.`;
  const payload = { schema_version:'ocean-simple-onboarding-activation/v2', activation_id:data.activation_id, strategy_id:data.strategy_id, environment:data.environment, action, revision, account_alias:onboarding.instance.account_alias, preflight:action === 'ACTIVATE' ? { source_fingerprint:onboarding.source.fingerprint, source_status:onboarding.source.status, profile_status:onboarding.profile.validity, instance_status:onboarding.instance.status, simulation_mode:onboarding.instance.mode, automated_ordering:false, actual_source_started:false } : null, reason, confirmed:true, source_fingerprint:onboarding.source.fingerprint, execution_authority:false, actual_source_started:false, automated_ordering:false, live_real:false };
  const payloadHash = objectHash(payload); const now = new Date().toISOString();
  backend.db.prepare('INSERT INTO ow_onboarding_activation_events(id,strategy_id,environment,action,revision,payload_hash,payload_json,actor_id,created_at_utc) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(data.activation_id,data.strategy_id,data.environment,action,revision,payloadHash,JSON.stringify(payload),actor.id,now);
  backend.event(data.strategy_id, `onboarding.${action.toLowerCase().replace('_','-')}`, actor, { activation_id:data.activation_id, environment:data.environment, revision, payload_hash:payloadHash, execution_authority:false, actual_source_started:false });
  enqueueOnboardingBrain(backend, { strategy_id:data.strategy_id, milestone_type:'ACTIVATION', milestone_id:data.activation_id, title:`Ocean ${data.environment} lifecycle ${action.toLowerCase()}`, summary:`Ocean recorded ${action} for ${data.environment} on ${data.strategy_id}. The lifecycle state changed without starting Sierra or enabling automated orders.`, conclusion:`The ${data.environment} lifecycle record is ${action}. Actual source start, LIVE_REAL, and automated-order authority remain outside this receipt.`, source_fingerprint:onboarding.source.fingerprint, receipt_hash:payloadHash });
  return { activation_id:data.activation_id, environment:data.environment, action, revision, state:action === 'ACTIVATE' ? 'ACTIVATED_NOT_STARTED' : action, brain_sync:'PENDING', execution_authority:false, actual_source_started:false };
}

export const activateStrategyOnboarding = (backend, actor, data) => activationEvent(backend, actor, data, 'ACTIVATE');
export const pauseStrategyOnboarding = (backend, actor, data) => activationEvent(backend, actor, data, 'PAUSE');
export const deactivateStrategyOnboarding = (backend, actor, data) => activationEvent(backend, actor, data, 'DEACTIVATE');
export const emergencyStopStrategyOnboarding = (backend, actor, data) => activationEvent(backend, actor, data, 'EMERGENCY_STOP');

export function onboardingStrategyRow(onboarding) {
  return { strategy_id: onboarding.strategy_id, strategy_name: onboarding.strategy_name, registry_revision: null, activation_status: onboarding.activation_status, activation_decision_id: onboarding.activation_decision_id, baseline_version: onboarding.baseline_version, baseline_hash: onboarding.profile.strategy_code_hash, production_version: onboarding.production_version, profile: onboarding.profile, cases: [], cases_total: 0, onboarding, external_onboarding: true };
}
