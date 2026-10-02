import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {WorkflowStore} from './store.mjs';
import {workflowFromEnvironment} from './backend.mjs';
import {protectedOperation,protectedOperatorHost} from './maintenance.mjs';
import {commitOperation} from './operator.mjs';
import {objectHash,digest} from './common.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const wrapper=path.resolve(here,'../../../../scripts/ocean-workflow-operator.ps1');
const call=(root,action,extra=[],input='')=>spawnSync(protectedOperatorHost,['-NoProfile','-NonInteractive','-File',wrapper,'-Root',root,'-Action',action,...extra],{input,encoding:'utf8',windowsHide:true,timeout:30000});
const safe=result=>{assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{const end=Date.now()+30000;while(!predicate()&&Date.now()<end)await sleep(100);assert.ok(predicate(),'bounded maintenance readiness');};

test('actual protected loader and maintenance use trusted Core, reload issued state and renew without browser login',async()=>{
  const root=path.join(os.tmpdir(),`ocean-s302-loader-${randomUUID()}`);let backend,writer;
  const server=http.createServer((req,res)=>void backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    await protectedOperation('Bootstrap',root);
    writer=new WorkflowStore(path.join(root,'workflow.sqlite'));
    const initial=await protectedOperation('Runtime',root);const next=structuredClone(initial);
    next.config.allowed_origins=[base];next.revision++;
    commitOperation({operation_id:randomUUID(),action:'private-loopback-origin',identity_id:'fixture',operator_id:'S-1-5-21-1000',previous_hash:objectHash(initial),next,next_hash:objectHash(next)});
    const seal=spawnSync(protectedOperatorHost,['-NoProfile','-NonInteractive','-File',path.join(here,'native-fixture-state.ps1'),'-Action','Write','-File',path.join(root,'operator-state.dpapi')],{input:JSON.stringify(next),encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(seal.status,0,seal.stderr);
    backend=workflowFromEnvironment({OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:path.join(root,'operator-state.dpapi')},'C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
    assert.equal(backend.config.browser.state,'UNENROLLED');
    await until(()=>backend.maintenanceHealth.state==='READY');
    const owner=path.join(root,'owner.md');fs.writeFileSync(owner,'PRIVATE OWNED FIXTURE, NOT OPERATIONAL AUTHORITY');
    const request={identity_id:'test-host-loader',role:'TELEMETRY',namespace:'TEST',credential_ref:'OCEAN_HOST_LOADER_FIXTURE_TOKEN',strategy_ids:['isolated_strategy'],instance_ids:['test-loader-instance'],scopes:['read'],expires_at_utc:new Date(Date.now()+180000).toISOString(),owner:'Private caller host test',evidence_path:owner,evidence_sha256:digest(fs.readFileSync(owner)).slice(7),renewal_policy:{lifetime_seconds:300,renew_before_seconds:240,runner:'ocean-website-maintenance',destination:'dpapi-current-operator'}};
    const requestFile=path.join(root,'request.json');fs.writeFileSync(requestFile,JSON.stringify(request));
    safe(call(root,'Enroll',['-RequestFile',requestFile]));
    await until(()=>backend.config.identities.length===1);
    const state=await protectedOperation('Runtime',root);
    const oldToken=state.environment[request.credential_ref];
    const get=token=>fetch(base+'/api/workflow/identity/v1',{headers:{Authorization:`Bearer ${token}`}});
    assert.equal((await get(oldToken)).status,200);
    // Restart only this private backend: its first regular tick must renew due credentials.
    backend.close();backend=workflowFromEnvironment({OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:path.join(root,'operator-state.dpapi')},'C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
    await until(()=>backend.maintenanceHealth.state==='READY'&&backend.config.identities[0].credential_version===2);
    const renewed=await protectedOperation('Runtime',root);
    assert.equal((await get(oldToken)).status,401);
    assert.equal((await get(renewed.environment[request.credential_ref])).status,200);
    assert.equal(backend.config.test_only,true);assert.equal(backend.config.brain_submission,'OFF');
    assert.equal(backend.config.dispatch_worker,'OFF');assert.equal(backend.config.live_real,'DISABLED');
    assert.equal(backend.config.browser.state,'UNENROLLED');
    for(const table of ['ow_runs','ow_decisions','ow_events','ow_datasets'])assert.equal(writer.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{
    backend?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));writer?.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('ocean-s302-loader-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('caller host paths and website-only launcher contain no policy overrides or forwarder',()=>{
  for(const name of ['backend.mjs','maintenance.mjs']){
    const source=fs.readFileSync(path.join(here,name),'utf8');
    assert.ok(!source.includes('ExecutionPolicy'));assert.ok(!source.includes('powershell.exe'));
    assert.ok(source.includes('protectedOperatorHost'));
  }
  const launcher=fs.readFileSync(path.resolve(here,'../../../../scripts/start-ocean-website.ps1'),'utf8');
  assert.ok(!launcher.includes('ExecutionPolicy')&&!launcher.includes('$forward'));
  assert.ok(launcher.includes('FileSystemAclExtensions')&&launcher.includes('-WindowStyle Hidden'));
});

test('actual Core launcher module path resolves Windows network and process commands',()=>{
  const launcher=fs.readFileSync(path.resolve(here,'../../../../scripts/start-ocean-website.ps1'),'utf8');
  const line=launcher.split(/\r?\n/).find(value=>value.startsWith('$env:PSModulePath = '));
  assert.ok(line?.includes('$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\Modules'));
  const result=spawnSync(protectedOperatorHost,['-NoProfile','-NonInteractive','-Command',line+'; Get-Command Get-NetTCPConnection,Get-CimInstance | Select-Object -ExpandProperty Name'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);
  assert.ok(result.stdout.includes('Get-NetTCPConnection')&&result.stdout.includes('Get-CimInstance'));
});

test('actual protected loader starts after a clean last-writer shutdown without precreated WAL sidecars',async()=>{
  const root=path.join(os.tmpdir(),`ocean-s302-loader-${randomUUID()}`);let backend;
  try{
    await protectedOperation('Bootstrap',root);
    assert.equal(fs.existsSync(path.join(root,'workflow.sqlite-wal')),false);
    assert.equal(fs.existsSync(path.join(root,'workflow.sqlite-shm')),false);
    const cipher=digest(fs.readFileSync(path.join(root,'operator-state.dpapi')));
    for(let pass=0;pass<2;pass++){
      backend=workflowFromEnvironment({OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:path.join(root,'operator-state.dpapi')},'C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe');
      await until(()=>backend.maintenanceHealth.state==='READY');
      assert.equal(backend.config.identities.length,0);assert.equal(backend.config.browser.state,'UNENROLLED');
      assert.equal(backend.config.brain_submission,'OFF');assert.equal(backend.config.live_real,'DISABLED');
      assert.equal(backend.store.db.prepare('SELECT COUNT(*) n FROM ow_auth_audit').get().n,1);
      assert.equal(digest(fs.readFileSync(path.join(root,'operator-state.dpapi'))),cipher);
      backend.close();backend=null;
      assert.equal(fs.existsSync(path.join(root,'workflow.sqlite-wal')),false);
      assert.equal(fs.existsSync(path.join(root,'workflow.sqlite-shm')),false);
    }
  }finally{
    backend?.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('ocean-s302-loader-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('startup runtime rejects missing protected database without creating a substitute',async()=>{
  const root=path.join(os.tmpdir(),`ocean-s302-loader-${randomUUID()}`);
  try{
    await protectedOperation('Bootstrap',root);
    const db=path.join(root,'workflow.sqlite');fs.renameSync(db,db+'.fixture-backup');
    const before=fs.readdirSync(root).sort();
    const rejected=call(root,'Bootstrap-Runtime');assert.notEqual(rejected.status,0);
    assert.deepEqual(fs.readdirSync(root).sort(),before);assert.equal(fs.existsSync(db),false);
  }finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('ocean-s302-loader-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
