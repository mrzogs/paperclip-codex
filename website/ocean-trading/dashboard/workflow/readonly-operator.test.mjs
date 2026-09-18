import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './store.mjs';
import { prepareOperation, commitOperation, verifyState } from './operator.mjs';
import { objectHash, digest } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(here,'../../../../scripts/ocean-workflow-operator.ps1');
const pwsh = process.env.OCEAN_READONLY_PWSH;
assert.ok(pwsh && path.isAbsolute(pwsh), 'Explicit trusted PowerShell 7.5+ host required');
const helper = path.join(here,'readonly-fixture.ps1');
const run = (script,args=[],input='') => spawnSync(pwsh,['-NoProfile','-NonInteractive','-File',script,...args],{input,encoding:'utf8',windowsHide:true,timeout:20000});
const read = (root,action='Status',args=[]) => run(wrapper,['-Root',root,'-Action',action,...args]);
const successful = result => { assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout); };
const root = () => fs.mkdtempSync(path.join(os.tmpdir(),'ocean-readonly-'));
const cleanup = dir => {
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(dir).startsWith('ocean-readonly-'));
  fs.rmSync(dir,{recursive:true,force:true});
};
const snapshot = dir => Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
  const file=path.join(e.parentPath,e.name);const bytes=fs.readFileSync(file);
  return [path.relative(dir,file),file.endsWith('-shm') ? bytes : digest(bytes)];
}).sort(([a],[b])=>a.localeCompare(b)));
function assertReadOnly(before,after) {
  assert.deepEqual(Object.keys(after),Object.keys(before),'No files created or removed');
  for(const name of Object.keys(before)) {
    if(!name.endsWith('-shm')) {assert.equal(after[name],before[name],name);continue;}
    assert.equal(after[name].length,before[name].length);
    // SQLite WAL read marks are five 32-bit values at bytes 100..119, not application records.
    for(let i=0;i<before[name].length;i++)if(i<100 || i>=120)assert.equal(after[name][i],before[name][i],`Unexpected SHM change at ${i}`);
  }
}
function fixture() {
  const dir=root();
  const plan=prepareOperation({action:'bootstrap',root:dir,operator_id:'S-1-5-21-1000'});
  const dates=['2026-09-18T09:34:02.000Z','2026-09-18T10:34:02.1234567+01:00','2026-09-18'];
  plan.next.config.readonly_fixture_dates=dates;
  const binding={state:'VERIFIED_FACTS_ONLY',operational_enabled:false,instance:{execution_instance_id:'isolated-readonly-instance'},source_observed_at_utc:dates[1]};
  binding.binding_hash=objectHash(binding);
  plan.next.config.operational_factual_bindings=[binding];
  plan.next.environment.ISOLATED_VALUE='fixture-only-never-operational';
  plan.next_hash=objectHash(plan.next);
  const writer=new WorkflowStore(plan.next.config.db_file);
  commitOperation(plan);
  const result=run(helper,['-Root',dir],JSON.stringify(plan.next));
  assert.equal(result.status,0,result.stderr);
  return {dir,state:plan.next,writer,close(){writer.close();cleanup(dir);}};
}

test('readOnly store requires existing schema without mkdir, initialization or migration',()=>{
  const dir=root();
  try {
    const absent=path.join(dir,'missing','workflow.sqlite');
    assert.throws(()=>new WorkflowStore(absent,{readOnly:true}),/EXISTING_WORKFLOW_DB_REQUIRED/);
    assert.equal(fs.existsSync(path.dirname(absent)),false);
    for(const kind of ['empty','foreign','old','partial']) {
      const file=path.join(dir,kind+'.sqlite');const db=new DatabaseSync(file);
      if(kind==='foreign')db.exec('CREATE TABLE trades(id)');
      if(kind==='old')db.exec("CREATE TABLE ow_schema_migrations(version); INSERT INTO ow_schema_migrations VALUES(5); CREATE TABLE ow_auth_state(id,credential_hash); CREATE TABLE ow_auth_audit(id); CREATE TABLE ow_identities(id)");
      if(kind==='partial')db.exec('CREATE TABLE ow_schema_migrations(version); INSERT INTO ow_schema_migrations VALUES(6)');
      db.close();const before=snapshot(dir);
      assert.throws(()=>new WorkflowStore(file,{readOnly:true}),/EXISTING_|READONLY_WORKFLOW_MIGRATION_REQUIRED/);
      assert.deepEqual(snapshot(dir),before);
    }
  } finally {cleanup(dir);}
});

