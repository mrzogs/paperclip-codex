import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { LEGACY_RESEARCH_VERSION, RESEARCH_VERSION, OperationalResearch, evaluateResearch } from './operational-research.mjs';
import { mockNativeProof } from './operational-native-sessions.test-fixtures.mjs';
import { RESEARCH_V5 } from './operational-research-protocol.mjs';
import { OperationalLearning } from './operational-learning.mjs';
import { CONTINUATION_ORIGIN } from './operational-continuation.mjs';
import { readWorkflowView } from './ui-api.mjs';
import { digest, objectHash } from './common.mjs';
import { consumePlanningOnce } from '../../../../scripts/consume-ocean-proposal-planning.mjs';

function fixture({insufficient=false,noChange=false,partial=false,prospective=false}={}) {
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
  const approvedPolicy={status:'APPROVED',policy_version:'1.0.0',minimum_comparable_trades:50,
    minimum_independent_sessions:20,maximum_data_quality_issues:0,contradictory_evidence_tolerance:0};
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',digest('profile'),JSON.stringify({profile_id:'p',profile_version:'1',
    ...(prospective?{evidence_policy:approvedPolicy}:{})}));
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,baseline,JSON.stringify({strategy_name:'Isolated planning fixture'}));
  backend.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s',JSON.stringify(prospective?{telemetry_producer_id:'telemetry'}:{}));
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
  const version=prospective?RESEARCH_VERSION:LEGACY_RESEARCH_VERSION;
  if(prospective) {
    bundle.research_coverage.r3[0].end_utc='2025-03-31T23:00:00Z';
    bundle.approved_evidence_policy=approvedPolicy;bundle.execution_sessions={};
    for(const [index,run_id] of runs.entries()) {
      bundle.execution_sessions[run_id]=mockNativeProof(contexts[run_id],rows.filter(row=>row.run_id===run_id),{month:index+1});
    }
  }
  let proof=true;
  backend.operationalLearning={enabled:true,brainActor:()=>actor,statusForRun:()=>null,
    // Explicit mock-only qualification. These tests prove persistence/isolation, not physical execution.
    classification:()=>({eligible:proof,reasons:proof?[]:['PHYSICAL_STRATEGY_DLL_HASH_CONFLICT'],
      telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'}}),cohort:()=>bundle};
  backend.operationalResearch=new OperationalResearch(backend);
  // Historical v4 continuation fixtures; prospective v5 has separate proof tests.
  backend.operationalResearch.version=version;
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
    restart(){store.close();store=new WorkflowStore(filename);backend.db=store.db;backend.store=store;backend.operationalResearch=new OperationalResearch(backend);backend.operationalResearch.version=version;},
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
    assert.match(child.next_action,/genuinely distinct, qualified non-live discovery coverage.*new Research evaluation/);
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
      else {assert.equal(status.report.evidence_sufficiency.assessment_complete,false);assert.equal(f.children().length,2);
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
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_tasks').get().n,2);assert.equal(f.worker.claim(),null);assertNoAuthority(f);
  }finally{f.close();}
});

test('duplicate support reports coalesce, task recovery is idempotent and sealed sources are never rewritten',()=>{
  const f=fixture();try {
    f.complete();const before=sealed(f),child=f.children()[0],original=f.backend.one('ow_artifacts',JSON.parse(child.payload_json).lineage_artifact_id);
    f.seed('same-support');f.complete();assert.equal(f.children().length,1);
    assert.equal(f.worker.statusForCase('same-support').continuations[0].case_id,child.id);
    f.backend.db.prepare('DELETE FROM ow_tasks WHERE case_id=?').run(child.id);
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.equal(f.children().length,1);assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_tasks').get().n,2);
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

const plans=f=>f.worker.continuations.plans;
function claimPlan(f,message='plan-claim'){
  const child=f.children()[0];
  return plans(f).perform('claim',f.actor,{message_id:message,data:{case_id:child.id,
    expected_revision:child.revision,support_hash:JSON.parse(child.payload_json).support_hash}});
}
function planInput(claim,message='plan-return'){
  return {message_id:message,data:{case_id:claim.case_id,expected_revision:claim.revision,
    support_hash:claim.support_hash,lease_id:claim.lease_id,
    plan:{...claim.template,planning_notes:'Checked source-bound direction exclusion; execution contracts remain unavailable.'}}};
}
const returnedCount=f=>f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.proposal.plan.returned'").get().n;

test('exact operational owner returns an immutable plan with observed scoped capability debt, never candidate PASS',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0];
    const queue=plans(f).queue(f.actor);assert.equal(queue.items.length,1);assert.equal(queue.items[0].status,'READY');
    const claim=claimPlan(f);assert.equal(claim.template.proposed_change.value,'short');
    assert.equal(claim.template.baseline.strategy_code_hash,child.baseline_hash);
    assert.equal(plans(f).read(f.actor,child.id).status,'IN_PROGRESS');
    const input=planInput(claim),result=plans(f).perform('plans',f.actor,input);
    assert.equal(result.planning_complete,true);assert.equal(result.approval_due,false);assert.equal(result.candidate_testing,'NOT_DUE');
    assert.deepEqual(result.missing_contracts,['SCOPED_CANDIDATE_TEST_DISPATCH']);assert.equal(plans(f).queue(f.actor).items.length,0);
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.planning.plan_work.status,'PLAN_RETURNED');assert.equal(view.tasks.find(task=>task.kind==='PROPOSAL_PLAN_REVIEW').status,'COMPLETED');
    assert.equal(view.stage,'RESEARCH');assert.equal(view.work_status,'READY');
    assert.equal(view.blockers.length,1);assert.ok(view.blockers.every(row=>row.owner_id==='brain' && row.state==='OPEN'));
    assert.match(view.next_action,/Source owner strategy.*plan authoring, not candidate execution/);
    const artifact=f.backend.artifactFor(f.backend.one('ow_cases',child.id),result.artifact_id,'RECOMMENDATION');
    assert.equal(artifact.producer_id,'brain');assert.equal(artifact.recipient_id,'strategy');
    assert.deepEqual(JSON.parse(artifact.dependencies_json),[JSON.parse(child.payload_json).lineage_artifact_id]);
    assert.deepEqual(plans(f).perform('plans',f.actor,input),result);assert.equal(returnedCount(f),1);
    const recorded=f.backend.one('ow_cases',child.id);f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.deepEqual(f.backend.one('ow_cases',child.id),recorded);assert.equal(returnedCount(f),1);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('planning claims/progress survive restart, reject competing and expired leases, and preserve exact request replay',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0],claim=claimPlan(f);
    assert.throws(()=>claimPlan(f,'other-claim'),/PROPOSAL_LEASE_HELD/);
    const progress={message_id:'plan-progress',data:{case_id:child.id,expected_revision:claim.revision,
      support_hash:claim.support_hash,lease_id:claim.lease_id,note:'Checking source contract prerequisites.'}};
    const recorded=plans(f).perform('progress',f.actor,progress);
    f.restart();assert.deepEqual(plans(f).perform('progress',f.actor,progress),recorded);
    const now=Date.now;try{
      Date.now=()=>recorded.lease_until_ms+1;
      const resumed=claimPlan(f,'new-lease');assert.notEqual(resumed.lease_id,claim.lease_id);
      assert.throws(()=>plans(f).perform('plans',f.actor,planInput({...claim,revision:resumed.revision})),/PROPOSAL_LEASE_EXPIRED/);
      plans(f).perform('plans',f.actor,planInput(resumed,'new-return'));
    }finally{Date.now=now;}
    assert.equal(returnedCount(f),1);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('planning return failure rolls back draft/blockers/task and retries exactly once after restart',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0],claim=claimPlan(f),input=planInput(claim);
    const event=f.backend.event.bind(f.backend);
    f.backend.event=(entity,action,...rest)=>{if(action==='operational.proposal.plan.returned')throw Error('plan return crash');return event(entity,action,...rest);};
    assert.throws(()=>plans(f).perform('plans',f.actor,input),/plan return crash/);
    assert.equal(returnedCount(f),0);assert.equal(f.backend.readCase(f.human,child.id).blockers.length,0);
    assert.equal(f.backend.one('ow_cases',child.id).revision,claim.revision);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE id LIKE 'test-proposal-plan-%'").get().n,0);
    f.backend.event=event;f.restart();plans(f).perform('plans',f.actor,input);plans(f).perform('plans',f.actor,input);
    assert.equal(returnedCount(f),1);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('plan work rejects TEST, wrong owner/role/scope, changed support, and caller-created execution authority',()=>{
  const f=fixture();try{
    f.complete();const child=f.children()[0],data={case_id:child.id,expected_revision:child.revision,
      support_hash:JSON.parse(child.payload_json).support_hash};
    for(const actor of [{...f.actor,namespace:'TEST'},{...f.actor,id:'strategy',role:'STRATEGY'},
      {...f.actor,role:'STRATEGY'},{...f.actor,scopes:['read','event.write']},f.human]){
      assert.throws(()=>plans(f).perform('claim',actor,{message_id:'bad-owner',data}),/PROPOSAL_|WRONG_ACTION_SCOPE/);
    }
    assert.throws(()=>plans(f).perform('claim',f.actor,{message_id:'bad-support',data:{...data,support_hash:digest('other')}}),/PROPOSAL_SUPPORT_CONFLICT/);
    const claim=claimPlan(f);
    for(const change of [plan=>{plan.authority.candidate_approved=true;},plan=>{plan.execution.status='AVAILABLE';},
      plan=>{plan.proposed_change.value='long';},plan=>{plan.protocol.tests[0].status='PASS';},
      plan=>{plan.baseline.strategy_code_hash=digest('different');},plan=>{plan.command='run arbitrary code';}]){
      const input=planInput(structuredClone(claim));change(input.data.plan);
      assert.throws(()=>plans(f).perform('plans',f.actor,input),/PROPOSAL_PLAN_BINDING_CONFLICT|UNKNOWN_OR_AUTHORITY_FIELD/);
    }
    assert.equal(returnedCount(f),0);assertNoAuthority(f);
  }finally{f.close();}
});

test('lost proof/owner/recipient/baseline blocks every new return and duplicate replay without changing sealed evidence',()=>{
  for(const mode of ['proof','owner','recipient','baseline','cancelled']){
    const f=fixture();try{
      f.complete();const before=sealed(f),child=f.children()[0],claim=claimPlan(f),input=planInput(claim);
      if(mode==='proof')f.setProof(false);
      if(mode==='owner')f.backend.config.identities[0].revoked=true;
      if(mode==='recipient')f.backend.config.identities[1].revoked=true;
      if(mode==='baseline')f.backend.db.prepare('UPDATE ow_strategies SET baseline_hash=? WHERE id=?').run(digest('changed'),'s');
      if(mode==='cancelled')f.backend.db.prepare("UPDATE ow_cases SET work_status='CANCELLED' WHERE id=?").run(child.id);
      assert.throws(()=>plans(f).perform('plans',f.actor,input),/CONTINUATION_|PROPOSAL_|BLOCKED_RECONCILIATION/);
      assert.equal(returnedCount(f),0);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
  const f=fixture();try{
    f.complete();const claim=claimPlan(f),input=planInput(claim);plans(f).perform('plans',f.actor,input);
    f.setProof(false);assert.throws(()=>plans(f).perform('plans',f.actor,input),/CONTINUATION_CURRENT_PROVENANCE_REQUIRED/);
    assert.equal(returnedCount(f),1);assertNoAuthority(f);
  }finally{f.close();}
});

test('insufficient/no-change/historical outcomes never enter the proposal queue or fabricate planning work',()=>{
  for(const options of [{insufficient:true},{noChange:true}]){
    const f=fixture(options);try{
      f.complete();assert.equal(plans(f).queue(f.actor).items.length,0);
      if(options.insufficient)assert.throws(()=>plans(f).read(f.actor,f.children()[0].id),/SUPPORTED_OPERATIONAL_PROPOSAL_REQUIRED/);
      assert.equal(returnedCount(f),0);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('operational plan HTTP route delegates only exact owned planning mutations and keeps generic TEST mutations denied',async()=>{
  const f=fixture();try{
    f.complete();const child=f.children()[0];
    f.backend.auth.authenticate=()=>f.actor;
    const invoke=async(route,body)=>{
      const request={method:body?'POST':'GET',headers:{'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'},
        async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}};
      let output;const response={setHeader(){},end(value){output=JSON.parse(value);},statusCode:200};
      await f.backend.handle(request,response,new URL(`http://127.0.0.1/api/workflow/operational/v1/${route}`));
      assert.equal(response.statusCode,200);return output;
    };
    assert.equal((await invoke('proposals/work')).items[0].case_id,child.id);
    const work=await invoke(`proposals/${child.id}/work`);
    const claim=await invoke('proposals/claim',{message_id:'http-claim',data:{case_id:child.id,
      expected_revision:work.revision,support_hash:work.support_hash}});
    const returned=await invoke('proposals/plans',planInput(claim,'http-return'));
    assert.equal(returned.planning_complete,true);assert.equal(returnedCount(f),1);
    assert.throws(()=>f.backend.mutate('approval.request',f.actor,{message_id:'test-no-approval',data:{case_id:child.id}}),/OPERATIONAL_PLANNING_MUTATION_NOT_ENABLED/);
    assertNoAuthority(f);
  }finally{f.close();}
});

function workerFixture(f){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-plan-consumer-'));
  const tokenFile=path.join(root,'owner.token'),stateFile=path.join(root,'work.json');
  const token='ocean_service_v1.brain.explicit-mock-credential-never-runtime';fs.writeFileSync(tokenFile,token);
  const fetch=async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,`Bearer ${token}`);
    const route=new URL(url).pathname.slice('/api/workflow/operational/v1/'.length);
    let result;
    try{
      if(route==='identity')result={identity:{id:f.actor.id,namespace:f.actor.namespace,role:f.actor.role,scopes:f.actor.scopes}};
      else if(route==='proposals/work')result=plans(f).queue(f.actor);
      else result=plans(f).perform(route.slice(10),f.actor,JSON.parse(options.body));
      return {ok:true,status:200,json:async()=>result};
    }catch(error){return {ok:false,status:error.status || 500,json:async()=>({error:error.code || 'fixture-transport'})};}
  };
  return {root,tokenFile,stateFile,fetch,token,options:{api:'http://127.0.0.1:4002',tokenFile,stateFile,fetch},
    close(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('real planning consumer returns exact owned brief once and reconciles lost successful responses after restart',async()=>{
  for(const lost of ['claim','plans',null]){
    const f=fixture(),w=workerFixture(f);try{
      f.complete();const before=sealed(f);let interrupted=false;
      const fetch=async(url,options)=>{
        const response=await w.fetch(url,options);
        if(!interrupted && lost && url.endsWith(`/proposals/${lost}`)){interrupted=true;throw Error('lost successful response');}
        return response;
      };
      await consumePlanningOnce({...w.options,fetch});
      f.restart();await consumePlanningOnce(w.options);await consumePlanningOnce(w.options);
      assert.equal(returnedCount(f),1);assert.equal(f.backend.readCase(f.human,f.children()[0].id).planning.plan_work.status,'PLAN_RETURNED');
      const state=fs.readFileSync(w.stateFile,'utf8');assert.equal(state.includes(w.token),false);
      assert.equal(Object.values(JSON.parse(state).work)[0].phase,'RETURNED');
      assertSealed(f,before);assertNoAuthority(f);
    }finally{w.close();f.close();}
  }
});

test('planning consumer does not claim blocked evidence or non-operational identity and never transports secrets off loopback',async()=>{
  const f=fixture(),w=workerFixture(f);try{
    f.complete();f.setProof(false);const result=await consumePlanningOnce(w.options);
    assert.equal(result.returned.length,0);assert.equal(result.blocked.length,1);assert.equal(returnedCount(f),0);
    await assert.rejects(consumePlanningOnce({...w.options,api:'https://external.invalid'}),/LOOPBACK_OCEAN_API_REQUIRED/);
    await assert.rejects(consumePlanningOnce({...w.options,fetch:async()=>({ok:true,json:async()=>({identity:{...f.actor,namespace:'TEST'}})})}),/PLANNING_WORKER_OWNER_SCOPE_REQUIRED/);
    assertNoAuthority(f);
  }finally{w.close();f.close();}
});

test('persistent Research reconciliation actually executes the owner planning worker and never repeats a returned draft',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0];
    assert.equal(returnedCount(f),0);f.worker.reconcile();
    assert.equal(returnedCount(f),1);const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.planning.plan_work.status,'PLAN_RETURNED');assert.equal(view.planning.plan_work.planning_complete,true);
    assert.equal(view.blockers.length,1);assert.match(view.next_action,/Source owner strategy/);
    const recorded=f.backend.one('ow_cases',child.id);f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.deepEqual(f.backend.one('ow_cases',child.id),recorded);assert.equal(returnedCount(f),1);
    f.backend.db.prepare('DELETE FROM ow_tasks WHERE case_id=?').run(child.id);f.worker.reconcile();
    const task=f.backend.readCase(f.human,child.id).tasks.find(task=>task.kind==='PROPOSAL_PLAN_REVIEW');assert.equal(task.status,'COMPLETED');
    assert.equal(task.artifact_id,view.planning.plan_work.returned.artifact_id);assert.equal(returnedCount(f),1);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('persistent worker failure leaves one bounded owner failure and resumes an expired claim after restart',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0];
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-proposal-plan-'))throw Error('worker crash');return write(actor,data);};
    f.worker.reconcile();f.worker.reconcile();assert.equal(returnedCount(f),0);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.proposal.plan.worker-blocked'").get().n,1);
    const lease=plans(f).forCase(f.backend.one('ow_cases',child.id)).lease;
    f.backend.writeArtifact=write;f.restart();const now=Date.now;
    try{Date.now=()=>Date.parse(lease.expires_at_utc)+1;f.worker.reconcile();}finally{Date.now=now;}
    assert.equal(returnedCount(f),1);f.worker.reconcile();assert.equal(returnedCount(f),1);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('automatic planning does not impersonate fallback operator or dispatch absent/revoked recipient and stale proof',()=>{
  for(const mode of ['operator','recipient','proof','paused']){
    const f=fixture();try{
      if(mode==='operator')f.backend.config.identities[0].revoked=true;
      f.complete();const before=sealed(f),child=f.children()[0];
      if(mode==='recipient')f.backend.config.identities[1].revoked=true;
      if(mode==='proof')f.setProof(false);
      if(mode==='paused')f.backend.db.prepare("UPDATE ow_cases SET work_status='PAUSED' WHERE id=?").run(child.id);
      f.worker.reconcile();f.restart();f.worker.reconcile();
      assert.equal(returnedCount(f),0);
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.proposal.plan.lease'").get().n,0);
      assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('returned plan retains immutable history but loses current support when its exact source owner is revoked',()=>{
  const f=fixture();try{
    f.complete();f.worker.reconcile();const before=sealed(f),child=f.children()[0];
    const returned=plans(f).forCase(child).returned,artifact=f.backend.one('ow_artifacts',returned.artifact_id);
    f.backend.config.identities[1].revoked=true;f.restart();f.worker.reconcile();
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.planning.qualified_for_planning,false);assert.equal(view.planning.plan_work.status,'BLOCKED');
    assert.equal(view.planning.plan_work.blocked_reason,'PROPOSAL_CURRENT_SOURCE_OWNER_REQUIRED');
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assert.equal(returnedCount(f),1);
    assert.equal(plans(f).queue(f.actor).items[0].status,'BLOCKED');assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('frozen sample debt remains owned design-review work after a third coverage arrives; supported direction can still plan',()=>{
  const f=fixture({insufficient:true,partial:true});try{
    const first=f.complete(),before=sealed(f),child=f.children()[0];
    assert.equal(first.report.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(first.loop_stage,'RESEARCH_DESIGN_REVIEW_REQUIRED');
    const original=f.backend.readCase(f.human,child.id);
    assert.equal(original.planning.evidence_remediation.requires_design_review,true);
    assert.match(original.next_action,/Owner brain.*long in r2 \(9\/10\).*Adding later runs cannot/);
    assert.equal(original.blockers[0].owner_id,'brain');assert.match(original.blockers[0].action,/author and test a prospective sampling-unit\/protocol revision under the existing engineering authorization/);
    thirdCoverage(f);f.seed('third-fixed-sample');const next=f.complete();
    assert.equal(next.report.outcome,'EXPLORATORY_PROPOSAL');assert.equal(next.report.historical_periods.distinct_coverage_count,3);
    assert.equal(next.continuations.length,2);assert.equal(next.loop_stage,'PROPOSAL_PLANNING');
    assert.equal(next.continuations.filter(item=>item.kind==='PROPOSAL_PLANNING').length,1);
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.work_status,'READY');assert.equal(view.tasks[0].status,'NOT_RUN');
    assert.equal(view.planning.progress.status,'STILL_INSUFFICIENT');
    assert.equal(view.planning.evidence_remediation.missing_distinct_coverage_count,0);
    assert.equal(view.planning.evidence_remediation.requires_design_review,true);
    assert.match(view.next_action,/Adding later runs cannot increase those frozen counts/);
    f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.equal(returnedCount(f),1,'only the separately supported direction has a planning draft');
    assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');
    assert.equal(f.backend.readCase(f.human,child.id).blockers.find(row=>row.id.endsWith(':sample-design')).state,'OPEN');
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('existing Learning maintenance route runs planning after startup with no extra launcher, including empty and duplicate queues',async()=>{
  for(const options of [{},{noChange:true}]){
    const f=fixture(options);try{
      f.complete();const before=sealed(f),learner=f.backend.operationalLearning;
      Object.assign(learner,{backend:f.backend,running:false,token:()=> 'explicit-mock-brain-access',
        verifyIdentity:async()=>{},registry:async()=>({}),pendingRun:()=>null,status:()=>({fixture:'EXPLICIT_MOCK_ONLY'})});
      await OperationalLearning.prototype.flushOnce.call(learner);
      const expected=options.noChange?0:1;assert.equal(returnedCount(f),expected);
      f.restart();await OperationalLearning.prototype.flushOnce.call(learner);
      await OperationalLearning.prototype.flushOnce.call(learner);
      assert.equal(returnedCount(f),expected);assert.equal(learner.running,false);
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.proposal.plan.lease'").get().n,expected);
      assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('v6 default captures approved eligibility/session proof separately and persistent planning freezes that lineage',()=>{
  const f=fixture({prospective:true});try {
    assert.equal(new OperationalResearch(f.backend).version,RESEARCH_VERSION);
    const status=f.complete();assert.equal(status.report.schema_version,RESEARCH_VERSION);
    assert.equal(status.report.outcome,'EXPLORATORY_PROPOSAL');assert.equal(status.report.approved_evidence_eligibility.status,'SUFFICIENT');
    const before=sealed(f),child=f.children()[0];f.worker.reconcile();
    const view=f.backend.readCase(f.human,child.id),plan=JSON.parse(Buffer.from(f.backend.one('ow_artifacts',view.planning.plan_work.returned.artifact_id).content).toString());
    assert.equal(plan.protocol.prospective_sampling_protocol.version,status.report.protocol.version);
    assert.equal(plan.protocol.approved_aggregate_evidence_policy.minimum_comparable_trades,50);
    assert.equal(plan.protocol.approved_aggregate_evidence_policy.minimum_independent_sessions,20);
    assert.equal(plan.execution.capabilities.find(item=>item.contract==='CANDIDATE_IMPLEMENTATION_AND_PHYSICAL_PIN').status,'NOT_YET_DUE');
    assert.equal(plan.execution.capabilities.find(item=>item.contract==='GOVERNED_DEVELOPMENT_DECISION').status,'NOT_YET_DUE');
    assert.deepEqual(plan.execution.missing_contracts,['SCOPED_CANDIDATE_TEST_DISPATCH']);
    assert.equal(view.planning.plan_work.planning_complete,true);assert.equal(view.planning.candidate_testing,'NOT_DUE');
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('observed capability changes append recoverable plan revisions, not frozen template rewrites or automatic decisions',()=>{
  const f=fixture();try {
    f.complete();const before=sealed(f);f.worker.reconcile();const child=f.children()[0];
    const first=plans(f).forCase(child).returned,oldArtifact=f.backend.one('ow_artifacts',first.artifact_id);
    f.backend.db.prepare('INSERT INTO ow_run_versions VALUES(?,?,?)').run('new-recorded-version','s',JSON.stringify({kind:'BASELINE',version:'EXPLICIT_MOCK_ONLY_NEW_REGISTRATION'}));
    assert.equal(plans(f).forCase(child).status,'REVISION_DUE');
    f.restart();f.worker.reconcile();const second=plans(f).forCase(f.backend.one('ow_cases',child.id)).returned;
    assert.notEqual(second.artifact_id,first.artifact_id);assert.equal(second.supersedes_artifact_id,first.artifact_id);
    assert.equal(returnedCount(f),2);assert.deepEqual(f.backend.one('ow_artifacts',oldArtifact.id),oldArtifact);
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();assert.equal(returnedCount(f),2);
    assertNoAuthority(f);assertSealed(f,before);
  }finally{f.close();}
});

test('a capability revision between claim and return fails closed, preserves the claim, and resumes after lease expiry',()=>{
  const f=fixture();try {
    f.complete();const claim=claimPlan(f),input=planInput(claim);
    f.backend.db.prepare('INSERT INTO ow_run_versions VALUES(?,?,?)').run('changed-registration','s',JSON.stringify({kind:'BASELINE',version:'EXPLICIT_MOCK_ONLY'}));
    assert.throws(()=>plans(f).perform('plans',f.actor,input),/PROPOSAL_CAPABILITIES_CHANGED/);
    assert.equal(returnedCount(f),0);f.restart();const now=Date.now;
    try{Date.now=()=>claim.lease_until_ms+1;f.worker.reconcile();}finally{Date.now=now;}
    assert.equal(returnedCount(f),1);assertNoAuthority(f);
  }finally{f.close();}
});

test('observed supported scoped capability clears only its engineering debt, not due candidate/decision work',()=>{
  const f=fixture();try {
    f.complete();f.worker.reconcile();const child=f.children()[0],old=plans(f).forCase(child).returned;
    const catalog=f.backend.operationalCandidateCapabilities();
    // Explicit mock only: production source still has no operational candidate dispatch adapter.
    f.backend.operationalCandidateCapabilities=()=>({...catalog,operational_candidate_test_dispatch:true,
      implementation_hash:digest('EXPLICIT_MOCK_ONLY_SUPPORTED_SCOPED_ADAPTER')});
    assert.equal(plans(f).forCase(child).status,'REVISION_DUE');f.worker.reconcile();
    const view=f.backend.readCase(f.human,child.id),current=view.planning.plan_work;
    const plan=JSON.parse(Buffer.from(f.backend.one('ow_artifacts',current.returned.artifact_id).content).toString());
    assert.deepEqual(plan.execution.missing_contracts,[]);assert.equal(plan.execution.status,'PLANNING_COMPLETE_EXECUTION_NOT_DUE');
    assert.match(current.next_action,/No current scoped capability gap is observed/);
    assert.doesNotMatch(current.next_action,/Implement the observed scoped candidate-test dispatch gap/);
    assert.notEqual(current.returned.artifact_id,old.artifact_id);
    assert.equal(view.blockers.filter(item=>item.state==='OPEN').length,0);
    assert.equal(view.tasks.find(item=>item.kind==='CANDIDATE_DISPATCH_ENGINEERING').status,'NOT_RUN');
    assert.equal(current.candidate_testing,'NOT_DUE');assert.equal(current.approval_due,false);assertNoAuthority(f);
  }finally{f.close();}
});

test('new exact session proof automatically queues/links one Research reassessment and closes evidence work after restart',()=>{
  const f=fixture({prospective:true});try {
    const native=structuredClone(f.bundle.execution_sessions);delete f.bundle.execution_sessions;
    const initial=f.complete();assert.equal(initial.report.outcome,'INSUFFICIENT_EVIDENCE');const before=sealed(f),child=f.children()[0];
    f.bundle.execution_sessions=native;
    const adapters=()=>{f.worker.sessionRows=run=>f.rows.filter(row=>row.run_id===run);f.worker.observedSessions=()=>f.bundle.execution_sessions;};
    adapters();f.worker.reconcile();
    const queue=f.backend.db.prepare("SELECT * FROM ow_research_jobs WHERE state='PENDING'").all();assert.equal(queue.length,1);
    assert.equal(JSON.parse(f.backend.one('ow_cases',queue[0].case_id).payload_json).origin,'OPERATIONAL_RESEARCH_REASSESSMENT');
    f.restart();adapters();f.worker.reconcile();f.worker.reconcile();
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE state='PENDING'").get().n,1);
    const status=f.complete();assert.equal(status.report.outcome,'EXPLORATORY_PROPOSAL');
    const view=f.backend.readCase(f.human,child.id);assert.equal(view.work_status,'COMPLETED');
    assert.equal(view.planning.progress.source.case_id,queue[0].case_id);assert.equal(view.planning.progress.status,'REASSESSED');
    assert.equal(view.tasks[0].status,'COMPLETED');assertSealed(f,before);assertNoAuthority(f);
    f.restart();adapters();f.worker.reconcile();assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE state='PENDING'").get().n,0);
  }finally{f.close();}
});

test('reassessment queue creation crash rolls back case/artifact/job and restart reconciles exactly once',()=>{
  const f=fixture({prospective:true});try {
    const native=structuredClone(f.bundle.execution_sessions);delete f.bundle.execution_sessions;f.complete();const before=sealed(f);
    f.bundle.execution_sessions=native;f.worker.sessionRows=run=>f.rows.filter(row=>row.run_id===run);f.worker.observedSessions=()=>native;
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-research-reassessment-'))throw Error('reassessment fixture crash');return write(actor,data);};
    f.worker.reconcile();f.worker.reconcile();assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE state='PENDING'").get().n,0);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_cases WHERE json_extract(payload_json,'$.origin')='OPERATIONAL_RESEARCH_REASSESSMENT'").get().n,0);
    f.backend.writeArtifact=write;f.restart();f.worker.sessionRows=run=>f.rows.filter(row=>row.run_id===run);f.worker.observedSessions=()=>native;
    f.worker.reconcile();f.worker.reconcile();assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE state='PENDING'").get().n,1);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('v6 restart resumes frozen unfinished v4 bytes as v4 without a recapture, backfill or new proposal work',()=>{
  const f=fixture();try {
    const {job}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    f.restart();f.worker.version=RESEARCH_VERSION;f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    f.worker.evidence=()=>{throw Error('must not recapture legacy evidence');};
    f.worker.reconcile();const claim=f.worker.claim();assert.equal(claim.id,job.id);assert.equal(claim.analysis_version,LEGACY_RESEARCH_VERSION);
    const captured=f.worker.capture(claim);assert.equal(captured.result.schema_version,LEGACY_RESEARCH_VERSION);
    f.worker.complete(claim,captured.result,f.actor,'strategy');assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    assert.equal(f.children().length,0);assert.equal(f.worker.statusForCase('source').historical,true);assertNoAuthority(f);
  }finally{f.close();}
});

test('v6 resumes a frozen unfinished v5 snapshot verbatim without recapture or current proposal support',()=>{
  const f=fixture({prospective:true});try {
    const old=f.backend.db.prepare('SELECT * FROM ow_research_jobs').get();
    const result={schema_version:RESEARCH_V5,eligible_run_ids:['r1','r2','r3'],outcome:'INSUFFICIENT_EVIDENCE',
      next_action:'EXPLICIT_MOCK_ONLY_FROZEN_V5_INSTRUCTION',proposals:[],authority:{automatic_strategy_change:false,
        candidate_approved:false,paper_authorized:false,live_authorized:false}};
    const input=JSON.stringify({result,evidence:{context:f.bundle.execution_sessions.r1.context}});
    f.backend.db.prepare(`UPDATE ow_research_jobs SET analysis_version=?,input_json=?,input_hash=? WHERE id=?`)
      .run(RESEARCH_V5,input,digest(input),old.id);
    for(let i=0;i<2;i++) {
      f.restart();f.worker.evidence=()=>{throw Error('must never recapture v5');};f.worker.reconcile();
      const job=f.worker.claim();assert.equal(job.analysis_version,RESEARCH_V5);
      assert.deepEqual(f.worker.capture(job).result,result);
      if(i===0)f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
      else f.worker.complete(job,result,f.actor,'strategy');
    }
    assert.equal(f.backend.one('ow_research_jobs',old.id).input_json,input);
    assert.equal(f.worker.statusForCase('source').historical,true);assert.equal(f.children().length,0);assertNoAuthority(f);
  }finally{f.close();}
});

test('current source has no fabricated native-session intake route and cannot turn a caller hook into proof',()=>{
  const f=fixture({prospective:true});try {
    const before=f.backend.db.prepare('SELECT COUNT(*) n FROM ow_events').get().n;
    assert.equal(typeof f.worker.observeSessions,'undefined');
    f.backend.verifyNativeSessionReceipt=()=>({verified:true,receipt_hash:digest('unsupported-caller-claim')});
    const proofs=OperationalResearch.prototype.observedSessions.call(f.worker,f.bundle,f.rows);
    assert.equal(proofs.r1.proof_error,'NATIVE_SESSION_DATABASE_REQUIRED');
    const result=evaluateResearch({...f.bundle,execution_sessions:proofs},f.rows);
    assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(result.approved_evidence_eligibility.observed_session_count,null);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_events').get().n,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('recorded Brain no-change queues real evidence Research once, not a fabricated recommendation or lost next action',()=>{
  const f=fixture({prospective:true});try {
    const run=f.backend.one('ow_runs','r3'),context=JSON.parse(run.context_json),details={conclusion_type:'NO_CHANGE',
      registry_record_sha256:digest('registry'),registry_reconciliation_id:'registry',finding:'EXPLICIT_MOCK_ONLY_NO_CHANGE'};
    const content=JSON.stringify(details),result={result_id:digest('recorded-learning-result'),run_id:run.id,
      context_hash:context.context_hash,producer_id:f.actor.id,content,content_sha256:digest(content)};
    f.backend.db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?,?,?,?,?)').run(result.result_id,f.actor.id,
      run.id,context.context_hash,digest('EXPLICIT_MOCK_REGISTERED_RESULT'),JSON.stringify(result),new Date().toISOString());
    const before=f.backend.db.prepare('SELECT * FROM ow_operational_brain_results WHERE id=?').get(result.result_id);
    const queued=f.worker.queueEvidenceReview(run,f.actor,result,details,f.bundle);
    assert.deepEqual(f.worker.queueEvidenceReview(run,f.actor,result,details,f.bundle),queued);
    const row=f.backend.one('ow_cases',queued.case_id),artifact=f.backend.one('ow_artifacts',queued.artifact_id);
    assert.equal(JSON.parse(row.payload_json).origin,'OPERATIONAL_RESEARCH_REASSESSMENT');assert.equal(artifact.kind,'EVIDENCE');
    assert.equal(JSON.parse(Buffer.from(artifact.content).toString()).basis,'DETERMINISTIC_RESEARCH_REQUIRED_NOT_A_FABRICATED_RECOMMENDATION');
    assert.equal(f.backend.readCase(f.human,row.id).namespace,'OPERATIONAL');
    assert.throws(()=>f.backend.mutate('approval.request',f.actor,{message_id:'test-no-internal-approval',data:{case_id:row.id}}),/OPERATIONAL_PLANNING_MUTATION_NOT_ENABLED/);
    assert.throws(()=>f.worker.queueEvidenceReview(run,f.actor,result,{...details,conclusion_type:'RECOMMENDATION'},f.bundle),/RESEARCH_SCOPED_LEARNING_RESULT_REQUIRED/);
    assert.deepEqual(f.backend.db.prepare('SELECT * FROM ow_operational_brain_results WHERE id=?').get(result.result_id),before);
    assertNoAuthority(f);
  }finally{f.close();}
});
