import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowBackend, workflowFromEnvironment } from './backend.mjs';
import { issueOceanIdentity, issueTestBrowserSecret } from './auth.mjs';
import { digest, sealedHash, WorkflowError } from './common.mjs';
import { initializeAvailableWorkflow, OPTIONAL_PHYSICAL_READINESS_ERRORS } from './startup-availability.mjs';
import { reconcileOperationalReplayRunSettings } from './operational-run-readiness.mjs';
import { chromium, expect } from '@playwright/test';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';
import { handleVwapImprovementRequest } from './vwap-improvement-status.mjs';
import { loadStrategyOnboarding, readOnboardingStrategyId } from './strategy-onboarding.mjs';

const code = 'OPERATIONAL_TELEMETRY_MODULE_HASH_CONFLICT';
const examples = JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json', import.meta.url)));
const python = process.env.OCEAN_TEST_PYTHON || 'C:\\Users\\wayne\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';

async function fixture(t, { degraded = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-startup-availability-'));
  const reports = makeVwapStatusSoftwareFixture(t), now = Date.now();
  for (const document of Object.values(reports.documents)) document.generated_at_utc = new Date(now - 60000).toISOString();
  reports.manifest.published_at_utc = new Date(now - 30000).toISOString(); reports.publish();
  const publicRoot = new URL('../public/workflow/', import.meta.url);
  let backend;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/vwap-improvement-monitor/status') { void handleVwapImprovementRequest(request, response, url); return; }
    if (url.pathname.startsWith('/api/workflow/')) {
      void backend.handle(request, response, url).catch(() => response.writeHead(500).end('{}')); return;
    }
    if (url.pathname === '/assets/ocean-trading-icon.png') { response.setHeader('Content-Type', 'image/png'); response.end(fs.readFileSync(new URL('../public/assets/ocean-trading-icon.png', import.meta.url))); return; }
    const file = url.pathname.startsWith('/workflow/') ? url.pathname.slice('/workflow/'.length) : 'index.html';
    if (!['index.html', 'ui.js', 'ui.css', 'icons.js', 'reprocess-identity.js', 'run-wizard.js', 'onboarding-help.js', 'vwap-improvement-view.js'].includes(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(new URL(file, publicRoot)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); backend?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const environment = { OCEAN_WORKFLOW_ENABLED: '1', OCEAN_ONBOARDING_BRAIN_SYNC: '0', OCEAN_OPERATIONAL_LEARNING_ENABLED: '0',
    OCEAN_VWAP_IMPROVEMENT_REPORT_CONFIG: reports.configFile,
    OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE: path.join(root, 'fixture-binding.json'),
    OCEAN_PAPERCLIP_INTERACTION_CONFIG: path.join(root, 'never-read-provider-config.json') };
  const config = { test_only: true, contract_release: '2.1.0', db_file: path.join(root, 'workflow.sqlite'),
    allowed_origins: [base], python_executable: python, lease_ms: 30000, strategy_onboarding_root: path.join(root, 'sources'),
    browser: { subject_id: 'wayne-ocean-ui', credential_ref: 'OCEAN_WAYNE_BROWSER_SECRET' },
    identities: ['BRAIN', 'TELEMETRY', 'STRATEGY'].map(role => issueOceanIdentity({ identity_id: `test-availability-${role.toLowerCase()}`,
      role, namespace: 'TEST', credential_ref: `OCEAN_${role}_TOKEN`, strategy_ids: ['test-strategy'], instance_ids: ['test-instance'] },
    environment, new Date(Date.now() + 3600000).toISOString())) };
  issueTestBrowserSecret(environment, config.browser.credential_ref);
  fs.mkdirSync(config.strategy_onboarding_root);
  const configFile = path.join(root, 'workflow.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  environment.OCEAN_WORKFLOW_CONFIG = configFile;
  backend = initializeAvailableWorkflow({ environment, python, createBackend: workflowFromEnvironment,
    reconcile: candidate => {
      assert.equal(candidate.operationalLearning.enabled, false);
      assert.equal(candidate.onboardingBrain.enabled, false);
      assert.equal(candidate.operationalCandidateEvaluator.timer, null);
      if (degraded) throw new WorkflowError(503, code, 'private exception path must not be projected');
      return { status: 'READY' };
    } });
  backend.config.strategy_onboarding_runtime_probe = () => ({ state: 'UNKNOWN', reason: 'SOFTWARE_FIXTURE_ONLY',
    chart_replay: { state: 'UNKNOWN', started: false }, sierra: { state: 'UNKNOWN' }, monitor: { state: 'UNKNOWN' },
    manual_launch: { available: false, reason: 'SOFTWARE_FIXTURE_ONLY' } });
  // Three disposable navigation records; no physical instances or telemetry DB.
  for (const strategyId of ['test-alpha', 'test-beta', 'cicd-vwap-pull-back-strategy']) {
    const profile = { ...examples['strategy-profile'], strategy_id: strategyId, profile_id: `test-${strategyId}-profile` };
    const registry = { ...examples['strategy-registry'], strategy_id: strategyId, strategy_name: strategyId, profile_id: profile.profile_id };
    const profileKey = `${profile.profile_id}:${profile.profile_version}`;
    backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(profileKey, strategyId, profile.profile_version, digest(JSON.stringify(profile)), JSON.stringify(profile));
    backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(strategyId, profileKey, 1, profile.strategy_code_hash, JSON.stringify(registry));
  }
  const login = await fetch(`${base}/api/workflow/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: '' }) });
  assert.equal(login.status, 200); const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (route, { method = 'GET', data, anonymous = false, service = false, csrf = session.csrf_token } = {}) => {
    const response = await fetch(`${base}/api/workflow/${route}`, { method, signal: AbortSignal.timeout(5000), headers: {
      Origin: base, ...(!anonymous ? service ? { Authorization: `Bearer ${environment.OCEAN_STRATEGY_TOKEN}` } : { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  };
  return { root, backend, request, environment, config, session, base, reports };
}

test('only the exact optional physical error is eligible; construction and unrelated reconciliation failures remain fatal', () => {
  assert.deepEqual(OPTIONAL_PHYSICAL_READINESS_ERRORS, [code]);
  for (const error of [new WorkflowError(503, 'WORKFLOW_DATABASE_BINDING_CONFLICT'), new WorkflowError(503, 'OPERATIONAL_STRATEGY_MODULE_HASH_CONFLICT'), new Error('unknown')]) {
    let closed = 0;
    assert.throws(() => initializeAvailableWorkflow({ environment: { OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE: 'fixture' },
      createBackend: () => ({ close() { closed++; } }), reconcile() { throw error; } }), actual => actual === error);
    assert.equal(closed, 1);
  }
  const fatal = new Error('fatal construction');
  assert.throws(() => initializeAvailableWorkflow({ environment: {}, createBackend() { throw fatal; } }), actual => actual === fatal);
  assert.equal(initializeAvailableWorkflow({ environment: {}, createBackend: () => null }), null);
});

test('requested background workers start only after successful synchronous physical reconciliation', () => {
  const events = [], environment = { OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE: 'software-fixture',
    OCEAN_ONBOARDING_BRAIN_SYNC: '1', OCEAN_OPERATIONAL_LEARNING_ENABLED: '1' };
  const worker = name => ({ enabled: false, start() { events.push(`${name}:${this.enabled}`); } });
  const backend = initializeAvailableWorkflow({ environment, createBackend: held => {
    assert.equal(held.OCEAN_ONBOARDING_BRAIN_SYNC, '0'); assert.equal(held.OCEAN_OPERATIONAL_LEARNING_ENABLED, '0');
    events.push('constructed-held');
    return { environment: { ...held }, config: { onboarding_brain_sync: { enabled: false }, operational_learning: { enabled: false } },
      onboardingBrain: worker('brain'), operationalLearning: worker('learning'), operationalCandidateEvaluator: worker('evaluator') };
  }, reconcile() { events.push('physical-preflight-ready'); } });
  assert.deepEqual(events, ['constructed-held', 'physical-preflight-ready', 'brain:true', 'evaluator:false', 'learning:true']);
  assert.equal(backend.environment.OCEAN_OPERATIONAL_LEARNING_ENABLED, '1');
  assert.equal(backend.config.operational_learning.enabled, true); assert.equal(backend.config.onboarding_brain_sync.enabled, true);
});

test('real file hash preflight mismatch stays blocked without registering execution settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-physical-pin-fixture-'));
  const db = new DatabaseSync(path.join(root, 'fixture.sqlite'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = JSON.parse(fs.readFileSync(new URL('../config/replay-run-bridge.json', import.meta.url)));
  for (const key of ['workflow_db', 'telemetry_db', 'handoff_path', 'expected_sierra_exe', 'state_file', 'expected_chartbook_path',
    'expected_strategy_module_path', 'expected_telemetry_module_path', 'source_preflight_status_path']) config[key] = path.join(root, `${key}.fixture`);
  for (const key of ['expected_chartbook_path', 'expected_strategy_module_path', 'expected_telemetry_module_path']) fs.writeFileSync(config[key], `software fixture ${key}`);
  config.expected_chartbook_sha256 = digest(fs.readFileSync(config.expected_chartbook_path));
  config.expected_strategy_module_sha256 = digest(fs.readFileSync(config.expected_strategy_module_path));
  config.expected_telemetry_module_sha256 = digest('different approved software fixture bytes');
  const instance = { execution_instance_id: config.instance_id };
  db.exec('CREATE TABLE ow_instances(id TEXT PRIMARY KEY,payload_json TEXT); CREATE TABLE ow_run_settings(id TEXT PRIMARY KEY,payload_json TEXT);');
  db.prepare('INSERT INTO ow_instances VALUES(?,?)').run(config.instance_id, JSON.stringify(instance));
  const configFile = path.join(root, 'bridge.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const backend = { environment: {}, db, config: { db_file: config.workflow_db, operational_factual_bindings: [{
    binding_hash: config.factual_binding_hash, strategy_id: config.strategy_id, instance }] },
    runs: { perform() { assert.fail('must not register settings after a telemetry pin mismatch'); } },
    handle() {}, close() { assert.fail('recognized mismatch must preserve read availability'); } };
  assert.equal(initializeAvailableWorkflow({ environment: { OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE: configFile },
    createBackend: () => backend, reconcile: reconcileOperationalReplayRunSettings }), backend);
  assert.equal(backend.workflowAvailability.physical_readiness.blocker.code, code);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ow_run_settings').get().n, 0);
});

test('real authenticated backend stays readable and reports the latched exact physical blocker without private details', async t => {
  const f = await fixture(t);
  assert.equal(f.backend instanceof WorkflowBackend, true);
  assert.equal(f.backend.operationalLearning.timer, null); assert.equal(f.backend.operationalCandidateEvaluator.timer, null);
  assert.equal(f.backend.onboardingBrain.timer, null); assert.equal(f.backend.operationalResearch.stopped, true);
  assert.equal(f.backend.environment.OCEAN_PAPERCLIP_INTERACTION_CONFIG, undefined);
  const readiness = await f.request('readiness'); assert.equal(readiness.status, 200);
  assert.equal(readiness.value.workflow.state, 'DEGRADED_READ_ONLY');
  assert.equal(readiness.value.workflow.read_only, true); assert.equal(readiness.value.workflow.mutations_enabled, false);
  assert.equal(readiness.value.workflow.physical_readiness.blocker.code, code);
  assert.equal(readiness.value.workflow.physical_readiness.latched, true);
  assert.equal(readiness.value.execution, 'READ_ONLY'); assert.equal(readiness.value.workflow.schema_version, 14);
  assert.ok(!JSON.stringify(readiness.value).includes('private exception'));
  for (const route of ['session', 'view/dashboard', 'view/strategies/page/0', 'view/strategies/test-alpha', 'view/strategies/test-beta', 'view/strategies/cicd-vwap-pull-back-strategy']) {
    const response = await f.request(route); assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.value)}`);
    assert.equal(response.value.workflow_availability.physical_readiness.blocker.code, code);
    if (route === 'view/strategies/page/0') assert.equal(response.value.items.length, 3);
  }
  assert.equal((await f.request('view/strategies/page/0', { anonymous: true })).status, 401);
  assert.equal((await f.request('view/strategies/page/0', { service: true })).status, 403);
});

test('every mutation family and unapproved GET is blocked before executing; auth and query checks remain enforced', async t => {
  const f = await fixture(t), before = f.backend.db.prepare('SELECT COUNT(*) AS n FROM ow_events').get().n;
  for (const route of ['run-manager/prepare', 'run-manager/claim', 'run-manager/event', 'operational/v1/run/start', 'operational/v1/candidate/dispatch', 'operational/v1/adopt', 'onboarding/activate', 'profiles']) {
    const response = await f.request(route, { method: 'POST', data: {} });
    assert.equal(response.status, 503, route); assert.equal(response.value.error.code, code);
  }
  for (const route of ['actions/start', 'interactions', 'run-manager/options', 'view/approvals/page/0']) {
    const response = await f.request(route); assert.equal(response.status, 503); assert.equal(response.value.error.code, code);
  }
  assert.equal(f.backend.db.prepare('SELECT COUNT(*) AS n FROM ow_events').get().n, before);
  assert.equal((await f.request('profiles', { method: 'POST', data: {}, anonymous: true })).status, 401);
  assert.equal((await f.request('profiles', { method: 'POST', data: {}, csrf: 'bad-csrf' })).status, 403);
  const unsafe = await f.request('session?path=private'); assert.equal(unsafe.status, 400); assert.equal(unsafe.value.error.code, 'UNSAFE_ROUTE_OR_QUERY');
});

test('normal READY startup keeps the original handler and real validated mutation behavior', async t => {
  const f = await fixture(t, { degraded: false });
  assert.equal(f.backend.workflowAvailability, undefined);
  const readiness = await f.request('readiness'); assert.equal(readiness.value.workflow.state, 'READY');
  assert.equal(readiness.value.workflow.read_only, undefined);
  const profile = { ...examples['strategy-profile'], strategy_id: 'test-ready-strategy', profile_id: 'test-ready-profile' };
  profile.profile_hash = sealedHash(profile, 'profile_hash');
  const result = await f.request('profiles', { method: 'POST', data: { message_id: 'test-ready-write', data: { profile, file_sha256: digest(JSON.stringify(profile)) } } });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.ok(f.backend.db.prepare('SELECT id FROM ow_profiles WHERE id=?').get(`${profile.profile_id}:${profile.profile_version}`));
});

test('real HTTP source-projection failures retain the old sanitized 500 and public WorkflowError contracts', async t => {
  const f = await fixture(t, { degraded: false }), sourceRoot = f.backend.config.strategy_onboarding_root;
  fs.writeFileSync(path.join(sourceRoot, 'unresolved-items.json'), JSON.stringify({ strategy_id: 'cicd-vwap-pull-back-strategy',
    items: {}, private: `DO_NOT_PROJECT ${sourceRoot}` }));
  // Run the existing pure reader directly under the real handler as the old
  // synchronous HTTP path did, then compare the fixed-worker transport path.
  f.backend.onboardingProjectionReader = { async read(kind, options) {
    if (kind === 'identity') return readOnboardingStrategyId(options.root);
    return { projection: loadStrategyOnboarding({ ...options, runtimeProbe: f.backend.config.strategy_onboarding_runtime_probe }) };
  }, close() {} };
  const originalError = console.error; console.error = () => {};
  try {
    const previous = await f.request('view/strategies/page/0');
    f.backend.onboardingProjectionReader = undefined;
    const current = await f.request('view/strategies/page/0');
    assert.equal(previous.status, 500); assert.deepEqual(current, previous);
    assert.deepEqual(current.value.error, { code: 'WORKFLOW_INTERNAL_ERROR', message: 'Workflow operation failed', retryable: false });
    assert.ok(!JSON.stringify(current).includes(sourceRoot)); assert.ok(!JSON.stringify(current).includes('DO_NOT_PROJECT'));
    fs.writeFileSync(path.join(sourceRoot, 'unresolved-items.json'), JSON.stringify({ strategy_id: 'cicd-vwap-pull-back-strategy', items: [] }));
    f.backend.config.strategy_onboarding_runtime_probe = () => { throw new WorkflowError(409, 'ONBOARDING_SOURCE_CHANGED', 'Source changed before projection finished'); };
    const publicError = await f.request('view/strategies/page/0');
    assert.equal(publicError.status, 409); assert.deepEqual(publicError.value.error, {
      code: 'ONBOARDING_SOURCE_CHANGED', message: 'Source changed before projection finished', retryable: false });
  } finally { console.error = originalError; }
});

test('disposable browser displays the exact blocker and preserves authenticated report downloads', { timeout: 30000 }, async t => {
  const f = await fixture(t), browser = await chromium.launch({ ...(process.env.OCEAN_BROWSER_TEST_EXECUTABLE
    ? { executablePath: process.env.OCEAN_BROWSER_TEST_EXECUTABLE } : { channel: 'chrome' }), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${f.base}/improvement/strategies/cicd-vwap-pull-back-strategy`);
  await expect(page.getByRole('heading', { name: 'Workflow is read only', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: code })).toBeVisible();
  await expect(page.locator('#content')).toContainText('Starts, dispatch, adoption and workflow changes are blocked');
  assert.deepEqual(await page.evaluate(async () => {
    const { workflowReadTimeoutMs } = await import(document.querySelector('script[type="module"]').src);
    return ['view/strategies/page/0', 'view/strategies/cicd-vwap-pull-back-strategy', 'view/dashboard', 'session', 'readiness']
      .map(path => workflowReadTimeoutMs(path));
  }), [25000, 25000, 12000, 12000, 12000]);
  const deadlines = await page.evaluate(async () => {
    const { request } = await import(document.querySelector('script[type="module"]').src);
    const { fetchVwapImprovementStatus } = await import('/workflow/vwap-improvement-view.js');
    const oldFetch = window.fetch, oldSetTimeout = window.setTimeout, scheduled = [], observed = [];
    window.setTimeout = (callback, delay, ...args) => {
      if ([12000, 25000].includes(delay)) { scheduled.push(delay); return oldSetTimeout(callback, 15, ...args); }
      return oldSetTimeout(callback, delay, ...args);
    };
    window.fetch = (_url, options) => new Promise((_resolve, reject) => {
      observed.push(options.signal);
      const rejectAbort = () => reject(new DOMException('Software deadline fixture', 'AbortError'));
      if (options.signal.aborted) rejectAbort(); else options.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const navigation = new AbortController(), failures = [];
    try {
      for (const path of ['session', 'view/dashboard', 'view/strategies/page/0']) {
        try { await request(path, { signal: navigation.signal }); } catch (error) { failures.push(error.code); }
      }
      try { await fetchVwapImprovementStatus({ signal: navigation.signal }); } catch (error) { failures.push(error.name); }
      return { scheduled, failures, allInnerAborted: observed.every(signal => signal.aborted && signal !== navigation.signal), navigationAborted: navigation.signal.aborted };
    } finally { window.fetch = oldFetch; window.setTimeout = oldSetTimeout; }
  });
  assert.deepEqual(deadlines, { scheduled: [12000, 12000, 25000, 12000],
    failures: ['WORKFLOW_REQUEST_TIMEOUT', 'WORKFLOW_REQUEST_TIMEOUT', 'WORKFLOW_REQUEST_TIMEOUT', 'AbortError'],
    allInnerAborted: true, navigationAborted: false });
  assert.equal(await page.locator('#content [data-action]:not([disabled]):not([data-action^="download-"]):not([data-action^="copy-"])').count(), 0);
  const route = `/api/workflow/vwap-improvement-monitor/reports/cohort?publication_sha256=${f.reports.config.publication_sha256}`;
  const download = await page.request.get(f.base + route); assert.equal(download.status(), 200);
  assert.deepEqual(await download.body(), fs.readFileSync(path.join(f.reports.root, 'cohort.json')));
  const denied = await page.request.post(`${f.base}/api/workflow/run-manager/prepare`, { headers: { Origin: f.base, 'X-CSRF-Token': await page.evaluate(() => sessionStorage.getItem('ocean-workflow-human-csrf')) }, data: {} });
  assert.equal(denied.status(), 503); assert.equal((await denied.json()).error.code, code);
  assert.deepEqual(errors, []);
});
