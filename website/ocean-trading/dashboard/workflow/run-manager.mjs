import { randomUUID } from 'node:crypto';
import { exactKeys, future, id, objectHash, requireThat, sealedHash } from './common.mjs';

export const RUN_API = 'ocean-run-manager/v1';
export const PURPOSES = [
  ['PAPER_FORWARD','LEARNING','FORWARD','SCOPED_LEARNING','Forward learning'],
  ['PAPER_FORWARD','SHADOW_FORWARD','FORWARD','FROZEN_EVALUATION','Frozen forward test'],
  ['REPLAY','HISTORICAL_BUILD','DISCOVERY','HISTORICAL_DISCOVERY','Historical build'],
  ['REPLAY','DEVELOPMENT_BACKTEST','DEVELOPMENT','EVALUATE_ONLY','Development backtest'],
  ['REPLAY','RESEARCH_EXPERIMENT','DEVELOPMENT','EVALUATE_ONLY','Research experiment'],
  ['REPLAY','VALIDATION','VALIDATION','FROZEN_EVALUATION','Validation'],
  ['REPLAY','PROTECTED_HOLDOUT','HOLDOUT','RESTRICTED_EVALUATOR','Protected holdout'],
];
const MODES = ['ADD_MISSING_HISTORY','REPROCESS_EXISTING_HISTORY','FILL_DATA_GAPS'];
const AXES = ['source_market','strategy_execution','processing_review'];
const SELECTION = ['strategy_id','version_id','expected_environment','instance_id','purpose','permission_id','partition_index','interval','warmup_interval','build_mode','case_id','experiment_id'];
const TERMINAL = ['COMPLETED','FAILED','CANCELLED'];
const parse = row => JSON.parse(row.payload_json);
const hash = value => requireThat(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value),422,'HASH_REQUIRED');
const bounded = value => requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 200,422,'BOUNDED_VALUE_REQUIRED');
const utc = value => requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19)===value.slice(0,19),422,'UTC_TIMESTAMP_REQUIRED');
export function interval(value) {
  exactKeys(value,['start_utc','end_utc']); utc(value.start_utc); utc(value.end_utc);
  requireThat(Date.parse(value.start_utc)<Date.parse(value.end_utc),422,'INVALID_INTERVAL');
  return {start_utc:new Date(value.start_utc).toISOString(),end_utc:new Date(value.end_utc).toISOString()};
}
export function merge(values) {
  const result=[];
  for(const v of values.map(interval).sort((a,b)=>a.start_utc.localeCompare(b.start_utc))) {
    const last=result.at(-1);
    if(last && v.start_utc<=last.end_utc) last.end_utc=last.end_utc>v.end_utc?last.end_utc:v.end_utc;
    else result.push({...v});
  }
  return result;
}
export function intersect(left,right) {
  return merge(left.flatMap(a=>right.flatMap(b=>{
    const start_utc=a.start_utc>b.start_utc?a.start_utc:b.start_utc;
    const end_utc=a.end_utc<b.end_utc?a.end_utc:b.end_utc;
    return start_utc<end_utc?[{start_utc,end_utc}]:[];
  })));
}
export function subtract(left,right) {
  let remaining=merge(left);
  for(const b of merge(right)) remaining=remaining.flatMap(a=>{
    if(b.end_utc<=a.start_utc || b.start_utc>=a.end_utc)return[a];
    return [...(a.start_utc<b.start_utc?[{start_utc:a.start_utc,end_utc:b.start_utc}]:[]),...(a.end_utc>b.end_utc?[{start_utc:b.end_utc,end_utc:a.end_utc}]:[])];
  });
  return remaining;
}
export function countNoTradeIntervals(observed,closeTimes,unresolved=0) {
  return unresolved?0:observed.filter(v=>!closeTimes.some(t=>v.start_utc<=t && t<v.end_utc)).length;
}

