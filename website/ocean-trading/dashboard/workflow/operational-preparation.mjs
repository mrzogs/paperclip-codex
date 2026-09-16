import {exactKeys,future,id,noSecrets,objectHash,requireThat,sealedHash} from './common.mjs';
import {PURPOSES,interval,subtract,intersect} from './run-manager.mjs';

export const RELEASE_SCOPES=['STRATEGY_ONBOARDING','DATASET_RELEASE','RUN_RELEASE'];
const human=actor=>requireThat(actor.role==='HUMAN' && actor.id==='wayne-ocean-ui',403,'WAYNE_BROWSER_ONLY');

// Provider-owned release contract. It does not add enum values to shared 2.1.0 decisions.
export class OperationalPreparation {
  constructor(backend){this.b=backend;this.db=backend.db;}
  review(actor,input){human(actor);return this.validateReview(input);}
  validateReview(input){
    exactKeys(input,['context','manifest_key','factual_binding_hash','interval','prior_exposure','expires_at_utc']);noSecrets(input,this.b.environment);
    const c=structuredClone(input.context);this.b.validate('run-context',c);
    requireThat(!c.run_id.startsWith('test-') && !c.execution_instance_id.startsWith('test-') && !c.dataset_manifest_id.startsWith('test-'),403,'TEST_PROMOTION_REJECTED');
    const binding=this.b.config.operational_factual_bindings?.find(v=>v.binding_hash===input.factual_binding_hash);
    requireThat(binding && sealedHash(binding,'binding_hash')===binding.binding_hash && binding.state==='VERIFIED_FACTS_ONLY' && binding.strategy_id===c.strategy_id && binding.instance.execution_instance_id===c.execution_instance_id,409,'VERIFIED_FACTUAL_BINDING_REQUIRED');
    const instance=binding.instance;
    requireThat(c.strategy_code_hash===binding.strategy_code_hash && c.strategy_config_hash===instance.config_hash && c.strategy_version===instance.version_binding && c.source_installation_id===instance.source_installation_id && instance.capabilities.includes(c.expected_environment),409,'FACTUAL_CONTEXT_CONFLICT');
    const registry=this.b.one('ow_strategies',c.strategy_id),profile=JSON.parse(this.b.one('ow_profiles',`${c.strategy_profile_id}:${c.strategy_profile_version}`).payload_json);
    this.b.validate('strategy-profile',profile);
    requireThat(registry.profile_id===`${c.strategy_profile_id}:${c.strategy_profile_version}` && profile.strategy_id===c.strategy_id && profile.profile_hash===binding.profile_hash && sealedHash(profile,'profile_hash')===profile.profile_hash,409,'FACTUAL_PROFILE_CONFLICT');
    const pending=this.db.prepare("SELECT payload_json FROM ow_operational_pending WHERE id=? AND strategy_id=? AND kind='DATASET_MANIFEST'").get(input.manifest_key,c.strategy_id);
    requireThat(pending,409,'VERIFIED_PENDING_MANIFEST_REQUIRED');
    const proposal=JSON.parse(pending.payload_json),manifest=JSON.parse(proposal.manifest_text);
    this.b.validate('dataset-manifest',manifest);
    requireThat(manifest.manifest_hash===c.dataset_manifest_hash && sealedHash(manifest,'manifest_hash')===manifest.manifest_hash && manifest.dataset_manifest_id===c.dataset_manifest_id && manifest.revision===c.dataset_manifest_revision && manifest.quality_status==='VERIFIED' && !manifest.gaps.length,409,'MANIFEST_NOT_READY');
    requireThat(future(input.expires_at_utc) && ['UNTOUCHED','EXPOSED','UNKNOWN'].includes(input.prior_exposure),422,'EXPIRING_DATASET_RELEASE_REQUIRED');
    const requested=interval(input.interval),matches=manifest.partitions.map((p,i)=>({p,i})).filter(({p})=>p.partition===c.dataset_partition && p.coverage_status==='COMPLETE' && !subtract([requested],[interval({start_utc:p.start_utc,end_utc:p.end_utc})]).length);
    requireThat(matches.length===1,409,'UNAMBIGUOUS_COMPLETE_PARTITION_REQUIRED');
    const partition=matches[0],rule=PURPOSES.find(r=>r[0]===c.expected_environment && r[1]===c.evidence_purpose && r[2]===c.dataset_partition);
    requireThat(rule,403,'OPERATIONAL_PURPOSE_REJECTED');
    requireThat(c.evidence_purpose!=='PROTECTED_HOLDOUT' || input.prior_exposure==='UNTOUCHED',403,'HOLDOUT_EXPOSURE_REJECTED');
    const protectedIntervals=[...manifest.protected_intervals,...manifest.partitions.filter(p=>['HOLDOUT','VALIDATION'].includes(p.partition)).map(p=>({start_utc:p.start_utc,end_utc:p.end_utc}))];
    if(['SCOPED_LEARNING','HISTORICAL_DISCOVERY','EVALUATE_ONLY'].includes(rule[3]))requireThat(!intersect([requested],protectedIntervals).length,403,'PROTECTED_HISTORY_OVERLAP');
    if(!['LEARNING','HISTORICAL_BUILD'].includes(c.evidence_purpose)){
      const row=this.b.one('ow_cases',c.case_id);this.b.active(row);this.b.baseline(row);
      requireThat(row.strategy_id===c.strategy_id && row.instance_id===c.execution_instance_id && row.candidate_hash===c.strategy_code_hash,403,'CANDIDATE_CASE_REQUIRED');
      this.b.approved(row,c.evidence_purpose==='SHADOW_FORWARD'?'SHADOW':'DEVELOPMENT',null,null,{DEVELOPMENT_BACKTEST:'BACKTEST',RESEARCH_EXPERIMENT:'RESEARCH_EXPERIMENT',VALIDATION:'VALIDATION',PROTECTED_HOLDOUT:'OOS_HOLDOUT',SHADOW_FORWARD:'SHADOW_FORWARD'}[c.evidence_purpose]);
    }else requireThat(c.case_id===null && c.experiment_id===null && c.candidate_id===null && registry.baseline_hash===c.strategy_code_hash,403,'BASELINE_RUN_REQUIRED');
    requireThat(c.observed_source_state.quality==='UNKNOWN' && c.observed_source_state.environment==='UNKNOWN',422,'PREPARATION_CANNOT_CLAIM_OBSERVATION');
    c.learner_permission=rule[3];c.permission_reason='Explicit human operational release; source handshake still required';c.context_hash=sealedHash(c,'context_hash');
    const review={schema_version:'ocean-operational-review/v1',context:c,factual_binding_hash:binding.binding_hash,profile_hash:binding.profile_hash,manifest_key:input.manifest_key,partition_index:partition.i,interval:requested,prior_exposure:input.prior_exposure,expires_at_utc:input.expires_at_utc,registry_revision:registry.revision};
    return {...review,review_hash:objectHash(review)};
  }
  approved(review,scope){
    const rows=this.db.prepare('SELECT id,payload_json FROM ow_operational_decisions WHERE strategy_id=? AND review_hash=? AND scope=?').all(review.context.strategy_id,review.review_hash,scope);
    const row=rows.find(r=>{const d=JSON.parse(r.payload_json);return d.decision==='APPROVED' && d.decided_by==='wayne-ocean-ui' && future(d.expires_at_utc) && !this.db.prepare('SELECT id FROM ow_operational_revocations WHERE id=?').get(r.id);});
    requireThat(row,403,`${scope}_REQUIRED`);return row.id;
  }
  perform(action,actor,input){
    human(actor);noSecrets(input,this.b.environment);
    if(action==='reviews')return this.review(actor,input);
    if(action==='decisions/revoke'){
      exactKeys(input,['decision_id','reason']);id(input.decision_id);requireThat(typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'REASON_REQUIRED');
      requireThat(this.db.prepare('SELECT id FROM ow_operational_decisions WHERE id=?').get(input.decision_id),404,'UNKNOWN_OPERATIONAL_DECISION');
      this.db.prepare('INSERT OR IGNORE INTO ow_operational_revocations VALUES(?,?)').run(input.decision_id,JSON.stringify({...input,actor_id:actor.id,at_utc:new Date().toISOString()}));return {revoked:true};
    }
    exactKeys(input,['review','review_hash',...(action==='decisions'?['decision_id','scope','decision','reason']:[])]);
    const review=this.review(actor,input.review);requireThat(review.review_hash===input.review_hash,409,'OPERATIONAL_REVIEW_CHANGED');
    if(action==='decisions'){
      id(input.decision_id);requireThat(!input.decision_id.startsWith('test-') && RELEASE_SCOPES.includes(input.scope) && ['APPROVED','REJECTED'].includes(input.decision) && typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'EXPLICIT_OPERATIONAL_DECISION_REQUIRED');
      const decision={schema_version:'ocean-operational-decision/v1',decision_id:input.decision_id,scope:input.scope,decision:input.decision,reason:input.reason,review,decided_by:actor.id,decided_via:'AUTHORISED_OCEAN_UI',expires_at_utc:review.expires_at_utc};
      const old=this.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(input.decision_id);
      if(old){const saved=JSON.parse(old.payload_json),{decided_at_utc,...comparable}=saved;requireThat(objectHash(comparable)===objectHash(decision),409,'IMMUTABLE_DECISION_CONFLICT');return saved;}
      decision.decided_at_utc=new Date().toISOString();
      this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(input.decision_id,review.context.strategy_id,review.review_hash,input.scope,JSON.stringify(decision));return decision;
    }
    requireThat(action==='runs/prepare',404,'UNKNOWN_OPERATIONAL_PREPARATION');
    const decisions=Object.fromEntries(RELEASE_SCOPES.map(s=>[s,this.approved(review,s)])),c=review.context;
    const binding=this.b.config.operational_factual_bindings.find(b=>b.binding_hash===review.factual_binding_hash),instance=binding.instance;
    const manifest=JSON.parse(JSON.parse(this.db.prepare('SELECT payload_json FROM ow_operational_pending WHERE id=?').get(review.manifest_key).payload_json).manifest_text);
    return this.b.store.transaction(()=>{
      const old=this.db.prepare('SELECT context_json FROM ow_runs WHERE id=?').get(c.run_id);
      if(old){requireThat(JSON.parse(old.context_json).context_hash===c.context_hash,409,'IMMUTABLE_RUN_CONFLICT');return {run_id:c.run_id,state:this.b.one('ow_runs',c.run_id).state,context:c,idempotent:true,actual_source_start:false};}
      this.b.runs.uniqueInstance(instance);
      requireThat(!this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(c.execution_instance_id),409,'INSTANCE_ALREADY_RESERVED');
      const existing=this.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(c.execution_instance_id);
      if(existing)requireThat(objectHash(JSON.parse(existing.payload_json))===objectHash(instance),409,'FACTUAL_INSTANCE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(c.execution_instance_id,c.strategy_id,JSON.stringify(instance));
      const dataset=this.db.prepare('SELECT content_hash,strategy_id FROM ow_datasets WHERE id=?').get(review.manifest_key);
      if(dataset)requireThat(dataset.content_hash===manifest.manifest_hash && dataset.strategy_id===c.strategy_id,409,'DATASET_SCOPE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run(review.manifest_key,c.strategy_id,manifest.revision,manifest.manifest_hash,'OPERATIONAL_MANIFEST',JSON.stringify(manifest));
      const permission={permission_id:c.run_id,strategy_id:c.strategy_id,manifest_key:review.manifest_key,manifest_hash:manifest.manifest_hash,purposes:[c.evidence_purpose],expires_at_utc:review.expires_at_utc,prior_exposure:review.prior_exposure,test_only:false,review,decisions};
      const plan={selection:{strategy_id:c.strategy_id,instance_id:c.execution_instance_id,purpose:c.evidence_purpose,permission_id:c.run_id,partition_index:review.partition_index,interval:review.interval},context_hash:c.context_hash,operational_review:review};plan.plan_hash=objectHash(plan);
      this.db.prepare('INSERT INTO ow_dataset_permissions VALUES(?,?,?)').run(c.run_id,c.strategy_id,JSON.stringify(permission));
      this.db.prepare("INSERT INTO ow_runs VALUES(?,?,?,?,'READY',?)").run(c.run_id,c.strategy_id,c.execution_instance_id,c.revision,JSON.stringify(c));
      this.db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(c.run_id,objectHash([binding.binding_hash,manifest.manifest_hash,review.interval]),JSON.stringify(plan));
      return {run_id:c.run_id,state:'READY',context:c,idempotent:false,actual_source_start:false,operational_enabled:false};
    });
  }
}
