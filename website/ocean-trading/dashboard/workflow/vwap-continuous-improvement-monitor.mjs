import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectRecurringVwapFailures, VWAP_STRATEGY_ID } from './vwap-continuous-improvement.mjs';

export const VWAP_MONITOR_SCHEMA = 'ocean-vwap-continuous-improvement-monitor-state/v1';
const REQUIRED_CAUSAL_FIELDS = ['setup_id','session_name','side','regime_label','vwap_reclaim_state'];
const LEARNING_ROLES = new Set(['DISCOVERY','PAPER','PAPER_ELIGIBLE']);
const nowUtc = () => new Date().toISOString();
const digest = value => 'sha256:' + crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath,'utf8').replace(/^\uFEFF/,'')); } catch { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  fs.writeFileSync(filePath,JSON.stringify(value,null,2));
}
function sqliteSignatures(filePath) {
  return ['', '-wal', '-shm'].flatMap(suffix => {
    const candidate=filePath+suffix;
    if (!fs.existsSync(candidate)) return [];
    const stat=fs.statSync(candidate);
    return [{path:candidate,size:stat.size,mtime_ms:suffix==='-shm'?0:Math.round(stat.mtimeMs)}];
  });
}
function objectExists(db,name) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name).n>0;
}
function utc(value) {
  if(value===null||value===undefined||value==='')return null;
  const number=Number(value);
  if(Number.isFinite(number)&&number>20000&&number<100000)return new Date(Math.round((number-25569)*86400000)).toISOString();
  const parsed=Date.parse(String(value));
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function flags(value) { return new Set(String(value||'').split(/[|,;]/).map(item=>item.trim().toLowerCase()).filter(Boolean)); }
function roleFor(row,source) {
  const direct=String(row.dataset_role||'').trim().toUpperCase();
  if(direct)return direct;
  const assigned=source.run_assignments?.[String(row.run_id||'')];
  if(assigned)return String(assigned).toUpperCase();
  return source.require_explicit_dataset_role===true?'UNASSIGNED':String(source.default_dataset_role||'UNASSIGNED').toUpperCase();
}
function normalize(row,source,config) {
  const role=roleFor(row,source), observedFlags=flags(row.quality_flags);
  const critical=(config.critical_quality_flags||[]).filter(value=>observedFlags.has(String(value).toLowerCase()));
  const missing=REQUIRED_CAUSAL_FIELDS.filter(field=>row[field]===null||row[field]===undefined||row[field]==='');
  const environment=String(row.environment||source.environment||'').toUpperCase(),entry=utc(row.entry_datetime);
  const identityVerified=row.strategy_id===config.strategy_id&&String(row.trade_account||'')===String(source.account||'')&&environment===String(source.environment||'').toUpperCase()&&Number(row.is_simulated)===1;
  const telemetryComplete=String(row.context_status||'').toLowerCase()==='complete'&&!critical.length&&!missing.length&&LEARNING_ROLES.has(role);
  return {trade_id:source.id+':'+row.trade_id,source_id:source.id,source_trade_id:String(row.trade_id),run_id:row.run_id||null,
    strategy_id:row.strategy_id||null,strategy_version:row.strategy_version||null,environment,dataset_role:role,
    session_id:entry?source.id+':'+entry.slice(0,10):null,trading_day:entry?.slice(0,10)||null,
    setup_id:row.setup_id||null,session_name:row.session_name||null,side:row.side||row.direction||null,
    regime_label:row.regime_label||null,volatility_label:row.volatility_label||null,vwap_reclaim_state:row.vwap_reclaim_state||null,
    net_pnl:Number(row.net_profit_loss??row.profit_loss??0),mfe:row.mfe_points??row.max_favourable_excursion??null,mae:row.mae_points??row.max_adverse_excursion??null,
    telemetry_complete:telemetryComplete,identity_verified:identityVerified,quality_flags:[...observedFlags].sort(),
    quality_blockers:[...critical,...missing.map(field=>field+'_missing')].sort(),entry_time_utc:entry,exit_time_utc:utc(row.exit_datetime),updated_utc:row.updated_utc||null};
}

export function loadVwapContinuousImprovementConfig(configFile) {
  const config=readJson(configFile);
  if(!config||config.schema_version!=='ocean-vwap-continuous-improvement-monitor/v1')throw new Error('VWAP_MONITOR_CONFIG_INVALID');
  if(config.strategy_id!==VWAP_STRATEGY_ID)throw new Error('VWAP_MONITOR_STRATEGY_MISMATCH');
  if(!Array.isArray(config.sources)||!config.sources.length)throw new Error('VWAP_MONITOR_SOURCES_REQUIRED');
  const safe=config.safety;
  if(safe?.production_version!==null||safe?.automatic_approval_enabled!==false||safe?.brain_normal_ingestion!=='OFF'||safe?.live_real_enabled!==false||safe?.real_order_routing!=='PROHIBITED')throw new Error('VWAP_MONITOR_SAFETY_BOUNDARY_INVALID');
  return config;
}

export function readVwapLearningRows(source,config) {
  if(!fs.existsSync(source.database_path))throw new Error('VWAP_SOURCE_DATABASE_MISSING:'+source.id);
  const db=new DatabaseSync(source.database_path,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON');
    const object=objectExists(db,'ocean_trade_causal_v1')?'ocean_trade_causal_v1':'trades';
    return db.prepare('SELECT * FROM '+object+" WHERE strategy_id=? AND lower(status)='closed' ORDER BY trade_id").all(config.strategy_id).map(row=>normalize(row,source,config));
  } finally { db.close(); }
}

function publicDetector(result) {
  return {disposition:result.disposition,analysis_hash:result.analysis_hash,next_action:result.next_action||null,
    investigation_queue:result.investigation_queue||[],source_trade_ids:result.source_trade_ids||[],
    sufficiency:{sufficient:result.sufficiency?.sufficient===true,policy_version:result.sufficiency?.policy_version||null,
      threshold_source:result.sufficiency?.threshold_source||null,discovery_trade_count:result.sufficiency?.discovery_trade_count||0,
      eligible_paper_trade_count:result.sufficiency?.eligible_paper_trade_count||0,discovery_session_count:result.sufficiency?.discovery_session_count||0,
      excluded_count:result.sufficiency?.excluded_count||0,blockers:result.sufficiency?.blockers||[]}};
}
function detectorEvent(detector,newTradeIds) {
  return {schema_version:'ocean-vwap-continuous-improvement-event/v1',event_id:'vwap-ci-'+detector.analysis_hash.slice(7,23),
    strategy_id:VWAP_STRATEGY_ID,kind:'INVESTIGATE',created_at_utc:nowUtc(),analysis_hash:detector.analysis_hash,
    new_trade_ids:newTradeIds,source_trade_ids:detector.source_trade_ids,investigation_queue:detector.investigation_queue,next_action:detector.next_action,
    safety:{production_version:null,automatic_approval_enabled:false,live_real_enabled:false,real_order_routing:'PROHIBITED'}};
}
async function requestJson(url,options,timeoutMs) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{...options,signal:controller.signal}),text=await response.text(),body=text?JSON.parse(text):null;
    if(!response.ok)throw new Error('PAPERCLIP_'+response.status+':'+text.slice(0,300));
    return body;
  } finally { clearTimeout(timer); }
}

