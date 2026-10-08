import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash, sealedHash } from './common.mjs';
import { readCurrentReplayExecution } from './replay-run-bridge-probe.mjs';
import { currentFixture, changeJson } from './current-execution.test-fixtures.mjs';

test('actual persisted RunManager/HTTP view verifies exact open attempt without lease, evidence or command writes',async()=>{
  const f=await currentFixture();try{
    const before=f.snapshot(),runs=f.runSnapshot(),attempts=f.nativeSnapshot(),files=f.nativeFiles.map(file=>fs.readFileSync(file));
    const view=f.read();assert.equal(view.execution.status,'CURRENT_RUNNING_VERIFIED');assert.equal(view.execution.phase,'WARMUP');
    assert.equal(view.execution.attempt_id,26);assert.equal(view.execution.context_hash,f.context.context_hash);
    assert.equal(view.execution.completed_coverage_granted,false);assert.equal(view.completion,null);assert.equal(view.lease,null);
    assert.equal(view.execution.chart_time_basis,'NATIVE_CHART_DATETIME_NOT_ASSUMED_UTC');
    const response=await f.request(`view/runs/${f.runId}`);assert.equal(response.status,200);
    assert.equal((await response.json()).manager.execution.status,'CURRENT_RUNNING_VERIFIED');
    assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.runSnapshot(),runs);assert.deepEqual(f.nativeSnapshot(),attempts);
    f.nativeFiles.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),files[index]));
  }finally{await f.close();}
});

test('persisted logical v011 context with pinned physical v238 and native session mode verifies without rewriting either identity',async()=>{
  const f=await currentFixture({logicalVersion:'v0.1.1',sessionObservationMode:'sierra_trading_day_v1'});try{
    const before=f.snapshot(),runs=f.runSnapshot(),attempts=f.nativeSnapshot(),files=f.nativeFiles.map(file=>fs.readFileSync(file));
    assert.equal(f.context.strategy_version,'v0.1.1');assert.equal(f.config.expected_strategy_version,'v0.6.238');
    assert.equal(f.sql.prepare('SELECT strategy_version FROM replay_runs WHERE run_id=?').get(f.runId).strategy_version,'v0.6.238');
    const view=f.read();assert.equal(view.context_status,'CURRENT');assert.equal(view.execution.status,'CURRENT_RUNNING_VERIFIED');
    assert.equal(view.execution.context_hash,f.context.context_hash);assert.equal(view.execution.phase,'WARMUP');
    assert.equal(view.execution.completed_coverage_granted,false);
    const response=await f.request(`view/runs/${f.runId}`);assert.equal(response.status,200);
    const manager=(await response.json()).manager;assert.equal(manager.context.strategy_version,'v0.1.1');
    assert.equal(manager.execution.status,'CURRENT_RUNNING_VERIFIED');assert.equal(manager.completion,null);
    assert.deepEqual(f.snapshot(),before);assert.deepEqual(f.runSnapshot(),runs);assert.deepEqual(f.nativeSnapshot(),attempts);
    f.nativeFiles.forEach((file,index)=>assert.deepEqual(fs.readFileSync(file),files[index]));
  }finally{await f.close();}
});

for(const [name,mutate] of [
  ['different physical replay version',f=>f.sql.prepare("UPDATE replay_runs SET strategy_version='v0.6.237'").run()],
  ['start command claims logical instead of pinned physical version',f=>fs.writeFileSync(f.commandFile,
    fs.readFileSync(f.commandFile,'utf8').replace('telemetryStrategyVersion=v0.6.238','telemetryStrategyVersion=v0.1.1'))],
  ['different native observation mode',f=>f.sql.prepare("UPDATE replay_run_context SET session_observation_mode=NULL").run()],
])test(`distinct logical/physical versions do not excuse ${name}`,async()=>{
  const f=await currentFixture({logicalVersion:'v0.1.1',sessionObservationMode:'sierra_trading_day_v1'});try{
    mutate(f);const view=f.read();assert.equal(view.execution.status,'CURRENT_EXECUTION_UNVERIFIED');
    assert.equal(view.execution.completed_coverage_granted,false);assert.equal(view.completion,null);
  }finally{await f.close();}
});

