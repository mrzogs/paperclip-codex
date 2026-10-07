import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from './store.mjs';
import { digest, objectHash } from './common.mjs';
import { OperationalResearch, evaluateResearch } from './operational-research.mjs';

function sample() {
  const rows=['a','b','c'].flatMap((run_id,index)=>Array.from({length:20},(_,i)=>({
    run_id,trade_id:index*100+i,entry_datetime:45000+index+i/24,direction:i<10?'long':'short',
    session_name:'US',regime_label:'known',gross_currency_value:i<10?20:-10,total_commission:1,
    net_profit_loss:i<10?19:-11,exit_causality:i%2?'stop':'unknown',
  })));
  const bundle={cohort:{eligible_runs:['a','b','c'].map(run_id=>({run_id})),aggregate:{observed_sample_count:60}},
    excluded_evidence:[{run_id:'protected-holdout',exclusion_reason:'PROTECTED'}]};
  return {rows,bundle};
}

test('isolated real evaluator reconciles fees and screens only entry-time proposals',()=>{
  const {rows,bundle}=sample();const result=evaluateResearch(bundle,rows);
  assert.deepEqual(result.aggregate,{trades:60,gross_profit_loss:300,fees:60,net_profit_loss:240,
    wins:30,losses:30,flat:0,gross_wins:30,fee_flipped_wins:0});
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');
  assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].dimension,'direction');
  assert.equal(result.proposals[0].value,'short');assert.equal(result.missing_exit_attribution,30);
  assert.equal(result.candidate_validation.status,'NOT_DUE');assert.equal(result.authority.live_authorized,false);
  assert.ok(result.experiments.every(value=>value.dimension!=='exit_causality'));
});

test('mixed periods finish Research with no supported change rather than inventing a candidate',()=>{
  const {rows,bundle}=sample();for(const row of rows.filter(row=>row.run_id==='b' && row.direction==='short')) {
    row.gross_currency_value=10;row.net_profit_loss=9;
  }
  const result=evaluateResearch(bundle,rows);assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');
  assert.match(result.next_action,/No approval is pending/);
});

test('flat gross trades losing after fees count as net losses',()=>{
  const {rows,bundle}=sample();rows[0].gross_currency_value=0;rows[0].net_profit_loss=-1;
  rows[1].gross_currency_value=0.5;rows[1].net_profit_loss=-0.5;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.losses,32);assert.equal(result.aggregate.fee_flipped_wins,1);
});

test('original accounting, exact counts, isolation and duplicate failures block Research',()=>{
  const {rows,bundle}=sample();
  assert.throws(()=>evaluateResearch(bundle,[...rows,rows[0]]),/RESEARCH_DUPLICATE_TRADE/);
  assert.throws(()=>evaluateResearch(bundle,rows.slice(1)),/RESEARCH_SAMPLE_COUNT_CONFLICT/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],run_id:'protected-holdout'},...rows.slice(1)]),/RESEARCH_FOREIGN_EVIDENCE/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],net_profit_loss:null},...rows.slice(1)]),/RESEARCH_FEE_RECONCILIATION_FAILED/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],total_commission:99},...rows.slice(1)]),/RESEARCH_FEE_RECONCILIATION_FAILED/);
});

function queueFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-research-'));
  const file=path.join(root,'workflow.sqlite');let store=new WorkflowStore(file);
  const db=store.db;const hash=digest('baseline');
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',hash,'{}');
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,hash,'{}');
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s','{}');
  db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('r','s','i','COMPLETED','{}');
  db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,?)")
    .run('case','s','i','r',hash,JSON.stringify({origin:'OPERATIONAL_LEARNING'}));
  const content=JSON.stringify({schema_version:'ocean-operational-learning-recommendation/v1',
    authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false}});
  db.prepare('INSERT INTO ow_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('a','s','r','case','brain','strategy','RECOMMENDATION',null,hash,'[]',JSON.stringify({content_hash:digest(content)}),Buffer.from(content));
  const backend={db,store,one:(table,id)=>backend.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
    artifactFor:(_,id)=>backend.one('ow_artifacts',id),event(){},operationalLearning:{enabled:true}};
  let worker=new OperationalResearch(backend);
  return {backend,get worker(){return worker;},restart(){store.close();store=new WorkflowStore(file);backend.store=store;backend.db=store.db;worker=new OperationalResearch(backend);},
    close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('real SQLite queue commits before delivery and enqueues idempotently across restart',()=>{
  const f=queueFixture();try {
    const first=f.backend.store.transaction(()=>f.worker.enqueue('case','a'));
    f.restart();const again=f.worker.enqueue('case','a');assert.equal(first.id,again.id);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,1);
    assert.equal(again.state,'PENDING');
  }finally{f.close();}
});

test('real queue survives a crash after claim and reclaims only the expired lease',()=>{
  const f=queueFixture();try {
    f.worker.enqueue('case','a');const first=f.worker.claim();f.restart();
    assert.equal(f.worker.claim(),null);
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(first.id);
    const second=f.worker.claim();assert.equal(second.id,first.id);assert.notEqual(second.lease_id,first.lease_id);
    assert.equal(second.attempts,2);
    assert.throws(()=>f.worker.complete(first,{},null,null),/RESEARCH_LEASE_EXPIRED/);
  }finally{f.close();}
});

test('a real persisted retry resumes automatically without a human decision',()=>{
  const f=queueFixture();try {
    f.worker.enqueue('case','a');const first=f.worker.claim();f.worker.fail(first,new Error('TELEMETRY_DATABASE_REQUIRED'));
    f.restart();assert.equal(f.worker.claim(),null);
    assert.equal(f.worker.statusForCase('case').state,'RETRY');
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0').run();
    assert.equal(f.worker.claim().attempts,2);
  }finally{f.close();}
});

test('queue mutation rolls back with its caller transaction; unapproved authority is rejected',()=>{
  const f=queueFixture();try {
    assert.throws(()=>f.backend.store.transaction(()=>{f.worker.enqueue('case','a');throw Error('crash before ACK');}));
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,0);
    f.backend.db.prepare("UPDATE ow_cases SET payload_json='{}' WHERE id='case'").run();
    assert.throws(()=>f.worker.enqueue('case','a'),/RESEARCH_OPERATIONAL_CASE_REQUIRED/);
  }finally{f.close();}
});

test('captured Research input is immutable and reused after restart without rereading changed history',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();
    f.worker.evidence=()=>({rows,bundle,row:{strategy_id:'s'},context:{run_id:'r'},completion_hash:digest('completion'),recipient:'strategy'});
    f.worker.enqueue('case','a');const job=f.worker.claim();const first=f.worker.capture(job);
    f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0').run();
    const resumed=f.worker.claim();
    f.worker.evidence=()=>{throw Error('must not reread changed source');};
    assert.deepEqual(f.worker.capture(resumed),first);
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_research_jobs SET input_json='{}'").run(),/immutable Research input/);
  }finally{f.close();}
});

test('mock Brain crash-after-write resumes the exact persisted request and rejects invalid responses',async()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();bundle.policy={project:'project',strategy_name:'Strategy'};
    bundle.excluded_evidence[0].diagnostic='e'.repeat(60000);
    const evidence={bundle,row:{strategy_id:'s',run_id:'r'},context:{strategy_version:'1'},completion_hash:digest('completion')};
    const result=evaluateResearch(bundle,rows);const calls=[];
    const registry={record_sha256:digest('registry'),reconciliation_id:'registry-1'};
    f.backend.operationalLearning={enabled:true,path:'/protected-learning',token:()=> 'isolated-test-token',verifyIdentity:async()=>{},
      registry:async()=>registry,call:async(_path,_token,input)=>{calls.push(input);throw Error('connection lost after remote write');}};
    f.worker.enqueue('case','a');const job=f.worker.claim();
    await assert.rejects(f.worker.recordInBrain(job,evidence,result),/connection lost/);
    f.worker.fail(job,Error('outage'));f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0').run();
    const resumed=f.worker.claim();
    f.backend.operationalLearning.registry=async()=>{throw Error('request must not be rebuilt');};
    f.backend.operationalLearning.call=async(_path,_token,input)=>{
      calls.push(input);
      const content=JSON.stringify({registry_record_sha256:input.registry_record_sha256,registry_reconciliation_id:input.registry_reconciliation_id});
      return {schema_version:'ocean-operational-learning-result/v1',record_id:'mock-record',relative_path:'mock/record.json',
        content,content_sha256:digest(content),correlation:input.correlation,
        source_record_ids:['a','b','c','protected-holdout']};
    };
    assert.equal((await f.worker.recordInBrain(resumed,evidence,result)).record_id,'mock-record');
    assert.equal(objectHash(calls[0]),objectHash(calls[1]));
    assert.ok(calls[0].proposed_recommendation.content.length<=50000);
    assert.equal(calls[0].excluded_evidence[0].diagnostic.length,60000);
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_research_jobs SET brain_request_json='{}'").run(),/immutable Research request/);
    f.backend.operationalLearning.call=async()=>({content:'{}'});
    await assert.rejects(f.worker.recordInBrain(resumed,evidence,result),/RESEARCH_BRAIN_RESPONSE_INVALID/);
  }finally{f.close();}
});
