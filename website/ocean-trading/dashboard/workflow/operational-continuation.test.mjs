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
import { REPORT_REFERENCE_VERSION } from './operational-research-report.mjs';
import { OperationalLearning } from './operational-learning.mjs';
import { CONTINUATION_ORIGIN } from './operational-continuation.mjs';
import { readWorkflowView } from './ui-api.mjs';
import { digest, objectHash } from './common.mjs';
import { consumePlanningOnce } from '../../../../scripts/consume-ocean-proposal-planning.mjs';
import { OperationalCandidateDispatch } from './operational-candidate-dispatch.mjs';

function fixture({insufficient=false,noChange=false,partial=false,prospective=false,oneDirection=null,rowsPerRun=20,
  ownerScopes=['read','artifact.write','event.write'],registerBaseline=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-planning-'));
  const filename=path.join(root,'workflow.sqlite');let store=new WorkflowStore(filename);
  const backend=Object.create(WorkflowBackend.prototype);
  const baseline=digest('baseline'),expiry=new Date(Date.now()+3600000).toISOString();
  const identity={identity_id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategy_ids:['s'],instance_ids:['i'],
    scopes:ownerScopes,expires_at_utc:expiry};
  const recipient={...identity,identity_id:'strategy',role:'STRATEGY'};
  const actor={id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:identity.scopes};
  const human={id:'wayne-ocean-ui',role:'HUMAN'};
  Object.assign(backend,{db:store.db,store,config:{identities:[identity,recipient],browser:{subject_id:human.id}},environment:{},
    auth:{human:{state:'CONFIGURED'},bindingErrors:new Map()},validate:kind=>assert.ok(['artifact-manifest','approval-decision','handoff'].includes(kind)),runs:{managed:()=>false}});
  store.registerIdentity(identity);store.registerIdentity(recipient);
  const approvedPolicy={status:'APPROVED',policy_version:'1.0.0',minimum_comparable_trades:50,
    minimum_independent_sessions:20,maximum_data_quality_issues:0,contradictory_evidence_tolerance:0};
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',digest('profile'),JSON.stringify({profile_id:'p',profile_version:'1',
    ...(prospective?{evidence_policy:approvedPolicy}:{})}));
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,baseline,JSON.stringify({strategy_name:'Isolated planning fixture'}));
  backend.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s',JSON.stringify(prospective?{telemetry_producer_id:'telemetry'}:{}));
  if(registerBaseline)backend.db.prepare('INSERT INTO ow_run_versions VALUES(?,?,?)').run('baseline-fixture','s',JSON.stringify({kind:'BASELINE',version:'v1',code_hash:baseline}));
  const runs=['r1','r2','r3'];
  const contexts=Object.fromEntries(runs.map(run_id=>[run_id,{run_id,context_hash:digest(`context-${run_id}`),strategy_profile_id:'p',
    strategy_profile_version:'1',strategy_code_hash:baseline,strategy_config_hash:digest('config'),dataset_manifest_id:'discovery',
    dataset_manifest_revision:1,dataset_manifest_hash:digest('dataset'),execution_instance_id:'i',expected_environment:'REPLAY'}]));
  for(const run of runs)backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run(run,'s','i','COMPLETED',JSON.stringify(contexts[run]));
  const bundle={policy:{project:'fixture',strategy_name:'Isolated planning fixture'},excluded_evidence:[],
    cohort:{eligible_runs:runs.map(run_id=>({run_id,context_hash:contexts[run_id].context_hash,observed_sample_count:rowsPerRun})),
      aggregate:{observed_sample_count:rowsPerRun*runs.length}},research_coverage:Object.fromEntries(runs.map((run,index)=>[run,[{
        start_utc:`2025-0${index+1}-01T00:00:00Z`,end_utc:`2025-0${index+2}-01T00:00:00Z`}]]))};
  if(insufficient)bundle.research_coverage.r2=bundle.research_coverage.r1;
  const rows=runs.flatMap((run_id,index)=>Array.from({length:rowsPerRun},(_,i)=>({run_id,trade_id:index*rowsPerRun+i,
    entry_datetime:45000+index+i/24,direction:i<rowsPerRun/2?'long':'short',session_name:'UNKNOWN',regime_label:'UNKNOWN',
    gross_currency_value:i<rowsPerRun/2 || (noChange && index===1)?20:-10,total_commission:1,
    net_profit_loss:i<rowsPerRun/2 || (noChange && index===1)?19:-11,exit_causality:'unknown'})));
  if(partial)rows.find(row=>row.run_id==='r2' && row.direction==='long').direction='short';
  if(oneDirection)for(const row of rows)Object.assign(row,{direction:oneDirection,gross_currency_value:-10,net_profit_loss:-11});
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
  backend.operationalCandidateDispatch=new OperationalCandidateDispatch(backend);
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
    restart(){store.close();store=new WorkflowStore(filename);backend.db=store.db;backend.store=store;backend.operationalResearch=new OperationalResearch(backend);backend.operationalResearch.version=version;backend.operationalCandidateDispatch=new OperationalCandidateDispatch(backend);},
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

function assertRiskReview(f,status) {
  const child=f.children().find(row=>JSON.parse(row.payload_json).kind==='RISK_DISABLE_REVIEW');
  assert.ok(child);const view=f.backend.readCase(f.human,child.id);
  assert.equal(view.namespace,'OPERATIONAL');assert.equal(view.owner_id,'brain');assert.equal(view.candidate_hash,null);
  assert.equal(view.planning.scope,'OWNED_RISK_REVIEW_ONLY');assert.equal(view.planning.qualified_for_planning,false);
  assert.equal(Boolean(view.planning.blocked_reason),false);assert.equal(view.planning.plan_work,null);
  assert.equal(view.planning.risk_review.disposition,'RISK_DISABLE_REVIEW_REQUIRED');
  assert.equal(view.planning.risk_review.retained_trades,0);assert.equal(view.planning.approval_due,false);
  assert.equal(view.tasks[0].kind,'RISK_DISABLE_REVIEW');assert.equal(view.tasks[0].status,'NOT_RUN');
  assert.match(view.next_action,/Owner brain: review the frozen .* direction loss observation/);
  assert.match(view.next_action,/Keep the baseline unchanged; no strategy disable, candidate, execution or human approval/);
  assert.match(status.next_action,new RegExp(child.id));
  const payload=JSON.parse(child.payload_json),artifact=f.backend.one('ow_artifacts',payload.lineage_artifact_id);
  const frozen=JSON.parse(Buffer.from(artifact.content).toString());
  assert.equal(artifact.kind,'EVIDENCE');assert.equal(frozen.source.report_hash,status.result_hash);
  assert.equal(frozen.source.input_hash,status.input_hash);assert.equal(objectHash(frozen.support),payload.support_hash);
  assert.equal(frozen.support.requirement.experiment_hash,objectHash(status.report.experiments[0]));
  assert.deepEqual(plans(f).queue(f.actor).items,[]);assert.equal(returnedCount(f),0);
  assertNoAuthority(f);return {child,artifact,view};
}

test('actual completion of a large mock-native cumulative report survives restart without clipping evidence',t=>{
  // Evidence/physical qualification are explicitly mocked; completion, artifact
  // size enforcement, transactions, immutable input and restart use real software.
  const f=fixture({prospective:true,rowsPerRun:500});try {
    const {job,result}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    const bytes=Buffer.byteLength(JSON.stringify({...result,job_id:job.id,case_id:job.case_id,
      source_recommendation_id:job.artifact_id,source_recommendation_hash:job.artifact_hash,
      completed_at_utc:new Date().toISOString()},null,2));
    assert.ok(bytes>128*1024);assert.equal(result.native_session_evidence.exit_audit.length,1500);
    t.diagnostic(JSON.stringify({report_bytes:bytes,cap_bytes:128*1024,scored_rows:f.rows.length,
      exit_audit_records:result.native_session_evidence.exit_audit.length,mocks:'EVIDENCE_AND_PHYSICAL_QUALIFICATION_ONLY'}));
    result.brain_record={record_id:'EXPLICIT_MOCK_BRAIN_RECEIPT',content_hash:digest('mock-record')};
    const status=f.worker.complete(job,result,f.actor,'strategy');
    assert.equal(status.state,'COMPLETED');assert.deepEqual(status.report.native_session_evidence.exit_audit,result.native_session_evidence.exit_audit);
    assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    const sealedResult=sealed(f),reference=JSON.parse(Buffer.from(sealedResult.artifact.content).toString());
    assert.equal(reference.schema_version,REPORT_REFERENCE_VERSION);
    assert.ok(Buffer.from(sealedResult.artifact.content).length<=128*1024);
    assert.equal(reference.full_report.content_hash,digest(JSON.stringify(status.report,null,2)));
    assert.equal(status.result_hash,digest(Buffer.from(sealedResult.artifact.content)));
    t.diagnostic(JSON.stringify({full_report_bytes:reference.full_report.bytes,
      outcome_artifact_bytes:Buffer.from(sealedResult.artifact.content).length,full_report_hash:reference.full_report.content_hash}));
    assert.notEqual(reference.full_report.content_hash,status.result_hash,'artifact and full-report hashes have explicit separate meanings');
    assert.equal(status.report.candidate_validation.status,'NOT_DUE');
    const planning=f.worker.continuations.plans.read(f.actor,status.continuations[0].case_id);
    assert.equal(planning.template.proposed_change.value,'short');
    assert.equal(planning.template.source.report_hash,status.result_hash);
    assert.deepEqual(f.worker.continuations.source(sealedResult.job).report,status.report);
    assert.deepEqual(f.backend.readCase(f.human,'source').research.report,status.report);
    f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.deepEqual(f.worker.statusForCase('source').report,status.report);assertSealed(f,sealedResult);assertNoAuthority(f);
    assert.throws(()=>f.backend.writeArtifact(f.actor,{artifact_id:'test-oversized-unrelated',case_id:'source',run_id:'r1',
      recipient_id:'strategy',kind:'OUTCOME',media_type:'application/json',content:JSON.stringify({data:'x'.repeat(128*1024)}),
      content_hash:digest('irrelevant'),candidate_hash:null,dependency_ids:[]}),/UNSAFE_ARTIFACT_TYPE_OR_SIZE/);
  }finally{f.close();}
});

