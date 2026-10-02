import { pathToFileURL } from 'node:url';
import { workflowFromEnvironment } from './backend.mjs';

const STRATEGY_ID = 'cicd-vwap-pull-back-strategy';
const VERSION_ID = 'test-replay-baseline-cicd-vwap-v010-profile-v012';
const INSTANCE_ID = 'test-cicd-vwap-pull-back-replay-two-v013';
const ACTOR = { id: 'wayne-ocean-ui', role: 'HUMAN', namespace: 'TEST', scopes: [], strategyIds: [], instanceIds: [] };

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('BOUNDED_ARGUMENT_PAIRS_REQUIRED');
    values[key.slice(2)] = value;
  }
  return values;
}

function utcInstant(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value || '')) {
    throw new Error(`${label}_UTC_REQUIRED`);
  }
  return value;
}

export function selectionFor(input) {
  if (!/^test-[A-Za-z0-9_.-]+$/.test(input.run_id || '')) throw new Error('TEST_RUN_ID_REQUIRED');
  if (!/^test-vwap-replay-v013-diagnostic-permission-[A-Za-z0-9_.-]+$/.test(input.permission_id || '')) {
    throw new Error('VWAP_V013_DIAGNOSTIC_PERMISSION_REQUIRED');
  }
  const interval = {
    start_utc: utcInstant(input.interval_start_utc, 'INTERVAL_START'),
    end_utc: utcInstant(input.interval_end_utc, 'INTERVAL_END'),
  };
  const warmup = {
    start_utc: utcInstant(input.warmup_start_utc, 'WARMUP_START'),
    end_utc: utcInstant(input.warmup_end_utc, 'WARMUP_END'),
  };
  if (!(warmup.start_utc < warmup.end_utc && warmup.end_utc === interval.start_utc && interval.start_utc < interval.end_utc)) {
    throw new Error('CONTIGUOUS_WARMUP_AND_INTERVAL_REQUIRED');
  }
  return {
    strategy_id: STRATEGY_ID,
    version_id: VERSION_ID,
    expected_environment: 'REPLAY',
    instance_id: INSTANCE_ID,
    purpose: 'NOT_ELIGIBLE',
    permission_id: input.permission_id,
    partition_index: 0,
    interval,
    warmup_interval: warmup,
    build_mode: null,
    case_id: null,
    experiment_id: null,
  };
}

export function validateExistingRun(result, runId) {
  const context = result?.context;
  if (!context || context.run_id !== runId || context.strategy_id !== STRATEGY_ID || context.execution_instance_id !== INSTANCE_ID) {
    throw new Error('EXISTING_RUN_BINDING_CONFLICT');
  }
  if (context.expected_environment !== 'REPLAY' || context.evidence_purpose !== 'NOT_ELIGIBLE' || context.learner_permission !== 'NONE') {
    throw new Error('EXISTING_RUN_AUTHORITY_CONFLICT');
  }
  return result;
}

export function prepareCampaignRun(backend, input) {
  const selection = selectionFor(input);
  const existing = backend.db.prepare('SELECT id FROM ow_runs WHERE id=?').get(input.run_id);
  if (existing) return { status: 'EXISTING', run: validateExistingRun(backend.runs.read(ACTOR, input.run_id), input.run_id) };
  const preview = backend.runs.perform('preview', ACTOR, { selection });
  if (!preview.can_prepare || preview.scored_intervals.length !== 1 || preview.symbol !== 'MNQU25_FUT_CME') {
    throw new Error(`SEALED_CAMPAIGN_RUN_PREVIEW_REJECTED:${JSON.stringify({
      instance_busy: preview.instance_busy,
      conflicting_runs: preview.conflicting_runs,
      scored_intervals: preview.scored_intervals,
      symbol: preview.symbol,
    })}`);
  }
  const run = backend.runs.perform('prepare', ACTOR, {
    run_id: input.run_id,
    selection,
    review_hash: preview.review_hash,
    confirmed: true,
  });
  return { status: 'PREPARED', threshold_selection_allowed: false, brain_submission: 'OFF', run };
}

export function terminalCampaignRun(backend, input, outcome) {
  if (!/^test-[A-Za-z0-9_.-]+$/.test(input.run_id || '')) throw new Error('TEST_RUN_ID_REQUIRED');
  if (!['COMPLETED', 'FAILED'].includes(outcome)) throw new Error('BOUNDED_TERMINAL_OUTCOME_REQUIRED');
  const current = validateExistingRun(backend.runs.read(ACTOR, input.run_id), input.run_id);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.state)) {
    if (current.state !== outcome) throw new Error('TERMINAL_RUN_OUTCOME_CONFLICT');
    return { status: 'EXISTING_TERMINAL', run: current };
  }
  if (current.state === 'COMPLETING') return { status: 'COMPLETING', run: current };
  if (!['READY', 'ACTIVE'].includes(current.state)) throw new Error('RUN_NOT_TERMINABLE');
  const run = backend.runs.perform('end', ACTOR, {
    run_id: input.run_id,
    expected_revision: current.revision,
    outcome,
  });
  return { status: 'TERMINAL_REQUESTED', outcome, run };
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const input = argumentsFrom(argv);
  const backend = workflowFromEnvironment(environment);
  if (!backend) throw new Error('OCEAN_WORKFLOW_REQUIRED');
  try {
    const action = input.action || 'prepare';
    const output = action === 'prepare'
      ? prepareCampaignRun(backend, input)
      : action === 'complete'
        ? terminalCampaignRun(backend, input, 'COMPLETED')
        : action === 'fail'
          ? terminalCampaignRun(backend, input, 'FAILED')
          : (() => { throw new Error('CAMPAIGN_RUN_ACTION_REQUIRED'); })();
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } finally {
    backend.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