export async function dispatchVwapImprovementEvent(config,event) {
  const trigger=config.trigger||{};
  if(trigger.enabled!==true)return {triggered:false,reason:'disabled'};
  const base=String(trigger.api_base_url||'http://127.0.0.1:3100/api').replace(/\/+$/,''),timeout=Number(trigger.timeout_ms||15000);
  const title='[VWAP CI] '+event.kind+' '+event.event_id;
  const listed=await requestJson(base+'/companies/'+trigger.company_id+'/issues?limit=100',{},timeout);
  let issue=(Array.isArray(listed)?listed:listed?.items||[]).find(item=>item.title===title);
  const degraded=event.kind==='MONITOR_DEGRADED';
  if(!issue)issue=await requestJson(base+'/companies/'+trigger.company_id+'/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    title,description:(degraded
      ? ['Ocean Trading website could not interrogate the bound VWAP telemetry database after repeated attempts.','','Event: '+event.event_id,'Failure: '+event.error,'Consecutive failures: '+event.consecutive_failures,'',event.next_action]
      : ['Ocean Trading website detected new eligible VWAP evidence and ran the frozen deterministic detector.','','Event: '+event.event_id,'Analysis: '+event.analysis_hash,'New trades: '+event.new_trade_ids.length,'Patterns: '+event.investigation_queue.length,'',event.next_action])
      .concat(['','Safety: no automatic approval, production_version remains null, LIVE_REAL and real-order routing are prohibited.']).join('\n'),
    priority:'high',status:'todo',assigneeAgentId:trigger.agent_id})},timeout);
  const wakeup=await requestJson(base+'/agents/'+trigger.agent_id+'/wakeup?companyId='+trigger.company_id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    source:'automation',triggerDetail:'event_driven',reason:'vwap_continuous_improvement_evidence',
    payload:{issueId:issue.id,eventId:event.event_id,analysisHash:event.analysis_hash,origin:'ocean-trading-website-monitor'},idempotencyKey:event.event_id})},timeout);
  return {triggered:true,issue_id:issue.id,issue_identifier:issue.identifier||null,wakeup_id:wakeup?.id||null,target_agent_id:trigger.agent_id};
}

