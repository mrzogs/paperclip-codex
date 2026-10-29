import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectRecurringVwapFailures, VWAP_STRATEGY_ID } from './vwap-continuous-improvement.mjs';
import { verifiedVwapDiscoveryRows } from './vwap-discovery-admission.mjs';
import { loadConfiguredVwapDiscoveryAdmission } from './vwap-improvement-reader.mjs';
import { readOnboardingFileSync } from './onboarding-file-read.mjs';

export const VWAP_MONITOR_SCHEMA = 'ocean-vwap-continuous-improvement-monitor-state/v1';
const REQUIRED_CAUSAL_FIELDS = ['setup_id','session_name','side','regime_label','vwap_reclaim_state'];
const LEARNING_ROLES = new Set(['DISCOVERY','PAPER','PAPER_ELIGIBLE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const STARTED_STATUSES = new Set(['running','succeeded','failed','timed_out']);
const SQLITE_READER = path.join(path.dirname(fileURLToPath(import.meta.url)),'vwap-sqlite-reader.mjs');
const nowUtc = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const digest = value => 'sha256:' + crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function readJson(filePath, fallback = null) {
  try { return JSON.parse(readOnboardingFileSync(filePath,'utf8').replace(/^\uFEFF/,'')); } catch { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath),{recursive:true});
  const temporary=filePath+'.tmp-'+process.pid;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2));
  fs.renameSync(temporary,filePath);
}
function sqliteSignatures(filePath) {
  return ['', '-wal', '-shm'].flatMap(suffix => {
    const candidate=filePath+suffix;
    if (!fs.existsSync(candidate)) return [];
    const stat=fs.statSync(candidate);
    return [{path:candidate,size:stat.size,mtime_ms:suffix==='-shm'?0:Math.round(stat.mtimeMs)}];
  });
}
function utc(value) {
  if(value===null||value===undefined||value==='')return null;
  const number=Number(value);
  if(Number.isFinite(number)&&number>20000&&number<100000)return new Date(Math.round((number-25569)*86400000)).toISOString();
  const parsed=Date.parse(String(value));
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function flags(value) { return new Set(String(value||'').split(/[|,;]/).map(item=>item.trim().toLowerCase()).filter(Boolean)); }
function runContractState(row,source) {
  const runId=String(row.run_id||''),contract=source.run_contracts?.[runId];
  if(!contract)return {state:'LEGACY_FROZEN_ASSIGNMENT',verified:true,contract:null};
  const attestation=contract.materialization_attestation;
  if(contract.materialization_authorized!==true||!attestation)return {state:'NOT_MATERIALIZED',verified:false,contract};
  const verified=attestation.status==='VERIFIED'
    &&attestation.run_id===runId
    &&attestation.context_hash===contract.context_hash
    &&row.context_hash===attestation.context_hash
    &&row.strategy_code_hash===attestation.strategy_code_hash
    &&row.strategy_config_hash===attestation.strategy_config_hash
    &&row.dataset_id===attestation.dataset_id;
  return {state:verified?'VERIFIED':'ATTESTATION_MISMATCH',verified,contract};
}
function roleFor(row,source,contractState=runContractState(row,source)) {
  const direct=String(row.dataset_role||'').trim().toUpperCase();
  const assigned=source.run_assignments?.[String(row.run_id||'')];
  if(String(source.environment||'').toUpperCase()==='REPLAY'){
    if(!assigned)return 'UNREGISTERED_RUN';
    if(contractState.state==='NOT_MATERIALIZED')return 'RUN_CONTRACT_NOT_MATERIALIZED';
    if(contractState.state==='ATTESTATION_MISMATCH')return 'RUN_CONTRACT_ATTESTATION_MISMATCH';
    const role=String(assigned).toUpperCase();
    return direct&&direct!==role?'ROLE_CONFLICT':role;
  }
  if(direct)return direct;
  if(assigned)return String(assigned).toUpperCase();
  return source.require_explicit_dataset_role===true?'UNASSIGNED':String(source.default_dataset_role||'UNASSIGNED').toUpperCase();
}
function normalize(row,source,config) {
  const contractState=runContractState(row,source),role=roleFor(row,source,contractState), observedFlags=flags(row.quality_flags);
  const critical=(config.critical_quality_flags||[]).filter(value=>observedFlags.has(String(value).toLowerCase()));
  const missing=REQUIRED_CAUSAL_FIELDS.filter(field=>row[field]===null||row[field]===undefined||row[field]==='');
  const environment=String(row.environment||source.environment||'').toUpperCase(),entry=utc(row.entry_datetime);
  const account=String(row.trade_account||'');
  const foreignAccount=account!==''&&account!==String(source.account||'');
  const identityVerified=row.strategy_id===config.strategy_id&&account===String(source.account||'')&&environment===String(source.environment||'').toUpperCase()&&Number(row.is_simulated)===1&&contractState.verified;
  const telemetryComplete=String(row.context_status||'').toLowerCase()==='complete'&&!critical.length&&!missing.length&&LEARNING_ROLES.has(role);
  return {trade_id:source.id+':'+row.trade_id,source_id:source.id,source_trade_id:String(row.trade_id),run_id:row.run_id||null,
    strategy_id:row.strategy_id||null,strategy_version:row.strategy_version||null,environment,dataset_role:role,
    session_id:entry?source.id+':'+entry.slice(0,10):null,trading_day:entry?.slice(0,10)||null,
    setup_id:row.setup_id||null,session_name:row.session_name||null,side:row.side||row.direction||null,
    regime_label:row.regime_label||null,volatility_label:row.volatility_label||null,vwap_reclaim_state:row.vwap_reclaim_state||null,
    net_pnl:row.net_profit_loss??row.profit_loss??null,mfe:row.mfe_points??row.max_favourable_excursion??null,mae:row.mae_points??row.max_adverse_excursion??null,
    telemetry_complete:telemetryComplete,identity_verified:identityVerified,foreign_account:foreignAccount,run_contract_state:contractState.state,
    quality_flags:[...observedFlags].sort(),
    quality_blockers:[...critical,...missing.map(field=>field+'_missing'),...(contractState.verified?[]:['run_contract_'+contractState.state.toLowerCase()])].sort(),entry_time_utc:entry,exit_time_utc:utc(row.exit_datetime),updated_utc:row.updated_utc||null};
}

export function loadVwapContinuousImprovementConfig(configFile) {
  const config=readJson(configFile);
  if(!config||config.schema_version!=='ocean-vwap-continuous-improvement-monitor/v1')throw new Error('VWAP_MONITOR_CONFIG_INVALID');
  if(config.strategy_id!==VWAP_STRATEGY_ID)throw new Error('VWAP_MONITOR_STRATEGY_MISMATCH');
  if(config.brain_identity?.project!==config.strategy_id||config.brain_identity?.domain!=='trading-strategy'
    ||config.brain_identity?.strategy!==config.strategy_id)throw new Error('VWAP_MONITOR_BRAIN_IDENTITY_MISMATCH');
  if(config.routing?.mode!=='BLOCK_UNTIL_EXACT_PROJECT_ROUTE'||typeof config.routing?.required_project_root!=='string'
    ||typeof config.routing?.brain_credential_ref!=='string'
    ||typeof config.routing?.required_agent_model!=='string'
    ||!(config.routing?.paperclip_project_id===null||UUID.test(config.routing?.paperclip_project_id||''))
    ||!(config.routing?.paperclip_project_workspace_id===null||UUID.test(config.routing?.paperclip_project_workspace_id||'')))throw new Error('VWAP_MONITOR_ROUTING_BOUNDARY_INVALID');
  if(!Array.isArray(config.sources)||!config.sources.length)throw new Error('VWAP_MONITOR_SOURCES_REQUIRED');
  for(const source of config.sources){
    const contracts=source.run_contracts||{};
    for(const [runId,contract] of Object.entries(contracts)){
      if(source.run_assignments?.[runId]!==contract.dataset_role
        ||contract.dataset_role!=='DISCOVERY'
        ||typeof contract.contract_id!=='string'||!contract.contract_id
        ||![contract.contract_hash,contract.document_hash,contract.context_hash].every(value=>SHA256.test(String(value||'')))
        ||!UUID.test(String(contract.run_release_approval_id||''))
        ||contract.run_release_scope!=='RUN_RELEASE'
        ||typeof contract.materialization_authorized!=='boolean'
        ||(contract.materialization_authorized===false&&(contract.materialization_blocker!=='POST_STAGING_CHARTBOOK_HASH_NOT_BOUND_BY_EXISTING_RUN_RELEASE'||contract.materialization_attestation!==null))
        ||(contract.materialization_authorized===true&&(!contract.materialization_attestation
          ||contract.materialization_attestation.status!=='VERIFIED'
          ||contract.materialization_attestation.run_id!==runId
          ||contract.materialization_attestation.context_hash!==contract.context_hash
          ||![contract.materialization_attestation.strategy_code_hash,contract.materialization_attestation.strategy_config_hash,
            contract.materialization_attestation.telemetry_attestation_hash].every(value=>SHA256.test(String(value||'')))
          ||typeof contract.materialization_attestation.dataset_id!=='string'||!contract.materialization_attestation.dataset_id
          ||!UUID.test(String(contract.materialization_attestation.approval_id||''))
          ||!Number.isFinite(Date.parse(contract.materialization_attestation.materialized_at_utc||''))))
        ||contract.playback_authorized!==false
        ||contract.registered_before_rows!==true)throw new Error('VWAP_MONITOR_RUN_CONTRACT_INVALID:'+runId);
    }
  }
  const safe=config.safety;
  if(safe?.production_version!==null||safe?.automatic_approval_enabled!==false||safe?.brain_normal_ingestion!=='OFF'||safe?.live_real_enabled!==false||safe?.real_order_routing!=='PROHIBITED')throw new Error('VWAP_MONITOR_SAFETY_BOUNDARY_INVALID');
  return config;
}
function isRunRoleIssue(row) {
  return row.dataset_role==='UNREGISTERED_RUN'||row.dataset_role==='ROLE_CONFLICT'||row.dataset_role.startsWith('RUN_CONTRACT_');
}

export function readVwapLearningRows(source,config) {
  if(!fs.existsSync(source.database_path))throw new Error('VWAP_SOURCE_DATABASE_MISSING:'+source.id);
  const result=spawnSync(process.execPath,[SQLITE_READER,source.database_path,config.strategy_id],{encoding:'utf8',timeout:Number(config.source_read_timeout_ms||45000),maxBuffer:64*1024*1024,windowsHide:true});
  if(result.error)throw new Error('VWAP_SOURCE_READ_FAILED:'+source.id+':'+(result.error.code||result.error.message));
  if(result.status!==0)throw new Error('VWAP_SOURCE_READ_FAILED:'+source.id+':'+String(result.stderr||'UNKNOWN').trim().slice(-500));
  return JSON.parse(result.stdout||'[]').map(row=>normalize(row,source,config));
}

export function readVwapLearningRowsAsync(source,config) {
  if(!fs.existsSync(source.database_path))return Promise.reject(new Error('VWAP_SOURCE_DATABASE_MISSING:'+source.id));
  const timeoutMs=Number(config.source_read_timeout_ms||45000),startedAt=Date.now();
  return new Promise((resolve,reject)=>{
    let settled=false;
    let hardTimeout=null;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;
      clearTimeout(hardTimeout);
      if(error)reject(error);else resolve(value);
    };
    const child=execFile(process.execPath,[SQLITE_READER,source.database_path,config.strategy_id],{
      encoding:'utf8',timeout:timeoutMs,maxBuffer:64*1024*1024,windowsHide:true,
    },(error,stdout,stderr)=>{
      if(error){
        const detail=[error.code||error.name||'ERROR',error.signal||null,'elapsed_ms='+String(Date.now()-startedAt),String(stderr||'').trim().slice(-300)].filter(Boolean).join(':');
        return finish(new Error('VWAP_SOURCE_READ_FAILED:'+source.id+':'+detail));
      }
      try{finish(null,JSON.parse(stdout||'[]').map(row=>normalize(row,source,config)));}
      catch(parseError){finish(new Error('VWAP_SOURCE_READ_FAILED:'+source.id+':'+String(parseError?.message||parseError)));}
    });
    // Node's synchronous child runner can remain blocked on Windows after a
    // timed-out descendant. Keep the monitor event loop free and own a second,
    // independent deadline so auxiliary learning reads cannot stop core scans.
    hardTimeout=setTimeout(()=>{
      child.kill();
      finish(new Error('VWAP_SOURCE_READ_FAILED:'+source.id+':ETIMEDOUT'));
    },timeoutMs+1000);
    hardTimeout.unref?.();
  });
}

