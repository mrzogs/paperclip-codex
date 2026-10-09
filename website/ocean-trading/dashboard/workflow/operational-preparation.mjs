import {API_VERSION,exactKeys,future,id,noSecrets,objectHash,requireThat,sealedHash} from './common.mjs';
import {PURPOSES,interval,subtract,intersect,merge} from './run-manager.mjs';

export const RELEASE_SCOPES=['STRATEGY_ONBOARDING','DATASET_RELEASE','RUN_RELEASE'];
const human=actor=>requireThat(actor.role==='HUMAN' && actor.id==='wayne-ocean-ui',403,'WAYNE_BROWSER_ONLY');
const parse=row=>JSON.parse(row.payload_json);
const REVIEW_INPUT_KEYS=['context','manifest_key','factual_binding_hash','interval','prior_exposure','expires_at_utc'];
const REVIEW_READBACK_KEYS=['schema_version','profile_hash','observed_profile_hash','manifest_hash','partition_index','review_hash'];

export function onboardingLineageDecisionId(sourceDecisionId,reviewHash){
  id(sourceDecisionId);
  requireThat(/^sha256:[a-f0-9]{64}$/.test(reviewHash || ''),422,'OPERATIONAL_REVIEW_HASH_REQUIRED');
  return `lineage:${objectHash([sourceDecisionId,reviewHash]).slice(7)}`;
}

