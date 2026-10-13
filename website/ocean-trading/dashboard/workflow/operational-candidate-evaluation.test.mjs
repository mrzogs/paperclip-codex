import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, objectHash } from './common.mjs';
import {
  CANDIDATE_EVALUATION_RESULT_VERSION,
  OperationalCandidateEvaluator,
} from './operational-candidate-evaluation.mjs';
import {
  CANDIDATE_VALIDATION_PLAN_VERSION,
  CANDIDATE_VALIDATION_VERSION,
  OperationalCandidateDispatch,
} from './operational-candidate-dispatch.mjs';

const brainAuthority = Object.freeze({
  strategy_changed: false,
  candidate_approved: false,
  candidate_promoted: false,
  paper_authorized: false,
  live_authorized: false,
  runtime_trade_decision_dependency: false,
});

function exchange(conclusion, policyStatus = 'NOT_PREDECLARED') {
  const executionBindings={baseline:{logical_hash:digest('baseline'),strategy_version:'baseline-v1',runs:[]},
    candidate:{logical_hash:digest('candidate'),strategy_version:'candidate-v1',runs:[]}};
  const artifactContent=JSON.stringify({baseline:{net_pnl:10},candidate:{net_pnl:12,trade_count:3},execution_bindings:executionBindings,
    contradictions:[],limitations:[]});
  const sourceArtifact={kind:'BACKTEST',artifact_id:'test-backtest',manifest_json:'{}',manifest_sha256:digest('{}'),
    content_json:artifactContent,content_sha256:digest(artifactContent)};
  const plan={schema_version:CANDIDATE_VALIDATION_PLAN_VERSION,plan_revision:1};
  const completion={schema_version:'ocean-operational-candidate-validation/v3',next_stage:'CANDIDATE_EVALUATION'};
  const request = {
    project:'cicd-vwap-pull-back-strategy',case_id:'test-case',strategy_id:'cicd-vwap-pull-back-strategy',
    strategy_name:'VWAP Pullback',strategy_profile_id:'test-profile',strategy_version:'v0.1.0',
    execution_instance_id:'test-instance',registry_reconciliation_id:null,registry_record_sha256:null,
    baseline_hash:digest('baseline'),candidate_hash:digest('candidate'),
    evaluation_policy: { status: policyStatus },
    validation_plan:{artifact_id:'test-plan',plan_hash:digest('plan'),content_json:JSON.stringify(plan),
      content_sha256:digest(JSON.stringify(plan)),hash_basis_json:null},
    validation_completion:{artifact_id:'test-completion',event_id:'ocean-event-1',content_json:JSON.stringify(completion),
      content_sha256:digest(JSON.stringify(completion))},
    source_artifacts:[sourceArtifact],
    correlation: { event_id: 'candidate-evaluation:test', job_id: 'test-job', input_sha256: digest('input') },
  };
  const bindings={case_id:request.case_id,plan_artifact_id:'test-plan',plan_hash:request.validation_plan.plan_hash,
    plan_content_sha256:request.validation_plan.content_sha256,completion_artifact_id:'test-completion',
    completion_event_id:'ocean-event-1',completion_content_sha256:request.validation_completion.content_sha256,
    baseline_hash:request.baseline_hash,candidate_hash:request.candidate_hash};
  const sourceArtifacts=[{kind:'BACKTEST',artifact_id:'test-backtest',manifest_sha256:sourceArtifact.manifest_sha256,
    content_sha256:sourceArtifact.content_sha256,execution_bindings:executionBindings,baseline_net_pnl:10,candidate_net_pnl:12,
    candidate_trade_count:3,contradiction_count:0,limitation_count:0}];
  const content = JSON.stringify({
    schema_version:'brain-candidate-evaluation-content/v1',
    strategy:{project:request.project,strategy_id:request.strategy_id,strategy_name:request.strategy_name,
      strategy_profile_id:request.strategy_profile_id,strategy_version:request.strategy_version,
      execution_instance_id:request.execution_instance_id},
    registry_reconciliation_id:null,registry_record_sha256:null,bindings,evaluation_policy:request.evaluation_policy,
    validation_plan:plan,validation_completion:completion,
    source_artifacts:[{echo:sourceArtifacts[0],content:JSON.parse(artifactContent)}],dataset_provenance:{partition_id:'test'},
    conclusion:{type:conclusion,reasons:[],metrics:{}},correlation:request.correlation,
    authority:brainAuthority,human_governance_required:true,
  });
  const response = {
    schema_version: CANDIDATE_EVALUATION_RESULT_VERSION,
    record_id: 'reasoning-test-candidate-evaluation',
    relative_path: 'reasoning/test-candidate-evaluation.md',
    content,
    content_sha256: digest(content),
    conclusion_type:conclusion,bindings,evaluation_policy:request.evaluation_policy,
    source_artifacts:sourceArtifacts,
    correlation: request.correlation,
    authority:brainAuthority,human_governance_required:true,
    readback:{verified:true,record_id:'reasoning-test-candidate-evaluation',relative_path:'reasoning/test-candidate-evaluation.md',
      content_sha256:digest(content)},
  };
  return { request, response };
}

