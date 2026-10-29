import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { EventEmitter, getEventListeners } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createOnboardingProjectionReader } from './onboarding-projection-reader.mjs';
import { loadStrategyOnboarding, applyOnboardingRuntime } from './strategy-onboarding.mjs';
import { readWorkflowViewAsync } from './ui-api.mjs';
import { withBoundedOnboardingReads, readOnboardingFileSync } from './onboarding-file-read.mjs';
import { WorkflowError } from './common.mjs';
import { serializeOnboardingProjectionError } from './onboarding-projection-errors.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-projection-software-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const strategy = 'cicd-vwap-pull-back-strategy';
  const files = {
    'strategy-registry.json': { strategy_id: strategy, strategy_name: 'Software fixture', profile_id: 'fixture-profile', profile_version: 'v1', profile_hash: 'hash', baseline_version: 'v1', activation_status: 'PENDING_ONBOARDING' },
    'strategy-profile.json': { strategy_id: strategy, profile_id: 'fixture-profile', profile_version: 'v1', profile_hash: 'hash', baseline_version: 'v1', strategy_code_hash: 'code', strategy_config_hash: 'config', onboarding_status: 'PENDING_ONBOARDING' },
    'execution-instance.json': { strategy_id: strategy, execution_instance_id: 'test-fixture', status: 'PREPARED_NOT_REGISTERED', safety_state: {}, capabilities: [], installation_root: root, executable: path.join(root, 'never-run.exe'), chartbook_path: path.join(root, 'never-open.Cht'), chart_id: '1' },
    'replay-two-setup.json': { strategy_id: strategy, configuration_revision: 'fixture-v1', status: 'PREPARED_NOT_ACTIVATED' },
    'unresolved-items.json': { strategy_id: strategy, items: [] },
    'replay-two-alert-remediation.json': { strategy_id: strategy, fix: { alerts_enabled: false }, validation: { automated_order_placement: false, telemetry_logging: false }, diagnosis: { dll_rebuild_required: false } },
    'priority-completion-program.json': { schema_version: 'cicd-vwap-priority-completion-program/v1', strategy_id: strategy, authorization: { live_real: 'PROHIBITED' }, workstreams: [] },
    'autonomous-continuous-improvement-program.json': { schema_version: 'cicd-vwap-autonomous-continuous-improvement-program/v1', strategy_id: strategy, authorization: { live_real: 'PROHIBITED', real_order_routing: 'PROHIBITED' }, fixed_boundaries: { live_real_enabled: false, automatic_approval_enabled: false, production_version: null }, pipeline: [] },
    'campaign.json': { schema_version: 'cicd-vwap-replay-campaign-state/v1', strategy_id: strategy, execution_instance_id: 'test-cicd-vwap-pull-back-replay-two-v013', live_real: 'DISABLED', status: 'NOT_STARTED', completed_windows: [], failed_windows: [] },
    'monitor.json': { status: 'SOFTWARE_FIXTURE_ONLY', eligible_trade_count: null, net: null },
    'dispatch.json': { schema_version: 'ocean-vwap-physical-comparator-approval-dispatch-state/v1', strategy_id: strategy, status: 'NOT_STARTED', safety: { execution_authority: false }, gate: { action: 'READ_ONLY_PREFLIGHT_ONLY', current_permission_state: 'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE', post_preflight_gate: 'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED', post_preflight_action: 'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT' } },
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const options = { root, events: [], brainOutbox: [], registration: null, activationEvents: [], campaignStatePath: path.join(root, 'campaign.json'),
    improvementMonitorStatePath: path.join(root, 'monitor.json'), physicalComparatorPath: path.join(root, 'missing-comparator.json'), approvalDispatchStatePath: path.join(root, 'dispatch.json') };
  const reader = createOnboardingProjectionReader(); t.after(() => reader.close());
  const runtime = { sierra: { state: 'UNKNOWN' }, chart_replay: { state: 'STATUS_UNAVAILABLE', started: null, observed_at_utc: null }, manual_launch: { available: false } };
  return { root, strategy, files, options, reader, runtime };
}
const code = expected => error => error.status === 503 && error.code === expected;

test('fresh fixed worker preserves pure projection, auxiliary data, nulls, hashes, source times and invalid/missing states', async t => {
  const f = fixture(t);
  assert.equal(await f.reader.read('identity', { root: f.root }), f.strategy);
  for (const state of ['valid', 'invalid', 'missing']) {
    if (state === 'invalid') { fs.writeFileSync(path.join(f.root, 'strategy-profile.json'), '{bad'); fs.writeFileSync(path.join(f.root, 'dispatch.json'), '{bad'); }
    if (state === 'missing') fs.unlinkSync(path.join(f.root, 'execution-instance.json'));
    const expected = loadStrategyOnboarding({ ...f.options, runtimeProbe: () => f.runtime });
    const result = await f.reader.read('projection', f.options);
    assert.deepEqual(applyOnboardingRuntime(result.projection, f.runtime), expected);
    assert.equal(result.projection.continuous_delivery.event_monitor.net, null);
    assert.equal(result.projection.safety.execution_authority, false);
  }
  fs.writeFileSync(path.join(f.root, 'monitor.json'), JSON.stringify({ status: 'CHANGED_SOFTWARE_ONLY', net: null }));
  const changed = await f.reader.read('projection', f.options);
  assert.equal(changed.projection.continuous_delivery.event_monitor.status, 'CHANGED_SOFTWARE_ONLY', 'never reuse an earlier projection');
  const nullPaths = { ...f.options, improvementMonitorStatePath: null, physicalComparatorPath: null, approvalDispatchStatePath: null };
  const nullResult = await f.reader.read('projection', nullPaths);
  assert.deepEqual(applyOnboardingRuntime(nullResult.projection, f.runtime), loadStrategyOnboarding({ ...nullPaths, runtimeProbe: () => f.runtime }));
});