function publicDetector(result) {
  return {disposition:result.disposition,analysis_hash:result.analysis_hash,next_action:result.next_action||null,
    investigation_queue:result.investigation_queue||[],source_trade_ids:result.source_trade_ids||[],
    sufficiency:{sufficient:result.sufficiency?.sufficient===true,policy_version:result.sufficiency?.policy_version||null,
      threshold_source:result.sufficiency?.threshold_source||null,discovery_trade_count:result.sufficiency?.discovery_trade_count||0,
      eligible_paper_trade_count:result.sufficiency?.eligible_paper_trade_count||0,discovery_session_count:result.sufficiency?.discovery_session_count||0,
      excluded_count:result.sufficiency?.excluded_count||0,blockers:result.sufficiency?.blockers||[]}};
}
function detectorEvent(detector,newTradeIds,newlyEligibleTradeIds,triggerReason) {
  return {schema_version:'ocean-vwap-continuous-improvement-event/v1',event_id:'vwap-ci-'+detector.analysis_hash.slice(7,23),
    strategy_id:VWAP_STRATEGY_ID,kind:'INVESTIGATE',created_at_utc:nowUtc(),analysis_hash:detector.analysis_hash,
    new_trade_ids:newTradeIds,newly_eligible_trade_ids:newlyEligibleTradeIds,trigger_reason:triggerReason,
    source_trade_ids:detector.source_trade_ids,investigation_queue:detector.investigation_queue,next_action:detector.next_action,
    safety:{production_version:null,automatic_approval_enabled:false,live_real_enabled:false,real_order_routing:'PROHIBITED'}};
}
function evidenceBlockerEvent(detector,rows) {
  const blockers=detector.sufficiency.blockers.map(item=>item.code).sort();
  const roleIssues=rows.filter(isRunRoleIssue);
  const paperIssues=rows.filter(row=>row.environment==='PAPER'&&(!LEARNING_ROLES.has(row.dataset_role)||!row.telemetry_complete||!row.identity_verified));
  const sourceIds=[...new Set([...roleIssues,...paperIssues].map(row=>row.source_id))].sort();
  const analysisHash=digest({blockers,sourceIds,roleIssueKinds:[...new Set(roleIssues.map(row=>row.dataset_role))].sort(),
    paperIssueKinds:[...new Set(paperIssues.map(row=>row.dataset_role))].sort()});
  return {schema_version:'ocean-vwap-continuous-improvement-event/v1',event_id:'vwap-ci-evidence-'+analysisHash.slice(7,23),
    strategy_id:VWAP_STRATEGY_ID,kind:'EVIDENCE_BLOCKED',created_at_utc:nowUtc(),analysis_hash:analysisHash,
    blockers,role_issue_count:roleIssues.length,paper_provenance_issue_count:paperIssues.length,source_ids:sourceIds,
    next_action:'Investigate source telemetry and frozen run-role provenance. Preserve original rows; do not relabel historical validation/holdout trades, backfill missing facts, change strategy rules, or authorize promotion.',
    safety:{production_version:null,automatic_approval_enabled:false,live_real_enabled:false,real_order_routing:'PROHIBITED'}};
}
function runContractPublication(config) {
  const contracts=config.sources.flatMap(source=>Object.entries(source.run_contracts||{}).map(([runId,contract])=>({
    source_id:source.id,environment:source.environment,account:source.account,run_id:runId,...contract,
  }))).sort((left,right)=>left.run_id.localeCompare(right.run_id));
  const body={schema_version:'ocean-vwap-run-role-publication/v1',strategy_id:config.strategy_id,contracts};
  return {...body,publication_hash:digest(body),authority:'OCEAN_CHECKED_IN_CONFIG_AND_PAPERCLIP_APPROVAL_READBACK',
    readback:'GET /api/workflow -> onboarding.continuous_delivery.event_monitor.run_contract_publication'};
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
  const brain=config.brain_identity||{};
  if(event.strategy_id!==config.strategy_id||brain.project!==config.strategy_id||brain.domain!=='trading-strategy'
    ||brain.strategy!==config.strategy_id)throw new Error('VWAP_MONITOR_DISPATCH_IDENTITY_MISMATCH');
  const base=String(trigger.api_base_url||'http://127.0.0.1:3100/api').replace(/\/+$/,''),timeout=Number(trigger.timeout_ms||15000);
  const routing=config.routing||{},target=await requestJson(base+'/agents/'+trigger.agent_id,{},timeout);
  const samePath=(left,right)=>path.win32.normalize(String(left||'')).toLowerCase()===path.win32.normalize(String(right||'')).toLowerCase();
  const agentReady=target?.companyId===trigger.company_id
    && (target?.status==='idle'||target?.status==='running')
    && target?.adapterType==='codex_local'
    && samePath(target?.adapterConfig?.cwd,routing.required_project_root)
    && target?.adapterConfig?.model===routing.required_agent_model
    && target?.metadata?.active_strategy_id===event.strategy_id
    && target?.metadata?.brain_project===brain.project && target?.metadata?.brain_domain===brain.domain
    && target?.metadata?.brain_credential_ref===routing.brain_credential_ref
    && target?.metadata?.paperclip_project_id===routing.paperclip_project_id
    && target?.metadata?.paperclip_workspace_id===routing.paperclip_project_workspace_id
    && target?.metadata?.environment==='TEST_ONLY'
    && target?.metadata?.live_real_enabled===false
    && target?.permissions?.canUseSecrets===true
    && target?.permissions?.canCreateAgents===false
    && target?.permissions?.canUseLiveTrading===false;
  let project=null,workspace=null;
  if(agentReady&&UUID.test(routing.paperclip_project_id||'')&&UUID.test(routing.paperclip_project_workspace_id||'')){
    project=await requestJson(base+'/projects/'+routing.paperclip_project_id,{},timeout);
    const workspaces=await requestJson(base+'/projects/'+routing.paperclip_project_id+'/workspaces',{},timeout);
    workspace=(Array.isArray(workspaces)?workspaces:workspaces?.items||[]).find(row=>row.id===routing.paperclip_project_workspace_id)||null;
  }
  const routeReady=agentReady && project?.id===routing.paperclip_project_id && project?.companyId===trigger.company_id
    && project?.primaryWorkspace?.id===routing.paperclip_project_workspace_id
    && workspace?.projectId===routing.paperclip_project_id && workspace?.isPrimary===true
    && samePath(workspace?.cwd,routing.required_project_root);
  const routingState=routeReady?'EXACT_PROJECT_READY':'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED';
  const title='[VWAP CI]['+event.strategy_id+'] '+event.kind+' '+event.event_id;
  // The company-wide issue list can exceed the dispatch deadline. Search by this
  // immutable event ID, then still require the exact title before reusing an issue.
  const listed=await requestJson(base+'/companies/'+trigger.company_id+'/issues?limit=5&q='+encodeURIComponent(event.event_id),{},timeout);
  let issue=(Array.isArray(listed)?listed:listed?.items||[]).find(item=>item.title===title);
  const issueCreated=!issue;
  const degraded=event.kind==='MONITOR_DEGRADED',evidenceBlocked=event.kind==='EVIDENCE_BLOCKED',transportTest=event.transport_test===true;
  if(!issue)issue=await requestJson(base+'/companies/'+trigger.company_id+'/issues',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    title,description:['Exact strategy ID: '+event.strategy_id,'Brain project: '+brain.project,'Brain domain: '+brain.domain,
      'Required project root: '+routing.required_project_root,'Brain credential reference: '+routing.brain_credential_ref,
      'Required agent model: '+routing.required_agent_model,
      'Paperclip project ID: '+(routing.paperclip_project_id||'NOT_PROVISIONED'),
      'Paperclip project workspace ID: '+(routing.paperclip_project_workspace_id||'NOT_PROVISIONED'),
      'Routing state: '+routingState,
      'Isolation: operate only on this exact strategy and Brain project. Do not substitute or access any sibling strategy, project, pod, token, registry, source tree, or evidence. Stop on any active_strategy_id/project/domain mismatch.',
      routeReady?'Exact project routing was verified for the configured target agent.':'Keep this issue blocked. The configured coordinator may contain and route the incident only; do not create or wake a child until the Paperclip project/workspace, agent cwd/model, active_strategy_id, Brain project/domain/credential reference, and secret permission are bound to the exact CICD project.',''].concat(transportTest
      ? ['End-to-end transport test from the Ocean Trading website monitor.','','Event: '+event.event_id,'Purpose: prove issue creation, coordinator assignment, and wakeup delivery.','','No strategy, Sierra, approval, promotion, Paper, or Live action is authorized by this test. Close this issue after acknowledging receipt.']
      : degraded
      ? ['Ocean Trading website could not interrogate the bound VWAP telemetry database after repeated attempts.','','Event: '+event.event_id,'Failure: '+event.error,'Consecutive failures: '+event.consecutive_failures,'',event.next_action]
      : evidenceBlocked
      ? ['Ocean Trading website can read VWAP trades, but evidence integrity prevents the deterministic learner from acting.','','Event: '+event.event_id,'Blockers: '+event.blockers.join(', '),'Replay run-role issues: '+event.role_issue_count,'Paper provenance issues: '+event.paper_provenance_issue_count,'Affected sources: '+event.source_ids.join(', '),'',event.next_action]
      : ['Ocean Trading website detected new eligible VWAP evidence and ran the frozen deterministic detector.','','Event: '+event.event_id,'Analysis: '+event.analysis_hash,'New trades: '+event.new_trade_ids.length,'Patterns: '+event.investigation_queue.length,'',event.next_action])
      .concat(['','Safety: no automatic approval, production_version remains null, LIVE_REAL and real-order routing are prohibited.']).join('\n'),
    priority:'high',status:routeReady?'todo':'blocked',assigneeAgentId:trigger.agent_id,
    projectId:routeReady?routing.paperclip_project_id:null,
    projectWorkspaceId:routeReady?routing.paperclip_project_workspace_id:null})},timeout);
  if(!routeReady)return {triggered:false,dispatch_committed:false,reason:'EXACT_PROJECT_ROUTE_NOT_READY',issue_created:issueCreated,
    issue_id:issue.id,issue_identifier:issue.identifier||null,wakeup_id:null,target_agent_id:trigger.agent_id,routing_state:routingState};
  if(issue.status==='blocked'&&(!issue.projectId||!issue.projectWorkspaceId)){
    issue=await requestJson(base+'/issues/'+issue.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({
      status:'todo',assigneeAgentId:trigger.agent_id,projectId:routing.paperclip_project_id,
      projectWorkspaceId:routing.paperclip_project_workspace_id,
    })},timeout);
    if(issue?.status!=='todo'||issue?.assigneeAgentId!==trigger.agent_id||issue?.projectId!==routing.paperclip_project_id
      ||issue?.projectWorkspaceId!==routing.paperclip_project_workspace_id)throw new Error('VWAP_MONITOR_ROUTE_REPAIR_READBACK_MISMATCH');
  }
  if(['blocked','done','cancelled'].includes(String(issue?.status||'').toLowerCase()))return {triggered:false,dispatch_committed:false,
    reason:'EVENT_ISSUE_NOT_WAKEABLE',issue_created:false,issue_id:issue.id,issue_identifier:issue.identifier||null,wakeup_id:null,
    target_agent_id:trigger.agent_id,routing_state:routingState,issue_status:issue.status};
  const wakePrefix=transportTest?'vwap_continuous_improvement_transport_test':'vwap_continuous_improvement_evidence';
  const wakeReason=wakePrefix+'_'+digest(event.event_id).slice(7,23);
  const wakeup=await requestJson(base+'/agents/'+trigger.agent_id+'/wakeup?companyId='+trigger.company_id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    source:'automation',triggerDetail:'system',reason:wakeReason,
    payload:{issueId:issue.id,eventId:event.event_id,analysisHash:event.analysis_hash,origin:'ocean-trading-website-monitor',
      strategyId:event.strategy_id,brainProject:brain.project,brainDomain:brain.domain,isolationScope:'EXACT_STRATEGY_ONLY',
      requiredProjectRoot:routing.required_project_root,brainCredentialRef:routing.brain_credential_ref,
      requiredAgentModel:routing.required_agent_model,paperclipProjectId:routing.paperclip_project_id,
      paperclipProjectWorkspaceId:routing.paperclip_project_workspace_id,routingState},idempotencyKey:event.event_id})},timeout);
  if(typeof wakeup?.id!=='string'||!wakeup.id)throw new Error('VWAP_MONITOR_WAKE_RECEIPT_INVALID');
  const deadline=Date.now()+Number(trigger.wake_start_timeout_ms||30000);
  let run=wakeup;
  const started=run=>STARTED_STATUSES.has(String(run?.status||'').toLowerCase())&&Number.isFinite(Date.parse(run?.startedAt||''));
  while(Date.now()<deadline){
    if(started(run))break;
    run=await requestJson(base+'/heartbeat-runs/'+wakeup.id,{},timeout);
    if(started(run))break;
    await sleep(Number(trigger.wake_poll_interval_ms||500));
  }
  if(!started(run))throw new Error('VWAP_MONITOR_WAKE_NOT_PROVEN_STARTED');
  if(run?.id!==wakeup.id||run?.agentId!==trigger.agent_id||run?.contextSnapshot?.issueId!==issue.id
    ||run?.contextSnapshot?.wakeReason!==wakeReason)throw new Error('VWAP_MONITOR_WAKE_READBACK_MISMATCH');
  return {triggered:true,dispatch_committed:true,issue_created:issueCreated,issue_id:issue.id,issue_identifier:issue.identifier||null,
    wakeup_id:wakeup.id,wakeup_status:run.status,wakeup_started_at_utc:run.startedAt,target_agent_id:trigger.agent_id,routing_state:routingState,
    delivery_proven:true,downstream_investigation_complete:false};
}

