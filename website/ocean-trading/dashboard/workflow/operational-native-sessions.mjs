import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { objectHash, requireThat } from './common.mjs';

export const SESSION_SCHEMA='ocean-native-entry-trading-days/v1';
export const SESSION_MODE='sierra_trading_day_v1';
export const SESSION_DEFINITION='UNION_OF_NATIVE_ENTRY_TRADING_DAY_UNITS_KEYED_BY_VERIFIED_CONFIGURATION_AND_DATE_NOT_IID_OR_FULL_COVERAGE';
// Append separately reviewed releases; retain past entries for immutable observations.
export const NATIVE_LOGGER_BUILDS=Object.freeze([Object.freeze({version:'v0.5.45',
  module_sha256:'c3dea9e08b2b4ed2c827a2e0ad37f85f09f8939b0c9e70945021eecda07b038a',
  source_commit:'b1fb6e642d6a40cb9dac1c295895c2c48d28b2f4',
  contract:'schema14-native-session-producer-pin',runtime_deployment_authorized:false}),Object.freeze({version:'v0.5.46',
  module_sha256:'51b7302398456de3022d98f669141cdf752b46fc13acde48be6ccc19c97210ad',
  source_commit:'123abc72c65b01946a0ca13ec862e30050315e7a',
  contract:'schema14-native-session-producer-pin-v238-candidate-binding',runtime_deployment_authorized:false})]);