test('file/input/output limits reject whole projections instead of returning caught partial state', async t => {
  const f = fixture(t);
  await assert.rejects(f.reader.read('projection', { ...f.options, events: ['x'.repeat(256 * 1024)] }), code('ONBOARDING_INPUT_SIZE_LIMIT'));
  fs.writeFileSync(path.join(f.root, 'strategy-profile.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(f.reader.read('projection', f.options), code('ONBOARDING_FILE_SIZE_LIMIT'));
  fs.writeFileSync(path.join(f.root, 'strategy-profile.json'), JSON.stringify(f.files['strategy-profile.json']));
  fs.writeFileSync(path.join(f.root, 'monitor.json'), JSON.stringify({ private: 'x'.repeat(2 * 1024 * 1024) }));
  await assert.rejects(f.reader.read('projection', f.options), code('ONBOARDING_OUTPUT_SIZE_LIMIT'));
  const file = path.join(f.root, 'tiny.txt'); fs.writeFileSync(file, '1234');
  assert.throws(() => withBoundedOnboardingReads({ maxFileBytes: 10, maxTotalBytes: 6, maxReads: 3 }, () => {
    readOnboardingFileSync(file); try { readOnboardingFileSync(file); } catch {} return 'must not hide failure';
  }), error => error.code === 'ONBOARDING_TOTAL_SIZE_LIMIT');
  assert.equal(readOnboardingFileSync(file, 'utf8'), '1234', 'outside the scope original reads remain unchanged');
});

class FakeWorker extends EventEmitter {
  ref() {} unref() {}
  postMessage(value) { this.last = value; }
  terminate() { this.terminated = (this.terminated || 0) + 1; return new Promise(resolve => { this.finishTermination = resolve; }); }
}
test('bounded queue, cancellation, timeout and retiring generation cannot grow workers or reuse stale results', async () => {
  const workers = [], reader = createOnboardingProjectionReader({ timeoutMs: 100, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const first = reader.read('identity', {}), second = reader.read('identity', {}), third = reader.read('identity', {});
  const settled = Promise.allSettled([first, second, third]);
  await assert.rejects(reader.read('identity', {}), code('ONBOARDING_READER_BUSY'));
  const results = await settled; assert.ok(results.every(result => result.reason.code === 'ONBOARDING_READ_TIMEOUT'));
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, 1);
  const queuedDuringRetirement = reader.read('identity', {});
  assert.equal(workers.length, 1, 'a fresh request waits without creating a successor');
  workers[0].emit('message', { id: 1, result: 'stale' });
  workers[0].finishTermination(); await new Promise(resolve => setImmediate(resolve));
  workers[1].emit('message', { id: workers[1].last.id, result: 'fresh-after-retirement' });
  assert.equal(await queuedDuringRetirement, 'fresh-after-retirement');
  const abort = new AbortController(), cancelled = reader.read('identity', {}, { signal: abort.signal });
  const replacement = reader.read('identity', {});
  const cancelledResult = assert.rejects(cancelled, code('ONBOARDING_READ_CANCELLED')); abort.abort(); await cancelledResult;
  assert.equal(workers.length, 2); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  workers[1].finishTermination(); await new Promise(resolve => setImmediate(resolve));
  workers[2].emit('message', { id: workers[2].last.id, result: 'fresh' });
  assert.equal(await replacement, 'fresh', 'force-refresh survives the old active request cancellation'); reader.close(); workers[2].finishTermination();
  await assert.rejects(reader.read('identity', {}), code('ONBOARDING_READER_CLOSED'));
});

test('slow isolated software work yields the HTTP event loop; shutdown rejects outstanding reads', async () => {
  const reader = createOnboardingProjectionReader({ timeoutMs: 3000, workerFactory: () => new Worker(`
    const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{
      const end=Date.now()+180;while(Date.now()<end){};parentPort.postMessage({id:m.id,result:'software-only'});
    });`, { eval: true, env: {}, execArgv: [] }) });
  try {
    let completed = false;
    const server = http.createServer((request, response) => {
      if (request.url === '/health') return response.end('alive');
      void reader.read('identity', {}).then(result => { completed = true; response.end(result); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const projection = fetch(base + '/projection');
      await new Promise(resolve => setTimeout(resolve, 15));
      const health = await fetch(base + '/health'); assert.equal(await health.text(), 'alive');
      assert.equal(completed, false, 'independent HTTP health completes before isolated software work');
      assert.equal(await (await projection).text(), 'software-only');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const pending = reader.read('identity', {}); const rejected = assert.rejects(pending, code('ONBOARDING_READER_CLOSED')); reader.close(); await rejected;
  } finally { reader.close(); }
});

test('unexpected worker error/exit fail closed and remove the old generation before recovery', async () => {
  for (const event of ['error', 'exit']) {
    const workers = [], reader = createOnboardingProjectionReader({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const pending = reader.read('identity', {}), rejected = assert.rejects(pending, code('ONBOARDING_WORKER_UNAVAILABLE'));
    workers[0].emit(event, event === 'error' ? new Error('private failure must not escape') : 1); await rejected;
    assert.equal(workers[0].listenerCount('message'), 0); assert.equal(workers[0].listenerCount('exit'), 0);
    const recovered = reader.read('identity', {}); assert.equal(workers.length, 1);
    workers[0].finishTermination(); await new Promise(resolve => setImmediate(resolve));
    workers[1].emit('message', { id: workers[1].last.id, result: 'fresh' });
    assert.equal(await recovered, 'fresh'); reader.close(); workers[1].finishTermination();
  }
});

test('error transport preserves deliberately public WorkflowError and strips unexpected source exceptions', async () => {
  const worker = new FakeWorker(), reader = createOnboardingProjectionReader({ workerFactory: () => worker });
  try {
    const sourceError = new WorkflowError(409, 'ONBOARDING_SOURCE_CHANGED', 'Source changed before projection finished');
    const pending = reader.read('projection', {});
    worker.emit('message', { id: worker.last.id, error: serializeOnboardingProjectionError(sourceError) });
    await assert.rejects(pending, error => error instanceof WorkflowError && error.status === 409
      && error.code === sourceError.code && error.message === sourceError.message);
    const privateError = new TypeError('private contents at C:/private/source.json');
    const envelope = serializeOnboardingProjectionError(privateError); assert.deepEqual(envelope, { kind: 'INTERNAL' });
    const unexpected = reader.read('projection', {}); worker.emit('message', { id: worker.last.id, error: envelope });
    await assert.rejects(unexpected, error => !(error instanceof WorkflowError) && error.message === 'Workflow operation failed');
  } finally { reader.close(); worker.finishTermination(); }
});

test('failed termination never permits an unbounded successor worker', async () => {
  let workers = 0; const worker = new FakeWorker(); worker.terminate = () => Promise.reject(new Error('termination not proved'));
  const reader = createOnboardingProjectionReader({ timeoutMs: 30, workerFactory: () => { workers++; return worker; } });
  const abort = new AbortController(), pending = reader.read('identity', {}, { signal: abort.signal });
  const rejected = assert.rejects(pending, code('ONBOARDING_READ_CANCELLED')); abort.abort(); await rejected;
  await assert.rejects(reader.read('identity', {}), code('ONBOARDING_READ_TIMEOUT'));
  assert.equal(workers, 1); reader.close();
});

test('async UI projection authenticates before worker use, awaits fresh reads, rechecks identity and merges only cached runtime observation', async t => {
  const f = fixture(t), result = await f.reader.read('projection', f.options); let calls = 0, runtimeCalls = 0; const deadlines = [];
  const backend = { config: { strategy_onboarding_root: f.root, strategy_onboarding_runtime_probe: spec => { runtimeCalls++; assert.equal(spec.executable, path.join(f.root, 'never-run.exe')); return f.runtime; } },
    db: { prepare(sql) { return { all: () => [], get: () => sql.includes('COUNT(*)') ? { n: 0 } : undefined }; } },
    onboardingProjectionReader: { async read(kind, options, control) { calls++; deadlines.push(control.deadline); await Promise.resolve(); return kind === 'identity' ? f.strategy : result; } } };
  await assert.rejects(readWorkflowViewAsync(backend, { role: 'STRATEGY' }, 'view/strategies/page/0'), error => error.code === 'WAYNE_BROWSER_ONLY');
  assert.equal(calls, 0);
  const view = await readWorkflowViewAsync(backend, { role: 'HUMAN' }, 'view/strategies/page/0');
  assert.equal(view.items[0].onboarding.replay_runtime.chart_replay.started, null); assert.equal(calls, 2); assert.equal(runtimeCalls, 1);
  assert.equal(deadlines[0], deadlines[1], 'identity and projection share one absolute HTTP budget');
  backend.onboardingProjectionReader.read = async kind => kind === 'identity' ? 'changed-source-identity' : result;
  await assert.rejects(readWorkflowViewAsync(backend, { role: 'HUMAN' }, 'view/strategies/page/0'), error => error.code === 'ONBOARDING_SOURCE_CHANGED');
  assert.equal(runtimeCalls, 1);
});
