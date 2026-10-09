import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { RunManager } from './run-manager.mjs';
import { digest, sealedHash } from './common.mjs';

const examples=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url)));

// Real SQLite, RunManager, actor/scope checks and completion schema validation.
// Only the initial authority/source rows are synthetic. No native or Brain IO.
function fixture(t,{progress=true,invalidContext=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-terminal-request-'));
  let store=new WorkflowStore(path.join(root,'workflow.sqlite'));
  const b=Object.create(WorkflowBackend.prototype);
  const human={id:'mock-human',role:'HUMAN'};
  const actor={id:'mock-telemetry',role:'TELEMETRY',namespace:'OPERATIONAL',scopes:['read','event.write'],
    strategyIds:['mock-strategy'],instanceIds:['mock-instance']};
  const context={...structuredClone(examples['run-context']),run_id:'mock-terminal-run',strategy_id:'mock-strategy',
    execution_instance_id:'mock-instance',expected_environment:'REPLAY'};
  context.context_hash=sealedHash(context,'context_hash');
  const instance={execution_instance_id:context.execution_instance_id,strategy_id:context.strategy_id,
    telemetry_producer_id:actor.id,account_alias:'Sim1'};
  const requested={start_utc:'2025-09-01T00:00:00.000Z',end_utc:'2025-09-13T00:00:00.000Z'};
  const plan={context_hash:context.context_hash,selection:{interval:requested},operational_review:{
    context,factual_binding_hash:digest('mock-binding'),manifest_key:'mock-manifest',partition_index:0,interval:requested}};
  plan.plan_hash=sealedHash(plan,'plan_hash');
  Object.assign(b,{db:store.db,store,environment:{},config:{python_executable:process.env.OCEAN_TRADING_PYTHON || 'python',
    operational_factual_bindings:[{binding_hash:plan.operational_review.factual_binding_hash,instance}]}});
  b.runs=new RunManager(b);
  const db=b.db;
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('mock-profile',context.strategy_id,'1',digest('mock-profile'),'{}');
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(context.strategy_id,'mock-profile',1,context.strategy_code_hash,'{}');
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(context.execution_instance_id,context.strategy_id,JSON.stringify(instance));
  db.prepare('INSERT INTO ow_identities VALUES(?,?,?)').run(actor.id,actor.role,'{}');
  db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run('mock-manifest',context.strategy_id,1,context.dataset_manifest_hash,
    'OPERATIONAL_MANIFEST',JSON.stringify({source_id:'mock-source',source_revision:1,manifest_hash:context.dataset_manifest_hash,partitions:[{symbol:'MNQU25'}]}));
  db.prepare("INSERT INTO ow_runs VALUES(?,?,?,2,'ACTIVE',?)").run(context.run_id,context.strategy_id,context.execution_instance_id,
    JSON.stringify(invalidContext?{...context,strategy_version:'EXPLICIT_MOCK_INVALID_HASH'}:context));
  db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(context.run_id,digest('mock-coverage'),JSON.stringify(plan));
  const perform=(action,data={},who=actor)=>b.runs.perform(action,who,{run_id:context.run_id,...data});
  const lease=perform('claim',{expected_revision:2});
  if(progress)perform('progress',{lease_id:lease.lease_id,axes:{source_market:[],strategy_execution:[],processing_review:[]},
    watermark:null,pending_events:0,gaps:[],failures:[]});
  const end=outcome=>perform('end',{expected_revision:2,outcome},human);
  const finish=(overrides={},who=actor)=>perform('finish',{lease_id:lease.lease_id,expected_revision:3,...overrides},who);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {b,db,root,context,plan,actor,human,lease,perform,end,finish,
    restart(){store.close();store=new WorkflowStore(path.join(root,'workflow.sqlite'));b.db=store.db;b.store=store;b.runs=new RunManager(b);},
    read:()=>b.runs.read(actor,context.run_id)};
}

for(const outcome of ['FAILED','CANCELLED'])test(`real SQLite human ${outcome} request survives restart and finishes drained without artifacts or coverage`,t=>{
  const f=fixture(t);
  assert.equal(f.read().end_request,null);
  const ending=f.end(outcome),request=ending.end_request;
  assert.equal(request.outcome,outcome);assert.equal(request.actor_role,'HUMAN');assert.ok(Number.isInteger(request.event_id));
  const progress=f.db.prepare('SELECT * FROM ow_run_progress').all();
  f.restart();assert.deepEqual(f.read().end_request,request);
  const done=f.finish();
  assert.equal(done.state,outcome);assert.equal(done.end_request,null);
  assert.equal(done.completion.status,outcome);assert.deepEqual(done.completion.observed_coverage,[]);
  assert.equal(done.completion.watermark,null);assert.equal(done.completion.unique_canonical_trade_count,0);
  assert.deepEqual(f.b.db.prepare('SELECT * FROM ow_run_progress').all(),progress);
  for(const table of ['ow_artifacts','ow_evidence_revisions','ow_run_leases'])assert.equal(f.b.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal(f.b.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,1);
  assert.throws(()=>f.finish(),/STALE_OR_FOREIGN_RUN_LEASE/);
  assert.equal(f.b.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,1);
});

for(const [name,change,code] of [
  ['missing progress',()=>{},'RUN_NOT_DRAINED'],
  ['pending events',f=>f.perform('progress',{lease_id:f.lease.lease_id,axes:{source_market:[],strategy_execution:[],processing_review:[]},
    watermark:null,pending_events:1,gaps:[],failures:[]}),'RUN_NOT_DRAINED'],
  ['open pin',f=>f.db.prepare("INSERT INTO ow_trade_pins VALUES(?,?,?,'OPEN')").run('mock-pin',f.context.run_id,f.context.context_hash),'RUN_NOT_DRAINED'],
  ['expired lease',f=>f.db.exec('UPDATE ow_run_leases SET expires_ms=0'),'STALE_OR_FOREIGN_RUN_LEASE'],
  ['foreign lease',f=>{f.db.prepare('INSERT INTO ow_identities VALUES(?,?,?)').run('other','TELEMETRY','{}');
    f.db.exec("UPDATE ow_run_leases SET owner_id='other'");},'STALE_OR_FOREIGN_RUN_LEASE'],
])test(`real finish rejects ${name} without a terminal receipt`,t=>{
  const f=fixture(t,{progress:name!=='missing progress'});f.end('FAILED');change(f);
  assert.throws(()=>f.finish(),new RegExp(code));
  assert.equal(f.db.prepare('SELECT state FROM ow_runs').get().state,'COMPLETING');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,0);
});

test('real read rejects an invalid sealed context and rolls back the attempted failed end',t=>{
  const f=fixture(t,{invalidContext:true});
  assert.throws(()=>f.end('FAILED'),/TERMINAL_RUN_CONTEXT_REJECTED/);
  assert.equal(f.db.prepare('SELECT state FROM ow_runs').get().state,'ACTIVE');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ow_events WHERE action='run-manager.end'").get().n,0);
});

test('existing immutable run and progress triggers stay enabled',t=>{
  const f=fixture(t);f.end('FAILED');
  assert.throws(()=>f.db.prepare('UPDATE ow_runs SET context_json=?').run(JSON.stringify({...f.context,strategy_version:'tampered'})),/immutable run context/);
  assert.throws(()=>f.db.exec('DELETE FROM ow_run_progress'),/immutable run record/);
  assert.equal(f.read().end_request.outcome,'FAILED');
});

test('COMPLETED remains strict even after human end and a drained empty progress record',t=>{
  const f=fixture(t);assert.equal(f.end('COMPLETED').end_request.outcome,'COMPLETED');
  assert.throws(()=>f.finish(),/COVERAGE_INCOMPLETE/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,0);
});

test('real finish rejects stale revision, wrong producer, role and scope',t=>{
  const f=fixture(t);f.end('CANCELLED');
  assert.throws(()=>f.finish({expected_revision:2}),/REVISION_CONFLICT/);
  assert.throws(()=>f.finish({}, {...f.actor,id:'other'}),/WRONG_TELEMETRY_PRODUCER/);
  assert.throws(()=>f.finish({}, {...f.actor,role:'STRATEGY'}),/OBSERVED_PRODUCER_REQUIRED/);
  assert.throws(()=>f.finish({}, {...f.actor,strategyIds:['other']}),/WRONG_STRATEGY_SCOPE/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,0);
});

test('caller transaction rollback retains the human request and permits exactly one successful retry',t=>{
  const f=fixture(t);f.end('FAILED');
  assert.throws(()=>f.b.store.transaction(()=>{f.finish();throw Error('EXPLICIT_MOCK_RESPONSE_FAILURE');}),/EXPLICIT_MOCK_RESPONSE_FAILURE/);
  assert.equal(f.read().state,'COMPLETING');assert.equal(f.read().end_request.outcome,'FAILED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,0);
  f.finish();assert.equal(f.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,1);
});

test('real restart waits for lease expiry then renews a newly claimed lease with the same persisted intent',t=>{
  const f=fixture(t);const request=f.end('CANCELLED').end_request;f.restart();
  assert.throws(()=>f.perform('claim',{expected_revision:3}),/RUN_ALREADY_LEASED/);
  // Explicit disposable lease-clock fixture, not an alteration to immutable evidence.
  f.b.db.exec('UPDATE ow_run_leases SET expires_ms=0');
  assert.throws(()=>f.finish(),/STALE_OR_FOREIGN_RUN_LEASE/);
  const claimed=f.perform('claim',{expected_revision:3});assert.notEqual(claimed.lease_id,f.lease.lease_id);
  const renewed=f.perform('renew',{lease_id:claimed.lease_id});
  assert.deepEqual(renewed.end_request,request);assert.equal(renewed.lease.owner_id,f.actor.id);
  assert.equal(renewed.lease.expired,false);assert.ok(renewed.lease.expires_ms>Date.now());
  const done=f.finish({lease_id:claimed.lease_id});assert.equal(done.state,'CANCELLED');
  assert.deepEqual(done.completion.observed_coverage,[]);
  assert.equal(f.b.db.prepare('SELECT count(*) n FROM ow_coverage_receipts').get().n,1);
});
