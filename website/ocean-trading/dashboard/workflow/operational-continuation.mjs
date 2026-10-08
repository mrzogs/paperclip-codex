import { digest, objectHash, requireThat } from './common.mjs';
import { OperationalProposalPlan } from './operational-proposal-plan.mjs';

export const CONTINUATION_ORIGIN = 'OPERATIONAL_RESEARCH_CONTINUATION';
const VERSION = 'ocean-research-planning-continuation/v1';
const LINK = 'operational.research.continuation.link';
const noAuthority = Object.freeze({ automatic_strategy_change:false, candidate_approved:false, paper_authorized:false, live_authorized:false });
const terminal = new Set(['COMPLETED','CANCELLED','PAUSED','FAILED']);
const errorCode = error => String(error.code || 'CONTINUATION_PROOF_REQUIRED').slice(0,200);
const evidenceGroup = binding => objectHash(Object.fromEntries(['strategy_id','execution_instance_id','baseline_hash','registry_revision',
  'registry_record_sha256','strategy_profile_id','strategy_profile_version','strategy_code_hash','strategy_config_hash','screening_policy']
  .map(key=>[key,binding[key]])));

export class OperationalContinuation {
  constructor(research) { this.research=research;this.backend=research.backend;this.db=research.db;this.plans=new OperationalProposalPlan(this); }
  source(job) {
    const row=this.backend.one('ow_cases',job.case_id);
    requireThat(JSON.parse(row.payload_json).origin==='OPERATIONAL_LEARNING'
      && job.state==='COMPLETED' && job.analysis_version===this.research.version,409,'CONTINUATION_CURRENT_RESEARCH_REQUIRED');
    const artifact=this.backend.artifactFor(row,job.result_artifact_id,'OUTCOME');
    requireThat(digest(Buffer.from(artifact.content))===job.result_hash,409,'CONTINUATION_REPORT_HASH_CONFLICT');
    const report=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    if(report.schema_version!==this.research.version || !report.screening_policy || !report.evidence_sufficiency
      || !['EXPLORATORY_PROPOSAL','INSUFFICIENT_EVIDENCE','NO_SUPPORTED_CHANGE'].includes(report.outcome))return null;
    requireThat(!['PAUSED','CANCELLED','FAILED','BLOCKED'].includes(row.work_status),409,'CONTINUATION_SOURCE_DISPOSITION_HELD');
    requireThat(job.input_json && digest(job.input_json)===job.input_hash,409,'CONTINUATION_FROZEN_INPUT_REQUIRED');
    const snapshot=JSON.parse(job.input_json);
    requireThat(snapshot.result && Object.keys(snapshot.result).every(key=>objectHash(snapshot.result[key])===objectHash(report[key]))
      && report.job_id===job.id && report.case_id===row.id
      && report.source_recommendation_id===job.artifact_id && report.source_recommendation_hash===job.artifact_hash,
    409,'CONTINUATION_REPORT_INPUT_CONFLICT');
    const recommendation=this.backend.artifactFor(row,job.artifact_id,'RECOMMENDATION');
    requireThat(digest(Buffer.from(recommendation.content))===job.artifact_hash,409,'CONTINUATION_RECOMMENDATION_HASH_CONFLICT');
    const cohort=snapshot.evidence?.bundle?.cohort;
    const ids=report.eligible_run_ids;
    requireThat(Array.isArray(ids) && ids.length>0 && new Set(ids).size===ids.length
      && objectHash(cohort)===report.cohort_hash
      && objectHash(cohort.eligible_runs.map(run=>run.run_id).sort())===objectHash([...ids].sort())
      && snapshot.evidence.row.strategy_id===row.strategy_id && snapshot.evidence.row.run_id===row.run_id,
    409,'CONTINUATION_COHORT_LINEAGE_CONFLICT');
    this.backend.baseline(row);
    requireThat(this.research.qualification(job).verified,409,'CONTINUATION_CURRENT_PROVENANCE_REQUIRED');
    const context=JSON.parse(this.backend.one('ow_runs',row.run_id).context_json);
    requireThat(context.context_hash && context.context_hash===snapshot.evidence.context.context_hash,
      409,'CONTINUATION_CONTEXT_CONFLICT');
    const runs=[...ids].sort().map(run_id=>{
      const run=this.backend.one('ow_runs',run_id),value=JSON.parse(run.context_json);
      requireThat(run.strategy_id===row.strategy_id && value.context_hash
        && cohort.eligible_runs.find(item=>item.run_id===run_id)?.context_hash===value.context_hash,
      409,'CONTINUATION_RUN_LINEAGE_CONFLICT');
      return {run_id,execution_instance_id:run.instance_id,context_hash:value.context_hash,
        strategy_profile_id:value.strategy_profile_id,strategy_profile_version:value.strategy_profile_version,
        strategy_code_hash:value.strategy_code_hash,strategy_config_hash:value.strategy_config_hash,
        dataset_manifest_id:value.dataset_manifest_id,dataset_manifest_revision:value.dataset_manifest_revision,
        dataset_manifest_hash:value.dataset_manifest_hash};
    });
    requireThat(Object.keys(noAuthority).every(key=>report.authority?.[key]===false)
      && report.candidate_validation?.candidate_hash===null && report.candidate_validation.status==='NOT_DUE',
    409,'CONTINUATION_AUTHORITY_BOUNDARY');
    const payload=JSON.parse(row.payload_json);
    const binding={strategy_id:row.strategy_id,execution_instance_id:row.instance_id,baseline_hash:row.baseline_hash,
      registry_revision:payload.registry_revision,registry_reconciliation_id:payload.registry_reconciliation_id,
      registry_record_sha256:payload.registry_record_sha256,strategy_profile_id:context.strategy_profile_id,
      strategy_profile_version:context.strategy_profile_version,strategy_code_hash:context.strategy_code_hash,
      strategy_config_hash:context.strategy_config_hash,runs,analysis_version:job.analysis_version,
      cohort_hash:report.cohort_hash,evidence_hash:report.evidence_hash,
      screening_policy:report.screening_policy,historical_periods:report.historical_periods};
    return {row,report,binding,recipient:artifact.recipient_id,reference:{job_id:job.id,case_id:row.id,
      input_hash:job.input_hash,report_artifact_id:artifact.id,report_hash:job.result_hash,
      recommendation_artifact_id:job.artifact_id,recommendation_hash:job.artifact_hash}};
  }
  items(source) {
    if(source.report.outcome==='NO_SUPPORTED_CHANGE')return [];
    if(source.report.outcome==='INSUFFICIENT_EVIDENCE') {
      requireThat(source.report.proposals?.length===0 && source.report.evidence_sufficiency.status==='INSUFFICIENT',
        409,'CONTINUATION_INSUFFICIENCY_CONFLICT');
      return [{kind:'EVIDENCE_FOLLOW_UP',task_kind:'QUALIFIED_EVIDENCE_FOLLOW_UP',
        requirement:source.report.evidence_sufficiency}];
    }
    requireThat(source.report.proposals?.length>0,409,'CONTINUATION_SUPPORTED_PROPOSAL_REQUIRED');
    const items=source.report.proposals.map(proposal=>{
      requireThat(proposal.dimension==='direction' && proposal.supported===true && proposal.proposal_eligible===true
        && proposal.lookahead_safe===true && proposal.evidence_sufficient===true
        && source.report.experiments.some(item=>objectHash(item)===objectHash(proposal)),
      409,'CONTINUATION_SUPPORTED_PROPOSAL_REQUIRED');
      return {kind:'PROPOSAL_PLANNING',task_kind:'PROPOSAL_PLAN_REVIEW',requirement:proposal};
    });
    if(source.report.evidence_sufficiency.assessment_complete!==true)items.push({kind:'EVIDENCE_FOLLOW_UP',
      task_kind:'QUALIFIED_EVIDENCE_FOLLOW_UP',requirement:source.report.evidence_sufficiency});
    return items;
  }
  ownerCurrent(owner,row) {
    if(owner===this.backend.config.browser?.subject_id)return this.backend.auth?.human?.state==='CONFIGURED';
    const identity=this.backend.config.identities.find(value=>value.identity_id===owner);
    return Boolean(identity?.namespace==='OPERATIONAL' && identity.role==='BRAIN' && !identity.revoked
      && Date.parse(identity.expires_at_utc)>Date.now() && identity.strategy_ids?.includes(row.strategy_id)
      && identity.instance_ids?.includes(row.instance_id)
      && ['read','artifact.write','event.write'].every(scope=>identity.scopes?.includes(scope))
      && this.backend.store.identityCurrent(identity) && !this.backend.auth?.bindingErrors?.has(owner));
  }
  action(kind,owner,requirement=null) {
    return kind==='PROPOSAL_PLANNING'
      ?`Owner ${owner}: review the supported direction rule and freeze an exact non-live development/test/comparison plan with a scoped recipient through the operational proposal work queue. Returned drafts remain planning work until execution contracts are verified; no candidate has been built or tested.`
      :`Owner ${owner}: ${requirement?this.research.remediation(requirement).next_action:'Review the frozen evidence shortfalls before collecting further evidence.'} Insufficient evidence is not an evaluated no-change finding. Keep the baseline; no approval is due for unassessed directions.`;
  }
  ensure(job,actor) {
    const source=this.source(job);
    if(!source)return [];
    requireThat(actor.role==='BRAIN' && actor.namespace==='OPERATIONAL',403,'CONTINUATION_OPERATIONAL_BRAIN_REQUIRED');
    const links=[];
    for(const item of this.items(source)) {
      const support={...source.binding,...item};
      const fingerprint=objectHash(support),suffix=fingerprint.slice('sha256:'.length);
      const caseId=`research-plan-${suffix}`,artifactId=`test-research-lineage-${suffix}`,taskId=`${caseId}:plan`;
      const frozen={schema_version:VERSION,support_hash:fingerprint,support,
        source:source.reference,authority:noAuthority};
      const payload={origin:CONTINUATION_ORIGIN,registry_revision:source.binding.registry_revision,
        kind:item.kind,support_hash:fingerprint,lineage_artifact_id:artifactId,task_kind:item.task_kind,authority:noAuthority};
      let row=this.db.prepare('SELECT * FROM ow_cases WHERE id=?').get(caseId);
      if(!row) {
        const owner=this.ownerCurrent(source.row.owner_id,source.row)?source.row.owner_id
          :this.backend.config.browser?.subject_id || source.row.owner_id;
        this.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,?,?,?)")
          .run(caseId,source.row.strategy_id,source.row.instance_id,source.row.run_id,source.row.baseline_hash,
            owner,this.action(item.kind,owner,item.requirement),JSON.stringify(payload));
        this.backend.writeArtifact(actor,{artifact_id:artifactId,case_id:caseId,run_id:source.row.run_id,
          recipient_id:source.recipient,kind:item.kind==='PROPOSAL_PLANNING'?'RECOMMENDATION':'EVIDENCE',
          media_type:'application/json',content:JSON.stringify(frozen),content_hash:digest(JSON.stringify(frozen)),
          candidate_hash:null,dependency_ids:[]});
        this.backend.event(caseId,'operational.research.planning.created',actor,{kind:item.kind,support_hash:fingerprint,
          source:source.reference,owner_id:owner,task_id:taskId,authority:noAuthority});
        row=this.backend.one('ow_cases',caseId);
      } else {
        requireThat(row.strategy_id===source.row.strategy_id && row.instance_id===source.row.instance_id
          && row.baseline_hash===source.row.baseline_hash && row.candidate_hash===null
          && objectHash(JSON.parse(row.payload_json))===objectHash(payload),409,'CONTINUATION_IDENTITY_CONFLICT');
        const original=this.backend.artifactFor(row,artifactId);
        requireThat(objectHash(JSON.parse(Buffer.from(original.content).toString('utf8')).support)===fingerprint,
          409,'CONTINUATION_LINEAGE_CONFLICT');
      }
      const task=this.db.prepare('SELECT * FROM ow_tasks WHERE id=?').get(taskId);
      if(task)requireThat(task.case_id===caseId && task.kind===item.task_kind && task.required===1,
        409,'CONTINUATION_TASK_CONFLICT');
      else {
        const returned=this.plans.forCase(row)?.returned;
        this.db.prepare('INSERT INTO ow_tasks VALUES(?,?,?,?,?,1)').run(taskId,caseId,item.task_kind,
          returned?'BLOCKED':'NOT_RUN',returned?.artifact_id || artifactId);
      }
      const existing=this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? AND json_extract(payload_json,'$.payload.continuation_case_id')=?")
        .all(source.row.id,LINK,caseId);
      if(existing.length)requireThat(existing.every(event=>objectHash(JSON.parse(event.payload_json).payload.source)===objectHash(source.reference)),
        409,'CONTINUATION_SOURCE_LINK_CONFLICT');
      else this.backend.event(source.row.id,LINK,actor,{continuation_case_id:caseId,support_hash:fingerprint,source:source.reference});
      this.refresh(row,actor);
      links.push(caseId);
    }
    return links;
  }
  reconcileEvidence(source,actor) {
    const registry=this.backend.operationalLearning.registryContext;
    if(registry?.record_sha256 && registry.record_sha256!==source.binding.registry_record_sha256)return;
    const currentOrdinal=this.db.prepare('SELECT rowid ordinal FROM ow_research_jobs WHERE id=?').get(source.reference.job_id).ordinal;
    for(const row of this.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')=? AND json_extract(payload_json,'$.kind')='EVIDENCE_FOLLOW_UP'").all(CONTINUATION_ORIGIN)) {
      if(terminal.has(row.work_status))continue;
      const payload=JSON.parse(row.payload_json),artifact=this.backend.artifactFor(row,payload.lineage_artifact_id);
      const frozen=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      requireThat(objectHash(frozen.support)===payload.support_hash,409,'CONTINUATION_LINEAGE_CONFLICT');
      const original=this.db.prepare('SELECT rowid ordinal FROM ow_research_jobs WHERE id=?').get(frozen.source.job_id);
      if(!original || original.ordinal>=currentOrdinal || evidenceGroup(frozen.support)!==evidenceGroup(source.binding))continue;
      const latest=this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action='operational.research.evidence.progress' ORDER BY id DESC LIMIT 1").get(row.id);
      if(latest) {
        const ref=JSON.parse(latest.payload_json).payload.source;
        if(this.db.prepare('SELECT rowid ordinal FROM ow_research_jobs WHERE id=?').get(ref.job_id)?.ordinal>=currentOrdinal)continue;
      }
      const directions=[...new Set([...(frozen.support.requirement.evaluated_direction_values || []),
        ...(frozen.support.requirement.unevaluated_direction_values || [])])];
      const resolved=source.report.evidence_sufficiency.assessment_complete===true
        && directions.every(value=>source.report.evidence_sufficiency.evaluated_direction_values.includes(value));
      const content=JSON.stringify({schema_version:VERSION,kind:'EVIDENCE_PROGRESS',source:source.reference,
        original_support_hash:payload.support_hash,status:resolved?'REASSESSED':'STILL_INSUFFICIENT',
        outcome:source.report.outcome,evidence_sufficiency:source.report.evidence_sufficiency,authority:noAuthority});
      const progressId=`test-evidence-progress-${digest(`${row.id}:${source.reference.job_id}`).slice(7)}`;
      // Planning progress is internal evidence, not a candidate result or authority route.
      const workStatus=row.work_status;
      if(workStatus==='BLOCKED')this.db.prepare("UPDATE ow_cases SET work_status='READY' WHERE id=?").run(row.id);
      this.backend.writeArtifact(actor,{artifact_id:progressId,case_id:row.id,run_id:row.run_id,recipient_id:source.recipient,
        kind:'EVIDENCE',media_type:'application/json',content,content_hash:digest(content),candidate_hash:null,
        dependency_ids:[payload.lineage_artifact_id]});
      const nextAction=resolved
        ?`Evidence follow-up was reassessed by ${source.reference.case_id}: ${source.report.outcome}. Open that Research case for the current owned action. This is not candidate testing.`
        :`Owner ${row.owner_id}: new qualified Research ${source.reference.case_id} still reports evidence shortfalls. ${this.research.remediation(source.report.evidence_sufficiency).next_action} No candidate or approval is due for unassessed directions.`;
      this.db.prepare('UPDATE ow_cases SET work_status=?,waiting_on=?,revision=revision+1 WHERE id=?')
        .run(resolved?'COMPLETED':workStatus,nextAction,row.id);
      if(resolved) {
        this.db.prepare("UPDATE ow_tasks SET status='COMPLETED',artifact_id=? WHERE case_id=? AND kind=?")
          .run(progressId,row.id,payload.task_kind);
        this.db.prepare("UPDATE ow_blockers SET state='RESOLVED' WHERE case_id=? AND id IN (?,?)").run(row.id,`${row.id}:proof`,`${row.id}:sample-design`);
      }
      this.backend.event(row.id,'operational.research.evidence.progress',actor,{source:source.reference,
        progress_artifact_id:progressId,status:resolved?'REASSESSED':'STILL_INSUFFICIENT',outcome:source.report.outcome,
        next_action:nextAction,owner_id:row.owner_id,authority:noAuthority});
    }
  }
  forCase(row) {
    const payload=JSON.parse(row.payload_json);
    if(payload.origin!==CONTINUATION_ORIGIN)return null;
    const progressRow=this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action='operational.research.evidence.progress' ORDER BY id DESC LIMIT 1").get(row.id);
    const progress=progressRow?JSON.parse(progressRow.payload_json).payload:null;
    let reason=null,source=null,evidenceRemediation=null;
    try {
      const artifact=this.backend.artifactFor(row,payload.lineage_artifact_id);
      const frozen=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      if(payload.kind==='EVIDENCE_FOLLOW_UP')evidenceRemediation=this.research.remediation(frozen.support.requirement);
      requireThat(frozen.schema_version===VERSION && frozen.support_hash===payload.support_hash
        && objectHash(frozen.support)===payload.support_hash
        && objectHash(frozen.authority)===objectHash(noAuthority)
        && objectHash(payload)===objectHash({origin:CONTINUATION_ORIGIN,registry_revision:frozen.support.registry_revision,
          kind:frozen.support.kind,support_hash:frozen.support_hash,lineage_artifact_id:artifact.id,
          task_kind:frozen.support.task_kind,authority:noAuthority}),
      409,'CONTINUATION_LINEAGE_CONFLICT');
      const job=this.backend.one('ow_research_jobs',frozen.source.job_id);
      source=this.source(job);
      requireThat(source && objectHash(source.reference)===objectHash(frozen.source)
        && this.items(source).some(item=>objectHash({...source.binding,...item})===payload.support_hash),
      409,'CONTINUATION_SOURCE_LINEAGE_CONFLICT');
      requireThat(row.strategy_id===source.row.strategy_id && row.instance_id===source.row.instance_id
        && row.baseline_hash===source.row.baseline_hash && row.candidate_hash===null,
      409,'CONTINUATION_IDENTITY_CONFLICT');
      const registry=this.backend.operationalLearning.registryContext;
      requireThat(!registry?.record_sha256 || registry.record_sha256===source.binding.registry_record_sha256,
        409,'CONTINUATION_REGISTRY_RECONCILIATION_REQUIRED');
      const task=this.db.prepare('SELECT * FROM ow_tasks WHERE case_id=? AND kind=?').get(row.id,payload.task_kind);
      requireThat(task?.required===1,409,'CONTINUATION_REQUIRED_TASK_MISSING');
      requireThat(this.ownerCurrent(row.owner_id,row),409,'CONTINUATION_PLANNING_OWNER_REQUIRED');
      if(progress) {
        const progressArtifact=this.backend.artifactFor(row,progress.progress_artifact_id,'EVIDENCE');
        const recorded=JSON.parse(Buffer.from(progressArtifact.content).toString('utf8'));
        const latest=this.source(this.backend.one('ow_research_jobs',progress.source.job_id));
        requireThat(latest && objectHash(latest.reference)===objectHash(progress.source)
          && evidenceGroup(frozen.support)===evidenceGroup(latest.binding)
          && recorded.schema_version===VERSION && recorded.kind==='EVIDENCE_PROGRESS'
          && recorded.original_support_hash===payload.support_hash
          && objectHash(recorded.source)===objectHash(progress.source)
          && recorded.status===progress.status && recorded.outcome===latest.report.outcome
          && recorded.outcome===progress.outcome
          && objectHash(recorded.evidence_sufficiency)===objectHash(latest.report.evidence_sufficiency)
          && objectHash(recorded.authority)===objectHash(noAuthority)
          && (progress.status!=='REASSESSED' || (latest.report.evidence_sufficiency.assessment_complete===true
            && task.status==='COMPLETED' && task.artifact_id===progressArtifact.id)),
        409,'CONTINUATION_PROGRESS_PROOF_CONFLICT');
        evidenceRemediation=this.research.remediation(latest.report.evidence_sufficiency);
      }
    }catch(error){reason=errorCode(error);}
    const planWork=this.plans.forCase(row);
    reason ||= planWork?.blocked_reason;
    const status=terminal.has(row.work_status)?row.work_status:reason?'BLOCKED':row.work_status;
    return {case_id:row.id,kind:payload.kind,owner_id:row.owner_id,work_status:status,
      support_hash:payload.support_hash,lineage_artifact_id:payload.lineage_artifact_id,
      source_case_id:source?.row.id || null,task_kind:payload.task_kind,
      tasks:this.db.prepare('SELECT kind,status,artifact_id,required FROM ow_tasks WHERE case_id=? ORDER BY kind').all(row.id),
      blocked_reason:reason,qualified_for_planning:!reason,
      progress,
      plan_work:planWork,
      evidence_remediation:evidenceRemediation,
      next_action:reason?`Owner ${row.owner_id}: resolve ${reason} before this continuation can support current planning. Preserve its recorded disposition and frozen evidence; no approval or candidate execution is due.`
        :row.work_status==='COMPLETED' && progress?.status==='REASSESSED'?progress.next_action
        :terminal.has(row.work_status)?`Planning is ${row.work_status.toLowerCase()}; owner ${row.owner_id} retains the recorded disposition. Restart does not reopen it. No candidate testing or approval is implied.`
        :evidenceRemediation?`Owner ${row.owner_id}: ${progress?.status==='STILL_INSUFFICIENT'?`new qualified Research ${progress.source.case_id} still reports evidence shortfalls. `:''}${evidenceRemediation.next_action} Insufficient evidence is not an evaluated no-change finding. Keep the baseline; no approval is due for unassessed directions.`
        :planWork?.returned?planWork.next_action:row.waiting_on || this.action(payload.kind,row.owner_id),
      scope:'OWNED_PLANNING_ONLY',candidate_testing:'NOT_DUE',approval_due:false,authority:noAuthority};
  }
  links(caseId) {
    const events=this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id').all(caseId,LINK);
    return [...new Set(events.map(event=>JSON.parse(event.payload_json).payload.continuation_case_id))]
      .map(id=>this.forCase(this.backend.one('ow_cases',id)));
  }
  refresh(row,actor) {
    if(terminal.has(row.work_status))return;
    const status=this.forCase(row),blockerId=`${row.id}:proof`;
    const designId=`${row.id}:sample-design`,design=this.db.prepare('SELECT * FROM ow_blockers WHERE id=?').get(designId);
    if(status.evidence_remediation?.requires_design_review){
      const action=`Owner ${row.owner_id}: ${status.evidence_remediation.next_action}`;
      if(!design)this.db.prepare("INSERT INTO ow_blockers VALUES(?,?,?,?,'OPEN')").run(designId,row.id,row.owner_id,action);
      else if(design.action!==action || design.state!=='OPEN')this.db.prepare("UPDATE ow_blockers SET action=?,state='OPEN' WHERE id=?").run(action,designId);
    }else if(design?.state==='OPEN')this.db.prepare("UPDATE ow_blockers SET state='RESOLVED' WHERE id=?").run(designId);
    const blocker=this.db.prepare('SELECT * FROM ow_blockers WHERE id=?').get(blockerId);
    if(status.blocked_reason) {
      if(!blocker)this.db.prepare("INSERT INTO ow_blockers VALUES(?,?,?,?,'OPEN')")
        .run(blockerId,row.id,row.owner_id,status.next_action);
      else if(blocker.action!==status.next_action || blocker.state!=='OPEN')this.db.prepare("UPDATE ow_blockers SET action=?,state='OPEN' WHERE id=?").run(status.next_action,blockerId);
      if(row.work_status!=='BLOCKED') {
        this.db.prepare("UPDATE ow_cases SET work_status='BLOCKED',revision=revision+1 WHERE id=?").run(row.id);
        this.backend.event(row.id,'operational.research.planning.blocked',actor,{reason:status.blocked_reason,owner_id:row.owner_id});
      }
    } else if(blocker?.state==='OPEN') {
      this.db.prepare("UPDATE ow_blockers SET state='RESOLVED' WHERE id=?").run(blockerId);
      if(row.work_status==='BLOCKED')this.db.prepare("UPDATE ow_cases SET work_status='READY',revision=revision+1 WHERE id=?").run(row.id);
      this.backend.event(row.id,'operational.research.planning.proof-restored',actor,{owner_id:row.owner_id});
    }
  }
  reconcile() {
    const actor={id:'ocean-research',role:'BRAIN',namespace:'OPERATIONAL'};
    for(const job of this.db.prepare("SELECT * FROM ow_research_jobs WHERE analysis_version=? AND state='COMPLETED' AND result_artifact_id IS NOT NULL").all(this.research.version)) {
      if(!this.research.qualification(job).verified)continue;
      try {
        this.backend.store.transaction(()=>{
          const source=this.source(job);
          if(!source)return;
          const owner=this.backend.operationalLearning.brainActor(source.row.strategy_id,source.row.instance_id);
          this.ensure(job,owner);
          this.reconcileEvidence(source,owner);
        });
      }catch(error) {
        // A sealed source is never reopened or retried to repair planning proof.
        const reason=errorCode(error);
        const previous=this.db.prepare("SELECT 1 FROM ow_events WHERE entity_id=? AND action='operational.research.continuation.blocked' AND json_extract(payload_json,'$.payload.reason')=?").get(job.case_id,reason);
        if(!previous)this.backend.event(job.case_id,'operational.research.continuation.blocked',actor,{reason,job_id:job.id,
          next_action:'The recorded Research owner must resolve continuation proof; preserve the completed report and frozen input.'});
      }
    }
    for(const row of this.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')=?").all(CONTINUATION_ORIGIN)) {
      this.backend.store.transaction(()=>this.refresh(row,actor));
    }
    this.plans.processOnce();
  }
}
