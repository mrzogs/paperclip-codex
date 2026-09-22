import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {prepareOperation,commitOperation,verifyState,prepareMaintenance,cancelPendingRenewal} from './operator.mjs';
import {WorkflowBackend} from './backend.mjs';
import {objectHash,digest} from './common.mjs';
import {orderedSetup,setupOperation} from './setup-operator.mjs';

const wrapper=path.resolve('scripts/ocean-workflow-operator.ps1');
test('S23.2 isolated real HTTP/SQLite: independent human/machine lifecycle, scopes, faults and recovery',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s232-'));
  const operator_id='S-1-5-21-1000';let state;let backend;
  const op=(action,args={})=>{const plan=prepareOperation({action,state,root,operator_id,...args});commitOperation(plan);state=plan.next;return plan;};
  op('bootstrap');const initial=structuredClone(state);
  assert.equal(verifyState(state).browser.state,'UNENROLLED');assert.deepEqual(state.environment,{});
  const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const load=(config=state.config,environment=state.environment)=>{backend?.close();backend=new WorkflowBackend({...config,allowed_origins:[base]},environment);};load();
  const call=async(route,headers={},body)=>{const response=await fetch(`${base}/api/workflow/${route}`,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,value:await response.json(),headers:response.headers};};
  const evidence=path.join(root,'owner-evidence.md');fs.writeFileSync(evidence,'S23.2 segregated software verification, no operational approval.');
  const request={identity_id:'test-s232-one',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_S232_ONE_TOKEN',strategy_ids:['test_s232_one'],instance_ids:['test-s232-one'],scopes:['read'],expires_at_utc:new Date(Date.now()+121000).toISOString(),owner:'Ocean S23.2 verification',evidence_path:evidence,evidence_sha256:digest(fs.readFileSync(evidence)).slice(7),verification_only:true,renewal_policy:{lifetime_seconds:120,renew_before_seconds:100,runner:'ocean-website-maintenance',destination:'dpapi-current-operator'}};
  try{
    assert.equal((await call('readiness')).value.human,'UNENROLLED');
    assert.equal((await call('status')).status,401);
    assert.equal((await call('session',{Origin:base},{credential:'not-a-real-password'})).status,401);
    op('enroll',{request});const revision=state.revision;op('enroll',{request});assert.equal(state.revision,revision);
    op('enroll',{request:{...request,identity_id:'test-s232-two',credential_ref:'OCEAN_S232_TWO_TOKEN',strategy_ids:['test_s232_two'],instance_ids:['test-s232-two']}});load();
    let token=state.environment.OCEAN_S232_ONE_TOKEN;const auth=()=>({Authorization:`Bearer ${token}`});
    assert.equal((await call('status',auth())).status,200);
    const probe={strategy_id:'test_s232_one',instance_id:'test-s232-one',action:'read'};
    assert.equal((await call('auth/probe',auth(),probe)).status,200);
    for(const change of [{strategy_id:'test_s232_two'},{instance_id:'test-s232-two'},{action:'approval.decide'}])assert.equal((await call('auth/probe',auth(),{...probe,...change})).status,403);
    for(const headers of [{...auth(),Origin:base},{...auth(),Cookie:'ocean_workflow_session=fake'},{...auth(),'X-Role':'HUMAN'},{...auth(),'X-Actor-Id':'wayne-ocean-ui'}])assert.equal((await call('status',headers)).status,403);
    assert.equal((await call('decisions',auth(),{message_id:'test-s232-deny',data:{}})).status,403);
    const broken=structuredClone(state.config);broken.browser={credential_ref:'BAD'};load(broken);
    assert.equal((await call('status',auth())).status,200);assert.equal((await call('readiness')).value.human,'ERROR');
    const badEnvironment={...state.environment,OCEAN_S232_TWO_TOKEN:'invalid'};load(state.config,badEnvironment);
    assert.equal((await call('status',auth())).status,200);assert.equal(backend.auth.readiness().bindings[1].state,'ERROR');load();
    const password=`isolated-${randomUUID()}`;op('initialize',{password});load();
    const login=await call('session',{Origin:base},{credential:password});assert.equal(login.status,200);
    assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    const human={Origin:base,Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':login.value.csrf_token};
    assert.equal((await call('session/logout',{...human,'X-CSRF-Token':'bad'},{})).status,403);
    assert.equal((await call('session',{Origin:'http://evil.invalid'},{credential:password})).status,403);
    const hostile=await new Promise(resolve=>{http.get(`${base}/api/workflow/status`,{headers:{...auth(),Host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode);});});assert.equal(hostile,403);
    op('reset-password',{password:`reset-${randomUUID()}`});
    assert.equal((await call('status',human)).status,401);assert.equal((await call('status',auth())).status,200);load();
    assert.equal((await call('session',{Origin:base},{credential:password})).status,401);
    const plan=prepareOperation({action:'rotate',state,root,operator_id,request});commitOperation(plan);
    assert.equal((await call('status',auth())).status,401);assert.throws(()=>verifyState(state),/OPERATOR_RESUME_REQUIRED/);
    assert.equal(commitOperation(plan).idempotent,true);state=plan.next;load();token=state.environment.OCEAN_S232_ONE_TOKEN;
    assert.equal((await call('status',auth())).status,200);assert.throws(()=>commitOperation({...plan,next:initial,next_hash:objectHash(initial)}),/STALE_OPERATOR_TRANSACTION/);
    op('rotate',{request:{...request,expires_at_utc:new Date(Date.now()+50000).toISOString()}});
    const before=state.config.identities[0];const renewed=prepareMaintenance({state,root,operator_id});assert.ok(renewed.next);commitOperation(renewed);state=renewed.next;load();
    assert.equal(state.config.identities[0].credential_version,before.credential_version+1);assert.deepEqual(state.config.identities[0].scopes,before.scopes);
    assert.equal((await call('status',auth())).status,401);token=state.environment.OCEAN_S232_ONE_TOKEN;assert.equal((await call('status',auth())).status,200);
    const proofFile=path.join(root,'isolated-consumer-proof.json');
    const identity=state.config.identities[0];
    fs.writeFileSync(proofFile,JSON.stringify({schema_version:'ocean-consumer-verification/v1',identity_id:identity.identity_id,audience:identity.audience,credential_hash:identity.credential_hash,strategy_ids:identity.strategy_ids,instance_ids:identity.instance_ids,scopes:identity.scopes,tests:['allowed','missing','invalid','wrong_strategy','wrong_instance','wrong_action','forged_human','expired_or_revoked'].map(name=>({name,status:'PASS',test_type:'ACTUAL_CONSUMER_TO_OCEAN'}))}));
    op('verify',{request:{...request,evidence_path:proofFile,evidence_sha256:digest(fs.readFileSync(proofFile)).slice(7)}});load();assert.equal(state.config.identities[0].verification_state,'VERIFIED');
    const capacity=structuredClone(state);capacity.config.identities=Array(64).fill(identity);
    assert.throws(()=>prepareOperation({action:'enroll',state:capacity,root,operator_id,request:{...request,identity_id:'test-s232-capacity'}}),/IDENTITY_REGISTRY_CAPACITY_REACHED/);
    op('revoke',{request});assert.equal((await call('status',auth())).status,401);load();
    assert.ok(prepareMaintenance({state,root,operator_id}).no_change);
    assert.throws(()=>op('rotate',{request}),/IDENTITY_LIFECYCLE_CONFLICT/);
    const requestTwo={...request,identity_id:'test-s232-two',credential_ref:'OCEAN_S232_TWO_TOKEN',strategy_ids:['test_s232_two'],instance_ids:['test-s232-two']};
    op('rotate',{request:{...requestTwo,expires_at_utc:new Date(Date.now()+50000).toISOString()}});
    const interrupted=prepareMaintenance({state,root,operator_id});
    commitOperation(interrupted);
    const cancelled=cancelPendingRenewal({state,pending:interrupted,request:requestTwo,operator_id,root});
    commitOperation(cancelled);state=cancelled.next;load();
    assert.equal((await call('status',{Authorization:`Bearer ${interrupted.next.environment.OCEAN_S232_TWO_TOKEN}`})).status,401);
    assert.throws(()=>commitOperation(interrupted),/STALE_OPERATOR_TRANSACTION/);
    const snapshots=fs.readdirSync(path.join(root,'backups'));assert.ok(snapshots.length);
    for(const file of snapshots){const db=new DatabaseSync(path.join(root,'backups',file),{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();}
    assert.throws(()=>backend.db.exec("UPDATE ow_auth_audit SET action='tampered'"),/immutable/);
    const order=orderedSetup(['S24','S23.2','S23','S23.1','S09-R1'].map(task_id=>({payload_json:JSON.stringify({task_id})}))).map(row=>JSON.parse(row.payload_json).task_id);
    assert.deepEqual(order,['S09-R1','S23','S23.1','S23.2','S24']);
  }finally{await new Promise(resolve=>server.close(resolve));backend?.close();assert.ok(root.startsWith(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});

test('S23.2 isolated protected receipt import and actual browser history projection',async()=>{
  const {chromium}=await import('@playwright/test');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s232-history-'));
  const operator_id='S-1-5-21-1000';const password=`isolated-${randomUUID()}`;
  const initial=prepareOperation({action:'bootstrap',root,operator_id});commitOperation(initial);
  const plan=prepareOperation({action:'initialize',state:initial.next,root,operator_id,password});commitOperation(plan);
  const state=plan.next;let backend;let browser;
  const publicRoot=path.resolve('website/ocean-trading/dashboard/public/workflow');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(url.pathname.startsWith('/api/workflow/')){void backend.handle(req,res,url);return;}
    if(url.pathname==='/assets/ocean-trading-icon.png'){res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(path.join(publicRoot,'../assets/ocean-trading-icon.png')));return;}
    const file=url.pathname.startsWith('/workflow/')?url.pathname.slice('/workflow/'.length):'index.html';
    if(!['index.html','ui.js','ui.css','icons.js','run-wizard.js'].includes(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(publicRoot,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  backend=new WorkflowBackend({...state.config,allowed_origins:[base]},state.environment);
  const fixture=(task_id,extra={})=>{
    const result=spawnSync(state.config.python_executable,['tests/website/s232-receipt-fixture.py'],{input:JSON.stringify({root,map:path.resolve('website/ocean-trading/dashboard/workflow/setup-task-map.json'),task_id,...extra}),encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0);return JSON.parse(result.stdout);
  };
  const operation=(action,request)=>setupOperation({state,operator_id,action,request});
  try{
    for(const task_id of ['S23.2','S23.1','S23','S09-R1']){
      const request=fixture(task_id,{status:task_id==='S23.2'?'PASS':'BLOCKED'});
      assert.equal(operation('setup-import',request).idempotent,false);
      assert.equal(operation('setup-import',request).idempotent,true);
    }
    assert.throws(()=>operation('setup-import',fixture('S23.2',{variant:1})),/SETUP_RECEIPT_CONFLICT/);
    assert.throws(()=>operation('setup-import',fixture('S23.2',{owner:'Wrong owner'})),/SETUP_BUNDLE_REJECTED/);
    const invalid=fixture('S23.2');invalid.bundle_sha256='0'.repeat(64);assert.throws(()=>operation('setup-import',invalid),/SETUP_BUNDLE_REJECTED/);
    const exported=operation('setup-export');assert.deepEqual(exported.items.map(row=>row.id),['S09-R1','S23','S23.1','S23.2']);
    assert.deepEqual(operation('setup-read'),exported);
    assert.equal(backend.db.prepare('SELECT COUNT(*) AS n FROM ow_decisions').get().n,0);
    assert.deepEqual(backend.db.prepare("SELECT DISTINCT operator_id FROM ow_auth_audit WHERE action='setup-import'").all().map(row=>row.operator_id),[operator_id]);
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(`${base}/improvement/history`);await page.locator('#credential').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('#setup-history summary').click();await page.getByText('Historical installation records. Not strategy approvals.',{exact:true}).waitFor();
    assert.deepEqual(await page.locator('#setup-history tbody tr td:first-child').allTextContents(),['S09-R1','S23','S23.1','S23.2']);
    if(process.env.OCEAN_S232_EVIDENCE)await page.screenshot({path:path.join(process.env.OCEAN_S232_EVIDENCE,'isolated-history.png'),fullPage:true});
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));backend.close();assert.ok(root.startsWith(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});

test('S23.2 Windows non-interactive DPAPI bootstrap is idempotent and local human setup needs no redirected stdin',()=>{
  const root=path.join(os.tmpdir(),`ocean-s232-${randomUUID()}`);
  const call=(action,args=[])=>spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,'-Root',root,'-Action',action,...args],{input:'',encoding:'utf8',windowsHide:true,timeout:30000});
  try{
    assert.equal(call('Bootstrap').status,0);
    const first=fs.readFileSync(path.join(root,'operator-state.dpapi'));assert.equal(call('Bootstrap').status,0);assert.deepEqual(fs.readFileSync(path.join(root,'operator-state.dpapi')),first);
    const status=call('Status');assert.equal(status.status,0);assert.equal(JSON.parse(status.stdout).browser.state,'UNENROLLED');
    assert.equal(call('Maintenance').status,0);assert.equal(call('Initialize').status,0);
    assert.equal(JSON.parse(call('Status').stdout).browser.state,'CONFIGURED');
    assert.ok(!status.stdout.includes('ocean_password_v1.'));
    const proof=path.join(root,'isolated-owner.md');fs.writeFileSync(proof,'S23.2 isolated owner fixture');
    const requestFile=path.join(root,'request.json');fs.writeFileSync(requestFile,JSON.stringify({identity_id:'test-s232-native',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_S232_NATIVE_TOKEN',strategy_ids:['test_s232_native'],instance_ids:['test-s232-native'],scopes:['read'],expires_at_utc:new Date(Date.now()+300000).toISOString(),owner:'S23.2 isolated native test',evidence_path:proof,evidence_sha256:digest(fs.readFileSync(proof)).slice(7),verification_only:true}));
    for(const action of ['Enroll','Enroll','Rotate','Revoke'])assert.equal(call(action,['-RequestFile',requestFile]).status,0,action);
    assert.equal(JSON.parse(call('Status').stdout).identities[0].state,'REVOKED');
  }finally{if(fs.existsSync(root)){assert.ok(root.startsWith(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}}
});
