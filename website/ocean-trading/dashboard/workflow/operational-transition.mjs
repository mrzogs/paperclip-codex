import { digest, exactKeys, future, id, noSecrets, objectHash, requireThat, sealedHash, strategyId } from './common.mjs';
import { PURPOSES, interval, intersect, subtract } from './run-manager.mjs';
import { OperationalPreparation, RELEASE_SCOPES } from './operational-preparation.mjs';

export const OPERATIONAL_PREFIX='operational/v1';
export const operationalPolicy=(config={})=>({
  schema_version:'ocean-operational-transition/v1',shared_contract_release:'2.1.0',
  modes:Object.fromEntries(['REPLAY','PAPER_FORWARD'].map(mode=>[mode,{enabled:config.operational?.modes?.[mode]?.enabled===true}])),live_real:'DISABLED',
  normal_ingestion:'OFF',test_identity_promotion:false,machine_activation:false,
  separate_operational_enrollment_required:true,
  classification:PURPOSES.map(([environment,purpose,partition,permission])=>({environment,purpose,partition,permission})),
  required_authorities:['verified factual instance','strategy/profile/code/config pins','dataset manifest revision/hash and permission','genuine onboarding and dataset release','genuine per-run confirmation','pinned Run Context','compatible observed source handshake'],
  future_owners:{dataset_manifest:'S31.2',human_access:'S33.2',human_release:'S40.2',per_run:'S41.2',first_replay_enablement:'S42.2',paper_enablement:'S49.2/S50.2'},
});

