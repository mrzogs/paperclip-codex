import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
