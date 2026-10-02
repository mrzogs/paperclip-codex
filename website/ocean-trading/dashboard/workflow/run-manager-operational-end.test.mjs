import assert from 'node:assert/strict';
import test from 'node:test';
import { isOperationalCompletionProducer, isOperationalCompletionReady } from './run-manager.mjs';

const interval = { start_utc: '2026-01-01T00:00:00.000Z', end_utc: '2026-03-01T00:00:00.000Z' };
const producer = { id: 'bound-producer', role: 'TELEMETRY', namespace: 'OPERATIONAL' };
const plan = {
  operational_review: { review_hash: `sha256:${'1'.repeat(64)}` },
  instance: { telemetry_producer_id: producer.id },
  scored_intervals: [interval],
};
const complete = {
  progress: {
    axes: { source_market: [interval], strategy_execution: [interval], processing_review: [interval] },
    watermark: interval.end_utc,
    pending_events: 0,
    gaps: [],
    failures: [],
  },
  open_pins: 0,
  unresolved_records: 0,
};

test('only the exact operational telemetry producer can request COMPLETED', () => {
  assert.equal(isOperationalCompletionProducer(producer, plan, 'COMPLETED'), true);
  assert.equal(isOperationalCompletionProducer({ ...producer, id: 'other' }, plan, 'COMPLETED'), false);
  assert.equal(isOperationalCompletionProducer({ ...producer, namespace: 'TEST' }, plan, 'COMPLETED'), false);
  assert.equal(isOperationalCompletionProducer(producer, plan, 'FAILED'), false);
  assert.equal(isOperationalCompletionProducer(producer, { ...plan, operational_review: null }, 'COMPLETED'), false);
});

test('operational completion requires full drained coverage and the final watermark', () => {
  const run = { state: 'ACTIVE' };
  assert.equal(isOperationalCompletionReady(run, plan, complete), true);
  assert.equal(isOperationalCompletionReady({ state: 'READY' }, plan, complete), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, open_pins: 1 }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, unresolved_records: 1 }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, progress: { ...complete.progress, pending_events: 1 } }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, progress: { ...complete.progress, gaps: ['gap'] } }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, progress: { ...complete.progress, failures: ['failure'] } }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, progress: { ...complete.progress, watermark: '2026-02-28T23:59:59.999Z' } }), false);
  assert.equal(isOperationalCompletionReady(run, plan, { ...complete, progress: { ...complete.progress, axes: { ...complete.progress.axes, processing_review: [] } } }), false);
});
