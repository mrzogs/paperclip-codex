import { randomUUID } from 'node:crypto';
import { canonical, digest, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_EVALUATOR_VERSION='ocean-operational-candidate-evaluator/v1';
export const CANDIDATE_EVALUATION_REQUEST_VERSION='ocean-candidate-evaluation-request/v1';
export const CANDIDATE_EVALUATION_RESULT_VERSION='ocean-candidate-evaluation-result/v1';

const completionAction='operational.candidate.validation.completed';
const requiredKinds=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false,automatic_promotion:false});
const brainAuthority=Object.freeze({strategy_changed:false,candidate_approved:false,candidate_promoted:false,
  paper_authorized:false,live_authorized:false,runtime_trade_decision_dependency:false});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exactObjectKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const safeError=error=>String(error?.code || error?.message || 'CANDIDATE_EVALUATION_FAILED')
  .replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300);

export class OperationalCandidateEvaluator {
  constructor(backend){
    this.b=backend;this.db=backend.db;this.running=false;this.stopped=false;this.leaseMs=300000;
    this.intervalMs=Math.max(1000,Number(backend.config.operational_learning?.interval_ms || 5000));this.timer=null;this.lastError=null;
  }
  start(){
    if(this.timer || !this.b.operationalLearning.enabled)return;
    this.stopped=false;
    const run=()=>void this.flushOnce().catch(error=>{this.lastError=safeError(error);});
    this.timer=setInterval(run,this.intervalMs);this.timer.unref?.();run();
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;this.stopped=true;}
  completionEvent(caseId){
    return this.db.prepare('SELECT * FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,completionAction) || null;
  }
  job(caseId){return this.db.prepare(`SELECT jobs.* FROM ow_candidate_evaluation_jobs jobs JOIN ow_cases cases ON cases.id=jobs.case_id
    WHERE jobs.case_id=? AND cases.stage='CANDIDATE_EVALUATION' ORDER BY jobs.rowid DESC LIMIT 1`).get(caseId) || null;}
  publicStatus(job){
    if(!job)return null;
    const phase=job.result_artifact_id?'RESULT_RECORDED':job.brain_readback_json?'BRAIN_READBACK_VERIFIED':
      job.brain_response_json?'BRAIN_RESPONSE_RECORDED':job.brain_request_json?'BRAIN_REQUEST_RECORDED':
      job.input_json?'INPUT_CAPTURED':job.state==='RUNNING'?'CLAIMED':'QUEUED';
    return {status:job.state,attempts:job.attempts,next_attempt_utc:['PENDING','RETRY'].includes(job.state)?new Date(job.next_attempt_ms).toISOString():null,
      lease_expires_utc:job.state==='RUNNING' && job.lease_until_ms?new Date(job.lease_until_ms).toISOString():null,
      error:job.last_error || null,input_hash:job.input_hash || null,brain_record_id:job.brain_record_id || null,
      brain_content_hash:job.brain_content_hash || null,result_artifact_id:job.result_artifact_id || null,
      result_hash:job.result_hash || null,phase,pipeline_status:job.state==='COMPLETED'?'PIPELINE_COMPLETED':job.state,
      benefit_conclusion:job.conclusion || null,conclusion:job.conclusion || null,authority};
  }
  statusForCase(caseId){
    const job=this.job(caseId);
    if(job)return this.publicStatus(job);
    const completion=this.completionEvent(caseId),row=this.db.prepare('SELECT stage FROM ow_cases WHERE id=?').get(caseId);
    return completion && row?.stage==='CANDIDATE_EVALUATION'?{status:'QUEUED',attempts:0,next_attempt_utc:null,lease_expires_utc:null,error:null,
      input_hash:null,brain_record_id:null,brain_content_hash:null,result_artifact_id:null,result_hash:null,phase:'QUEUED',pipeline_status:'QUEUED',benefit_conclusion:null,conclusion:null,authority}
      :{status:'NOT_DUE',attempts:0,next_attempt_utc:null,lease_expires_utc:null,error:null,input_hash:null,
        brain_record_id:null,brain_content_hash:null,result_artifact_id:null,result_hash:null,phase:'NOT_DUE',pipeline_status:'NOT_DUE',benefit_conclusion:null,conclusion:null,authority};
  }
  verifyCompletion(event){
    const envelope=JSON.parse(event.payload_json),payload=envelope.payload;
    const row=this.b.one('ow_cases',event.entity_id);
    requireThat(row.stage==='CANDIDATE_EVALUATION' && !['PAUSED','CANCELLED','COMPLETED'].includes(row.work_status),409,'CANDIDATE_EVALUATION_STAGE_REQUIRED');
    this.b.baseline(row);
    requireThat(payload?.schema_version && payload.case_id===row.id && payload.candidate_hash===row.candidate_hash
      && validHash(payload.plan_hash) && Array.isArray(payload.artifacts) && payload.artifacts.length===requiredKinds.length,
    409,'CANDIDATE_EVALUATION_COMPLETION_CONFLICT');
    requireThat(requiredKinds.every((kind,index)=>payload.artifacts[index]?.kind===kind),409,'CANDIDATE_EVALUATION_ARTIFACT_ORDER_CONFLICT');
    return {row,envelope,payload};
  }
  enqueue(event){
    const {row,payload}=this.verifyCompletion(event),eventHash=digest(event.payload_json);
    const id=`candidate-evaluation-${objectHash({case_id:row.id,event_id:event.id,event_hash:eventHash,version:CANDIDATE_EVALUATOR_VERSION}).slice(7,31)}`;
    const existing=this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(id);
    if(existing){
      requireThat(existing.completion_event_hash===eventHash && existing.plan_hash===payload.plan_hash
        && existing.candidate_hash===row.candidate_hash,409,'CANDIDATE_EVALUATION_JOB_CONFLICT');
      return existing;
    }
    const created=new Date().toISOString();
    this.db.prepare(`INSERT INTO ow_candidate_evaluation_jobs(id,case_id,completion_event_id,completion_event_hash,plan_hash,
      candidate_hash,evaluator_version,state,next_attempt_ms,created_at_utc) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`)
      .run(id,row.id,event.id,eventHash,payload.plan_hash,row.candidate_hash,CANDIDATE_EVALUATOR_VERSION,Date.now(),created);
    this.b.event(row.id,'operational.candidate.evaluation.queued',{id:'ocean-candidate-evaluator',role:'BRAIN'},
      {job_id:id,completion_event_id:event.id,completion_event_hash:eventHash,plan_hash:payload.plan_hash,candidate_hash:row.candidate_hash,authority});
    return this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(id);
  }
  reconcile(){
    for(const event of this.db.prepare(`SELECT e.* FROM ow_events e JOIN ow_cases c ON c.id=e.entity_id
      WHERE e.action=? AND e.id=(SELECT MAX(latest.id) FROM ow_events latest WHERE latest.entity_id=e.entity_id AND latest.action=e.action)
      AND c.stage='CANDIDATE_EVALUATION' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED') ORDER BY e.id`).all(completionAction)){
      this.b.store.transaction(()=>{
        const payload=JSON.parse(event.payload_json).payload;
        const row=this.b.one('ow_cases',event.entity_id);
        const planEvent=this.db.prepare(`SELECT payload_json FROM ow_events WHERE entity_id=? AND action='operational.candidate.validation.plan'
          AND json_extract(payload_json,'$.payload.plan_hash')=? ORDER BY id DESC LIMIT 1`).get(row.id,payload.plan_hash);
        const plan=planEvent?JSON.parse(planEvent.payload_json).payload:null;
        const tasks=this.db.prepare('SELECT kind,status,artifact_id FROM ow_tasks WHERE case_id=?').all(row.id);
        requireThat(plan,409,'CANDIDATE_EVALUATION_PLAN_EVENT_REQUIRED');
        const reopened=this.b.operationalCandidateDispatch.reconcileValidationArtifacts(
          {id:'ocean-candidate-evaluator',role:'BRAIN'},row,plan,tasks,{completionEventId:event.id});
        if(reopened)return;
        const existing=this.db.prepare('SELECT id FROM ow_candidate_evaluation_jobs WHERE completion_event_id=? AND evaluator_version=?').get(event.id,CANDIDATE_EVALUATOR_VERSION);
        if(!existing)this.enqueue(event);
      });
    }
  }
  claim(){
    return this.b.store.transaction(()=>{
      const row=this.db.prepare(`SELECT jobs.* FROM ow_candidate_evaluation_jobs jobs JOIN ow_cases cases ON cases.id=jobs.case_id WHERE
        cases.stage='CANDIDATE_EVALUATION'
        AND jobs.completion_event_id=(SELECT MAX(events.id) FROM ow_events events WHERE events.entity_id=jobs.case_id AND events.action=?)
        AND ((jobs.state IN ('PENDING','RETRY') AND jobs.next_attempt_ms<=?) OR (jobs.state='RUNNING' AND jobs.lease_until_ms<=?))
        ORDER BY jobs.rowid LIMIT 1`).get(completionAction,Date.now(),Date.now());
      if(!row)return null;
      const event=this.db.prepare('SELECT * FROM ow_events WHERE id=?').get(row.completion_event_id);
      this.verifyCompletion(event);
      const lease=randomUUID();
      this.db.prepare("UPDATE ow_candidate_evaluation_jobs SET state='RUNNING',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?")
        .run(lease,Date.now()+this.leaseMs,row.id);
      return {...row,state:'RUNNING',attempts:row.attempts+1,lease_id:lease,lease_until_ms:Date.now()+this.leaseMs};
    });
  }
  renew(job){
    const leaseUntil=Date.now()+this.leaseMs;
    const update=this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET lease_until_ms=?
      WHERE id=? AND state='RUNNING' AND lease_id=?`).run(leaseUntil,job.id,job.lease_id);
    requireThat(update.changes===1,409,'CANDIDATE_EVALUATION_LEASE_LOST');
    return this.b.one('ow_candidate_evaluation_jobs',job.id);
  }
  artifactEnvelope(row,artifactId,kind){
    const artifact=this.b.artifactFor(row,artifactId,kind),manifest=JSON.parse(artifact.manifest_json);
    const content=Buffer.from(artifact.content).toString('utf8');
    requireThat(digest(content)===manifest.content_hash,409,'CANDIDATE_EVALUATION_ARTIFACT_TAMPERED');
    const parsed=JSON.parse(content);
    return {artifact_id:artifact.id,kind,manifest_json:artifact.manifest_json,manifest_sha256:digest(artifact.manifest_json),
      content_json:content,content_sha256:manifest.content_hash,parsed};
  }
  planEnvelope(planPayload){
    const basis=structuredClone(planPayload);delete basis.plan_hash;
    const content=canonical(planPayload),hashBasis=canonical(basis);
    requireThat(validHash(planPayload.plan_hash) && objectHash(basis)===planPayload.plan_hash,
      409,'CANDIDATE_EVALUATION_PLAN_HASH_CONFLICT');
    return {artifact_id:planPayload.plan_artifact_id,content_json:content,content_sha256:digest(content),
      plan_hash:planPayload.plan_hash,hash_basis_json:hashBasis};
  }
  planLineage(row,currentPlan){
    const events=this.db.prepare(`SELECT payload_json FROM ow_events WHERE entity_id=?
      AND action='operational.candidate.validation.plan' ORDER BY rowid`).all(row.id);
    const plans=events.map(event=>JSON.parse(event.payload_json).payload);
    const currentIndex=plans.findIndex(plan=>plan?.plan_hash===currentPlan.plan_hash);
    requireThat(currentIndex===plans.length-1 && currentIndex>=0,409,'CANDIDATE_EVALUATION_PLAN_LINEAGE_CONFLICT');
    const currentRevision=currentPlan.plan_revision;
    requireThat(Number.isSafeInteger(currentRevision) && currentRevision>=1 && plans.length===currentRevision,
      409,'CANDIDATE_EVALUATION_PLAN_LINEAGE_CONFLICT');
    let previousHash=null;
    const envelopes=plans.map((plan,index)=>{
      const revision=plan.plan_revision ?? (index===0?1:null);
      requireThat(revision===index+1 && plan.plan_artifact_id===currentPlan.plan_artifact_id
        && (revision===1?plan.supersedes_plan_hash==null:plan.supersedes_plan_hash===previousHash),
      409,'CANDIDATE_EVALUATION_PLAN_LINEAGE_CONFLICT');
      const envelope=this.planEnvelope(plan);previousHash=plan.plan_hash;
      return {revision,...envelope};
    });
    return {predecessors:envelopes.slice(0,-1),current:this.planEnvelope(currentPlan)};
  }
  snapshot(job){
    const event=this.db.prepare('SELECT * FROM ow_events WHERE id=?').get(job.completion_event_id);
    const {row,envelope,payload}=this.verifyCompletion(event);
    const planEvent=this.db.prepare(`SELECT * FROM ow_events WHERE entity_id=? AND action='operational.candidate.validation.plan'
      AND json_extract(payload_json,'$.payload.plan_hash')=? ORDER BY id DESC LIMIT 1`).get(row.id,payload.plan_hash);
    requireThat(planEvent && digest(planEvent.payload_json) && JSON.parse(planEvent.payload_json).payload.plan_hash===payload.plan_hash,
      409,'CANDIDATE_EVALUATION_PLAN_EVENT_REQUIRED');
    const dispatch=this.b.operationalCandidateDispatch,completed=dispatch.completion(row.id),registered=dispatch.registration(row.id);
    requireThat(completed && registered && registered.candidate_hash===row.candidate_hash
      && completed.candidate.candidate_hash===row.candidate_hash,409,'CANDIDATE_EVALUATION_CANDIDATE_CONFLICT');
    const planPayload=JSON.parse(planEvent.payload_json).payload;
    const artifacts=payload.artifacts.map((value,index)=>this.artifactEnvelope(row,value.artifact_id,requiredKinds[index]));
    requireThat(artifacts.every((artifact,index)=>artifact.kind===requiredKinds[index]
      && this.b.operationalCandidateDispatch.validationArtifactCompatible(row,planPayload,requiredKinds[index],artifact.artifact_id)),
    409,'CANDIDATE_EVALUATION_ARTIFACT_CONFLICT');
    const strategy=this.b.one('ow_strategies',row.strategy_id),profile=this.b.one('ow_profiles',strategy.profile_id);
    const profilePayload=JSON.parse(profile.payload_json),run=this.b.one('ow_runs',row.run_id),instance=this.b.one('ow_instances',row.instance_id);
    const planLineage=this.planLineage(row,planPayload);
    const completionContent=canonical(payload),completionContentHash=digest(completionContent);
    const completionDigest=completionContentHash.slice(7,31);
    const completionArtifactId=`candidate-validation-completion-${completionDigest}`;
    const completionEventId=`candidate-validation-completed-${completionDigest}`;
    const snapshot={schema_version:CANDIDATE_EVALUATOR_VERSION,case:{case_id:row.id,run_id:row.run_id,strategy_id:row.strategy_id,
      instance_id:row.instance_id,baseline_hash:row.baseline_hash,candidate_hash:row.candidate_hash},
      strategy:{name:profilePayload.strategy_name || profilePayload.display_name || row.strategy_id,
        profile_id:strategy.profile_id,profile_version:profile.version,project:profilePayload.owner_project || row.strategy_id},
      run:{state:run.state,context:JSON.parse(run.context_json)},instance:JSON.parse(instance.payload_json),
      validation_completion:{artifact_id:completionArtifactId,event_id:completionEventId,
        content_json:completionContent,content_sha256:completionContentHash},
      validation_plan_predecessors:planLineage.predecessors,validation_plan:planLineage.current,
      candidate:{completion:completed,registration:registered,artifact:this.artifactEnvelope(row,registered.candidate_artifact_id,'CANDIDATE')},
      evaluation_policy:{status:'NOT_PREDECLARED',policy_id:null,policy_hash:null,favorable_performance_required:null,
        minimum_positive_tests:null,maximum_negative_tests:null,minimum_cumulative_net_pnl_delta:null,
        minimum_candidate_trade_count:null,no_benefit_when_thresholds_fail:null},validation_artifacts:artifacts,authority};
    return snapshot;
  }
  capture(job){
    const current=this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(job.id);
    requireThat(current.state==='RUNNING' && current.lease_id===job.lease_id && current.lease_until_ms>Date.now(),409,'CANDIDATE_EVALUATION_LEASE_EXPIRED');
    if(current.input_json){requireThat(digest(current.input_json)===current.input_hash,409,'CANDIDATE_EVALUATION_INPUT_HASH_CONFLICT');return JSON.parse(current.input_json);}
    const snapshot=this.snapshot(current),content=canonical(snapshot),hash=digest(content);
    const update=this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET input_json=?,input_hash=?
      WHERE id=? AND state='RUNNING' AND lease_id=? AND input_json IS NULL`).run(content,hash,current.id,current.lease_id);
    requireThat(update.changes===1,409,'CANDIDATE_EVALUATION_SNAPSHOT_CONFLICT');
    return snapshot;
  }
  request(job,snapshot,registry){
    const predecessors=snapshot.validation_plan_predecessors || [];
    const frozen={schema_version:CANDIDATE_EVALUATION_REQUEST_VERSION,project:snapshot.strategy.project,
      case_id:snapshot.case.case_id,
      strategy_id:snapshot.case.strategy_id,strategy_profile_id:snapshot.strategy.profile_id,
      strategy_name:snapshot.strategy.name,strategy_version:snapshot.strategy.profile_version,
      execution_instance_id:snapshot.case.instance_id,registry_reconciliation_id:registry.reconciliation_id,
      registry_record_sha256:registry.record_sha256,baseline_hash:snapshot.case.baseline_hash,candidate_hash:snapshot.case.candidate_hash,
      evaluation_policy:snapshot.evaluation_policy,
      validation_plan:snapshot.validation_plan,
      validation_completion:snapshot.validation_completion,source_artifacts:snapshot.validation_artifacts.map(({parsed,...item})=>item),
      correlation:{event_id:`candidate-evaluation:${job.id}`,job_id:job.id}};
    if(predecessors.length) frozen.validation_plan_predecessors=predecessors;
    const request={...frozen,correlation:{...frozen.correlation,input_sha256:objectHash(frozen)}};
    return request;
  }
  expectedSourceEchoes(request){
    return request.source_artifacts.map(item=>{
      const content=JSON.parse(item.content_json),metric=(side,name)=>content[side]?.aggregate?.[name] ?? content[side]?.[name];
      return {kind:item.kind,artifact_id:item.artifact_id,manifest_sha256:item.manifest_sha256,content_sha256:item.content_sha256,
        execution_bindings:content.execution_bindings,baseline_net_pnl:Number(metric('baseline','net_pnl')),
        candidate_net_pnl:Number(metric('candidate','net_pnl')),candidate_trade_count:Number(metric('candidate','trade_count')),
        contradiction_count:content.contradictions.length,limitation_count:content.limitations.length};
    });
  }
  expectedBindings(request){
    const plan=JSON.parse(request.validation_plan.content_json);
    const lineage=request.validation_plan_predecessors || [];
    const predecessors=lineage.map(item=>({revision:item.revision,artifact_id:item.artifact_id,
      plan_hash:item.plan_hash,content_sha256:item.content_sha256,hash_basis_sha256:digest(item.hash_basis_json)}));
    const bindings={case_id:request.case_id,plan_artifact_id:request.validation_plan.artifact_id,
      plan_hash:request.validation_plan.plan_hash,plan_content_sha256:request.validation_plan.content_sha256,
      completion_artifact_id:request.validation_completion.artifact_id,
      completion_event_id:request.validation_completion.event_id,
      completion_content_sha256:request.validation_completion.content_sha256,
      baseline_hash:request.baseline_hash,candidate_hash:request.candidate_hash};
    if(predecessors.length) bindings.plan_lineage={plan_revision:plan.plan_revision,predecessor_count:predecessors.length,
        first_plan_hash:predecessors[0]?.plan_hash || request.validation_plan.plan_hash,
        current_plan_hash:request.validation_plan.plan_hash,
        lineage_sha256:digest(canonical({predecessors:lineage,current:request.validation_plan})),predecessors};
    return bindings;
  }
  verifyResponse(response,request){
    let content;try{content=JSON.parse(response?.content || '');}catch{}
    const allowed=request.evaluation_policy.status==='PREDECLARED'
      ?['BENEFIT_SUPPORTED','BENEFIT_NOT_ESTABLISHED','MORE_EVIDENCE_REQUIRED','NO_BENEFIT']
      :['BENEFIT_NOT_ESTABLISHED','MORE_EVIDENCE_REQUIRED'];
    const bindings=this.expectedBindings(request);
    const echoes=this.expectedSourceEchoes(request);
    const responseKeys=['schema_version','record_id','relative_path','content','content_sha256','conclusion_type','bindings',
      'evaluation_policy','source_artifacts','correlation','authority','human_governance_required','readback'];
    const lineage=request.validation_plan_predecessors || [];
    const contentKeys=['schema_version','strategy','registry_reconciliation_id','registry_record_sha256','bindings',
      'evaluation_policy','validation_plan','validation_completion','source_artifacts','dataset_provenance','conclusion',
      'correlation','authority','human_governance_required'];
    if(lineage.length) contentKeys.push('validation_plan_predecessors');
    const strategy={project:request.project,strategy_id:request.strategy_id,strategy_name:request.strategy_name,
      strategy_profile_id:request.strategy_profile_id,strategy_version:request.strategy_version,
      execution_instance_id:request.execution_instance_id};
    let predecessors=null,plan=null,completion=null;
    try{predecessors=lineage.map(envelope=>({envelope,content:JSON.parse(envelope.content_json)}));
      plan=JSON.parse(request.validation_plan.content_json);completion=JSON.parse(request.validation_completion.content_json);}catch{}
    let embeddedSources=null;
    try{embeddedSources=request.source_artifacts.map((item,index)=>({echo:echoes[index],content:JSON.parse(item.content_json)}));}catch{}
    requireThat(exactObjectKeys(response,responseKeys) && exactObjectKeys(content,contentKeys)
      && response?.schema_version===CANDIDATE_EVALUATION_RESULT_VERSION && response.record_id
      && response.relative_path && typeof response.content==='string' && digest(response.content)===response.content_sha256
      && allowed.includes(response.conclusion_type) && objectHash(response.correlation)===objectHash(request.correlation)
      && objectHash(response.bindings)===objectHash(bindings) && objectHash(response.evaluation_policy)===objectHash(request.evaluation_policy)
      && objectHash(response.source_artifacts)===objectHash(echoes) && objectHash(response.authority)===objectHash(brainAuthority)
      && response.human_governance_required===true && response.readback?.verified===true
      && response.readback.record_id===response.record_id && response.readback.relative_path===response.relative_path
      && response.readback.content_sha256===response.content_sha256
      && content?.schema_version==='brain-candidate-evaluation-content/v1'
      && objectHash(content.strategy)===objectHash(strategy)
      && content.registry_reconciliation_id===request.registry_reconciliation_id
      && content.registry_record_sha256===request.registry_record_sha256
      && content?.conclusion?.type===response.conclusion_type && Array.isArray(content?.conclusion?.reasons)
      && content.conclusion.metrics && typeof content.conclusion.metrics==='object' && !Array.isArray(content.conclusion.metrics)
      && objectHash(content?.bindings)===objectHash(bindings)
      && objectHash(content?.evaluation_policy)===objectHash(request.evaluation_policy)
      && predecessors && (!lineage.length || objectHash(content?.validation_plan_predecessors)===objectHash(predecessors))
      && plan && completion && objectHash(content?.validation_plan)===objectHash(plan)
      && objectHash(content?.validation_completion)===objectHash(completion)
      && embeddedSources && objectHash(content?.source_artifacts)===objectHash(embeddedSources)
      && content.dataset_provenance && typeof content.dataset_provenance==='object' && !Array.isArray(content.dataset_provenance)
      && objectHash(content?.correlation)===objectHash(request.correlation)
      && objectHash(content?.authority)===objectHash(brainAuthority)
      && content.human_governance_required===true,503,'CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID');
    return response;
  }
  async recordInBrain(job,snapshot){
    const learner=this.b.operationalLearning,token=learner.token();
    this.renew(job);await learner.verifyIdentity(token);this.renew(job);
    const registry=await learner.registry(token);this.renew(job);
    let current=this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(job.id),request;
    if(current.brain_request_json){requireThat(digest(current.brain_request_json)===current.brain_request_hash,409,'CANDIDATE_EVALUATION_REQUEST_HASH_CONFLICT');request=JSON.parse(current.brain_request_json);}
    else{
      request=this.request(current,snapshot,registry);const content=canonical(request),hash=digest(content);
      const update=this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET brain_request_json=?,brain_request_hash=?
        WHERE id=? AND state='RUNNING' AND lease_id=? AND brain_request_json IS NULL`).run(content,hash,current.id,current.lease_id);
      requireThat(update.changes===1,409,'CANDIDATE_EVALUATION_REQUEST_CONFLICT');
    }
    current=this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(job.id);
    let response;
    if(current.brain_response_json){requireThat(digest(current.brain_response_json)===current.brain_response_hash,409,'CANDIDATE_EVALUATION_RESPONSE_HASH_CONFLICT');response=this.verifyResponse(JSON.parse(current.brain_response_json),request);}
    else{
      this.renew(job);
      response=this.verifyResponse(await learner.call('/trading/learning/candidate-evaluation',token,request),request);
      this.renew(job);
      const content=canonical(response),hash=digest(content);
      const update=this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET brain_response_json=?,brain_response_hash=?,brain_record_id=?,brain_relative_path=?,brain_content_hash=?
        WHERE id=? AND state='RUNNING' AND lease_id=? AND brain_response_json IS NULL`)
        .run(content,hash,response.record_id,response.relative_path,response.content_sha256,current.id,current.lease_id);
      requireThat(update.changes===1,409,'CANDIDATE_EVALUATION_RESPONSE_CONFLICT');
    }
    current=this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE id=?').get(job.id);
    let readback;
    if(current.brain_readback_json){requireThat(digest(current.brain_readback_json)===current.brain_readback_hash,409,'CANDIDATE_EVALUATION_READBACK_HASH_CONFLICT');readback=this.verifyResponse(JSON.parse(current.brain_readback_json),request);}
    else{
      this.renew(job);
      readback=this.verifyResponse(await learner.call('/trading/learning/candidate-evaluation',token,request),request);
      this.renew(job);
      requireThat(objectHash(readback)===objectHash(response),503,'CANDIDATE_EVALUATION_BRAIN_READBACK_CONFLICT');
      const content=canonical(readback),hash=digest(content);
      const update=this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET brain_readback_json=?,brain_readback_hash=?
        WHERE id=? AND state='RUNNING' AND lease_id=? AND brain_readback_json IS NULL`).run(content,hash,current.id,current.lease_id);
      requireThat(update.changes===1,409,'CANDIDATE_EVALUATION_READBACK_CONFLICT');
    }
    requireThat(objectHash(readback)===objectHash(response),503,'CANDIDATE_EVALUATION_BRAIN_READBACK_CONFLICT');
    return response;
  }
  complete(job,snapshot,response){
    this.renew(job);
    return this.b.store.transaction(()=>{
      const current=this.b.one('ow_candidate_evaluation_jobs',job.id);
      requireThat(current.state==='RUNNING' && current.lease_id===job.lease_id && current.lease_until_ms>Date.now(),409,'CANDIDATE_EVALUATION_LEASE_EXPIRED');
      const row=this.b.one('ow_cases',current.case_id),dispatch=this.b.operationalCandidateDispatch;
      const completionEvent=this.completionEvent(row.id);
      const latestLifecycle=this.db.prepare(`SELECT id,action FROM ow_events WHERE entity_id=? AND action IN (?,?)
        ORDER BY id DESC LIMIT 1`).get(row.id,completionAction,'operational.candidate.validation.revalidation_required');
      const latestPlan=dispatch.validationPlan(row.id);
      requireThat(row.stage==='CANDIDATE_EVALUATION' && completionEvent?.id===current.completion_event_id
        && latestLifecycle?.action===completionAction && latestLifecycle.id===current.completion_event_id
        && latestPlan?.plan_hash===current.plan_hash,409,'CANDIDATE_EVALUATION_EVIDENCE_INVALIDATED');
      const completed=dispatch.completion(row.id),registered=dispatch.registration(row.id);
      const kind=response.conclusion_type==='NO_BENEFIT'?'NO_BENEFIT':'EVALUATION';
      requireThat(kind!=='NO_BENEFIT' || snapshot.evaluation_policy.status==='PREDECLARED',409,'CANDIDATE_EVALUATION_POLICY_REQUIRED');
      const brainContent=JSON.parse(response.content);
      const result={schema_version:CANDIDATE_EVALUATOR_VERSION,pipeline_status:'PIPELINE_COMPLETED',
        benefit_conclusion:response.conclusion_type,case_id:row.id,job_id:job.id,plan_hash:current.plan_hash,
        candidate_hash:current.candidate_hash,conclusion:response.conclusion_type,brain_record:{record_id:response.record_id,
          relative_path:response.relative_path,content_hash:response.content_sha256},evaluation:{schema_version:brainContent.schema_version,
          bindings:response.bindings,evaluation_policy:response.evaluation_policy,conclusion:brainContent.conclusion,
          source_artifacts:response.source_artifacts.map(item=>({kind:item.kind,artifact_id:item.artifact_id,
            manifest_sha256:item.manifest_sha256,content_sha256:item.content_sha256})),
          authority:response.authority,human_governance_required:response.human_governance_required},authority};
      const content=canonical(result),contentHash=digest(content),artifactId=`test-candidate-evaluation-${contentHash.slice(7,31)}`;
      this.b.writeArtifact(this.b.operationalLearning.brainActor(row.strategy_id,row.instance_id),{artifact_id:artifactId,case_id:row.id,
        run_id:row.run_id,recipient_id:completed.recipient_id,kind,media_type:'application/json',content,content_encoding:'utf8',
        content_hash:contentHash,candidate_hash:row.candidate_hash,
        dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id,...snapshot.validation_artifacts.map(item=>item.artifact_id)]});
      const ended=new Date().toISOString();
      this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET state='COMPLETED',lease_id=NULL,lease_until_ms=NULL,last_error=NULL,
        conclusion=?,result_artifact_id=?,result_hash=?,completed_at_utc=? WHERE id=?`)
        .run(response.conclusion_type,artifactId,contentHash,ended,current.id);
      this.b.event(row.id,'operational.candidate.evaluation.completed',{id:'ocean-candidate-evaluator',role:'BRAIN'},
        {job_id:job.id,plan_hash:current.plan_hash,candidate_hash:current.candidate_hash,conclusion:response.conclusion_type,
          result_artifact_id:artifactId,result_hash:contentHash,brain_record_id:response.record_id,brain_content_hash:response.content_sha256,authority});
      return this.publicStatus(this.b.one('ow_candidate_evaluation_jobs',job.id));
    });
  }
  fail(job,error){
    const message=safeError(error),leaseLoss=/CANDIDATE_EVALUATION_LEASE_(?:EXPIRED|LOST)/.test(message),blocked=!leaseLoss && ((error?.status>=400 && error?.status<500)
      || /HTTP_(400|401|403|404|409|410|422)|TAMPER|CONFLICT|MISMATCH|INVALID/.test(message));
    this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET state=?,lease_id=NULL,lease_until_ms=NULL,last_error=?,next_attempt_ms=?
      WHERE id=? AND lease_id=?`).run(blocked?'BLOCKED':'RETRY',message,
      Date.now()+Math.min(300000,1000*2**Math.min(job.attempts,8)),job.id,job.lease_id);
  }
  async flushOnce(){
    if(this.running || this.stopped || !this.b.operationalLearning.enabled)return;
    this.running=true;
    try{
      this.reconcile();let job;
      while(!this.stopped && (job=this.claim())){
        try{const snapshot=this.capture(job),response=await this.recordInBrain(job,snapshot);if(this.stopped)return;this.complete(job,snapshot,response);}
        catch(error){if(!this.stopped)this.fail(job,error);}
      }
      this.lastError=null;
    }finally{this.running=false;}
  }
}