function withContent(response,mutate){
  const parsed=JSON.parse(response.content);mutate(parsed);const content=JSON.stringify(parsed),content_sha256=digest(content);
  return {...response,content,content_sha256,readback:{...response.readback,content_sha256}};
}

test('undeclared evaluation policy cannot manufacture a benefit or no-benefit verdict after holdout', () => {
  const evaluator = Object.create(OperationalCandidateEvaluator.prototype);
  for (const conclusion of ['BENEFIT_SUPPORTED', 'NO_BENEFIT']) {
    const { request, response } = exchange(conclusion);
    assert.throws(() => evaluator.verifyResponse(response, request), /CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID/);
  }
  for (const conclusion of ['BENEFIT_NOT_ESTABLISHED', 'MORE_EVIDENCE_REQUIRED']) {
    const { request, response } = exchange(conclusion);
    assert.equal(objectHash(evaluator.verifyResponse(response, request)), objectHash(response));
  }
});

test('declared policy still requires exact lineage, source echo and no-authority response', () => {
  const evaluator = Object.create(OperationalCandidateEvaluator.prototype);
  const { request, response } = exchange('BENEFIT_SUPPORTED', 'PREDECLARED');
  assert.equal(objectHash(evaluator.verifyResponse(response, request)), objectHash(response));
  for (const changed of [
    { ...response, bindings:{...response.bindings,plan_hash:digest('other-plan')} },
    { ...response, source_artifacts: [{...response.source_artifacts[0],content_sha256:digest('other-backtest')}] },
    { ...response, authority: { ...response.authority, paper_authorized: true } },
    withContent(response,content=>{content.schema_version='wrong-content-schema';}),
    withContent(response,content=>{content.human_governance_required=false;}),
    withContent(response,content=>{content.source_artifacts[0].echo.content_sha256=digest('other-embedded-source');}),
    withContent(response,content=>{delete content.source_artifacts[0].content;}),
    withContent(response,content=>{content.source_artifacts[0].content.candidate.net_pnl=999;}),
  ]) assert.throws(() => evaluator.verifyResponse(changed, request), /CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID/);
});

