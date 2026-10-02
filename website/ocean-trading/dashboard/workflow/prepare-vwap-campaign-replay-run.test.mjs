import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionFor, validateExistingRun } from './prepare-vwap-campaign-replay-run.mjs';

const valid = {
  run_id: 'test-run-cicd-vwap-july-2025-u25-20261002T120000Z',
  permission_id: 'test-vwap-replay-v013-diagnostic-permission-20250616-20250831-212aa000',
  warmup_start_utc: '2025-06-16T23:00:00.000Z',
  warmup_end_utc: '2025-06-30T23:00:00.000Z',
  interval_start_utc: '2025-06-30T23:00:00.000Z',
  interval_end_utc: '2025-07-31T23:00:00.000Z',
};

test('builds a non-learning Replay-only selection', () => {
  const selection = selectionFor(valid);
  assert.equal(selection.strategy_id, 'cicd-vwap-pull-back-strategy');
  assert.equal(selection.instance_id, 'test-cicd-vwap-pull-back-replay-two-v013');
  assert.equal(selection.expected_environment, 'REPLAY');
  assert.equal(selection.purpose, 'NOT_ELIGIBLE');
  assert.equal(selection.build_mode, null);
  assert.deepEqual(selection.warmup_interval, {
    start_utc: valid.warmup_start_utc,
    end_utc: valid.warmup_end_utc,
  });
});

test('rejects a telemetry identity outside Ocean TEST namespace', () => {
  assert.throws(() => selectionFor({ ...valid, run_id: 'v0448-unmanaged' }), /TEST_RUN_ID_REQUIRED/);
});

test('rejects non-contiguous warmup and scored interval', () => {
  assert.throws(
    () => selectionFor({ ...valid, warmup_end_utc: '2025-06-29T23:00:00.000Z' }),
    /CONTIGUOUS_WARMUP_AND_INTERVAL_REQUIRED/,
  );
});

test('accepts only an exact existing isolated run binding', () => {
  const run = {
    context: {
      run_id: valid.run_id,
      strategy_id: 'cicd-vwap-pull-back-strategy',
      execution_instance_id: 'test-cicd-vwap-pull-back-replay-two-v013',
      expected_environment: 'REPLAY',
      evidence_purpose: 'NOT_ELIGIBLE',
      learner_permission: 'NONE',
    },
  };
  assert.equal(validateExistingRun(run, valid.run_id), run);
  assert.throws(() => validateExistingRun({ context: { ...run.context, learner_permission: 'LEARNING' } }, valid.run_id), /AUTHORITY_CONFLICT/);
});
