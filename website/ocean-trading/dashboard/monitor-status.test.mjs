import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createMonitorStatusReader, readMonitorStatusFile, MonitorStatusReadError } from './monitor-status.mjs';
import { shouldWebsiteScheduleManifestRebuild } from './manifest-refresh-policy.mjs';
import { handleVwapImprovementRequest } from './workflow/vwap-improvement-status.mjs';

const source = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const functionSource = (name, next) => {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start); return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end);
};
const oldMonitor = functionSource('monitorState', 'withAsyncMonitorRequest');
const withAsyncMonitor = functionSource('withAsyncMonitorRequest', 'startMonitor');
const code = expected => error => error instanceof MonitorStatusReadError && error.status === 503 && error.code === expected;
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-monitor-read-software-')), file = path.join(root, 'monitor.json');
  let managed = null, alive = false; const checks = [];
  const reader = createMonitorStatusReader({ file, getManagedProcess: () => managed,
    isProcessAlive: pid => { checks.push(pid); return alive; }, ...overrides });
  t.after(() => { reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, reader, checks, setProcess(value, external) { managed = value; alive = external; },
    legacy() {
      return vm.runInNewContext(`(${oldMonitor})`, { MONITOR_STATE_FILE: file, monitorProcess: managed,
        readJsonFile(filename, fallback) { if (!fs.existsSync(filename)) return fallback;
          try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return fallback; } },
        isProcessAlive: pid => { checks.push(pid); return alive; }, timedSync: (_label, work) => work() })();
    } };
}

function snapshotContext(reader, events = []) {
  const manifest = { generatedAtUtc: '2026-10-29T00:00:00Z', propFirms: [], tradingModes: {
    live: { openPositions: [], performanceClosedTrades: [], accountSnapshots: [] },
    paper: { openPositions: [], performanceClosedTrades: [], accountSnapshots: [], projectTelemetry: { closedTrades: [] } },
  } };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-29T12:00:00Z'])); } }
  return { monitorStatusReader: reader, Date: FixedDate, MANIFEST_FILE: 'FIXTURE_MANIFEST',
    VWAP_PROJECT_PAPER_SQLITE_FILE: 'FIXTURE_PROJECT', PATRADING_LIVE_SQLITE_FILE: 'FIXTURE_LIVE', PATRADING_PAPER_SQLITE_FILE: 'FIXTURE_PAPER',
    buildManifest(options) { events.push(['manifest', JSON.parse(JSON.stringify(options))]); return JSON.stringify(manifest); },
    fs: { existsSync(file) { events.push(['exists', file]); return true; }, statSync(file) { events.push(['stat', file]); return { mtime: new FixedDate(), mtimeMs: 50 }; } },
    fileMtimeMs(file) { events.push(['mtime', file]); return 70; },
    sqliteInputFiles(file) { events.push(['sqlite', file]); return [file]; },
    readSierraSymbolConfig() { events.push(['sierra-config']); return { paper: { patradingSqliteFile: 'FIXTURE_PAPER' } }; } };
}

test('delayed descriptor open/read cancellation closes the actual handle before its I/O slot can be reused', async () => {
  for (const stage of ['open', 'read']) {
    let release, closes = 0, reads = 0;
    const gate = new Promise(resolve => { release = resolve; }), abort = new AbortController();
    const handle = { stat: async () => ({ isFile: () => true, size: 2 }), async read() { reads++; await gate; return { bytesRead: 0 }; }, async close() { closes++; } };
    let opened;
    const started = new Promise(resolve => { opened = resolve; });
    const pending = readMonitorStatusFile('FIXED_TEST_FILE', { signal: abort.signal, maxBytes: 16 }, async () => {
      opened(); if (stage === 'open') await gate; return handle;
    });
    const rejected = assert.rejects(pending, code('MONITOR_STATUS_READ_CANCELLED'));
    await started; if (stage === 'read') await settle(); abort.abort(); assert.equal(closes, 0);
    release(); await rejected; assert.equal(closes, 1); assert.equal(reads, stage === 'open' ? 0 : 1);
  }
});

