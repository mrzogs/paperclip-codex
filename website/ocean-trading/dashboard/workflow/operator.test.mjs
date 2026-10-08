import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareOperation, commitOperation, verifyState } from './operator.mjs';
import { WorkflowBackend, workflowFromEnvironment } from './backend.mjs';
import { objectHash, digest } from './common.mjs';
import { WorkflowStore } from './store.mjs';
import { protectedOperatorHost } from './maintenance.mjs';

const wrapper = fileURLToPath(new URL('../../../../scripts/ocean-workflow-operator.ps1',import.meta.url));
function closeServer(server) {
  if(!server.listening)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Isolated HTTP fixture close timed out')),5000);
    server.close(error=>{clearTimeout(timer);error?reject(error):resolve();});
    server.closeAllConnections();
  });
}
async function cleanup(root,closers,primary) {
  const errors=[];
  for(const close of closers)try {await close();}catch(error){errors.push(error);}
  if(!errors.length)try {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)
      && path.basename(root).startsWith('ocean-s231-'),'Private isolated fixture root required');
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'Isolated operator cleanup failed; primary failure and fixture retained');
}

test('S23.1 isolated real software: pending start, password, lifecycle, fault recovery, receipt lineage and auth denials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s231-'));
  const operator_id = 'S-1-5-21-1000';
  const password = `isolated-${randomUUID()}`;
  let state;
  const op = (action, args = {}) => {
    const plan = prepareOperation({ action, state, operator_id, root, ...args });
    commitOperation(plan); state = plan.next; return plan;
  };
  let backend,primary;
  const server = http.createServer((req,res) => backend.handle(req,res,new URL(req.url, `http://${req.headers.host}`)));
  let base;
  const load = (config=state.config,environment=state.environment) => {
    backend?.close();backend=null;
    backend = new WorkflowBackend({ ...config, allowed_origins:[base] },environment);
  };
  const call = async (route, headers = {}, body) => {
    const result = await fetch(`${base}/api/workflow/${route}`, { method:body === undefined ? 'GET':'POST', headers:{...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers}, body:body === undefined ? undefined : JSON.stringify(body) });
    return { status:result.status, headers:result.headers, value:await result.json() };
  };
  try {
    const first = op('initialize', { password });
    assert.equal(verifyState(state).pending_services.length,3);
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    base = `http://127.0.0.1:${server.address().port}`;
    load();
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
    for (const [change,reason] of [
      [item=>{item.provider='BRAIN';},'INVALID_PROVIDER_IDENTITY'],
      [item=>{item.audience='Brain GENERAL';},'INVALID_OCEAN_AUDIENCE'],
      [item=>{item.scopes=['*'];},'WRONG_ACTION_SCOPE'],
      [item=>{item.credential_ref='OCEAN_UNRESOLVED_TOKEN';},'PROVIDER_CREDENTIAL_UNRESOLVED'],
    ]) {
      const invalid=structuredClone(state.config); change(invalid.identities[0]);
      load(invalid);
      const readiness=backend.auth.readiness();
      assert.equal(readiness.machine_readiness,'DEGRADED');
      assert.equal(readiness.bindings[0].state,'ERROR');assert.equal(readiness.bindings[0].reason,reason);
      assert.equal((await call('status',{Authorization:`Bearer ${state.environment.OCEAN_S231_PROBE_TOKEN}`})).status,401);
    }
    load(state.config,{});
    assert.equal(backend.auth.readiness().machine_readiness,'DEGRADED');
    assert.equal(backend.auth.readiness().human_readiness,'ERROR');
    assert.equal((await call('status',{Authorization:`Bearer ${state.environment.OCEAN_S231_PROBE_TOKEN}`})).status,401);
    load();
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
  } catch(error) {primary=error;throw error;}
  finally {await cleanup(root,[()=>closeServer(server),()=>backend?.close()],primary);}
});

