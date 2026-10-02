import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {prepareOperation,commitOperation,verifyState,prepareMaintenance} from './operator.mjs';
import {WorkflowBackend} from './backend.mjs';
import {OceanAuth,issueOceanIdentity} from './auth.mjs';
import {WorkflowStore} from './store.mjs';
import {objectHash,digest} from './common.mjs';
import {attachMaintenance} from './maintenance.mjs';
import {identityProbePath,identityProjection,validateIdentityProbe,MAX_SERVICE_IDENTITIES} from './provider-lifecycle.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const python='C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const wrapper=path.resolve(here,'../../../../scripts/ocean-workflow-operator.ps1');
const run=(exe,args,input='')=>new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
  child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
});
const safeJson=result=>{assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout);};
const schema=(name,value)=>{
  const result=spawnSync(python,['-B',path.join(here,'validate-provider-schema.py')],{input:JSON.stringify({schema:`https://ocean.local/contracts/${name}/v1`,value}),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
};

test('S30.2 isolated registry capacity 64 includes tombstones at every reader and issuance/rotation',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s302-capacity-'));
  try {
    const plan=prepareOperation({action:'bootstrap',root,operator_id:'S-1-5-21-1000'});
    const state=plan.next;const owner=path.join(root,'owner.md');fs.writeFileSync(owner,'isolated capacity test');
    const req={identity_id:'test-capacity-next',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_CAPACITY_NEXT_TOKEN',strategy_ids:['isolated_strategy'],instance_ids:['test-capacity-instance'],scopes:['read'],owner:'isolated',evidence_path:owner,evidence_sha256:digest(fs.readFileSync(owner)).slice(7),expires_at_utc:new Date(Date.now()+300000).toISOString()};
    for(let i=0;i<63;i++)state.config.identities.push(issueOceanIdentity({...req,identity_id:`test-capacity-${i}`,credential_ref:`OCEAN_CAPACITY_${i}_TOKEN`,revoked:false},state.environment,req.expires_at_utc));
    state.config.identities[0].revoked=true;
    const final=prepareOperation({action:'enroll',state,root,operator_id:'S-1-5-21-1000',request:req});
    assert.equal(final.next.config.identities.length,MAX_SERVICE_IDENTITIES);
    assert.equal(final.next.config.identities[0].revoked,true);
    // Establish the isolated 64-row durable registry in one prepared transaction.
    final.previous_hash=null;commitOperation(final);
    assert.equal(verifyState(final.next).identities.length,64);
    const backend=new WorkflowBackend(final.next.config,final.next.environment);backend.close();
    const rotate=prepareOperation({action:'rotate',state:final.next,root,operator_id:'S-1-5-21-1000',request:req});
    assert.equal(rotate.next.config.identities.length,64);
    assert.throws(()=>prepareOperation({action:'enroll',state:final.next,root,operator_id:'S-1-5-21-1000',request:{...req,identity_id:'test-overflow',credential_ref:'OCEAN_OVERFLOW_TOKEN'}}),/CAPACITY/);
    const overflow=structuredClone(final.next);overflow.config.identities.push({...overflow.config.identities[1],identity_id:'test-overflow'});
    for(const action of ['enroll','rotate','revoke'])assert.throws(()=>prepareOperation({action,state:overflow,root,operator_id:'S-1-5-21-1000',request:req}),/CAPACITY/);
    assert.throws(()=>verifyState(overflow),/CAPACITY/);
    assert.throws(()=>prepareMaintenance({state:overflow,root,operator_id:'S-1-5-21-1000'}),/CAPACITY/);
    assert.throws(()=>commitOperation({...final,next:overflow,next_hash:objectHash(overflow)}),/CAPACITY/);
    const store=new WorkflowStore(state.config.db_file);
    try{assert.throws(()=>new OceanAuth(overflow.config,store,overflow.environment),/CAPACITY/);}finally{store.close();}
    assert.throws(()=>issueOceanIdentity({...req,audience:'Ocean workflow operational v1'}, {},req.expires_at_utc),/AUDIENCE/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('S30.2 native Windows DPAPI both audiences, actual loopback identity/renewal/revocation and protected facts',async()=>{
  const root=path.join(os.tmpdir(),`ocean-s302-native-${Date.now()}`);let backend;
  const call=async(action,args=[])=>run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,'-Root',root,'-Action',action,...args]);
  const read=async file=>safeJson(await run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'native-fixture-state.ps1'),'-Action','Read','-File',file]));
  const server=http.createServer((req,res)=>void backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const reload=async()=>{backend?.close();const state=safeJson(await call('Runtime'));backend=new WorkflowBackend(state.config,state.environment);return state;};
  const get=async(token,route,headers={})=>fetch(base+route,{headers:{Authorization:`Bearer ${token}`,...headers}});
  try {
    safeJson(await call('Bootstrap'));
    // Only this private fixture bootstrap selects a random loopback listener.
    let state=safeJson(await call('Runtime'));const next=structuredClone(state);next.config.allowed_origins=[base];next.revision++;
    commitOperation({operation_id:crypto.randomUUID(),action:'isolated-fixture-origin',identity_id:'fixture',operator_id:'S-1-5-21-1000',previous_hash:objectHash(state),next,next_hash:objectHash(next)});
    const written=await run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'native-fixture-state.ps1'),'-Action','Write','-File',path.join(root,'operator-state.dpapi')],JSON.stringify(next));assert.equal(written.code,0,written.stderr);
    const fixture=spawnSync(python,['-B',path.join(here,'qualification-fixture.py')],{input:JSON.stringify({directory:root,inputs:process.env.OCEAN_S302_INPUTS}),encoding:'utf8',windowsHide:true});assert.equal(fixture.status,0,fixture.stderr);
    const facts=JSON.parse(fixture.stdout);const requestFile=path.join(root,'facts-request.json');fs.writeFileSync(requestFile,JSON.stringify(facts));
    safeJson(await call('Register-Facts',['-RequestFile',requestFile]));
    const registered=safeJson(await call('Read-Facts',['-IdentityId',facts.instance.execution_instance_id]));schema('factual-registration-readback',registered);
    const factsRevision=registered.registry_revision;
    safeJson(await call('Register-Facts',['-RequestFile',requestFile]));
    assert.equal(safeJson(await call('Read-Facts',['-IdentityId',facts.instance.execution_instance_id])).binding.binding_hash,registered.binding.binding_hash);
    assert.ok(registered.registry_revision===factsRevision);
    const owner=path.join(root,'owner.md');fs.writeFileSync(owner,'ISOLATED NATIVE SOFTWARE FIXTURE, NOT ACTUAL SOURCE AUTHORITY');
    const common={role:'TELEMETRY',strategy_ids:['isolated_strategy'],scopes:['read'],expires_at_utc:new Date(Date.now()+300000).toISOString(),owner:'Isolated Ocean native fixture',evidence_path:owner,evidence_sha256:digest(fs.readFileSync(owner)).slice(7),renewal_policy:{lifetime_seconds:120,renew_before_seconds:90,runner:'ocean-website-maintenance',destination:'dpapi-current-operator'}};
    const requests=[{...common,identity_id:'test-s302-caller',namespace:'TEST',credential_ref:'OCEAN_S302_TEST_TOKEN',instance_ids:['test-s302-instance']},{...common,identity_id:facts.instance.telemetry_producer_id,namespace:'OPERATIONAL',credential_ref:'OCEAN_S302_OPERATIONAL_TOKEN',instance_ids:[facts.instance.execution_instance_id],factual_binding_hash:registered.binding.binding_hash}];
    for(const [i,request] of requests.entries()){
      const file=path.join(root,`enroll-${i}.json`);fs.writeFileSync(file,JSON.stringify(request));safeJson(await call('Enroll',['-RequestFile',file]));
    }
    state=await reload();
    for(const identity of state.config.identities){
      safeJson(await call('Transfer',['-IdentityId',identity.identity_id]));
      const handoff=await read(path.join(root,'handoffs',identity.identity_id+'.dpapi'));
      assert.deepEqual(Object.keys(handoff).sort(),['identity_id','credential_ref','token','expires_at_utc','credential_version','revoked','audience','owner'].sort());
      assert.equal(handoff.audience,identity.audience);assert.equal(handoff.token,state.environment[identity.credential_ref]);
      const response=await get(handoff.token,identityProbePath(identity.namespace));assert.equal(response.status,200);
      const body=await response.json();schema('service-identity',body);validateIdentityProbe(body,identity);
      for(const field of ['audience','id','scopes','instance_ids','factual_binding_hash'])assert.throws(()=>validateIdentityProbe({...body,identity:{...body.identity,[field]:'wrong'}},identity),/MISMATCH/);
      safeJson(await call('Probe',['-IdentityId',identity.identity_id]));
      const other=identityProbePath(identity.namespace==='TEST'?'OPERATIONAL':'TEST');assert.equal((await get(handoff.token,other)).status,403);
      assert.equal((await get(handoff.token,identityProbePath(identity.namespace),{Origin:base})).status,403);
      assert.equal((await get(handoff.token,identityProbePath(identity.namespace),{'X-Role':'HUMAN'})).status,403);
      assert.equal((await get('invalid',identityProbePath(identity.namespace))).status,401);
    }
    assert.equal((await fetch(base+identityProbePath('OPERATIONAL'))).status,401);
    const oldTokens={...state.environment};
    for(const [i,request] of requests.entries()){
      fs.writeFileSync(path.join(root,`enroll-${i}.json`),JSON.stringify({...request,expires_at_utc:new Date(Date.now()+50000).toISOString()}));
      safeJson(await call('Rotate',['-RequestFile',path.join(root,`enroll-${i}.json`)]));
    }
    state=await reload();const oldVersion=state.config.identities[0].credential_version;
    attachMaintenance(backend,path.join(root,'operator-state.dpapi'));
    const until=Date.now()+25000;
    while(Date.now()<until && (backend.maintenanceHealth.state!=='READY' || backend.config.identities[0].credential_version===oldVersion))await new Promise(r=>setTimeout(r,250));
    assert.equal(backend.maintenanceHealth.state,'READY',JSON.stringify(backend.maintenanceHealth));
    assert.equal(backend.config.identities[0].credential_version,oldVersion+1);
    state=safeJson(await call('Runtime'));
    for(const identity of state.config.identities){
      assert.equal((await get(oldTokens[identity.credential_ref],identityProbePath(identity.namespace))).status,401);
      safeJson(await call('Probe',['-IdentityId',identity.identity_id]));
      const handoff=await read(path.join(root,'handoffs',identity.identity_id+'.dpapi'));assert.equal(handoff.audience,identity.audience);assert.equal(handoff.credential_version,identity.credential_version);
    }
    backend.stopMaintenance();state=await reload(); // Actual private receiver restart/reload, same registry and identity.
    for(const identity of state.config.identities)safeJson(await call('Probe',['-IdentityId',identity.identity_id]));
    for(let i=0;i<requests.length;i++)safeJson(await call('Revoke',['-RequestFile',path.join(root,`enroll-${i}.json`)]));
    for(const identity of state.config.identities)assert.equal((await get(state.environment[identity.credential_ref],identityProbePath(identity.namespace))).status,401);
    state=await reload();assert.equal(state.config.identities.length,2);assert.ok(state.config.identities.every(i=>i.revoked));
    for(const identity of state.config.identities){const h=await read(path.join(root,'handoffs',identity.identity_id+'.dpapi'));assert.equal(h.token,null);assert.equal(h.revoked,true);assert.notEqual((await call('Probe',['-IdentityId',identity.identity_id])).code,0);}
    for(const table of ['ow_runs','ow_decisions','ow_events','ow_datasets'])assert.equal(backend.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{backend?.close();server.closeAllConnections();await new Promise(r=>server.close(r));if(fs.existsSync(root))fs.rmSync(root,{recursive:true,force:true});}
});
