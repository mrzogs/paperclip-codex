import { randomUUID } from 'node:crypto';
import { digest, exactKeys, id, noSecrets, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_DISPATCH_VERSION='ocean-operational-candidate-dispatch/v2';
const ORIGIN='OPERATIONAL_RESEARCH_CONTINUATION';
const leaseAction='operational.candidate.dispatch.lease';
const completionAction='operational.candidate.dispatch.completed';
const registrationAction='operational.candidate.dispatch.registered';
const REQUIRED_TESTS=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);

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
    return {schema_version:CANDIDATE_DISPATCH_VERSION,status:registered?'REGISTERED':completed?'BUILT_PENDING_REVIEW':lease && lease.lease_until_ms>now?'IN_PROGRESS':'READY',
      recipient_id:completed?.recipient_id || lease?.owner_id || null,plan_artifact_id:completed?.plan_artifact_id || lease?.plan_artifact_id || null,
      completion:completed?this.publicCompletion(completed):null,registration:registered || null};
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
}
