import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { websiteTiming, createRequestTiming } from '../request-timing.mjs';

// Pure software fixtures and an in-memory query double: no WorkflowBackend,
// SQLite connection, native runtime probe, service or production file reads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-onboarding-spans-'));
const auxiliary = Object.fromEntries(['OCEAN_VWAP_REPLAY_CAMPAIGN_STATE', 'OCEAN_VWAP_IMPROVEMENT_MONITOR_STATE',
  'OCEAN_VWAP_PHYSICAL_COMPARATOR_CONTRACT', 'OCEAN_VWAP_APPROVAL_DISPATCH_STATE'].map(key => [key, path.join(root, `${key}.json`)]));
const previous = Object.fromEntries(Object.keys(auxiliary).map(key => [key, process.env[key]]));
Object.assign(process.env, auxiliary);
const { readWorkflowView } = await import('./ui-api.mjs');
const { loadStrategyOnboarding } = await import('./strategy-onboarding.mjs');
for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
after(() => fs.rmSync(root, { recursive: true, force: true }));
const strategy = 'test-private-strategy-identity';
const sourceNames = ['strategy-registry.json', 'strategy-profile.json', 'execution-instance.json',
  'replay-two-setup.json', 'unresolved-items.json', 'replay-two-alert-remediation.json'];
for (const name of sourceNames) fs.writeFileSync(path.join(root, name), JSON.stringify({ strategy_id: strategy, strategy_name: 'Private fixture contents' }));
const runtime = () => ({ monitor: { state: 'UNKNOWN' }, sierra: { state: 'UNKNOWN' },
  chart_replay: { state: 'STATUS_UNAVAILABLE', started: null, observed_at_utc: null }, manual_launch: { available: false } });
const expected = ['workflow.onboarding.source.identity', 'workflow.onboarding.db.events',
  'workflow.onboarding.db.brain-outbox', 'workflow.onboarding.db.registration', 'workflow.onboarding.db.activation',
  ...['registry', 'profile', 'instance', 'setup', 'unresolved', 'remediation'].map(key => `workflow.onboarding.source.${key}`),
  'workflow.onboarding.runtime-cache', ...['campaign', 'priority', 'autonomous', 'monitor', 'comparator', 'dispatch'].map(key => `workflow.onboarding.aux.${key}`)];

function backend(failTable, failure) {
  const queries = [];
  const query = sql => { queries.push(sql); if (failTable && sql.includes(failTable)) throw failure;
    return sql.includes('COUNT(*)') ? { n: 0 } : undefined; };
  return { config: { strategy_onboarding_root: root, strategy_onboarding_runtime_probe: runtime,
    strategy_improvement_monitor_state: auxiliary.OCEAN_VWAP_IMPROVEMENT_MONITOR_STATE,
    strategy_physical_comparator_contract: auxiliary.OCEAN_VWAP_PHYSICAL_COMPARATOR_CONTRACT,
    strategy_approval_dispatch_state: auxiliary.OCEAN_VWAP_APPROVAL_DISPATCH_STATE },
    db: { prepare(sql) { return { all() { query(sql); return []; }, get() { return query(sql); } }; } }, queries };
}
function withTiming(work) {
  let clock = 0; const events = [], labels = [], original = websiteTiming.sync;
  const timing = createRequestTiming({ clock: () => clock, utc: () => 'SOFTWARE_FIXTURE', thresholdMs: 1, log: event => events.push(event) });
  timing.start();
  websiteTiming.sync = (label, reader) => { labels.push(label); return timing.sync(label, () => { clock += 2; return reader(); }); };
  try { return { value: work(), events, labels }; }
  finally { websiteTiming.sync = original; timing.stop(); }
}
function withoutStamp(value) { const { refreshed_at_utc, ...rest } = value; return rest; }

test('fixed subspans preserve successful projection, null observations and exact reader call order', () => {
  const beforeBackend = backend(), afterBackend = backend();
  const before = readWorkflowView(beforeBackend, { role: 'HUMAN' }, 'view/strategies/page/0');
  const measured = withTiming(() => readWorkflowView(afterBackend, { role: 'HUMAN' }, 'view/strategies/page/0'));
  assert.deepEqual(withoutStamp(measured.value), withoutStamp(before));
  assert.deepEqual(afterBackend.queries, beforeBackend.queries);
  assert.equal(measured.value.items[0].onboarding.replay_runtime.chart_replay.started, null);
  assert.equal(measured.value.items[0].onboarding.safety.execution_authority, false);
  assert.equal(measured.value.items[0].onboarding.source.status, 'AVAILABLE');
  for (const label of expected) assert.ok(measured.labels.includes(label), label);
  assert.equal(measured.labels.filter(label => label === 'workflow.onboarding.source.identity').length, 2);
  assert.ok(new Set(measured.labels).size < 32);
  const diagnostics = JSON.stringify(measured.events);
  for (const privateText of [root, strategy, 'Private fixture contents', 'SELECT', 'ow_events', '.json']) assert.ok(!diagnostics.includes(privateText), privateText);
});

test('all four throwing query readers keep the original exception identity and stop at the same reader', () => {
  for (const [table, label] of [['ow_events', 'events'], ['ow_onboarding_brain_outbox', 'brain-outbox'],
    ['ow_onboarding_registrations', 'registration'], ['ow_onboarding_activation_events', 'activation']]) {
    const failure = new Error('private database failure'), beforeBackend = backend(table, failure), afterBackend = backend(table, failure);
    assert.throws(() => readWorkflowView(beforeBackend, { role: 'HUMAN' }, 'view/strategies/page/0'), error => error === failure);
    let labels;
    assert.throws(() => withTiming(() => { labels = [];
      const original = websiteTiming.sync; websiteTiming.sync = (name, reader) => { labels.push(name); return original(name, reader); };
      return readWorkflowView(afterBackend, { role: 'HUMAN' }, 'view/strategies/page/0');
    }), error => error === failure);
    assert.deepEqual(afterBackend.queries, beforeBackend.queries);
    assert.ok(labels.includes(`workflow.onboarding.db.${label}`));
  }
});

test('runtime errors and source missing/invalid states retain their existing behavior', () => {
  const options = { root, runtimeProbe: runtime, campaignStatePath: auxiliary.OCEAN_VWAP_REPLAY_CAMPAIGN_STATE,
    improvementMonitorStatePath: auxiliary.OCEAN_VWAP_IMPROVEMENT_MONITOR_STATE,
    physicalComparatorPath: auxiliary.OCEAN_VWAP_PHYSICAL_COMPARATOR_CONTRACT,
    approvalDispatchStatePath: auxiliary.OCEAN_VWAP_APPROVAL_DISPATCH_STATE };
  const failure = new Error('private runtime failure');
  assert.throws(() => loadStrategyOnboarding({ ...options, runtimeProbe() { throw failure; } }), error => error === failure);
  assert.throws(() => withTiming(() => loadStrategyOnboarding({ ...options, runtimeProbe() { throw failure; } })), error => error === failure);
  fs.writeFileSync(path.join(root, 'strategy-profile.json'), '{invalid');
  fs.unlinkSync(path.join(root, 'execution-instance.json'));
  const before = loadStrategyOnboarding(options), measured = withTiming(() => loadStrategyOnboarding(options));
  assert.deepEqual(measured.value, before);
  assert.equal(measured.value.source.files.find(file => file.filename === 'strategy-profile.json').state, 'INVALID');
  assert.equal(measured.value.source.files.find(file => file.filename === 'execution-instance.json').state, 'MISSING');
  assert.equal(measured.value.safety.execution_authority, false);
});