// Provider-owned release contract. It does not add enum values to shared 2.1.0 decisions.
export class OperationalPreparation {
  constructor(backend){this.b=backend;this.db=backend.db;}
  review(actor,input){
    human(actor);
    exactKeys(input,[...REVIEW_INPUT_KEYS,...REVIEW_READBACK_KEYS]);
    const raw=Object.fromEntries(REVIEW_INPUT_KEYS.map(key=>[key,input[key]]));
    const reviewed=this.validateReview(raw);
    for(const key of REVIEW_READBACK_KEYS)if(Object.hasOwn(input,key))requireThat(input[key]===reviewed[key],409,'OPERATIONAL_REVIEW_CHANGED');
    return reviewed;
  }
  validateReview(input){
    exactKeys(input,['context','manifest_key','factual_binding_hash','interval','prior_exposure','expires_at_utc']);noSecrets(input,this.b.environment);
    const c=structuredClone(input.context);this.b.validate('run-context',c);
    requireThat(!c.run_id.startsWith('test-') && !c.execution_instance_id.startsWith('test-') && !c.dataset_manifest_id.startsWith('test-'),403,'TEST_PROMOTION_REJECTED');
    const binding=this.b.config.operational_factual_bindings?.find(v=>v.binding_hash===input.factual_binding_hash);
    requireThat(binding && sealedHash(binding,'binding_hash')===binding.binding_hash && binding.state==='VERIFIED_FACTS_ONLY' && binding.strategy_id===c.strategy_id && binding.instance.execution_instance_id===c.execution_instance_id,409,'VERIFIED_FACTUAL_BINDING_REQUIRED');
    const instance=binding.instance;
    requireThat(c.strategy_code_hash===binding.strategy_code_hash && c.strategy_config_hash===instance.config_hash && c.strategy_version===instance.version_binding && c.source_installation_id===instance.source_installation_id && instance.capabilities.includes(c.expected_environment),409,'FACTUAL_CONTEXT_CONFLICT');
    const registry=this.b.one('ow_strategies',c.strategy_id),profile=parse(this.b.one('ow_profiles',`${c.strategy_profile_id}:${c.strategy_profile_version}`));
    this.b.validate('strategy-profile',profile);
    requireThat(registry.profile_id===`${c.strategy_profile_id}:${c.strategy_profile_version}` && profile.strategy_id===c.strategy_id && profile.strategy_code_hash===binding.strategy_code_hash && profile.strategy_config_hash===instance.config_hash && profile.baseline_version===instance.version_binding && sealedHash(profile,'profile_hash')===profile.profile_hash,409,'FACTUAL_PROFILE_CONFLICT');
    const pending=this.db.prepare("SELECT payload_json FROM ow_operational_pending WHERE id=? AND strategy_id=? AND kind='DATASET_MANIFEST'").get(input.manifest_key,c.strategy_id);
    requireThat(pending,409,'VERIFIED_PENDING_MANIFEST_REQUIRED');
    const proposal=parse(pending),manifest=JSON.parse(proposal.manifest_text);
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
    const review={schema_version:'ocean-operational-review/v1',context:c,factual_binding_hash:binding.binding_hash,profile_hash:profile.profile_hash,observed_profile_hash:binding.profile_hash,manifest_key:input.manifest_key,manifest_hash:manifest.manifest_hash,partition_index:partition.i,interval:requested,prior_exposure:input.prior_exposure,expires_at_utc:input.expires_at_utc};
    return {...review,review_hash:objectHash(review)};
  }
  approved(review,scope){
    const rows=this.db.prepare('SELECT id,payload_json FROM ow_operational_decisions WHERE strategy_id=? AND review_hash=? AND scope=?').all(review.context.strategy_id,review.review_hash,scope);
    const row=rows.find(r=>{
      const d=parse(r),direct=d.decided_via==='AUTHORISED_OCEAN_UI' && d.decided_by==='wayne-ocean-ui';
      const lineage=d.decided_via==='AUTHORISED_OCEAN_UI_LINEAGE' && d.decided_by==='Wayne' && typeof d.source_decision_id==='string';
      return d.decision==='APPROVED' && (direct || lineage) && future(d.expires_at_utc) && !this.db.prepare('SELECT id FROM ow_operational_revocations WHERE id=?').get(r.id);
    });
    requireThat(row,403,`${scope}_REQUIRED`);return row.id;
  }
  list(actor){
    human(actor);
    const rows=this.db.prepare('SELECT id,payload_json,created_at_utc FROM ow_operational_release_requests ORDER BY rowid DESC').all();
    return {schema_version:'ocean-operational-release-requests/v1',items:rows.map(row=>{
      const request=parse(row),review=request.review;
      const decision=this.db.prepare("SELECT id,payload_json FROM ow_operational_decisions WHERE review_hash=? AND scope='DATASET_RELEASE' ORDER BY rowid DESC LIMIT 1").get(review.review_hash);
      const runDecision=this.db.prepare("SELECT id,payload_json FROM ow_operational_decisions WHERE review_hash=? AND scope='RUN_RELEASE' ORDER BY rowid DESC LIMIT 1").get(review.review_hash);
      const released=this.db.prepare('SELECT id,payload_json FROM ow_operational_release_receipts WHERE id=?').get(`release-receipt:${review.review_hash.slice(7)}`);
      const run=this.db.prepare('SELECT state FROM ow_runs WHERE id=?').get(review.context.run_id);
      const payload=decision?parse(decision):null;
      const state=released?'RELEASED':payload?.decision || (future(review.expires_at_utc)?'PENDING':'EXPIRED');
      return {...request,request_id:row.id,state,decision_id:decision?.id || null,release_receipt:released?parse(released):null,run_release_decision:runDecision?parse(runDecision):null,run_state:run?.state || null,created_at_utc:row.created_at_utc,actionable:state==='PENDING'};
    })};
  }
  reconcileOnboarding(review,sourceDecisionId){
    id(sourceDecisionId);
    const setup=this.db.prepare('SELECT payload_json FROM ow_setup_receipts WHERE id=?').get('S40.3');
    requireThat(setup && ['PASS','VERIFIED_REUSE'].includes(parse(setup).status),409,'S40_3_SETUP_RECEIPT_REQUIRED');
    const source=this.db.prepare('SELECT request_id,case_id,binding_json,payload_json FROM ow_decisions WHERE id=?').get(sourceDecisionId);
    requireThat(source,409,'SOURCE_ONBOARDING_DECISION_REQUIRED');
    const payload=parse(source),binding=JSON.parse(source.binding_json),request=this.b.one('ow_approval_requests',source.request_id),row=this.b.one('ow_cases',source.case_id),current=this.b.one('ow_strategies',row.strategy_id);
    this.b.verifySnapshot(request);
    // Onboarding follows the unchanged baseline, not a later research candidate.
    requireThat(current.baseline_hash===row.baseline_hash && request.state==='APPROVED' && future(payload.expires_at_utc) && !this.db.prepare('SELECT decision_id FROM ow_decision_revocations WHERE decision_id=?').get(sourceDecisionId),409,'SOURCE_ONBOARDING_APPROVAL_NOT_CURRENT');
    requireThat(payload.decision==='APPROVED' && payload.decided_by==='Wayne' && payload.decided_via==='AUTHORISED_OCEAN_UI'
      && payload.request_id===request.id && payload.snapshot_hash===request.snapshot_hash
      && request.case_id===row.id && request.gate==='ONBOARDING' && request.baseline_hash===row.baseline_hash
      && binding.case_id===row.id && binding.instance_id===row.instance_id && binding.gate==='ONBOARDING'
      && binding.strategy_id===row.strategy_id && binding.strategy_id===review.context.strategy_id
      && binding.baseline_hash===row.baseline_hash && binding.baseline_hash===review.context.strategy_code_hash
      && request.artifact_id===binding.artifact_id,409,'SOURCE_ONBOARDING_DECISION_CONFLICT');
    const artifact=this.b.artifactFor(row,binding.artifact_id),text=Buffer.from(artifact.content).toString('utf8');
    requireThat(text.includes(review.context.strategy_version),409,'ONBOARDING_IDENTITY_EVIDENCE_MISMATCH');
    for(const value of [review.context.strategy_code_hash,review.context.strategy_config_hash,review.profile_hash,review.observed_profile_hash])requireThat(text.includes(value.slice(7)),409,'ONBOARDING_IDENTITY_EVIDENCE_MISMATCH');
    const lineage={schema_version:'ocean-onboarding-decision-lineage/v1',source_decision_id:sourceDecisionId,source_request_id:source.request_id,source_artifact_id:binding.artifact_id,source_snapshot_hash:request.snapshot_hash,source_decided_at_utc:payload.decided_at_utc,source_setup_task:'S40.3',strategy_id:review.context.strategy_id,strategy_version:review.context.strategy_version,strategy_code_hash:review.context.strategy_code_hash,strategy_config_hash:review.context.strategy_config_hash,workflow_profile_hash:review.profile_hash,observed_profile_hash:review.observed_profile_hash,factual_binding_hash:review.factual_binding_hash,governed_identity_hash:objectHash([review.context.strategy_id,review.context.strategy_version,review.context.strategy_code_hash,review.context.strategy_config_hash,review.profile_hash,review.observed_profile_hash]),preserved_scope:'STRATEGY_ONBOARDING_ONLY',dataset_release_preserved:false};
    const decisionId=onboardingLineageDecisionId(sourceDecisionId,review.review_hash),decision={schema_version:'ocean-operational-decision/v1',decision_id:decisionId,scope:'STRATEGY_ONBOARDING',decision:'APPROVED',reason:'Preserved from the authenticated S40.3 onboarding decision after exact identity reconciliation.',review,decided_by:'Wayne',decided_via:'AUTHORISED_OCEAN_UI_LINEAGE',source_decision_id:sourceDecisionId,lineage,expires_at_utc:payload.expires_at_utc,decided_at_utc:payload.decided_at_utc};
    const old=this.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(decisionId);
    if(old)requireThat(objectHash(parse(old))===objectHash(decision),409,'IMMUTABLE_ONBOARDING_LINEAGE_CONFLICT');
    else this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(decisionId,review.context.strategy_id,review.review_hash,'STRATEGY_ONBOARDING',JSON.stringify(decision));
    return {decision_id:decisionId,...lineage};
  }
  request(actor,input){
    requireThat(actor.role==='BRAIN' && actor.scopes.includes('event.write'),403,'BRAIN_PROPOSAL_SCOPE_REQUIRED');
    exactKeys(input,['review','source_onboarding_decision_id']);noSecrets(input,this.b.environment);
    const review=this.validateReview(input.review);
    requireThat(actor.strategyIds.includes(review.context.strategy_id),403,'WRONG_PROPOSAL_SCOPE');
    return this.b.store.transaction(()=>{
      const key=`release-request:${review.review_hash.slice(7)}`;
      const old=this.db.prepare('SELECT content_hash,payload_json FROM ow_operational_release_requests WHERE id=?').get(key);
      if(old){
        const saved=parse(old);
        requireThat(saved.review_hash===review.review_hash && saved.lineage?.source_decision_id===input.source_onboarding_decision_id,409,'IMMUTABLE_RELEASE_REQUEST_CONFLICT');
        return {request_id:key,review_hash:review.review_hash,state:'PENDING',idempotent:true,lineage:saved.lineage};
      }
      const lineage=this.reconcileOnboarding(review,input.source_onboarding_decision_id);
      const request={schema_version:'ocean-operational-release-request/v1',review,review_hash:review.review_hash,lineage,requested_by:actor.id,requested_at_utc:new Date().toISOString()};
      const contentHash=objectHash(request);
      this.db.prepare('INSERT INTO ow_operational_release_requests VALUES(?,?,?,?,?)').run(key,review.context.strategy_id,contentHash,JSON.stringify(request),request.requested_at_utc);
      return {request_id:key,review_hash:review.review_hash,state:'PENDING',idempotent:false,lineage};
    });
  }
  release(actor,input){
    human(actor);exactKeys(input,['review','review_hash']);noSecrets(input,this.b.environment);
    const review=this.review(actor,input.review);requireThat(review.review_hash===input.review_hash,409,'OPERATIONAL_REVIEW_CHANGED');
    const request=this.db.prepare('SELECT id FROM ow_operational_release_requests WHERE id=?').get(`release-request:${review.review_hash.slice(7)}`);
    requireThat(request,409,'PENDING_DATASET_RELEASE_REQUEST_REQUIRED');
    const decisions={STRATEGY_ONBOARDING:this.approved(review,'STRATEGY_ONBOARDING'),DATASET_RELEASE:this.approved(review,'DATASET_RELEASE')};
    const c=review.context,binding=this.b.config.operational_factual_bindings.find(b=>b.binding_hash===review.factual_binding_hash),instance=binding.instance;
    const manifest=JSON.parse(parse(this.db.prepare('SELECT payload_json FROM ow_operational_pending WHERE id=?').get(review.manifest_key)).manifest_text);
    const permissionId=`dataset-release:${review.review_hash.slice(7)}`,versionId=`baseline:${objectHash([c.strategy_id,c.strategy_version,c.strategy_code_hash]).slice(7,31)}`,receiptId=`release-receipt:${review.review_hash.slice(7)}`;
    return this.b.store.transaction(()=>{
      const existingReceipt=this.db.prepare('SELECT payload_json FROM ow_operational_release_receipts WHERE id=?').get(receiptId);
      if(existingReceipt)return {...parse(existingReceipt),idempotent:true};
      this.b.runs.uniqueInstance(instance);
      const existingInstance=this.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(c.execution_instance_id);
      if(existingInstance)requireThat(objectHash(parse(existingInstance))===objectHash(instance),409,'FACTUAL_INSTANCE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(c.execution_instance_id,c.strategy_id,JSON.stringify(instance));
      const dataset=this.db.prepare('SELECT content_hash,strategy_id,payload_json FROM ow_datasets WHERE id=?').get(review.manifest_key);
      if(dataset)requireThat(dataset.content_hash===manifest.manifest_hash && dataset.strategy_id===c.strategy_id && objectHash(parse(dataset))===objectHash(manifest),409,'DATASET_SCOPE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run(review.manifest_key,c.strategy_id,manifest.revision,manifest.manifest_hash,'OPERATIONAL_MANIFEST',JSON.stringify(manifest));
      const registryRow=this.b.one('ow_strategies',c.strategy_id),registry=parse(registryRow),lineage=parse(this.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(decisions.STRATEGY_ONBOARDING));
      const executionInstances=[...registry.execution_instances.filter(value=>(value.execution_instance_id || value)!==instance.execution_instance_id),instance];
      const changed=registry.activation_status!=='ACTIVE' || registry.activation_decision_id!==lineage.source_decision_id || objectHash(registry.execution_instances)!==objectHash(executionInstances);
      if(changed){registry.activation_status='ACTIVE';registry.activation_decision_id=lineage.source_decision_id;registry.execution_instances=executionInstances;registry.registry_revision=registryRow.revision+1;this.b.validate('strategy-registry',registry);this.db.prepare('UPDATE ow_strategies SET revision=?,payload_json=? WHERE id=?').run(registry.registry_revision,JSON.stringify(registry),c.strategy_id);}
      const currentRegistry=this.b.one('ow_strategies',c.strategy_id),version={version_id:versionId,strategy_id:c.strategy_id,kind:'BASELINE',version:c.strategy_version,code_hash:c.strategy_code_hash,profile_key:currentRegistry.profile_id,artifact_id:null,case_id:null,registry_revision:currentRegistry.revision};
      const oldVersion=this.db.prepare('SELECT payload_json FROM ow_run_versions WHERE id=?').get(versionId);
      if(oldVersion)requireThat(objectHash(parse(oldVersion))===objectHash(version),409,'IMMUTABLE_VERSION_CONFLICT');else this.db.prepare('INSERT INTO ow_run_versions VALUES(?,?,?)').run(versionId,c.strategy_id,JSON.stringify(version));
      const permission={permission_id:permissionId,strategy_id:c.strategy_id,manifest_key:review.manifest_key,manifest_hash:manifest.manifest_hash,purposes:[c.evidence_purpose],expires_at_utc:review.expires_at_utc,prior_exposure:review.prior_exposure,test_only:false,review_hash:review.review_hash,decisions};
      const oldPermission=this.db.prepare('SELECT payload_json FROM ow_dataset_permissions WHERE id=?').get(permissionId);
      if(oldPermission)requireThat(objectHash(parse(oldPermission))===objectHash(permission),409,'IMMUTABLE_PERMISSION_CONFLICT');else this.db.prepare('INSERT INTO ow_dataset_permissions VALUES(?,?,?)').run(permissionId,c.strategy_id,JSON.stringify(permission));
      const receipt={schema_version:'ocean-operational-dataset-release/v1',release_id:receiptId,strategy_id:c.strategy_id,version_id:versionId,instance_id:c.execution_instance_id,permission_id:permissionId,manifest_key:review.manifest_key,manifest_hash:manifest.manifest_hash,review_hash:review.review_hash,decisions,released_by:actor.id,released_at_utc:new Date().toISOString(),run_created:false,run_release_granted:false,normal_ingestion:'OFF',live_real:'DISABLED'};
      this.db.prepare('INSERT INTO ow_operational_release_receipts VALUES(?,?,?,?,?)').run(receiptId,c.strategy_id,objectHash(receipt),JSON.stringify(receipt),receipt.released_at_utc);
      return {...receipt,idempotent:false};
    });
  }
  sourceObservation(source){
    const modern=this.db.prepare("SELECT actor_id,payload_json FROM ow_events WHERE entity_id=? AND action='operational.source-observed' ORDER BY id DESC LIMIT 1").get(source.run.id);
    if(modern){
      requireThat(modern.actor_id===source.plan.instance.telemetry_producer_id,409,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
      return;
    }
    // Older operational runs retained the validated activation, not a resolver
    // event. Recheck its frozen proof at event time; a new run still needs a fresh handshake.
    const legacy=this.db.prepare("SELECT entity_id,action,actor_id,actor_role,created_at_utc,payload_json FROM ow_events WHERE entity_id=? AND action='run-manager.activate' ORDER BY id DESC LIMIT 1").get(source.run.id);
    requireThat(legacy && legacy.actor_id===source.plan.instance.telemetry_producer_id && legacy.actor_role==='TELEMETRY',409,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
    let event;try{event=parse(legacy);}catch{requireThat(false,409,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');}
    requireThat(event?.schema_version===API_VERSION && event.namespace==='OPERATIONAL' && event.operational_action_allowed===true
      && ['entity_id','action','actor_id','actor_role','created_at_utc'].every(key=>event[key]===legacy[key]),409,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
    exactKeys(event.payload,['observed_handshake']);
    const h=event.payload.observed_handshake;exactKeys(h,['instance','source_state','plan_hash','context_hash']);
    this.b.validate('source-state',h.source_state);
    const observed=h.source_state,at=Date.parse(observed.observed_at_utc),recorded=Date.parse(legacy.created_at_utc);
    requireThat(h.instance && objectHash(h.instance)===objectHash(source.plan.instance)
      && h.plan_hash===source.plan.plan_hash && h.context_hash===source.context.context_hash
      && h.context_hash===source.plan.context_hash && source.context.run_id===source.run.id
      && observed.environment===source.context.expected_environment && observed.quality==='VERIFIED'
      && observed.simulation===true && observed.replay===(source.context.expected_environment==='REPLAY')
      && observed.account_alias===source.plan.instance.account_alias && observed.source_schema_version
      && Number.isFinite(at) && Number.isFinite(recorded) && recorded-at<=120000 && at-recorded<=5000,
      409,'SOURCE_HANDSHAKE_MISMATCH');
  }
  reprocess(actor,input){
    human(actor);
    exactKeys(input,['source_run_id','run_id','processing_id','expected_revision','confirmed','reason']);
    id(input.source_run_id);id(input.run_id);id(input.processing_id);
    requireThat(!input.source_run_id.startsWith('test-') && !input.run_id.startsWith('test-') && !input.processing_id.startsWith('test-'),403,'OPERATIONAL_REPROCESS_ID_REQUIRED');
    requireThat(input.confirmed===true && input.run_id!==input.source_run_id && typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'EXPLICIT_REPROCESS_CONFIRMATION_REQUIRED');
    const existing=this.db.prepare('SELECT context_json FROM ow_runs WHERE id=?').get(input.run_id);
    if(existing){
      const stored=parse(this.b.one('ow_run_plans',input.run_id));
      requireThat(stored.reprocess_of_run_id===input.source_run_id && stored.processing_id===input.processing_id,409,'IMMUTABLE_REPROCESS_CONFLICT');
      return {...this.b.runs.read(actor,input.run_id),idempotent:true};
    }
    const source=this.b.runs.load(actor,input.source_run_id,'read');this.b.expect(source.run,input.expected_revision);
    requireThat(source.run.state==='COMPLETED' && source.plan.operational_review && source.context.evidence_purpose==='HISTORICAL_BUILD',409,'ELIGIBLE_COMPLETED_OPERATIONAL_RUN_REQUIRED');
    this.b.runs.current(source.plan);
    const summary=this.b.runs.summary(source.run),completion=summary.completion,review=source.plan.operational_review;
    requireThat(summary.completion_current && completion?.status==='COMPLETED' && !completion.gaps.length && !completion.failures.length && summary.unresolved_records===0,409,'CURRENT_COMPLETE_SOURCE_RECEIPT_REQUIRED');
    requireThat(summary.progress && ['source_market','strategy_execution','processing_review'].every(axis=>!subtract([review.interval],summary.progress.axes[axis]).length),409,'THREE_AXIS_SOURCE_COVERAGE_REQUIRED');
    requireThat(!subtract([review.interval],completion.observed_coverage).length && !subtract(completion.observed_coverage,[review.interval]).length,409,'SOURCE_COVERAGE_MISMATCH');
    requireThat(!this.db.prepare('SELECT id FROM ow_run_leases WHERE id=?').get(input.source_run_id),409,'SOURCE_RUN_LEASE_STILL_PRESENT');
    this.sourceObservation(source);
    requireThat(!this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(source.run.instance_id),409,'INSTANCE_ALREADY_RESERVED');
    const processingConflict=this.db.prepare('SELECT id,payload_json FROM ow_run_plans').all().find(row=>parse(row).processing_id===input.processing_id);
    requireThat(!processingConflict,409,'PROCESSING_ID_ALREADY_USED');
    const sourceDecisions={};
    for(const scope of RELEASE_SCOPES){
      const decisionId=this.approved(review,scope),row=this.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(decisionId);
      sourceDecisions[scope]={id:decisionId,payload:parse(row)};
    }
    let context=structuredClone(source.context);
    context.run_id=input.run_id;context.revision=1;context.historical_build_mode='REPROCESS_EXISTING_HISTORY';
    context.observed_source_state={observed_at_utc:new Date().toISOString(),environment:'UNKNOWN',simulation:null,replay:null,account_alias:null,source_schema_version:null,quality:'UNKNOWN'};
    context.permission_reason='Explicit authenticated reprocessing of completed governed history; source handshake still required';
    context.context_hash=sealedHash(context,'context_hash');
    const nextReview=this.validateReview({context,manifest_key:review.manifest_key,factual_binding_hash:review.factual_binding_hash,interval:review.interval,prior_exposure:review.prior_exposure,expires_at_utc:review.expires_at_utc});
    context=nextReview.context;
    const sourceRecord=this.b.runs.managed(input.source_run_id),coverageKey=sourceRecord.coverage_key;
    const preCounts={source_run_id:input.source_run_id,source_run_revision:source.run.revision,source_processing_id:source.plan.processing_id || input.source_run_id,unique_canonical_trade_count:summary.unique_canonical_count,processing_event_count:summary.processing_count,no_trade_interval_count:completion.no_trade_interval_count,coverage_receipt_hash:objectHash(completion),coverage_key:coverageKey,producer_id:source.plan.instance.telemetry_producer_id};
    const decisions={};
    const createDecision=(scope,direct=false)=>{
      const sourceDecision=sourceDecisions[scope],decisionId=direct?`reprocess-run-release-${nextReview.review_hash.slice(7,31)}`:`reprocess-lineage-${scope.toLowerCase().replaceAll('_','-')}-${nextReview.review_hash.slice(7,31)}`;
      const decision={schema_version:'ocean-operational-decision/v1',decision_id:decisionId,scope,decision:'APPROVED',reason:direct?input.reason:`Preserved ${scope} authority for an exact governed reprocess of ${input.source_run_id}.`,review:nextReview,decided_by:direct?actor.id:'Wayne',decided_via:direct?'AUTHORISED_OCEAN_UI':'AUTHORISED_OCEAN_UI_LINEAGE',source_decision_id:sourceDecision.id,expires_at_utc:sourceDecision.payload.expires_at_utc,decided_at_utc:new Date().toISOString()};
      this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(decisionId,context.strategy_id,nextReview.review_hash,scope,JSON.stringify(decision));decisions[scope]=decisionId;
    };
    return this.b.store.transaction(()=>{
      createDecision('STRATEGY_ONBOARDING');createDecision('DATASET_RELEASE');createDecision('RUN_RELEASE',true);
      const permission={permission_id:input.run_id,strategy_id:context.strategy_id,manifest_key:nextReview.manifest_key,manifest_hash:nextReview.manifest_hash,purposes:[context.evidence_purpose],expires_at_utc:nextReview.expires_at_utc,prior_exposure:nextReview.prior_exposure,test_only:false,review:nextReview,decisions,reprocess_of_run_id:input.source_run_id};
      const plan={selection:{strategy_id:context.strategy_id,instance_id:context.execution_instance_id,purpose:context.evidence_purpose,permission_id:input.run_id,partition_index:nextReview.partition_index,interval:nextReview.interval,build_mode:'REPROCESS_EXISTING_HISTORY'},context_hash:context.context_hash,operational_review:nextReview,processing_id:input.processing_id,reprocess_of_run_id:input.source_run_id,canonical_identity_key:coverageKey,pre_reprocess_counts:preCounts};plan.plan_hash=objectHash(plan);
      this.db.prepare('INSERT INTO ow_dataset_permissions VALUES(?,?,?)').run(input.run_id,context.strategy_id,JSON.stringify(permission));
      this.db.prepare("INSERT INTO ow_runs VALUES(?,?,?,1,'READY',?)").run(input.run_id,context.strategy_id,context.execution_instance_id,JSON.stringify(context));
      this.db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(input.run_id,coverageKey,JSON.stringify(plan));
      this.db.prepare('INSERT INTO ow_operational_releases VALUES(?,?,?)').run(input.run_id,context.context_hash,JSON.stringify({decisions,actor_id:actor.id,observed_at_utc:new Date().toISOString(),reprocess_of_run_id:input.source_run_id,processing_id:input.processing_id}));
      this.b.event(input.run_id,'run-manager.reprocess',actor,{source_run_id:input.source_run_id,processing_id:input.processing_id,context_hash:context.context_hash,coverage_key:coverageKey,pre_reprocess_counts:preCounts,actual_source_start:false});
      return {...this.b.runs.read(actor,input.run_id),idempotent:false,original_run_unchanged:true,actual_source_start:false};
    });
  }
  abandonReprocess(actor,input){
    human(actor);
    exactKeys(input,['run_id','expected_revision','reason']);
    id(input.run_id);
    requireThat(typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'REASON_REQUIRED');
    const loaded=this.b.runs.load(actor,input.run_id,'read');this.b.expect(loaded.run,input.expected_revision);
    requireThat(loaded.run.state==='READY' && typeof loaded.plan.reprocess_of_run_id==='string',409,'UNSTARTED_REPROCESS_REQUIRED');
    const counts={
      leases:this.db.prepare('SELECT COUNT(*) n FROM ow_run_leases WHERE id=?').get(input.run_id).n,
      source_observations:this.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE entity_id=? AND action='operational.source-observed'").get(input.run_id).n,
      evidence:this.db.prepare('SELECT COUNT(*) n FROM ow_evidence_revisions WHERE run_id=?').get(input.run_id).n,
      progress:this.db.prepare('SELECT COUNT(*) n FROM ow_run_progress WHERE run_id=?').get(input.run_id).n,
      coverage:this.db.prepare('SELECT COUNT(*) n FROM ow_coverage_receipts WHERE run_id=?').get(input.run_id).n,
      pins:this.db.prepare('SELECT COUNT(*) n FROM ow_trade_pins WHERE run_id=?').get(input.run_id).n,
    };
    requireThat(Object.values(counts).every(value=>value===0),409,'REPROCESS_ALREADY_STARTED');
    return this.b.store.transaction(()=>{
      this.db.prepare("UPDATE ow_runs SET state='CANCELLED',revision=revision+1 WHERE id=?").run(input.run_id);
      this.b.event(input.run_id,'run-manager.reprocess-abandon',actor,{reason:input.reason,reprocess_of_run_id:loaded.plan.reprocess_of_run_id,processing_id:loaded.plan.processing_id,actual_source_start:false,prestart_counts:counts});
      return {...this.b.runs.read(actor,input.run_id),abandoned:true,actual_source_start:false};
    });
  }
  noNewCoverage(actor,input){
    human(actor);
    exactKeys(input,['decision_id','reprocess_run_id','expected_revision','confirmed','reason']);
    id(input.decision_id);id(input.reprocess_run_id);
    requireThat(!input.decision_id.startsWith('test-') && !input.reprocess_run_id.startsWith('test-'),403,'OPERATIONAL_NO_NEW_COVERAGE_ID_REQUIRED');
    requireThat(input.confirmed===true && typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'EXPLICIT_NO_NEW_COVERAGE_CONFIRMATION_REQUIRED');
    const reprocess=this.b.runs.load(actor,input.reprocess_run_id,'read');this.b.expect(reprocess.run,input.expected_revision);
    requireThat(reprocess.run.state==='COMPLETED' && typeof reprocess.plan.reprocess_of_run_id==='string' && reprocess.context.historical_build_mode==='REPROCESS_EXISTING_HISTORY',409,'COMPLETED_REPROCESS_REQUIRED');
    const source=this.b.runs.load(actor,reprocess.plan.reprocess_of_run_id,'read');
    requireThat(source.run.state==='COMPLETED' && source.context.evidence_purpose==='HISTORICAL_BUILD' && source.context.historical_build_mode==='ADD_MISSING_HISTORY',409,'COMPLETED_ADD_MISSING_HISTORY_SOURCE_REQUIRED');
    this.b.runs.current(source.plan);this.b.runs.current(reprocess.plan);
    const identityKeys=['strategy_id','strategy_version','strategy_code_hash','strategy_config_hash','execution_instance_id','source_installation_id','dataset_manifest_id','dataset_manifest_revision','dataset_manifest_hash','evidence_purpose','dataset_partition'];
    requireThat(identityKeys.every(key=>source.context[key]===reprocess.context[key]) && source.plan.coverage_key===reprocess.plan.coverage_key && objectHash(source.plan.operational_review.interval)===objectHash(reprocess.plan.operational_review.interval),409,'REPROCESS_LINEAGE_CHANGED');
    const complete=loaded=>{
      const summary=this.b.runs.summary(loaded.run);
      requireThat(summary.completion_current && summary.completion?.status==='COMPLETED' && !summary.completion.gaps.length && !summary.completion.failures.length && summary.unresolved_records===0 && summary.open_pins===0,409,'CURRENT_COMPLETE_COVERAGE_RECEIPT_REQUIRED');
      requireThat(summary.progress && ['source_market','strategy_execution','processing_review'].every(axis=>!subtract(loaded.plan.scored_intervals,summary.progress.axes[axis]).length),409,'THREE_AXIS_COVERAGE_REQUIRED');
      requireThat(!subtract(loaded.plan.scored_intervals,summary.completion.observed_coverage).length && !subtract(summary.completion.observed_coverage,loaded.plan.scored_intervals).length,409,'COMPLETION_COVERAGE_MISMATCH');
      requireThat(!this.db.prepare('SELECT id FROM ow_run_leases WHERE id=?').get(loaded.run.id),409,'TERMINAL_RUN_LEASE_PRESENT');
      return summary;
    };
    const sourceSummary=complete(source),reprocessSummary=complete(reprocess),review=source.plan.operational_review;
    const manifest=parse(this.b.one('ow_datasets',review.manifest_key));
    requireThat(manifest.manifest_hash===review.manifest_hash && sealedHash(manifest,'manifest_hash')===manifest.manifest_hash && manifest.quality_status==='VERIFIED' && !manifest.gaps.length,409,'MANIFEST_NOT_READY');
    const permitted=merge(manifest.partitions.filter(partition=>partition.partition==='DISCOVERY' && partition.coverage_status==='COMPLETE').map(partition=>interval({start_utc:partition.start_utc,end_utc:partition.end_utc})));
    requireThat(permitted.length>0,409,'NO_PERMITTED_DISCOVERY_INTERVAL');
    const protectedIntervals=merge([...manifest.protected_intervals,...manifest.partitions.filter(partition=>['VALIDATION','HOLDOUT'].includes(partition.partition)).map(partition=>({start_utc:partition.start_utc,end_utc:partition.end_utc}))]);
    requireThat(!intersect(permitted,protectedIntervals).length,403,'PROTECTED_HISTORY_OVERLAP');
    const rows=this.db.prepare("SELECT c.run_id,c.payload_json FROM ow_coverage_receipts c WHERE c.coverage_key=? AND c.status='COMPLETED' AND c.id=(SELECT MAX(newer.id) FROM ow_coverage_receipts newer WHERE newer.run_id=c.run_id)").all(source.plan.coverage_key);
    const current=rows.filter(row=>{
      const run=this.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(row.run_id);
      return run?.state==='COMPLETED' && this.b.runs.summary(run).completion_current;
    }).map(row=>({run_id:row.run_id,receipt:parse(row)}));
    const completedIntervals=merge(current.flatMap(row=>row.receipt.observed_coverage));
    const axes=Object.fromEntries(['source_market','strategy_execution','processing_review'].map(axis=>[axis,merge(current.flatMap(row=>row.receipt.axes?.[axis] || []))]));
    const missing=subtract(permitted,completedIntervals),axisMissing=Object.fromEntries(Object.entries(axes).map(([axis,values])=>[axis,subtract(permitted,values)]));
    requireThat(!missing.length && Object.values(axisMissing).every(values=>values.length===0),409,'NEW_DISCOVERY_COVERAGE_REQUIRED');
    requireThat(!this.db.prepare("SELECT r.id FROM ow_runs r JOIN ow_run_plans p ON p.id=r.id WHERE p.coverage_key=? AND r.state IN ('READY','ACTIVE','COMPLETING')").get(source.plan.coverage_key),409,'COVERAGE_RESERVATION_PRESENT');
    const reconciled={manifest_key:review.manifest_key,manifest_hash:manifest.manifest_hash,coverage_key:source.plan.coverage_key,permitted_discovery_intervals:permitted,completed_intervals:intersect(permitted,completedIntervals),coverage_axes:Object.fromEntries(Object.entries(axes).map(([axis,values])=>[axis,intersect(permitted,values)])),missing_intervals:missing,axis_missing:axisMissing,protected_overlap:intersect(permitted,protectedIntervals),completed_run_ids:current.map(row=>row.run_id).sort()};
    const base={schema_version:'ocean-operational-no-new-coverage/v1',decision_id:input.decision_id,scope:'NO_NEW_COVERAGE',decision:'APPROVED',outcome:'NO_NEW_COVERAGE',reason:input.reason.trim(),strategy_id:source.context.strategy_id,strategy_version:source.context.strategy_version,strategy_code_hash:source.context.strategy_code_hash,strategy_config_hash:source.context.strategy_config_hash,execution_instance_id:source.context.execution_instance_id,dataset_manifest_id:source.context.dataset_manifest_id,dataset_manifest_revision:source.context.dataset_manifest_revision,dataset_manifest_hash:source.context.dataset_manifest_hash,source_run_id:source.run.id,reprocess_run_id:reprocess.run.id,source_completion_hash:objectHash(sourceSummary.completion),reprocess_completion_hash:objectHash(reprocessSummary.completion),coverage:reconciled,coverage_hash:objectHash(reconciled),run_id:null,run_created:false,decided_by:actor.id,decided_via:'AUTHORISED_OCEAN_UI',normal_ingestion:'OFF',live_real:'DISABLED'};
    const old=this.db.prepare("SELECT payload_json FROM ow_operational_decisions WHERE id=? AND scope='NO_NEW_COVERAGE'").get(input.decision_id);
    if(old){const saved=parse(old),{decision_hash,decided_at_utc,...savedBase}=saved;requireThat(sealedHash(saved,'decision_hash')===decision_hash && objectHash(savedBase)===objectHash(base),409,'IMMUTABLE_NO_NEW_COVERAGE_CONFLICT');return {...saved,idempotent:true};}
    const decision={...base,decided_at_utc:new Date().toISOString()};decision.decision_hash=sealedHash(decision,'decision_hash');
    return this.b.store.transaction(()=>{
      this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(input.decision_id,source.context.strategy_id,review.review_hash,'NO_NEW_COVERAGE',JSON.stringify(decision));
      this.b.event(reprocess.run.id,'run-manager.no-new-coverage',actor,{decision_id:decision.decision_id,decision_hash:decision.decision_hash,coverage_hash:decision.coverage_hash,source_run_id:source.run.id,reprocess_run_id:reprocess.run.id,run_id:null,run_created:false,normal_ingestion:'OFF',live_real:'DISABLED',reason:decision.reason});
      return {...decision,idempotent:false};
    });
  }
  readNoNewCoverage(actor,decisionId){
    human(actor);id(decisionId);
    const row=this.db.prepare("SELECT payload_json FROM ow_operational_decisions WHERE id=? AND scope='NO_NEW_COVERAGE'").get(decisionId);
    requireThat(row,404,'NO_NEW_COVERAGE_DECISION_NOT_FOUND');
    const decision=parse(row);requireThat(sealedHash(decision,'decision_hash')===decision.decision_hash,409,'NO_NEW_COVERAGE_DECISION_CHANGED');
    return decision;
  }
  perform(action,actor,input){
    noSecrets(input,this.b.environment);
    if(action==='reviews')return this.review(actor,input);
    if(action==='release-requests')return this.request(actor,input);
    if(action==='dataset-releases')return this.release(actor,input);
    human(actor);
    if(action==='runs/reprocess')return this.reprocess(actor,input);
    if(action==='runs/reprocess/abandon')return this.abandonReprocess(actor,input);
    if(action==='runs/no-new-coverage')return this.noNewCoverage(actor,input);
    if(action==='decisions/revoke'){
      exactKeys(input,['decision_id','reason']);id(input.decision_id);requireThat(typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'REASON_REQUIRED');
      requireThat(this.db.prepare('SELECT id FROM ow_operational_decisions WHERE id=?').get(input.decision_id),404,'UNKNOWN_OPERATIONAL_DECISION');
      this.db.prepare('INSERT OR IGNORE INTO ow_operational_revocations VALUES(?,?)').run(input.decision_id,JSON.stringify({...input,actor_id:actor.id,at_utc:new Date().toISOString()}));return {revoked:true};
    }
    exactKeys(input,['review','review_hash',...(action==='decisions'?['decision_id','scope','decision','reason']:[])]);
    const review=this.review(actor,input.review);requireThat(review.review_hash===input.review_hash,409,'OPERATIONAL_REVIEW_CHANGED');
    if(action==='decisions'){
      id(input.decision_id);requireThat(!input.decision_id.startsWith('test-') && ['DATASET_RELEASE','RUN_RELEASE'].includes(input.scope) && ['APPROVED','REJECTED'].includes(input.decision) && typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'EXPLICIT_OPERATIONAL_DECISION_REQUIRED');
      const releaseRequest=this.db.prepare('SELECT id FROM ow_operational_release_requests WHERE id=?').get(`release-request:${review.review_hash.slice(7)}`);
      requireThat(releaseRequest,409,'PENDING_DATASET_RELEASE_REQUEST_REQUIRED');
      if(input.scope==='RUN_RELEASE'){
        requireThat(this.db.prepare('SELECT id FROM ow_operational_release_receipts WHERE id=?').get(`release-receipt:${review.review_hash.slice(7)}`),409,'OPERATIONAL_DATASET_RELEASE_REQUIRED');
        this.approved(review,'STRATEGY_ONBOARDING');this.approved(review,'DATASET_RELEASE');
        requireThat(!this.db.prepare('SELECT id FROM ow_runs WHERE id=?').get(review.context.run_id),409,'RUN_ALREADY_PREPARED');
      }
      const decision={schema_version:'ocean-operational-decision/v1',decision_id:input.decision_id,scope:input.scope,decision:input.decision,reason:input.reason,review,decided_by:actor.id,decided_via:'AUTHORISED_OCEAN_UI',expires_at_utc:review.expires_at_utc};
      const old=this.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(input.decision_id);
      if(old){const saved=parse(old),{decided_at_utc,...comparable}=saved;requireThat(objectHash(comparable)===objectHash(decision),409,'IMMUTABLE_DECISION_CONFLICT');return saved;}
      requireThat(!this.db.prepare('SELECT id FROM ow_operational_decisions WHERE review_hash=? AND scope=?').get(review.review_hash,input.scope),409,`${input.scope}_ALREADY_DECIDED`);
      decision.decided_at_utc=new Date().toISOString();
      this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(input.decision_id,review.context.strategy_id,review.review_hash,input.scope,JSON.stringify(decision));return decision;
    }
    requireThat(action==='runs/prepare',404,'UNKNOWN_OPERATIONAL_PREPARATION');
    const decisions=Object.fromEntries(RELEASE_SCOPES.map(s=>[s,this.approved(review,s)])),c=review.context;
    const binding=this.b.config.operational_factual_bindings.find(b=>b.binding_hash===review.factual_binding_hash),instance=binding.instance;
    const manifest=JSON.parse(parse(this.db.prepare('SELECT payload_json FROM ow_operational_pending WHERE id=?').get(review.manifest_key)).manifest_text);
    return this.b.store.transaction(()=>{
      const old=this.db.prepare('SELECT context_json FROM ow_runs WHERE id=?').get(c.run_id);
      if(old){requireThat(JSON.parse(old.context_json).context_hash===c.context_hash,409,'IMMUTABLE_RUN_CONFLICT');return {run_id:c.run_id,state:this.b.one('ow_runs',c.run_id).state,context:c,idempotent:true,actual_source_start:false};}
      this.b.runs.uniqueInstance(instance);
      requireThat(!this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(c.execution_instance_id),409,'INSTANCE_ALREADY_RESERVED');
      const existing=this.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(c.execution_instance_id);
      if(existing)requireThat(objectHash(parse(existing))===objectHash(instance),409,'FACTUAL_INSTANCE_CONFLICT');
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
