import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enqueueOnboardingBrain, OnboardingBrainSync, readOnboardingBrainOutbox, retryOnboardingBrain } from './onboarding-brain-sync.mjs';
import { WorkflowStore } from './store.mjs';

function fixture(fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-brain-sync-'));
  const tokenFile = path.join(root, 'project.token');
  fs.writeFileSync(tokenFile, 'project-test-token-value-not-exported');
  const store = new WorkflowStore(path.join(root, 'workflow.sqlite'));
  const backend = {
    db: store.db,
    store,
    event(entity, action, actor, payload) {
      const created = new Date().toISOString();
      const event = { entity_id:entity, action, actor_id:actor.id, actor_role:actor.role, created_at_utc:created, payload };
      store.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)').run(entity,action,actor.id,actor.role,created,JSON.stringify(event));
    },
  };
  const worker = new OnboardingBrainSync(backend, { enabled:true, api:'http://brain.test', token_file:tokenFile, fetch:fetchImpl, interval_ms:60_000 });
  return { root, store, backend, worker };
}

const response = (status, body) => ({ ok:status >= 200 && status < 300, status, async json() { return body; } });

test('delivers one project-scoped milestone and confirms exact marker readback', async () => {
  let saved = null;
  const calls = [];
  const setup = fixture(async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ pathname, method:options?.method || 'GET', authorization:options?.headers?.Authorization || null });
    if (pathname === '/auth/me') return response(200, { client:{ scope:'PROJECT', project:'ocean-trading-website', domain:'software' } });
    if (pathname === '/search') return response(200, { results:[] });
    if (pathname === '/reasoning') {
      saved = { id:'reasoning-test-ocean-sync', relative_path:'reasoning/reasoning-test-ocean-sync.md', content:`${body.title}\n${body.conclusion}` };
      return response(200, { id:saved.id, relative_path:saved.relative_path });
    }
    if (pathname === '/reasoning/reasoning-test-ocean-sync') return response(200, {
      relative_path:saved.relative_path,
      record:{ ...saved, relative_path:path.basename(saved.relative_path) },
    });
    return response(404, {});
  });
  try {
    setup.store.transaction(() => enqueueOnboardingBrain(setup.backend, {
      strategy_id:'cicd-vwap-pull-back-strategy', milestone_type:'QUESTIONNAIRE', milestone_id:'test-brain-milestone-1',
      title:'Test onboarding decision', summary:'A checked onboarding decision was recorded.', conclusion:'No execution authority was granted.',
      source_fingerprint:`sha256:${'1'.repeat(64)}`, receipt_hash:`sha256:${'2'.repeat(64)}`,
    }));
    const status = await setup.worker.flushOnce();
    const row = readOnboardingBrainOutbox(setup.store.db)[0];
    assert.equal(status.state, 'READY');
    assert.equal(row.state, 'ACKNOWLEDGED');
    assert.equal(row.brain_record_id, 'reasoning-test-ocean-sync');
    assert.match(saved.content, /ocean-onboarding-milestone:test-brain-milestone-1:sha256:/);
    assert.ok(calls.every(call => call.authorization === 'Bearer project-test-token-value-not-exported'));
    assert.deepEqual(calls.map(call => call.pathname), ['/auth/me','/search','/reasoning','/reasoning/reasoning-test-ocean-sync']);
  } finally {
    setup.store.close();
    fs.rmSync(setup.root, { recursive:true, force:true });
  }
});

test('fails closed, records retry state, and supports an explicit human retry', async () => {
  const setup = fixture(async url => new URL(url).pathname === '/auth/me'
    ? response(200, { client:{ scope:'PROJECT', project:'ocean-trading-website', domain:'software' } })
    : response(503, { error:'unavailable' }));
  try {
    setup.store.transaction(() => enqueueOnboardingBrain(setup.backend, {
      strategy_id:'cicd-vwap-pull-back-strategy', milestone_type:'REGISTRATION', milestone_id:'test-brain-milestone-2',
      title:'Test registration', summary:'A registration package was recorded.', conclusion:'The package remains non-executing.',
      source_fingerprint:`sha256:${'3'.repeat(64)}`, receipt_hash:`sha256:${'4'.repeat(64)}`,
    }));
    const degraded = await setup.worker.flushOnce();
    let row = readOnboardingBrainOutbox(setup.store.db)[0];
    assert.equal(degraded.state, 'DEGRADED');
    assert.equal(row.state, 'FAILED');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /ONBOARDING_BRAIN_HTTP_503/);
    const retried = setup.store.transaction(() => retryOnboardingBrain(setup.backend, { id:'wayne', role:'HUMAN' }, { outbox_id:row.id }));
    assert.equal(retried.state, 'PENDING');
    row = readOnboardingBrainOutbox(setup.store.db)[0];
    assert.equal(row.state, 'PENDING');
    assert.equal(row.attempts, 0);
  } finally {
    setup.store.close();
    fs.rmSync(setup.root, { recursive:true, force:true });
  }
});