test('a resealed caller logical version cannot replace the exact released logical context',async()=>{
  const f=await currentFixture({logicalVersion:'v0.1.1'});try{
    const caller=f.caller(),context={...caller.context,strategy_version:'v0.1.2'};
    context.context_hash=sealedHash(context,'context_hash');
    const storedPlan={...caller.storedPlan,context_hash:context.context_hash,
      operational_review:{...caller.storedPlan.operational_review,context}};
    storedPlan.plan_hash=sealedHash(storedPlan,'plan_hash');
    const plan={...caller.plan,...storedPlan};
    const view=readCurrentReplayExecution(f.configFile,{...caller,context,storedPlan,plan});
    assert.equal(view.status,'CURRENT_EXECUTION_UNVERIFIED');assert.equal(view.completed_coverage_granted,false);
  }finally{await f.close();}
});

for(const [time,phase] of [['2025-08-31 23:59:59','WARMUP'],['2025-09-01 00:00:00','SCORED_REPLAY'],
  ['2025-09-12 23:59:59','SCORED_REPLAY'],['2025-09-13 00:00:00','END_BOUNDARY_AWAITING_STOP']]) {
  test(`native chart boundary ${time} yields ${phase}, never completed coverage`,async()=>{
    const f=await currentFixture();try{
      changeJson(f.controllerFile,{currentChartDateTime:time});const view=f.read();
      assert.equal(view.execution.status,'CURRENT_RUNNING_VERIFIED');assert.equal(view.execution.phase,phase);
      assert.equal(view.execution.completed_coverage_granted,false);assert.equal(view.completion,null);assert.equal(view.completion_current,false);
    }finally{await f.close();}
  });
}

for(const [name,mutate] of [
  ['stale controller',f=>{const old=new Date(Date.now()-600000);fs.utimesSync(f.controllerFile,old,old);}],
  ['future controller',f=>{const future=new Date(Date.now()+60000);fs.utimesSync(f.controllerFile,future,future);}],
  ['paused',f=>changeJson(f.controllerFile,{replayStatus:2,chartReplayStatus:2})],
  ['stopped',f=>changeJson(f.controllerFile,{isReplayRunning:false,replayStatus:0,chartReplayStatus:0})],
  ['wrong controller command',f=>changeJson(f.controllerFile,{commandId:'other'})],
  ['wrong chart',f=>changeJson(f.controllerFile,{chartNumber:2})],
  ['beyond requested end',f=>changeJson(f.controllerFile,{currentChartDateTime:'2025-09-13 00:00:01'})],
  ['closed attempt',f=>f.sql.prepare("UPDATE replay_run_attempts SET attempt_ended_utc='2026-01-01'").run()],
  ['stopped attempt',f=>f.sql.prepare("UPDATE replay_run_attempts SET stop_command_id='other-stop'").run()],
  ['other run latest attempt',f=>f.otherLatestAttempt()],
  ['wrong logical context',f=>f.sql.prepare("UPDATE replay_run_context SET context_hash='wrong'").run()],
  ['missing source',f=>fs.unlinkSync(f.controllerFile)],
  ['historical activation only',f=>fs.unlinkSync(f.commandFile)],
])test(`persistent view falls back honestly for ${name}`,async()=>{
  const f=await currentFixture();try{
    mutate(f);const view=f.read();assert.equal(view.execution.status,'CURRENT_EXECUTION_UNVERIFIED');
    assert.equal(view.execution.completed_coverage_granted,false);assert.equal(view.completion,null);
  }finally{await f.close();}
});

test('repeated reads recover from stale proof only after actual fresh source bytes, not a cached bridge ACTIVE status',async()=>{
  const f=await currentFixture();try{
    fs.writeFileSync(f.config.state_file,JSON.stringify({status:'ACTIVE',run_id:f.runId,telemetry:{verified:true}}));
    const old=new Date(Date.now()-600000);fs.utimesSync(f.controllerFile,old,old);
    assert.equal(f.read().execution.status,'CURRENT_EXECUTION_UNVERIFIED');
    const now=new Date();fs.utimesSync(f.controllerFile,now,now);
    assert.equal(f.read().execution.status,'CURRENT_RUNNING_VERIFIED');
  }finally{await f.close();}
});