export async function scanVwapContinuousImprovement({config,stateFile,reason='periodic_scan',force=false,dispatch=dispatchVwapImprovementEvent}={}) {
  if(!config?.enabled)return {enabled:false,skipped:true,reason:'disabled'};
  const previous=readJson(stateFile,{})||{},checkedAt=nowUtc();
  const signatures=config.sources.flatMap(source=>sqliteSignatures(source.database_path)),signature=digest(signatures);
  if(!force&&previous.database_signature===signature){
    const unchanged={...previous,last_checked_at_utc:checkedAt,last_check_reason:reason,skipped_unchanged:true};
    writeJson(stateFile,unchanged);return unchanged;
  }
  try {
    const sources=config.sources.map(source=>({source,rows:readVwapLearningRows(source,config)})),rows=sources.flatMap(item=>item.rows);
    const ids=new Set(rows.map(row=>row.trade_id)),prior=new Set(previous.observed_trade_ids||[]),newIds=[...ids].filter(id=>!prior.has(id)).sort();
    const first=!previous.initialized_at_utc,baseline=first&&config.baseline_existing_trades_on_first_run!==false;
    const detector=publicDetector(detectRecurringVwapFailures(rows,{strategyId:config.strategy_id}));
    let receipt=null,lastHash=previous.last_triggered_analysis_hash||null;
    if(!baseline&&newIds.length&&detector.disposition==='INVESTIGATE'&&detector.analysis_hash!==lastHash){
      receipt=await dispatch(config,detectorEvent(detector,newIds));
      if(receipt?.triggered)lastHash=detector.analysis_hash;
    }
    const eligible=row=>row.telemetry_complete&&row.identity_verified&&LEARNING_ROLES.has(row.dataset_role);
    const state={schema_version:VWAP_MONITOR_SCHEMA,strategy_id:config.strategy_id,strategy_name:config.strategy_name||'VWAP Pullback',enabled:true,status:'HEALTHY',
      initialized_at_utc:previous.initialized_at_utc||checkedAt,last_checked_at_utc:checkedAt,last_database_interrogation_at_utc:checkedAt,last_check_reason:reason,
      skipped_unchanged:false,database_query_count:Number(previous.database_query_count||0)+1,database_signature:signature,
      sources:sources.map(item=>({id:item.source.id,environment:item.source.environment,account:item.source.account,database_path:item.source.database_path,observed_trade_count:item.rows.length,eligible_trade_count:item.rows.filter(eligible).length,latest_trade_id:item.rows.at(-1)?.trade_id||null})),
      observed_trade_count:rows.length,eligible_trade_count:rows.filter(eligible).length,new_trade_count:baseline?0:newIds.length,last_observed_new_trade_ids:baseline?[]:newIds,
      observed_trade_ids:[...ids].sort(),detector,disposition:detector.disposition,next_action:detector.next_action||detector.sufficiency.blockers.map(item=>item.code).join(', '),baseline_applied:baseline,
      last_trigger_receipt:receipt||previous.last_trigger_receipt||null,last_triggered_analysis_hash:lastHash,consecutive_failures:0,last_error:null,
      recent_events:[...(previous.recent_events||[]),{at_utc:checkedAt,reason,disposition:detector.disposition,new_trade_count:newIds.length,database_query:true,trigger:receipt}].slice(-25),safety:config.safety};
    writeJson(stateFile,state);return state;
  } catch(error) {
    const errorText=String(error?.message||error),consecutiveFailures=Number(previous.consecutive_failures||0)+1,threshold=Number(config.trigger?.failure_threshold||3);
    const failureId='vwap-monitor-failure-'+digest({error:errorText}).slice(7,23);let failureReceipt=previous.last_failure_trigger_receipt||null,lastFailureId=previous.last_triggered_failure_event_id||null,dispatchError=null;
    if(consecutiveFailures>=threshold&&failureId!==lastFailureId){
      try {
        failureReceipt=await dispatch(config,{schema_version:'ocean-vwap-continuous-improvement-event/v1',event_id:failureId,strategy_id:config.strategy_id,kind:'MONITOR_DEGRADED',created_at_utc:checkedAt,analysis_hash:digest({error:errorText}),error:errorText,consecutive_failures:consecutiveFailures,next_action:'Restore read-only access to the exact bound telemetry database and verify the website monitor recovers.',safety:config.safety});
        if(failureReceipt?.triggered)lastFailureId=failureId;
      } catch(dispatchFailure) { dispatchError=String(dispatchFailure?.message||dispatchFailure); }
    }
    const state={...previous,schema_version:VWAP_MONITOR_SCHEMA,strategy_id:config.strategy_id,enabled:true,status:'DEGRADED',last_checked_at_utc:checkedAt,last_check_reason:reason,skipped_unchanged:false,
      consecutive_failures:consecutiveFailures,last_error:errorText,last_failure_trigger_receipt:failureReceipt,last_triggered_failure_event_id:lastFailureId,last_dispatch_error:dispatchError,
      recent_events:[...(previous.recent_events||[]),{at_utc:checkedAt,reason,database_query:true,error:errorText,trigger:failureReceipt,dispatch_error:dispatchError}].slice(-25),safety:config.safety};
    writeJson(stateFile,state);return state;
  }
}

export function readVwapContinuousImprovementState(stateFile) {
  return readJson(stateFile,{schema_version:VWAP_MONITOR_SCHEMA,strategy_id:VWAP_STRATEGY_ID,enabled:false,status:'NOT_STARTED',disposition:'UNKNOWN',sources:[],recent_events:[]});
}