test('large contradictory and insufficient reports retain full evidence and honest disposition after restart',()=>{
  for(const options of [{noChange:true},{insufficient:true}]) {
    const f=fixture({prospective:true,rowsPerRun:500,...options});try {
      const {job,result}=f.capture(),status=f.worker.complete(job,result,f.actor,'strategy');
      assert.equal(status.report.outcome,options.noChange?'NO_SUPPORTED_CHANGE':'INSUFFICIENT_EVIDENCE');
      for(const key of Object.keys(result))assert.deepEqual(status.report[key],result[key]);
      assert.equal(status.report.native_session_evidence.exit_audit.length,1500);
      if(options.noChange) {
        assert.deepEqual(status.report.experiments.find(item=>item.value==='short').contradictory_child_run_ids,['r2']);
        assert.equal(f.children().length,0);
      } else assert.equal(status.continuations[0].kind,'EVIDENCE_FOLLOW_UP');
      const before=sealed(f);f.restart();f.worker.reconcile();
      assert.deepEqual(f.worker.statusForCase('source').report,status.report);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('large completion rollback and renewed lease retry preserve full frozen input and older inline reports',()=>{
  const f=fixture({prospective:true});try {
    f.complete();const original=sealed(f);
    assert.equal(JSON.parse(Buffer.from(original.artifact.content).toString()).schema_version,RESEARCH_VERSION);
    f.bundle.excluded_evidence.push({run_id:'EXPLICIT_MOCK_EXCLUDED_HISTORY',exclusion_reason:'Retain contradiction '.repeat(7000)});
    f.seed('large-later');const {job,result}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.kind==='OUTCOME'){write(actor,data);throw Error('EXPLICIT_MOCK_CRASH_AFTER_OUTCOME_WRITE');}return write(actor,data);};
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/EXPLICIT_MOCK_CRASH_AFTER_OUTCOME_WRITE/);
    assert.equal(f.backend.one('ow_research_jobs',job.id).state,'RUNNING');
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE case_id='large-later' AND kind='OUTCOME'").get().n,0);
    f.backend.writeArtifact=write;f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    const resumed=f.worker.claim();assert.notEqual(resumed.lease_id,job.lease_id);
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/RESEARCH_LEASE_EXPIRED/);
    const snapshot=f.worker.capture(resumed);assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    const status=f.worker.complete(resumed,snapshot.result,f.actor,'strategy');
    assert.deepEqual(status.report.excluded_evidence,result.excluded_evidence);
    assert.equal(status.report.excluded_evidence[0].exclusion_reason.length,'Retain contradiction '.repeat(7000).length);
    assert.throws(()=>f.worker.complete(resumed,snapshot.result,f.actor,'strategy'),/RESEARCH_LEASE_EXPIRED/);
    f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.deepEqual(f.worker.statusForCase('large-later').report,status.report);assertSealed(f,original);assertNoAuthority(f);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE case_id='large-later' AND kind='OUTCOME'").get().n,1);
  }finally{f.close();}
});

test('large report worker retries the exact mock Brain request after completion failure and resumes across restart',async()=>{
  const f=fixture({prospective:true,rowsPerRun:500});try {
    // Only the Brain transport/identity/registry and evidence facts are mocked.
    // flushOnce/capture/recordInBrain/complete and SQLite remain production code.
    const {job}=f.capture(),input=f.backend.one('ow_research_jobs',job.id).input_json;
    f.worker.fail(job,Error('EXPLICIT_MOCK_PRE_BRAIN_INTERRUPTION'));
    const calls=[];
    Object.assign(f.backend.operationalLearning,{path:'/EXPLICIT_MOCK_ONLY',token:()=> 'mock-test-token',verifyIdentity:async()=>{},
      registry:async()=>({record_sha256:digest('registry'),reconciliation_id:'registry'}),
      call:async(_path,_token,request)=>{
        calls.push(request);
        const content=JSON.stringify({registry_record_sha256:request.registry_record_sha256,
          registry_reconciliation_id:request.registry_reconciliation_id});
        return {schema_version:'ocean-operational-learning-result/v1',record_id:'EXPLICIT_MOCK_RESEARCH_RECORD',
          relative_path:'EXPLICIT_MOCK_ONLY/result.json',content,content_sha256:digest(content),
          correlation:request.correlation,source_record_ids:['r1','r2','r3']};
      }});
    const write=f.backend.writeArtifact.bind(f.backend);
    f.backend.writeArtifact=(actor,data)=>{if(data.kind==='OUTCOME'){write(actor,data);throw Error('EXPLICIT_MOCK_COMPLETION_INTERRUPTION');}return write(actor,data);};
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0 WHERE id=?').run(job.id);
    await f.worker.flushOnce();
    const failed=f.backend.one('ow_research_jobs',job.id);
    assert.equal(failed.state,'RETRY');assert.equal(failed.last_error,'EXPLICIT_MOCK_COMPLETION_INTERRUPTION');
    assert.equal(failed.input_json,input);assert.ok(failed.brain_request_json);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE kind='OUTCOME'").get().n,0);
    assert.equal(f.children().length,0);f.backend.writeArtifact=write;f.restart();
    f.worker.evidence=()=>{throw Error('must use frozen evidence');};
    f.backend.operationalLearning.registry=async()=>{throw Error('must use frozen Brain request');};
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0 WHERE id=?').run(job.id);
    await f.worker.flushOnce();
    const status=f.worker.statusForCase('source'),completed=sealed(f);
    assert.equal(status.state,'COMPLETED');assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);
    assert.ok(calls[0].proposed_recommendation.content.length<=50000);
    assert.equal(status.report.brain_record.record_id,'EXPLICIT_MOCK_RESEARCH_RECORD');
    assert.equal(status.report.native_session_evidence.exit_audit.length,1500);
    assert.equal(completed.job.input_json,input);assert.equal(completed.job.brain_request_json,failed.brain_request_json);
    f.restart();await f.worker.flushOnce();assert.equal(calls.length,2);assertSealed(f,completed);assertNoAuthority(f);
  }finally{f.close();}
});

test('large report continuation comparisons resolve later evidence without rewriting the earlier reference',()=>{
  const f=fixture({prospective:true,insufficient:true,rowsPerRun:500});try {
    const first=f.complete(),before=sealed(f),child=first.continuations[0];
    assert.equal(first.report.outcome,'INSUFFICIENT_EVIDENCE');thirdCoverage(f);f.seed('large-qualified-later');
    const status=f.complete();assert.equal(status.report.outcome,'EXPLORATORY_PROPOSAL');
    const view=f.backend.readCase(f.human,child.case_id);
    assert.equal(view.work_status,'COMPLETED');assert.equal(view.planning.progress.status,'REASSESSED');
    assert.equal(view.planning.progress.source.report_hash,status.result_hash);
    assert.equal(view.planning.progress.source.case_id,'large-qualified-later');
    f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.equal(progressCount(f),1);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('large zero-exposure reports still require G21 risk-disable review, not candidate planning',()=>{
  const f=fixture({prospective:true,oneDirection:'long',rowsPerRun:500});try {
    const status=f.complete(),before=sealed(f);
    assert.equal(status.report.outcome,'NO_SUPPORTED_CHANGE');assert.equal(f.children().length,1);
    assert.equal(status.report.direction_exclusion_dispositions[0].retained_trades,0);
    assert.equal(status.report.direction_exclusion_dispositions[0].disposition,'RISK_DISABLE_REVIEW_REQUIRED');
    assert.equal(status.report.native_session_evidence.exit_audit.length,1500);
    assert.equal(status.report.candidate_validation.status,'NOT_DUE');
    const {child,artifact}=assertRiskReview(f,status);
    f.restart();f.worker.reconcile();assertSealed(f,before);assertNoAuthority(f);
    assert.deepEqual(f.backend.one('ow_cases',child.id),child);assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);
    assert.deepEqual(f.worker.statusForCase('source').report,status.report);
  }finally{f.close();}
});

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

test('prospective all-one-direction losses create no entry-filter planning work or candidate authority',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    const status=f.complete(),before=sealed(f);
    assert.equal(status.report.outcome,'NO_SUPPORTED_CHANGE');assert.deepEqual(status.report.proposals,[]);
    assert.equal(status.report.direction_exclusion_dispositions[0].disposition,'RISK_DISABLE_REVIEW_REQUIRED');
    assert.equal(status.report.candidate_validation.status,'NOT_DUE');assert.equal(f.children().length,1);
    assert.equal(status.loop_stage,'RISK_DISABLE_REVIEW_REQUIRED');const {child,artifact}=assertRiskReview(f,status);
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.equal(f.children().length,1);assertSealed(f,before);assertNoAuthority(f);
    assert.deepEqual(f.backend.one('ow_cases',child.id),child);assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);
  }finally{f.close();}
});

