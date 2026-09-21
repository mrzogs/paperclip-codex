import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WorkflowStore} from './store.mjs';
import {WorkflowBackend} from './backend.mjs';
import {prepareOperation,commitOperation,prepareMaintenance} from './operator.mjs';
import {objectHash,digest} from './common.mjs';
import {identityProbePath} from './provider-lifecycle.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const wrapper=path.resolve(here,'../../../../scripts/ocean-workflow-operator.ps1');
const core=process.env.OCEAN_READONLY_PWSH;
assert.ok(core&&path.isAbsolute(core),'Explicit trusted Core host required');
const native='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const python='C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const run=(exe,args,input='')=>new Promise((resolve,reject)=>{
  assert.ok(!args.some(v=>/^-ExecutionPolicy$/i.test(v)),'No policy override');
  const p=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>{p.kill();reject(Error('Isolated command exceeded 90 seconds'));},90000);
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});p.stdin.end(input);
});
const safe=result=>{assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout);};
const call=(root,action,args=[])=>run(core,['-NoProfile','-NonInteractive','-File',wrapper,'-Root',root,'-Action',action,...args]);
const seal=(root,name,value)=>run(core,['-NoProfile','-NonInteractive','-File',path.join(here,'native-fixture-state.ps1'),'-Action','Write','-File',path.join(root,name)],JSON.stringify(value));
const capturedFixture=(root,name)=>run(core,['-NoProfile','-NonInteractive','-File',path.join(here,'native-fixture-state.ps1'),'-Action','Read','-File',path.join(root,name)]);
async function fixture(){
  const root=path.join(os.tmpdir(),`ocean-s302-mutation-${randomUUID()}`);
  safe(await call(root,'Bootstrap'));
  const writer=new WorkflowStore(path.join(root,'workflow.sqlite'));
  const state=()=>call(root,'Runtime').then(safe);
  const owner=path.join(root,'owner.md');fs.writeFileSync(owner,'PRIVATE ISOLATED SOFTWARE FIXTURE. NOT OPERATIONAL AUTHORITY.');
  const request={identity_id:'test-mutation-caller',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_MUTATION_FIXTURE_TOKEN',strategy_ids:['isolated_strategy'],instance_ids:['test-mutation-instance'],scopes:['read'],expires_at_utc:new Date(Date.now()+3600000).toISOString(),owner:'Isolated host certification',evidence_path:owner,evidence_sha256:digest(fs.readFileSync(owner)).slice(7),renewal_policy:{lifetime_seconds:300,renew_before_seconds:240,runner:'ocean-website-maintenance',destination:'dpapi-current-operator'}};
  const requestCall=async(action,value=request)=>{const file=path.join(root,'request.json');fs.writeFileSync(file,JSON.stringify(value));return call(root,action,['-RequestFile',file]);};
  const close=()=>{writer.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('ocean-s302-mutation-'));fs.rmSync(root,{recursive:true,force:true});};
  return {root,writer,state,request,requestCall,close};
}

test('Core mutation bootstrap, idempotency, exact JSON dates, ACL and lifecycle fail-closed',async()=>{
  const f=await fixture();
  try{
    const initial=await f.state();const firstHash=objectHash(initial);
    safe(await call(f.root,'Bootstrap'));assert.equal(objectHash(await f.state()),firstHash);
    assert.equal(initial.config.browser.state,'UNENROLLED');
    const expiry=new Date(Date.now()+3600000).toISOString().replace('Z','0000+00:00');
    const req={...f.request,expires_at_utc:expiry};safe(await f.requestCall('Enroll',req));
    const issued=await f.state();assert.equal(issued.config.identities[0].expires_at_utc,expiry);
    const fingerprint=objectHash(issued);safe(await f.requestCall('Enroll',req));assert.equal(objectHash(await f.state()),fingerprint);
    for(const mutation of [{scopes:['approval.decide']},{expires_at_utc:'2000-01-01T00:00:00Z',identity_id:'test-expired',credential_ref:'OCEAN_EXPIRED_FIXTURE_TOKEN'},{evidence_sha256:'0'.repeat(64)},{strategy_ids:['other_strategy']}]){
      assert.notEqual((await f.requestCall('Enroll',{...req,...mutation})).code,0);
      assert.equal(objectHash(await f.state()),fingerprint);
      assert.equal(fs.existsSync(path.join(f.root,'operator-pending.dpapi')),false);
    }
    safe(await call(f.root,'Transfer',['-IdentityId',req.identity_id]));
    const handoff=safe(await capturedFixture(f.root,`handoffs/${req.identity_id}.dpapi`));
    assert.ok(handoff.token===issued.environment[req.credential_ref]);
    assert.equal(handoff.expires_at_utc,expiry);
    assert.notEqual((await call(f.root,'Initialize')).code,0,'Redirected human setup cannot become enrollment');
  } finally {f.close();}
});

