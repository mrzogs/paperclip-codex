import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { digest, exactKeys, id, noSecrets, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_DISPATCH_VERSION='ocean-operational-candidate-dispatch/v2';
export const CANDIDATE_VALIDATION_VERSION='ocean-operational-candidate-validation/v2';
const ORIGIN='OPERATIONAL_RESEARCH_CONTINUATION';
const leaseAction='operational.candidate.dispatch.lease';
const completionAction='operational.candidate.dispatch.completed';
const registrationAction='operational.candidate.dispatch.registered';
const validationPlanAction='operational.candidate.validation.plan';
const validationResultAction='operational.candidate.validation.result';
const holdoutReleaseAction='operational.candidate.validation.holdout_released';
const validationCompletionAction='operational.candidate.validation.completed';
const REQUIRED_TESTS=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const REQUIRED_ROLES=Object.freeze({BACKTEST:'DISCOVERY',ROBUSTNESS:'DISCOVERY',WALK_FORWARD:'VALIDATION',OOS_HOLDOUT:'HOLDOUT'});
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const sameNumber=(left,right)=>Math.abs(left-right)<=1e-6;
const contractKey=value=>String(value).replace(/\[M\]$/,'');
const metricKeys=Object.freeze(['trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods']);

// This adapter dispatches an exact, non-live engineering brief to the current
// strategy owner and records its completion. Review, validation, Paper and Live
// authority remain in the existing governed lifecycle.
export class OperationalCandidateDispatch {
  constructor(backend){this.b=backend;this.db=backend.db;this.leaseMs=300000;}
  latest(caseId,action=leaseAction){
    const row=this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,action);
    return row?JSON.parse(row.payload_json).payload:null;
  }
  completion(caseId){return this.latest(caseId,completionAction);}
  registration(caseId){return this.latest(caseId,registrationAction);}
  validationPlan(caseId){return this.latest(caseId,validationPlanAction);}
  validationCompletion(caseId){return this.latest(caseId,validationCompletionAction);}
  load(actor,caseId,scope='read'){
    const row=this.b.one('ow_cases',caseId),payload=JSON.parse(row.payload_json);
    requireThat(payload.origin===ORIGIN && payload.kind==='PROPOSAL_PLANNING',403,'SUPPORTED_OPERATIONAL_PROPOSAL_REQUIRED');
    requireThat(actor.role==='STRATEGY' && actor.namespace==='OPERATIONAL',403,'CANDIDATE_OPERATIONAL_STRATEGY_REQUIRED');
    this.b.authorize(actor,scope,row.strategy_id,row.instance_id);
    const planning=this.b.operationalResearch.continuations.plans.forCase(row);
    requireThat(planning?.status==='PLAN_RETURNED' && planning.planning_complete,409,
      planning?.blocked_reason || (planning?.status==='REVISION_DUE'?'CANDIDATE_PLAN_REVISION_DUE':'CANDIDATE_PLAN_NOT_READY'));
    requireThat(planning.returned.source_owner_id===actor.id,403,'CANDIDATE_EXACT_RECIPIENT_REQUIRED');
    const artifact=this.b.artifactFor(row,planning.returned.artifact_id,'RECOMMENDATION');
    const plan=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    const capability=plan.execution?.capabilities?.find(item=>item.contract==='SCOPED_CANDIDATE_TEST_DISPATCH');
    const versions=capability?.evidence?.registered_versions || [];
    requireThat(plan.non_live_only===true && plan.candidate?.state==='NOT_CREATED'
      && objectHash(plan.authority)===objectHash(authority),409,'CANDIDATE_PLAN_AUTHORITY_CONFLICT');
    requireThat(plan.execution?.missing_contracts?.length===0 && capability?.status==='VERIFIED'
      && capability.evidence?.operational_candidate_test_dispatch===true,409,'CANDIDATE_DISPATCH_CAPABILITY_REQUIRED');
    requireThat(versions.some(version=>version.kind==='BASELINE'),409,'CANDIDATE_PROVIDER_BASELINE_REQUIRED');
    return {row,payload,planning,artifact,plan,versions};
  }
  payload(work){
    const frozen={schema_version:CANDIDATE_DISPATCH_VERSION,plan_case_id:work.row.id,
      plan_artifact_id:work.artifact.id,plan_content_hash:JSON.parse(work.artifact.manifest_json).content_hash,
      recipient_id:work.plan.source_owner_id,baseline:work.plan.baseline,proposed_change:work.plan.proposed_change,
      protocol:{...work.plan.protocol,tests:REQUIRED_TESTS.map(kind=>({kind,status:'NOT_STARTED'}))},
      provider_versions:work.versions,namespace:'TEST',execution_environment:'REPLAY',
      actual_execution_allowed:false,authority};
    return {...frozen,dispatch_id:`candidate-dispatch-${objectHash(frozen).slice(7,31)}`,
      dispatch_hash:objectHash(frozen)};
  }
  publicCompletion(value){
    return {completion_hash:value.completion_hash,completed_at_utc:value.completed_at_utc,recipient_id:value.recipient_id,
      plan_artifact_id:value.plan_artifact_id,dispatch_hash:value.dispatch_hash,candidate_version:value.candidate.candidate_version,
      candidate_hash:value.candidate.candidate_hash,source_hash:value.candidate.source_hash,binary_hash:value.candidate.binary_hash,
      source_commit:value.candidate.source_commit,pull_request_url:value.candidate.pull_request_url,
      build_receipt_hash:value.candidate.build_receipt_hash,change_summary:value.candidate.change_summary,
      verification:value.candidate.verification,authority:value.authority};
  }
  validateCandidate(candidate){
    exactKeys(candidate,['candidate_version','candidate_hash','source_hash','binary_hash','source_commit','pull_request_url','build_receipt_hash','change_summary','verification']);
    requireThat(typeof candidate.candidate_version==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(candidate.candidate_version),422,'CANDIDATE_VERSION_REQUIRED');
    for(const key of ['candidate_hash','source_hash','binary_hash','build_receipt_hash'])requireThat(validHash(candidate[key]),422,'CANDIDATE_HASH_REQUIRED');
    requireThat(candidate.candidate_hash===candidate.binary_hash,409,'CANDIDATE_BINARY_BINDING_REQUIRED');
    requireThat(/^[a-f0-9]{40}$/.test(candidate.source_commit),422,'CANDIDATE_COMMIT_REQUIRED');
    requireThat(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(candidate.pull_request_url),422,'CANDIDATE_PULL_REQUEST_REQUIRED');
    requireThat(typeof candidate.change_summary==='string' && candidate.change_summary.trim().length>0 && candidate.change_summary.length<=1000,422,'CANDIDATE_CHANGE_SUMMARY_REQUIRED');
    exactKeys(candidate.verification,['build_status','tests_status','short_entries_enabled','non_live_only']);
    requireThat(candidate.verification.build_status==='PASS' && candidate.verification.tests_status==='PASS'
      && candidate.verification.short_entries_enabled===false && candidate.verification.non_live_only===true,409,'CANDIDATE_BUILD_VERIFICATION_REQUIRED');
    return structuredClone(candidate);
  }
  read(actor,caseId){
    const work=this.load(actor,caseId),lease=this.latest(caseId),completed=this.completion(caseId),registered=this.registration(caseId),now=Date.now();
    return {schema_version:CANDIDATE_DISPATCH_VERSION,case_id:caseId,revision:work.row.revision,
      status:registered?'REGISTERED':completed?'BUILT_PENDING_REVIEW':lease && lease.lease_until_ms>now?'IN_PROGRESS':'READY',
      lease:lease?{lease_id:lease.lease_id,owner_id:lease.owner_id,expires_at_utc:new Date(lease.lease_until_ms).toISOString()}:null,
      completion:completed?this.publicCompletion(completed):null,registration:registered || null,
      dispatch:this.payload(work),next_action:registered?'Run the four approved Replay-only validation tests and attach their immutable results.':completed?'Wayne must review the exact Replay-only validation request in Ocean; no test or trading authority exists before approval.':'Claim this exact TEST-only engineering brief, build a separately hashed candidate, then use the governed candidate/version/run lifecycle. Claiming does not approve or execute a candidate.'};
  }
  forCase(row){
    const payload=JSON.parse(row.payload_json);
    if(payload.origin!==ORIGIN || payload.kind!=='PROPOSAL_PLANNING')return null;
    const completed=this.completion(row.id),registered=this.registration(row.id),lease=this.latest(row.id),now=Date.now();
    const validation=this.validationPlan(row.id),validationComplete=this.validationCompletion(row.id);
    return {schema_version:CANDIDATE_DISPATCH_VERSION,status:registered?'REGISTERED':completed?'BUILT_PENDING_REVIEW':lease && lease.lease_until_ms>now?'IN_PROGRESS':'READY',
      recipient_id:completed?.recipient_id || lease?.owner_id || null,plan_artifact_id:completed?.plan_artifact_id || lease?.plan_artifact_id || null,
      completion:completed?this.publicCompletion(completed):null,registration:registered || null,
      validation:validation?{schema_version:CANDIDATE_VALIDATION_VERSION,plan_hash:validation.plan_hash,
        status:validationComplete?'COMPLETED':'PLANNED',tests:validation.tests.map(test=>({kind:test.kind,
          state:test.kind==='OOS_HOLDOUT' && !this.latest(row.id,holdoutReleaseAction)?'SEALED':'RELEASED'}))}:null};
  }
  queue(actor){
    requireThat(actor.role==='STRATEGY' && actor.namespace==='OPERATIONAL',403,'CANDIDATE_OPERATIONAL_STRATEGY_REQUIRED');
    const items=[];
    for(const row of this.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')=? AND json_extract(payload_json,'$.kind')='PROPOSAL_PLANNING' ORDER BY rowid").all(ORIGIN)){
      const state=this.b.operationalResearch.continuations.plans.forCase(row);
      if(state?.returned?.source_owner_id!==actor.id)continue;
      try{const work=this.read(actor,row.id);items.push({case_id:row.id,revision:work.revision,status:work.status,
        plan_artifact_id:work.dispatch.plan_artifact_id,dispatch_hash:work.dispatch.dispatch_hash,next_action:work.next_action});}
      catch(error){items.push({case_id:row.id,revision:row.revision,status:'BLOCKED',blocked_reason:error.code || 'CANDIDATE_DISPATCH_PROOF_REQUIRED',
        next_action:'Restore the exact current plan, recipient, provider baseline and route proof; do not build or test a candidate from stale work.'});}
    }
    return {schema_version:CANDIDATE_DISPATCH_VERSION,namespace:'OPERATIONAL',owner_id:actor.id,items,authority};
  }
  perform(action,actor,input){
    requireThat(['claim','renew','complete','acknowledge','register'].includes(action),404,'UNKNOWN_CANDIDATE_DISPATCH_ACTION');
    exactKeys(input,['message_id','data']);id(input.message_id);noSecrets(input,this.b.environment);
    const keys=['case_id','expected_revision','plan_artifact_id','dispatch_hash',
      ...(['renew','complete'].includes(action)?['lease_id']:[]),...(action==='complete'?['candidate']:[]),
      ...(['acknowledge','register'].includes(action)?['completion_hash','handoff_id']:[]),
      ...(action==='acknowledge'?['handoff_revision']:[])];
    exactKeys(input.data,keys);const data=input.data,work=this.load(actor,data.case_id,'event.write'),dispatch=this.payload(work);
    requireThat(data.plan_artifact_id===dispatch.plan_artifact_id && data.dispatch_hash===dispatch.dispatch_hash,
      409,'CANDIDATE_DISPATCH_BINDING_CONFLICT');
    const message=`candidate-dispatch:${input.message_id}`,requestHash=objectHash({action,data});
    return this.b.store.transaction(()=>{
      const current=this.load(actor,data.case_id,'event.write'),currentDispatch=this.payload(current);
      requireThat(currentDispatch.dispatch_hash===dispatch.dispatch_hash,409,'CANDIDATE_DISPATCH_CHANGED');
      const previous=this.db.prepare('SELECT * FROM ow_inbox WHERE producer_id=? AND message_id=?').get(actor.id,message);
      if(previous){requireThat(previous.payload_hash===requestHash,409,'DUPLICATE_CONFLICT');return JSON.parse(previous.result_json);}
      this.b.expect(current.row,data.expected_revision);
      const now=Date.now(),lease=this.latest(current.row.id),completed=this.completion(current.row.id);let next;
      if(action==='claim'){
        requireThat(!completed,409,'CANDIDATE_ALREADY_COMPLETED');
        requireThat(!lease || lease.lease_until_ms<=now,409,'CANDIDATE_DISPATCH_LEASE_HELD');
        next={lease_id:randomUUID(),owner_id:actor.id,lease_until_ms:now+this.leaseMs,
          dispatch_hash:dispatch.dispatch_hash,plan_artifact_id:dispatch.plan_artifact_id};
      }else if(action==='renew'){
        requireThat(!completed,409,'CANDIDATE_ALREADY_COMPLETED');
        requireThat(lease && lease.lease_id===data.lease_id && lease.owner_id===actor.id
          && lease.lease_until_ms>now && lease.dispatch_hash===dispatch.dispatch_hash,409,'CANDIDATE_DISPATCH_LEASE_EXPIRED');
        next={...lease,lease_until_ms:now+this.leaseMs};
      }else if(action==='complete'){
        requireThat(!completed,409,'CANDIDATE_ALREADY_COMPLETED');
        requireThat(lease && lease.lease_id===data.lease_id && lease.owner_id===actor.id
          && lease.lease_until_ms>now && lease.dispatch_hash===dispatch.dispatch_hash,409,'CANDIDATE_DISPATCH_LEASE_EXPIRED');
        const candidate=this.validateCandidate(data.candidate);
        const frozen={schema_version:CANDIDATE_DISPATCH_VERSION,case_id:current.row.id,recipient_id:actor.id,
          plan_artifact_id:dispatch.plan_artifact_id,dispatch_hash:dispatch.dispatch_hash,candidate,
          completed_at_utc:new Date(now).toISOString(),authority};
        next={...frozen,completion_hash:objectHash(frozen)};
        this.b.event(current.row.id,completionAction,actor,next);
        this.db.prepare("UPDATE ow_tasks SET status='COMPLETED',artifact_id=? WHERE case_id=? AND kind='CANDIDATE_DISPATCH_ENGINEERING'")
          .run(dispatch.plan_artifact_id,current.row.id);
        const nextAction='Wayne: review the exact Replay-only candidate validation request in Ocean. Candidate build completion grants no test, Paper, Live or promotion authority.';
        // Preserve the immutable plan author as case owner until the normal
        // review transition assigns Wayne; changing it invalidates plan proof.
        this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,current.row.id);
        const result={case_id:current.row.id,revision:current.row.revision+1,status:'BUILT_PENDING_REVIEW',completion:this.publicCompletion(next),next_action:nextAction};
        this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
        return result;
      }else if(action==='acknowledge'){
        requireThat(completed && completed.completion_hash===data.completion_hash,409,'CANDIDATE_COMPLETION_BINDING_REQUIRED');
        const handoff=this.b.one('ow_handoffs',data.handoff_id),handoffPayload=JSON.parse(handoff.payload_json);
        requireThat(handoff.case_id===current.row.id && handoff.recipient_id===actor.id
          && handoff.state==='DISPATCHED' && handoff.revision===data.handoff_revision
          && handoffPayload.gate==='DEVELOPMENT',409,'CANDIDATE_DISPATCHED_HANDOFF_REQUIRED');
        const approved=this.b.approved(current.row,'DEVELOPMENT',handoff.decision_id,actor.id);
        requireThat(REQUIRED_TESTS.every(kind=>approved.binding.authorized_tests.includes(kind)),409,'CANDIDATE_REQUIRED_TEST_AUTHORITY_MISSING');
        const acknowledged=this.b.handoffEvent(actor,{handoff_id:handoff.id,expected_revision:handoff.revision,
          state:'ACKNOWLEDGED',result_artifact_id:null,reason:null});
        const result={case_id:current.row.id,status:'ACKNOWLEDGED',revision:current.row.revision,
          handoff_id:acknowledged.handoff_id,handoff_revision:acknowledged.revision,completion_hash:completed.completion_hash};
        this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
        return result;
      }else{
        requireThat(completed && completed.completion_hash===data.completion_hash,409,'CANDIDATE_COMPLETION_BINDING_REQUIRED');
        const existing=this.registration(current.row.id);
        if(existing){
          requireThat(existing.completion_hash===data.completion_hash && existing.candidate_hash===completed.candidate.candidate_hash,409,'CANDIDATE_REGISTRATION_CONFLICT');
          this.db.prepare("UPDATE ow_tasks SET status='COMPLETED',artifact_id=? WHERE case_id=? AND kind='CANDIDATE_DISPATCH_ENGINEERING'")
            .run(completed.plan_artifact_id,current.row.id);
          const result={...existing,status:'REGISTERED',revision:current.row.revision};
          this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
          return result;
        }
        const handoff=this.b.one('ow_handoffs',data.handoff_id),handoffPayload=JSON.parse(handoff.payload_json);
        requireThat(handoff.case_id===current.row.id && handoff.recipient_id===actor.id
          && ['ACKNOWLEDGED','WORK_IN_PROGRESS'].includes(handoff.state) && handoffPayload.gate==='DEVELOPMENT',409,'CANDIDATE_APPROVED_HANDOFF_REQUIRED');
        const approved=this.b.approved(current.row,'DEVELOPMENT',handoff.decision_id,actor.id);
        requireThat(REQUIRED_TESTS.every(kind=>approved.binding.authorized_tests.includes(kind)),409,'CANDIDATE_REQUIRED_TEST_AUTHORITY_MISSING');
        requireThat(current.row.stage==='DEVELOPMENT_HANDOFF',409,'CANDIDATE_REGISTRATION_STAGE_REQUIRED');
        const development=this.b.transition(actor,{case_id:current.row.id,expected_revision:current.row.revision,action:'advance',
          to_stage:'CANDIDATE_DEVELOPMENT',artifact_id:null,artifact_ids:null,decision_id:null,owner_id:null,next_action:null});
        const content=JSON.stringify({schema_version:CANDIDATE_DISPATCH_VERSION,candidate_version:completed.candidate.candidate_version,
          candidate_hash:completed.candidate.candidate_hash,source_hash:completed.candidate.source_hash,binary_hash:completed.candidate.binary_hash,
          source_commit:completed.candidate.source_commit,pull_request_url:completed.candidate.pull_request_url,
          build_receipt_hash:completed.candidate.build_receipt_hash,change_summary:completed.candidate.change_summary,
          verification:completed.candidate.verification,dispatch_hash:completed.dispatch_hash,completion_hash:completed.completion_hash,
          authorized_tests:REQUIRED_TESTS,execution_environment:'REPLAY',authority});
        const artifactId=`test-candidate-${completed.candidate.candidate_hash.slice(7,39)}`;
        const brain=this.b.config.identities.find(entry=>entry.role==='BRAIN' && entry.strategy_ids.includes(current.row.strategy_id) && entry.instance_ids.includes(current.row.instance_id));
        requireThat(brain,409,'CANDIDATE_REVIEW_RECIPIENT_REQUIRED');
        this.b.writeArtifact(actor,{artifact_id:artifactId,case_id:current.row.id,run_id:current.row.run_id,recipient_id:brain.identity_id,
          kind:'CANDIDATE',media_type:'application/json',content,content_encoding:'utf8',content_hash:digest(content),
          candidate_hash:completed.candidate.candidate_hash,dependency_ids:[completed.plan_artifact_id]});
        const historical=this.b.transition(actor,{case_id:current.row.id,expected_revision:development.revision,action:'advance',
          to_stage:'HISTORICAL_VALIDATION',artifact_id:artifactId,artifact_ids:null,decision_id:null,owner_id:null,next_action:null});
        next={schema_version:CANDIDATE_DISPATCH_VERSION,case_id:current.row.id,completion_hash:completed.completion_hash,
          candidate_hash:completed.candidate.candidate_hash,candidate_artifact_id:artifactId,handoff_id:handoff.id,
          registered_at_utc:new Date().toISOString(),stage:historical.stage,authority};
        this.b.event(current.row.id,registrationAction,actor,next);
        this.db.prepare("UPDATE ow_tasks SET status='COMPLETED',artifact_id=? WHERE case_id=? AND kind='CANDIDATE_DISPATCH_ENGINEERING'")
          .run(completed.plan_artifact_id,current.row.id);
        const result={...next,status:'REGISTERED',revision:historical.revision};
        this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
        return result;
      }
      this.b.event(current.row.id,leaseAction,actor,next);
      this.db.prepare("UPDATE ow_tasks SET status='IN_PROGRESS',artifact_id=? WHERE case_id=? AND kind='CANDIDATE_DISPATCH_ENGINEERING'")
        .run(dispatch.plan_artifact_id,current.row.id);
      const nextAction=`Owner ${actor.id}: implement the separate TEST-only candidate pinned to dispatch ${dispatch.dispatch_id}; candidate approval, Replay execution, Paper and Live remain false.`;
      this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,current.row.id);
      const result={...next,case_id:current.row.id,revision:current.row.revision+1,dispatch,
        status:'IN_PROGRESS',next_action:nextAction};
      this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
      return result;
    });
  }

  validationPerform(action,actor,input){
    requireThat(['plan','result','complete'].includes(action),404,'UNKNOWN_CANDIDATE_VALIDATION_ACTION');
    exactKeys(input,['message_id','data']);id(input.message_id);noSecrets(input,this.b.environment);
    requireThat(input.data && typeof input.data==='object',422,'DATA_REQUIRED');
    const data=input.data,message=`candidate-validation:${input.message_id}`,requestHash=objectHash({action,data});
    return this.b.store.transaction(()=>{
      const row=this.b.one('ow_cases',data.case_id);
      const previous=this.db.prepare('SELECT * FROM ow_inbox WHERE producer_id=? AND message_id=?').get(actor.id,message);
      if(previous){requireThat(previous.payload_hash===requestHash,409,'DUPLICATE_CONFLICT');return JSON.parse(previous.result_json);}
      requireThat(actor.role==='STRATEGY' && actor.namespace==='OPERATIONAL',403,'CANDIDATE_OPERATIONAL_STRATEGY_REQUIRED');
      this.b.authorize(actor,'event.write',row.strategy_id,row.instance_id);
      const completed=this.completion(row.id),registered=this.registration(row.id);
      requireThat(completed && registered && registered.candidate_hash===completed.candidate.candidate_hash,
        409,'CANDIDATE_REGISTRATION_REQUIRED');
      requireThat(row.candidate_hash===registered.candidate_hash,409,'CANDIDATE_REGISTRATION_CONFLICT');
      const approved=this.b.approved(row,'DEVELOPMENT',null,actor.id);
      requireThat(REQUIRED_TESTS.every(kind=>approved.binding.authorized_tests.includes(kind)),409,'CANDIDATE_REQUIRED_TEST_AUTHORITY_MISSING');
      let result;
      if(action==='plan')result=this.recordValidationPlan(actor,row,completed,registered,data);
      else if(action==='result')result=this.recordValidationResult(actor,row,completed,registered,data);
      else result=this.completeValidation(actor,row,completed,registered,data);
      this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,message,requestHash,JSON.stringify(result));
      return result;
    });
  }

  recordValidationPlan(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','completion_hash','candidate_hash','baseline_hash','plan_artifact_id','tests']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION' && !this.validationPlan(row.id),409,'CANDIDATE_VALIDATION_PLAN_STATE_CONFLICT');
    requireThat(data.completion_hash===completed.completion_hash && data.candidate_hash===registered.candidate_hash
      && data.baseline_hash===row.baseline_hash && data.plan_artifact_id===completed.plan_artifact_id,
      409,'CANDIDATE_VALIDATION_PLAN_BINDING_CONFLICT');
    requireThat(Array.isArray(data.tests) && data.tests.length===REQUIRED_TESTS.length,422,'CANDIDATE_VALIDATION_TEST_MATRIX_REQUIRED');
    const runIds=new Set(),segmentIds=new Set();
    const tests=data.tests.map((test,index)=>{
      exactKeys(test,['kind','baseline_version','baseline_strategy_hash','candidate_version','telemetry_version','telemetry_hash','cost_model','cost_model_hash','acceptance','failure_rule','segments']);
      requireThat(test.kind===REQUIRED_TESTS[index],422,'CANDIDATE_VALIDATION_TEST_ORDER_REQUIRED');
      for(const key of ['baseline_strategy_hash','telemetry_hash','cost_model_hash'])requireThat(validHash(test[key]),422,'CANDIDATE_VALIDATION_TEST_HASH_REQUIRED');
      requireThat(typeof test.baseline_version==='string' && test.baseline_version.length>0
        && typeof test.telemetry_version==='string' && test.telemetry_version.length>0
        && test.candidate_version===completed.candidate.candidate_version,409,'CANDIDATE_VALIDATION_VERSION_CONFLICT');
      exactKeys(test.cost_model,['schema_version','broker_profile','product','fee_tier','currency','total_fee_per_side','effective_from','source_reference','source_type']);
      requireThat(typeof test.cost_model.schema_version==='string' && typeof test.cost_model.broker_profile==='string'
        && typeof test.cost_model.product==='string' && typeof test.cost_model.fee_tier==='string'
        && test.cost_model.currency==='USD' && Number.isFinite(test.cost_model.total_fee_per_side)
        && test.cost_model.total_fee_per_side>=0 && Number.isFinite(Date.parse(test.cost_model.effective_from))
        && typeof test.cost_model.source_reference==='string' && test.cost_model.source_reference.length>0
        && typeof test.cost_model.source_type==='string' && test.cost_model.source_type.length>0
        && objectHash(test.cost_model)===test.cost_model_hash,422,'CANDIDATE_VALIDATION_COST_MODEL_CONFLICT');
      exactKeys(test.acceptance,['evidence_integrity_only','favorable_performance_required','zero_trade_valid','costs_required','duplicate_check_required','completion_receipt_required']);
      requireThat(test.acceptance.evidence_integrity_only===true && test.acceptance.favorable_performance_required===false
        && test.acceptance.zero_trade_valid===true && test.acceptance.costs_required===true
        && test.acceptance.duplicate_check_required===true && test.acceptance.completion_receipt_required===true,
      422,'CANDIDATE_VALIDATION_ACCEPTANCE_CONFLICT');
      requireThat(typeof test.failure_rule==='string' && test.failure_rule.length>0 && test.failure_rule.length<=1000,422,'CANDIDATE_VALIDATION_FAILURE_RULE_REQUIRED');
      requireThat(Array.isArray(test.segments) && test.segments.length>0,422,'CANDIDATE_VALIDATION_SEGMENTS_REQUIRED');
      const segments=test.segments.map(segment=>{
        exactKeys(segment,['segment_id','dataset_id','dataset_revision','dataset_role','dataset_manifest_hash','contract','warmup_start_utc','scored_start_utc','scored_end_utc','baseline_run_id','candidate_run_id']);
        id(segment.segment_id);id(segment.dataset_id);id(segment.baseline_run_id,true);id(segment.candidate_run_id,true);
        requireThat(!segmentIds.has(segment.segment_id),409,'CANDIDATE_VALIDATION_SEGMENT_DUPLICATE');segmentIds.add(segment.segment_id);
        for(const runId of [segment.baseline_run_id,segment.candidate_run_id]){
          requireThat(!runIds.has(runId),409,'CANDIDATE_VALIDATION_RUN_DUPLICATE');runIds.add(runId);
        }
        requireThat(Number.isInteger(segment.dataset_revision) && segment.dataset_revision>0,422,'CANDIDATE_VALIDATION_DATASET_REVISION_REQUIRED');
        requireThat(segment.dataset_role===REQUIRED_ROLES[test.kind],422,'CANDIDATE_VALIDATION_DATASET_ROLE_REQUIRED');
        requireThat(validHash(segment.dataset_manifest_hash),422,'CANDIDATE_VALIDATION_TEST_HASH_REQUIRED');
        requireThat(typeof segment.contract==='string' && /^[A-Za-z0-9_.\[\]-]{1,80}$/.test(segment.contract),422,'CANDIDATE_VALIDATION_CONTRACT_REQUIRED');
        const warmup=Date.parse(segment.warmup_start_utc),start=Date.parse(segment.scored_start_utc),end=Date.parse(segment.scored_end_utc);
        requireThat(Number.isFinite(warmup) && Number.isFinite(start) && Number.isFinite(end) && warmup<start && start<end,422,'CANDIDATE_VALIDATION_INTERVAL_REQUIRED');
        const dataset=this.b.one('ow_datasets',`${segment.dataset_id}:${segment.dataset_revision}`),manifest=JSON.parse(dataset.payload_json);
        requireThat(dataset.strategy_id===row.strategy_id && dataset.revision===segment.dataset_revision
          && dataset.content_hash===segment.dataset_manifest_hash && manifest.dataset_manifest_id===segment.dataset_id
          && manifest.revision===segment.dataset_revision && manifest.manifest_hash===segment.dataset_manifest_hash
          && manifest.quality_status==='VERIFIED' && Array.isArray(manifest.gaps) && manifest.gaps.length===0,
        409,'CANDIDATE_VALIDATION_DATASET_CONFLICT');
        const partitions=manifest.partitions.filter(partition=>partition.partition===segment.dataset_role
          && partition.coverage_status==='COMPLETE' && contractKey(partition.symbol)===contractKey(segment.contract)
          && Date.parse(partition.start_utc)<=start && end<=Date.parse(partition.end_utc));
        requireThat(partitions.length===1,409,'CANDIDATE_VALIDATION_PARTITION_CONFLICT');
        return structuredClone(segment);
      });
      return {...structuredClone(test),segments};
    });
    requireThat(tests.at(-1).segments.every(segment=>segment.dataset_role==='HOLDOUT'),422,'CANDIDATE_VALIDATION_HOLDOUT_REQUIRED');
    const frozen={schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_artifact_id:completed.plan_artifact_id,
      completion_hash:completed.completion_hash,candidate_hash:registered.candidate_hash,baseline_hash:row.baseline_hash,
      decision_id:approvedDecisionId(this.b.approved(row,'DEVELOPMENT')),owner_id:actor.id,tests,
      authority:{...authority,authorized_tests:REQUIRED_TESTS,execution_environment:'REPLAY'},created_at_utc:new Date().toISOString()};
    const plan={...frozen,plan_hash:objectHash(frozen)};
    this.b.event(row.id,validationPlanAction,actor,plan);
    const nextAction=`Run ${tests[0].kind} from validation plan ${plan.plan_hash}; result PASS means evidence integrity only, not performance approval.`;
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,row.id);
    return {case_id:row.id,revision:row.revision+1,status:'PLANNED',plan_hash:plan.plan_hash,next_test:tests[0].kind,
      holdout_state:'SEALED',next_action:nextAction};
  }

  recordValidationResult(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','plan_hash','kind','result']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_VALIDATION_STAGE_REQUIRED');
    const plan=this.validationPlan(row.id);requireThat(plan && data.plan_hash===plan.plan_hash,409,'CANDIDATE_VALIDATION_PLAN_REQUIRED');
    requireThat(REQUIRED_TESTS.includes(data.kind),422,'CANDIDATE_VALIDATION_KIND_REQUIRED');
    const tasks=this.db.prepare('SELECT * FROM ow_tasks WHERE case_id=?').all(row.id);
    const expected=REQUIRED_TESTS.find(kind=>tasks.find(task=>task.kind===kind)?.status==='NOT_RUN');
    requireThat(data.kind===expected,409,'CANDIDATE_VALIDATION_ORDER_CONFLICT');
    if(data.kind==='OOS_HOLDOUT'){
      requireThat(REQUIRED_TESTS.slice(0,3).every(kind=>tasks.find(task=>task.kind===kind)?.status==='PASS'),409,'CANDIDATE_HOLDOUT_NOT_RELEASED');
      if(!this.latest(row.id,holdoutReleaseAction))this.b.event(row.id,holdoutReleaseAction,actor,{schema_version:CANDIDATE_VALIDATION_VERSION,
        case_id:row.id,plan_hash:plan.plan_hash,candidate_hash:row.candidate_hash,released_at_utc:new Date().toISOString(),prior_tests:REQUIRED_TESTS.slice(0,3)});
    }
    const test=plan.tests.find(item=>item.kind===data.kind),report=this.validateResult(row,completed,registered,plan,test,data.result);
    const content=JSON.stringify(report),contentHash=digest(content),artifactId=`test-validation-${data.kind.toLowerCase().replaceAll('_','-')}-${contentHash.slice(7,31)}`;
    const brain=this.b.config.identities.find(entry=>entry.role==='BRAIN' && entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id));
    requireThat(brain,409,'CANDIDATE_REVIEW_RECIPIENT_REQUIRED');
    const priorArtifacts=REQUIRED_TESTS.slice(0,REQUIRED_TESTS.indexOf(data.kind)).map(kind=>tasks.find(task=>task.kind===kind)?.artifact_id).filter(Boolean);
    this.b.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:brain.identity_id,
      kind:data.kind,media_type:'application/json',content,content_encoding:'utf8',content_hash:contentHash,
      candidate_hash:row.candidate_hash,dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id,...priorArtifacts]});
    const task=this.db.prepare('SELECT * FROM ow_tasks WHERE case_id=? AND kind=?').get(row.id,data.kind);
    this.db.prepare('UPDATE ow_tasks SET status=?,artifact_id=? WHERE id=?').run(report.status,artifactId,task.id);
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(
      report.status==='PASS'?`Run ${REQUIRED_TESTS[REQUIRED_TESTS.indexOf(data.kind)+1] || 'candidate evaluation'} from validation plan ${plan.plan_hash}.`:
        `Repair and repeat ${data.kind}; candidate evaluation remains blocked.`,row.id);
    this.b.event(row.id,validationResultAction,actor,{schema_version:CANDIDATE_VALIDATION_VERSION,plan_hash:plan.plan_hash,
      kind:data.kind,status:report.status,artifact_id:artifactId,content_hash:contentHash});
    return {case_id:row.id,revision:row.revision+1,kind:data.kind,status:report.status,artifact_id:artifactId,
      next_test:report.status==='PASS'?REQUIRED_TESTS[REQUIRED_TESTS.indexOf(data.kind)+1] || null:data.kind};
  }

  validateResult(row,completed,registered,plan,test,result){
    exactKeys(result,['status','segments','baseline','candidate','checks','comparison','contradictions','limitations','provenance']);
    requireThat(['PASS','FAIL','BLOCKED'].includes(result.status),422,'CANDIDATE_VALIDATION_RESULT_STATUS_REQUIRED');
    requireThat(Array.isArray(result.segments) && result.segments.length===test.segments.length,422,'CANDIDATE_VALIDATION_SEGMENT_RESULTS_REQUIRED');
    const measured=result.segments.map((segmentResult,index)=>{
      const segment=test.segments[index];
      exactKeys(segmentResult,['segment_id','baseline','candidate','source_files']);
      requireThat(segmentResult.segment_id===segment.segment_id,409,'CANDIDATE_VALIDATION_SEGMENT_ORDER_CONFLICT');
      requireThat(Array.isArray(segmentResult.source_files) && segmentResult.source_files.length>0,422,'CANDIDATE_VALIDATION_SOURCE_FILES_REQUIRED');
      const fileHashes=new Set(segmentResult.source_files.map(file=>{
        exactKeys(file,['path','sha256']);requireThat(path.isAbsolute(file.path) && validHash(file.sha256),422,'CANDIDATE_VALIDATION_SOURCE_FILE_REQUIRED');
        let bytes;try{requireThat(fs.statSync(file.path).isFile(),409,'CANDIDATE_VALIDATION_SOURCE_FILE_MISSING');bytes=fs.readFileSync(file.path);}
        catch(error){if(error?.code==='CANDIDATE_VALIDATION_SOURCE_FILE_MISSING')throw error;requireThat(false,409,'CANDIDATE_VALIDATION_SOURCE_FILE_MISSING');}
        requireThat(digest(bytes)===file.sha256,409,'CANDIDATE_VALIDATION_SOURCE_FILE_HASH_CONFLICT');return file.sha256;
      }));
      const evidence={};
      for(const name of ['baseline','candidate']){
        const value=segmentResult[name];
        exactKeys(value,['run_id','strategy_version','strategy_hash','telemetry_version','telemetry_hash','trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods','completion_receipt_hash','data_quality_flags']);
        id(value.run_id,true);for(const key of ['strategy_hash','telemetry_hash','completion_receipt_hash'])requireThat(validHash(value[key]),422,'CANDIDATE_VALIDATION_EVIDENCE_HASH_REQUIRED');
        requireThat(value.run_id===segment[`${name}_run_id`],409,'CANDIDATE_VALIDATION_RUN_BINDING_CONFLICT');
        requireThat(typeof value.strategy_version==='string' && typeof value.telemetry_version==='string',422,'CANDIDATE_VALIDATION_EVIDENCE_VERSION_REQUIRED');
        for(const key of metricKeys)requireThat(Number.isFinite(value[key]),422,'CANDIDATE_VALIDATION_METRIC_REQUIRED');
        requireThat(Number.isInteger(value.trade_count) && value.trade_count>=0 && value.fees>=0
          && Number.isInteger(value.short_trade_count) && value.short_trade_count>=0
          && Number.isInteger(value.zero_trade_periods) && value.zero_trade_periods>=0
          && sameNumber(value.net_pnl,value.gross_pnl-value.fees) && Array.isArray(value.data_quality_flags),422,'CANDIDATE_VALIDATION_METRIC_INVALID');
        requireThat(value.strategy_version===(name==='baseline'?test.baseline_version:completed.candidate.candidate_version)
          && value.strategy_hash===(name==='baseline'?test.baseline_strategy_hash:registered.candidate_hash)
          && value.telemetry_version===test.telemetry_version && value.telemetry_hash===test.telemetry_hash,
        409,'CANDIDATE_VALIDATION_EVIDENCE_BINDING_CONFLICT');
        requireThat(fileHashes.has(value.strategy_hash) && fileHashes.has(value.telemetry_hash)
          && fileHashes.has(value.completion_receipt_hash),409,'CANDIDATE_VALIDATION_SOURCE_FILE_BINDING_CONFLICT');
        evidence[name]=structuredClone(value);
      }
      return {segment_id:segment.segment_id,...evidence,source_files:segmentResult.source_files
        .map(file=>({file_name:path.basename(file.path),sha256:file.sha256}))};
    });
    for(const name of ['baseline','candidate']){
      const aggregate=result[name];
      exactKeys(aggregate,['strategy_version','strategy_hash','telemetry_version','telemetry_hash','trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods','data_quality_flags']);
      requireThat(aggregate.strategy_version===(name==='baseline'?test.baseline_version:completed.candidate.candidate_version)
        && aggregate.strategy_hash===(name==='baseline'?test.baseline_strategy_hash:registered.candidate_hash)
        && aggregate.telemetry_version===test.telemetry_version && aggregate.telemetry_hash===test.telemetry_hash
        && Array.isArray(aggregate.data_quality_flags),409,'CANDIDATE_VALIDATION_AGGREGATE_BINDING_CONFLICT');
      for(const key of metricKeys){
        const expected=measured.reduce((sum,item)=>sum+item[name][key],0);
        requireThat(Number.isFinite(aggregate[key]) && sameNumber(aggregate[key],expected),409,'CANDIDATE_VALIDATION_AGGREGATE_CONFLICT');
      }
      const flags=[...new Set(measured.flatMap(item=>item[name].data_quality_flags))].sort();
      requireThat(objectHash([...aggregate.data_quality_flags].sort())===objectHash(flags),409,'CANDIDATE_VALIDATION_AGGREGATE_CONFLICT');
    }
    exactKeys(result.checks,['physical_strategy_hash_verified','telemetry_attribution_complete','fees_reconciled','duplicates_absent','zero_trade_periods_recorded','completion_receipt_verified','same_window_and_cost_model','database_read_completed']);
    const integrity=Object.values(result.checks).every(value=>value===true);
    requireThat(result.status!=='PASS' || integrity,409,'CANDIDATE_VALIDATION_PASS_EVIDENCE_INCOMPLETE');
    exactKeys(result.provenance,['cost_model','cost_model_hash']);
    requireThat(result.provenance.cost_model_hash===test.cost_model_hash
      && objectHash(result.provenance.cost_model)===test.cost_model_hash
      && objectHash(result.provenance.cost_model)===objectHash(test.cost_model),409,'CANDIDATE_VALIDATION_PROVENANCE_CONFLICT');
    requireThat(result.comparison && typeof result.comparison==='object' && !Array.isArray(result.comparison)
      && Array.isArray(result.contradictions) && Array.isArray(result.limitations)
      && result.provenance && typeof result.provenance==='object' && !Array.isArray(result.provenance),422,'CANDIDATE_VALIDATION_RESULT_STRUCTURE_REQUIRED');
    return {schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_hash:plan.plan_hash,
      plan_artifact_id:completed.plan_artifact_id,completion_hash:completed.completion_hash,candidate_hash:registered.candidate_hash,
      baseline_hash:row.baseline_hash,test,status:result.status,evidence_integrity_passed:integrity,...structuredClone(result),segments:measured,
      recorded_at_utc:new Date().toISOString(),authority:{...authority,execution_environment:'REPLAY'}};
  }

  completeValidation(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','plan_hash']);
    const plan=this.validationPlan(row.id);requireThat(plan && data.plan_hash===plan.plan_hash,409,'CANDIDATE_VALIDATION_PLAN_REQUIRED');
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_VALIDATION_STAGE_REQUIRED');
    const tasks=this.db.prepare('SELECT kind,status,artifact_id FROM ow_tasks WHERE case_id=?').all(row.id);
    requireThat(REQUIRED_TESTS.every(kind=>tasks.some(task=>task.kind===kind && task.status==='PASS' && task.artifact_id)),409,'REQUIRED_SUBTESTS_INCOMPLETE');
    const next=this.b.transition(actor,{case_id:row.id,expected_revision:row.revision,action:'advance',to_stage:'CANDIDATE_EVALUATION',
      artifact_id:null,artifact_ids:null,decision_id:null,owner_id:null,next_action:null});
    const completion={schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_hash:plan.plan_hash,
      candidate_hash:registered.candidate_hash,completion_hash:completed.completion_hash,artifacts:REQUIRED_TESTS.map(kind=>({kind,artifact_id:tasks.find(task=>task.kind===kind).artifact_id})),
      completed_at_utc:new Date().toISOString(),next_stage:'CANDIDATE_EVALUATION',authority};
    this.b.event(row.id,validationCompletionAction,actor,completion);
    return {case_id:row.id,revision:next.revision,status:'COMPLETED',stage:next.stage,
      next_action:'Obsidian Brain must evaluate the cumulative evidence and record benefit supported or no benefit established; no promotion is automatic.'};
  }
}

function approvedDecisionId(approval){return approval.decision.id;}