export async function scanVwapContinuousImprovement({config,stateFile,reason='periodic_scan',force=false,dispatch=dispatchVwapImprovementEvent,
  readSource=readVwapLearningRowsAsync,readAdmission=loadConfiguredVwapDiscoveryAdmission,clock=Date.now}={}) {
  if(!config?.enabled)return {enabled:false,skipped:true,reason:'disabled'};
  const previous=readJson(stateFile,{})||{},checkedAt=new Date(clock()).toISOString();
  const publication=runContractPublication(config);
  // Revalidate publication/receipt freshness even when no SQLite row changed.
  // A persisted "eligible" counter is not a transferable admission capability.
  let admissionState;
  try { admissionState=await readAdmission({configFile:config.discovery_report_reader_config,now:Date.parse(checkedAt),config}); }
  catch { admissionState={admitted:false,admission:null,rows:[],blockers:[{code:'DISCOVERY_ADMISSION_READER_FAILED'}]}; }
  const admissionRows=Array.isArray(admissionState?.rows)?admissionState.rows:[];
  const currentAdmission=verifiedVwapDiscoveryRows(admissionState?.admission,admissionRows,
    {strategyId:config.strategy_id,now:Date.parse(checkedAt)});
  const admissionValid=admissionState?.admitted===true && currentAdmission.blockers.length===0;
  const admissionSignature=digest({publication:admissionState?.publication_sha256||null,
    admitted:admissionValid,report:admissionState?.admission?.report_sha256||null,
    intake_package_sha256:admissionState?.admission?.semantic_admission?.intake_package_sha256||null,
    blockers:[...(admissionState?.blockers||[]),...currentAdmission.blockers]});
  const signatures=config.sources.flatMap(source=>sqliteSignatures(source.database_path));
  const signature=digest({normalization_version:'frozen-replay-role-map-account-scope/v2',signatures,
    sources:config.sources.map(source=>({id:source.id,environment:source.environment,account:source.account,
      run_assignments:source.run_assignments||null,require_explicit_dataset_role:source.require_explicit_dataset_role===true,
      run_contracts:source.run_contracts||null,default_dataset_role:source.default_dataset_role||null})),critical_quality_flags:config.critical_quality_flags||[]});
  if(!force&&previous.status==='HEALTHY'&&previous.database_signature===signature
    &&previous.discovery_admission_signature===admissionSignature&&!previous.pending_dispatch){
    const unchanged={...previous,last_checked_at_utc:checkedAt,last_check_reason:reason,skipped_unchanged:true};
    writeJson(stateFile,unchanged);return unchanged;
  }
  try {
    writeJson(stateFile,{...previous,schema_version:VWAP_MONITOR_SCHEMA,strategy_id:config.strategy_id,enabled:true,status:'SCANNING',last_checked_at_utc:checkedAt,last_check_reason:reason,current_phase:'READING_SOURCES',current_source_id:null,safety:config.safety});
    const sources=[];
    for(const source of config.sources){
      writeJson(stateFile,{...readJson(stateFile,{}),current_source_id:source.id});
      sources.push({source,rows:await readSource(source,config)});
    }
    // A shared telemetry database may hold trades from other simulated accounts.
    // Keep their presence visible, but never count or dispatch them as this source.
    const foreignAccountRows=sources.flatMap(item=>item.rows.filter(row=>row.foreign_account));
    const rows=sources.flatMap(item=>item.rows.filter(row=>!row.foreign_account));
    const declaredComplete=row=>row.telemetry_complete&&row.identity_verified&&LEARNING_ROLES.has(row.dataset_role);
    const researchRows=admissionValid?admissionRows:rows;
    const verifiedRows=admissionValid?currentAdmission.rows:[];
    const ids=new Set(rows.map(row=>row.trade_id)),prior=new Set(previous.observed_trade_ids||[]),newIds=[...ids].filter(id=>!prior.has(id)).sort();
    const eligibleRows=verifiedRows.filter(row=>row.research_eligible===true)
      .sort((left,right)=>left.trade_id.localeCompare(right.trade_id));
    const eligibleIds=eligibleRows.map(row=>row.trade_id),priorEligible=new Set(previous.eligible_trade_ids||[]);
    const newlyEligibleIds=eligibleIds.filter(id=>!priorEligible.has(id));
    const eligibleFingerprint=digest({admission_report_sha256:admissionState?.admission?.report_sha256||null,
      intake_package_sha256:admissionState?.admission?.semantic_admission?.intake_package_sha256||null,
      rows:eligibleRows.map(row=>({trade_id:row.trade_id,run_id:row.run_id,dataset_role:row.dataset_role,
      setup_id:row.setup_id,session_name:row.session_name,side:row.side,regime_label:row.regime_label,
      volatility_label:row.volatility_label,vwap_reclaim_state:row.vwap_reclaim_state,net_pnl:row.net_pnl,mfe:row.mfe,mae:row.mae,
      research_eligible:row.research_eligible,learning_context_complete:row.learning_context_complete,quality_flags:row.quality_flags,
      entry_time_utc:row.entry_time_utc,exit_time_utc:row.exit_time_utc,updated_utc:row.updated_utc}))});
    const first=!previous.initialized_at_utc,baseline=first&&config.baseline_existing_trades_on_first_run!==false;
    const detector=publicDetector(detectRecurringVwapFailures(researchRows,{strategyId:config.strategy_id,
      admission:admissionValid?admissionState.admission:null,now:Date.parse(checkedAt)}));
    let receipt=null,lastHash=previous.last_triggered_analysis_hash||null,pendingDispatch=previous.pending_dispatch||null;
    const evidenceChanged=previous.eligible_evidence_fingerprint&&previous.eligible_evidence_fingerprint!==eligibleFingerprint;
    const triggerReason=newIds.length?'NEW_TRADE_IDS':newlyEligibleIds.length?'EXISTING_TRADES_BECAME_ELIGIBLE':evidenceChanged?'ELIGIBLE_EVIDENCE_CHANGED':pendingDispatch?'RETRY_UNCOMMITTED_DISPATCH':null;
    if(!baseline&&triggerReason&&detector.disposition==='INVESTIGATE'&&detector.analysis_hash!==lastHash){
      const event=detectorEvent(detector,newIds,newlyEligibleIds,triggerReason);
      pendingDispatch={event,attempted_at_utc:checkedAt,reason:'AWAITING_PROVEN_WAKE'};
      writeJson(stateFile,{...readJson(stateFile,{}),pending_dispatch:pendingDispatch});
      receipt=await dispatch(config,event);
      const committed=receipt?.triggered===true&&receipt?.dispatch_committed!==false;
      if(committed){lastHash=detector.analysis_hash;pendingDispatch=null;}
      else pendingDispatch={event,attempted_at_utc:checkedAt,reason:receipt?.reason||'DISPATCH_NOT_COMMITTED',receipt};
    }
    const hasQualityBlocker=detector.sufficiency.blockers.some(item=>['TELEMETRY_OR_IDENTITY_GAPS','STRATEGY_ID_MISMATCH',
      'DISCOVERY_ADMISSION_REQUIRED','DISCOVERY_ADMISSION_EXPIRED','DISCOVERY_ADMISSION_ROW_SET_MISMATCH'].includes(item.code));
    const hasRoleIssue=rows.some(isRunRoleIssue);
    const hasPaperIssue=rows.some(row=>row.environment==='PAPER'&&(!LEARNING_ROLES.has(row.dataset_role)||!row.telemetry_complete||!row.identity_verified));
    let lastEvidenceBlockerHash=previous.last_triggered_evidence_blocker_hash||null;
    if(!baseline&&detector.disposition==='INSUFFICIENT_EVIDENCE'&&(hasQualityBlocker||hasRoleIssue||hasPaperIssue)){
      const event=evidenceBlockerEvent(detector,rows);
      if(event.analysis_hash!==lastEvidenceBlockerHash){
        pendingDispatch={event,attempted_at_utc:checkedAt,reason:'AWAITING_PROVEN_WAKE'};
        writeJson(stateFile,{...readJson(stateFile,{}),pending_dispatch:pendingDispatch});
        receipt=await dispatch(config,event);
        const committed=receipt?.triggered===true&&receipt?.dispatch_committed!==false;
        if(committed){lastEvidenceBlockerHash=event.analysis_hash;pendingDispatch=null;}
        else pendingDispatch={event,attempted_at_utc:checkedAt,reason:receipt?.reason||'DISPATCH_NOT_COMMITTED',receipt};
      }
    }
    const roleIssueCount=rows.filter(isRunRoleIssue).length;
    const paperProvenanceIssueCount=rows.filter(row=>row.environment==='PAPER'&&(!LEARNING_ROLES.has(row.dataset_role)||!row.telemetry_complete||!row.identity_verified)).length;
    const nextAction=roleIssueCount
      ? 'REPLAY_RUN_ROLE_PROVENANCE_BLOCKED: reconcile each run with its frozen dataset role; do not trust embedded DISCOVERY labels or rewrite history.'
      : paperProvenanceIssueCount
      ? 'PAPER_PROVENANCE_BLOCKED: qualify future Paper evidence using an approved producer and explicit role; do not backfill missing historical facts.'
      : detector.next_action||detector.sufficiency.blockers.map(item=>item.code).join(', ');
    const state={schema_version:VWAP_MONITOR_SCHEMA,strategy_id:config.strategy_id,strategy_name:config.strategy_name||'VWAP Pullback',enabled:true,status:'HEALTHY',
      initialized_at_utc:previous.initialized_at_utc||checkedAt,last_checked_at_utc:checkedAt,last_database_interrogation_at_utc:checkedAt,last_check_reason:reason,
      skipped_unchanged:false,database_query_count:Number(previous.database_query_count||0)+1,database_signature:signature,
      sources:sources.map(item=>({id:item.source.id,environment:item.source.environment,account:item.source.account,database_path:item.source.database_path,
        observed_trade_count:item.rows.filter(row=>!row.foreign_account).length,
        eligible_trade_count:eligibleRows.filter(row=>item.rows.some(observed=>!observed.foreign_account
          &&observed.run_id===row.run_id&&(observed.source_trade_id===row.trade_id||observed.trade_id===row.trade_id))).length,
        declared_identity_complete_trade_count:item.rows.filter(declaredComplete).length,
        foreign_account_trade_count:item.rows.filter(row=>row.foreign_account).length,
        role_issue_count:item.rows.filter(row=>!row.foreign_account&&isRunRoleIssue(row)).length,
        latest_trade_id:item.rows.filter(row=>!row.foreign_account).at(-1)?.trade_id||null})),
      observed_trade_count:rows.length,foreign_account_trade_count:foreignAccountRows.length,eligible_trade_count:eligibleRows.length,new_trade_count:baseline?0:newIds.length,last_observed_new_trade_ids:baseline?[]:newIds,
      newly_eligible_trade_count:baseline?0:newlyEligibleIds.length,last_newly_eligible_trade_ids:baseline?[]:newlyEligibleIds,
      observed_trade_ids:[...ids].sort(),eligible_trade_ids:eligibleIds,eligible_evidence_fingerprint:eligibleFingerprint,
      discovery_admission_signature:admissionSignature,
      discovery_admission:{admitted:verifiedRows.length>0,publication_sha256:admissionState?.publication_sha256||null,
        report_sha256:admissionState?.admission?.report_sha256||null,
        semantic_admission:admissionValid?admissionState.admission.semantic_admission:null,
        blockers:[...(admissionState?.blockers||[]),...currentAdmission.blockers],
        authority:verifiedRows.length?'AUTHENTICATED_DISCOVERY_ORIGINALS':'UNPROVED'},
      run_contract_publication:publication,
      detector,disposition:detector.disposition,next_action:nextAction,
      account_scope_anomaly_action:foreignAccountRows.length?'FOREIGN_ACCOUNT_ROWS_EXCLUDED: verify the telemetry producer and account binding; do not import these rows into this account evidence.':null,
      role_issue_count:roleIssueCount,paper_provenance_issue_count:paperProvenanceIssueCount,baseline_applied:baseline,
      current_phase:null,current_source_id:null,
      last_trigger_receipt:receipt||previous.last_trigger_receipt||null,last_triggered_analysis_hash:lastHash,
      last_triggered_evidence_blocker_hash:lastEvidenceBlockerHash,pending_dispatch:pendingDispatch,consecutive_failures:0,last_error:null,
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
    const inProgress=readJson(stateFile,previous)||previous;
    const state={...inProgress,schema_version:VWAP_MONITOR_SCHEMA,strategy_id:config.strategy_id,enabled:true,status:'DEGRADED',last_checked_at_utc:checkedAt,last_check_reason:reason,skipped_unchanged:false,
      consecutive_failures:consecutiveFailures,last_error:errorText,last_failure_trigger_receipt:failureReceipt,last_triggered_failure_event_id:lastFailureId,last_dispatch_error:dispatchError,
      current_phase:null,current_source_id:null,
      recent_events:[...(previous.recent_events||[]),{at_utc:checkedAt,reason,database_query:true,error:errorText,trigger:failureReceipt,dispatch_error:dispatchError}].slice(-25),safety:config.safety};
    writeJson(stateFile,state);return state;
  }
}

export function readVwapContinuousImprovementState(stateFile) {
  return readJson(stateFile,{schema_version:VWAP_MONITOR_SCHEMA,strategy_id:VWAP_STRATEGY_ID,enabled:false,status:'NOT_STARTED',disposition:'UNKNOWN',sources:[],recent_events:[]});
}