test('Core exact facts, independent TEST/OP enrollment, protected HTTP denials, renewal and revocation',async()=>{
  const f=await fixture();let backend;
  const server=http.createServer((req,res)=>void backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const reload=async()=>{backend?.close();const state=await f.state();backend=new WorkflowBackend(state.config,state.environment);return state;};
  const get=(token,route,extra={})=>fetch(base+route,{headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...extra}});
  try{
    const initial=await f.state();const next=structuredClone(initial);next.config.allowed_origins=[base];next.revision++;
    commitOperation({operation_id:randomUUID(),action:'isolated-fixture-origin',identity_id:'fixture',operator_id:'S-1-5-21-1000',previous_hash:objectHash(initial),next,next_hash:objectHash(next)});
    assert.equal((await seal(f.root,'operator-state.dpapi',next)).code,0);
    const fixtureResult=await run(python,['-B','-E',path.join(here,'qualification-fixture.py')],JSON.stringify({directory:f.root,inputs:process.env.OCEAN_S302_INPUTS}));
    const facts=safe(fixtureResult);
    const before=objectHash(await f.state());
    const bad=structuredClone(facts);bad.instance.config_hash='sha256:'+'d'.repeat(64);
    assert.notEqual((await f.requestCall('Register-Facts',bad)).code,0);assert.equal(objectHash(await f.state()),before);
    const badHash=structuredClone(facts);badHash.bundles.source.bundle_sha256='0'.repeat(64);
    assert.notEqual((await f.requestCall('Register-Facts',badHash)).code,0);assert.equal(objectHash(await f.state()),before);
    safe(await f.requestCall('Register-Facts',facts));
    const registered=safe(await call(f.root,'Read-Facts',['-IdentityId',facts.instance.execution_instance_id]));
    assert.equal(registered.binding.operational_enabled,false);
    safe(await f.requestCall('Register-Facts',facts));
    assert.equal((await f.state()).config.operational_factual_bindings.length,1);
    const op={...f.request,identity_id:'isolated-operational-caller',namespace:'OPERATIONAL',credential_ref:'OCEAN_MUTATION_OP_FIXTURE_TOKEN',instance_ids:[facts.instance.execution_instance_id],factual_binding_hash:registered.binding.binding_hash};
    assert.notEqual((await f.requestCall('Enroll',{...op,factual_binding_hash:'sha256:'+'0'.repeat(64)})).code,0);
    const requests=[f.request,op];for(const req of requests)safe(await f.requestCall('Enroll',req));
    let state=await reload();
    for(const identity of state.config.identities){
      const route=identityProbePath(identity.namespace);const token=state.environment[identity.credential_ref];
      assert.equal((await get(token,route)).status,200);
      assert.equal((await get(null,route)).status,401);assert.equal((await get('invalid',route)).status,401);
      assert.equal((await get(token,identityProbePath(identity.namespace==='TEST'?'OPERATIONAL':'TEST'))).status,403);
      assert.equal((await get(token,route,{Origin:base})).status,403);
      assert.equal((await get(token,route,{'X-Role':'HUMAN'})).status,403);
      safe(await call(f.root,'Probe',['-IdentityId',identity.identity_id]));
    }
    const testToken=state.environment[f.request.credential_ref];
    for(const data of [{strategy_id:'other',instance_id:f.request.instance_ids[0],action:'read'},{strategy_id:'isolated_strategy',instance_id:'other',action:'read'},{strategy_id:'isolated_strategy',instance_id:f.request.instance_ids[0],action:'approval.decide'}]){
      assert.equal((await fetch(base+'/api/workflow/auth/probe',{method:'POST',headers:{Authorization:`Bearer ${testToken}`,'Content-Type':'application/json'},body:JSON.stringify(data)})).status,403);
    }
    const oldEnvironment={...state.environment};
    for(const req of requests)safe(await f.requestCall('Rotate',{...req,expires_at_utc:new Date(Date.now()+180000).toISOString()}));
    const rotated=await f.state();safe(await call(f.root,'Maintenance'));state=await reload();
    for(const identity of state.config.identities){
      assert.equal(identity.credential_version,rotated.config.identities.find(i=>i.identity_id===identity.identity_id).credential_version+1);
      assert.equal((await get(oldEnvironment[identity.credential_ref],identityProbePath(identity.namespace))).status,401);
      assert.equal((await get(state.environment[identity.credential_ref],identityProbePath(identity.namespace))).status,200);
      const handoff=safe(await capturedFixture(f.root,`handoffs/${identity.identity_id}.dpapi`));assert.ok(handoff.token===state.environment[identity.credential_ref]);
      assert.equal(handoff.audience,identity.audience);
    }
    const maintained=objectHash(state);safe(await call(f.root,'Maintenance'));assert.equal(objectHash(await f.state()),maintained);
    for(const req of requests)safe(await f.requestCall('Revoke',req));
    for(const identity of state.config.identities)assert.equal((await get(state.environment[identity.credential_ref],identityProbePath(identity.namespace))).status,401);
    state=await f.state();assert.equal(state.config.identities.length,2);assert.ok(state.config.identities.every(i=>i.revoked));
    for(const identity of state.config.identities){const handoff=safe(await capturedFixture(f.root,`handoffs/${identity.identity_id}.dpapi`));assert.ok(handoff.token===null&&handoff.revoked);}
    for(const table of ['ow_runs','ow_decisions','ow_events','ow_datasets'])assert.equal(f.writer.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  } finally {backend?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('Core interrupted publication before and after DB commit resumes idempotently; pending renewal can be revoked',async()=>{
  const f=await fixture();
  try{
    safe(await f.requestCall('Enroll'));let state=await f.state();
    for(const afterCommit of [false,true]){
      const plan=prepareOperation({action:'rotate',state,root:f.root,operator_id:'S-1-5-21-1000',request:f.request});
      assert.equal((await seal(f.root,'operator-pending.dpapi',plan)).code,0);
      if(afterCommit)commitOperation(plan);
      assert.notEqual((await call(f.root,'Status')).code,0);
      safe(await call(f.root,'Resume'));state=await f.state();assert.equal(objectHash(state),objectHash(plan.next));
      assert.equal(fs.existsSync(path.join(f.root,'operator-pending.dpapi')),false);
      assert.notEqual((await call(f.root,'Resume')).code,0);
      assert.equal(f.writer.db.prepare('SELECT COUNT(*) n FROM ow_auth_audit WHERE after_hash=?').get(plan.next_hash).n,1);
    }
    safe(await f.requestCall('Rotate',{...f.request,expires_at_utc:new Date(Date.now()+180000).toISOString()}));
    state=await f.state();const plan=prepareMaintenance({state,root:f.root,operator_id:'S-1-5-21-1000'});assert.ok(plan.next);
    assert.equal((await seal(f.root,'operator-pending.dpapi',plan)).code,0);commitOperation(plan);
    safe(await f.requestCall('Revoke'));state=await f.state();assert.equal(state.config.identities[0].revoked,true);
    assert.equal(fs.existsSync(path.join(f.root,'operator-pending.dpapi')),false);
    assert.equal(safe(await capturedFixture(f.root,`handoffs/${f.request.identity_id}.dpapi`)).token,null);
  }finally{f.close();}
});

test('Core mutation lock contention fails bounded without publication and retries after release',async()=>{
  const f=await fixture();let child,exited;
  try{
    const before=objectHash(await f.state());
    child=spawn(core,['-NoProfile','-NonInteractive','-File',path.join(here,'mutation-lock-fixture.ps1'),'-Root',f.root],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const result=await f.requestCall('Enroll');assert.notEqual(result.code,0);assert.match(result.stderr,/bounded lock wait exceeded/);
    assert.equal(await exited,0);assert.equal(objectHash(await f.state()),before);
    assert.equal(fs.existsSync(path.join(f.root,'operator-pending.dpapi')),false);
    safe(await f.requestCall('Enroll'));assert.equal((await f.state()).config.identities.length,1);
  }finally{if(exited)await exited;f.close();}
});

test('Core-issued expired credential is denied by actual private HTTP and protected transfer',async()=>{
  const f=await fixture();let backend;
  const server=http.createServer((req,res)=>void backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const initial=await f.state();const configured=structuredClone(initial);
    configured.config.allowed_origins=[`http://127.0.0.1:${server.address().port}`];configured.revision++;
    commitOperation({operation_id:randomUUID(),action:'isolated-fixture-origin',identity_id:'fixture',operator_id:'S-1-5-21-1000',previous_hash:objectHash(initial),next:configured,next_hash:objectHash(configured)});
    assert.equal((await seal(f.root,'operator-state.dpapi',configured)).code,0);
    const request={...f.request,expires_at_utc:new Date(Date.now()+10000).toISOString()};
    delete request.renewal_policy;
    safe(await f.requestCall('Enroll',request));
    const state=await f.state();backend=new WorkflowBackend(state.config,state.environment);
    const url=`http://127.0.0.1:${server.address().port}${identityProbePath('TEST')}`;
    const headers={Authorization:`Bearer ${state.environment[request.credential_ref]}`};
    assert.equal((await fetch(url,{headers})).status,200);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(request.expires_at_utc)-Date.now()+100)));
    assert.equal((await fetch(url,{headers})).status,401);
    assert.notEqual((await call(f.root,'Transfer',['-IdentityId',request.identity_id])).code,0);
  }finally{backend?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('Core/WinPS built-in DPAPI interoperability uses fixture-only ciphertext; no native operator policy override',async t=>{
  const f=await fixture();
  try{
    const value=JSON.stringify({fixture:'public interoperability sentinel',timestamp:'2026-09-19T08:00:00.1234567+01:00'});
    const filename=path.join(f.root,'cross-host.dpapi');
    const nativeCode="$ErrorActionPreference='Stop';$env:PSModulePath=\"$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules\";$f=$env:OCEAN_ISOLATED_CRYPTO_FILE;if($f -notmatch '[\\\\/]ocean-s302-mutation-[^\\\\/]+[\\\\/]cross-host[.]dpapi$'){throw 'Fixture only'};$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force | ConvertFrom-SecureString;[IO.File]::WriteAllText($f,$s);[Console]::Out.Write('OK')";
    const prior=process.env.OCEAN_ISOLATED_CRYPTO_FILE;process.env.OCEAN_ISOLATED_CRYPTO_FILE=filename;
    try{
      const result=await run(native,['-NoProfile','-NonInteractive','-Command',nativeCode],value);assert.equal(result.code,0,result.stderr);
      const decoded=await capturedFixture(f.root,'cross-host.dpapi');assert.equal(decoded.code,0,decoded.stderr);assert.equal(digest(decoded.stdout),digest(value));
      assert.equal((await seal(f.root,'cross-host.dpapi',JSON.parse(value))).code,0);
      const decodeCode="$ErrorActionPreference='Stop';$env:PSModulePath=\"$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules\";$f=$env:OCEAN_ISOLATED_CRYPTO_FILE;if($f -notmatch '[\\\\/]ocean-s302-mutation-[^\\\\/]+[\\\\/]cross-host[.]dpapi$'){throw 'Fixture only'};$s=Get-Content -LiteralPath $f -Raw|ConvertTo-SecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{$bytes=[Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p));$h=[Security.Cryptography.SHA256]::Create();[Console]::Out.Write([BitConverter]::ToString($h.ComputeHash($bytes)).Replace('-','').ToLowerInvariant())}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";
      const hashResult=await run(native,['-NoProfile','-NonInteractive','-Command',decodeCode]);assert.equal(hashResult.code,0,hashResult.stderr);assert.equal(hashResult.stdout,digest(value).slice(7));
      const policy=await run(native,['-NoProfile','-NonInteractive','-Command','$env:PSModulePath="$PSHOME\\Modules;${env:ProgramFiles}\\WindowsPowerShell\\Modules";Get-ExecutionPolicy']);assert.equal(policy.code,0,policy.stderr);assert.equal(policy.stdout.trim(),'Restricted');
      t.diagnostic(JSON.stringify({native_policy:policy.stdout.trim(),native_full_operator:'NOT_RUN_POLICY_RESTRICTED',dpapi_both_directions:'PASS',inline_operator:false}));
    }finally{if(prior===undefined)delete process.env.OCEAN_ISOLATED_CRYPTO_FILE;else process.env.OCEAN_ISOLATED_CRYPTO_FILE=prior;}
  }finally{f.close();}
});