test('read-only calendar/open-trades snapshots preserve payload and metadata input order while replacing only the monitor leaf', async () => {
  const monitor = { running: true, status: 'observed', unknown: null };
  for (const [name, next, args] of [['dashboardCalendarFreshnessInfo', 'readSierraSymbolConfig', ['paper']],
    ['dashboardCalendarFreshnessInfo', 'readSierraSymbolConfig', ['live']], ['openTradesPayload', 'staticPath', []]]) {
    const events = [], leaf = functionSource(name, next);
    const context = snapshotContext({ read: async () => { events.push(['monitor']); return monitor; } }, events);
    context.monitorState = () => { events.push(['monitor']); return monitor; };
    const before = vm.runInNewContext(`(${leaf.replace(/^async /, '').replace('await monitorStatusReader.read(readOptions)', 'monitorState()')})`, context);
    const current = vm.runInNewContext(`(${leaf})`, context);
    const expected = before(...args), inputs = events.splice(0), result = await current(...args);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(expected))); assert.deepEqual(events.splice(0), inputs);
    const failure = new Error('SOFTWARE_SNAPSHOT_FAILURE'); context.monitorState = () => { throw failure; };
    context.monitorStatusReader.read = async () => { throw failure; };
    assert.throws(() => before(...args), error => error === failure); await assert.rejects(current(...args), error => error === failure);
  }
});

test('actual freshness poll retains rebuild inputs/decisions, never overlaps and releases after errors and shutdown', async () => {
  let tick, timerCount = 0, reads = 0, resolveRead, rejectRead, exists = true, changed = false;
  const inputs = [], logs = [], scheduled = [];
  const context = { manifestFreshnessTimer: null, websiteClosing: false, MANIFEST_FILE: 'FIXTURE_MANIFEST', VWAP_PROJECT_PAPER_SQLITE_FILE: 'FIXTURE_PROJECT',
    process: { env: {} }, fs: { existsSync: () => exists }, fileMtimeMs: file => file === 'FIXTURE_MANIFEST' ? 100 : changed ? 102 : 100,
    sqliteInputFiles: file => [file], monitorStatusReader: { read: () => { reads++; return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }); } },
    shouldWebsiteScheduleManifestRebuild: values => { inputs.push(JSON.parse(JSON.stringify(values))); return shouldWebsiteScheduleManifestRebuild(values); },
    scheduleManifestRebuild: () => { scheduled.push(true); }, console: { error: message => logs.push(message) },
    setInterval(callback, ms) { assert.equal(ms, 5000); tick = callback; timerCount++; return { unref() {} }; } };
  const start = vm.runInNewContext(`(${functionSource('startManifestFreshnessPoll', 'buildManifest')})`, context);
  start(); start(); assert.equal(timerCount, 1); assert.equal(reads, 1);
  await tick(); assert.equal(reads, 1, 'a pending read prevents overlapping polls');
  resolveRead({ running: false }); await settle();
  for (exists of [false, true]) for (changed of [false, true]) for (const running of [false, true]) {
    const before = scheduled.length, result = tick(); resolveRead({ running }); await result;
    assert.deepEqual(inputs.at(-1), { manifestExists: exists, inputChanged: changed, monitorRunning: running });
    assert.equal(scheduled.length - before, shouldWebsiteScheduleManifestRebuild({ manifestExists: exists, inputChanged: changed, monitorRunning: running }) ? 1 : 0);
  }
  const failed = tick(); rejectRead(new Error('SOFTWARE_POLL_FAILURE')); await failed; assert.equal(logs.length, 1);
  const before = reads, recovery = tick(); resolveRead({ running: true }); await recovery; assert.equal(reads, before + 1);
  const closing = tick(), decisions = inputs.length; context.websiteClosing = true; resolveRead({ running: false }); await closing;
  assert.equal(inputs.length, decisions); const finalReads = reads; await tick(); assert.equal(reads, finalReads);
});

