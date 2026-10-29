import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { websiteTiming, createRequestTiming } from '../request-timing.mjs';
import { observeReplayRuntime, loadStrategyOnboarding } from './strategy-onboarding.mjs';
import { loadConfiguredVwapImprovementReports } from './vwap-improvement-reader.mjs';
import { readVwapImprovementStatus, handleVwapImprovementRequest } from './vwap-improvement-status.mjs';
import { enrichStrategyApprovalStatuses } from './paperclip-approval-status.mjs';
import { loadVwapPhysicalComparatorApprovalDispatchConfig } from './vwap-physical-comparator-approval-dispatch.mjs';
import { readWorkflowViewAsync } from './ui-api.mjs';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';

async function measured(work) {
  let time = 0; const events = [], labels = [], original = websiteTiming.sync;
  const timing = createRequestTiming({ clock: () => time, utc: () => 'SOFTWARE_FIXTURE', thresholdMs: 1, log: event => events.push(event) });
  timing.start(); websiteTiming.sync = (label, callback) => {
    labels.push(label); return timing.sync(label, () => { time += 2; return callback(); });
  };
  try { return { value: await work(), labels, events }; }
  finally { websiteTiming.sync = original; timing.stop(); }
}
const normalized = value => JSON.parse(JSON.stringify(value, (key, item) => ['checked_at_utc','refreshed_at_utc'].includes(key) ? undefined : item));