test('legacy PASS evidence is reopened from the first incompatible test instead of becoming a Brain blocker', () => {
  const dispatch=Object.create(OperationalCandidateDispatch.prototype),updates=[],events=[];
  dispatch.validationArtifactCompatible=(_row,_plan,kind)=>kind==='BACKTEST';
  dispatch.db={prepare:sql=>({run:(...args)=>{updates.push({sql,args});}})};
  dispatch.b={config:{identities:[{identity_id:'strategy',namespace:'OPERATIONAL',role:'STRATEGY',revoked:false,
    expires_at_utc:new Date(Date.now()+60_000).toISOString(),strategy_ids:['s'],instance_ids:['i']}]},
    event:(...args)=>events.push(args)};
  const row={id:'test-case',revision:17,stage:'HISTORICAL_VALIDATION',strategy_id:'s',instance_id:'i'};
  const plan={plan_hash:digest('plan')};
  const tasks=['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']
    .map(kind=>({kind,status:'PASS',artifact_id:`test-${kind.toLowerCase()}`}));
  const result=dispatch.reconcileValidationArtifacts({id:'strategy',role:'STRATEGY'},row,plan,tasks);
  assert.equal(result.status,'REVALIDATION_REQUIRED');
  assert.equal(result.next_test,'ROBUSTNESS');
  assert.deepEqual(result.reset_kinds,['ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
  assert.deepEqual(updates[0].args,['test-case','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
  assert.equal(updates[1].args[0],'strategy');
  assert.match(updates[1].args[1],/Revalidate ROBUSTNESS/);
  assert.equal(events[0][1],'operational.candidate.validation.revalidation_required');
});

test('current validation artifacts require the exact plan, current shape and distinct physical roles', () => {
  const dispatch=Object.create(OperationalCandidateDispatch.prototype);
  const row={id:'test-case',baseline_hash:digest('baseline'),candidate_hash:digest('candidate')};
  const baselineHashes={strategy_source_hash:digest('baseline-source'),strategy_dll_hash:digest('baseline-dll'),
    strategy_marker_hash:digest('marker'),completion_receipt_hash:digest('receipt')};
  const candidateHashes={strategy_source_hash:digest('candidate-source'),strategy_dll_hash:digest('candidate-dll'),
    strategy_marker_hash:digest('candidate-marker'),completion_receipt_hash:digest('candidate-receipt')};
  const testPlan={kind:'BACKTEST',baseline_version:'v0.6.238',baseline_strategy_hash:baselineHashes.strategy_dll_hash,
    baseline_execution_source_hash:baselineHashes.strategy_source_hash,candidate_version:'v0.6.239',
    candidate_execution_version:'v0.6.239',candidate_execution_hash:candidateHashes.strategy_dll_hash,
    candidate_execution_source_hash:candidateHashes.strategy_source_hash,
    segments:[{segment_id:'one',baseline_run_id:'test-baseline',candidate_run_id:'test-candidate'}]},plan={schema_version:CANDIDATE_VALIDATION_PLAN_VERSION,plan_hash:digest('plan'),
    plan_artifact_id:'test-plan',tests:[testPlan]};
  const report={schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_hash:plan.plan_hash,
    plan_artifact_id:plan.plan_artifact_id,candidate_hash:row.candidate_hash,baseline_hash:row.baseline_hash,
    completion_hash:digest('completion'),status:'PASS',evidence_integrity_passed:true,test:testPlan,
    comparison:{reported_delta:1},authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,
      live_authorized:false,execution_environment:'REPLAY'},execution_bindings:{
      baseline:{logical_hash:row.baseline_hash,strategy_version:testPlan.baseline_version,
        runs:[{run_id:'test-baseline',physical_hashes:baselineHashes,marker_bytes_available:true}]},
      candidate:{logical_hash:row.candidate_hash,strategy_version:testPlan.candidate_execution_version,
        runs:[{run_id:'test-candidate',physical_hashes:candidateHashes,marker_bytes_available:true}]}}};
  let content=report;
  dispatch.completion=()=>({completion_hash:report.completion_hash});
  dispatch.b={artifactFor:()=>({content:Buffer.from(JSON.stringify(content))})};
  assert.equal(dispatch.validationArtifactCompatible(row,plan,'BACKTEST','test-artifact'),true);
  content={...report,comparison:{net_pnl_delta:1}};
  assert.equal(dispatch.validationArtifactCompatible(row,plan,'BACKTEST','test-artifact'),false);
  content=structuredClone(report);content.execution_bindings.candidate.runs[0].physical_hashes.strategy_marker_hash=candidateHashes.strategy_source_hash;
  assert.equal(dispatch.validationArtifactCompatible(row,plan,'BACKTEST','test-artifact'),false);
});

test('an in-flight Brain result cannot complete after a newer revalidation invalidates its evidence', () => {
  const evaluator=Object.create(OperationalCandidateEvaluator.prototype),now=Date.now();
  const job={id:'job',case_id:'test-case',state:'RUNNING',lease_id:'lease',lease_until_ms:now+60_000,
    completion_event_id:12,plan_hash:digest('plan')};
  const row={id:'test-case',stage:'HISTORICAL_VALIDATION'};
  evaluator.b={store:{transaction:fn=>fn()},one:(table)=>table==='ow_candidate_evaluation_jobs'?job:row,
    operationalCandidateDispatch:{validationPlan:()=>({plan_hash:job.plan_hash})}};
  evaluator.db={prepare:sql=>({run:()=>({changes:1}),get:()=>sql.includes('action IN')
    ?{id:13,action:'operational.candidate.validation.revalidation_required'}
    :{id:12}})};
  assert.throws(()=>evaluator.complete(job,{},{}),/CANDIDATE_EVALUATION_EVIDENCE_INVALIDATED/);
});

test('candidate evaluator renews only its fenced lease and exposes pipeline completion separately from benefit', () => {
  const evaluator=Object.create(OperationalCandidateEvaluator.prototype),updates=[];
  evaluator.leaseMs=300_000;
  evaluator.db={prepare:()=>({run:(...args)=>{updates.push(args);return {changes:1};}})};
  evaluator.b={one:()=>({id:'job',state:'RUNNING',lease_id:'lease',lease_until_ms:Date.now()+300_000})};
  const renewed=evaluator.renew({id:'job',lease_id:'lease'});
  assert.equal(renewed.lease_id,'lease');
  assert.equal(updates[0][1],'job');
  assert.equal(updates[0][2],'lease');
  const status=evaluator.publicStatus({state:'COMPLETED',attempts:1,next_attempt_ms:0,lease_until_ms:null,
    brain_request_json:'{}',brain_response_json:'{}',brain_readback_json:'{}',result_artifact_id:'test-result',
    result_hash:digest('result'),brain_record_id:'reasoning-result',brain_content_hash:digest('brain'),conclusion:'MORE_EVIDENCE_REQUIRED'});
  assert.equal(status.pipeline_status,'PIPELINE_COMPLETED');
  assert.equal(status.benefit_conclusion,'MORE_EVIDENCE_REQUIRED');
  assert.equal(status.phase,'RESULT_RECORDED');
});

test('candidate evaluator treats its own lease loss as resumable rather than a durable blocker', () => {
  const evaluator=Object.create(OperationalCandidateEvaluator.prototype),writes=[];
  evaluator.db={prepare:()=>({run:(...args)=>writes.push(args)})};
  evaluator.fail({id:'job',lease_id:'lease',attempts:2},{status:409,code:'CANDIDATE_EVALUATION_LEASE_LOST'});
  assert.equal(writes[0][0],'RETRY');
});