test('current view rejects a caller from another run/revision/plan scope and changed governance',async()=>{
  const f=await currentFixture();try{
    const original=f.caller();
    for(const caller of [{...original,run:{...original.run,id:'other-run'}},
      {...original,run:{...original.run,revision:99}},
      {...original,plan:{...original.plan,symbol:'MNQZ25_FUT_CME'}}])
      assert.equal(readCurrentReplayExecution(f.configFile,caller).status,'CURRENT_EXECUTION_UNVERIFIED');
    f.backend.runs.current=()=>{throw Object.assign(Error(),{code:'MOCK_RECONCILIATION_REQUIRED'});};
    assert.equal(f.read().execution.status,'CURRENT_EXECUTION_UNVERIFIED');
  }finally{await f.close();}
});

test('receipt changes during read are rejected without a write-side retry or native command',async()=>{
  const f=await currentFixture(),original=fs.readFileSync;try{
    let reads=0;fs.readFileSync=function(file,...args){
      const bytes=original.call(this,file,...args);
      if(String(file)===f.controllerFile && ++reads===2)return Buffer.from('{}');
      return bytes;
    };
    assert.equal(f.read().execution.status,'CURRENT_EXECUTION_UNVERIFIED');
  }finally{fs.readFileSync=original;await f.close();}
});

for(const [name,change] of [
  ['config',f=>changeJson(f.configFile,{expected_chart_number:2})],
  ['workflow',f=>f.backend.db.prepare("UPDATE ow_runs SET state='FAILED',revision=revision+1 WHERE id=?").run(f.runId)],
])test(`${name} changes after source verification prevent a current-running projection`,async()=>{
  const f=await currentFixture(),original=fs.readFileSync;try{
    let changed=false;
    fs.readFileSync=function(file,...args){
      const bytes=original.call(this,file,...args);
      // The source rereads the held start receipt after validating controller
      // bytes; inject an isolated concurrent writer before the final guards.
      if(String(file)===f.config.source_preflight_status_path && !changed
        && ++hookReads===2){changed=true;change(f);}
      return bytes;
    };
    let hookReads=0;
    assert.equal(f.read().execution.status,'CURRENT_EXECUTION_UNVERIFIED');assert.equal(changed,true);
  }finally{fs.readFileSync=original;await f.close();}
});

test('failed receipt reconciliation takes precedence over an otherwise fresh running source',async()=>{
  const f=await currentFixture();try{
    fs.writeFileSync(f.root+'/managed-failure-stop.json',JSON.stringify({run_id:f.runId,reason:'invalid'}));
    assert.equal(f.read().execution.status,'FAILURE_RECONCILIATION_UNVERIFIED');
  }finally{await f.close();}
});

// Native/governance data remain labelled mocks from currentFixture. These
// boundary checks use actual temporary SQLite writer and reader connections.
function blockPhysicalSource(f) {
  const target=f.backend.operationalLearning,descriptor=Object.getOwnPropertyDescriptor(target,'physicalBindingFile');
  let calls=0;
  Object.defineProperty(target,'physicalBindingFile',{configurable:true,get(){calls++;throw Error('MOCK_EXTERNAL_SOURCE_BLOCKED');}});
  return {calls:()=>calls,restore:()=>Object.defineProperty(target,'physicalBindingFile',descriptor)};
}

