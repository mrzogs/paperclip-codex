import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { OperationalResearch } from './operational-research.mjs';
import { OperationalLearning } from './operational-learning.mjs';
import { CONTINUATION_ORIGIN } from './operational-continuation.mjs';
import { readWorkflowView } from './ui-api.mjs';
import { digest, objectHash } from './common.mjs';

function fixture({insufficient=false,noChange=false,partial=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-planning-'));
  const filename=path.join(root,'workflow.sqlite');let store=new WorkflowStore(filename);
  const backend=Object.create(WorkflowBackend.prototype);
  const baseline=digest('baseline'),expiry=new Date(Date.now()+3600000).toISOString();
  const identity={identity_id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategy_ids:['s'],instance_ids:['i'],
    scopes:['read','artifact.write','event.write'],expires_at_utc:expiry};
  const recipient={...identity,identity_id:'strategy',role:'STRATEGY'};
  const actor={id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:identity.scopes};
  const human={id:'wayne-ocean-ui',role:'HUMAN'};
  Object.assign(backend,{db:store.db,store,config:{identities:[identity,recipient],browser:{subject_id:human.id}},environment:{},
    auth:{human:{state:'CONFIGURED'},bindingErrors:new Map()},validate:kind=>assert.equal(kind,'artifact-manifest'),runs:{managed:()=>false}});
  store.registerIdentity(identity);store.registerIdentity(recipient);
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',digest('profile'),JSON.stringify({profile_id:'p',profile_version:'1'}));
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,baseline,JSON.stringify({strategy_name:'Isolated planning fixture'}));
  backend.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s','{}');
  const runs=['r1','r2','r3'];
  const contexts=Object.fromEntries(runs.map(run_id=>[run_id,{run_id,context_hash:digest(`context-${run_id}`),strategy_profile_id:'p',
    strategy_profile_version:'1',strategy_code_hash:baseline,strategy_config_hash:digest('config'),dataset_manifest_id:'discovery',
    dataset_manifest_revision:1,dataset_manifest_hash:digest('dataset'),execution_instance_id:'i',expected_environment:'REPLAY'}]));
  for(const run of runs)backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run(run,'s','i','COMPLETED',JSON.stringify(contexts[run]));
  const bundle={policy:{project:'fixture',strategy_name:'Isolated planning fixture'},excluded_evidence:[],
    cohort:{eligible_runs:runs.map(run_id=>({run_id,context_hash:contexts[run_id].context_hash,observed_sample_count:20})),
      aggregate:{observed_sample_count:60}},research_coverage:Object.fromEntries(runs.map((run,index)=>[run,[{
        start_utc:`2025-0${index+1}-01T00:00:00Z`,end_utc:`2025-0${index+2}-01T00:00:00Z`}]]))};
  if(insufficient)bundle.research_coverage.r2=bundle.research_coverage.r1;
  const rows=runs.flatMap((run_id,index)=>Array.from({length:20},(_,i)=>({run_id,trade_id:index*100+i,
    entry_datetime:45000+index+i/24,direction:i<10?'long':'short',session_name:'UNKNOWN',regime_label:'UNKNOWN',
    gross_currency_value:i<10 || (noChange && index===1)?20:-10,total_commission:1,
    net_profit_loss:i<10 || (noChange && index===1)?19:-11,exit_causality:'unknown'})));
  if(partial)rows.find(row=>row.run_id==='r2' && row.direction==='long').direction='short';
  let proof=true;
  backend.operationalLearning={enabled:true,brainActor:()=>actor,statusForRun:()=>null,
    // Explicit mock-only qualification. These tests prove persistence/isolation, not physical execution.
    classification:()=>({eligible:proof,reasons:proof?[]:['PHYSICAL_STRATEGY_DLL_HASH_CONFLICT'],
      telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'}}),cohort:()=>bundle};
  backend.operationalResearch=new OperationalResearch(backend);
  const seed=(case_id,trigger='r1')=>{
    backend.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,?)")
      .run(case_id,'s','i',trigger,baseline,JSON.stringify({origin:'OPERATIONAL_LEARNING',registry_revision:1,
        registry_record_sha256:digest('registry'),registry_reconciliation_id:'registry'}));
    const artifact_id=`test-recommendation-${case_id}`,content=JSON.stringify({schema_version:'ocean-operational-learning-recommendation/v1',
      authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false}});
    backend.writeArtifact(actor,{artifact_id,case_id,run_id:trigger,recipient_id:'strategy',kind:'RECOMMENDATION',media_type:'application/json',
      content,content_hash:digest(content),candidate_hash:null,dependency_ids:[]});
    backend.store.transaction(()=>backend.operationalResearch.enqueue(case_id,artifact_id));
  };
  const capture=()=>{
    const worker=backend.operationalResearch,job=worker.claim();
    worker.evidence=()=>({rows,bundle,row:backend.one('ow_cases',job.case_id),
      context:JSON.parse(backend.one('ow_runs',backend.one('ow_cases',job.case_id).run_id).context_json),
      completion_hash:digest('completion'),recipient:'strategy'});
    return {job,result:worker.capture(job).result};
  };
  const complete=()=>{const {job,result}=capture();return backend.operationalResearch.complete(job,result,actor,'strategy');};
  seed('source');
  return {backend,actor,human,bundle,rows,seed,capture,complete,
    get worker(){return backend.operationalResearch;},setProof(value){proof=value;},
    children:()=>backend.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')=?").all(CONTINUATION_ORIGIN),
    restart(){store.close();store=new WorkflowStore(filename);backend.db=store.db;backend.store=store;backend.operationalResearch=new OperationalResearch(backend);},
    close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

function sealed(f) {
  const job=f.backend.db.prepare("SELECT * FROM ow_research_jobs WHERE case_id='source'").get();
  return {job,artifact:f.backend.one('ow_artifacts',job.result_artifact_id),source:f.backend.one('ow_cases','source')};
}
function assertSealed(f,before) {
  assert.deepEqual(f.backend.one('ow_research_jobs',before.job.id),before.job);
  assert.deepEqual(f.backend.one('ow_artifacts',before.artifact.id),before.artifact);
  assert.deepEqual(f.backend.one('ow_cases','source'),before.source);
}
function assertNoAuthority(f) {
  assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_approval_requests').get().n,0);
  assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_decisions').get().n,0);
  assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_handoffs').get().n,0);
  assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE kind IN ('CANDIDATE','BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT')").get().n,0);
}

test('supported completion atomically freezes an owned planning case/task and exposes linked real action',()=>{
  const f=fixture();try {
    const status=f.complete();assert.equal(status.state,'COMPLETED');assert.equal(status.loop_stage,'PROPOSAL_PLANNING');
    assert.equal(status.continuations.length,1);
    const child=f.children()[0],view=f.backend.readCase(f.human,child.id);
    assert.equal(view.namespace,'OPERATIONAL');assert.equal(view.owner_id,'brain');assert.equal(view.candidate_hash,null);
    assert.equal(view.planning.scope,'OWNED_PLANNING_ONLY');assert.equal(view.planning.approval_due,false);
    assert.equal(view.tasks[0].kind,'PROPOSAL_PLAN_REVIEW');assert.equal(view.tasks[0].status,'NOT_RUN');
    assert.match(view.next_action,/Owner brain:.*exact non-live development\/test\/comparison plan/);
    assert.match(status.next_action,new RegExp(child.id));
    const payload=JSON.parse(child.payload_json),artifact=f.backend.one('ow_artifacts',payload.lineage_artifact_id);
    const lineage=JSON.parse(Buffer.from(artifact.content).toString());
    assert.equal(lineage.source.report_hash,status.result_hash);assert.equal(lineage.source.input_hash,status.input_hash);
    assert.equal(objectHash(lineage.support),payload.support_hash);
    assert.equal(lineage.support.requirement.value,'short');assert.deepEqual(lineage.support.runs.map(run=>run.run_id),['r1','r2','r3']);
    assert.deepEqual(JSON.parse(artifact.dependencies_json),[],'typed source links, not cross-case dependency bypass');
    assert.equal(status.report.candidate_validation.status,'NOT_DUE');assertNoAuthority(f);
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_artifacts SET content='changed' WHERE id=?").run(artifact.id),/immutable workflow record/);
  }finally{f.close();}
});

test('insufficient coverage creates owned evidence work, not proposal/approval/candidate work',()=>{
  const f=fixture({insufficient:true});try {
    const status=f.complete();assert.equal(status.report.outcome,'INSUFFICIENT_EVIDENCE');
    assert.equal(status.report.historical_periods.distinct_coverage_count,2);
    assert.equal(status.report.screening_policy.minimum_distinct_declared_periods,3);
    assert.equal(status.loop_stage,'EVIDENCE_REQUIRED');
    const child=status.continuations[0];assert.equal(child.kind,'EVIDENCE_FOLLOW_UP');
    assert.equal(child.tasks[0].kind,'QUALIFIED_EVIDENCE_FOLLOW_UP');
    assert.match(child.next_action,/new qualified, governed non-live discovery evidence.*new Research evaluation/);
    assertNoAuthority(f);
  }finally{f.close();}
});

function thirdCoverage(f) {
  f.bundle.research_coverage.r2=[{start_utc:'2025-02-01T00:00:00Z',end_utc:'2025-03-01T00:00:00Z'}];
}
const progressCount=f=>f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.evidence.progress'").get().n;

test('later qualified third coverage resolves owned evidence work and links real Research, not candidate testing',()=>{
  for(const outcome of ['EXPLORATORY_PROPOSAL','NO_SUPPORTED_CHANGE']) {
    const f=fixture({insufficient:true});try {
      f.complete();const before=sealed(f),child=f.children()[0];thirdCoverage(f);
      if(outcome==='NO_SUPPORTED_CHANGE')for(const row of f.rows)if(row.run_id==='r2' && row.direction==='short') {
        row.gross_currency_value=20;row.net_profit_loss=19;
      }
      f.seed('third-coverage');const status=f.complete();assert.equal(status.report.outcome,outcome);
      const view=f.backend.readCase(f.human,child.id);
      assert.equal(view.work_status,'COMPLETED');assert.equal(view.tasks[0].status,'COMPLETED');
      assert.equal(view.planning.progress.status,'REASSESSED');assert.equal(view.planning.progress.source.case_id,'third-coverage');
      assert.equal(view.planning.progress.source.report_hash,status.result_hash);
      assert.match(view.next_action,/Open that Research case.*not candidate testing/);
      assert.equal(f.worker.statusForCase('source').loop_stage,outcome==='EXPLORATORY_PROPOSAL'?'PROPOSAL_PLANNING':'DIRECTION_SCREEN_NO_SUPPORTED_CHANGE');
      assert.equal(status.continuations.length,outcome==='EXPLORATORY_PROPOSAL'?1:0);
      const progress=f.backend.artifactFor(f.backend.one('ow_cases',child.id),view.tasks[0].artifact_id,'EVIDENCE');
      assert.deepEqual(JSON.parse(progress.dependencies_json),[JSON.parse(child.payload_json).lineage_artifact_id]);
      const closed=f.backend.one('ow_cases',child.id);f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
      assert.equal(progressCount(f),1);assert.deepEqual(f.backend.one('ow_cases',child.id),closed);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('later insufficient/partially assessed Research records monotonic progress but never falsely closes evidence work',()=>{
  for(const partial of [false,true]) {
    const f=fixture({insufficient:true});try {
      f.complete();const before=sealed(f),child=f.children()[0];
      if(partial) {thirdCoverage(f);f.rows.find(row=>row.run_id==='r2' && row.direction==='long').direction='short';}
      f.seed('still-short');f.complete();
      const view=f.backend.readCase(f.human,child.id);
      assert.equal(view.work_status,'READY');assert.equal(view.tasks[0].status,'NOT_RUN');
      assert.equal(view.planning.progress.status,'STILL_INSUFFICIENT');assert.match(view.next_action,/still reports evidence shortfalls/);
      const recorded=f.backend.one('ow_cases',child.id);f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
      assert.equal(progressCount(f),1);assert.deepEqual(f.backend.one('ow_cases',child.id),recorded);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('unqualified or incompatible later results cannot discharge a frozen evidence obligation',()=>{
  for(const mode of ['proof','config','registry']) {
    const f=fixture({insufficient:true});try {
      f.complete();const before=sealed(f),child=f.children()[0];thirdCoverage(f);
      if(mode==='config') {
        const run=f.backend.one('ow_runs','r1'),context=JSON.parse(run.context_json);
        Object.assign(context,{run_id:'r4',context_hash:digest('context-r4'),strategy_config_hash:digest('different-config')});
        f.backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('r4','s','i','COMPLETED',JSON.stringify(context));
        f.bundle.cohort.eligible_runs[0]={...f.bundle.cohort.eligible_runs[0],run_id:'r4',context_hash:context.context_hash};
        f.bundle.research_coverage.r4=f.bundle.research_coverage.r1;delete f.bundle.research_coverage.r1;
        for(const row of f.rows)if(row.run_id==='r1')row.run_id='r4';
      }
      f.seed('different',mode==='config'?'r4':'r1');
      if(mode==='registry') {
        const row=f.backend.one('ow_cases','different'),payload=JSON.parse(row.payload_json);
        payload.registry_record_sha256=digest('different-registry');
        f.backend.db.prepare('UPDATE ow_cases SET payload_json=? WHERE id=?').run(JSON.stringify(payload),'different');
      }
      if(mode==='proof') {f.worker.continuations.reconcileEvidence=()=>{};f.complete();f.setProof(false);}
      else f.complete();
      f.restart();f.worker.reconcile();f.worker.reconcile();
      assert.equal(f.backend.one('ow_cases',child.id).work_status==='COMPLETED',false);
      assert.equal(progressCount(f),0);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('evidence-progress failure rolls back new completion; restart retries frozen input exactly once',()=>{
  const f=fixture({insufficient:true});try {
    f.complete();const before=sealed(f),child=f.children()[0];thirdCoverage(f);f.seed('new-result');
    const {job,result}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-evidence-progress-'))throw Error('progress crash');return write(actor,data);};
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/progress crash/);
    assert.equal(f.backend.one('ow_research_jobs',job.id).state,'RUNNING');assert.equal(progressCount(f),0);
    assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');assert.equal(f.children().length,1);
    f.backend.writeArtifact=write;f.restart();f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    const resumed=f.worker.claim();assert.notEqual(resumed.lease_id,job.lease_id);
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/RESEARCH_LEASE_EXPIRED/);
    const frozen=f.worker.capture(resumed);assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    f.worker.complete(resumed,frozen.result,f.actor,'strategy');f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.equal(progressCount(f),1);assert.equal(f.backend.one('ow_cases',child.id).work_status,'COMPLETED');
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('reassessed evidence keeps its historical completion but loses current planning support when proof is revoked',()=>{
  const f=fixture({insufficient:true});try {
    f.complete();const before=sealed(f),child=f.children()[0];thirdCoverage(f);f.seed('reassessed');f.complete();
    const closed=f.backend.one('ow_cases',child.id);f.setProof(false);f.restart();f.worker.reconcile();
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.work_status,'COMPLETED');assert.equal(view.planning.qualified_for_planning,false);
    assert.match(view.next_action,/Preserve its recorded disposition/);
    assert.equal(f.worker.statusForCase('source').loop_stage,'BLOCKED_CONTINUATION');
    assert.deepEqual(f.backend.one('ow_cases',child.id),closed);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('fully assessed no-change is terminal only for the recorded screen; partial proposals hand off only supported rules',()=>{
  for(const options of [{noChange:true},{partial:true}]) {
    const f=fixture(options);try {
      const status=f.complete();
      if(options.noChange) {assert.equal(status.report.outcome,'NO_SUPPORTED_CHANGE');assert.equal(f.children().length,0);assert.deepEqual(status.continuations,[]);}
      else {assert.equal(status.report.evidence_sufficiency.assessment_complete,false);assert.equal(f.children().length,1);
        const payload=JSON.parse(f.children()[0].payload_json);
        const frozen=JSON.parse(Buffer.from(f.backend.one('ow_artifacts',payload.lineage_artifact_id).content).toString());
        assert.equal(frozen.support.requirement.value,'short');}
      assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('failure while persisting a continuation rolls back report/job completion; two-lease restart succeeds once',()=>{
  const f=fixture();try {
    const {job,result}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-research-lineage-'))throw Error('fixture crash');return write(actor,data);};
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/fixture crash/);
    assert.equal(f.backend.one('ow_research_jobs',job.id).state,'RUNNING');assert.equal(f.children().length,0);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE kind='OUTCOME'").get().n,0);
    f.backend.writeArtifact=write;f.restart();f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    const resumed=f.worker.claim();assert.notEqual(resumed.lease_id,job.lease_id);
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/RESEARCH_LEASE_EXPIRED/);
    const capture=f.worker.capture(resumed);assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    f.worker.complete(resumed,capture.result,f.actor,'strategy');
    f.restart();f.worker.reconcile();f.worker.reconcile();assert.equal(f.children().length,1);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_tasks').get().n,1);assert.equal(f.worker.claim(),null);assertNoAuthority(f);
  }finally{f.close();}
});

test('duplicate support reports coalesce, task recovery is idempotent and sealed sources are never rewritten',()=>{
  const f=fixture();try {
    f.complete();const before=sealed(f),child=f.children()[0],original=f.backend.one('ow_artifacts',JSON.parse(child.payload_json).lineage_artifact_id);
    f.seed('same-support');f.complete();assert.equal(f.children().length,1);
    assert.equal(f.worker.statusForCase('same-support').continuations[0].case_id,child.id);
    f.backend.db.prepare('DELETE FROM ow_tasks WHERE case_id=?').run(child.id);
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.equal(f.children().length,1);assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_tasks').get().n,1);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.continuation.link'").get().n,2);
    assert.deepEqual(f.backend.one('ow_artifacts',original.id),original);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('restart backfills qualified sealed current results additively but never historical or unqualified reports',()=>{
  for(const mode of ['qualified','unqualified','historical']) {
    const f=fixture();try {
      f.worker.continuations.ensure=()=>[];f.complete();
      if(mode==='unqualified')f.setProof(false);
      if(mode==='historical') {
        // Explicit historical-version fixture: older job versions never create support.
        f.backend.db.prepare("UPDATE ow_research_jobs SET analysis_version='ocean-cumulative-research/v2' WHERE case_id='source'").run();
      }
      const before=sealed(f);
      f.restart();
      f.worker.reconcile();f.worker.reconcile();
      assert.equal(f.children().length,mode==='qualified'?1:0);assertSealed(f,before);assert.equal(f.worker.claim(),null);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('stale physical proof blocks retained planning across restart without Research retries or source mutation',()=>{
  const f=fixture();try {
    f.complete();const before=sealed(f),child=f.children()[0];f.setProof(false);
    assert.equal(f.backend.readCase(f.human,child.id).work_status,'BLOCKED');
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    const view=f.backend.readCase(f.human,child.id);assert.equal(view.planning.blocked_reason,'CONTINUATION_CURRENT_PROVENANCE_REQUIRED');
    assert.equal(view.blockers[0].state,'OPEN');assert.match(view.next_action,/Owner brain: resolve/);
    assert.equal(f.worker.statusForCase('source').loop_stage,'BLOCKED_CONTINUATION');assert.equal(f.worker.claim(),null);assertSealed(f,before);
    f.setProof(true);f.worker.reconcile();assert.equal(f.backend.readCase(f.human,child.id).work_status,'READY');
    assert.equal(f.backend.readCase(f.human,child.id).blockers[0].state,'RESOLVED');assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('changed baseline, missing owner and preserved cancellation are owned fail-closed planning, not new authority',()=>{
  for(const mode of ['baseline','owner','cancelled']) {
    const f=fixture();try {
      f.complete();const before=sealed(f),child=f.children()[0];
      if(mode==='baseline')f.backend.db.prepare('UPDATE ow_strategies SET baseline_hash=?,revision=2 WHERE id=?').run(digest('different'),'s');
      if(mode==='owner')f.backend.config.identities[0].revoked=true;
      if(mode==='cancelled')f.backend.db.prepare("UPDATE ow_cases SET work_status='CANCELLED' WHERE id=?").run(child.id);
      f.restart();f.worker.reconcile();f.worker.reconcile();
      const view=f.backend.readCase(f.human,child.id);
      assert.equal(view.work_status,mode==='cancelled'?'CANCELLED':'BLOCKED');
      assert.equal(view.owner_id,'brain');assert.equal(f.children().length,1);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('registry proof drift is owned blocked planning, not indefinite Research retry; missing owner falls back explicitly',()=>{
  for(const mode of ['registry','owner']) {
    const f=fixture();try {
      if(mode==='registry')f.backend.operationalLearning.registryContext={record_sha256:digest('new-registry')};
      else {f.backend.config.identities[0].revoked=true;f.backend.auth.human.state='UNENROLLED';}
      const status=f.complete(),before=sealed(f);assert.equal(status.state,'COMPLETED');assert.equal(status.loop_stage,'BLOCKED_CONTINUATION');
      const child=f.children()[0];assert.equal(f.backend.readCase(f.human,child.id).work_status,'BLOCKED');
      if(mode==='owner')assert.equal(child.owner_id,'wayne-ocean-ui','named configured operator, not an invented service');
      f.restart();f.worker.reconcile();f.worker.reconcile();assert.equal(f.worker.claim(),null);assert.equal(f.children().length,1);
      assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('new operational planning is visible in existing read views but TEST service/human mutation routes cannot advance it',()=>{
  const f=fixture();try {
    f.complete();const child=f.children()[0];
    const list=readWorkflowView(f.backend,f.human,'view/cases');
    assert.equal(list.items.find(row=>row.case_id===child.id).planning.kind,'PROPOSAL_PLANNING');
    const view=readWorkflowView(f.backend,f.human,`view/cases/${child.id}`);
    assert.equal(view.namespace,'OPERATIONAL');assert.equal(view.tasks.length,1);assert.match(view.next_action,/Owner brain/);
    const testActor={...f.actor,namespace:'TEST'};
    assert.throws(()=>f.backend.readCase(testActor,child.id),/TEST_PLANNING_CASE_ACCESS_REJECTED/);
    for(const actor of [f.human,testActor,f.actor])for(const operation of ['case.transition','artifact.write','approval.request','task.result']) {
      assert.throws(()=>f.backend.mutate(operation,actor,{message_id:'test-denied',data:{case_id:child.id}}),/OPERATIONAL_PLANNING_MUTATION_NOT_ENABLED/);
    }
    assertNoAuthority(f);
  }finally{f.close();}
});

test('learning projection does not call an open owned continuation a completed whole loop',()=>{
  const f=fixture({insufficient:true});try {
    f.complete();const learner=Object.create(OperationalLearning.prototype);
    Object.assign(learner,{backend:f.backend,db:f.backend.db,registryContext:null,retry:new Map(),classification:()=>({eligible:true,reasons:[],telemetry:{}}),
      resultFor:()=>({result:{},callback:{status:'COMPLETED'},details:{conclusion_type:'RECOMMENDATION',continuation:{case_id:'source'}}})});
    const status=learner.statusForRun('r1');assert.equal(status.stage,'COMPLETE');assert.equal(status.loop_stage,'EVIDENCE_REQUIRED');
    assert.match(status.next_action,/Owner brain/);assert.equal(status.research.state,'COMPLETED');assertNoAuthority(f);
  }finally{f.close();}
});

test('actual source UI links owned progress and labels planning work without offering TEST mutations or claiming tests',()=>{
  const f=fixture();try {
    const research=f.complete(),child=f.children()[0];
    const source=fs.readFileSync(new URL('../public/workflow/ui.js',import.meta.url),'utf8');
    const helpers={section:(title,body)=>`${title}\n${body}`,facts:items=>items.map(([name,value])=>`${name}: ${value}`).join('\n'),
      table:(_headers,rows)=>rows.flat().join('\n'),esc:String,badge:String,human:String,link:(_type,id)=>id,
      heading:()=>'',button:(_action,label)=>`BUTTON:${label}`,hash:String,date:String,empty:String,timeline:()=>'',
      caseProgress:()=>'',approvalTable:()=>'',handoffList:()=>''};
    const panel=vm.runInNewContext(source.slice(source.indexOf('function researchPanel('),source.indexOf('function casePage('))+';researchPanel',helpers);
    assert.match(panel(research),/Owned continuation work/);assert.match(panel(research),new RegExp(child.id));assert.match(panel(research),/Owner brain/);
    const page=vm.runInNewContext(source.slice(source.indexOf('function casePage('),source.indexOf('function approvalPage('))+';casePage',
      {...helpers,researchPanel:()=>''});
    const data=readWorkflowView(f.backend,f.human,`view/cases/${child.id}`),html=page(data);
    assert.match(html,/Planning only; no candidate development or test permission/);assert.match(html,/Required planning work/);
    assert.match(html,/Candidate testing: NOT_DUE/);assert.doesNotMatch(html,/BUTTON:(Upload result|Pause|Resume|Retry)|Historical validation/);
    assertNoAuthority(f);
  }finally{f.close();}
});