test('readOnly WAL requires existing sidecars and SQL writes are rejected; default writer is unchanged',()=>{
  const dir=root();const file=path.join(dir,'workflow.sqlite');
  try {
    const writer=new WorkflowStore(file);
    const reader=new WorkflowStore(file,{readOnly:true});
    try {
      assert.equal(reader.db.prepare('PRAGMA query_only').get().query_only,1);
      assert.throws(()=>reader.db.exec('CREATE TABLE ow_forbidden(id)'),/readonly/);
      writer.db.prepare("INSERT INTO ow_auth_state VALUES('isolated','value')").run();
      assert.equal(reader.db.prepare("SELECT credential_hash FROM ow_auth_state WHERE id='isolated'").get().credential_hash,'value');
    } finally {reader.close();writer.close();}
    assert.equal(fs.existsSync(file+'-wal'),false);const before=snapshot(dir);
    assert.throws(()=>new WorkflowStore(file,{readOnly:true}),/EXISTING_WORKFLOW_WAL_REQUIRED/);
    assert.deepEqual(snapshot(dir),before);
  } finally {cleanup(dir);}
});

test('actual trusted Core wrapper preserves DPAPI, dates and DB/WAL bytes; only transient SHM read marks may change',t=>{
  const f=fixture();
  try {
    const before=snapshot(f.dir);
    const status=successful(read(f.dir));assert.equal(status.revision,f.state.revision);
    assert.deepEqual(status,verifyState(f.state,{readOnly:true}));
    assert.ok(!JSON.stringify(status).includes(f.state.environment.ISOLATED_VALUE));
    const runtime=successful(read(f.dir,'Runtime'));assert.deepEqual(runtime,f.state);
    const facts=successful(read(f.dir,'Read-Facts',['-IdentityId','isolated-readonly-instance']));
    assert.equal(facts.binding.source_observed_at_utc,f.state.config.readonly_fixture_dates[1]);
    assert.equal(facts.binding.binding_hash,f.state.config.operational_factual_bindings[0].binding_hash);
    assert.notEqual(read(f.dir,'Read-Facts',['-IdentityId','unknown']).status,0);
    const after=snapshot(f.dir);assertReadOnly(before,after);
    t.diagnostic(JSON.stringify({shm_before:digest(before['workflow.sqlite-shm']),shm_after:digest(after['workflow.sqlite-shm']),classification:'TRANSIENT_SQLITE_READER_COORDINATION_ONLY'}));
  } finally {f.close();}
});

test('Core read-only rejects missing root, missing lock, pending publication, wrong registry and escaped DB without writing',()=>{
  const parent=root();
  try {const missing=path.join(parent,'absent');assert.notEqual(read(missing).status,0);assert.equal(fs.existsSync(missing),false);} finally {cleanup(parent);}
  for(const kind of ['lock','pending','registry','database','escape','corrupt-dpapi']) {
    const f=fixture();
    try {
      if(kind==='lock')fs.unlinkSync(path.join(f.dir,'operator.lock'));
      if(kind==='pending')fs.writeFileSync(path.join(f.dir,'operator-pending.dpapi'),'isolated pending');
      if(kind==='registry')f.writer.db.prepare("UPDATE ow_auth_state SET credential_hash='wrong' WHERE id='bundle'").run();
      if(kind==='database'){f.writer.close();f.writer.close=()=>{};fs.unlinkSync(f.state.config.db_file);}
      if(kind==='escape'){f.state.config.db_file=path.join(f.dir,'elsewhere.sqlite');assert.equal(run(helper,['-Root',f.dir],JSON.stringify(f.state)).status,0);}
      if(kind==='corrupt-dpapi')fs.writeFileSync(path.join(f.dir,'operator-state.dpapi'),'invalid');
      const before=snapshot(f.dir);assert.notEqual(read(f.dir).status,0,kind);assertReadOnly(before,snapshot(f.dir));
    } finally {f.close();}
  }
});

test('Core read-only rejects unsafe root and file ACLs and reparse roots',()=>{
  for(const action of ['LooseAcl','LooseFileAcl']) {
    const f=fixture();
    try {const result=run(helper,['-Root',f.dir,'-Action',action]);assert.equal(result.status,0,result.stderr);const before=snapshot(f.dir);assert.notEqual(read(f.dir).status,0);assert.deepEqual(snapshot(f.dir),before);} finally {f.close();}
  }
  const f=fixture();const link=root();fs.rmdirSync(link);
  try {fs.symlinkSync(f.dir,link,'junction');assert.notEqual(read(link).status,0);} finally {fs.unlinkSync(link);f.close();}
});

test('Core read-only respects the existing exclusive operator lock with bounded wait',async()=>{
  const f=fixture();
  const child=spawn(pwsh,['-NoProfile','-NonInteractive','-File',helper,'-Root',f.dir,'-Action','Lock'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
    const result=read(f.dir);assert.notEqual(result.status,0);assert.match(result.stderr,/bounded lock wait exceeded/);
    assert.equal(await exited,0);
    assert.equal(successful(read(f.dir)).revision,f.state.revision);
  } finally {await exited;f.close();}
});