export const NATIVE_LOGGER_BUILD=NATIVE_LOGGER_BUILDS[0];
const settings=['chart_timezone','start_time1','end_time1','start_time2','end_time2','use_second_start_end_times','trading_day_starts_previous_date'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const rawHash=value=>String(value || '').replace(/^sha256:/,'').toLowerCase();
const samePath=(a,b)=>typeof a==='string' && typeof b==='string' && a.replaceAll('\\','/').toLowerCase()===b.replaceAll('\\','/').toLowerCase();
const finite=value=>value!=null && value!=='' && Number.isFinite(Number(value));
export function criticalNativeSessionFlags(value) {
  return String(value || '').split('|').filter(Boolean).filter(flag=>flag!=='native_session_mapping_only');
}
const epoch=Date.UTC(1899,11,30),dayMs=86400000;
const lastFourDigitDate=(Date.UTC(9999,11,31)-epoch)/dayMs;
export function nativeDateLabel(value) {
  requireThat(Number.isInteger(value) && value>0 && value<=lastFourDigitDate,409,'NATIVE_SESSION_DATE_VALUE_ENCODING_REQUIRED');
  return new Date(epoch+value*dayMs).toISOString().slice(0,10);
}

export function nativeConfigurationHash(row) {
  requireThat(typeof row.chart_timezone==='string' && row.chart_timezone.length>0
    && settings.slice(1).every(key=>Number.isInteger(row[key]))
    && settings.slice(1,5).every(key=>row[key]>=0 && row[key]<86400)
    && [0,1].includes(row.use_second_start_end_times) && [0,1].includes(row.trading_day_starts_previous_date),
  409,'NATIVE_SESSION_SETTINGS_REQUIRED');
  return sha(settings.map(key=>row[key]).join('|'));
}

// Dates and fills stay in Sierra's chart-native time basis. No UTC conversion is
// inferred, and zero-trade rows or exit-only days never increase this count.
export function checkNativeSessionProof(proof,context,rows) {
  requireThat(proof?.schema_version===SESSION_SCHEMA && proof.context?.run_id===context.run_id
    && proof.context.context_hash===context.context_hash && proof.run?.run_id===context.run_id
    && rawHash(proof.managed_context?.context_hash)===rawHash(context.context_hash)
    && proof.managed_context?.session_observation_mode===SESSION_MODE,409,'NATIVE_SESSION_CONTEXT_CONFLICT');
  const {run,attempt}=proof;
  requireThat(attempt?.run_id===run.run_id && Number.isInteger(attempt.attempt_id) && attempt.start_command_id
    && attempt.attempt_ended_utc && run.run_ended_utc && attempt.attempt_started_utc
    && Number.isInteger(attempt.starting_trade_id) && Number.isInteger(attempt.starting_fill_id),
  409,'NATIVE_SESSION_ACCEPTED_COMPLETED_ATTEMPT_REQUIRED');
  const receipts=proof.receipts.filter(receipt=>receipt.attempt_id===attempt.attempt_id);
  requireThat(receipts.length===1 && receipts[0].run_id===run.run_id && receipts[0].instance_id===run.instance_id
    && receipts[0].closed_trade_count===rows.length && receipts[0].trade_count===rows.length
    && !receipts[0].data_quality_flags,409,'NATIVE_SESSION_COMPLETION_RECEIPT_CONFLICT');
  const observations=new Map(proof.observations.map(row=>[row.session_observation_id,row]));
  requireThat(observations.size===proof.observations.length,409,'NATIVE_SESSION_DUPLICATE_OBSERVATION');
  const actual=new Map(rows.map(row=>[String(row.trade_id),row])),entries=new Map(),exits=[];
  requireThat(actual.size===rows.length && proof.trades.length===rows.length,409,'NATIVE_SESSION_EXACT_TRADES_REQUIRED');
  const used=new Map();
  for(const trade of proof.trades) {
    const row=actual.get(String(trade.trade_id));
    requireThat(row && trade.run_id===run.run_id && trade.trade_id>attempt.starting_trade_id
      && trade.instance_id===run.instance_id && trade.instance_role==='replay' && trade.is_simulated===1
      && trade.trade_account===row.trade_account && trade.symbol===row.symbol
      && finite(trade.entry_datetime) && Number(trade.entry_datetime)===Number(row.entry_datetime)
      && String(trade.status).toLowerCase()==='closed',409,'NATIVE_SESSION_TRADE_SCOPE_CONFLICT');
    for(const role of ['entry','exit']) {
      const links=proof.links.filter(link=>link.trade_id===trade.trade_id && link.link_role===role);
      if(role==='exit' && !links.length){exits.push({trade_id:trade.trade_id,status:'MISSING_FINAL_EXIT_MAPPING'});continue;}
      requireThat(links.length===1,409,'NATIVE_SESSION_EXACT_ENTRY_LINK_REQUIRED');
      const link=links[0],observation=observations.get(link.session_observation_id);
      const at=Number(role==='entry'?trade.entry_datetime:trade.exit_datetime);
      requireThat(observation && observation.run_id===run.run_id && observation.attempt_id===attempt.attempt_id
        && observation.instance_id===trade.instance_id && observation.instance_role==='replay'
        && observation.trade_account===trade.trade_account && observation.symbol===trade.symbol
        && observation.trade_symbol===trade.trade_symbol && samePath(observation.chartbook,run.chartbook)
        && observation.chart_number===run.chart_number && observation.session_observation_mode===SESSION_MODE
        && link.provenance_source==='sierra_native_callback' && observation.provenance_source==='sierra_native_callback'
        && Number(link.source_fill_datetime)===at && Number.isFinite(at)
        && Number.isInteger(observation.trading_day_date) && observation.trading_day_date>0
        && finite(observation.trading_day_start_datetime) && observation.trading_day_start_datetime<=at
        && observation.rewind_observed===0 && observation.fill_cursor_reset_observed===0 && observation.coverage_gap_observed===0
        && criticalNativeSessionFlags(observation.data_quality_flags).length===0,
      409,'NATIVE_SESSION_LINK_SCOPE_OR_TIME_CONFLICT');
      requireThat(nativeConfigurationHash(observation)===rawHash(observation.session_config_hash),409,'NATIVE_SESSION_CONFIGURATION_HASH_CONFLICT');
      nativeDateLabel(observation.trading_day_date);
      requireThat(observation.consumer_coverage_status==='mapping_only'
        && ['native_session_coverage_complete','zero_trade_coverage_verified','statistical_independence_verified','brain_eligible']
          .every(key=>observation[key]===0),409,'NATIVE_SESSION_MAPPING_ONLY_CONTRACT_REQUIRED');
      const fills=proof.fills.filter(fill=>fill.trade_id===trade.trade_id && (role==='entry'
        ?fill.leg_type==='entry':['final_exit','position_flip_exit'].includes(fill.leg_type))
        && fill.fill_id>attempt.starting_fill_id && fill.run_id===trade.run_id && fill.instance_id===trade.instance_id
        && fill.trade_account===trade.trade_account && fill.symbol===trade.symbol && fill.is_simulated===1
        && Number(fill.fill_datetime)===at && Number(fill.leg_fill_datetime)===at);
      requireThat(fills.length>0,409,'NATIVE_SESSION_ACTUAL_FILL_JOIN_REQUIRED');
      if(role==='entry') {
        requireThat(!entries.has(String(trade.trade_id)),409,'NATIVE_SESSION_DUPLICATE_TRADE');
        const entry={trade_id:trade.trade_id,run_id:trade.run_id,entry_datetime:at,trade_account:trade.trade_account,symbol:trade.symbol,
          trading_day_date:observation.trading_day_date,trading_day_start_datetime:observation.trading_day_start_datetime,
          session_config_hash:rawHash(observation.session_config_hash),chart_timezone:observation.chart_timezone};
        entries.set(String(trade.trade_id),entry);used.set(observation.session_observation_id,observation);
      } else exits.push({trade_id:trade.trade_id,status:'FINAL_EXIT_MAPPING_VERIFIED',trading_day_date:observation.trading_day_date});
    }
  }
  requireThat(entries.size===rows.length,409,'NATIVE_SESSION_EXACT_TRADES_REQUIRED');
  return {entries:[...entries.values()],observations:[...used.values()],exit_audit:exits};
}

export function sessionEvidence(bundle,rows) {
  const sessions=new Map(),entries=new Map(),missing=[],conflicts=[],producerGaps=[],configs=new Set(),exits=[];
  for(const run of bundle.cohort.eligible_runs) {
    const proof=bundle.execution_sessions?.[run.run_id];
    if(!proof){missing.push(run.run_id);continue;}
    try {
      requireThat(!proof.proof_error,409,proof.proof_error || 'NATIVE_SESSION_SOURCE_REQUIRED');
      const checked=checkNativeSessionProof(proof,proof.context,rows.filter(row=>row.run_id===run.run_id));
      if(proof.producer_verification?.verified!==true)producerGaps.push({run_id:run.run_id,
        reason:proof.producer_verification?.reason || 'NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED'});
      exits.push(...checked.exit_audit.map(exit=>({run_id:run.run_id,...exit})));
      for(const entry of checked.entries) {
        entries.set(`${run.run_id}:${entry.trade_id}`,entry);configs.add(entry.session_config_hash);
        const key=`${entry.session_config_hash}:${entry.trading_day_date}`,start=entry.trading_day_start_datetime;
        requireThat(!sessions.has(key) || sessions.get(key).start===start,409,'NATIVE_SESSION_DAY_START_CONFLICT');
        sessions.set(key,{date:entry.trading_day_date,start});
      }
    }catch(error){conflicts.push({run_id:run.run_id,reason:error.code || 'NATIVE_SESSION_PROOF_CONFLICT'});}
  }
  if(configs.size>1)conflicts.push({reason:'NATIVE_SESSION_COMPARABLE_CONFIGURATION_CONFLICT'});
  const units=[...sessions.values()].sort((a,b)=>a.date-b.date);
  if(units.some((unit,index)=>index>0 && unit.start<=units[index-1].start))conflicts.push({reason:'NATIVE_SESSION_PARTITION_ORDER_CONFLICT'});
  for(const entry of entries.values()) {
    const next=units.find(unit=>unit.date>entry.trading_day_date);
    if(next && entry.entry_datetime>=next.start)conflicts.push({run_id:entry.run_id,reason:'NATIVE_SESSION_PARTITION_MAPPING_CONFLICT'});
  }
  const mappingVerified=missing.length===0 && conflicts.length===0,verified=mappingVerified && producerGaps.length===0;
  return {verified,mapping_verified:mappingVerified,verification_status:verified?'NATIVE_ENTRY_DAY_UNION_VERIFIED':'UNVERIFIED',
    observed_session_count:verified?sessions.size:0,mapped_entry_day_count:mappingVerified?sessions.size:null,
    session_config_hash:configs.size===1?[...configs][0]:null,missing_run_ids:missing,conflicts:[...conflicts,...producerGaps],entries,
    exit_audit:exits,statistical_independence_verified:false,zero_trade_coverage_verified:false,
    full_market_session_coverage_verified:false,market_coverage_status:'MAPPING_ONLY_NOT_COMPLETE_MARKET_COVERAGE',basis:SESSION_DEFINITION};
}

function recordedProducerVerification(backend,workflowRun,run,attempt,observations,qualification,trades) {
  const metadata={reviewed_build:null,reviewed_build_catalog_hash:objectHash(NATIVE_LOGGER_BUILDS),recorded_hashes:[],
    next_action:'The existing Telemetry/deployment owner must install only the reviewed producer build through the controlled instance lifecycle, pin the existing bridge, and collect fresh managed native observations. No old row is backfilled.'};
  try {
    if(!trades.length)return {...metadata,verified:true,basis:'NO_SCORED_ENTRY_UNITS_NO_SESSION_COUNT_GRANTED'};
    const rows=observations.filter(row=>row.attempt_id===attempt?.attempt_id);
    requireThat(rows.length>0 && rows.every(row=>row.logger_module_provenance_status==='recorded'
      && /^[a-fA-F0-9]{64}$/.test(row.logger_module_sha256 || '')),409,'NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED');
    metadata.recorded_hashes=[...new Set(rows.map(row=>rawHash(row.logger_module_sha256)))];
    const reviewed=metadata.recorded_hashes.length===1
      ?NATIVE_LOGGER_BUILDS.find(build=>build.module_sha256===metadata.recorded_hashes[0]):null;
    requireThat(reviewed && run.study_name===`Sierra Trade Telemetry Logger ${reviewed.version}`,
    409,'NATIVE_LOGGER_REVIEWED_PRODUCER_BUILD_CONFLICT');
    metadata.reviewed_build=reviewed;
    const binding=JSON.parse(fs.readFileSync(backend.operationalLearning.physicalBindingFile,'utf8'));
    const physical=qualification.telemetry.physical_strategy_binding;
    requireThat(binding.schema_version==='ocean-replay-run-bridge/v4' && binding.namespace==='OPERATIONAL'
      && binding.strategy_id===workflowRun.strategy_id && binding.instance_id===workflowRun.instance_id
      && physical?.verified && physical.factual_binding_hash===binding.factual_binding_hash
      && physical.recorded_sierra_instance_id===run.instance_id,
    409,'NATIVE_LOGGER_APPROVED_PHYSICAL_BINDING_CONFLICT');
    // A current logger upgrade cannot invalidate recorded producer proof. The
    // runner checks current loaded/disk pins before start, not this historical read.
    const scope={schema_version:binding.schema_version,namespace:binding.namespace,strategy_id:binding.strategy_id,
      instance_id:binding.instance_id,factual_binding_hash:binding.factual_binding_hash,
      recorded_sierra_instance_id:physical.recorded_sierra_instance_id};
    return {...metadata,verified:true,basis:'RECORDED_OWN_LOGGER_HASH_AND_VERSIONED_REVIEWED_BUILD_AND_EXACT_PHYSICAL_SCOPE_AGREE',
      factual_binding_hash:binding.factual_binding_hash,binding_hash:objectHash(scope)};
  }catch(error) {return {...metadata,verified:false,reason:error.code || 'NATIVE_LOGGER_APPROVED_PHYSICAL_BINDING_REQUIRED'};}
}

export function nativeSourceReceiptHash(proof) {
  const source=Object.fromEntries(['run','managed_context','attempt','receipts','observations','trades','links','fills'].map(key=>[key,proof[key]]));
  const verification=proof.producer_verification;
  // Catalog-wide metadata describes the reader, not unchanged historical facts.
  const producer_verification=Object.fromEntries(['verified','reason','basis','reviewed_build','recorded_hashes',
    'factual_binding_hash','binding_hash'].map(key=>[key,verification[key] ?? null]));
  return objectHash({source,producer_verification});
}

export function readObservedSessionProofs(backend,runIds,rows=[]) {
  const proofs={};let database,transaction=false;
  try {
    const filename=backend.operationalLearning?.telemetryDb;
    requireThat(filename && fs.existsSync(filename),409,'NATIVE_SESSION_DATABASE_REQUIRED');
    database=new DatabaseSync(filename,{readOnly:true,timeout:2000});
    database.exec('BEGIN');
    transaction=true;
    requireThat(database.prepare('SELECT COALESCE(MAX(version),0) version FROM schema_version').get().version>=14,
      409,'NATIVE_SESSION_SCHEMA_14_REQUIRED');
    for(const run_id of runIds) {
      const workflowRun=backend.one('ow_runs',run_id),context=JSON.parse(workflowRun.context_json);
      try {
        const qualification=backend.operationalLearning.classification(backend.one('ow_runs',run_id));
        requireThat(qualification.eligible && qualification.telemetry?.verified && !qualification.telemetry.bypassed,
          409,'NATIVE_SESSION_EXISTING_PHYSICAL_RAW_QUALIFICATION_REQUIRED');
        const run=database.prepare('SELECT * FROM replay_runs WHERE run_id=?').get(run_id);
        const managed_context=database.prepare('SELECT * FROM replay_run_context WHERE run_id=?').get(run_id);
        const attempt=database.prepare('SELECT * FROM replay_run_attempts WHERE run_id=? ORDER BY attempt_number DESC LIMIT 1').get(run_id);
        const receipts=database.prepare('SELECT * FROM telemetry_run_receipts WHERE run_id=? ORDER BY attempt_id').all(run_id);
        const observations=database.prepare('SELECT * FROM ocean_exchange_session_observations_v1 WHERE run_id=? ORDER BY session_observation_id').all(run_id);
        const trades=database.prepare("SELECT * FROM trades WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id").all(run_id);
        const links=database.prepare('SELECT l.* FROM trade_exchange_session_links l JOIN trades t ON t.trade_id=l.trade_id WHERE t.run_id=? ORDER BY l.trade_id,l.link_role').all(run_id);
        const fills=database.prepare(`SELECT f.*,l.trade_id,l.leg_type,l.fill_datetime leg_fill_datetime FROM trade_legs l JOIN fills f
          ON f.run_id=l.run_id AND f.instance_id=l.instance_id AND f.trade_account=l.trade_account AND f.symbol=l.symbol
          AND f.internal_order_id=l.internal_order_id AND f.fill_datetime=CAST(l.fill_datetime AS REAL)
          AND f.quantity=l.quantity AND f.fill_price=l.fill_price WHERE l.run_id=? ORDER BY l.leg_id,f.fill_id`).all(run_id);
        const producer_verification=recordedProducerVerification(backend,workflowRun,run,attempt,observations,qualification,trades);
        const source={run,managed_context,attempt,receipts,observations,trades,links,fills};
        const proof={schema_version:SESSION_SCHEMA,context,...source,producer_verification,
          source_receipt_hash:nativeSourceReceiptHash({...source,producer_verification}),source_record_refs:['replay_run_context','replay_run_attempts','telemetry_run_receipts',
            'ocean_exchange_session_observations_v1','trade_exchange_session_links','trades','trade_legs','fills']};
        checkNativeSessionProof(proof,context,rows.filter(row=>row.run_id===run_id));proofs[run_id]=proof;
      }catch(error){proofs[run_id]={context,proof_error:error.code || 'NATIVE_SESSION_TABLE_OR_FIELD_REQUIRED'};}
    }
  }catch(error) {
    for(const run_id of runIds)proofs[run_id]={proof_error:error.code || 'NATIVE_SESSION_TABLE_OR_FIELD_REQUIRED'};
  }finally {if(database){try{if(transaction)database.exec('ROLLBACK');}finally{database.close();}}}
  return proofs;
}
