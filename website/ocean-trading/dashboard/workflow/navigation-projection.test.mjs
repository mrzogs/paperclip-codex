import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {readWorkflowView} from './ui-api.mjs';

test('real run/case list API never hydrates slow evidence or current authority',()=>{
 const db=new DatabaseSync(':memory:');let leafCalls=0;
 const slow=()=>{leafCalls++;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);return {};};
 try{
  db.exec(`CREATE TABLE ow_strategies(id TEXT,payload_json TEXT);
    CREATE TABLE ow_runs(id TEXT,strategy_id TEXT,instance_id TEXT,state TEXT,revision INTEGER,context_json TEXT);
    CREATE TABLE ow_cases(id TEXT,strategy_id TEXT,instance_id TEXT,run_id TEXT,stage TEXT,work_status TEXT,revision INTEGER,owner_id TEXT,payload_json TEXT);
    CREATE TABLE ow_handoffs(case_id TEXT);`);
  db.prepare('INSERT INTO ow_strategies VALUES(?,?)').run('strategy-a',JSON.stringify({strategy_name:'Fixture'}));
  for(let i=0;i<75;i++){
   db.prepare('INSERT INTO ow_runs VALUES(?,?,?,?,?,?)').run(`run-${i}`,'strategy-a','sim','COMPLETED',i,JSON.stringify({run_id:`run-${i}`,execution_instance_id:'sim',expected_environment:'REPLAY',observed_source_state:{environment:'REPLAY'},evidence_purpose:'DISCOVERY'}));
   db.prepare('INSERT INTO ow_cases VALUES(?,?,?,?,?,?,?,?,?)').run(`case-${i}`,'strategy-a','sim',`run-${i}`,'RESEARCH_REVIEW','BLOCKED',i,'owner','not parsed');
  }
  const backend={db,one:(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),readRun:slow,readCase:slow,operationalLearning:{statusForRun:slow}};
  const actor={role:'HUMAN'},start=performance.now();
  const runs=readWorkflowView(backend,actor,'view/runs/page/0');
  const cases=readWorkflowView(backend,actor,'view/cases/page/0');
  assert.equal(leafCalls,0,'navigation must not call full run/case/evidence readers');
  assert.ok(performance.now()-start<250,'bounded in-memory navigation must not inherit leaf delays');
  assert.equal(runs.items.length,50);assert.equal(runs.total,75);assert.equal(runs.items[0].context.run_id,'run-74');
  assert.equal(cases.items.length,50);assert.equal(cases.total,75);
  assert.ok([...runs.items,...cases.items].every(row=>row.navigation_only===true&&row.qualification_state==='NOT_EVALUATED_IN_LIST'));
  assert.ok(runs.items.every(row=>row.manager===null&&row.learning===null&&row.protected_actions_allowed===false));
  assert.throws(()=>readWorkflowView(backend,{role:'TELEMETRY'},'view/runs/page/0'),/WAYNE_BROWSER_ONLY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ow_runs').get().n,75);
  const witness=Error('FULL_DETAIL_READER_REQUIRED');
  backend.readRun=()=>{throw witness;};backend.readCase=()=>{throw witness;};
  assert.throws(()=>readWorkflowView(backend,actor,'view/runs/run-74'),error=>error===witness);
  assert.throws(()=>readWorkflowView(backend,actor,'view/cases/case-74'),error=>error===witness);
 }finally{db.close();}
});
