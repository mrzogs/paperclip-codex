import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { prepareOperation, commitOperation } from './operator.mjs';
import { setupOperation } from './setup-operator.mjs';
import { WorkflowBackend } from './backend.mjs';

const inputFile = process.env.OCEAN_S332_INPUTS;
assert.ok(inputFile && path.isAbsolute(inputFile), 'Verified S33.2 input map required');
const inputs = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const byTask = new Map(inputs.map(row => [row.task_id, row]));
const required = ['S23', 'S23.1', 'S23.2', 'S23.3', 'S24', 'S24.1', 'S25.1', 'S26.1', 'S26.2', 'S27.2', 'S28.2', 'S29.2', 'S31.2', 'S32.2'];
for (const task of required) {
  const row = byTask.get(task);
  assert.ok(row?.path && row?.sha256, `Verified ${task} bundle required`);
}

const operator_id = 'S-1-5-21-1000';
const request = task => ({ task_id: task, bundle_path: byTask.get(task).path, bundle_sha256: byTask.get(task).sha256 });

test('S33.2 isolated operator import and lifecycle dashboard projection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-s332-'));
  let backend;
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, `http://${req.headers.host}`)));
  try {
    const plan = prepareOperation({ action: 'initialize', operator_id, root });
    commitOperation(plan);
    const state = plan.next;
    state.config.python_executable = process.env.OCEAN_TRADING_PYTHON || 'python';

    for (const task of required) {
      const first = setupOperation({ state, operator_id, action: 'setup-import', request: request(task) });
      assert.equal(first.idempotent, false, `${task} initial import`);
      const second = setupOperation({ state, operator_id, action: 'setup-import', request: request(task) });
      assert.equal(second.idempotent, true, `${task} idempotent import`);
    }

    const exported = setupOperation({ state, operator_id, action: 'setup-export' });
    const receipts = exported.items.map(row => JSON.parse(row.payload_json));
    const status = task => receipts.find(row => row.task_id === task)?.status || receipts.find(row => row.task_id === task)?.final_status;
    assert.equal(status('S23'), 'BLOCKED');
    assert.equal(status('S23.1'), 'BLOCKED');
    assert.equal(status('S24'), 'BLOCKED');
    assert.equal(status('S26.1'), 'BLOCKED');
    assert.equal(status('S26.2'), 'PASS');
    assert.equal(status('S23.3'), 'PASS');
    assert.ok(receipts.find(row => row.task_id === 'S31.2')?.verified_members);

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    backend = new WorkflowBackend({ ...state.config, allowed_origins: [base] }, state.environment);

    const call = async (route, { method = 'GET', headers = {}, body } = {}) => {
      const response = await fetch(`${base}/api/workflow/${route}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, headers: response.headers, value: await response.json() };
    };

    const readiness = await call('readiness', { headers: { Origin: base } });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.value.human_acceptance_due, 'S33.2');
    assert.equal(readiness.value.human_auth_method, 'LOCAL_OPERATOR_ACCESS');
    assert.equal(readiness.value.execution, 'TEST_ONLY');
    assert.equal(readiness.value.ingestion, 'OFF');

    const wrong = await call('session', { method: 'POST', headers: { Origin: base }, body: { credential: 'not-local-access' } });
    assert.equal(wrong.status, 401);
    const login = await call('session', { method: 'POST', headers: { Origin: base }, body: { credential: '' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const human = { Origin: base, Cookie: cookie, 'X-CSRF-Token': login.value.csrf_token };
    const dashboard = await call('view/dashboard', { headers: human });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.value.human_acceptance_due, 'S33.2');
    assert.equal(dashboard.value.provider_binding.current_amended_provider.task_id, 'S23.3');
    assert.equal(dashboard.value.provider_binding.current_amended_provider.status, 'PASS');
    assert.equal(dashboard.value.provider_binding.immutable_machine_foundation.task_id, 'S23.2');
    assert.equal(dashboard.value.provider_binding.immutable_machine_foundation.status, 'PASS');
    assert.equal(dashboard.value.provider_binding.historical_diagnostics.find(row => row.task_id === 'S26.1').status, 'BLOCKED');
    assert.equal(dashboard.value.provider_binding.historical_diagnostics.find(row => row.task_id === 'S26.2').status, 'PASS');
    assert.equal(dashboard.value.provider_binding.historical_diagnostics.find(row => row.task_id === 'S31.2').status, 'PASS');
    assert.equal(dashboard.value.provider_binding.historical_diagnostics.find(row => row.task_id === 'S32.2').status, 'PASS');
    assert.equal(dashboard.value.operational_readiness.replay_enabled, false);
    assert.equal(dashboard.value.operational_readiness.paper_forward_enabled, false);
    assert.equal(dashboard.value.operational_readiness.live_real, 'DISABLED');
    assert.equal(dashboard.value.operational_readiness.normal_ingestion, 'OFF');
    assert.equal(dashboard.value.dispatch_worker, 'OFF');
    assert.equal(dashboard.value.brain_submission, 'OFF');
    assert.equal(dashboard.value.live_real, 'DISABLED');
    assert.equal(dashboard.value.provider_binding.persisted_receipts_total, required.length);

    const text = JSON.stringify(dashboard.value);
    assert.ok(!/ocean_(?:service|browser|password)_v1\./i.test(text));
  } finally {
    await new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    backend?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