// This component writes only the separate workflow TEST store. No producer or Brain ingestion is enabled.
export class RunManager {
  constructor(backend) {this.b=backend;this.db=backend.db;this.leaseMs=30000;}
  human(actor) {requireThat(actor.role==='HUMAN',403,'WAYNE_BROWSER_ONLY');}
  managed(runId) {return this.db.prepare('SELECT * FROM ow_run_plans WHERE id=?').get(runId);}
  register(table,key,strategy,payload) {
    id(key,true);
    requireThat(!this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(key),409,'IMMUTABLE_REGISTRATION_CONFLICT');
    if(strategy)this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(key,strategy,JSON.stringify(payload));
    else this.db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(key,JSON.stringify(payload));
    return {id:key,namespace:'TEST',operational_action_allowed:false};
  }
  uniqueInstance(instance) {
    for(const row of this.db.prepare('SELECT payload_json FROM ow_instances').all()) {
      const other=parse(row);
      requireThat(instance.execution_instance_id===other.execution_instance_id || objectHash([instance.source_installation_id,instance.chartbook_id,instance.chart_id,instance.source_study_instance_id])!==objectHash([other.source_installation_id,other.chartbook_id,other.chart_id,other.source_study_instance_id]),409,'DUPLICATE_PHYSICAL_INSTANCE');
    }
  }
  perform(action,actor,data) {
    if(['version','settings','permission','preview','prepare','preset','end'].includes(action))this.human(actor);
    if(action==='version') {
      exactKeys(data,['version_id','strategy_id','kind','version','code_hash','profile_key','artifact_id','case_id']);
      requireThat(['BASELINE','CANDIDATE'].includes(data.kind),422,'INVALID_VERSION_KIND'); bounded(data.version);hash(data.code_hash);
      const registry=this.b.one('ow_strategies',data.strategy_id); const profile=parse(this.b.one('ow_profiles',data.profile_key));
      requireThat(profile.strategy_id===data.strategy_id && data.profile_key===registry.profile_id,409,'PROFILE_REGISTRY_MISMATCH');
      if(data.kind==='BASELINE')requireThat(!data.case_id && !data.artifact_id && data.code_hash===registry.baseline_hash && data.version===profile.baseline_version,409,'BASELINE_PROFILE_MISMATCH');
      else {
        const row=this.b.caseFor(actor,data.case_id,'read');this.b.baseline(row);
        const artifact=this.b.artifactFor(row,data.artifact_id,'CANDIDATE');
        requireThat(row.strategy_id===data.strategy_id && row.candidate_hash===data.code_hash && artifact.candidate_hash===data.code_hash,409,'CANDIDATE_BINDING_MISMATCH');
      }
      return this.register('ow_run_versions',data.version_id,data.strategy_id,{...data,registry_revision:registry.revision});
    }
    if(action==='settings') {
      exactKeys(data,['instance_id','chart_settings_hash','time_basis','session_calendar_revision','fill_model_version']);
      this.b.one('ow_instances',data.instance_id);hash(data.chart_settings_hash);for(const key of ['time_basis','session_calendar_revision','fill_model_version'])bounded(data[key]);
      return this.register('ow_run_settings',data.instance_id,null,data);
    }
    if(action==='permission') {
      exactKeys(data,['permission_id','strategy_id','manifest_key','manifest_hash','purposes','expires_at_utc','prior_exposure','test_only']);
      requireThat(data.test_only===true && future(data.expires_at_utc),403,'CURRENT_TEST_AUTHORIZATION_REQUIRED');
      const row=this.b.one('ow_datasets',data.manifest_key);const manifest=parse(row);
      requireThat(row.kind==='TEST_RUNTIME_MANIFEST' && row.strategy_id===data.strategy_id && row.content_hash===data.manifest_hash && manifest.quality_status==='VERIFIED',403,'APPROVED_RUNTIME_MANIFEST_REQUIRED');
      requireThat(Array.isArray(data.purposes) && data.purposes.length>0 && data.purposes.every(p=>PURPOSES.some(v=>v[1]===p)||p==='NOT_ELIGIBLE'),422,'INVALID_PURPOSE');
      requireThat(['UNTOUCHED','EXPOSED','UNKNOWN'].includes(data.prior_exposure),422,'EXPOSURE_REQUIRED');
      if(data.purposes.includes('PROTECTED_HOLDOUT'))requireThat(data.prior_exposure==='UNTOUCHED',403,'HOLDOUT_EXPOSURE_REJECTED');
      return this.register('ow_dataset_permissions',data.permission_id,data.strategy_id,data);
    }
    if(action==='preview') {exactKeys(data,['selection']);return this.preview(data.selection);}
    if(action==='preset') {
      exactKeys(data,['preset_id','name','selection']);bounded(data.name);this.preview(data.selection);
      return this.register('ow_run_presets',data.preset_id,null,{name:data.name,selection:data.selection});
    }
    if(action==='prepare')return this.prepare(actor,data);
    if(action==='end') {
      exactKeys(data,['run_id','expected_revision','outcome']);
      const {run}=this.load(actor,data.run_id,'read');this.b.expect(run,data.expected_revision);
      requireThat(['READY','ACTIVE'].includes(run.state) && ['COMPLETED','CANCELLED','FAILED'].includes(data.outcome),409,'RUN_END_REJECTED');
      this.db.prepare("UPDATE ow_runs SET state='COMPLETING',revision=revision+1 WHERE id=?").run(run.id);
      this.b.event(run.id,'run-manager.end',actor,{outcome:data.outcome});
      return this.read(actor,run.id);
    }
    return this.telemetry(action,actor,data);
  }
  versionsCurrent(version) {
    const registry=this.b.one('ow_strategies',version.strategy_id);
    requireThat(registry.revision===version.registry_revision && registry.profile_id===version.profile_key,409,'VERSION_RECONCILIATION_REQUIRED');
    if(version.kind==='BASELINE')requireThat(version.code_hash===registry.baseline_hash,409,'VERSION_RECONCILIATION_REQUIRED');
    else {const row=this.b.one('ow_cases',version.case_id);this.b.active(row);this.b.baseline(row);requireThat(row.candidate_hash===version.code_hash,409,'CANDIDATE_BINDING_MISMATCH');this.b.artifactFor(row,version.artifact_id,'CANDIDATE');}
  }
  preview(selection) {
    exactKeys(selection,SELECTION);
    const s={...selection,interval:interval(selection.interval),warmup_interval:selection.warmup_interval?interval(selection.warmup_interval):null};
    requireThat(['REPLAY','PAPER_FORWARD'].includes(s.expected_environment),403,'ENVIRONMENT_DISABLED');
    const version=parse(this.b.one('ow_run_versions',s.version_id));this.versionsCurrent(version);
    const instance=parse(this.b.one('ow_instances',s.instance_id));this.uniqueInstance(instance);
    const settings=parse(this.b.one('ow_run_settings',s.instance_id));
    requireThat(version.strategy_id===s.strategy_id && instance.strategy_id===s.strategy_id && instance.version_binding===version.version && instance.capabilities.includes(s.expected_environment),403,'VERSION_INSTANCE_SCOPE_MISMATCH');
    const permission=parse(this.b.one('ow_dataset_permissions',s.permission_id));
    requireThat(permission.strategy_id===s.strategy_id && permission.purposes.includes(s.purpose) && future(permission.expires_at_utc),403,'DATASET_PERMISSION_EXPIRED_OR_MISMATCH');
    const manifest=parse(this.b.one('ow_datasets',permission.manifest_key));
    requireThat(manifest.manifest_hash===permission.manifest_hash && sealedHash(manifest,'manifest_hash')===permission.manifest_hash && manifest.quality_status==='VERIFIED' && manifest.gaps.length===0,403,'MANIFEST_QUALITY_REJECTED');
    requireThat(Number.isInteger(s.partition_index),422,'PARTITION_REQUIRED');
    const partition=manifest.partitions[s.partition_index];requireThat(partition && partition.coverage_status==='COMPLETE',403,'PARTITION_NOT_COMPLETE');
    const declared=[interval({start_utc:partition.start_utc,end_utc:partition.end_utc})];
    requireThat(!subtract([s.interval],declared).length && (!s.warmup_interval || (!subtract([s.warmup_interval],declared).length && s.warmup_interval.end_utc<=s.interval.start_utc)),403,'INTERVAL_OUTSIDE_APPROVED_PARTITION');
    const rule=s.purpose==='NOT_ELIGIBLE'?[s.expected_environment,s.purpose,partition.partition,'NONE','No Brain learning']:PURPOSES.find(p=>p[0]===s.expected_environment && p[1]===s.purpose && p[2]===partition.partition);
    requireThat(rule,403,'PURPOSE_ROLE_COMBINATION_DENIED');
    requireThat(s.purpose==='HISTORICAL_BUILD'?MODES.includes(s.build_mode):s.build_mode===null,422,'BUILD_MODE_MISMATCH');
    let approval=null;
    if(['DEVELOPMENT_BACKTEST','RESEARCH_EXPERIMENT','VALIDATION','PROTECTED_HOLDOUT','SHADOW_FORWARD'].includes(s.purpose)) {
      id(s.experiment_id,true);const row=this.b.one('ow_cases',s.case_id);this.b.active(row);this.b.baseline(row);
      requireThat(version.kind==='CANDIDATE' && version.case_id===row.id && row.instance_id===s.instance_id && row.strategy_id===s.strategy_id && row.candidate_hash===version.code_hash,403,'EXPERIMENT_CANDIDATE_SCOPE_MISMATCH');
      const gate=s.purpose==='SHADOW_FORWARD'?'SHADOW':'DEVELOPMENT';
      const test={DEVELOPMENT_BACKTEST:'BACKTEST',RESEARCH_EXPERIMENT:'RESEARCH_EXPERIMENT',VALIDATION:'VALIDATION',PROTECTED_HOLDOUT:'OOS_HOLDOUT',SHADOW_FORWARD:'SHADOW_FORWARD'}[s.purpose];
      approval=this.b.approved(row,gate,null,null,test).decision.id;
      if(s.purpose==='PROTECTED_HOLDOUT')requireThat(permission.prior_exposure==='UNTOUCHED',403,'HOLDOUT_EXPOSURE_REJECTED');
    } else requireThat(!s.case_id && !s.experiment_id && version.kind==='BASELINE',403,'UNBOUND_CASE_OR_CANDIDATE');
    const {instance_id:settingsInstance,...executionSettings}=settings;
    const identity={strategy_id:s.strategy_id,code_hash:version.code_hash,config_hash:instance.config_hash,source_id:manifest.source_id,source_revision:manifest.source_revision,symbol:partition.symbol,timezone:manifest.timezone,rollover:manifest.contract_rollover_policy,adjustment:manifest.adjustment_policy,settings:executionSettings};
    const coverageKey=objectHash(identity);
    // Protection is source/symbol wide, including manifests registered by another strategy.
    const protectedIntervals=[];
    for(const row of this.db.prepare("SELECT payload_json FROM ow_datasets WHERE kind='TEST_RUNTIME_MANIFEST'").all()) {
      const m=parse(row);if(m.source_id!==manifest.source_id || !m.partitions.some(p=>p.symbol===partition.symbol))continue;
      protectedIntervals.push(...m.protected_intervals.map(interval),...m.partitions.filter(p=>['VALIDATION','HOLDOUT'].includes(p.partition)).map(p=>interval({start_utc:p.start_utc,end_utc:p.end_utc})));
    }
    const protectedOverlap=intersect([s.interval,...(s.warmup_interval?[s.warmup_interval]:[])],merge(protectedIntervals));
    requireThat(!['HISTORICAL_BUILD','LEARNING','RESEARCH_EXPERIMENT','DEVELOPMENT_BACKTEST'].includes(s.purpose) || !protectedOverlap.length,403,'PROTECTED_HISTORY_OVERLAP');
    const receipts=this.db.prepare('SELECT c.* FROM ow_coverage_receipts c WHERE coverage_key=? AND id=(SELECT MAX(id) FROM ow_coverage_receipts newer WHERE newer.run_id=c.run_id)').all(coverageKey);
    const completed=receipts.filter(row=>row.status==='COMPLETED' && this.summary(this.b.one('ow_runs',row.run_id)).completion_current).flatMap(row=>parse(row).observed_coverage);
    const covered=intersect([s.interval],merge(completed));const missing=subtract([s.interval],covered);
    const axisCoverage=Object.fromEntries(AXES.map(k=>[k,intersect([s.interval],merge(receipts.flatMap(row=>parse(row).axes[k])))]));
    const knownGaps=[...new Set(receipts.flatMap(row=>parse(row).gaps))];
    const scored=s.build_mode==='ADD_MISSING_HISTORY'?missing:[s.interval];
    const reservations=this.db.prepare("SELECT p.id,p.payload_json FROM ow_run_plans p JOIN ow_runs r ON r.id=p.id WHERE r.state IN ('READY','ACTIVE','COMPLETING') AND p.coverage_key=?").all(coverageKey);
    const conflicts=reservations.filter(row=>intersect(scored,parse(row).scored_intervals).length).map(row=>row.id);
    const instanceBusy=this.db.prepare("SELECT id FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(s.instance_id)?.id || null;
    const result={api_version:RUN_API,namespace:'TEST',actual_ingestion:'OFF',selection:s,version,instance,manifest_hash:manifest.manifest_hash,manifest_key:permission.manifest_key,partition:partition.partition,symbol:partition.symbol,learner_permission:rule[3],approval_id:approval,permission_expires:permission.expires_at_utc,coverage_identity:identity,coverage_key:coverageKey,requested:[s.interval],already_covered:covered,missing,axes_observed:axisCoverage,known_gaps:knownGaps,protected:protectedOverlap,scored_intervals:scored,warmup_intervals:s.warmup_interval?[s.warmup_interval]:[],conflicting_runs:conflicts,instance_busy:instanceBusy,can_prepare:scored.length>0 && !conflicts.length && !instanceBusy,lease_policy:{duration_ms:this.leaseMs,expiry_releases_instance:false}};
    result.review_hash=objectHash(result);return result;
  }
  prepare(actor,data) {
    exactKeys(data,['run_id','selection','review_hash','confirmed']);id(data.run_id,true);
    requireThat(data.confirmed===true,422,'FRESH_CONFIRMATION_REQUIRED');
    const plan=this.preview(data.selection);
    requireThat(plan.review_hash===data.review_hash,409,'REVIEW_CHANGED');
    requireThat(plan.can_prepare,409,plan.instance_busy?'INSTANCE_ALREADY_RESERVED':plan.conflicting_runs.length?'COVERAGE_RESERVED':'NO_NEW_EVIDENCE');
    const profile=parse(this.b.one('ow_profiles',plan.version.profile_key));const m=parse(this.b.one('ow_datasets',plan.manifest_key));
    const s=plan.selection;
    const context={schema_version:'2.1.0',run_id:data.run_id,revision:1,strategy_id:s.strategy_id,strategy_version:plan.version.version,strategy_code_hash:plan.version.code_hash,strategy_config_hash:plan.instance.config_hash,strategy_profile_id:profile.profile_id,strategy_profile_version:profile.profile_version,execution_instance_id:s.instance_id,source_installation_id:plan.instance.source_installation_id,expected_environment:s.expected_environment,observed_source_state:{observed_at_utc:new Date().toISOString(),environment:'UNKNOWN',simulation:null,replay:null,account_alias:null,source_schema_version:null,quality:'UNKNOWN'},evidence_purpose:s.purpose,dataset_manifest_id:m.dataset_manifest_id,dataset_manifest_revision:m.revision,dataset_manifest_hash:m.manifest_hash,dataset_partition:plan.partition,experiment_id:s.experiment_id||null,candidate_id:plan.version.kind==='CANDIDATE'?plan.version.artifact_id:null,case_id:s.case_id||null,historical_build_mode:s.build_mode,learner_permission:plan.learner_permission,permission_reason:'TEST policy simulation only; actual ingestion and Brain submission OFF'};
    context.context_hash=sealedHash(context,'context_hash');this.b.validate('run-context',context);
    plan.run_id=data.run_id;plan.context_hash=context.context_hash;plan.created_at_utc=new Date().toISOString();plan.plan_hash=objectHash(plan);
    this.db.prepare("INSERT INTO ow_runs VALUES(?,?,?,1,'READY',?)").run(data.run_id,s.strategy_id,s.instance_id,JSON.stringify(context));
    this.db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(data.run_id,plan.coverage_key,JSON.stringify(plan));
    this.b.event(data.run_id,'run-manager.prepare',actor,{context_hash:context.context_hash,plan_hash:plan.plan_hash,actual_sierra_start:false});
    return this.read(actor,data.run_id);
  }
  load(actor,runId,scope='read') {
    const run=this.b.one('ow_runs',runId);this.b.authorize(actor,scope,run.strategy_id,run.instance_id);
    const record=this.managed(runId);requireThat(record,409,'MANAGED_RUN_REQUIRED');const plan=parse(record);
    requireThat(sealedHash(plan,'plan_hash')===plan.plan_hash,409,'RUN_PLAN_HASH_MISMATCH');
    return {run,plan,context:JSON.parse(run.context_json)};
  }
  current(plan) {
    const fresh=this.preview(plan.selection);
    requireThat(fresh.approval_id===plan.approval_id && fresh.coverage_key===plan.coverage_key && fresh.manifest_hash===plan.manifest_hash,409,'RUN_AUTHORITY_CHANGED');
  }
  lease(actor,data,run) {
    const lease=this.db.prepare('SELECT * FROM ow_run_leases WHERE id=?').get(run.id);
    requireThat(lease && lease.owner_id===actor.id && lease.lease_id===data.lease_id && lease.expires_ms>Date.now(),409,'STALE_OR_FOREIGN_RUN_LEASE');return lease;
  }
  telemetry(action,actor,data) {
    const allowed={claim:['run_id','expected_revision'],renew:['run_id','lease_id'],activate:['run_id','lease_id','expected_revision','observed_handshake'],pin:['run_id','lease_id','trade_id','state','context_hash'],progress:['run_id','lease_id','axes','watermark','pending_events','gaps','failures'],evidence:['run_id','lease_id','event_id','legacy_trade_id','trade_id','symbol','entry_time_utc','exit_time_utc','side','entry_order_key','exit_order_key','market_event_keys','facts'],finish:['run_id','lease_id','expected_revision']};
    requireThat(allowed[action],404,'UNKNOWN_RUN_ACTION');exactKeys(data,allowed[action]);
    requireThat(actor.role==='TELEMETRY',403,'OBSERVED_PRODUCER_REQUIRED');
    const {run,plan,context}=this.load(actor,data.run_id,'event.write');
    requireThat(plan.instance.telemetry_producer_id===actor.id,403,'WRONG_TELEMETRY_PRODUCER');
    const terminal=TERMINAL.includes(run.state);
    requireThat(!terminal || ['claim','renew','evidence','progress','finish'].includes(action),409,'RUN_TERMINAL');
    if(action==='claim') {
      this.b.expect(run,data.expected_revision);if(run.state==='READY')this.current(plan);
      const old=this.db.prepare('SELECT * FROM ow_run_leases WHERE id=?').get(run.id);
      requireThat(!old || old.expires_ms<=Date.now(),409,'RUN_ALREADY_LEASED');
      const leaseId=randomUUID();const now=new Date().toISOString();
      this.db.prepare('INSERT INTO ow_run_leases VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lease_id=excluded.lease_id,owner_id=excluded.owner_id,expires_ms=excluded.expires_ms,heartbeat_utc=excluded.heartbeat_utc').run(run.id,leaseId,actor.id,Date.now()+this.leaseMs,now);
      this.b.event(run.id,'run-manager.claim',actor,{lease_id:leaseId});return {run_id:run.id,lease_id:leaseId,expires_ms:Date.now()+this.leaseMs,context_hash:context.context_hash};
    }
    this.lease(actor,data,run);
    if(action==='activate' || (action==='renew' && run.state==='READY'))this.current(plan);
    if(action==='renew') {
      this.db.prepare('UPDATE ow_run_leases SET expires_ms=?,heartbeat_utc=? WHERE id=?').run(Date.now()+this.leaseMs,new Date().toISOString(),run.id);return this.read(actor,run.id);
    }
    if(action==='activate') {
      this.b.expect(run,data.expected_revision);requireThat(run.state==='READY',409,'INVALID_RUN_TRANSITION');
      exactKeys(data.observed_handshake,['instance','source_state','plan_hash','context_hash']);
      const h=data.observed_handshake;this.b.validate('source-state',h.source_state);const observed=h.source_state;
      requireThat(objectHash(h.instance)===objectHash(plan.instance) && h.plan_hash===plan.plan_hash && h.context_hash===context.context_hash && observed.environment===context.expected_environment && observed.quality==='VERIFIED' && observed.simulation===true && observed.replay===(context.expected_environment==='REPLAY') && observed.account_alias===plan.instance.account_alias && observed.source_schema_version && Date.now()-Date.parse(observed.observed_at_utc)<=120000 && Date.parse(observed.observed_at_utc)<=Date.now()+5000,409,'SOURCE_HANDSHAKE_MISMATCH');
      this.db.prepare("UPDATE ow_runs SET state='ACTIVE',revision=revision+1 WHERE id=?").run(run.id);this.b.event(run.id,'run-manager.activate',actor,{observed_handshake:h});return this.read(actor,run.id);
    }
    requireThat(['ACTIVE','COMPLETING'].includes(run.state) || terminal,409,'RUN_NOT_ACTIVE');
    if(action==='pin') {
      id(data.trade_id);requireThat(data.context_hash===context.context_hash && ['OPEN','CLOSED'].includes(data.state),409,'PIN_CONTEXT_MISMATCH');
      const old=this.db.prepare('SELECT * FROM ow_trade_pins WHERE run_id=? AND id=?').get(run.id,data.trade_id);
      if(data.state==='OPEN') {this.current(plan);requireThat(run.state==='ACTIVE' && !old,409,'NEW_TRADE_NOT_ALLOWED');this.db.prepare("INSERT INTO ow_trade_pins VALUES(?,?,?,'OPEN')").run(data.trade_id,run.id,context.context_hash);}
      else {requireThat(old?.state==='OPEN',409,'OPEN_PIN_REQUIRED');this.db.prepare("UPDATE ow_trade_pins SET state='CLOSED' WHERE run_id=? AND id=?").run(run.id,data.trade_id);}
      this.b.event(run.id,'run-manager.pin',actor,{trade_id:data.trade_id,state:data.state,context_hash:context.context_hash});return this.read(actor,run.id);
    }
    if(action==='progress') {
      exactKeys(data.axes,AXES);requireThat(AXES.every(k=>Array.isArray(data.axes[k])&&data.axes[k].length<=1000),422,'THREE_COVERAGE_AXES_REQUIRED');
      const axes=Object.fromEntries(AXES.map(k=>[k,merge(data.axes[k])]));
      const activated=this.db.prepare("SELECT id FROM ow_events WHERE entity_id=? AND action='run-manager.activate' LIMIT 1").get(run.id);
      requireThat(activated || AXES.every(k=>axes[k].length===0),409,'OBSERVED_ACTIVATION_REQUIRED');
      const earlier=this.db.prepare('SELECT payload_json FROM ow_run_progress WHERE run_id=? ORDER BY id DESC LIMIT 1').get(run.id);
      if(earlier && TERMINAL.includes(run.state)) {
        const previous=parse(earlier);requireThat(AXES.every(k=>!subtract(previous.axes[k],axes[k]).length),409,'COMPLETED_COVERAGE_CANNOT_REGRESS');
      }
      for(const values of Object.values(axes)) requireThat(!subtract(values,plan.scored_intervals).length,422,'PROGRESS_OUTSIDE_SCORED_INTERVAL');
      if(data.watermark!==null) {utc(data.watermark);requireThat(Date.parse(data.watermark)>=Date.parse(plan.scored_intervals[0].start_utc) && Date.parse(data.watermark)<=Date.parse(plan.scored_intervals.at(-1).end_utc),422,'WATERMARK_OUTSIDE_RUN');}
      requireThat(Number.isInteger(data.pending_events)&&data.pending_events>=0 && Array.isArray(data.gaps)&&data.gaps.every(g=>typeof g==='string'&&g.length<=200) && Array.isArray(data.failures)&&data.failures.every(f=>typeof f==='string'&&f.length<=200),422,'PROGRESS_QUALITY_REQUIRED');
      this.db.prepare('INSERT INTO ow_run_progress(run_id,payload_json) VALUES(?,?)').run(run.id,JSON.stringify({...data,axes,observed_at_utc:new Date().toISOString()}));return this.read(actor,run.id);
    }
    if(action==='evidence')return this.evidence(run,plan,context,data);
    this.b.expect(run,data.expected_revision);requireThat(run.state==='COMPLETING' || terminal,409,'END_AND_DRAIN_REQUIRED');
    const summary=this.summary(run,plan);
    requireThat(summary.progress && summary.open_pins===0 && summary.progress.pending_events===0,409,'RUN_NOT_DRAINED');
    const ending=this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action='run-manager.end' ORDER BY id DESC LIMIT 1").get(run.id);
    const status=terminal?run.state:parse(ending).payload.outcome;
    const observed=AXES.reduce((v,k)=>intersect(v,summary.progress.axes[k]),plan.scored_intervals);
    if(status==='COMPLETED') requireThat(!subtract(plan.scored_intervals,observed).length && !summary.progress.gaps.length && !summary.progress.failures.length && summary.unresolved_records===0 && summary.progress.watermark && Date.parse(summary.progress.watermark)>=Date.parse(plan.scored_intervals.at(-1).end_utc),409,'COVERAGE_INCOMPLETE');
    const start=this.db.prepare("SELECT created_at_utc FROM ow_events WHERE entity_id=? AND action='run-manager.activate' ORDER BY id LIMIT 1").get(run.id);
    requireThat(status!=='COMPLETED'||start,409,'OBSERVED_ACTIVATION_REQUIRED');
    const closeTimes=this.db.prepare('SELECT payload_json FROM ow_evidence_revisions WHERE run_id=?').all(run.id).map(row=>parse(row).provenance.exit_time_utc);
    const completion={schema_version:'2.1.0',run_id:run.id,run_context_revision:context.revision,run_context_hash:context.context_hash,status,requested_coverage:plan.scored_intervals,observed_coverage:observed,watermark:summary.progress.watermark,unique_canonical_trade_count:summary.unique_canonical_count,processing_event_count:summary.processing_count,no_trade_interval_count:countNoTradeIntervals(observed,closeTimes,summary.unresolved_records),gaps:summary.progress.gaps,failures:summary.progress.failures.map(reason=>({code:'UNKNOWN',message:reason,retryable:false,quarantine_id:null})),dataset_manifest_hash:context.dataset_manifest_hash,started_at_utc:start?.created_at_utc||plan.created_at_utc,completed_at_utc:new Date().toISOString()};
    this.b.validate('run-completion',completion);
    this.db.prepare('INSERT INTO ow_coverage_receipts(run_id,coverage_key,status,payload_json) VALUES(?,?,?,?)').run(run.id,plan.coverage_key,status,JSON.stringify({...completion,axes:summary.progress.axes,plan_hash:plan.plan_hash}));
    this.db.prepare('UPDATE ow_runs SET state=?,revision=revision+1 WHERE id=?').run(status,run.id);this.db.prepare('DELETE FROM ow_run_leases WHERE id=?').run(run.id);
    this.b.event(run.id,'run-manager.finish',actor,{completion});return this.read(actor,run.id);
  }
  evidence(run,plan,context,data) {
    id(data.event_id);id(data.legacy_trade_id);id(data.trade_id);bounded(data.symbol);utc(data.entry_time_utc);utc(data.exit_time_utc);
    requireThat(Date.parse(data.entry_time_utc)<=Date.parse(data.exit_time_utc) && ['LONG','SHORT'].includes(data.side) && data.symbol===plan.symbol,422,'INVALID_TRADE_PROVENANCE');
    const close=new Date(data.exit_time_utc).toISOString();requireThat(plan.scored_intervals.some(v=>v.start_utc<=close && close<v.end_utc),403,'UNSCORED_EVIDENCE');
    data={...data,entry_time_utc:new Date(data.entry_time_utc).toISOString(),exit_time_utc:close};
    const pin=this.db.prepare('SELECT * FROM ow_trade_pins WHERE run_id=? AND id=?').get(run.id,data.trade_id);requireThat(pin && pin.context_hash===context.context_hash,409,'PINNED_CONTEXT_REQUIRED');
    exactKeys(data.facts,['entry_price','exit_price','quantity','pnl','screenshot_hash','analysis_hash']);
    for(const [key,value] of Object.entries(data.facts)) key.endsWith('_hash')?hash(value):requireThat(typeof value==='number'&&Number.isFinite(value),422,'FINITE_FACT_REQUIRED');
    requireThat(Array.isArray(data.market_event_keys)&&data.market_event_keys.length<=100,422,'MARKET_EVENT_KEYS_REQUIRED');for(const value of data.market_event_keys)bounded(value);
    const resolved=data.market_event_keys.length>0 && typeof data.entry_order_key==='string' && data.entry_order_key.length>0 && typeof data.exit_order_key==='string' && data.exit_order_key.length>0;
    const marketId=resolved?objectHash({source:plan.coverage_identity.source_id,revision:plan.coverage_identity.source_revision,symbol:data.symbol,events:[...new Set(data.market_event_keys)].sort()}):null;
    if(resolved){bounded(data.entry_order_key);bounded(data.exit_order_key);}
    const canonicalId=resolved?objectHash({coverage_key:plan.coverage_key,market_id:marketId,entry_order:data.entry_order_key,exit_order:data.exit_order_key,entry:data.entry_time_utc,exit:data.exit_time_utc,side:data.side}):null;
    const payload={legacy_trade_id:data.legacy_trade_id,trade_id:data.trade_id,context_hash:context.context_hash,market_id:marketId,canonical_id:canonicalId,provenance:{symbol:data.symbol,entry_time_utc:data.entry_time_utc,exit_time_utc:data.exit_time_utc,side:data.side,entry_order_key:data.entry_order_key,exit_order_key:data.exit_order_key,market_event_keys:data.market_event_keys},facts:data.facts,match_confidence:resolved?'EXACT_IMMUTABLE_PROVENANCE':'UNRESOLVED',store:context.learner_permission==='HISTORICAL_DISCOVERY'||context.learner_permission==='SCOPED_LEARNING'?'LEARNING_CATALOGUE':context.learner_permission==='NONE'?'DIAGNOSTICS':'EVALUATION',dataset_partition:context.dataset_partition};
    const previousEvent=this.db.prepare('SELECT payload_json FROM ow_evidence_revisions WHERE run_id=? AND event_id=?').get(run.id,data.event_id);
    if(previousEvent) {const p=parse(previousEvent);requireThat(objectHash({...p,conflicting_fields:undefined})===objectHash({...payload,conflicting_fields:undefined}),409,'EVIDENCE_EVENT_CONFLICT');return p;}
    const previous=canonicalId?this.db.prepare('SELECT payload_json FROM ow_evidence_revisions WHERE canonical_id=?').all(canonicalId).map(parse):[];
    payload.conflicting_fields=[...new Set(previous.flatMap(p=>Object.keys(data.facts).filter(key=>key in p.facts && p.facts[key]!==data.facts[key])))];
    this.db.prepare('INSERT INTO ow_evidence_revisions(run_id,event_id,canonical_id,market_id,payload_json) VALUES(?,?,?,?,?)').run(run.id,data.event_id,canonicalId,marketId,JSON.stringify(payload));return payload;
  }
  summary(run) {
    const progress=this.db.prepare('SELECT payload_json FROM ow_run_progress WHERE run_id=? ORDER BY id DESC LIMIT 1').get(run.id);
    const evidence=this.db.prepare('SELECT canonical_id,market_id,payload_json FROM ow_evidence_revisions WHERE run_id=?').all(run.id);
    const complete=this.db.prepare('SELECT payload_json FROM ow_coverage_receipts WHERE run_id=? ORDER BY id DESC LIMIT 1').get(run.id);
    const missingPins=this.db.prepare("SELECT id FROM ow_trade_pins WHERE run_id=? AND state='CLOSED'").all(run.id).filter(pin=>!evidence.some(e=>parse(e).trade_id===pin.id)).length;
    const unresolved=missingPins+evidence.filter(r=>!r.canonical_id || parse(r).conflicting_fields.length>0).length;
    const completion=complete?parse(complete):null;
    const current=!!completion && completion.processing_event_count===evidence.length && unresolved===0 && (!progress || parse(progress).observed_at_utc<=completion.completed_at_utc);
    return {progress:progress?parse(progress):null,open_pins:this.db.prepare("SELECT COUNT(*) AS n FROM ow_trade_pins WHERE run_id=? AND state='OPEN'").get(run.id).n,unique_canonical_count:new Set(evidence.map(r=>r.canonical_id).filter(Boolean)).size,unique_market_count:new Set(evidence.map(r=>r.market_id).filter(Boolean)).size,processing_count:evidence.length,unresolved_records:unresolved,completion,completion_current:current};
  }
  read(actor,runId) {
    const {run,plan,context}=this.load(actor,runId);const lease=this.db.prepare('SELECT * FROM ow_run_leases WHERE id=?').get(runId);
    let contextStatus='CURRENT';try{this.current(plan);}catch(e){contextStatus=e.code||'RECONCILIATION_REQUIRED';}
    return {api_version:RUN_API,namespace:'TEST',actual_ingestion:'OFF',run_id:run.id,state:run.state,revision:run.revision,context,plan,context_status:contextStatus,lease:lease?{owner_id:lease.owner_id,heartbeat_utc:lease.heartbeat_utc,expires_ms:lease.expires_ms,expired:lease.expires_ms<=Date.now()}:null,...this.summary(run,plan),reservation_is_actual_sierra_start:false};
  }
  options(actor) {
    this.human(actor);
    return {api_version:RUN_API,namespace:'TEST',actual_ingestion:'OFF',disabled_environments:['LIVE_REAL','BACKTEST','IMPORT'],purposes:PURPOSES,build_modes:MODES,strategies:this.db.prepare('SELECT payload_json FROM ow_strategies').all().map(parse),versions:this.db.prepare('SELECT payload_json FROM ow_run_versions').all().map(row=>{const v=parse(row);let blocked=null;try{this.versionsCurrent(v);}catch(e){blocked=e.code;}return {...v,blocked};}),instances:this.db.prepare('SELECT payload_json FROM ow_instances').all().map(parse),settings:this.db.prepare('SELECT payload_json FROM ow_run_settings').all().map(parse),permissions:this.db.prepare('SELECT payload_json FROM ow_dataset_permissions').all().map(row=>{const p=parse(row);return {...p,expired:!future(p.expires_at_utc),manifest:parse(this.b.one('ow_datasets',p.manifest_key))};}),presets:this.db.prepare('SELECT id,payload_json FROM ow_run_presets').all().map(row=>({id:row.id,...parse(row)})),pending_plans:this.db.prepare("SELECT id FROM ow_datasets WHERE kind='PENDING_PLAN'").all(),cases:this.db.prepare('SELECT id,strategy_id,instance_id,candidate_hash FROM ow_cases').all()};
  }
}
