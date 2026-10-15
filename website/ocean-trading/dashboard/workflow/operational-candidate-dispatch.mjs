import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, exactKeys, id, noSecrets, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_DISPATCH_VERSION='ocean-operational-candidate-dispatch/v2';
export const CANDIDATE_VALIDATION_VERSION='ocean-operational-candidate-validation/v3';
export const CANDIDATE_VALIDATION_PLAN_VERSION='ocean-operational-candidate-validation/v4';
const ORIGIN='OPERATIONAL_RESEARCH_CONTINUATION';
const leaseAction='operational.candidate.dispatch.lease';
const completionAction='operational.candidate.dispatch.completed';
const registrationAction='operational.candidate.dispatch.registered';
const validationPlanAction='operational.candidate.validation.plan';
const validationResultAction='operational.candidate.validation.result';
const holdoutReleaseAction='operational.candidate.validation.holdout_released';
const validationCompletionAction='operational.candidate.validation.completed';
const validationRevalidationAction='operational.candidate.validation.revalidation_required';
const REQUIRED_TESTS=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const REQUIRED_ROLES=Object.freeze({BACKTEST:'DISCOVERY',ROBUSTNESS:'DISCOVERY',WALK_FORWARD:'VALIDATION',OOS_HOLDOUT:'HOLDOUT'});
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exactObjectKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const sameNumber=(left,right)=>Math.abs(left-right)<=1e-6;
const contractKey=value=>String(value).replace(/\[M\]$/,'');
const metricKeys=Object.freeze(['trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods']);
const physicalHashKeys=Object.freeze(['strategy_source_hash','strategy_dll_hash','strategy_marker_hash','completion_receipt_hash']);
const candidateExecutionVersion=(test,completed)=>test.candidate_execution_version || test.candidate_version || completed.candidate.candidate_version;
const candidateExecutionHash=(test,registered)=>test.candidate_execution_hash || registered.candidate_hash;
const markerLimitation=runId=>`Marker bytes were not retained for ${runId}; the marker hash remains sealed in its completion receipt.`;
const londonChartTime=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value)).replace('T',' ');
const qualityFlags=value=>String(value || '').split(',').map(item=>item.trim()).filter(Boolean).sort();
export const acceptedTestRevisionCompatible=(existing,proposed)=>{
  if(!existing || !proposed)return false;
  if(objectHash(existing)===objectHash(proposed))return true;
  if(Object.hasOwn(existing,'baseline_execution_source_hash') || Object.hasOwn(existing,'candidate_execution_source_hash'))return false;
  const legacyComparable=structuredClone(proposed);
  delete legacyComparable.baseline_execution_source_hash;
  delete legacyComparable.candidate_execution_source_hash;
  return objectHash(existing)===objectHash(legacyComparable);
};
export const pendingTestRerunCompatible=(existing,proposed)=>{
  if(!existing || !proposed || existing.kind!==proposed.kind || !Array.isArray(existing.segments)
    || !Array.isArray(proposed.segments) || existing.segments.length!==proposed.segments.length)return false;
  const normalized=structuredClone(proposed);
  for(let index=0;index<normalized.segments.length;index++){
    normalized.segments[index].baseline_run_id=existing.segments[index].baseline_run_id;
    normalized.segments[index].candidate_run_id=existing.segments[index].candidate_run_id;
  }
  if(!Object.hasOwn(existing,'baseline_execution_source_hash'))delete normalized.baseline_execution_source_hash;
  if(!Object.hasOwn(existing,'candidate_execution_source_hash'))delete normalized.candidate_execution_source_hash;
  return objectHash(existing)===objectHash(normalized);
};

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
  validationCompletion(caseId){
    const row=this.db.prepare(`SELECT action,payload_json FROM ow_events WHERE entity_id=? AND action IN (?,?) ORDER BY id DESC LIMIT 1`)
      .get(caseId,validationCompletionAction,validationRevalidationAction);
    return row?.action===validationCompletionAction?JSON.parse(row.payload_json).payload:null;
  }
  activeHoldoutRelease(caseId){
    const row=this.db.prepare(`SELECT release.payload_json FROM ow_events release
      WHERE release.entity_id=? AND release.action=?
      AND release.id>COALESCE((SELECT MAX(reopened.id) FROM ow_events reopened
        WHERE reopened.entity_id=release.entity_id AND reopened.action=?),0)
      ORDER BY release.id DESC LIMIT 1`).get(caseId,holdoutReleaseAction,validationRevalidationAction);
    return row?JSON.parse(row.payload_json).payload:null;
  }
  validationArtifactCompatible(row,plan,kind,artifactId){
    try{
      if(!artifactId)return false;
      const test=plan.tests.find(item=>item.kind===kind);
      const artifact=this.b.artifactFor(row,artifactId,kind);
      const report=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      const bindings=report.execution_bindings;
      const completed=this.completion(row.id);
      const runsValid=name=>Array.isArray(bindings?.[name]?.runs)
        && bindings[name].runs.length===test.segments.length
        && bindings[name].runs.every((run,index)=>exactObjectKeys(run,['run_id','physical_hashes','marker_bytes_available'])
          && run.run_id===test.segments[index][`${name}_run_id`]
          && exactObjectKeys(run.physical_hashes,physicalHashKeys)
          && run.physical_hashes.strategy_source_hash===(name==='baseline'
            ?test.baseline_execution_source_hash:test.candidate_execution_source_hash)
          && run.physical_hashes.strategy_dll_hash===(name==='baseline'
            ?test.baseline_strategy_hash:candidateExecutionHash(test,{candidate_hash:row.candidate_hash}))
          && new Set(Object.values(run.physical_hashes)).size===physicalHashKeys.length);
      return plan.schema_version===CANDIDATE_VALIDATION_PLAN_VERSION
        && validHash(test?.baseline_execution_source_hash) && validHash(test?.candidate_execution_source_hash)
        && report.schema_version===CANDIDATE_VALIDATION_VERSION && report.case_id===row.id
        && report.plan_hash===plan.plan_hash && report.plan_artifact_id===plan.plan_artifact_id
        && report.completion_hash===completed?.completion_hash
        && report.candidate_hash===row.candidate_hash && report.baseline_hash===row.baseline_hash
        && report.status==='PASS' && report.evidence_integrity_passed===true
        && objectHash(report.test)===objectHash(test)
        && exactObjectKeys(report.comparison,['reported_delta'])
        && objectHash(report.authority)===objectHash({...authority,execution_environment:'REPLAY'})
        && exactObjectKeys(bindings,['baseline','candidate'])
        && exactObjectKeys(bindings.baseline,['logical_hash','strategy_version','runs'])
        && exactObjectKeys(bindings.candidate,['logical_hash','strategy_version','runs'])
        && bindings?.baseline?.logical_hash===row.baseline_hash
        && bindings.baseline.strategy_version===test.baseline_version
        && bindings?.candidate?.logical_hash===row.candidate_hash
        && bindings.candidate.strategy_version===candidateExecutionVersion(test,completed)
        && runsValid('baseline') && runsValid('candidate');
    }catch{return false;}
  }
  reconcileValidationArtifacts(actor,row,plan,tasks,{completionEventId=null}={}){
    const firstInvalid=REQUIRED_TESTS.findIndex(kind=>{
      const task=tasks.find(item=>item.kind===kind);
      return task?.status==='PASS' && !this.validationArtifactCompatible(row,plan,kind,task.artifact_id);
    });
    if(firstInvalid<0)return null;
    const resetKinds=REQUIRED_TESTS.slice(firstInvalid);
    const placeholders=resetKinds.map(()=>'?').join(',');
    const strategyOwner=this.b.config.identities.find(identity=>identity.namespace==='OPERATIONAL'
      && identity.role==='STRATEGY' && !identity.revoked && Date.parse(identity.expires_at_utc)>Date.now()
      && identity.strategy_ids?.includes(row.strategy_id) && identity.instance_ids?.includes(row.instance_id));
    requireThat(strategyOwner,409,'CANDIDATE_REVALIDATION_STRATEGY_OWNER_REQUIRED');
    this.db.prepare(`UPDATE ow_tasks SET status='NOT_RUN',artifact_id=NULL WHERE case_id=? AND kind IN (${placeholders})`)
      .run(row.id,...resetKinds);
    const nextAction=`Revalidate ${resetKinds[0]} from sealed source evidence under validation plan ${plan.plan_hash}; legacy artifacts remain immutable history.`;
    this.db.prepare("UPDATE ow_cases SET stage='HISTORICAL_VALIDATION',revision=revision+1,owner_id=?,waiting_on=? WHERE id=?")
      .run(strategyOwner.identity_id,nextAction,row.id);
    this.b.event(row.id,validationRevalidationAction,actor,{schema_version:CANDIDATE_VALIDATION_VERSION,
      plan_hash:plan.plan_hash,completion_event_id:completionEventId,reset_kinds:resetKinds,next_action:nextAction});
    return {case_id:row.id,revision:row.revision+1,status:'REVALIDATION_REQUIRED',stage:'HISTORICAL_VALIDATION',
      next_test:resetKinds[0],reset_kinds:resetKinds,next_action:nextAction};
  }
  rebindAcceptedArtifacts(actor,row,existing,plan,tasks,completed,registered){
    for(const task of tasks.filter(item=>item.status==='PASS' && item.artifact_id)){
      if(!this.validationArtifactCompatible(row,existing,task.kind,task.artifact_id))continue;
      const artifact=this.b.artifactFor(row,task.artifact_id,task.kind);
      const report=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      const rebound={...report,plan_hash:plan.plan_hash,test:structuredClone(plan.tests.find(item=>item.kind===task.kind)),
        recorded_at_utc:new Date().toISOString()};
      const content=JSON.stringify(rebound),contentHash=digest(content);
      const artifactId=`test-validation-${task.kind.toLowerCase().replaceAll('_','-')}-${contentHash.slice(7,31)}`;
      this.b.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:artifact.recipient_id,
        kind:task.kind,media_type:'application/json',content,content_encoding:'utf8',content_hash:contentHash,
        candidate_hash:row.candidate_hash,dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id,task.artifact_id]});
      this.db.prepare('UPDATE ow_tasks SET artifact_id=? WHERE case_id=? AND kind=?').run(artifactId,row.id,task.kind);
      this.b.event(row.id,validationResultAction,actor,{schema_version:CANDIDATE_VALIDATION_VERSION,plan_hash:plan.plan_hash,
        kind:task.kind,status:'PASS',artifact_id:artifactId,content_hash:contentHash,revalidated_from_artifact_id:task.artifact_id});
    }
  }
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
      validation:validation?{schema_version:validation.schema_version || CANDIDATE_VALIDATION_VERSION,plan_hash:validation.plan_hash,
        status:validationComplete?'COMPLETED':'PLANNED',tests:validation.tests.map(test=>({kind:test.kind,
          state:test.kind==='OOS_HOLDOUT' && !this.activeHoldoutRelease(row.id)?'SEALED':'RELEASED'}))}:null};
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
    exactKeys(data,['case_id','expected_revision','completion_hash','candidate_hash','baseline_hash','plan_artifact_id','tests','supersedes_plan_hash']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    const existing=this.validationPlan(row.id);
    let tasks=[];
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_VALIDATION_PLAN_STATE_CONFLICT');
    if(existing){
      tasks=this.db.prepare('SELECT kind,status,artifact_id FROM ow_tasks WHERE case_id=? AND kind IN (?,?,?,?)')
        .all(row.id,...REQUIRED_TESTS);
      const taskByKind=new Map(tasks.map(task=>[task.kind,task.status]));
      const acceptedTestsPreserved=REQUIRED_TESTS.every(kind=>{
        if(taskByKind.get(kind)!=='PASS')return true;
        const proposed=Array.isArray(data.tests)?data.tests.find(test=>test?.kind===kind):null;
        return acceptedTestRevisionCompatible(existing.tests.find(test=>test.kind===kind),proposed);
      });
      const anyEvidenceConsumed=tasks.some(task=>task.status==='PASS');
      const pendingTestsFrozen=!anyEvidenceConsumed || REQUIRED_TESTS.every(kind=>{
        if(taskByKind.get(kind)!=='NOT_RUN')return true;
        const proposed=Array.isArray(data.tests)?data.tests.find(test=>test?.kind===kind):null;
        return pendingTestRerunCompatible(existing.tests.find(test=>test.kind===kind),proposed);
      });
      requireThat(data.supersedes_plan_hash===existing.plan_hash
        && tasks.length===REQUIRED_TESTS.length && tasks.every(task=>['PASS','NOT_RUN'].includes(task.status))
        && tasks.some(task=>task.status==='NOT_RUN') && acceptedTestsPreserved && pendingTestsFrozen,
      409,'CANDIDATE_VALIDATION_PLAN_REVISION_NOT_ALLOWED');
    }else requireThat(data.supersedes_plan_hash===undefined,409,'CANDIDATE_VALIDATION_PLAN_REVISION_CONFLICT');
    requireThat(data.completion_hash===completed.completion_hash && data.candidate_hash===registered.candidate_hash
      && data.baseline_hash===row.baseline_hash && data.plan_artifact_id===completed.plan_artifact_id,
      409,'CANDIDATE_VALIDATION_PLAN_BINDING_CONFLICT');
    requireThat(Array.isArray(data.tests) && data.tests.length===REQUIRED_TESTS.length,422,'CANDIDATE_VALIDATION_TEST_MATRIX_REQUIRED');
    const runIds=new Set(),segmentIds=new Set();
    const tests=data.tests.map((test,index)=>{
      exactKeys(test,['kind','baseline_version','baseline_strategy_hash','baseline_execution_source_hash','candidate_version','candidate_execution_version','candidate_execution_hash','candidate_execution_source_hash','telemetry_version','telemetry_hash','cost_model','cost_model_hash','acceptance','failure_rule','segments']);
      requireThat(test.kind===REQUIRED_TESTS[index],422,'CANDIDATE_VALIDATION_TEST_ORDER_REQUIRED');
      for(const key of ['baseline_strategy_hash','baseline_execution_source_hash','candidate_execution_hash','candidate_execution_source_hash','telemetry_hash','cost_model_hash'])requireThat(validHash(test[key]),422,'CANDIDATE_VALIDATION_TEST_HASH_REQUIRED');
      requireThat(typeof test.baseline_version==='string' && test.baseline_version.length>0
        && typeof test.candidate_execution_version==='string' && test.candidate_execution_version.length>0
        && typeof test.telemetry_version==='string' && test.telemetry_version.length>0
        && test.candidate_version===completed.candidate.candidate_version,409,'CANDIDATE_VALIDATION_VERSION_CONFLICT');
      requireThat(test.candidate_execution_hash!==test.baseline_strategy_hash,409,'CANDIDATE_VALIDATION_EXECUTION_BINDING_CONFLICT');
      if(test.candidate_execution_version===completed.candidate.candidate_version
        && test.candidate_execution_hash===registered.candidate_hash)
        requireThat(test.candidate_execution_source_hash===completed.candidate.source_hash,409,'CANDIDATE_VALIDATION_CANDIDATE_SOURCE_CONFLICT');
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
    const now=new Date().toISOString();
    const createdAt=existing && Date.parse(now)<Date.parse(existing.created_at_utc)?existing.created_at_utc:now;
    const frozen={schema_version:CANDIDATE_VALIDATION_PLAN_VERSION,case_id:row.id,plan_revision:(existing?.plan_revision || 1)+(existing?1:0),
      supersedes_plan_hash:existing?.plan_hash || null,plan_artifact_id:completed.plan_artifact_id,
      completion_hash:completed.completion_hash,candidate_hash:registered.candidate_hash,baseline_hash:row.baseline_hash,
      decision_id:existing?.decision_id || approvedDecisionId(this.b.approved(row,'DEVELOPMENT')),
      owner_id:existing?.owner_id || actor.id,tests,
      authority:{...authority,authorized_tests:REQUIRED_TESTS,execution_environment:'REPLAY'},created_at_utc:createdAt};
    const plan={...frozen,plan_hash:objectHash(frozen)};
    this.b.event(row.id,validationPlanAction,actor,plan);
    if(existing)this.rebindAcceptedArtifacts(actor,row,existing,plan,tasks,completed,registered);
    const taskStatus=new Map(this.db.prepare('SELECT kind,status FROM ow_tasks WHERE case_id=? AND kind IN (?,?,?,?)')
      .all(row.id,...REQUIRED_TESTS).map(task=>[task.kind,task.status]));
    const nextTest=REQUIRED_TESTS.find(kind=>taskStatus.get(kind)==='NOT_RUN') || tests[0].kind;
    const nextAction=`Run ${nextTest} from validation plan ${plan.plan_hash}; result PASS means evidence integrity only, not performance approval.`;
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,row.id);
    return {case_id:row.id,revision:row.revision+1,status:'PLANNED',plan_revision:plan.plan_revision,
      supersedes_plan_hash:plan.supersedes_plan_hash,plan_hash:plan.plan_hash,next_test:nextTest,
      holdout_state:'SEALED',next_action:nextAction};
  }

  recordValidationResult(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','plan_hash','kind','result']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_VALIDATION_STAGE_REQUIRED');
    const plan=this.validationPlan(row.id);requireThat(plan && data.plan_hash===plan.plan_hash,409,'CANDIDATE_VALIDATION_PLAN_REQUIRED');
    requireThat(REQUIRED_TESTS.includes(data.kind),422,'CANDIDATE_VALIDATION_KIND_REQUIRED');
    const tasks=this.db.prepare('SELECT * FROM ow_tasks WHERE case_id=?').all(row.id);
    const reconciliation=this.reconcileValidationArtifacts(actor,row,plan,tasks);
    if(reconciliation)return reconciliation;
    const expected=REQUIRED_TESTS.find(kind=>tasks.find(task=>task.kind===kind)?.status==='NOT_RUN');
    requireThat(data.kind===expected,409,'CANDIDATE_VALIDATION_ORDER_CONFLICT');
    if(data.kind==='OOS_HOLDOUT'){
      requireThat(REQUIRED_TESTS.slice(0,3).every(kind=>tasks.find(task=>task.kind===kind)?.status==='PASS'),409,'CANDIDATE_HOLDOUT_NOT_RELEASED');
      if(!this.activeHoldoutRelease(row.id))this.b.event(row.id,holdoutReleaseAction,actor,{schema_version:CANDIDATE_VALIDATION_VERSION,
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
    requireThat(result.comparison && typeof result.comparison==='object' && !Array.isArray(result.comparison)
      && Array.isArray(result.contradictions) && Array.isArray(result.limitations)
      && result.provenance && typeof result.provenance==='object' && !Array.isArray(result.provenance),422,'CANDIDATE_VALIDATION_RESULT_STRUCTURE_REQUIRED');
    requireThat(Array.isArray(result.segments) && result.segments.length===test.segments.length,422,'CANDIDATE_VALIDATION_SEGMENT_RESULTS_REQUIRED');
    const bindingRuns={baseline:[],candidate:[]};
    const measured=result.segments.map((segmentResult,index)=>{
      const segment=test.segments[index];
      exactKeys(segmentResult,['segment_id','baseline','candidate','source_files']);
      requireThat(segmentResult.segment_id===segment.segment_id,409,'CANDIDATE_VALIDATION_SEGMENT_ORDER_CONFLICT');
      requireThat(Array.isArray(segmentResult.source_files) && segmentResult.source_files.length>0,422,'CANDIDATE_VALIDATION_SOURCE_FILES_REQUIRED');
      const sourceFiles=segmentResult.source_files.map(file=>{
        exactKeys(file,['path','sha256']);requireThat(path.isAbsolute(file.path) && validHash(file.sha256),422,'CANDIDATE_VALIDATION_SOURCE_FILE_REQUIRED');
        let bytes;try{requireThat(fs.statSync(file.path).isFile(),409,'CANDIDATE_VALIDATION_SOURCE_FILE_MISSING');bytes=fs.readFileSync(file.path);}
        catch(error){if(error?.code==='CANDIDATE_VALIDATION_SOURCE_FILE_MISSING')throw error;requireThat(false,409,'CANDIDATE_VALIDATION_SOURCE_FILE_MISSING');}
        requireThat(digest(bytes)===file.sha256,409,'CANDIDATE_VALIDATION_SOURCE_FILE_HASH_CONFLICT');return {...file,bytes};
      });
      const fileHashes=new Set(sourceFiles.map(file=>file.sha256));
      const evidence={};
      for(const name of ['baseline','candidate']){
        const value=segmentResult[name];
        exactKeys(value,['run_id','strategy_version','strategy_hash','telemetry_version','telemetry_hash','trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods','terminal_trade_count','boundary_cleanup_trade_id','completion_receipt_hash','physical_hashes','data_quality_flags']);
        id(value.run_id,true);for(const key of ['strategy_hash','telemetry_hash','completion_receipt_hash'])requireThat(validHash(value[key]),422,'CANDIDATE_VALIDATION_EVIDENCE_HASH_REQUIRED');
        exactKeys(value.physical_hashes,physicalHashKeys);
        requireThat(physicalHashKeys.every(key=>validHash(value.physical_hashes[key]))
          && new Set(Object.values(value.physical_hashes)).size===physicalHashKeys.length
          && value.physical_hashes.strategy_dll_hash===value.strategy_hash
          && value.physical_hashes.completion_receipt_hash===value.completion_receipt_hash,
        409,'CANDIDATE_VALIDATION_PHYSICAL_BINDING_CONFLICT');
        requireThat(value.run_id===segment[`${name}_run_id`],409,'CANDIDATE_VALIDATION_RUN_BINDING_CONFLICT');
        requireThat(typeof value.strategy_version==='string' && typeof value.telemetry_version==='string',422,'CANDIDATE_VALIDATION_EVIDENCE_VERSION_REQUIRED');
        for(const key of metricKeys)requireThat(Number.isFinite(value[key]),422,'CANDIDATE_VALIDATION_METRIC_REQUIRED');
        requireThat(Number.isInteger(value.trade_count) && value.trade_count>=0 && value.fees>=0
          && Number.isInteger(value.short_trade_count) && value.short_trade_count>=0
          && Number.isInteger(value.zero_trade_periods) && value.zero_trade_periods>=0
          && Number.isInteger(value.terminal_trade_count) && value.terminal_trade_count>=value.trade_count
          && value.terminal_trade_count-value.trade_count<2
          && (value.boundary_cleanup_trade_id===null || (typeof value.boundary_cleanup_trade_id==='string' && value.boundary_cleanup_trade_id.length>0))
          && (value.terminal_trade_count===value.trade_count)===(value.boundary_cleanup_trade_id===null)
          && sameNumber(value.net_pnl,value.gross_pnl-value.fees) && Array.isArray(value.data_quality_flags),422,'CANDIDATE_VALIDATION_METRIC_INVALID');
        requireThat(value.strategy_version===(name==='baseline'?test.baseline_version:candidateExecutionVersion(test,completed))
          && value.strategy_hash===(name==='baseline'?test.baseline_strategy_hash:candidateExecutionHash(test,registered))
          && value.telemetry_version===test.telemetry_version && value.telemetry_hash===test.telemetry_hash,
        409,'CANDIDATE_VALIDATION_EVIDENCE_BINDING_CONFLICT');
        requireThat(fileHashes.has(value.strategy_hash) && fileHashes.has(value.telemetry_hash)
          && fileHashes.has(value.completion_receipt_hash),409,'CANDIDATE_VALIDATION_SOURCE_FILE_BINDING_CONFLICT');
        const receiptFile=sourceFiles.find(file=>file.sha256===value.completion_receipt_hash);
        let receipt;try{receipt=JSON.parse(receiptFile.bytes.toString('utf8'));}catch{requireThat(false,409,'CANDIDATE_VALIDATION_COMPLETION_RECEIPT_INVALID');}
        const physical=receipt?.physical_binaries;
        requireThat(receipt?.run_id===value.run_id
          && physical?.replay_source?.sha256===value.physical_hashes.strategy_source_hash
          && physical?.replay_dll?.sha256===value.physical_hashes.strategy_dll_hash
          && physical?.replay_marker?.sha256===value.physical_hashes.strategy_marker_hash,
        409,'CANDIDATE_VALIDATION_COMPLETION_RECEIPT_BINDING_CONFLICT');
        const cleanupApplied=value.boundary_cleanup_trade_id!==null;
        const boundaryClose=receipt.runner_boundary_proof?.test_boundary_close;
        const scoredReceiptCount=receipt.logger_receipt?.scored_closed_trade_count
          ?? (cleanupApplied?null:receipt.logger_receipt?.closed_trade_count);
        let boundaryProofValid=boundaryClose?.applied===cleanupApplied;
        if(cleanupApplied){
          const immutable=boundaryClose?.immutable_proof,proofPath=String(immutable?.path || '');
          let proofBytes=null;
          if(path.isAbsolute(proofPath) && fs.existsSync(proofPath) && fs.statSync(proofPath).isFile()){
            proofBytes=fs.readFileSync(proofPath);
          }
          boundaryProofValid=boundaryProofValid && receipt.runner_boundary_proof?.scored_boundary_open_trade_excluded===true
            && String(boundaryClose?.cleanup_trade_id || '')===value.boundary_cleanup_trade_id
            && Number(boundaryClose?.terminal_trade_count)===Number(value.terminal_trade_count)
            && Number(boundaryClose?.scored_trade_count)===Number(value.trade_count)
            && proofBytes!==null && Number.isInteger(Number(immutable?.bytes)) && Number(immutable.bytes)===proofBytes.length
            && validHash(immutable?.sha256) && digest(proofBytes)===immutable.sha256;
          if(boundaryProofValid){
            const proof=JSON.parse(proofBytes.toString('utf8'));
            boundaryProofValid=proof.schema_version==='oql.vwap-test-boundary-close/v3' && proof.run_id===value.run_id
              && String(proof.cleanup_trade_id)===value.boundary_cleanup_trade_id
              && JSON.stringify(proof.before?.open_trade_ids)===JSON.stringify([Number(value.boundary_cleanup_trade_id)])
              && JSON.stringify(proof.after?.open_trade_ids)===JSON.stringify([]);
          }
        }
        requireThat(receipt.schema_version==='ocean-replay-test-completion/v1' && receipt.run_kind==='TEST' && receipt.status==='COMPLETED'
          && receipt.requested_replay_window?.start_chart_time===londonChartTime(segment.warmup_start_utc)
          && receipt.requested_replay_window?.end_chart_time===londonChartTime(segment.scored_end_utc)
          && receipt.execution_identity?.strategy_id===row.strategy_id
          && receipt.execution_identity?.trade_strategy_version===value.strategy_version
          && contractKey(receipt.execution_identity?.symbol)===contractKey(segment.contract)
          && receipt.execution_identity?.chart_number===1
          && Number(receipt.logger_receipt?.closed_trade_count)===Number(value.terminal_trade_count)
          && Number(scoredReceiptCount)===Number(value.trade_count)
          && boundaryProofValid
          && receipt.safety?.simulation_account==='Sim1' && receipt.safety?.all_trades_simulated===true
          && receipt.safety?.all_fills_simulated===true && receipt.safety?.live_real==='DISABLED'
          && receipt.safety?.workflow_status_mutated===false,
        409,'CANDIDATE_VALIDATION_COMPLETION_RECEIPT_SCOPE_CONFLICT');
        let snapshot;
        for(const file of sourceFiles.filter(item=>path.basename(item.path).toLowerCase()==='run-snapshot.json')){
          try{const parsed=JSON.parse(file.bytes.toString('utf8'));if(parsed?.run?.run_id===value.run_id){snapshot=parsed;break;}}catch{}
        }
        requireThat(snapshot?.schema_version==='ocean-candidate-validation-run-snapshot/v1'
          && snapshot.run?.run_id===value.run_id && snapshot.run?.strategy_id===row.strategy_id
          && snapshot.run?.strategy_version===receipt.execution_identity.strategy_version
          && snapshot.logger_receipt?.run_id===value.run_id && snapshot.logger_receipt?.trade_account==='Sim1'
          && Number(snapshot.logger_receipt?.closed_trade_count)===Number(snapshot.terminal_metrics?.trade_count)
          && Number(snapshot.terminal_metrics?.trade_count)===Number(value.terminal_trade_count)
          && Boolean(snapshot.scored_boundary?.cleanup_applied)===cleanupApplied
          && Number(snapshot.scored_boundary?.scored_closed_trade_count)===Number(value.trade_count)
          && Number(snapshot.scored_boundary?.terminal_trade_count)===Number(value.terminal_trade_count)
          && (cleanupApplied?(String(snapshot.scored_boundary?.cleanup_trade_id || snapshot.scored_boundary?.cleanup_trade?.trade_id || '')===value.boundary_cleanup_trade_id
            && snapshot.scored_boundary?.immutable_proof?.sha256===boundaryClose.immutable_proof.sha256
            && Number(snapshot.scored_boundary?.immutable_proof?.bytes)===Number(boundaryClose.immutable_proof.bytes)):true)
          && Number(snapshot.metrics?.open_trade_count)===0
          && Number(snapshot.duplicate_check?.total_rows)===Number(snapshot.duplicate_check?.distinct_rows)
          && metricKeys.every(key=>sameNumber(Number(snapshot.metrics?.[key]),Number(value[key])))
          && objectHash(qualityFlags(snapshot.context?.data_quality_flags))===objectHash([...value.data_quality_flags].sort()),
        409,'CANDIDATE_VALIDATION_RUN_SNAPSHOT_CONFLICT');
        let cost;
        for(const file of sourceFiles.filter(item=>path.basename(item.path).toLowerCase()==='telemetry.sqlite')){
          try{
            const telemetry=new DatabaseSync(':memory:');
            try{
              telemetry.deserialize(file.bytes);
              const runExists=Number(telemetry.prepare('SELECT COUNT(*) AS n FROM replay_runs WHERE run_id=?').get(value.run_id)?.n || 0);
              if(runExists===1)cost=telemetry.prepare(`SELECT COUNT(*) AS total_rows,
                SUM(CASE WHEN trade_account='Sim1' AND is_simulated=1 AND strategy_id=? AND run_id=? THEN 1 ELSE 0 END) AS attributed_rows,
                SUM(CASE WHEN fees_available=1 THEN 1 ELSE 0 END) AS fee_rows,
                COALESCE(SUM(total_commission),0) AS total_fees,
                MIN(total_fee_per_side) AS min_fee,MAX(total_fee_per_side) AS max_fee,
                MIN(fee_broker_profile) AS min_profile,MAX(fee_broker_profile) AS max_profile,
                MIN(fee_product_code) AS min_product,MAX(fee_product_code) AS max_product,
                MIN(fee_tier) AS min_tier,MAX(fee_tier) AS max_tier,
                MIN(fee_source_type) AS min_source_type,MAX(fee_source_type) AS max_source_type
                 FROM trades WHERE run_id=? AND (? IS NULL OR trade_id<>?)`).get(row.strategy_id,value.run_id,value.run_id,
                   value.boundary_cleanup_trade_id,value.boundary_cleanup_trade_id);
            }finally{telemetry.close();}
            if(cost)break;
          }catch{}
        }
        requireThat(cost,409,'CANDIDATE_VALIDATION_TELEMETRY_DATABASE_INVALID');
        requireThat(Number(cost.total_rows)===value.trade_count && Number(cost.attributed_rows)===Number(cost.total_rows)
          && sameNumber(Number(cost.total_fees),Number(value.fees))
          && (Number(cost.total_rows)===0 || (Number(cost.fee_rows)===Number(cost.total_rows)
            && sameNumber(Number(cost.min_fee),Number(test.cost_model.total_fee_per_side))
            && sameNumber(Number(cost.max_fee),Number(test.cost_model.total_fee_per_side))
            && cost.min_profile===test.cost_model.broker_profile && cost.max_profile===test.cost_model.broker_profile
            && cost.min_product===test.cost_model.product && cost.max_product===test.cost_model.product
            && cost.min_tier===test.cost_model.fee_tier && cost.max_tier===test.cost_model.fee_tier
            && cost.min_source_type===test.cost_model.source_type && cost.max_source_type===test.cost_model.source_type)),
        409,'CANDIDATE_VALIDATION_COST_EVIDENCE_CONFLICT');
        const expectedSourceHash=name==='baseline'?test.baseline_execution_source_hash:test.candidate_execution_source_hash;
        requireThat(validHash(expectedSourceHash) && value.physical_hashes.strategy_source_hash===expectedSourceHash,
          409,'CANDIDATE_VALIDATION_EXECUTION_SOURCE_CONFLICT');
        const markerBytesAvailable=fileHashes.has(value.physical_hashes.strategy_marker_hash);
        const versionMatch=/^v0\.6\.(\d+)/.exec(value.strategy_version);
        const markerBytesRequired=test.kind==='OOS_HOLDOUT'
          || (versionMatch!==null && Number(versionMatch[1])>=240);
        requireThat(fileHashes.has(value.physical_hashes.strategy_source_hash)
          && fileHashes.has(value.physical_hashes.strategy_dll_hash)
          && markerBytesAvailable===markerBytesRequired
          && (markerBytesAvailable || result.limitations.includes(markerLimitation(value.run_id))),
        409,'CANDIDATE_VALIDATION_PHYSICAL_SOURCE_BINDING_CONFLICT');
        bindingRuns[name].push({run_id:value.run_id,physical_hashes:structuredClone(value.physical_hashes),
          marker_bytes_available:markerBytesAvailable});
        const {physical_hashes,...metricEvidence}=value;
        evidence[name]=structuredClone(metricEvidence);
      }
      return {segment_id:segment.segment_id,...evidence,source_files:segmentResult.source_files
        .map(file=>({file_name:path.basename(file.path),sha256:file.sha256}))};
    });
    for(const name of ['baseline','candidate']){
      const aggregate=result[name];
      exactKeys(aggregate,['strategy_version','strategy_hash','telemetry_version','telemetry_hash','trade_count','gross_pnl','fees','net_pnl','short_trade_count','zero_trade_periods','data_quality_flags']);
      requireThat(aggregate.strategy_version===(name==='baseline'?test.baseline_version:candidateExecutionVersion(test,completed))
        && aggregate.strategy_hash===(name==='baseline'?test.baseline_strategy_hash:candidateExecutionHash(test,registered))
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
    exactKeys(result.comparison,['reported_delta']);
    requireThat(Number.isFinite(result.comparison.reported_delta)
      && sameNumber(result.comparison.reported_delta,result.candidate.net_pnl-result.baseline.net_pnl)
      && Array.isArray(result.contradictions) && Array.isArray(result.limitations),409,'CANDIDATE_VALIDATION_COMPARISON_CONFLICT');
    return {schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_hash:plan.plan_hash,
      plan_artifact_id:completed.plan_artifact_id,completion_hash:completed.completion_hash,candidate_hash:registered.candidate_hash,
      baseline_hash:row.baseline_hash,test,execution_bindings:{
        baseline:{logical_hash:row.baseline_hash,strategy_version:test.baseline_version,runs:bindingRuns.baseline},
        candidate:{logical_hash:registered.candidate_hash,strategy_version:candidateExecutionVersion(test,completed),runs:bindingRuns.candidate}},
      status:result.status,evidence_integrity_passed:integrity,...structuredClone(result),segments:measured,
      recorded_at_utc:new Date().toISOString(),authority:{...authority,execution_environment:'REPLAY'}};
  }

  completeValidation(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','plan_hash']);
    const plan=this.validationPlan(row.id);requireThat(plan && data.plan_hash===plan.plan_hash,409,'CANDIDATE_VALIDATION_PLAN_REQUIRED');
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_VALIDATION_STAGE_REQUIRED');
    const tasks=this.db.prepare('SELECT kind,status,artifact_id FROM ow_tasks WHERE case_id=?').all(row.id);
    const reconciliation=this.reconcileValidationArtifacts(actor,row,plan,tasks);
    if(reconciliation)return reconciliation;
    requireThat(REQUIRED_TESTS.every(kind=>tasks.some(task=>task.kind===kind && task.status==='PASS' && task.artifact_id)),409,'REQUIRED_SUBTESTS_INCOMPLETE');
    const next=this.b.transition(actor,{case_id:row.id,expected_revision:row.revision,action:'advance',to_stage:'CANDIDATE_EVALUATION',
      artifact_id:null,artifact_ids:null,decision_id:null,owner_id:null,next_action:null});
    const completion={schema_version:CANDIDATE_VALIDATION_VERSION,case_id:row.id,plan_hash:plan.plan_hash,
      candidate_hash:registered.candidate_hash,completion_hash:completed.completion_hash,
      artifacts:REQUIRED_TESTS.map(kind=>({kind,artifact_id:tasks.find(task=>task.kind===kind).artifact_id})),
      completed_at_utc:new Date().toISOString(),next_stage:'CANDIDATE_EVALUATION',authority:{...authority,execution_environment:'REPLAY'}};
    this.b.event(row.id,validationCompletionAction,actor,completion);
    return {case_id:row.id,revision:next.revision,status:'COMPLETED',stage:next.stage,
      next_action:'Obsidian Brain must evaluate the cumulative evidence and record benefit supported or no benefit established; no promotion is automatic.'};
  }
}

function approvedDecisionId(approval){return approval.decision.id;}