// Pending source observations and proposed manifests are not executable registrations.
export class OperationalTransition {
  constructor(backend){this.b=backend;this.db=backend.db;}
  read(actor,receiptId=null){
    requireThat(actor.role==='HUMAN' || (actor.role==='TELEMETRY' && actor.namespace==='OPERATIONAL' && actor.scopes.includes('read')),403,'OPERATIONAL_READ_SCOPE_REQUIRED');
    if(receiptId){
      const row=this.db.prepare('SELECT producer_id,payload_json FROM ow_operational_receipts WHERE id=?').get(receiptId);
      requireThat(row,404,'UNKNOWN_OPERATIONAL_RECEIPT');const stored=JSON.parse(row.payload_json);
      requireThat(actor.role==='HUMAN' || (row.producer_id===actor.id && actor.strategyIds.includes(stored.event.strategy_id) && actor.instanceIds.includes(stored.event.execution_instance_id)),403,'OPERATIONAL_RECEIPT_SCOPE_CONFLICT');
      return stored.receipt;
    }
    return {schema_version:'ocean-operational-run-catalog/v1',items:this.db.prepare("SELECT * FROM ow_runs WHERE id NOT LIKE 'test-%'").all().filter(r=>actor.role==='HUMAN' || (actor.strategyIds.includes(r.strategy_id) && actor.instanceIds.includes(r.instance_id))).map(r=>({run_id:r.id,state:r.state,context:JSON.parse(r.context_json),release_recorded:Boolean(this.db.prepare('SELECT run_id FROM ow_operational_releases WHERE run_id=?').get(r.id)),actual_source_start:false}))};
  }
  pending(actor) {
    requireThat(actor.role==='HUMAN' || actor.scopes.includes('read'),403,'WRONG_ACTION_SCOPE');
    const rows=this.db.prepare('SELECT id,strategy_id,kind,content_hash,created_at_utc FROM ow_operational_pending ORDER BY id').all();
    return {schema_version:'ocean-operational-pending/v1',items:rows.filter(row=>actor.role==='HUMAN' || (row.strategy_id && actor.strategyIds.includes(row.strategy_id))),operational_enabled:false};
  }
  manifest(actor,input) {
    requireThat(actor.role==='BRAIN' && actor.scopes.includes('event.write'),403,'BRAIN_PROPOSAL_SCOPE_REQUIRED');
    exactKeys(input,['strategy_id','instance_id','manifest_text','source_member','source_task','source_bundle_sha256']);
    strategyId(input.strategy_id);id(input.instance_id,true);
    requireThat(actor.strategyIds.includes(input.strategy_id) && actor.instanceIds.includes(input.instance_id),403,'WRONG_PROPOSAL_SCOPE');
    requireThat(input.source_task==='S31.2',422,'DATASET_OWNER_RECEIPT_REQUIRED');
    const setup=this.db.prepare('SELECT payload_json FROM ow_setup_receipts WHERE id=?').get(input.source_task);
    requireThat(setup,409,'SEALED_DATASET_OWNER_RECEIPT_MISSING');
    const receipt=JSON.parse(setup.payload_json);
    requireThat(['PASS','VERIFIED_REUSE'].includes(receipt.status) && receipt.verified_bundle_sha256===input.source_bundle_sha256,409,'DATASET_OWNER_RECEIPT_CONFLICT');
    noSecrets(input,this.b.environment);
    requireThat(typeof input.manifest_text==='string' && receipt.verified_members?.[input.source_member]===digest(input.manifest_text).slice(7),409,'MANIFEST_MEMBER_PROVENANCE_CONFLICT');
    let m;try{m=JSON.parse(input.manifest_text);}catch{requireThat(false,422,'MANIFEST_JSON_REQUIRED');}
    this.b.validate('dataset-manifest',m);
    requireThat(sealedHash(m,'manifest_hash')===m.manifest_hash,422,'DATASET_HASH_CONFLICT');
    requireThat(!m.dataset_manifest_id.startsWith('test-') && m.partitions.every(p=>Date.parse(p.start_utc)<Date.parse(p.end_utc)),422,'OPERATIONAL_PROPOSAL_REQUIRED');
    const key=`${m.dataset_manifest_id}:${m.revision}`,hash=objectHash(input);
    return this.b.store.transaction(()=>{
      const previous=this.db.prepare('SELECT content_hash FROM ow_operational_pending WHERE id=?').get(key);
      if(previous)requireThat(previous.content_hash===hash,409,'IMMUTABLE_MANIFEST_CONFLICT');
      else {
        requireThat(this.db.prepare('SELECT COUNT(*) n FROM ow_operational_pending').get().n<256,429,'PENDING_CATALOG_CAPACITY');
        this.db.prepare('INSERT INTO ow_operational_pending VALUES(?,?,?,?,?,?)').run(key,input.strategy_id,'DATASET_MANIFEST',hash,JSON.stringify(input),new Date().toISOString());
      }
      return {id:key,idempotent:Boolean(previous),state:'PENDING_HUMAN_DATASET_RELEASE',runtime_eligible:false,learner_permission:'NONE'};
    });
  }
  perform(action,actor,input) {
    exactKeys(input,['environment','strategy_id','instance_id','run_id','context_hash','source_handshake',...(action==='events'?['event']:[])]);
    noSecrets(input,this.b.environment);
    requireThat(['REPLAY','PAPER_FORWARD'].includes(input.environment),403,'LIVE_REAL_DISABLED');
    requireThat(typeof input.instance_id==='string' && !input.instance_id.startsWith('test-'),403,'TEST_IDENTITY_PROMOTION_REJECTED');
    if(action==='activate')requireThat(actor.role==='HUMAN',403,'HUMAN_RELEASE_REQUIRED');
    else requireThat(actor.role==='TELEMETRY' && actor.namespace==='OPERATIONAL' && actor.audience==='Ocean workflow operational v1',403,'SEPARATE_OPERATIONAL_CREDENTIAL_REQUIRED');
    if(actor.role!=='HUMAN')requireThat(actor.strategyIds.includes(input.strategy_id) && actor.instanceIds.includes(input.instance_id) && actor.scopes.includes(action==='events'?'event.write':'read'),403,'OPERATIONAL_SCOPE_CONFLICT');
    const binding=this.b.config.operational_factual_bindings?.find(b=>b.strategy_id===input.strategy_id && b.instance.execution_instance_id===input.instance_id);
    requireThat(binding && (actor.role==='HUMAN' || actor.factualBindingHash===binding.binding_hash),409,'VERIFIED_FACTUAL_BINDING_REQUIRED');
    requireThat(sealedHash(binding,'binding_hash')===binding.binding_hash && binding.state==='VERIFIED_FACTS_ONLY',409,'FACTUAL_BINDING_HASH_CONFLICT');
    requireThat(actor.role==='HUMAN' || actor.id===binding.instance.telemetry_producer_id,403,'OBSERVED_PRODUCER_REQUIRED');
    const run=this.b.one('ow_runs',id(input.run_id));
    requireThat(!run.id.startsWith('test-') && run.strategy_id===input.strategy_id && run.instance_id===input.instance_id,409,'OPERATIONAL_RUN_REQUIRED');
    const context=JSON.parse(run.context_json);
    this.b.validate('run-context',context);
    requireThat(sealedHash(context,'context_hash')===context.context_hash && input.context_hash===context.context_hash && context.expected_environment===input.environment,409,'PINNED_CONTEXT_CONFLICT');
    requireThat(context.strategy_code_hash===binding.strategy_code_hash && context.strategy_config_hash===binding.instance.config_hash && context.source_installation_id===binding.instance.source_installation_id,409,'FACTUAL_CONTEXT_CONFLICT');
    const profile=JSON.parse(this.b.one('ow_profiles',`${context.strategy_profile_id}:${context.strategy_profile_version}`).payload_json);
    this.b.validate('strategy-profile',profile);
    requireThat(profile.strategy_id===context.strategy_id && profile.profile_hash===binding.profile_hash && sealedHash(profile,'profile_hash')===profile.profile_hash,409,'FACTUAL_PROFILE_CONFLICT');
    const plan=JSON.parse(this.b.one('ow_run_plans',run.id).payload_json);
    const permission=JSON.parse(this.b.one('ow_dataset_permissions',plan.selection.permission_id).payload_json);
    requireThat(permission.test_only===false && future(permission.expires_at_utc) && permission.strategy_id===context.strategy_id && permission.purposes.includes(context.evidence_purpose) && permission.manifest_hash===context.dataset_manifest_hash,403,'OPERATIONAL_DATASET_PERMISSION_REQUIRED');
    const dataset=this.b.one('ow_datasets',permission.manifest_key),manifest=JSON.parse(dataset.payload_json);
    requireThat(!manifest.dataset_manifest_id.startsWith('test-') && manifest.manifest_hash===context.dataset_manifest_hash && sealedHash(manifest,'manifest_hash')===manifest.manifest_hash,409,'OPERATIONAL_MANIFEST_CONFLICT');
    this.b.validate('dataset-manifest',manifest);
    const partition=manifest.partitions[plan.selection.partition_index];
    const rule=PURPOSES.find(r=>r[0]===context.expected_environment && r[1]===context.evidence_purpose && r[2]===context.dataset_partition);
    requireThat(rule && rule[3]===context.learner_permission && dataset.strategy_id===context.strategy_id && manifest.quality_status==='VERIFIED' && manifest.gaps.length===0 && partition?.coverage_status==='COMPLETE' && partition.partition===context.dataset_partition,403,'OPERATIONAL_DATASET_QUALITY_REQUIRED');
    requireThat(sealedHash(plan,'plan_hash')===plan.plan_hash && plan.context_hash===context.context_hash && plan.selection.strategy_id===context.strategy_id && plan.selection.instance_id===run.instance_id && plan.selection.purpose===context.evidence_purpose,409,'OPERATIONAL_PLAN_CONFLICT');
    const requested=interval(plan.selection.interval),bounds=interval({start_utc:partition.start_utc,end_utc:partition.end_utc});
    requireThat(!subtract([requested],[bounds]).length,403,'OPERATIONAL_INTERVAL_NOT_PERMITTED');
    if(['SCOPED_LEARNING','HISTORICAL_DISCOVERY','EVALUATE_ONLY'].includes(context.learner_permission))requireThat(!intersect([requested],manifest.protected_intervals).length,403,'PROTECTED_HISTORY_OVERLAP');
    const preparation=new OperationalPreparation(this.b),review=plan.operational_review;
    requireThat(review && review.context.context_hash===context.context_hash,409,'OPERATIONAL_REVIEW_REQUIRED');
    const current=preparation.validateReview(Object.fromEntries(['context','manifest_key','factual_binding_hash','interval','prior_exposure','expires_at_utc'].map(k=>[k,review[k]])));
    requireThat(current.review_hash===review.review_hash,409,'OPERATIONAL_REVIEW_CHANGED');
    const decisions=Object.fromEntries(RELEASE_SCOPES.map(scope=>[scope,preparation.approved(review,scope)]));
    this.b.validate('source-state',input.source_handshake?.source_state);
    const h=input.source_handshake,s=h.source_state;
    requireThat(objectHash(h.instance)===objectHash(binding.instance) && h.context_hash===context.context_hash && s.quality==='VERIFIED' && s.environment===context.expected_environment && s.simulation===true && s.replay===(context.expected_environment==='REPLAY') && s.account_alias===binding.instance.account_alias && s.source_schema_version && Date.now()-Date.parse(s.observed_at_utc)<=120000 && Date.parse(s.observed_at_utc)<=Date.now()+5000,409,'OPERATIONAL_SOURCE_HANDSHAKE_CONFLICT');
    requireThat(['READY','ACTIVE'].includes(run.state),409,'OPERATIONAL_RUN_NOT_RELEASED');
    if(action==='activate'){
      requireThat(actor.id==='wayne-ocean-ui',403,'WAYNE_BROWSER_ONLY');
      const old=this.db.prepare('SELECT context_hash FROM ow_operational_releases WHERE run_id=?').get(run.id);
      if(old)requireThat(old.context_hash===context.context_hash,409,'OPERATIONAL_RELEASE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_operational_releases VALUES(?,?,?)').run(run.id,context.context_hash,JSON.stringify({decisions,actor_id:actor.id,observed_at_utc:new Date().toISOString()}));
      return {run_id:run.id,release_valid:true,actual_source_start:false};
    }
    requireThat(this.db.prepare('SELECT context_hash FROM ow_operational_releases WHERE run_id=?').get(run.id)?.context_hash===context.context_hash,409,'OPERATIONAL_RELEASE_DISABLED');
    if(action==='context/resolve')return this.b.store.transaction(()=>{
      if(run.state==='READY'){
        this.db.prepare("UPDATE ow_runs SET state='ACTIVE',revision=revision+1 WHERE id=? AND state='READY'").run(run.id);
        this.b.event(run.id,'operational.source-observed',actor,{context_hash:context.context_hash,source_handshake:input.source_handshake});
      }
      return {schema_version:'ocean-operational-context/v1',context,state:'ACTIVE',actual_source_start:false,analysis_complete:false};
    });
    const event=input.event;this.b.validate('workflow-event',event);
    requireThat(!event.event_id.startsWith('test-') && event.producer_id===actor.id && event.actor_role===actor.role && event.strategy_id===context.strategy_id && event.execution_instance_id===run.instance_id && event.run_id===run.id && event.run_context_hash===context.context_hash && event.run_context_revision===context.revision,403,'OPERATIONAL_EVENT_SCOPE_CONFLICT');
    requireThat(['strategy_version','strategy_code_hash','strategy_config_hash','strategy_profile_id','strategy_profile_version','source_installation_id'].every(k=>event[k]===context[k]) && sealedHash(event,'payload_hash')===event.payload_hash,409,'OPERATIONAL_EVENT_PIN_CONFLICT');
    return this.b.store.transaction(()=>{
      const key=objectHash([actor.id,event.event_id]),hash=objectHash(event);
      const old=this.db.prepare('SELECT content_hash,payload_json FROM ow_operational_receipts WHERE id=?').get(key);
      if(old){requireThat(old.content_hash===hash,409,'OPERATIONAL_EVENT_CONFLICT');return JSON.parse(old.payload_json).receipt;}
      requireThat(this.db.prepare('SELECT COUNT(*) n FROM ow_operational_receipts').get().n<100000,429,'OPERATIONAL_RECEIPT_CAPACITY');
      const receipt={schema_version:'ocean-operational-receipt/v1',receipt_id:key,event_id:event.event_id,run_id:run.id,context_hash:context.context_hash,payload_hash:hash,persisted:true,analysis_complete:false,dispatch_state:'DISABLED'};
      this.db.prepare('INSERT INTO ow_operational_receipts VALUES(?,?,?,?,?,?)').run(key,actor.id,run.id,hash,JSON.stringify({event,receipt}),new Date().toISOString());
      return receipt;
    });
  }
}