test('risk review coalesces duplicate support, recovers only its missing task and never invokes planning',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    const status=f.complete(),before=sealed(f),{child,artifact}=assertRiskReview(f,status);
    f.seed('duplicate-risk');f.complete();assert.equal(f.children().length,1);
    assert.equal(f.worker.statusForCase('duplicate-risk').continuations[0].case_id,child.id);
    f.backend.db.prepare('DELETE FROM ow_tasks WHERE case_id=?').run(child.id);
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.equal(f.children().length,1);assert.equal(f.backend.readCase(f.human,child.id).tasks.length,1);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.planning.created'").get().n,1);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.continuation.link'").get().n,2);
    assert.deepEqual(f.backend.one('ow_cases',child.id),child);assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_artifacts SET content='changed' WHERE id=?").run(artifact.id),/immutable workflow record/);
    assert.throws(()=>plans(f).read(f.actor,child.id),/SUPPORTED_OPERATIONAL_PROPOSAL_REQUIRED/);
    for(const actor of [f.human,{...f.actor,namespace:'TEST'},f.actor])
      for(const operation of ['case.transition','artifact.write','approval.request','task.result'])
        assert.throws(()=>f.backend.mutate(operation,actor,{message_id:'test-risk-denied',data:{case_id:child.id}}),/OPERATIONAL_PLANNING_MUTATION_NOT_ENABLED/);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('insufficient loss observation retains both risk review and independent evidence remediation',()=>{
  const f=fixture({prospective:true,oneDirection:'long',insufficient:true});try {
    const status=f.complete(),before=sealed(f);assert.equal(status.report.outcome,'INSUFFICIENT_EVIDENCE');
    assert.equal(status.loop_stage,'EVIDENCE_REQUIRED');assert.equal(f.children().length,2);
    const {child}=assertRiskReview(f,status);assert.equal(status.continuations.find(item=>item.case_id===child.id).risk_review.evidence_status,'INSUFFICIENT');
    assert.ok(status.continuations.some(item=>item.kind==='EVIDENCE_FOLLOW_UP' && item.evidence_remediation.status==='QUALIFIED_EVIDENCE_REQUIRED'));
    f.restart();f.worker.reconcile();assert.equal(f.children().length,2);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('profitable zero-remainder accounting and ordinary no-change do not invent risk-disable work',()=>{
  for(const options of [{prospective:true,oneDirection:'long'},{prospective:true,noChange:true}]) {
    const f=fixture(options);try {
      if(options.oneDirection)for(const row of f.rows)Object.assign(row,{gross_currency_value:20,net_profit_loss:19});
      const status=f.complete(),before=sealed(f);assert.equal(status.report.outcome,'NO_SUPPORTED_CHANGE');
      assert.deepEqual(f.children(),[]);assert.deepEqual(status.continuations,[]);
      f.restart();f.worker.reconcile();assert.deepEqual(f.children(),[]);assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('risk routing checks sealed disposition agreement and current source/owner proof rather than trusting a flag',()=>{
  const f=fixture({prospective:true,oneDirection:'long'});try {
    const {result}=f.capture(),c=f.worker.continuations;
    for(const mutate of [report=>report.direction_exclusion_dispositions=[],report=>report.hypotheses=[],
      report=>report.experiments[0].retained_exposure.retained_trades=1]) {
      const changed=structuredClone(result);mutate(changed);
      assert.throws(()=>c.items({report:changed}),/CONTINUATION_RISK_DISPOSITION_CONFLICT/);
    }
  }finally{f.close();}
  for(const mode of ['unqualified','owner','historical']) {
    const f=fixture({prospective:true,oneDirection:'short'});try {
      if(mode==='historical')f.worker.continuations.ensure=()=>[];
      const status=f.complete(),before=sealed(f);
      if(mode==='historical')f.backend.db.prepare("UPDATE ow_research_jobs SET analysis_version='ocean-cumulative-research/v5' WHERE id=?").run(before.job.id);
      if(mode==='unqualified')f.setProof(false);
      if(mode==='owner')f.backend.config.identities[0].revoked=true;
      const retained=sealed(f);f.restart();for(let i=0;i<3;i++)f.worker.reconcile();assertSealed(f,retained);
      if(mode==='historical')assert.equal(f.children().length,0);
      else {const view=f.backend.readCase(f.human,f.children()[0].id);assert.equal(view.work_status,'BLOCKED');
        assert.match(view.planning.blocked_reason,mode==='owner'?/OWNER_REQUIRED/:/PROVENANCE_REQUIRED/);
        assert.match(view.next_action,/Owner brain: resolve/);}
      assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('risk publication failure rolls back completion and retry seals exactly one review',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    const {job,result}=f.capture(),write=f.backend.writeArtifact.bind(f.backend),input=f.backend.one('ow_research_jobs',job.id).input_json;
    f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-research-lineage-'))throw Error('risk publication crash');return write(actor,data);};
    assert.throws(()=>f.worker.complete(job,result,f.actor,'strategy'),/risk publication crash/);
    assert.equal(f.children().length,0);assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,input);
    f.backend.writeArtifact=write;f.restart();f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    const resumed=f.worker.claim();f.worker.complete(resumed,JSON.parse(input).result,f.actor,'strategy');
    const status=f.worker.statusForCase('source');assertRiskReview(f,status);const before=sealed(f);
    f.restart();f.worker.reconcile();assert.equal(f.children().length,1);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('risk review cancellation is preserved rather than reopened or treated as an authorized disable',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    const status=f.complete(),{child,artifact}=assertRiskReview(f,status),before=sealed(f);
    // Disposable fixture of a separately recorded terminal disposition; this
    // does not introduce a browser mutation or fabricate a production review.
    f.backend.db.prepare("UPDATE ow_cases SET work_status='CANCELLED',revision=revision+1 WHERE id=?").run(child.id);
    const cancelled=f.backend.one('ow_cases',child.id);f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.deepEqual(f.backend.one('ow_cases',child.id),cancelled);assert.equal(f.children().length,1);
    const view=f.backend.readCase(f.human,child.id);assert.equal(view.work_status,'CANCELLED');
    assert.match(view.next_action,/Risk review is cancelled.*No strategy disable, candidate testing or approval is implied/);
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

function riskInput(f,caseId,message='risk-return',disposition='KEEP_BASELINE') {
  const row=f.backend.one('ow_cases',caseId);
  return {message_id:message,data:{case_id:caseId,expected_revision:row.revision,
    support_hash:JSON.parse(row.payload_json).support_hash,disposition,
    review_notes:'Reviewed the frozen zero-retained-exposure observation and its recorded child strata. No disable is authorized.'}};
}
function assertMachineRisk(f,child) {
  const view=f.backend.readCase(f.human,child.id),value=view.planning.risk_disposition;
  assert.equal(view.work_status,'COMPLETED');assert.equal(value.disposition,'EVIDENCE_LIMITED');
  assert.equal(value.review_method,'MACHINE_ZERO_EXPOSURE_EVIDENCE_QUALIFICATION_V1');
  assert.equal(value.reviewer_id,child.owner_id);assert.equal(value.disable_authorized,false);
  assert.match(value.review_notes,/^Machine evidence qualification; not a human review or substantive risk decision\./);
  const assessment=JSON.parse(value.review_notes.split('\n')[1]);
  assert.equal(assessment.unchanged_baseline_hash,child.baseline_hash);
  assert.equal(assessment.baseline_trades,view.planning.risk_review.baseline_trades);
  assert.equal(assessment.excluded_trades,assessment.baseline_trades);assert.equal(assessment.retained_trades,0);
  assert.equal(value.source.report_hash,assessment.source.report_hash);
  assert.equal(view.tasks[0].status,'COMPLETED');assert.equal(view.tasks[0].artifact_id,value.artifact_id);
  assert.equal(view.planning.qualified_for_planning,false);assertNoAuthority(f);
  return {view,value,assessment};
}

test('G28 existing website learning tick records only checked machine evidence limitation and survives reopen',async()=>{
  const f=fixture({prospective:true,oneDirection:'short',insufficient:true,ownerScopes:['read','artifact.write','case.transition','approval.request','delivery','event.write']});
  try {
    const status=f.complete(),before=sealed(f),{child,artifact}=assertRiskReview(f,status);
    f.backend.operationalLearning.brainActor=(strategy,instance)=>OperationalLearning.prototype.brainActor.call({backend:f.backend},strategy,instance);
    f.worker.recordInBrain=()=>{throw Error('No model or new Brain call is due for risk qualification');};
    const learner=Object.assign(Object.create(OperationalLearning.prototype),{enabled:true,running:false,backend:f.backend,
      token:()=> 'EXPLICIT_MOCK_TICK_IDENTITY',verifyIdentity:async()=>{},registry:async()=>({}),pendingRun:()=>null,status:()=>({})});
    await learner.flushOnce();
    const {value}=assertMachineRisk(f,child),closed=f.backend.one('ow_cases',child.id),receipt=f.backend.one('ow_artifacts',value.artifact_id);
    const expectedMessage=`risk-review:risk-evidence-${objectHash({method:value.review_method,case_id:child.id,
      owner_id:child.owner_id,support_hash:value.support_hash,report_hash:value.source.report_hash}).slice(7)}`;
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_inbox WHERE producer_id=? AND message_id=?').get(child.owner_id,expectedMessage).n,1);
    assert.equal(f.worker.statusForCase('source').loop_stage,'EVIDENCE_REQUIRED');
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assert.deepEqual(f.backend.one('ow_cases',child.id),closed);assert.deepEqual(f.backend.one('ow_artifacts',receipt.id),receipt);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.risk-review.recorded'").get().n,1);
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assertSealed(f,before);
    assert.equal(f.worker.continuations.riskEvidenceOnce().status,'NOT_DUE');
  }finally{f.close();}
});

test('G28 notes retain actual contradiction and native evidence gaps without closing separate evidence follow-up',()=>{
  for(const missingProof of [false,true]) {
  const f=fixture({prospective:true,oneDirection:'long'});try {
    const native=structuredClone(f.bundle.execution_sessions);
    for(const row of f.rows.filter(row=>row.run_id==='r2'))Object.assign(row,{gross_currency_value:20,net_profit_loss:19});
    if(missingProof)delete f.bundle.execution_sessions.r2;
    const status=f.complete(),before=sealed(f),{child}=assertRiskReview(f,status);
    const evidence=f.children().find(row=>JSON.parse(row.payload_json).kind==='EVIDENCE_FOLLOW_UP');
    f.worker.reconcile();const {value,assessment}=assertMachineRisk(f,child);
    assert.equal(assessment.aggregate_evidence.status,missingProof?'INSUFFICIENT':'SUFFICIENT');
    assert.equal(assessment.aggregate_evidence.reasons.includes('OBSERVED_EXECUTION_SESSION_PROOF_REQUIRED'),missingProof);
    assert.equal(assessment.aggregate_evidence.session_proof_gaps.count,missingProof?1:0);
    assert.deepEqual(assessment.aggregate_evidence.session_proof_gaps.sample,missingProof?['r2']:[]);
    assert.deepEqual(assessment.retained_contradictions.sample,['r2']);
    assert.equal(assessment.retained_contradictions.count,1);assert.equal(assessment.robustness.status,'CONTRADICTED');
    assert.deepEqual(assessment.contradiction_facts.sample,[{run_id:'r2',trades:20,net_profit_loss:380,observed_exclusion_delta:-380}]);
    if(missingProof)assert.deepEqual(f.backend.one('ow_cases',evidence.id),evidence);
    else assert.equal(evidence,undefined);
    assert.equal(f.worker.statusForCase('source').loop_stage,missingProof?'EVIDENCE_REQUIRED':'RISK_REVIEW_RECORDED');
    assert.match(value.review_notes,/unsampled entries.*exact immutable source report/);
    if(missingProof) {
      f.bundle.execution_sessions=native;
      f.worker.sessionRows=run=>f.rows.filter(row=>row.run_id===run);f.worker.observedSessions=()=>f.bundle.execution_sessions;
      f.worker.reconcile();
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE state='PENDING'").get().n,1);
    }
    assert.equal(f.backend.one('ow_cases',child.id).work_status,'COMPLETED');assertSealed(f,before);
  }finally{f.close();}
  }
});

test('G28 return rollback and lost committed response retry without duplicate completion or source mutation',()=>{
  for(const fault of ['artifact','event','inbox','readback','proof-drift','owner-drift','lost-response']) {
    const f=fixture({prospective:true,oneDirection:'short',insufficient:true});try {
      const status=f.complete(),before=sealed(f),{child}=assertRiskReview(f,status),c=f.worker.continuations;
      const write=f.backend.writeArtifact.bind(f.backend),event=f.backend.event.bind(f.backend),record=c.recordRiskDisposition.bind(c);
      if(fault==='artifact')f.backend.writeArtifact=(actor,data)=>{if(data.artifact_id.startsWith('test-risk-disposition-'))throw Error('EXPLICIT_MOCK_DISK_FAILURE');return write(actor,data);};
      if(fault==='event')f.backend.event=(entity,action,...args)=>{if(action==='operational.research.risk-review.recorded')throw Error('EXPLICIT_MOCK_RETURN_FAILURE');return event(entity,action,...args);};
      if(fault==='readback')f.backend.event=(entity,action,...args)=>event(entity,action,...(action==='operational.research.risk-review.recorded'
        ?[args[0],{...args[1],disposition:'KEEP_BASELINE'}]:args));
      if(fault==='inbox')f.backend.db.exec("CREATE TRIGGER mock_risk_inbox_failure BEFORE INSERT ON ow_inbox WHEN NEW.message_id LIKE 'risk-review:risk-evidence-%' BEGIN SELECT RAISE(ABORT,'EXPLICIT_MOCK_INBOX_FAILURE'); END");
      if(fault==='lost-response')c.recordRiskDisposition=(...args)=>{record(...args);throw Error('EXPLICIT_MOCK_LOST_COMMITTED_RESPONSE');};
      if(fault==='proof-drift')c.recordRiskDisposition=(...args)=>{f.setProof(false);return record(...args);};
      if(fault==='owner-drift')c.recordRiskDisposition=(...args)=>{f.backend.db.prepare('UPDATE ow_cases SET owner_id=? WHERE id=?').run('replacement-owner',child.id);return record(...args);};
      const result=c.riskEvidenceOnce();assert.equal(result.status,'RETRY');assert.equal(result.returned.length,0);
      if(fault!=='lost-response') {
        assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');
        assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE id LIKE 'test-risk-disposition-%'").get().n,0);
        assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_inbox WHERE message_id LIKE 'risk-review:risk-evidence-%'").get().n,0);
        const blocker=f.backend.db.prepare("SELECT * FROM ow_blockers WHERE id=?").get(`${child.id}:risk-worker`);
        assert.equal(blocker.owner_id,fault==='owner-drift'?'replacement-owner':child.owner_id);assert.equal(blocker.state,'OPEN');
        assert.equal(result.blocked[0].owner_id,blocker.owner_id);assert.match(blocker.action,new RegExp(`Owner ${blocker.owner_id}:`));
        c.riskEvidenceOnce();assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.risk-review.worker-blocked'").get().n,1);
      }
      f.backend.writeArtifact=write;f.backend.event=event;
      f.setProof(true);
      if(fault==='owner-drift')f.backend.db.prepare('UPDATE ow_cases SET owner_id=? WHERE id=?').run(child.owner_id,child.id);
      if(fault==='inbox')f.backend.db.exec('DROP TRIGGER mock_risk_inbox_failure');
      f.restart();f.worker.reconcile();const {value}=assertMachineRisk(f,child);
      const inbox=f.backend.db.prepare("SELECT * FROM ow_inbox WHERE message_id LIKE 'risk-review:risk-evidence-%'").get();
      const returned=JSON.parse(inbox.result_json),closed=f.backend.one('ow_cases',child.id);
      const notes=value.review_notes,input={message_id:inbox.message_id.slice('risk-review:'.length),
        data:{case_id:child.id,expected_revision:returned.revision-1,support_hash:returned.support_hash,
          disposition:'EVIDENCE_LIMITED',review_notes:notes}};
      assert.deepEqual(f.worker.continuations.recordRiskDisposition(f.actor,input,true),returned);
      f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
      assert.deepEqual(f.backend.one('ow_cases',child.id),closed);
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.risk-review.recorded'").get().n,1);
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_blockers WHERE case_id=? AND state='OPEN'").get(child.id).n,0);
      assertSealed(f,before);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('G28 sufficient zero-exposure without contradictions or shortfalls stays explicitly owned and unqualified',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    const status=f.complete(),before=sealed(f),{child}=assertRiskReview(f,status),c=f.worker.continuations;
    const result=c.riskEvidenceOnce();assert.equal(result.status,'UNQUALIFIED');assert.deepEqual(result.returned,[]);
    assert.equal(result.blocked[0].reason,'RISK_MACHINE_LIMITATION_NOT_ESTABLISHED');
    assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.risk-review.recorded'").get().n,0);
    const blocker=f.backend.db.prepare('SELECT * FROM ow_blockers WHERE id=?').get(`${child.id}:risk-worker`);
    assert.equal(blocker.owner_id,child.owner_id);assert.match(blocker.action,/genuine owner risk review remains due/);
    f.restart();f.worker.reconcile();assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');
    const returned=f.worker.continuations.recordRiskDisposition(f.actor,riskInput(f,child.id,'genuine-owner-return'));
    assert.equal(returned.disposition,'KEEP_BASELINE');assert.equal(returned.review_method,undefined);
    assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
  const limited=fixture({prospective:true,oneDirection:'short',insufficient:true});try {
    const status=limited.complete(),{child}=assertRiskReview(limited,status),c=limited.worker.continuations;
    const work=c.riskWork(limited.actor,child.id),source=c.source(limited.backend.one('ow_research_jobs',work.frozen.source.job_id));
    const changed=structuredClone(source);changed.report.proposals=[{dimension:'direction',value:'long',supported:true}];
    assert.throws(()=>c.riskEvidenceNotes(work.frozen,changed),/RISK_MACHINE_LIMITATION_NOT_ESTABLISHED/);
    assert.equal(limited.backend.one('ow_cases',child.id).work_status,'READY');assertNoAuthority(limited);
  }finally{limited.close();}
});

test('G28 wrong owner, revocation and stale/restored source remain owned retry work, never default decisions',()=>{
  for(const mode of ['wrong-owner','revoked','scope','proof','registry','baseline']) {
    const f=fixture({prospective:true,oneDirection:'short',insufficient:true});try {
      const status=f.complete(),before=sealed(f),{child}=assertRiskReview(f,status),identity=f.backend.config.identities[0];
      const select=f.backend.operationalLearning.brainActor;
      if(mode==='wrong-owner')f.backend.operationalLearning.brainActor=()=>({...f.actor,id:'other'});
      if(mode==='revoked')identity.revoked=true;
      if(mode==='scope')f.backend.operationalLearning.brainActor=()=>({...f.actor,scopes:['read','event.write']});
      if(mode==='proof')f.setProof(false);
      if(mode==='registry')f.backend.operationalLearning.registryContext={record_sha256:digest('drift')};
      if(mode==='baseline')f.backend.db.prepare('UPDATE ow_strategies SET baseline_hash=? WHERE id=?').run(digest('drift'),'s');
      const retained=sealed(f);f.restart();f.worker.reconcile();
      assert.notEqual(f.backend.one('ow_cases',child.id).work_status,'COMPLETED');
      const blocker=f.backend.db.prepare('SELECT * FROM ow_blockers WHERE id=?').get(`${child.id}:risk-worker`);
      assert.equal(blocker.owner_id,child.owner_id);assert.equal(blocker.state,'OPEN');assert.match(blocker.action,/No default risk decision or completion/);
      assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.research.risk-review.recorded'").get().n,0);
      f.backend.operationalLearning.brainActor=select;delete identity.revoked;f.setProof(true);delete f.backend.operationalLearning.registryContext;
      if(mode==='baseline')f.backend.db.prepare('UPDATE ow_strategies SET baseline_hash=? WHERE id=?').run(child.baseline_hash,'s');
      f.worker.reconcile();assertMachineRisk(f,child);assertSealed(f,retained);
      assert.deepEqual(before,retained);assertNoAuthority(f);
    }finally{f.close();}
  }
});

test('G28 empty queue is NOT_DUE and bounded rotation retries beyond an old blocked batch',()=>{
  const empty=fixture();try {
    const counts=()=>Object.fromEntries(['ow_cases','ow_events','ow_artifacts','ow_inbox','ow_blockers'].map(table=>[table,empty.backend.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
    const before=counts();assert.equal(empty.worker.continuations.riskEvidenceOnce().status,'NOT_DUE');assert.deepEqual(counts(),before);
  }finally{empty.close();}
  const f=fixture({prospective:true,oneDirection:'short',insufficient:true});try {
    for(let i=0;i<21;i++) {
      Object.assign(f.rows[0],{net_profit_loss:-11-i,gross_currency_value:-10-i});if(i)f.seed(`batch-risk-${i}`);f.complete();
    }
    assert.equal(f.children().filter(row=>JSON.parse(row.payload_json).kind==='RISK_DISABLE_REVIEW').length,21);f.setProof(false);
    const c=f.worker.continuations,first=c.riskEvidenceOnce(),second=c.riskEvidenceOnce();
    assert.equal(first.blocked.length,20);assert.equal(second.blocked.length,1);
    assert.equal(first.returned.length,0);assert.equal(second.returned.length,0);
    f.setProof(true);f.worker.reconcile();f.worker.reconcile();
    assert.equal(f.children().filter(row=>JSON.parse(row.payload_json).kind==='RISK_DISABLE_REVIEW' && row.work_status==='COMPLETED').length,21);
    assert.equal(c.riskEvidenceOnce().status,'NOT_DUE');assertNoAuthority(f);
  }finally{f.close();}
});

// The second scope set is the read-only CICD OPERATIONAL catalog observation
// from 2026-10-08; identity, session and qualification remain isolated fixtures.
for(const [scopeLabel,ownerScopes] of [
  ['minimum scopes',['read','artifact.write','event.write']],
  ['configured CICD catalog scopes',['read','artifact.write','case.transition','approval.request','delivery','event.write']],
])test(`real isolated HTTP risk-owner disposition closes only the risk task and replays byte-identically after restart (${scopeLabel})`,async()=>{
  const {createServer}=await import('node:http');
  const f=fixture({prospective:true,oneDirection:'short',ownerScopes});let server;
  try {
    const status=f.complete(),before=sealed(f),{child,artifact}=assertRiskReview(f,status);
    const pins=()=>Object.fromEntries(['ow_strategies','ow_profiles','ow_instances','ow_runs'].map(table=>[table,f.backend.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const originalPins=pins();let actor=OperationalLearning.prototype.brainActor.call({backend:f.backend},'s','i');
    assert.equal(actor.id,f.actor.id);assert.deepEqual(actor.scopes,ownerScopes);
    Object.assign(f.backend,{authFailureWindowMs:300000,authFailureThreshold:3,
      authFailureTotals:{401:0,403:0},authFailureBuckets:new Map()});
    // Authentication identity is an explicit fixture. Actual HTTP body parser,
    // scoped handler, authorization, transactions and SQLite execute unchanged.
    f.backend.auth.authenticate=()=>actor;
    server=createServer((request,response)=>void f.backend.handle(request,response,new URL(request.url,'http://127.0.0.1')));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/api/workflow/operational/v1/`;
    const invoke=async(route,input)=>{const response=await fetch(url+route,{signal:AbortSignal.timeout(5000),
      ...(input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{})});
      return {status:response.status,body:await response.json()};};
    const queued=await invoke('risk-reviews/work');assert.equal(queued.status,200);assert.equal(queued.body.items[0].case_id,child.id);
    const input=riskInput(f,child.id),returned=await invoke('risk-reviews/dispositions',input);
    assert.equal(returned.status,200);assert.equal(returned.body.risk_review_complete,true);assert.equal(returned.body.disable_authorized,false);
    const view=f.backend.readCase(f.human,child.id);assert.equal(view.work_status,'COMPLETED');
    assert.equal(view.tasks[0].status,'COMPLETED');assert.equal(view.tasks[0].artifact_id,returned.body.artifact_id);
    assert.equal(view.planning.risk_disposition.disposition,'KEEP_BASELINE');assert.equal(view.planning.qualified_for_planning,false);
    assert.match(view.next_action,/risk review recorded KEEP_BASELINE.*No strategy disable/);
    assert.equal(f.worker.statusForCase('source').loop_stage,'RISK_REVIEW_RECORDED');
    assert.deepEqual((await invoke('risk-reviews/work')).body.items,[]);
    const receipt=f.backend.one('ow_artifacts',returned.body.artifact_id),closed=f.backend.one('ow_cases',child.id);
    assert.equal(receipt.kind,'EVIDENCE');assert.deepEqual(JSON.parse(receipt.dependencies_json),[artifact.id]);
    assert.deepEqual((await invoke('risk-reviews/dispositions',input)).body,returned.body);
    f.restart();f.worker.reconcile();f.worker.reconcile();
    assert.deepEqual((await invoke('risk-reviews/dispositions',input)).body,returned.body);
    assert.deepEqual(f.backend.one('ow_cases',child.id),closed);assert.deepEqual(f.backend.one('ow_artifacts',receipt.id),receipt);
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assert.deepEqual(pins(),originalPins);
    const changed=structuredClone(input);changed.data.review_notes='Different disposition notes';
    assert.equal((await invoke('risk-reviews/dispositions',changed)).body.error.code,'DUPLICATE_CONFLICT');
    assert.equal((await invoke('risk-reviews/dispositions',{...input,message_id:'new-stale'})).body.error.code,'REVISION_CONFLICT');
    assert.equal((await invoke('risk-reviews/dispositions',riskInput(f,child.id,'new-closed'))).body.error.code,'RISK_REVIEW_DISPOSITION_HELD');
    actor={...f.actor,id:'different-owner'};assert.equal((await invoke('risk-reviews/dispositions',input)).body.error.code,'RISK_REVIEW_EXACT_OWNER_REQUIRED');
    actor=f.actor;f.setProof(false);
    assert.equal((await invoke('risk-reviews/dispositions',input)).body.error.code,'CONTINUATION_CURRENT_PROVENANCE_REQUIRED');
    assertSealed(f,before);assertNoAuthority(f);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));f.close();}
});

test('risk completion refuses TEST, wrong role/scope/support, authority fields, held state and missing return proof',()=>{
  const f=fixture({prospective:true,oneDirection:'short'});try {
    f.complete();const child=f.children()[0],input=riskInput(f,child.id),c=f.worker.continuations;
    for(const actor of [{...f.actor,namespace:'TEST'},{...f.actor,role:'STRATEGY'},f.human,
      {...f.actor,scopes:['read','event.write']},{...f.actor,strategyIds:['other']},{...f.actor,instanceIds:['other']}])
      assert.throws(()=>c.recordRiskDisposition(actor,input),/RISK_REVIEW_OPERATIONAL_BRAIN_REQUIRED|EXACT_OWNER_REQUIRED|WRONG_ACTION_SCOPE|WRONG_STRATEGY_SCOPE|WRONG_INSTANCE_SCOPE/);
    for(const data of [{...input.data,support_hash:digest('different')},{...input.data,disposition:'DISABLE_APPROVED'},
      {...input.data,review_notes:''},{...input.data,disable_authorized:true},{...input.data,human_approved:true}])
      assert.throws(()=>c.recordRiskDisposition(f.actor,{...input,data}),/SUPPORT_CONFLICT|DISPOSITION_REQUIRED|NOTES_REQUIRED|UNKNOWN_OR_AUTHORITY_FIELD/);
    f.backend.config.identities[0].revoked=true;
    assert.throws(()=>c.recordRiskDisposition(f.actor,input),/CURRENT_OWNER_REQUIRED/);delete f.backend.config.identities[0].revoked;
    f.backend.db.prepare("UPDATE ow_cases SET work_status='CANCELLED' WHERE id=?").run(child.id);
    assert.throws(()=>c.recordRiskDisposition(f.actor,input),/DISPOSITION_HELD/);
    f.backend.db.prepare("UPDATE ow_cases SET work_status='COMPLETED' WHERE id=?").run(child.id);
    assert.equal(f.backend.readCase(f.human,child.id).planning.blocked_reason,'RISK_REVIEW_RETURN_PROOF_REQUIRED');
    assert.throws(()=>c.recordRiskDisposition(f.actor,input),/RETURN_PROOF_REQUIRED/);
    assertNoAuthority(f);
  }finally{f.close();}
  const f2=fixture();try {
    f2.complete();const child=f2.children()[0];
    assert.throws(()=>f2.worker.continuations.recordRiskDisposition(f2.actor,riskInput(f2,child.id)),/OWNED_RISK_REVIEW_REQUIRED/);
  }finally{f2.close();}
});

test('risk return failure rolls back all closure evidence and evidence-limited review never closes the separate evidence task',()=>{
  const f=fixture({prospective:true,oneDirection:'long',insufficient:true});try {
    const status=f.complete(),before=sealed(f),{child,artifact}=assertRiskReview(f,status);
    const evidence=f.children().find(row=>JSON.parse(row.payload_json).kind==='EVIDENCE_FOLLOW_UP');
    const input=riskInput(f,child.id,'evidence-limited-risk','EVIDENCE_LIMITED'),event=f.backend.event.bind(f.backend);
    f.backend.event=(entity,action,...args)=>{if(action==='operational.research.risk-review.recorded')throw Error('risk closure crash');return event(entity,action,...args);};
    assert.throws(()=>f.worker.continuations.recordRiskDisposition(f.actor,input),/risk closure crash/);
    assert.equal(f.backend.one('ow_cases',child.id).work_status,'READY');
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_artifacts WHERE id LIKE 'test-risk-disposition-%'").get().n,0);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_inbox WHERE message_id LIKE 'risk-review:%'").get().n,0);
    f.backend.event=event;f.restart();const returned=f.worker.continuations.recordRiskDisposition(f.actor,input);
    assert.equal(returned.risk_review_complete,true);assert.equal(returned.disable_authorized,false);
    f.restart();f.worker.reconcile();assert.deepEqual(f.worker.continuations.recordRiskDisposition(f.actor,input),returned);
    assert.deepEqual(f.backend.one('ow_cases',evidence.id),evidence);assert.equal(f.worker.statusForCase('source').loop_stage,'EVIDENCE_REQUIRED');
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('old immutable zero-exposure proposal/report survives but cannot authorize a new planning draft',()=>{
  const f=fixture({oneDirection:'short'});try {
    // Explicit disposable mock of the pre-G21 continuation producer. It seals
    // the old v4 report and lineage without invoking current planning guards.
    const continuation=f.worker.continuations,items=continuation.items;
    continuation.items=source=>[{kind:'PROPOSAL_PLANNING',task_kind:'PROPOSAL_PLAN_REVIEW',requirement:source.report.proposals[0]}];
    f.complete();continuation.items=items;
    const before=sealed(f),child=f.children()[0],payload=JSON.parse(child.payload_json);
    const lineage=f.backend.one('ow_artifacts',payload.lineage_artifact_id);
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.planning.qualified_for_planning,false);
    assert.equal(view.planning.blocked_reason,'ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE');
    assert.equal(view.planning.candidate_testing,'NOT_DUE');assert.equal(view.planning.approval_due,false);
    assert.match(view.planning.next_action,/risk-disable|Risk-disable/);
    const planner=continuation.plans;
    assert.throws(()=>planner.read(f.actor,child.id),/ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE/);
    assert.equal(planner.queue(f.actor).items[0].status,'BLOCKED');
    assert.equal(planner.queue(f.actor).items[0].blocked_reason,'ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE');
    f.restart();for(let i=0;i<3;i++)f.worker.reconcile();
    assertSealed(f,before);assert.deepEqual(f.backend.one('ow_artifacts',lineage.id),lineage);
    assert.deepEqual(f.backend.one('ow_cases',child.id),child);assertNoAuthority(f);
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

function learningProjection(f,classification) {
  const learner=Object.create(OperationalLearning.prototype);
  Object.assign(learner,{backend:f.backend,db:f.backend.db,registryContext:null,retry:new Map(),classification,
    resultFor:()=>({result:{},callback:{status:'COMPLETED'},details:{conclusion_type:'RECOMMENDATION',continuation:{case_id:'source'}}})});
  return learner;
}

test('learning projection prioritizes missing current provenance over an open compatibility continuation',()=>{
  const f=fixture({insufficient:true});try {
    f.complete();const before=sealed(f),action='Owner provenance: resolve current physical/raw proof before continuing.';
    const learner=learningProjection(f,()=>({eligible:false,reasons:['CURRENT_PROVENANCE_MISSING'],
      telemetry:{verified:false,bypassed:false,required_action:action}}));
    const status=learner.statusForRun('r1');
    assert.equal(status.stage,'COMPLETE','The preserved callback is not rewritten');
    assert.equal(status.research.analysis_version,LEGACY_RESEARCH_VERSION);
    assert.equal(status.research.historical,false,'This fixture explicitly runs the v4 compatibility worker');
    assert.equal(status.recorded_loop_stage,'EVIDENCE_REQUIRED');
    assert.equal(status.loop_stage,'QUALIFICATION_REQUIRED');
    assert.equal(status.current_qualification_status,'QUALIFICATION_REQUIRED');
    assert.equal(status.current_provenance_qualified,false);assert.equal(status.next_action,action);
    assert.equal(status.historical_result.loop_stage,'EVIDENCE_REQUIRED');
    assert.equal(status.research.state,'COMPLETED');assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('learning projection keeps a current-qualified v6 open continuation evidence-required, not whole-loop complete',()=>{
  const f=fixture({prospective:true,insufficient:true});try {
    const classification=f.backend.operationalLearning.classification;
    // Explicit qualification fixture, not physical execution or an approval.
    f.backend.operationalLearning.classification=run=>{
      const current=classification(run);
      return {...current,telemetry:{verified:current.eligible,bypassed:false,proof_basis:'EXPLICIT_MOCK_ONLY',
        ...(!current.eligible?{required_action:'Owner provenance: restore exact current physical/raw proof.'}:{})}};
    };
    f.complete();const before=sealed(f),child=f.children()[0];
    const learner=learningProjection(f,f.backend.operationalLearning.classification);
    const checkCurrent=()=>{
      const status=learner.statusForRun('r1');
      assert.equal(status.stage,'COMPLETE');assert.equal(status.loop_stage,'EVIDENCE_REQUIRED');
      assert.equal(status.recorded_loop_stage,'EVIDENCE_REQUIRED');assert.equal(status.current_qualification_status,'CURRENT');
      assert.equal(status.current_provenance_qualified,true);assert.equal(status.historical_result,null);
      assert.equal(status.research.analysis_version,RESEARCH_VERSION);assert.equal(status.research.historical,false);
      assert.equal(status.research.qualified_for_new_support,true);assert.equal(status.research.state,'COMPLETED');
      assert.equal(status.next_action,status.research.next_action);assert.match(status.next_action,/Owner brain/);
      assert.ok(status.next_action.includes(child.id));assert.notEqual(status.loop_stage,'COMPLETE');
    };
    checkCurrent();
    f.setProof(false);const blocked=learner.statusForRun('r1');
    assert.equal(blocked.loop_stage,'QUALIFICATION_REQUIRED');
    assert.equal(blocked.current_provenance_qualified,false);
    assert.equal(blocked.next_action,'Owner provenance: restore exact current physical/raw proof.');
    f.setProof(true);checkCurrent();assertSealed(f,before);assertNoAuthority(f);
  }finally{f.close();}
});

test('learning projection treats a completed legacy report as historical even with current physical qualification',()=>{
  const f=fixture({insufficient:true});try {
    f.complete();const before=sealed(f);
    f.worker.version=RESEARCH_VERSION;
    const learner=learningProjection(f,()=>({eligible:true,reasons:[],
      telemetry:{verified:true,bypassed:false,proof_basis:'EXPLICIT_MOCK_ONLY'}}));
    const status=learner.statusForRun('r1');
    assert.equal(status.stage,'COMPLETE');assert.equal(status.current_provenance_qualified,true);
    assert.equal(status.research.analysis_version,LEGACY_RESEARCH_VERSION);assert.equal(status.research.state,'COMPLETED');
    assert.equal(status.research.historical,true);assert.equal(status.research.qualified_for_new_support,false);
    assert.equal(status.loop_stage,'QUALIFICATION_REQUIRED');
    assert.equal(status.current_qualification_status,'QUALIFICATION_REQUIRED');
    assert.equal(status.historical_result.loop_stage,status.recorded_loop_stage);
    assert.equal(status.next_action,status.research.next_action);
    assert.match(status.next_action,/Historical Research is completed and preserved/);
    assert.match(status.next_action,/provenance owner/);assert.doesNotMatch(status.next_action,/Owner brain: obtain/);
    assertSealed(f,before);assertNoAuthority(f);
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
    const fullReportLink=source.slice(source.indexOf('const fullReportLink ='),source.indexOf('\n',source.indexOf('const fullReportLink =')));
    const panel=vm.runInNewContext(fullReportLink+'\n'+source.slice(source.indexOf('function researchPanel('),source.indexOf('function casePage('))+';researchPanel',helpers);
    assert.match(panel(research),/Owned continuation work/);assert.match(panel(research),new RegExp(child.id));assert.match(panel(research),/Owner brain/);
    assert.ok(panel(research).includes(`/improvement/artifacts/${research.result_artifact_id}#full-research-report`));
    const page=vm.runInNewContext(source.slice(source.indexOf('function casePage('),source.indexOf('function approvalPage('))+';casePage',
      {...helpers,researchPanel:()=>''});
    const data=readWorkflowView(f.backend,f.human,`view/cases/${child.id}`),html=page(data);
    assert.match(html,/Planning only; no candidate development or test permission/);assert.match(html,/Required planning work/);
    assert.match(html,/Candidate testing: NOT_DUE/);assert.doesNotMatch(html,/BUTTON:(Upload result|Pause|Resume|Retry)|Historical validation/);
    assertNoAuthority(f);
  }finally{f.close();}
});

const plans=f=>f.worker.continuations.plans;
test('isolated Chrome links the actual owned risk review, retains it across restart and offers no disable or approval',
  {skip:!process.env.OCEAN_RISK_REVIEW_UI_ARTIFACTS},async t=>{
  const {createRequire}=await import('node:module');
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.OCEAN_S21_NODE_MODULES]}));
  const f=fixture({prospective:true,oneDirection:'short',insufficient:true}),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const status=f.complete(),before=sealed(f),{child,artifact}=assertRiskReview(f,status);
    const root=new URL('../public/',import.meta.url),base='http://127.0.0.1:17891',errors=[],writes=[];
    const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>sessionStorage.setItem('ocean-workflow-human-csrf','EXPLICIT_MOCK_BROWSER_SESSION'));
    // Transport/session are explicit mocks. Read views use the real backend,
    // disposable SQLite and current UI; no production service or credential is read.
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base)return route.abort();
      if(request.method()!=='GET'){writes.push(request.url());return route.abort();}
      if(url.pathname==='/api/workflow/session')return route.fulfill({json:{expires_at_utc:new Date(Date.now()+3600000).toISOString()}});
      if(url.pathname==='/api/workflow/view/dashboard')return route.fulfill({json:{counts:{action_required:0}}});
      if(url.pathname.startsWith('/api/workflow/view/cases/'))return route.fulfill({json:readWorkflowView(f.backend,f.human,url.pathname.slice('/api/workflow/'.length))});
      const relative=url.pathname.startsWith('/improvement/')?'workflow/index.html':url.pathname.slice(1);
      const file=new URL(relative,root);
      if(!file.href.startsWith(root.href) || !fs.existsSync(file))return route.fulfill({status:404,body:''});
      const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file.pathname)];
      return route.fulfill({contentType:type || 'application/octet-stream',body:fs.readFileSync(file)});
    });
    const settled=()=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
    await page.goto(`${base}/improvement/cases/source`);await settled();
    await page.locator(`a[href='/improvement/cases/${child.id}']`).click();await settled();
    await page.getByRole('heading',{name:'Risk review scope',exact:true}).waitFor();
    const body=await page.locator('#content').innerText();
    assert.match(body,/Owner brain: review the frozen short direction loss observation/);
    assert.match(body,/60 baseline \/ 60 excluded \/ 0 retained trades/);assert.match(body,/Required risk review/);
    assert.match(body,/no strategy disable, candidate development or test permission/);
    assert.doesNotMatch(body,/Await new qualified Research|Required planning work|Historical validation/);
    const fact=label=>page.locator('dt').filter({hasText:new RegExp(`^${label}$`)}).locator('..').locator('dd');
    assert.equal(await fact('Observation classification').innerText(),'Risk disable review required');
    assert.equal(await fact('Review disposition').count(),0);
    assert.equal(await fact('Recorded disposition').count(),0);
    assert.equal(await page.locator('#content [data-action]').count(),0);
    const output=process.env.OCEAN_RISK_REVIEW_UI_ARTIFACTS;fs.mkdirSync(output,{recursive:true});
    for(const [width,height,label] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
      await page.setViewportSize({width,height});
      await page.screenshot({path:path.join(output,`risk-review-${label}.png`),fullPage:true,animations:'disabled'});
      const overflow=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,
        elements:[...document.querySelectorAll('#content *')].filter(node=>node.getBoundingClientRect().right>innerWidth)
          .slice(0,12).map(node=>({tag:node.tagName,class:node.className,text:node.textContent.slice(0,100),right:node.getBoundingClientRect().right}))}));
      if(overflow.document>overflow.viewport)t.diagnostic(JSON.stringify(overflow));
      assert.equal(overflow.document<=overflow.viewport,true);
    }
    f.restart();f.worker.reconcile();await page.reload();await settled();
    assert.equal(await page.getByRole('heading',{name:'Risk review scope',exact:true}).count(),1);
    const {value:returned}=assertMachineRisk(f,child);
    assert.match(await page.locator('#content').innerText(),/Machine evidence qualification; not a human review or substantive risk decision/);
    f.restart();f.worker.reconcile();
    await page.reload();await settled();
    assert.match(await page.locator('#content').innerText(),/risk review recorded EVIDENCE_LIMITED/);
    assert.equal(await fact('Observation classification').innerText(),'Risk disable review required');
    assert.equal(await fact('Review disposition').innerText(),'Evidence limited');
    assert.equal(await fact('Review notes').textContent(),returned.review_notes);
    assert.equal(await fact('Reviewer').innerText(),f.actor.id);
    assert.equal(await fact('Immutable review artifact').getByRole('link').getAttribute('href'),
      `/improvement/artifacts/${returned.artifact_id}`);
    assert.equal(await fact('Immutable review artifact').locator('code').innerText(),returned.content_hash);
    assert.equal(await fact('Recorded disposition').count(),0);
    assert.equal(await page.locator('#content [data-action]').count(),0);
    for(const [width,height,label] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(output,`risk-review-completed-${label}.png`),fullPage:true,animations:'disabled'});
    }
    await page.locator('dt').filter({hasText:'Source Research'}).locator('..').getByRole('link').click();await settled();
    assert.equal(new URL(page.url()).pathname,'/improvement/cases/source');
    assert.match(await page.locator('#content').innerText(),/Owned continuation work/);
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assertSealed(f,before);
    assert.deepEqual(f.backend.one('ow_artifacts',artifact.id),artifact);assertNoAuthority(f);
  }finally{await browser.close();f.close();}
});
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
const candidateBuild=()=>({candidate_version:'v0.6.239-short-exclusion-candidate',candidate_hash:digest('candidate-binary'),
  source_hash:digest('candidate-source'),binary_hash:digest('candidate-binary'),source_commit:'a'.repeat(40),
  pull_request_url:'https://github.com/example/strategy/pull/13',build_receipt_hash:digest('candidate-build-receipt'),
  change_summary:'Disable short entries only; preserve inherited long-entry, exit, sizing and risk behaviour.',
  verification:{build_status:'PASS',tests_status:'PASS',short_entries_enabled:false,non_live_only:true}});

test('exact operational owner returns an immutable plan with verified scoped dispatch, never candidate PASS',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0];
    const queue=plans(f).queue(f.actor);assert.equal(queue.items.length,1);assert.equal(queue.items[0].status,'READY');
    const claim=claimPlan(f);assert.equal(claim.template.proposed_change.value,'short');
    assert.equal(claim.template.baseline.strategy_code_hash,child.baseline_hash);
    assert.equal(plans(f).read(f.actor,child.id).status,'IN_PROGRESS');
    const input=planInput(claim),result=plans(f).perform('plans',f.actor,input);
    assert.equal(result.planning_complete,true);assert.equal(result.approval_due,false);assert.equal(result.candidate_testing,'NOT_DUE');
    assert.deepEqual(result.missing_contracts,[]);assert.equal(plans(f).queue(f.actor).items.length,0);
    const view=f.backend.readCase(f.human,child.id);
    assert.equal(view.planning.plan_work.status,'PLAN_RETURNED');assert.equal(view.tasks.find(task=>task.kind==='PROPOSAL_PLAN_REVIEW').status,'COMPLETED');
    assert.equal(view.stage,'RESEARCH');assert.equal(view.work_status,'READY');
    assert.equal(view.blockers.length,0);
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
    const strategy={id:'strategy',role:'STRATEGY',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:['read','artifact.write','event.write']};
    f.backend.auth.authenticate=()=>strategy;
    const candidateQueue=await invoke('candidates/work');assert.equal(candidateQueue.items[0].case_id,child.id);
    const candidateWork=await invoke(`candidates/${child.id}/work`);
    const candidateClaim=await invoke('candidates/claim',{message_id:'http-candidate-claim',data:{case_id:child.id,
      expected_revision:candidateWork.revision,plan_artifact_id:candidateWork.dispatch.plan_artifact_id,
      dispatch_hash:candidateWork.dispatch.dispatch_hash}});
    assert.equal(candidateClaim.status,'IN_PROGRESS');assert.equal(candidateClaim.dispatch.actual_execution_allowed,false);
    assert.throws(()=>f.backend.mutate('approval.request',f.actor,{message_id:'test-no-approval',data:{case_id:child.id}}),/OPERATIONAL_PLANNING_MUTATION_NOT_ENABLED/);
    assertNoAuthority(f);
  }finally{f.close();}
});

test('candidate completion survives restart and registration requires an approved acknowledged Replay-only handoff',()=>{
  const f=fixture();try{
    f.complete();const before=sealed(f),child=f.children()[0],planClaim=claimPlan(f);
    const returned=plans(f).perform('plans',f.actor,planInput(planClaim));
    const strategy={id:'strategy',role:'STRATEGY',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],
      scopes:['read','artifact.write','case.transition','event.write']};
    let work=f.backend.operationalCandidateDispatch.read(strategy,child.id);
    const claim=f.backend.operationalCandidateDispatch.perform('claim',strategy,{message_id:'candidate-claim',data:{case_id:child.id,
      expected_revision:work.revision,plan_artifact_id:work.dispatch.plan_artifact_id,dispatch_hash:work.dispatch.dispatch_hash}});
    const completionInput={message_id:'candidate-complete',data:{case_id:child.id,expected_revision:claim.revision,
      plan_artifact_id:claim.dispatch.plan_artifact_id,dispatch_hash:claim.dispatch.dispatch_hash,lease_id:claim.lease_id,candidate:candidateBuild()}};
    const completed=f.backend.operationalCandidateDispatch.perform('complete',strategy,completionInput);
    assert.equal(completed.status,'BUILT_PENDING_REVIEW');assert.equal(completed.completion.candidate_hash,candidateBuild().candidate_hash);
    assert.equal(f.backend.readCase(f.human,child.id).candidate_dispatch.status,'BUILT_PENDING_REVIEW');
    assert.equal(f.backend.readCase(f.human,child.id).tasks.find(task=>task.kind==='CANDIDATE_DISPATCH_ENGINEERING').status,'COMPLETED');
    f.restart();assert.deepEqual(f.backend.operationalCandidateDispatch.perform('complete',strategy,completionInput),completed);
    work=f.backend.operationalCandidateDispatch.read(strategy,child.id);assert.equal(work.status,'BUILT_PENDING_REVIEW');
    assert.throws(()=>f.backend.operationalCandidateDispatch.perform('register',strategy,{message_id:'early-register',data:{case_id:child.id,
      expected_revision:work.revision,plan_artifact_id:work.dispatch.plan_artifact_id,dispatch_hash:work.dispatch.dispatch_hash,
      completion_hash:completed.completion.completion_hash,handoff_id:'test-missing-handoff'}}),/ENTITY_NOT_FOUND/);

    let row=f.backend.transition(f.human,{case_id:child.id,expected_revision:work.revision,action:'advance',to_stage:'DEVELOPMENT_REVIEW',
      artifact_id:returned.artifact_id,artifact_ids:null,decision_id:null,owner_id:null,next_action:null});
    const request=f.backend.requestApproval(f.human,{request_id:'test-candidate-review',case_id:child.id,expected_revision:row.revision,
      gate:'DEVELOPMENT',artifact_id:returned.artifact_id,recipient_id:'strategy',authorized_tests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'],
      expires_at_utc:new Date(Date.now()+3600000).toISOString()});
    const decision=f.backend.decide(f.human,{decision_id:'test-candidate-decision',request_id:request.request_id,case_id:child.id,
      expected_revision:request.revision,snapshot_hash:request.snapshot_hash,decision:'APPROVED',reason:'Approve exact Replay-only validation; Paper, Live and promotion remain disabled.'});
    row=f.backend.transition(f.human,{case_id:child.id,expected_revision:decision.revision,action:'advance',to_stage:'DEVELOPMENT_HANDOFF',
      artifact_id:null,artifact_ids:null,decision_id:decision.decision_id,owner_id:null,next_action:null});
    let handoff=f.backend.createHandoff(f.human,{handoff_id:'test-candidate-handoff',case_id:child.id,decision_id:decision.decision_id,
      gate:'DEVELOPMENT',recipient_id:'strategy',authorized_test:'BACKTEST'});
    handoff=f.backend.handoffEvent(f.human,{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'READY',result_artifact_id:null,reason:null});
    handoff=f.backend.handoffEvent(f.human,{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'DISPATCHED',result_artifact_id:null,reason:null});
    handoff=f.backend.handoffEvent(strategy,{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'ACKNOWLEDGED',result_artifact_id:null,reason:null});
    const current=f.backend.operationalCandidateDispatch.read(strategy,child.id);
    const registered=f.backend.operationalCandidateDispatch.perform('register',strategy,{message_id:'candidate-register',data:{case_id:child.id,
      expected_revision:row.revision,plan_artifact_id:current.dispatch.plan_artifact_id,dispatch_hash:current.dispatch.dispatch_hash,
      completion_hash:completed.completion.completion_hash,handoff_id:handoff.handoff_id}});
    assert.equal(registered.status,'REGISTERED');assert.equal(registered.stage,'HISTORICAL_VALIDATION');
    const view=f.backend.readCase(f.human,child.id);assert.equal(view.candidate_dispatch.status,'REGISTERED');
    assert.equal(view.candidate_hash,candidateBuild().candidate_hash);assert.deepEqual(view.tasks.filter(task=>['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].includes(task.kind)).map(task=>task.status),['NOT_RUN','NOT_RUN','NOT_RUN','NOT_RUN']);
    assert.equal(f.backend.one('ow_artifacts',registered.candidate_artifact_id).kind,'CANDIDATE');
    assert.equal(view.candidate_dispatch.registration.authority.paper_authorized,false);
    f.restart();assert.equal(f.backend.readCase(f.human,child.id).candidate_dispatch.status,'REGISTERED');assertSealed(f,before);
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
    assert.equal(view.blockers.length,0);assert.match(view.next_action,/Source owner strategy/);
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
    assert.deepEqual(plan.execution.missing_contracts,[]);
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
    const implementation=f.backend.operationalCandidateCapabilities.bind(f.backend),catalog=implementation();
    f.backend.operationalCandidateCapabilities=()=>({...catalog,operational_candidate_test_dispatch:false,
      implementation_hash:digest('EXPLICIT_MOCK_ONLY_MISSING_SCOPED_ADAPTER')});
    f.complete();f.worker.reconcile();const child=f.children()[0],old=plans(f).forCase(child).returned;
    f.backend.operationalCandidateCapabilities=implementation;
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

test('exact strategy owner can claim and renew the frozen TEST-only candidate brief without creating authority',()=>{
  const f=fixture();try {
    f.complete();f.worker.reconcile();const child=f.children()[0];
    const actor={id:'strategy',role:'STRATEGY',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:['read','artifact.write','event.write']};
    const queue=f.backend.operationalCandidateDispatch.queue(actor);assert.equal(queue.items.length,1);
    assert.equal(queue.items[0].case_id,child.id);assert.equal(queue.items[0].status,'READY');
    const work=f.backend.operationalCandidateDispatch.read(actor,child.id);
    assert.equal(work.dispatch.proposed_change.value,'short');assert.equal(work.dispatch.actual_execution_allowed,false);
    assert.deepEqual(work.dispatch.protocol.tests.map(item=>item.kind),['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
    const input={message_id:'candidate-claim',data:{case_id:child.id,expected_revision:work.revision,
      plan_artifact_id:work.dispatch.plan_artifact_id,dispatch_hash:work.dispatch.dispatch_hash}};
    const claim=f.backend.operationalCandidateDispatch.perform('claim',actor,input);
    assert.deepEqual(f.backend.operationalCandidateDispatch.perform('claim',actor,input),claim);
    assert.equal(claim.status,'IN_PROGRESS');assert.equal(claim.dispatch.authority.candidate_approved,false);
    assert.equal(f.backend.one('ow_cases',child.id).candidate_hash,null);
    assert.equal(f.backend.db.prepare("SELECT status FROM ow_tasks WHERE case_id=? AND kind='CANDIDATE_DISPATCH_ENGINEERING'").get(child.id).status,'IN_PROGRESS');
    const renewed=f.backend.operationalCandidateDispatch.perform('renew',actor,{message_id:'candidate-renew',data:{case_id:child.id,
      expected_revision:claim.revision,plan_artifact_id:claim.dispatch.plan_artifact_id,dispatch_hash:claim.dispatch.dispatch_hash,
      lease_id:claim.lease_id}});
    assert.equal(renewed.lease_id,claim.lease_id);assert.ok(renewed.lease_until_ms>=claim.lease_until_ms);
    assertNoAuthority(f);
  }finally{f.close();}
});

test('candidate dispatch denies the wrong namespace or recipient and blocks an unregistered provider baseline',()=>{
  const f=fixture();try {
    f.complete();f.worker.reconcile();const child=f.children()[0];
    const actor={id:'strategy',role:'STRATEGY',namespace:'OPERATIONAL',strategyIds:['s'],instanceIds:['i'],scopes:['read','artifact.write','event.write']};
    assert.throws(()=>f.backend.operationalCandidateDispatch.queue({...actor,namespace:'TEST'}),/CANDIDATE_OPERATIONAL_STRATEGY_REQUIRED/);
    assert.throws(()=>f.backend.operationalCandidateDispatch.read({...actor,id:'other'},child.id),/CANDIDATE_EXACT_RECIPIENT_REQUIRED/);
    const missing=fixture({registerBaseline:false});try {
      missing.complete();missing.worker.reconcile();const blocked=missing.children()[0];
      assert.throws(()=>missing.backend.operationalCandidateDispatch.read(actor,blocked.id),/CANDIDATE_DISPATCH_CAPABILITY_REQUIRED/);
    }finally{missing.close();}
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
