import { randomUUID } from 'node:crypto';
import { digest, exactKeys, id, noSecrets, objectHash, requireThat } from './common.mjs';
import { requireDirectionExclusionExposure } from './operational-research-protocol.mjs';
import { readResearchReport } from './operational-research-report.mjs';

export const PLAN_VERSION='ocean-operational-proposal-plan/v2';
const origin='OPERATIONAL_RESEARCH_CONTINUATION';
const leaseAction='operational.proposal.plan.lease';
const returnAction='operational.proposal.plan.returned';
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});
const held=new Set(['COMPLETED','CANCELLED','PAUSED','FAILED']);

// Planning leases and returns use immutable events/artifacts, not TEST approvals or handoffs.
export class OperationalProposalPlan {
  constructor(continuation){this.c=continuation;this.b=continuation.backend;this.db=continuation.db;}
  latest(caseId,action){
    const row=this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,action);
    return row?JSON.parse(row.payload_json).payload:null;
  }
  identity(actor,row,scope='read'){
    requireThat(actor.id===row.owner_id,403,'PROPOSAL_EXACT_OWNER_REQUIRED');
    if(actor.role==='HUMAN')requireThat(actor.id===this.b.config.browser?.subject_id,403,'WAYNE_BROWSER_ONLY');
    else {
      requireThat(actor.role==='BRAIN' && actor.namespace==='OPERATIONAL',403,'PROPOSAL_OPERATIONAL_BRAIN_REQUIRED');
      this.b.authorize(actor,scope,row.strategy_id,row.instance_id);
    }
    requireThat(this.c.ownerCurrent(row.owner_id,row),403,'PROPOSAL_CURRENT_OWNER_REQUIRED');
  }
  load(actor,caseId,scope='read'){
    const row=this.b.one('ow_cases',caseId),payload=JSON.parse(row.payload_json);
    requireThat(payload.origin===origin && payload.kind==='PROPOSAL_PLANNING',403,'SUPPORTED_OPERATIONAL_PROPOSAL_REQUIRED');
    this.identity(actor,row,scope);
    const view=this.c.forCase(row);
    requireThat(view.qualified_for_planning,409,view.blocked_reason || 'PROPOSAL_CURRENT_PROOF_REQUIRED');
    requireThat(!held.has(row.work_status),409,'PROPOSAL_DISPOSITION_HELD');
    const artifact=this.b.artifactFor(row,payload.lineage_artifact_id,'RECOMMENDATION');
    const frozen=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    const source=this.c.source(this.b.one('ow_research_jobs',frozen.source.job_id));
    return {row,payload,frozen,source};
  }
  template(work){
    const {row,payload,frozen,source}=work,support=frozen.support;
    const exposure=requireDirectionExclusionExposure(source.report,support.requirement);
    const capabilities=this.capabilities(work);
    const missing=capabilities.filter(item=>item.required_now && item.status!=='VERIFIED').map(item=>item.contract);
    return {schema_version:PLAN_VERSION,case_id:row.id,support_hash:payload.support_hash,
      lineage_artifact_id:payload.lineage_artifact_id,source:frozen.source,
      disposition:'DRAFT_FOR_TECHNICAL_REVIEW',non_live_only:true,
      baseline:Object.fromEntries(['strategy_id','execution_instance_id','baseline_hash','strategy_profile_id',
        'strategy_profile_version','strategy_code_hash','strategy_config_hash','registry_revision','registry_record_sha256']
        .map(key=>[key,support[key]])),
      proposed_change:{kind:'DIRECTION_EXCLUSION',dimension:'direction',value:support.requirement.value,
        entry_time_only:true,source_proposal_hash:objectHash(support.requirement),retained_exposure:exposure},
      protocol:{discovery_run_ids:support.runs.map(run=>run.run_id),screening_policy:support.screening_policy,
        prospective_sampling_protocol:support.protocol || null,
        approved_aggregate_evidence_policy:support.approved_evidence_eligibility?.policy || null,
        child_strata:support.historical_periods,retain_all_contradictory_evidence:true,
        accounting:'EXECUTED_GROSS_MINUS_RECORDED_FEES',baseline_comparison:'SAME_FROZEN_SCOPE_REQUIRED',
        tests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].map(kind=>({kind,status:'NOT_SCHEDULED'})),
        holdout_access:'PROHIBITED_BEFORE_SEPARATE_RELEASE',acceptance_thresholds:'NOT_DECLARED'},
      planning_owner_id:row.owner_id,source_owner_id:source.recipient,
      candidate:{state:'NOT_CREATED',candidate_hash:null},
      execution:{status:missing.length?'ENGINEERING_PREREQUISITES_REQUIRED':'PLANNING_COMPLETE_EXECUTION_NOT_DUE',capability_hash:objectHash(capabilities),
        capabilities,missing_contracts:missing},authority};
  }
  capabilities(work){
    const {row,source}=work;
    // This is the route implementation's own catalog, not a configured Boolean
    // claiming a physical adapter exists. Missing candidates/decisions are not failures.
    const routes=this.b.operationalCandidateCapabilities();
    const versions=this.db.prepare('SELECT id,payload_json FROM ow_run_versions WHERE strategy_id=? ORDER BY id').all(row.strategy_id)
      .map(version=>({id:version.id,content_hash:objectHash(JSON.parse(version.payload_json)),kind:JSON.parse(version.payload_json).kind}));
    return [{contract:'OWNED_NON_LIVE_PLAN',status:'VERIFIED',required_now:true,owner_id:row.owner_id,
      evidence:{route:'/api/workflow/operational/v1/proposals/plans',source_report_hash:work.frozen.source.report_hash}},
    {contract:'SCOPED_CANDIDATE_TEST_DISPATCH',status:routes.operational_candidate_test_dispatch?'VERIFIED':'UNSUPPORTED_BY_THIS_ROUTE',
      required_now:true,owner_id:row.owner_id,evidence:{...routes,registered_versions:versions},
      action:'Implement and test a separately scoped non-live candidate registration/test-dispatch contract using the existing run/version lifecycle, exact frozen plan/recipient and reviewed provider proof. The generic version/handoff lifecycle is TEST-only and grants no operational execution.'},
    {contract:'CANDIDATE_IMPLEMENTATION_AND_PHYSICAL_PIN',status:'NOT_YET_DUE',required_now:false,owner_id:source.recipient,
      evidence:{candidate_hash:row.candidate_hash},action:'Only after an exact reviewed engineering plan and due governed development decision, build the candidate and record its own source/module/config pins; baseline provider pins are not candidate proof.'},
    {contract:'GOVERNED_DEVELOPMENT_DECISION',status:'NOT_YET_DUE',required_now:false,owner_id:source.recipient,
      evidence:{automatic_approval:false},action:'No request is created by planning. An exact plan, scoped recipient and authorized test list must be ready before the real supported development review route can be due.'}];
  }
  sourceOwnerCurrent(recipient,row){
    const identity=this.b.config.identities.find(value=>value.identity_id===recipient);
    return identity?.namespace==='OPERATIONAL' && identity.role==='STRATEGY' && !identity.revoked
      && Date.parse(identity.expires_at_utc)>Date.now() && identity.strategy_ids?.includes(row.strategy_id)
      && identity.instance_ids?.includes(row.instance_id) && identity.scopes?.includes('read')
      && this.b.store.identityCurrent(identity) && !this.b.auth?.bindingErrors?.has(recipient);
  }
  forCase(row){
    if(JSON.parse(row.payload_json).kind!=='PROPOSAL_PLANNING')return null;
    const lease=this.latest(row.id,leaseAction),returned=this.latest(row.id,returnAction);
    let reason=null,currentHash=null,recordedHash=null,capabilityAction=null;
    try{
      const payload=JSON.parse(row.payload_json);
      const lineage=JSON.parse(Buffer.from(this.b.artifactFor(row,payload.lineage_artifact_id,'RECOMMENDATION').content).toString('utf8'));
      const sourceRow=this.b.one('ow_cases',lineage.source.case_id);
      const reportArtifact=this.b.artifactFor(sourceRow,lineage.source.report_artifact_id,'OUTCOME');
      const recipient=reportArtifact.recipient_id;
      const report=readResearchReport(this.b.one('ow_research_jobs',lineage.source.job_id),reportArtifact);
      requireThat(this.sourceOwnerCurrent(recipient,row),409,'PROPOSAL_CURRENT_SOURCE_OWNER_REQUIRED');
      const current=this.template({row,payload,frozen:lineage,source:{recipient,report}});
      currentHash=current.execution.capability_hash;
      const gaps=current.execution.capabilities.filter(item=>item.required_now && item.status!=='VERIFIED');
      capabilityAction=gaps.length?gaps.map(item=>`Owner ${item.owner_id}: ${item.action}`).join(' ')
        :'No current scoped capability gap is observed. Candidate development remains not due until the exact reviewed plan, authorized test list and genuine governed development decision are recorded.';
      if(returned){
        const artifact=this.b.artifactFor(row,returned.artifact_id,'RECOMMENDATION');
        const plan=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
        const {planning_notes,...body}=plan;
        requireThat(digest(Buffer.from(artifact.content))===returned.content_hash
        && ['ocean-operational-proposal-plan/v1',PLAN_VERSION].includes(plan.schema_version) && plan.case_id===row.id
        && plan.support_hash===JSON.parse(row.payload_json).support_hash
        && plan.disposition==='DRAFT_FOR_TECHNICAL_REVIEW'
        && objectHash(plan.authority)===objectHash(authority)
        && returned.planning_owner_id===row.owner_id
        && artifact.producer_id===row.owner_id && artifact.recipient_id===returned.source_owner_id
        && typeof planning_notes==='string' && planning_notes.trim().length>0 && planning_notes.length<=4000
        && (!returned.plan_body_hash || objectHash(body)===returned.plan_body_hash)
        && objectHash(JSON.parse(artifact.dependencies_json))===objectHash([plan.lineage_artifact_id]),
        409,'PROPOSAL_RETURN_PROOF_CONFLICT');
        recordedHash=plan.execution?.capability_hash || null;
      }
    }catch(error){reason=error.code || 'PROPOSAL_RETURN_PROOF_CONFLICT';}
    const stale=returned && recordedHash!==currentHash;
    return {schema_version:PLAN_VERSION,status:reason?'BLOCKED':stale?'REVISION_DUE':returned?'PLAN_RETURNED'
      :lease && lease.lease_until_ms>Date.now()?'IN_PROGRESS':'READY',
      lease:lease?{lease_id:lease.lease_id,owner_id:lease.owner_id,expires_at_utc:new Date(lease.lease_until_ms).toISOString()}:null,
      returned,blocked_reason:reason,planning_complete:Boolean(returned && !stale && !reason),candidate_testing:'NOT_DUE',approval_due:false,
      capability_hash:currentHash,recorded_capability_hash:recordedHash,
      queue_route:'/api/workflow/operational/v1/proposals/work',
      next_action:reason?`Owner ${row.owner_id}: resolve ${reason}; no new plan or candidate execution is supported. Sealed plans remain preserved.`
        :returned?`Owner ${row.owner_id}: ${stale?'reconcile a new immutable capability/plan revision; previous drafts stay sealed. ':''}Frozen plan ${returned.artifact_id} defines the concrete direction hypothesis and retained comparison scope. ${capabilityAction} Source owner ${returned.source_owner_id} retains candidate development work when genuinely due. This is plan authoring, not candidate execution or tested improvement; no approval or testing is due.`
        :`Owner ${row.owner_id}: claim this work through the operational proposal queue and return the frozen non-live planning draft. A delivery acknowledgement does not complete planning.`};
  }
  read(actor,caseId){
    const work=this.load(actor,caseId);
    return {...this.forCase(work.row),case_id:caseId,revision:work.row.revision,support_hash:work.payload.support_hash,
      template:this.template(work)};
  }
  queue(actor){
    requireThat(actor.role==='HUMAN' || (actor.role==='BRAIN' && actor.namespace==='OPERATIONAL'),403,'PROPOSAL_OPERATIONAL_BRAIN_REQUIRED');
    const items=[];
    for(const row of this.db.prepare("SELECT * FROM ow_cases WHERE owner_id=? AND json_extract(payload_json,'$.origin')=? AND json_extract(payload_json,'$.kind')='PROPOSAL_PLANNING' ORDER BY rowid").all(actor.id,origin)){
      if(held.has(row.work_status))continue;
      // Retain proof failures as owned queue work; never dispatch them as executable claims.
      this.identity(actor,row);
      const planning=this.c.forCase(row),work=this.forCase(row);
      if(work.status==='PLAN_RETURNED' && planning.qualified_for_planning)continue;
      items.push({case_id:row.id,revision:row.revision,support_hash:planning.support_hash,
        status:planning.qualified_for_planning?work.status:'BLOCKED',
        blocked_reason:planning.blocked_reason || work.blocked_reason,next_action:planning.next_action,lease:work.lease});
    }
    return {schema_version:PLAN_VERSION,namespace:'OPERATIONAL',owner_id:actor.id,items,authority};
  }
  perform(action,actor,input){
    requireThat(['claim','progress','plans'].includes(action),404,'UNKNOWN_PROPOSAL_PLAN_ACTION');
    exactKeys(input,['message_id','data']);id(input.message_id);noSecrets(input,this.b.environment);
    const data=input.data;exactKeys(data,['case_id','expected_revision','support_hash',...(action==='claim'?[]:['lease_id']),
      ...(action==='progress'?['note']:action==='plans'?['plan']:[])]);
    const work=this.load(actor,data.case_id,'event.write');
    if(actor.role!=='HUMAN')this.b.authorize(actor,'artifact.write',work.row.strategy_id,work.row.instance_id);
    requireThat(data.support_hash===work.payload.support_hash,409,'PROPOSAL_SUPPORT_CONFLICT');
    const hash=objectHash({action,data}),key=`proposal-plan:${input.message_id}`;
    return this.b.store.transaction(()=>{
      // Recheck inside the write lock; an earlier lease/return cannot race this claim.
      const current=this.load(actor,data.case_id,'event.write');
      const previous=this.db.prepare('SELECT * FROM ow_inbox WHERE producer_id=? AND message_id=?').get(actor.id,key);
      if(previous){requireThat(previous.payload_hash===hash,409,'DUPLICATE_CONFLICT');return JSON.parse(previous.result_json);}
      this.b.expect(current.row,data.expected_revision);
      const state=this.forCase(current.row);
      requireThat(!state.returned || state.status==='REVISION_DUE',409,'PROPOSAL_PLAN_ALREADY_RETURNED');
      const now=Date.now(),lease=this.latest(current.row.id,leaseAction);
      let result;
      if(action==='claim'){
        requireThat(!lease || lease.lease_until_ms<=now || (state.status==='REVISION_DUE'
          && state.returned?.lease_id===lease.lease_id),409,'PROPOSAL_LEASE_HELD');
        const next={lease_id:randomUUID(),owner_id:actor.id,support_hash:data.support_hash,
          lease_until_ms:now+30000,capability_hash:state.capability_hash,note:'Planning claimed; no candidate or approval authority.'};
        this.b.event(current.row.id,leaseAction,{...actor,namespace:'OPERATIONAL'},next);
        this.db.prepare("UPDATE ow_tasks SET status='IN_PROGRESS' WHERE case_id=? AND kind='PROPOSAL_PLAN_REVIEW'").run(current.row.id);
        this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(this.forCase(current.row).next_action,current.row.id);
        result={...next,case_id:current.row.id,revision:current.row.revision+1,template:this.template(current)};
      }else{
        requireThat(lease && lease.lease_id===data.lease_id && lease.owner_id===actor.id
          && lease.support_hash===data.support_hash && lease.lease_until_ms>now,409,'PROPOSAL_LEASE_EXPIRED');
        requireThat(lease.capability_hash===state.capability_hash,409,'PROPOSAL_CAPABILITIES_CHANGED');
        if(action==='progress'){
          requireThat(typeof data.note==='string' && data.note.trim().length>0 && data.note.length<=2000,422,'PROPOSAL_PROGRESS_NOTE_REQUIRED');
          const next={...lease,lease_until_ms:now+30000,note:data.note};
          this.b.event(current.row.id,leaseAction,{...actor,namespace:'OPERATIONAL'},next);
          this.db.prepare('UPDATE ow_cases SET revision=revision+1 WHERE id=?').run(current.row.id);
          result={...next,case_id:current.row.id,revision:current.row.revision+1};
        }else result=this.returnPlan(actor,current,data);
      }
      this.db.prepare('INSERT INTO ow_inbox VALUES(?,?,?,?)').run(actor.id,key,hash,JSON.stringify(result));
      return result;
    });
  }
  returnPlan(actor,work,data){
    exactKeys(data.plan,[...Object.keys(this.template(work)),'planning_notes']);
    const {planning_notes,...body}=data.plan;
    requireThat(typeof planning_notes==='string' && planning_notes.trim().length>0 && planning_notes.length<=4000,
      422,'PROPOSAL_PLANNING_NOTES_REQUIRED');
    requireThat(objectHash(body)===objectHash(this.template(work)),409,'PROPOSAL_PLAN_BINDING_CONFLICT');
    requireThat(this.sourceOwnerCurrent(body.source_owner_id,work.row),409,'PROPOSAL_CURRENT_SOURCE_OWNER_REQUIRED');
    const content=JSON.stringify(data.plan),hash=digest(content),artifactId=`test-proposal-plan-${hash.slice(7)}`;
    const operationalActor={...actor,namespace:'OPERATIONAL'};
    this.b.writeArtifact(operationalActor,{artifact_id:artifactId,case_id:work.row.id,run_id:work.row.run_id,
      recipient_id:body.source_owner_id,kind:'RECOMMENDATION',media_type:'application/json',content,content_hash:hash,
      candidate_hash:null,dependency_ids:[work.payload.lineage_artifact_id]});
    const returned={artifact_id:artifactId,content_hash:hash,support_hash:work.payload.support_hash,
      lease_id:data.lease_id,planning_owner_id:actor.id,source_owner_id:body.source_owner_id,
      disposition:body.disposition,missing_contracts:body.execution.missing_contracts,
      capability_hash:body.execution.capability_hash,plan_body_hash:objectHash(body),
      supersedes_artifact_id:this.latest(work.row.id,returnAction)?.artifact_id || null,authority};
    this.b.event(work.row.id,returnAction,operationalActor,returned);
    const nextAction=this.forCase(work.row).next_action;
    const gaps=body.execution.capabilities.filter(item=>item.required_now && item.status!=='VERIFIED');
    const active=new Set(gaps.map(item=>`${work.row.id}:capability:${item.contract}`));
    for(const gap of gaps){
      const blockerId=`${work.row.id}:capability:${gap.contract}`;
      const action=`Owner ${gap.owner_id}: ${gap.action} Frozen plan ${artifactId}; no candidate approval or execution is granted.`;
      const old=this.db.prepare('SELECT * FROM ow_blockers WHERE id=?').get(blockerId);
      if(old)this.db.prepare("UPDATE ow_blockers SET action=?,owner_id=?,state='OPEN' WHERE id=?").run(action,gap.owner_id,blockerId);
      else this.db.prepare("INSERT INTO ow_blockers VALUES(?,?,?,?,'OPEN')").run(blockerId,work.row.id,gap.owner_id,action);
    }
    for(const blocker of this.db.prepare("SELECT id FROM ow_blockers WHERE case_id=? AND state='OPEN' AND (id LIKE ? OR id IN (?,?,?,?))").all(work.row.id,`${work.row.id}:capability:%`,
      ...['OPERATIONAL_DEVELOPMENT_DECISION','CANDIDATE_PHYSICAL_BINDING','EXECUTABLE_CANDIDATE_TEST_ADAPTER','FROZEN_INDEPENDENT_COMPARISON_PROTOCOL'].map(key=>`${work.row.id}:${key}`)))
      if(!active.has(blocker.id))this.db.prepare("UPDATE ow_blockers SET state='RESOLVED' WHERE id=?").run(blocker.id);
    this.db.prepare("UPDATE ow_tasks SET status='COMPLETED',artifact_id=? WHERE case_id=? AND kind='PROPOSAL_PLAN_REVIEW'")
      .run(artifactId,work.row.id);
    const taskId=`${work.row.id}:candidate-dispatch-engineering`;
    const task=this.db.prepare('SELECT id FROM ow_tasks WHERE id=?').get(taskId);
    if(!task)this.db.prepare('INSERT INTO ow_tasks VALUES(?,?,?,?,?,1)').run(taskId,work.row.id,'CANDIDATE_DISPATCH_ENGINEERING',gaps.length?'BLOCKED':'NOT_RUN',artifactId);
    else this.db.prepare('UPDATE ow_tasks SET status=?,artifact_id=? WHERE id=?').run(gaps.length?'BLOCKED':'NOT_RUN',artifactId,taskId);
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,work.row.id);
    return {...returned,case_id:work.row.id,revision:work.row.revision+1,planning_complete:true,
      candidate_testing:'NOT_DUE',approval_due:false,next_action:nextAction};
  }
  processOnce(){
    let returned=0;
    for(const row of this.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')=? AND json_extract(payload_json,'$.kind')='PROPOSAL_PLANNING' ORDER BY rowid").all(origin)){
      if(held.has(row.work_status))continue;
      const view=this.c.forCase(row),work=view.plan_work;
      if(view.qualified_for_planning && work.status==='PLAN_RETURNED') {
        const taskId=`${row.id}:candidate-dispatch-engineering`;
        if(!this.db.prepare('SELECT id FROM ow_tasks WHERE id=?').get(taskId))this.b.store.transaction(()=>{
          if(!this.db.prepare('SELECT id FROM ow_tasks WHERE id=?').get(taskId))
            this.db.prepare('INSERT INTO ow_tasks VALUES(?,?,?,?,?,1)').run(taskId,row.id,'CANDIDATE_DISPATCH_ENGINEERING',
              work.returned.missing_contracts.length?'BLOCKED':'NOT_RUN',work.returned.artifact_id);
        });
      }
      if(!view.qualified_for_planning || !['READY','REVISION_DUE'].includes(work.status))continue;
      // The existing Brain owner executes deterministic planning, never an invented HUMAN actor.
      if(row.owner_id===this.b.config.browser?.subject_id)continue;
      let actor={id:'ocean-research',role:'BRAIN',namespace:'OPERATIONAL'};
      try{
        actor=this.b.operationalLearning.brainActor(row.strategy_id,row.instance_id);
        if(actor.id!==row.owner_id)continue;
        const claim=this.perform('claim',actor,{message_id:`plan-worker-claim-${randomUUID()}`,data:{
          case_id:row.id,expected_revision:row.revision,support_hash:view.support_hash}});
        this.perform('plans',actor,{message_id:`plan-worker-return-${claim.lease_id}`,data:{
          case_id:row.id,expected_revision:claim.revision,support_hash:claim.support_hash,lease_id:claim.lease_id,
          plan:{...claim.template,planning_notes:'The persistent Ocean Brain-owner worker froze the exact entry-direction hypothesis, retained discovery/child-stratum comparison scope and observed route capabilities. This completes deterministic plan authoring only. The separately owned candidate-dispatch engineering task must resolve the observed executor gap; no candidate, development approval, holdout access or tested improvement is claimed.'}}});
        returned++;
      }catch(error){
        const reason=String(error.code || 'PROPOSAL_PLAN_WORKER_INTERRUPTED').slice(0,200);
        if(!this.db.prepare("SELECT 1 FROM ow_events WHERE entity_id=? AND action='operational.proposal.plan.worker-blocked' AND json_extract(payload_json,'$.payload.reason')=?").get(row.id,reason))
          this.b.event(row.id,'operational.proposal.plan.worker-blocked',actor,{reason,owner_id:row.owner_id,
            next_action:'Resolve the owned planning worker failure; the source Research report remains sealed. Expired claims may resume, but no approval or candidate execution is allowed.'});
      }
    }
    return {returned,planning_complete:false,candidate_testing:'NOT_DUE'};
  }
}