test('fresh async reads preserve legacy payload/default/null/process semantics without a result cache', async t => {
  const f = fixture(t);
  for (const state of [{ pid: 123, status: 'observed', count: 7, unknown: null }, { pid: 123, status: '' },
    false, 0, 'text', [], { pid: null }]) {
    fs.writeFileSync(f.file, JSON.stringify(state));
    for (const managed of [null, { killed: false, exitCode: null }, { killed: true, exitCode: null }, { killed: false, exitCode: 0 }]) {
      for (const alive of [false, true]) {
        f.setProcess(managed, alive); f.checks.length = 0;
        const before = f.legacy(), beforeChecks = f.checks.splice(0), current = await f.reader.read();
        assert.deepEqual(JSON.parse(JSON.stringify(current)), JSON.parse(JSON.stringify(before))); assert.deepEqual(f.checks, beforeChecks);
      }
    }
  }
  f.setProcess(null, false);
  for (const content of ['{bad', '\uFEFF{"pid":1}', '']) {
    fs.writeFileSync(f.file, content); assert.deepEqual(await f.reader.read(), JSON.parse(JSON.stringify(f.legacy())));
  }
  fs.unlinkSync(f.file); assert.deepEqual(await f.reader.read(), JSON.parse(JSON.stringify(f.legacy())));
  fs.writeFileSync(f.file, 'null');
  let previous; try { f.legacy(); } catch (error) { previous = error; }
  await assert.rejects(f.reader.read(), error => error.name === previous.name && error.message === previous.message);
  fs.writeFileSync(f.file, '{"revision":1}'); assert.equal((await f.reader.read()).revision, 1);
  fs.writeFileSync(f.file, '{"revision":2}'); assert.equal((await f.reader.read()).revision, 2);
});

test('ordinary read failures keep the fallback; owned size bounds and unexpected process errors remain errors', async t => {
  const f = fixture(t, { maxBytes: 16 }); fs.writeFileSync(f.file, 'x'.repeat(17));
  await assert.rejects(f.reader.read(), code('MONITOR_STATUS_SIZE_LIMIT'));
  const io = fixture(t, { readFile: async () => { throw Object.assign(new Error('PRIVATE_IO'), { code: 'EACCES' }); } });
  assert.deepEqual(await io.reader.read(), { running: false, status: 'stopped', managedByServer: false });
  const failure = new Error('PRIVATE_PROCESS_FAILURE');
  const process = fixture(t, { readFile: async () => Buffer.from('{"pid":1}'), isProcessAlive() { throw failure; } });
  await assert.rejects(process.reader.read(), error => error === failure);
});

test('timeouts and cancellation retain the active native slot, bound queueing, and clean listeners until actual I/O completion', async t => {
  const tasks = [], f = fixture(t, { timeoutMs: 40, readFile: (_file, options) => new Promise(resolve => tasks.push({ resolve, signal: options.signal })) });
  const initial = f.reader.read(), timeout = assert.rejects(initial, code('MONITOR_STATUS_READ_TIMEOUT')); await timeout;
  const queueAbort = new AbortController(), cancelledQueue = f.reader.read({ signal: queueAbort.signal });
  const queueCancellation = assert.rejects(cancelledQueue, code('MONITOR_STATUS_READ_CANCELLED')); queueAbort.abort(); await queueCancellation;
  assert.equal(tasks.length, 1); assert.equal(getEventListeners(queueAbort.signal, 'abort').length, 0);
  const queued = f.reader.read(); const queuedTimeout = assert.rejects(queued, code('MONITOR_STATUS_READ_TIMEOUT'));
  const third = f.reader.read(); const thirdTimeout = assert.rejects(third, code('MONITOR_STATUS_READ_TIMEOUT'));
  await assert.rejects(f.reader.read(), code('MONITOR_STATUS_READER_BUSY'));
  await Promise.all([queuedTimeout, thirdTimeout]); assert.equal(tasks.length, 1);
  tasks[0].resolve(Buffer.from('{}')); await settle();
  const abort = new AbortController(), cancelled = f.reader.read({ signal: abort.signal });
  const cancellation = assert.rejects(cancelled, code('MONITOR_STATUS_READ_CANCELLED')); abort.abort(); await cancellation;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const fresh = f.reader.read(); assert.equal(tasks.length, 2, 'cancelled I/O must finish before another open');
  tasks[1].resolve(Buffer.from('{}')); await settle(); assert.equal(tasks.length, 3);
  tasks[2].resolve(Buffer.from('{"fresh":true}')); assert.equal((await fresh).fresh, true);
  const closing = f.reader.read(), closed = assert.rejects(closing, code('MONITOR_STATUS_READER_CLOSED'));
  const queuedClose = f.reader.read(), queuedClosed = assert.rejects(queuedClose, code('MONITOR_STATUS_READER_CLOSED'));
  f.reader.close(); await Promise.all([closed, queuedClosed]);
  tasks[3].resolve(Buffer.from('{}')); await settle(); await assert.rejects(f.reader.read(), code('MONITOR_STATUS_READER_CLOSED'));
  assert.equal(tasks.length, 4, 'queued cancelled/closed work must never open a file');
});

