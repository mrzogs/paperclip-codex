import { randomUUID } from 'node:crypto';
import { exactKeys, id, noSecrets, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_DISPATCH_VERSION='ocean-operational-candidate-dispatch/v1';
const ORIGIN='OPERATIONAL_RESEARCH_CONTINUATION';
const leaseAction='operational.candidate.dispatch.lease';
const REQUIRED_TESTS=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});

// This adapter dispatches an exact, non-live engineering brief to the current
// strategy owner. It deliberately does not create a candidate or an approval.
export class OperationalCandidateDispatch {
  constructor(backend){this.b=backend;this.db=backend.db;this.leaseMs=300000;}
  latest(caseId){
    const row=this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,leaseAction);
    return row?JSON.parse(row.payload_json).payload:null;
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
  read(actor,caseId){
    const work=this.load(actor,caseId),lease=this.latest(caseId),now=Date.now();
    return {schema_version:CANDIDATE_DISPATCH_VERSION,case_id:caseId,revision:work.row.revision,
      status:lease && lease.lease_until_ms>now?'IN_PROGRESS':'READY',
      lease:lease?{lease_id:lease.lease_id,owner_id:lease.owner_id,expires_at_utc:new Date(lease.lease_until_ms).toISOString()}:null,
      dispatch:this.payload(work),next_action:'Claim this exact TEST-only engineering brief, build a separately hashed candidate, then use the governed candidate/version/run lifecycle. Claiming does not approve or execute a candidate.'};
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
    requireThat(['claim','renew'].includes(action),404,'UNKNOWN_CANDIDATE_DISPATCH_ACTION');
    exactKeys(input,['message_id','data']);id(input.message_id);noSecrets(input,this.b.environment);
    const keys=['case_id','expected_revision','plan_artifact_id','dispatch_hash',...(action==='renew'?['lease_id']:[])];
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
      const now=Date.now(),lease=this.latest(current.row.id);let next;
      if(action==='claim'){
        requireThat(!lease || lease.lease_until_ms<=now,409,'CANDIDATE_DISPATCH_LEASE_HELD');
        next={lease_id:randomUUID(),owner_id:actor.id,lease_until_ms:now+this.leaseMs,
          dispatch_hash:dispatch.dispatch_hash,plan_artifact_id:dispatch.plan_artifact_id};
      }else{
        requireThat(lease && lease.lease_id===data.lease_id && lease.owner_id===actor.id
          && lease.lease_until_ms>now && lease.dispatch_hash===dispatch.dispatch_hash,409,'CANDIDATE_DISPATCH_LEASE_EXPIRED');
        next={...lease,lease_until_ms:now+this.leaseMs};
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