test('the companion diagnostic catalogue is fixed and remains below the existing global label bound', () => {
  const labels = new Set();
  for (const file of ['../server.mjs', 'backend.mjs', 'ui-api.mjs', 'strategy-onboarding.mjs', 'vwap-improvement-reader.mjs',
    'vwap-improvement-status.mjs', 'paperclip-approval-status.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/timedSync\('(workflow\.companion\.[a-z.-]+)'/g)) labels.add(match[1]);
  }
  assert.equal(labels.size, 12); assert.ok(labels.size < 32);
});

test('status config/report synchronous portions preserve reports, public projection and failures with redacted fixed labels', async t => {
  const f = makeVwapStatusSoftwareFixture(t), options = { configFile: f.configFile, now: f.now };
  const before = await loadConfiguredVwapImprovementReports(options);
  const result = await measured(() => loadConfiguredVwapImprovementReports({ ...options, diagnosticTiming: true }));
  assert.deepEqual(result.value, before);
  assert.deepEqual(result.labels, ['workflow.companion.reader-config', 'workflow.companion.report-loader.sync']);
  for (const loadReports of [() => { throw Object.assign(new Error('PRIVATE_READER_FAILURE'), { code: 'PRIVATE_READER_FAILURE' }); },
    async () => { throw new Error('PRIVATE_READER_FAILURE'); }]) {
    const plain = await loadConfiguredVwapImprovementReports({ ...options, loadReports });
    const traced = await measured(() => loadConfiguredVwapImprovementReports({ ...options, loadReports, diagnosticTiming: true }));
    assert.deepEqual(traced.value, plain);
  }
  const statusOptions = { now: f.now, legacyState: { closed: null }, loadConfigured: () => before };
  const plainStatus = await readVwapImprovementStatus(statusOptions);
  const publicResult = await measured(async () => {
    let bytes, headers, status;
    await handleVwapImprovementRequest({ method: 'GET' }, { writeHead(code, fields) { status = code; headers = fields; }, end(body) { bytes = body; } },
      new URL('http://127.0.0.1/api/vwap-improvement-monitor/status'), statusOptions);
    return { status, headers, bytes };
  });
  assert.equal(publicResult.value.status, 200); assert.deepEqual(JSON.parse(publicResult.value.bytes), plainStatus);
  assert.equal(publicResult.value.headers['Cache-Control'], 'no-store');
  assert.deepEqual(publicResult.labels, ['workflow.companion.status-project', 'workflow.companion.status-serialize']);
  const logs = JSON.stringify([...result.events, ...publicResult.events]);
  for (const forbidden of [f.root, 'DO_NOT_PROJECT', 'database_path', 'PRIVATE_READER_FAILURE', 'SELECT', 'Bearer']) assert.ok(!logs.includes(forbidden));
});

test('existing native observer launch and callback timing preserves arguments, nulls and exact errors without launching a process', async () => {
  const input = { executable: 'C:/private/never-start.exe', chart_id: 'PRIVATE_CHART_ID' }, expected = { chart_replay: { started: null }, value: null };
  let captured;
  const result = await measured(() => observeReplayRuntime(input, (executable, args, options, callback) => {
    captured = { executable, args, options }; queueMicrotask(() => callback(null, JSON.stringify(expected))); return { pid: 0 };
  }));
  assert.deepEqual(result.value, expected); assert.equal(captured.executable, process.execPath);
  assert.ok(captured.args[0].endsWith('strategy-runtime-probe.mjs')); assert.deepEqual(JSON.parse(captured.args[1]), input);
  assert.deepEqual(captured.options, { encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 128 * 1024 });
  assert.deepEqual(result.labels, ['workflow.companion.runtime-launch', 'workflow.companion.runtime-json']);
  for (const mode of ['launch', 'callback']) {
    const failure = new Error('PRIVATE_NATIVE_FAILURE');
    await measured(async () => {
      await assert.rejects(observeReplayRuntime(input, (_exe, _args, _options, callback) => {
        if (mode === 'launch') throw failure; queueMicrotask(() => callback(failure));
      }), error => error === failure);
    });
  }
  await measured(async () => {
    await assert.rejects(observeReplayRuntime(input, (_exe, _args, _options, callback) => queueMicrotask(() => callback(null, '{bad'))), SyntaxError);
  });
  const logs = JSON.stringify(result.events);
  for (const forbidden of ['PRIVATE_CHART_ID', 'private', process.execPath, 'never-start.exe']) assert.ok(!logs.includes(forbidden));
});

test('monitor status source function has identical read/process behavior and errors with timing off/on', async () => {
  // Compile only the actual pure monitor function with software doubles. Importing
  // server.mjs would initialize real services and is deliberately avoided.
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function monitorState('), end = source.indexOf('\nfunction startMonitor(', start);
  assert.ok(start >= 0 && end > start);
  let failure = null; const calls = [];
  const monitor = vm.runInNewContext(`(${source.slice(start, end)})`, {
    MONITOR_STATE_FILE: 'PRIVATE_STATE_PATH', monitorProcess: null,
    readJsonFile(file, fallback) { calls.push(['read', file, fallback]); if (failure === 'read') throw sentinel; return { pid: 123, status: 'observed', null_value: null }; },
    isProcessAlive(pid) { calls.push(['process', pid]); if (failure === 'process') throw sentinel; return true; },
    timedSync: (label, callback) => websiteTiming.sync(label, callback),
  });
  const sentinel = new Error('PRIVATE_MONITOR_FAILURE');
  const before = monitor(), beforeCalls = calls.splice(0);
  const result = await measured(() => monitor(true)); assert.deepEqual(result.value, before); assert.deepEqual(calls.splice(0), beforeCalls);
  assert.deepEqual(result.labels, ['workflow.companion.monitor-read', 'workflow.companion.monitor-process']);
  for (failure of ['read', 'process']) {
    assert.throws(() => monitor(), error => error === sentinel);
    await measured(() => assert.throws(() => monitor(true), error => error === sentinel));
  }
  assert.ok(!JSON.stringify(result.events).includes('PRIVATE_')); assert.ok(!JSON.stringify(result.events).includes('123'));
  const branch = source.slice(source.indexOf('if (requestUrl.pathname === "/api/vwap-improvement-monitor/status")'), source.indexOf('if (req.url === "/api/monitor/start"'));
  assert.match(branch, /timedSync\('workflow\.companion\.legacy-state'/); assert.match(branch, /websiteMonitor: monitorState\(true\)/);
});

test('post-worker approval config and main strategy assembly keep authority, output and error semantics', async t => {
  const f = makeVwapStatusSoftwareFixture(t), config = loadVwapPhysicalComparatorApprovalDispatchConfig();
  const configPath = path.join(f.root, 'dispatch-config.json'); const { config_path, ...document } = config;
  fs.writeFileSync(configPath, JSON.stringify(document));
  const reference = { approval_id: config.sealed_authority.approvals[0].approval_id, purpose: 'Software test approval' };
  const view = { onboarding: { continuous_delivery: { autonomous_improvement: { required_human_approvals: [reference] } } } };
  const options = { dispatchConfigPath: configPath, fetchImpl: async (_url, request) => {
    assert.equal(request.method, 'GET'); assert.equal(request.headers.Authorization, undefined);
    return new Response(JSON.stringify({ id: reference.approval_id, companyId: config.paperclip.company_id, type: 'request_board_approval', status: 'pending', payload: { title: 'Fixture' } }));
  } };
  const before = await enrichStrategyApprovalStatuses(view, options);
  const measuredApproval = await measured(() => enrichStrategyApprovalStatuses(view, options));
  assert.deepEqual(normalized(measuredApproval.value), normalized(before)); assert.deepEqual(measuredApproval.labels, ['workflow.companion.approval-config']);
  const failedOptions = { ...options, dispatchConfigPath: path.join(f.root, 'missing.json') };
  const failure = await enrichStrategyApprovalStatuses(view, failedOptions);
  const measuredFailure = await measured(() => enrichStrategyApprovalStatuses(view, failedOptions));
  assert.deepEqual(normalized(measuredFailure.value), normalized(failure));
  const runtime = { chart_replay: { started: null } }, projection = loadStrategyOnboarding({ root: f.root, runtimeProbe: () => runtime,
    campaignStatePath: null, improvementMonitorStatePath: null, physicalComparatorPath: null, approvalDispatchStatePath: null });
  const backend = { config: { strategy_onboarding_runtime_probe: () => runtime },
    db: { prepare(sql) { return { all: () => [], get: () => sql.includes('COUNT(*)') ? { n: 0 } : undefined }; } },
    onboardingProjectionReader: { async read(kind) { return kind === 'identity' ? projection.strategy_id : { projection, runtimeSpec: {} }; } } };
  const plain = await readWorkflowViewAsync(backend, { role: 'HUMAN' }, 'view/strategies/page/0');
  const traced = await measured(() => readWorkflowViewAsync(backend, { role: 'HUMAN' }, 'view/strategies/page/0'));
  assert.deepEqual(normalized(traced.value), normalized(plain)); assert.ok(traced.labels.includes('workflow.companion.strategy-assembly'));
  const allLabels = new Set([...measuredApproval.labels, ...measuredFailure.labels, ...traced.labels]); assert.ok(allLabels.size < 32);
  assert.ok(!JSON.stringify([...measuredApproval.events, ...traced.events]).includes(f.root));
});