test('a logical timeout cannot release a native slot while descriptor close is still pending', async t => {
  let releaseClose, opened = 0, handles = 0, maxHandles = 0;
  const closing = new Promise(resolve => { releaseClose = resolve; });
  const f = fixture(t, { timeoutMs: 30, readFile: (file, options) => readMonitorStatusFile(file, options, async () => {
    const number = ++opened; handles++; maxHandles = Math.max(maxHandles, handles);
    return { stat: async () => ({ isFile: () => true, size: 0 }), read: async () => ({ bytesRead: 0 }),
      async close() { if (number === 1) await closing; handles--; } };
  }) });
  await assert.rejects(f.reader.read(), code('MONITOR_STATUS_READ_TIMEOUT'));
  const fresh = f.reader.read(); assert.equal(opened, 1); assert.equal(handles, 1);
  releaseClose(); await fresh; assert.equal(opened, 2); assert.equal(maxHandles, 1); assert.equal(handles, 0);
});

function routeServer(t, reader) {
  const context = { AbortController, MonitorStatusReadError, monitorStatusReader: reader,
    timedSync: (_label, work) => work(), VWAP_IMPROVEMENT_STATE_FILE: 'PRIVATE_FIXED_LEGACY',
    readVwapContinuousImprovementState: () => ({ schema_version: 'legacy', observed_trade_count: null }),
    handleVwapImprovementRequest: (req, res, url, options) => handleVwapImprovementRequest(req, res, url, { ...options,
      loadConfigured: async () => ({ ingestion: { status: 'NOT_CONFIGURED', blockers: [] }, reports: {} }) }) };
  context.withAsyncMonitorRequest = vm.runInNewContext(`(${withAsyncMonitor})`, context);
  Object.assign(context, snapshotContext(reader));
  context.dashboardCalendarFreshnessInfo = vm.runInNewContext(`(${functionSource('dashboardCalendarFreshnessInfo', 'readSierraSymbolConfig')})`, context);
  context.openTradesPayload = vm.runInNewContext(`(${functionSource('openTradesPayload', 'staticPath')})`, context);
  const start = source.indexOf('if (req.url === "/api/monitor/status")'), end = source.indexOf('if (req.url === "/api/monitor/start"', start);
  const calendar = source.slice(source.indexOf('const calendarFreshnessMatch = req.url.match('), source.indexOf('if (req.url === "/api/historical-cache")'));
  const openTrades = source.slice(source.indexOf('if (req.url === "/api/open-trades")'), source.indexOf('if (req.url === "/api/site-config"'));
  const dispatch = vm.runInNewContext(`(function(req,res,requestUrl){${calendar}${source.slice(start, end)}${openTrades}res.writeHead(404).end();})`, context);
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end('alive');
    dispatch(req, res, new URL(req.url, `http://${req.headers.host}`));
  });
  t.after(async () => { reader.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server;
}

test('all actual read-only GET branches await fresh monitor I/O while independent HTTP health stays responsive', async t => {
  const tasks = []; let started;
  const f = fixture(t, { readFile: (file, options) => new Promise(resolve => { tasks.push({ file, options, resolve }); started?.(); }) });
  const server = routeServer(t, f.reader); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`; f.setProcess(null, true);
  for (const route of ['/api/monitor/status', '/api/vwap-improvement-monitor/status', '/api/paper-calendar-freshness', '/api/live-calendar-freshness', '/api/open-trades']) {
    const begun = new Promise(resolve => { started = resolve; }); let complete = false;
    const response = fetch(base + route).then(value => { complete = true; return value; }); await begun;
    assert.equal(await (await fetch(base + '/health')).text(), 'alive'); assert.equal(complete, false);
    assert.equal(tasks.at(-1).file, f.file);
    tasks.at(-1).resolve(Buffer.from('{"pid":123,"status":"observed","unknown":null}'));
    const reply = await response; assert.equal(reply.status, 200); const payload = await reply.json();
    const monitor = route === '/api/monitor/status' ? payload : payload.website_monitor || payload.monitor;
    assert.deepEqual(monitor, { pid: 123, status: 'observed', unknown: null, running: true, managedByServer: false });
    if (payload.website_monitor) { assert.equal(payload.observed_trade_count, null); assert.equal(payload.strategy_improvement.status, 'STALLED'); }
  }
  assert.equal(tasks.length, 5, 'each status request reads its own fresh file');
});

test('both HTTP branches expose bounded unavailable errors and sanitized unexpected errors, never a cached healthy result', async t => {
  let mode = 'size'; const f = fixture(t, { readFile: async () => {
    if (mode === 'size') throw new MonitorStatusReadError('MONITOR_STATUS_SIZE_LIMIT');
    return Buffer.from('null');
  } });
  const server = routeServer(t, f.reader); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/api/monitor/status', '/api/vwap-improvement-monitor/status', '/api/paper-calendar-freshness', '/api/live-calendar-freshness', '/api/open-trades']) {
    const bounded = await fetch(base + route); assert.equal(bounded.status, 503); assert.equal((await bounded.json()).error.code, 'MONITOR_STATUS_SIZE_LIMIT');
  }
  mode = 'null';
  for (const route of ['/api/monitor/status', '/api/vwap-improvement-monitor/status']) {
    const unexpected = await fetch(base + route); assert.equal(unexpected.status, 500);
    assert.deepEqual(await unexpected.json(), { error: { code: 'MONITOR_STATUS_UNAVAILABLE' } });
  }
  for (const route of ['/api/paper-calendar-freshness', '/api/live-calendar-freshness', '/api/open-trades']) {
    const unexpected = await fetch(base + route); assert.equal(unexpected.status, 500);
    assert.deepEqual(await unexpected.json(), { ok: false, error: "Cannot read properties of null (reading 'pid')" });
  }
});

test('real HTTP disconnect cancels its read without freeing unsettled I/O or returning interrupted payload', async t => {
  const tasks = []; let started;
  const f = fixture(t, { readFile: (_file, options) => new Promise(resolve => { tasks.push({ resolve, signal: options.signal }); started?.(); }) });
  const server = routeServer(t, f.reader); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, abort = new AbortController();
  const begun = new Promise(resolve => { started = resolve; });
  const request = fetch(base + '/api/monitor/status', { signal: abort.signal }), rejected = assert.rejects(request, error => error.name === 'AbortError');
  await begun;
  const cancelled = new Promise(resolve => tasks[0].signal.addEventListener('abort', resolve, { once: true }));
  abort.abort(); await Promise.all([rejected, cancelled]);
  const accepted = new Promise(resolve => server.once('request', resolve));
  const replacement = fetch(base + '/api/open-trades'); await accepted; await settle(); assert.equal(tasks.length, 1);
  const nextRead = new Promise(resolve => { started = resolve; }); tasks[0].resolve(Buffer.from('{"stale":true}')); await nextRead;
  assert.equal(tasks.length, 2); tasks[1].resolve(Buffer.from('{"fresh":true}'));
  const response = await replacement; assert.equal(response.status, 200); const payload = await response.json();
  assert.equal(payload.monitor.fresh, true); assert.equal(payload.monitor.stale, undefined);
});