test('writer view defers both external readers; fresh authenticated GET after commit sees the new state',async()=>{
  const f=await currentFixture(),db=f.backend.db,reader=new DatabaseSync(f.config.workflow_db,{readOnly:true,timeout:50}),
    blocked=blockPhysicalSource(f);
  try{
    assert.equal(db.isTransaction,false);
    db.exec('BEGIN IMMEDIATE');assert.equal(db.isTransaction,true);
    db.prepare("UPDATE ow_runs SET state='ACTIVE',revision=revision+1 WHERE id=?").run(f.runId);
    const view=f.read();assert.equal(view.state,'ACTIVE');assert.equal(view.revision,3);
    assert.equal(view.execution.status,'CURRENT_EXECUTION_UNVERIFIED');
    assert.equal(view.execution.reason,'PHYSICAL_PROJECTION_DEFERRED_UNTIL_COMMIT');
    assert.match(view.execution.next_action,/fresh GET.*commits/);
    assert.equal(view.execution.completed_coverage_granted,false);assert.equal(blocked.calls(),0);
    assert.equal(reader.prepare('SELECT revision FROM ow_runs WHERE id=?').get(f.runId).revision,2);
    db.exec('COMMIT');assert.equal(db.isTransaction,false);blocked.restore();
    assert.equal(reader.prepare('SELECT revision FROM ow_runs WHERE id=?').get(f.runId).revision,3);
    const response=await f.request(`view/runs/${f.runId}`);assert.equal(response.status,200);
    const fresh=(await response.json()).manager;
    assert.equal(fresh.revision,3);assert.equal(fresh.execution.status,'CURRENT_RUNNING_VERIFIED');
    assert.equal(fresh.execution.completed_coverage_granted,false);
    assert.equal(fresh.execution.reason,undefined);
    f.sql.prepare("UPDATE replay_run_context SET context_hash='wrong'").run();
    const rejected=await f.request(`view/runs/${f.runId}`);
    assert.equal((await rejected.json()).manager.execution.status,'CURRENT_EXECUTION_UNVERIFIED');
  }finally{blocked.restore();if(db.isTransaction)db.exec('ROLLBACK');reader.close();await f.close();}
});

test('a genuinely locked temporary Telemetry database is never read for display inside the Workflow writer',async()=>{
  const f=await currentFixture(),db=f.backend.db;let reader;
  try{
    // Deterministic isolated lock, not a reproduction of the native WAL incident.
    f.sql.exec('PRAGMA journal_mode=DELETE');
    reader=new DatabaseSync(f.config.telemetry_db,{readOnly:true,timeout:20});
    f.sql.exec('BEGIN EXCLUSIVE');
    assert.throws(()=>reader.prepare('SELECT attempt_id FROM replay_run_attempts').all(),/database is locked/);
    db.exec('BEGIN IMMEDIATE');
    const view=f.read();assert.equal(view.execution.status,'CURRENT_EXECUTION_UNVERIFIED');
    assert.equal(view.execution.reason,'PHYSICAL_PROJECTION_DEFERRED_UNTIL_COMMIT');
    assert.equal(view.execution.completed_coverage_granted,false);
    db.exec('COMMIT');f.sql.exec('ROLLBACK');
    assert.equal(f.read().execution.status,'CURRENT_RUNNING_VERIFIED');
  }finally{if(db.isTransaction)db.exec('ROLLBACK');if(f.sql.isTransaction)f.sql.exec('ROLLBACK');reader?.close();await f.close();}
});

for(const state of ['COMPLETING','FAILED'])test(`sealed own-DB ${state} failure remains visible inside the writer without external projection`,async()=>{
  const f=await currentFixture(),db=f.backend.db,blocked=blockPhysicalSource(f);
  try{
    const body={schema_version:'ocean-operational-attempt-failure/v1',run_id:f.runId,context_hash:f.context.context_hash,
      plan_hash:f.storedPlan.plan_hash,failure_reason:'managed_completion_identity_failure',
      logger_attempt:{attempt_id:26,attempt_ended_utc:'2026-10-08T20:15:33Z'},retained_trade_count:0,retained_fill_count:0,
      full_requested_coverage_verified:false,completed_coverage_granted:false},proof={...body,proof_hash:objectHash(body)};
    // Mock already-retained event, not native stop/authority fabrication.
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE ow_runs SET state=?,revision=revision+1 WHERE id=?').run(state,f.runId);
    f.backend.event(f.runId,'run-manager.end',{id:'mock-producer',role:'TELEMETRY',namespace:'OPERATIONAL'},
      {outcome:'FAILED',failure_proof:proof});
    const view=f.read();assert.equal(view.state,state);assert.equal(view.execution.status,'FAILED_STOP_VERIFIED');
    assert.equal(view.execution.proof_hash,proof.proof_hash);assert.equal(view.execution.retained_trade_count,0);
    assert.equal(view.execution.full_requested_coverage_verified,false);assert.equal(blocked.calls(),0);
    assert.equal(view.execution.reconciliation_status,state==='FAILED'?'RECONCILED':'PENDING');
    db.exec('COMMIT');assert.equal(f.read().execution.proof_hash,proof.proof_hash);assert.equal(blocked.calls(),0);
  }finally{blocked.restore();if(db.isTransaction)db.exec('ROLLBACK');await f.close();}
});

