import fs from 'node:fs';
import { WorkflowBackend } from './backend.mjs';

const state = JSON.parse(fs.readFileSync(0, 'utf8'));
const segmentId = process.argv[2];
const backend = new WorkflowBackend(state.config, state.environment);
const actor = { id: 'wayne-ocean-ui', role: 'HUMAN', namespace: 'TEST', scopes: [], strategyIds: [], instanceIds: [] };
const common = {
  strategy_id: 'cicd-vwap-pull-back-strategy',
  version_id: 'test-replay-baseline-cicd-vwap-v010-profile-v012',
  expected_environment: 'REPLAY',
  instance_id: 'test-cicd-vwap-pull-back-replay-two-v013',
  purpose: 'NOT_ELIGIBLE',
  partition_index: 0,
  build_mode: null,
  case_id: null,
  experiment_id: null,
};
const segments = {
  'june-2025-m25-pre-roll': {
    run_id: 'test-run-cicd-vwap-june-2025-m25-v013',
    permission_id: 'test-vwap-replay-v013-diagnostic-permission-20250517-20250615-e04eca26',
    interval: { start_utc: '2025-05-31T23:00:00.000Z', end_utc: '2025-06-15T23:00:00.000Z' },
    warmup_interval: { start_utc: '2025-05-17T23:00:00.000Z', end_utc: '2025-05-31T23:00:00.000Z' },
  },
  'june-2025-u25-post-roll': {
    run_id: 'test-run-cicd-vwap-june-2025-u25-v013',
    permission_id: 'test-vwap-replay-v013-diagnostic-permission-20250601-20250630-236cc229',
    interval: { start_utc: '2025-06-15T23:00:00.000Z', end_utc: '2025-06-30T23:00:00.000Z' },
    warmup_interval: { start_utc: '2025-06-01T23:00:00.000Z', end_utc: '2025-06-15T23:00:00.000Z' },
  },
};

try {
  const segment = segments[segmentId];
  if (!segment) throw new Error('SEALED_SEGMENT_REQUIRED');
  const existing = backend.db.prepare('SELECT id FROM ow_runs WHERE id=?').get(segment.run_id);
  if (existing) {
    const result = backend.runs.read(actor, segment.run_id);
    process.stdout.write(`${JSON.stringify({ status: 'EXISTING', segment_id: segmentId, run: result }, null, 2)}\n`);
  } else {
    const selection = { ...common, permission_id: segment.permission_id, interval: segment.interval, warmup_interval: segment.warmup_interval };
    const preview = backend.runs.perform('preview', actor, { selection });
    if (!preview.can_prepare || preview.scored_intervals.length !== 1 || preview.symbol !== (segmentId.includes('m25') ? 'MNQM25_FUT_CME' : 'MNQU25_FUT_CME')) {
      throw new Error('SEALED_RUN_PREVIEW_REJECTED');
    }
    const result = backend.runs.perform('prepare', actor, { run_id: segment.run_id, selection, review_hash: preview.review_hash, confirmed: true });
    process.stdout.write(`${JSON.stringify({ status: 'PREPARED', segment_id: segmentId, threshold_selection_allowed: false, brain_submission: 'OFF', run: result }, null, 2)}\n`);
  }
} finally {
  backend.close();
}
