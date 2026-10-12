import { randomUUID } from 'node:crypto';
import { canonical, digest, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_EVALUATOR_VERSION='ocean-operational-candidate-evaluator/v1';
export const CANDIDATE_EVALUATION_REQUEST_VERSION='ocean-candidate-evaluation-request/v1';
export const CANDIDATE_EVALUATION_RESULT_VERSION='ocean-candidate-evaluation-result/v1';

const completionAction='operational.candidate.validation.completed';
const requiredKinds=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const authority=Object.freeze({automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false,automatic_promotion:false});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const safeError=error=>String(error?.code || error?.message || 'CANDIDATE_EVALUATION_FAILED')
  .replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300);

export class OperationalCandidateEvaluator {
  constructor(backend){this.b=backend;this.db=backend.db;this.running=false;this.stopped=false;this.leaseMs=300000;}
  stop(){this.stopped=true;}
  completionEvent(caseId){
    return this.db.prepare('SELECT * FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,completionAction) || null;
  }
  job(caseId){return this.db.prepare('SELECT * FROM ow_candidate_evaluation_jobs WHERE case_id=? ORDER BY rowid DESC LIMIT 1').get(caseId) || null;}
  publicStatus(job){
    if(!job)return null;
    return {status:job.state,attempts:job.attempts,next_attempt_utc:['PENDING','RETRY'].includes(job.state)?new Date(job.next_attempt_ms).toISOString():null,
      lease_expires_utc:job.state==='RUNNING' && job.lease_until_ms?new Date(job.lease_until_ms).toISOString():null,
      error:job.last_error || null,input_hash:job.input_hash || null,brain_record_id:job.brain_record_id || null,
      brain_content_hash:job.brain_content_hash || null,result_artifact_id:job.result_artifact_id || null,
      result_hash:job.result_hash || null,conclusion:job.conclusion || null,authority};
  }
  statusForCase(caseId){
    const job=this.job(caseId);
    if(job)return this.publicStatus(job);
    return this.completionEvent(caseId)?{status:'QUEUED',attempts:0,next_attempt_utc:null,lease_expires_utc:null,error:null,
      input_hash:null,brain_record_id:null,brain_content_hash:null,result_artifact_id:null,result_hash:null,conclusion:null,authority}
      :{status:'NOT_DUE',attempts:0,next_attempt_utc:null,lease_expires_utc:null,error:null,input_hash:null,
        brain_record_id:null,brain_content_hash:null,result_artifact_id:null,result_hash:null,conclusion:null,authority};
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
      WHERE e.action=? AND c.stage='CANDIDATE_EVALUATION' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED') ORDER BY e.id`).all(completionAction)){
      const existing=this.db.prepare('SELECT id FROM ow_candidate_evaluation_jobs WHERE completion_event_id=? AND evaluator_version=?').get(event.id,CANDIDATE_EVALUATOR_VERSION);
      if(!existing)this.b.store.transaction(()=>this.enqueue(event));
    }
  }
  claim(){
    return this.b.store.transaction(()=>{
      const row=this.db.prepare(`SELECT * FROM ow_candidate_evaluation_jobs WHERE
        ((state IN ('PENDING','RETRY') AND next_attempt_ms<=?) OR (state='RUNNING' AND lease_until_ms<=?))
        ORDER BY rowid LIMIT 1`).get(Date.now(),Date.now());
      if(!row)return null;
      const event=this.db.prepare('SELECT * FROM ow_events WHERE id=?').get(row.completion_event_id);
      this.verifyCompletion(event);
      const lease=randomUUID();
      this.db.prepare("UPDATE ow_candidate_evaluation_jobs SET state='RUNNING',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?")
        .run(lease,Date.now()+this.leaseMs,row.id);
      return {...row,state:'RUNNING',attempts:row.attempts+1,lease_id:lease,lease_until_ms:Date.now()+this.leaseMs};
    });
  }
  artifactEnvelope(row,artifactId,kind){
    const artifact=this.b.artifactFor(row,artifactId,kind),manifest=JSON.parse(artifact.manifest_json);
    const content=Buffer.from(artifact.content).toString('utf8');
    requireThat(digest(content)===manifest.content_hash,409,'CANDIDATE_EVALUATION_ARTIFACT_TAMPERED');
    const parsed=JSON.parse(content);
    const envelope={artifact_id:artifact.id,kind,producer_id:artifact.producer_id,recipient_id:artifact.recipient_id,
      candidate_hash:artifact.candidate_hash,baseline_hash:artifact.baseline_hash,manifest,content,content_hash:manifest.content_hash};
    for(const field of ['execution_bindings','comparison','contradictions','limitations','provenance','status']){
      if(parsed[field]!==undefined)envelope[field]=parsed[field];
    }
    return envelope;
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
    const artifacts=payload.artifacts.map((value,index)=>this.artifactEnvelope(row,value.artifact_id,requiredKinds[index]));
    requireThat(artifacts.every((artifact,index)=>artifact.kind===requiredKinds[index] && artifact.status==='PASS'
      && artifact.candidate_hash===row.candidate_hash && artifact.execution_bindings?.candidate?.logical_hash===row.candidate_hash),
    409,'CANDIDATE_EVALUATION_ARTIFACT_CONFLICT');
    const strategy=this.b.one('ow_strategies',row.strategy_id),profile=this.b.one('ow_profiles',strategy.profile_id);
    const profilePayload=JSON.parse(profile.payload_json),run=this.b.one('ow_runs',row.run_id),instance=this.b.one('ow_instances',row.instance_id);
    const snapshot={schema_version:CANDIDATE_EVALUATOR_VERSION,case:{case_id:row.id,run_id:row.run_id,strategy_id:row.strategy_id,
      instance_id:row.instance_id,baseline_hash:row.baseline_hash,candidate_hash:row.candidate_hash},
      strategy:{profile_id:strategy.profile_id,profile_version:profile.version,project:profilePayload.owner_project || row.strategy_id},
      run:{state:run.state,context:JSON.parse(run.context_json)},instance:JSON.parse(instance.payload_json),
      completion_event:{event_id:event.id,event_hash:job.completion_event_hash,payload:envelope.payload},
      plan_event:{event_id:planEvent.id,event_hash:digest(planEvent.payload_json),payload:JSON.parse(planEvent.payload_json).payload},
      candidate:{completion:completed,registration:registered,artifact:this.artifactEnvelope(row,registered.candidate_artifact_id,'CANDIDATE')},
      evaluation_policy:{status:'NOT_PREDECLARED',policy_id:null,policy_hash:null},validation_artifacts:artifacts,authority};
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
    const sourceArtifacts=Object.fromEntries(snapshot.validation_artifacts.map(item=>[item.artifact_id,item.content_hash]));
    const frozen={schema_version:CANDIDATE_EVALUATION_REQUEST_VERSION,project:snapshot.strategy.project,
      strategy_id:snapshot.case.strategy_id,strategy_profile_id:snapshot.strategy.profile_id,
      strategy_version:snapshot.strategy.profile_version,execution_instance_id:snapshot.case.instance_id,
      case_id:snapshot.case.case_id,plan_hash:job.plan_hash,validation_completion_event_id:job.completion_event_id,
      validation_completion_event_hash:job.completion_event_hash,registry_reconciliation_id:registry.reconciliation_id,
      registry_record_sha256:registry.record_sha256,logical:{baseline_hash:snapshot.case.baseline_hash,candidate_hash:snapshot.case.candidate_hash},
      evaluation_policy:snapshot.evaluation_policy,validation_artifacts:snapshot.validation_artifacts,source_artifacts:sourceArtifacts,
      correlation:{event_id:`candidate-evaluation:${job.id}`,job_id:job.id},authority};
    const request={...frozen,correlation:{...frozen.correlation,input_sha256:objectHash(frozen)}};
    return request;
  }
  verifyResponse(response,request){
    let content;try{content=JSON.parse(response?.content || '');}catch{}
    const allowed=request.evaluation_policy.status==='PREDECLARED'
      ?['BENEFIT_SUPPORTED','BENEFIT_NOT_ESTABLISHED','MORE_EVIDENCE_REQUIRED','NO_BENEFIT']
      :['BENEFIT_NOT_ESTABLISHED','MORE_EVIDENCE_REQUIRED'];
    requireThat(response?.schema_version===CANDIDATE_EVALUATION_RESULT_VERSION && response.record_id
      && response.relative_path && typeof response.content==='string' && digest(response.content)===response.content_sha256
      && allowed.includes(response.conclusion) && objectHash(response.correlation)===objectHash(request.correlation)
      && objectHash(response.source_artifacts)===objectHash(request.source_artifacts)
      && response.plan_hash===request.plan_hash && response.candidate_hash===request.logical.candidate_hash
      && objectHash(response.authority)===objectHash({...authority,human_governance_required:true})
      && content?.conclusion===response.conclusion && content?.plan_hash===request.plan_hash
      && content?.candidate_hash===request.logical.candidate_hash,503,'CANDIDATE_EVALUATION_BRAIN_RESPONSE_INVALID');
    return response;
  }
  async recordInBrain(job,snapshot){
    const learner=this.b.operationalLearning,token=learner.token();
    await learner.verifyIdentity(token);const registry=await learner.registry(token);
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
      response=this.verifyResponse(await learner.call('/trading/learning/candidate-evaluation',token,request),request);
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
      readback=this.verifyResponse(await learner.call('/trading/learning/candidate-evaluation',token,request),request);
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
    return this.b.store.transaction(()=>{
      const current=this.b.one('ow_candidate_evaluation_jobs',job.id);
      requireThat(current.state==='RUNNING' && current.lease_id===job.lease_id && current.lease_until_ms>Date.now(),409,'CANDIDATE_EVALUATION_LEASE_EXPIRED');
      const row=this.b.one('ow_cases',current.case_id),dispatch=this.b.operationalCandidateDispatch;
      const completed=dispatch.completion(row.id),registered=dispatch.registration(row.id);
      const kind=response.conclusion==='NO_BENEFIT'?'NO_BENEFIT':'EVALUATION';
      requireThat(kind!=='NO_BENEFIT' || snapshot.evaluation_policy.status==='PREDECLARED',409,'CANDIDATE_EVALUATION_POLICY_REQUIRED');
      const result={schema_version:CANDIDATE_EVALUATOR_VERSION,case_id:row.id,job_id:job.id,plan_hash:current.plan_hash,
        candidate_hash:current.candidate_hash,conclusion:response.conclusion,brain_record:{record_id:response.record_id,
          relative_path:response.relative_path,content_hash:response.content_sha256},evaluation:JSON.parse(response.content),authority};
      const content=canonical(result),contentHash=digest(content),artifactId=`test-candidate-evaluation-${contentHash.slice(7,31)}`;
      this.b.writeArtifact(this.b.operationalLearning.brainActor(row.strategy_id,row.instance_id),{artifact_id:artifactId,case_id:row.id,
        run_id:row.run_id,recipient_id:completed.recipient_id,kind,media_type:'application/json',content,content_encoding:'utf8',
        content_hash:contentHash,candidate_hash:row.candidate_hash,
        dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id,...snapshot.validation_artifacts.map(item=>item.artifact_id)]});
      const ended=new Date().toISOString();
      this.db.prepare(`UPDATE ow_candidate_evaluation_jobs SET state='COMPLETED',lease_id=NULL,lease_until_ms=NULL,last_error=NULL,
        conclusion=?,result_artifact_id=?,result_hash=?,completed_at_utc=? WHERE id=?`)
        .run(response.conclusion,artifactId,contentHash,ended,current.id);
      this.b.event(row.id,'operational.candidate.evaluation.completed',{id:'ocean-candidate-evaluator',role:'BRAIN'},
        {job_id:job.id,plan_hash:current.plan_hash,candidate_hash:current.candidate_hash,conclusion:response.conclusion,
          result_artifact_id:artifactId,result_hash:contentHash,brain_record_id:response.record_id,brain_content_hash:response.content_sha256,authority});
      return this.publicStatus(this.b.one('ow_candidate_evaluation_jobs',job.id));
    });
  }
  fail(job,error){
    const message=safeError(error),blocked=(error?.status>=400 && error?.status<500)
      || /HTTP_(401|403)|TAMPER|CONFLICT|MISMATCH|INVALID/.test(message);
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
    }finally{this.running=false;}
  }
}