test('S23.1 Windows protected bootstrap refuses redirected human secret entry without enrollment or mutation', {skip:process.platform!=='win32'}, async () => {
  const root = path.join(os.tmpdir(),`ocean-s231-${randomUUID()}`);
  const host=process.env.OCEAN_READONLY_PWSH || protectedOperatorHost;
  const run=(action,input='')=>spawnSync(host,['-NoProfile','-NonInteractive','-File',wrapper,'-Root',root,'-Action',action],
    {input,encoding:'utf8',stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:30000});
  const successful=result=>{assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  const snapshot=()=>Object.fromEntries(fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(item=>item.isFile())
    .map(item=>{const file=path.join(item.parentPath,item.name);return [path.relative(root,file),digest(fs.readFileSync(file))];}).sort());
  let writer,backend,primary;
  try {
    assert.ok(path.isAbsolute(host) && fs.existsSync(host),'Existing protected PowerShell host required');
    assert.ok(fs.existsSync(wrapper),'Archive must include repository-relative scripts/ocean-workflow-operator.ps1');
    assert.equal(successful(run('Bootstrap')).revision,1);
    writer=new WorkflowStore(path.join(root,'workflow.sqlite'));
    const beforeStatus=successful(run('Status')),before=snapshot();
    assert.equal(beforeStatus.browser.state,'UNENROLLED');assert.deepEqual(beforeStatus.identities,[]);
    const input=`isolated-rejected-secret-${randomUUID()}`,denied=run('Reset-Password',input+'\n');
    assert.ifError(denied.error);assert.equal(denied.status,1);
    assert.match(denied.stderr,/Human secret entry requires the genuine protected interactive operator prompt\./);
    assert.ok(!denied.stdout.includes(input) && !denied.stderr.includes(input));
    assert.deepEqual(snapshot(),before,'Denied prompt must not mutate protected files or database');
    assert.deepEqual(successful(run('Status')),beforeStatus);
    assert.equal(fs.existsSync(path.join(root,'operator-pending.dpapi')),false);
    backend = workflowFromEnvironment({OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:path.join(root,'operator-state.dpapi'),
      OCEAN_ONBOARDING_BRAIN_SYNC:'0',OCEAN_OPERATIONAL_LEARNING_ENABLED:'0'},'python');
    const readiness=backend.auth.readiness();
    assert.equal(readiness.local_readiness,'READY');assert.equal(readiness.human_readiness,'UNENROLLED');
    assert.equal(readiness.pending_bindings.length,3);assert.deepEqual(readiness.bindings,[]);
    assert.equal(backend.operationalLearning.enabled,false);assert.equal(backend.onboardingBrain.enabled,false);
  }
  catch(error){primary=error;throw error;}
  finally {await cleanup(root,[()=>backend?.close(),()=>writer?.close()],primary);}
});

test('S23.1 isolated cleanup releases HTTP/SQLite and retains the primary failure alongside cleanup errors', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s231-'));
  const plan=prepareOperation({action:'bootstrap',operator_id:'S-1-5-21-1000',root});commitOperation(plan);
  const backend=new WorkflowBackend(plan.next.config,plan.next.environment);
  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const primary=Error('EXPLICIT_ISOLATED_PRIMARY_FAILURE'),closeFailure=Error('EXPLICIT_MOCK_CLOSE_FAILURE');
  await assert.rejects(cleanup(root,[()=>closeServer(server),
    ()=>backend.close(),()=>{throw closeFailure;}],primary),error=>error instanceof AggregateError
      && error.errors.length===2 && error.errors[0]===primary && error.errors[1]===closeFailure);
  assert.equal(server.listening,false);
  assert.throws(()=>backend.db.prepare('SELECT 1'),/not open|closed/);
  assert.equal(fs.existsSync(root),true,'Resource-close failure must retain its own fixture');
  await cleanup(root,[],null);
  assert.equal(fs.existsSync(root),false);
});
