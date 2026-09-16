import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareOperation, commitOperation, verifyState } from './operator.mjs';
import { WorkflowBackend, workflowFromEnvironment } from './backend.mjs';
import { objectHash, digest } from './common.mjs';

test('S23.1 isolated real software: pending start, password, lifecycle, fault recovery, receipt lineage and auth denials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s231-'));
  const operator_id = 'S-1-5-21-1000';
  const password = `isolated-${randomUUID()}`;
  let state;
  const op = (action, args = {}) => {
    const plan = prepareOperation({ action, state, operator_id, root, ...args });
    commitOperation(plan); state = plan.next; return plan;
  };
  const first = op('initialize', { password });
  assert.equal(verifyState(state).pending_services.length,3);
  let backend;
  const server = http.createServer((req,res) => backend.handle(req,res,new URL(req.url, `http://${req.headers.host}`)));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const load = () => { backend?.close(); backend = new WorkflowBackend({ ...state.config, allowed_origins:[base] },state.environment); };
  load();
  const call = async (route, headers = {}, body) => {
    const result = await fetch(`${base}/api/workflow/${route}`, { method:body === undefined ? 'GET':'POST', headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers}, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:result.status, headers:result.headers, value:await result.json() };
  };
  try {
    assert.equal((await call('status')).status,401);
    assert.equal((await call('status',{Authorization:'Bearer ocean_service_v1.unissued.invalid'})).status,401);
    assert.equal((await call('session',{Origin:'http://evil.invalid'},{credential:password})).status,403);
    assert.equal((await call('session',{Origin:base,'X-Role':'HUMAN'},{credential:password})).status,403);
    const login = await call('session',{Origin:base},{credential:password}); assert.equal(login.status,200);
    const human = {Origin:base,Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':login.value.csrf_token};
    assert.equal((await call('status',human)).value.local_readiness,'READY');
    assert.equal((await call('session/logout',{...human,'X-CSRF-Token':''},{})).status,403);
    const badHostStatus = await new Promise((resolve,reject) => { const req = http.get(`${base}/api/workflow/status`,{headers:{...human,Host:'evil.invalid'}},res => { res.resume(); resolve(res.statusCode); }); req.on('error',reject); });
    assert.equal(badHostStatus,403);
    for (const task_id of ['S23','S23.1','S09-R1','S22']) {
      const receipt = {task_id,status:task_id === 'S23'?'BLOCKED':'PASS'};
      const body = {message_id:`test-s231-${task_id}`,data:{receipt_id:`test-s231-${task_id}`,receipt,content_hash:objectHash(receipt)}};
      assert.equal((await call('setup-receipts',human,body)).status,200);
      assert.equal((await call('setup-receipts',human,body)).status,200);
      assert.equal((await call('setup-receipts',human,{...body,data:{...body.data,receipt:{...receipt,status:'CHANGED'}}})).status,409);
    }
    const history = (await call('setup-receipts',human)).value.items;
    assert.deepEqual(history.map(row=>JSON.parse(row.payload_json).task_id),['S23','S23.1','S09-R1','S22']);
    assert.equal(JSON.parse(history[0].payload_json).status,'BLOCKED');
    const evidence = path.join(root,'owner-evidence.txt'); fs.writeFileSync(evidence,'S23.1 explicitly segregated TEST verification only. No real strategy authority.');
    const request = {identity_id:'test-s231-probe',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_S231_PROBE_TOKEN',strategy_ids:['test_s231_probe'],instance_ids:['test-s231-probe'],scopes:['read'],expires_at_utc:new Date(Date.now()+3600_000).toISOString(),owner:'Ocean S23.1 verification',evidence_path:evidence,evidence_sha256:digest(fs.readFileSync(evidence)).slice(7),verification_only:true};
    op('enroll',{request}); load();
    for (const change of [item=>{item.provider='BRAIN';},item=>{item.audience='Brain GENERAL';},item=>{item.scopes=['*'];},item=>{item.credential_ref='OCEAN_UNRESOLVED_TOKEN';}]) {
      const invalid=structuredClone(state.config); change(invalid.identities[0]);
      assert.throws(()=>new WorkflowBackend(invalid,state.environment));
    }
    assert.throws(()=>new WorkflowBackend(state.config,{}),/PROVIDER_CREDENTIAL_UNRESOLVED/);
    const token = state.environment.OCEAN_S231_PROBE_TOKEN;
    assert.equal((await call('status',{Authorization:`Bearer ${token}`})).status,200);
    assert.equal((await call('decisions',{Authorization:`Bearer ${token}`},{message_id:'test-s231-denied',data:{}})).status,403);
    assert.equal((await call('status',{Authorization:`Bearer ${token}`,Origin:base})).status,403);
    assert.equal((await call('status',{Authorization:`Bearer ${token}`,'X-Actor-Id':'wayne-ocean-ui'})).status,403);
    assert.throws(()=>prepareOperation({action:'rotate',state,root,operator_id,request:{...request,scopes:['read','health.write']}}),/SEGREGATED_VERIFICATION_SCOPE_REQUIRED|IDENTITY_OR_SCOPE_CHANGE_REJECTED/);
    const rotate = op('rotate',{request});
    assert.equal((await call('status',{Authorization:`Bearer ${token}`})).status,401);
    assert.throws(()=>verifyState(first.next),/OPERATOR_RESUME_REQUIRED/);
    assert.equal(commitOperation(rotate).idempotent,true);
    load(); assert.equal((await call('status',{Authorization:`Bearer ${state.environment.OCEAN_S231_PROBE_TOKEN}`})).status,200);
    op('revoke',{request}); load();
    assert.equal((await call('status',{Authorization:`Bearer ${state.environment.OCEAN_S231_PROBE_TOKEN}`})).status,401);
    assert.throws(()=>commitOperation(first),/STALE_OPERATOR_TRANSACTION/);
    const reset = op('reset-password',{password:`new-isolated-${randomUUID()}`});
    assert.equal((await call('status',human)).status,401);
    load(); assert.equal((await call('session',{Origin:base},{credential:password})).status,401);
    assert.equal(verifyState(reset.next).audit_events,5);
    assert.throws(()=>backend.db.exec("UPDATE ow_auth_audit SET action='tampered'"),/immutable/);
  } finally { await new Promise(resolve => server.close(resolve)); backend.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

test('S23.1 Windows DPAPI/ACL operator initialization and recovery (isolated fixture, not Wayne)', () => {
  const root = path.join(os.tmpdir(),`ocean-s231-${randomUUID()}`);
  const result = spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','D:\\Paperclip-codex\\tests\\website\\s231-protected-operator-test.ps1','-Root',root],{encoding:'utf8',windowsHide:true,timeout:30000});
  try {
    assert.equal(result.status,0,result.stderr); assert.match(result.stdout, /"revision":\s*2/); assert.ok(!result.stdout.includes('ocean_password_v1'));
    const backend = workflowFromEnvironment({OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:path.join(root,'operator-state.dpapi')},'python');
    try { assert.equal(backend.auth.readiness().local_readiness,'READY'); assert.equal(backend.auth.readiness().pending_bindings.length,3); }
    finally { backend.close(); }
  }
  finally { if(fs.existsSync(root)) fs.rmSync(root,{recursive:true,force:true}); }
});