test('stored completed receipt stays visible on the own connection while external projection is deferred',async()=>{
  const f=await currentFixture(),db=f.backend.db,blocked=blockPhysicalSource(f);
  try{
    const completion={run_id:f.runId,status:'COMPLETED',processing_event_count:0,observed_coverage:[f.storedPlan.selection.interval],
      completed_at_utc:new Date().toISOString(),no_trade_interval_count:1};
    // Mock completed history only: exercise display, not completion admission.
    db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE ow_runs SET state='COMPLETED',revision=revision+1 WHERE id=?").run(f.runId);
    db.prepare('INSERT INTO ow_coverage_receipts(run_id,coverage_key,status,payload_json) VALUES(?,?,?,?)')
      .run(f.runId,digest('mock-coverage'),'COMPLETED',JSON.stringify(completion));
    const view=f.read();assert.equal(view.state,'COMPLETED');assert.deepEqual(view.completion,completion);
    assert.equal(view.completion_current,true);assert.equal(view.execution.reason,'PHYSICAL_PROJECTION_DEFERRED_UNTIL_COMMIT');
    assert.equal(blocked.calls(),0);db.exec('COMMIT');
    const response=await f.request(`view/runs/${f.runId}`);assert.equal(response.status,200);
    const fresh=(await response.json()).manager;assert.deepEqual(fresh.completion,completion);assert.equal(fresh.completion_current,true);
    assert.equal(fresh.execution.reason,undefined);assert.equal(blocked.calls(),0);
  }finally{blocked.restore();if(db.isTransaction)db.exec('ROLLBACK');await f.close();}
});

test('writer display deferral never bypasses required failure-end proof or producer validation',async()=>{
  const f=await currentFixture(),db=f.backend.db,blocked=blockPhysicalSource(f),actor={id:'strategy',role:'TELEMETRY',namespace:'OPERATIONAL',
    strategyIds:['s'],instanceIds:['i'],scopes:['read','event.write']};
  try{
    const lease=f.backend.runs.perform('claim',actor,{run_id:f.runId,expected_revision:2});
    const data={run_id:f.runId,expected_revision:2,outcome:'FAILED',lease_id:lease.lease_id,failure_proof_hash:digest('mock-proof')};
    db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>f.backend.runs.perform('end',{...actor,id:'wrong-producer'},data),/OBSERVED_PRODUCER_REQUIRED/);
    assert.equal(blocked.calls(),0);
    assert.throws(()=>f.backend.runs.perform('end',actor,data),/MOCK_EXTERNAL_SOURCE_BLOCKED/);
    assert.equal(blocked.calls(),1);assert.equal(f.read().state,'ACTIVE');assert.equal(blocked.calls(),1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ow_events WHERE entity_id=? AND action='run-manager.end'").get(f.runId).n,0);
  }finally{blocked.restore();if(db.isTransaction)db.exec('ROLLBACK');await f.close();}
});

test('writer view still rejects an invalid sealed own-DB failure hash before any external getter',async()=>{
  const f=await currentFixture(),db=f.backend.db,blocked=blockPhysicalSource(f);
  try{
    db.exec('BEGIN IMMEDIATE');
    f.backend.event(f.runId,'run-manager.end',{id:'mock-producer',role:'TELEMETRY',namespace:'OPERATIONAL'},
      {outcome:'FAILED',failure_proof:{run_id:f.runId,proof_hash:digest('wrong')}});
    const view=f.read();assert.equal(view.execution.status,'FAILURE_RECONCILIATION_UNVERIFIED');
    assert.equal(view.execution.reason,'IMMUTABLE_FAILURE_PROOF_CONFLICT');assert.equal(blocked.calls(),0);
  }finally{blocked.restore();if(db.isTransaction)db.exec('ROLLBACK');await f.close();}
});
