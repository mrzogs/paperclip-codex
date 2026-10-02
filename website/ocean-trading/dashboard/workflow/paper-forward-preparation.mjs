import {exactKeys,future,id,objectHash,requireThat,sealedHash} from './common.mjs';

const parse=row=>JSON.parse(row.payload_json);
const HUMAN_ID='wayne-ocean-ui';
const GAP='future interval incomplete';
const PURPOSE='LEARNING';
const PARTITION='FORWARD';
const ENVIRONMENT='PAPER_FORWARD';
const LEARNER_PERMISSION='SCOPED_LEARNING';
const SELECTION_KEYS=['run_id','strategy_id','version_id','instance_id','expected_environment','purpose','dataset_role','start_utc','end_utc'];

const human=actor=>requireThat(actor.role==='HUMAN' && actor.id===HUMAN_ID,403,'WAYNE_BROWSER_ONLY');
const utc=value=>requireThat(typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value,422,'UTC_TIMESTAMP_REQUIRED');

export class PaperForwardPreparation {
  constructor(backend){this.b=backend;this.db=backend.db;}
  prerequisites(actor){
    human(actor);
    const bindings=(this.b.config.operational_factual_bindings || []).filter(binding=>binding.state==='VERIFIED_FACTS_ONLY' && binding.operational_enabled===false && binding.instance.capabilities?.includes(ENVIRONMENT));
    requireThat(bindings.length===1,409,'UNAMBIGUOUS_PAPER_BINDING_REQUIRED');
    const binding=bindings[0];
    requireThat(sealedHash(binding,'binding_hash')===binding.binding_hash,409,'FACTUAL_BINDING_HASH_CONFLICT');
    const consumers=(this.b.config.identities || []).filter(identity=>identity.namespace==='OPERATIONAL' && identity.role==='TELEMETRY' && identity.factual_binding_hash===binding.binding_hash && identity.instance_ids?.length===1 && identity.instance_ids[0]===binding.instance.execution_instance_id && identity.strategy_ids?.length===1 && identity.strategy_ids[0]===binding.strategy_id && identity.scopes?.includes('read') && identity.revoked!==true && future(identity.expires_at_utc));
    requireThat(consumers.length===1,409,'CURRENT_PAPER_CONSUMER_BINDING_REQUIRED');
    const consumer=consumers[0];
    requireThat(/^[a-f0-9]{64}$/.test(consumer.owner_evidence_sha256 || ''),409,'PAPER_SOURCE_EVIDENCE_REQUIRED');
    const registry=this.b.one('ow_strategies',binding.strategy_id),registryPayload=parse(registry);
    const profile=this.b.one('ow_profiles',registry.profile_id),profilePayload=parse(profile);
    this.b.validate('strategy-profile',profilePayload);
    requireThat(registry.baseline_hash===binding.strategy_code_hash && registryPayload.baseline_version===binding.instance.version_binding && profilePayload.strategy_code_hash===binding.strategy_code_hash && profilePayload.strategy_config_hash===binding.instance.config_hash && profilePayload.baseline_version===binding.instance.version_binding && sealedHash(profilePayload,'profile_hash')===profilePayload.profile_hash,409,'FIXED_PAPER_BASELINE_REQUIRED');
    const versions=this.db.prepare('SELECT id,payload_json FROM ow_run_versions WHERE strategy_id=?').all(binding.strategy_id).map(row=>({id:row.id,...parse(row)})).filter(version=>version.kind==='BASELINE' && version.version===binding.instance.version_binding && version.code_hash===binding.strategy_code_hash && version.profile_key===registry.profile_id);
    requireThat(versions.length===1,409,'FIXED_PAPER_VERSION_REQUIRED');
    const historical=this.db.prepare('SELECT id,run_id,context_hash,payload_json FROM ow_operational_brain_results ORDER BY rowid DESC').all().map(row=>({...row,payload:parse(row)})).find(row=>row.payload.content?.includes('# S48.3 Historical Bootstrap Report') && row.payload.content?.includes('HISTORICAL_RECONCILIATION / NO_NEW_COVERAGE'));
    requireThat(historical,409,'COMPLETED_HISTORICAL_RECONCILIATION_REQUIRED');
    const callback=this.db.prepare('SELECT payload_json FROM ow_operational_brain_callbacks WHERE result_id=? ORDER BY rowid DESC LIMIT 1').get(historical.id);
    requireThat(callback && parse(callback).status==='COMPLETED',409,'COMPLETED_HISTORICAL_RECONCILIATION_REQUIRED');
    requireThat(this.b.config.live_real==='DISABLED' && this.b.config.brain_submission==='OFF',409,'SAFE_OPERATIONAL_MODE_REQUIRED');
    const busy=this.db.prepare("SELECT id,state FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(binding.instance.execution_instance_id);
    requireThat(!busy,409,'INSTANCE_ALREADY_RESERVED');
    return {binding,consumer,registry,registryPayload,profile,profilePayload,version:versions[0],historical:{result_id:historical.id,run_id:historical.run_id,context_hash:historical.context_hash,callback_status:'COMPLETED'}};
  }
  options(actor){
    const p=this.prerequisites(actor);
    return {schema_version:'ocean-paper-forward-options/v1',eligible:true,strategy:{strategy_id:p.binding.strategy_id,strategy_name:p.registryPayload.strategy_name},version:{version_id:p.version.id,version:p.version.version,code_hash:p.version.code_hash,config_hash:p.binding.instance.config_hash,profile_hash:p.profilePayload.profile_hash,observed_profile_hash:p.binding.profile_hash},instance:p.binding.instance,environment:ENVIRONMENT,purpose:PURPOSE,purpose_label:'Forward Learning',dataset_role:PARTITION,dataset_label:'Forward Data',learner_permission:LEARNER_PERMISSION,maximum_end_utc:new Date(p.consumer.expires_at_utc).toISOString(),source_handshake:'PENDING',historical_reconciliation:p.historical,normal_ingestion:'OFF',brain_submission:'OFF',live_real:'DISABLED'};
  }
  preview(actor,input){
    human(actor);exactKeys(input,['selection']);exactKeys(input.selection,SELECTION_KEYS);
    const p=this.prerequisites(actor),s=structuredClone(input.selection);
    id(s.run_id);requireThat(!s.run_id.startsWith('test-'),403,'OPERATIONAL_RUN_REQUIRED');
    requireThat(s.strategy_id===p.binding.strategy_id && s.version_id===p.version.id && s.instance_id===p.binding.instance.execution_instance_id && s.expected_environment===ENVIRONMENT && s.purpose===PURPOSE && s.dataset_role===PARTITION,403,'PAPER_FORWARD_SCOPE_CONFLICT');
    utc(s.start_utc);utc(s.end_utc);requireThat(Date.parse(s.start_utc)>=Date.now()-60000 && Date.parse(s.start_utc)<Date.parse(s.end_utc) && Date.parse(s.end_utc)<=Date.parse(p.consumer.expires_at_utc),422,'PAPER_FORWARD_INTERVAL_REJECTED');
    const manifest={schema_version:'2.1.0',dataset_manifest_id:`paper-forward-manifest:${s.run_id}`,revision:1,source_id:p.binding.instance.source_installation_id,source_revision:`sha256:${p.consumer.owner_evidence_sha256}`,created_at_utc:s.start_utc,timezone:'SOURCE_HANDSHAKE_PENDING',contract_rollover_policy:'SOURCE_HANDSHAKE_PENDING',adjustment_policy:'SOURCE_HANDSHAKE_PENDING',partitions:[{start_utc:s.start_utc,end_utc:s.end_utc,partition:PARTITION,symbol:p.profilePayload.instrument_scope[0],coverage_status:'PARTIAL'}],protected_intervals:[],content_hashes:[`sha256:${p.consumer.owner_evidence_sha256}`],quality_status:'PARTIAL',gaps:[GAP]};
    manifest.manifest_hash=sealedHash(manifest,'manifest_hash');this.b.validate('dataset-manifest',manifest);
    const context={schema_version:'2.1.0',run_id:s.run_id,revision:1,strategy_id:p.binding.strategy_id,strategy_version:p.binding.instance.version_binding,strategy_code_hash:p.binding.strategy_code_hash,strategy_config_hash:p.binding.instance.config_hash,strategy_profile_id:p.profilePayload.profile_id,strategy_profile_version:p.profilePayload.profile_version,execution_instance_id:p.binding.instance.execution_instance_id,source_installation_id:p.binding.instance.source_installation_id,expected_environment:ENVIRONMENT,observed_source_state:{observed_at_utc:s.start_utc,environment:'UNKNOWN',simulation:null,replay:null,account_alias:null,source_schema_version:null,quality:'UNKNOWN'},evidence_purpose:PURPOSE,dataset_manifest_id:manifest.dataset_manifest_id,dataset_manifest_revision:manifest.revision,dataset_manifest_hash:manifest.manifest_hash,dataset_partition:PARTITION,experiment_id:null,candidate_id:null,case_id:null,historical_build_mode:null,learner_permission:LEARNER_PERMISSION,permission_reason:'Authenticated Paper Forward reservation; actual source handshake is required before activation.'};
    context.context_hash=sealedHash(context,'context_hash');this.b.validate('run-context',context);
    const review={schema_version:'ocean-operational-review/v1',context,factual_binding_hash:p.binding.binding_hash,profile_hash:p.profilePayload.profile_hash,observed_profile_hash:p.binding.profile_hash,manifest_key:`${manifest.dataset_manifest_id}:${manifest.revision}`,manifest_hash:manifest.manifest_hash,partition_index:0,interval:{start_utc:s.start_utc,end_utc:s.end_utc},prior_exposure:'UNKNOWN',expires_at_utc:new Date(p.consumer.expires_at_utc).toISOString(),paper_forward:{source_handshake:'PENDING',manifest_quality:'PARTIAL',coverage_status:'PARTIAL',gap:GAP,historical_reconciliation:p.historical}};
    review.review_hash=objectHash(review);
    return {schema_version:'ocean-paper-forward-preview/v1',selection:s,review,manifest,instance:p.binding.instance,version:p.version,can_prepare:true,actual_source_start:false,state_after_confirmation:'READY',normal_ingestion:'OFF',brain_submission:'OFF',live_real:'DISABLED'};
  }
  prepare(actor,input){
    human(actor);exactKeys(input,['selection','review_hash','confirmed','reason']);
    requireThat(input.confirmed===true && typeof input.reason==='string' && input.reason.trim().length>0 && input.reason.length<=1000,422,'FRESH_PAPER_CONFIRMATION_REQUIRED');
    const preview=this.preview(actor,{selection:input.selection}),{review,manifest}=preview,c=review.context,s=preview.selection;
    requireThat(input.review_hash===review.review_hash,409,'PAPER_FORWARD_REVIEW_CHANGED');
    return this.b.store.transaction(()=>{
      const old=this.db.prepare('SELECT context_json,state FROM ow_runs WHERE id=?').get(c.run_id);
      if(old){requireThat(JSON.parse(old.context_json).context_hash===c.context_hash,409,'IMMUTABLE_RUN_CONFLICT');return {run_id:c.run_id,state:old.state,context:c,review_hash:review.review_hash,idempotent:true,actual_source_start:false,source_handshake:'PENDING'};}
      requireThat(!this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(c.execution_instance_id),409,'INSTANCE_ALREADY_RESERVED');
      const p=this.prerequisites(actor),instance=p.binding.instance;
      this.b.runs.uniqueInstance(instance);
      const existing=this.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(c.execution_instance_id);
      if(existing)requireThat(objectHash(parse(existing))===objectHash(instance),409,'FACTUAL_INSTANCE_CONFLICT');
      else this.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(c.execution_instance_id,c.strategy_id,JSON.stringify(instance));
      const pendingPayload={strategy_id:c.strategy_id,instance_id:c.execution_instance_id,manifest_text:JSON.stringify(manifest),source_member:'S49.3/generated-prospective-forward-manifest',source_task:'S49.3',source_bundle_sha256:p.consumer.owner_evidence_sha256};
      this.db.prepare('INSERT INTO ow_operational_pending VALUES(?,?,?,?,?,?)').run(review.manifest_key,c.strategy_id,'DATASET_MANIFEST',objectHash(pendingPayload),JSON.stringify(pendingPayload),manifest.created_at_utc);
      this.db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run(review.manifest_key,c.strategy_id,manifest.revision,manifest.manifest_hash,'OPERATIONAL_FORWARD_MANIFEST',JSON.stringify(manifest));
      const decisions={};
      for(const scope of ['STRATEGY_ONBOARDING','DATASET_RELEASE','RUN_RELEASE']){
        const decisionId=`paper-forward-${scope.toLowerCase().replaceAll('_','-')}:${c.run_id}`;
        const decision={schema_version:'ocean-operational-decision/v1',decision_id:decisionId,scope,decision:'APPROVED',reason:input.reason.trim(),review,decided_by:HUMAN_ID,decided_via:'AUTHORISED_OCEAN_UI',expires_at_utc:review.expires_at_utc,decided_at_utc:new Date().toISOString()};
        this.db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(decisionId,c.strategy_id,review.review_hash,scope,JSON.stringify(decision));decisions[scope]=decisionId;
      }
      const permission={permission_id:c.run_id,strategy_id:c.strategy_id,manifest_key:review.manifest_key,manifest_hash:manifest.manifest_hash,purposes:[PURPOSE],expires_at_utc:review.expires_at_utc,prior_exposure:'UNKNOWN',test_only:false,review,decisions,activation_state:'PENDING_SOURCE_HANDSHAKE'};
      this.db.prepare('INSERT INTO ow_dataset_permissions VALUES(?,?,?)').run(c.run_id,c.strategy_id,JSON.stringify(permission));
      const coverageIdentity={strategy_id:c.strategy_id,code_hash:c.strategy_code_hash,config_hash:c.strategy_config_hash,source_id:manifest.source_id,source_revision:manifest.source_revision,symbol:manifest.partitions[0].symbol,timezone:manifest.timezone,rollover:manifest.contract_rollover_policy,adjustment:manifest.adjustment_policy,instance_id:c.execution_instance_id};
      const plan={selection:{strategy_id:c.strategy_id,version_id:s.version_id,expected_environment:ENVIRONMENT,instance_id:c.execution_instance_id,purpose:PURPOSE,permission_id:c.run_id,partition_index:0,interval:review.interval,warmup_interval:null,build_mode:null,case_id:null,experiment_id:null},context_hash:c.context_hash,operational_review:review,coverage_identity:coverageIdentity,coverage_key:objectHash(coverageIdentity),scored_intervals:[review.interval],warmup_intervals:[],created_at_utc:manifest.created_at_utc};plan.plan_hash=objectHash(plan);
      this.db.prepare("INSERT INTO ow_runs VALUES(?,?,?,1,'READY',?)").run(c.run_id,c.strategy_id,c.execution_instance_id,JSON.stringify(c));
      this.db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(c.run_id,plan.coverage_key,JSON.stringify(plan));
      const event={schema_version:'ocean-workflow/v1',namespace:'OPERATIONAL',operational_action_allowed:true,entity_id:c.run_id,action:'paper-forward.prepare',actor_id:HUMAN_ID,actor_role:'HUMAN',created_at_utc:new Date().toISOString(),payload:{context_hash:c.context_hash,review_hash:review.review_hash,decisions,actual_source_start:false,source_handshake:'PENDING',normal_ingestion:'OFF',live_real:'DISABLED'}};
      this.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)').run(c.run_id,event.action,event.actor_id,event.actor_role,event.created_at_utc,JSON.stringify(event));
      return {run_id:c.run_id,state:'READY',context:c,review_hash:review.review_hash,decisions,idempotent:false,actual_source_start:false,operational_enabled:false,source_handshake:'PENDING',normal_ingestion:'OFF',brain_submission:'OFF',live_real:'DISABLED'};
    });
  }
}
