import { objectHash, requireThat } from './common.mjs';

export const RESEARCH_V5='ocean-cumulative-research/v5';
export const PROTOCOL_VERSION='ocean-calendar-direction-discovery/v1';
export const SESSION_SCHEMA='ocean-observed-execution-sessions/v1';
// Internal normalized evidence, not a logger wire contract or a new run-context field.
export const NATIVE_SESSION_INTEGRATION=Object.freeze({status:'INTEGRATION_DUE',
  reason:'NATIVE_SESSION_ADAPTER_INTEGRATION_DUE',
  owner:'OCEAN_RESEARCH_ENGINEERING_AND_INSTANCE_TELEMETRY_OWNER',
  next_action:'Map and test the reviewed additive native logger contract against its exact pinned receipt and source configuration before deployment acceptance.'});
export const REASSESSMENT_ORIGIN='OPERATIONAL_RESEARCH_REASSESSMENT';
export const screeningPolicy=Object.freeze({minimum_distinct_declared_periods:3,
  minimum_direction_trades_per_calendar_block:10,positive_net_exclusion_required_in_every_retained_run:true,
  sampling_unit:'PREDECLARED_EUROPE_LONDON_CALENDAR_MONTH',
  basis:'PROSPECTIVE_ENGINEERING_SCREEN_NOT_STATISTICALLY_CALIBRATED_NOT_APPROVED_EVIDENCE_POLICY'});
const zone='Europe/London';
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
const localDate=ms=>Object.fromEntries(dateFormat.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
const month=ms=>{const p=localDate(ms);return `${p.year}-${p.month}`;};
function midnight(year,m) {
  const desired=Date.UTC(year,m-1,1);let result=desired;
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit'});
  for(let i=0;i<3;i++) {
    const p=Object.fromEntries(format.formatToParts(new Date(result)).map(part=>[part.type,part.value]));
    result+=desired-Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour));
  }
  return result;
}
function bounds(key) {
  const [y,m]=key.split('-').map(Number);
  return {start:midnight(y,m),end:midnight(m===12?y+1:y,m===12?1:m+1)};
}
const iso=ms=>new Date(ms).toISOString();
const sum=rows=>Math.round(rows.reduce((n,row)=>n+Number(row.net_profit_loss),0)*100)/100;

// The unit rule is fixed before reading returns. Contract rollover is a child
// stratum, never an extra independent observation or a result-selected boundary.
export function calendarBlocks(bundle) {
  const map=new Map(),missing=[];
  for(const run of bundle.cohort.eligible_runs) {
    const ranges=bundle.research_coverage?.[run.run_id];
    if(!Array.isArray(ranges) || !ranges.length){missing.push(run.run_id);continue;}
    for(const range of ranges) {
      const start=Date.parse(range.start_utc),end=Date.parse(range.end_utc);
      if(!Number.isFinite(start) || !Number.isFinite(end) || start>=end){missing.push(run.run_id);continue;}
      for(let at=start;at<end;) {
        const key=month(at),edge=bounds(key),stop=Math.min(end,edge.end);
        if(!map.has(key))map.set(key,{block_id:key,start:edge.start,end:edge.end,children:[]});
        map.get(key).children.push({run_id:run.run_id,start:at,end:stop});at=stop;
      }
    }
  }
  const blocks=[...map.values()].sort((a,b)=>a.start-b.start).map(block=>{
    let end=block.start;const gaps=[];
    for(const child of [...block.children].sort((a,b)=>a.start-b.start || a.end-b.end)) {
      if(child.start>end)gaps.push({start_utc:iso(end),end_utc:iso(child.start)});
      end=Math.max(end,child.end);
    }
    if(end<block.end)gaps.push({start_utc:iso(end),end_utc:iso(block.end)});
    return {block_id:block.block_id,start_utc:iso(block.start),end_utc:iso(block.end),complete:gaps.length===0,gaps,
      child_strata:block.children.map(child=>({run_id:child.run_id,start_utc:iso(child.start),end_utc:iso(child.end)}))};
  });
  return {blocks,missing_run_ids:[...new Set(missing)].sort()};
}

export function checkSessionObservation(observation,context,rows,calendarBinding) {
  requireThat(observation?.schema_version===SESSION_SCHEMA && observation.run_id===context.run_id
    && observation.context_hash===context.context_hash && observation.calendar?.timezone===zone
    && calendarBinding?.revision && observation.calendar.revision===calendarBinding.revision
    && observation.calendar.source_config_hash?.match(/^sha256:[a-f0-9]{64}$/)
    && observation.calendar.source_config_hash===calendarBinding.source_config_hash
    && observation.calendar.chart_settings_hash===calendarBinding.chart_settings_hash
    && observation.calendar.effective_chart_timezone===calendarBinding.effective_chart_timezone
    && observation.calendar.timezone===calendarBinding.timezone
    && observation.calendar.mapping_method==='SIERRA_NATIVE_TRADING_DAY_AND_UTC_CONVERSION'
    && observation.calendar.trading_day_method==='sc.GetTradingDayDate'
    && observation.calendar.utc_method==='sc.ConvertDateTimeFromChartTimeZone'
    && observation.calendar.chart_settings_hash?.match(/^sha256:[a-f0-9]{64}$/)
    && typeof observation.calendar.effective_chart_timezone==='string'
    && observation.calendar.effective_chart_timezone.length>0,409,'OBSERVED_SESSION_CALENDAR_PROOF_REQUIRED');
  const actual=new Map(rows.map(row=>[String(row.trade_id),row])),seen=new Set();
  requireThat(Array.isArray(observation.entries) && observation.entries.length===rows.length,409,'OBSERVED_SESSION_EXACT_TRADES_REQUIRED');
  const sessions=new Map();
  for(const entry of observation.entries) {
    const row=actual.get(String(entry.trade_id)),start=Date.parse(entry.session_start_utc),end=Date.parse(entry.session_end_utc),at=Date.parse(entry.entry_utc);
    requireThat(row && !seen.has(String(entry.trade_id)) && Number(entry.entry_datetime)===Number(row.entry_datetime)
      && entry.trade_account===row.trade_account && entry.symbol===row.symbol
      && Number.isFinite(at) && Number.isFinite(start) && Number.isFinite(end) && start<=at && at<end
      && end-start<=86400000+3600000 && end>start && /^\d{4}-\d{2}-\d{2}$/.test(entry.trading_day_date),
    409,'OBSERVED_SESSION_TRADE_MAPPING_CONFLICT');
    seen.add(String(entry.trade_id));
    const key=`${observation.calendar.revision}:${entry.trading_day_date}`;
    const interval={start_utc:entry.session_start_utc,end_utc:entry.session_end_utc};
    requireThat(!sessions.has(key) || objectHash(sessions.get(key))===objectHash(interval),409,'OBSERVED_SESSION_IDENTITY_CONFLICT');
    sessions.set(key,interval);
  }
  return observation;
}

export function sessionEvidence(bundle,rows) {
  const sessions=new Map(),entries=new Map(),missing=[],conflicts=[];
  for(const run of bundle.cohort.eligible_runs) {
    const proof=bundle.execution_sessions?.[run.run_id];
    if(!proof){missing.push(run.run_id);continue;}
    try {
      requireThat(!proof.proof_error,409,proof.proof_error || 'OBSERVED_SESSION_PROOF_CONFLICT');
      requireThat(proof.native_contract_verified===true && proof.native_contract_receipt_hash?.match(/^sha256:[a-f0-9]{64}$/),
        409,'SUPPORTED_NATIVE_SESSION_PRODUCER_CONTRACT_REQUIRED');
      requireThat(proof.context?.run_id===run.run_id,409,'OBSERVED_SESSION_RUN_IDENTITY_CONFLICT');
      checkSessionObservation(proof.observation,proof.context,rows.filter(row=>row.run_id===run.run_id),proof.calendar_binding);
      requireThat(proof.source_receipt_ref && proof.source_receipt_hash?.match(/^sha256:[a-f0-9]{64}$/),409,'OBSERVED_SESSION_PRODUCER_RECEIPT_REQUIRED');
      for(const entry of proof.observation.entries) {
        entries.set(`${run.run_id}:${entry.trade_id}`,entry);
        const key=`${proof.observation.calendar.revision}:${entry.trading_day_date}`;
        const interval={start:Date.parse(entry.session_start_utc),end:Date.parse(entry.session_end_utc)};
        requireThat(!sessions.has(key) || objectHash(sessions.get(key))===objectHash(interval),409,'OBSERVED_SESSION_IDENTITY_CONFLICT');
        sessions.set(key,interval);
      }
    }catch(error){conflicts.push({run_id:run.run_id,reason:error.code || 'OBSERVED_SESSION_PROOF_CONFLICT'});}
  }
  const intervals=[...sessions.values()].sort((a,b)=>a.start-b.start);
  if(intervals.some((entry,i)=>i>0 && entry.start<intervals[i-1].end))conflicts.push({reason:'OBSERVED_SESSION_OVERLAP'});
  return {verified:missing.length===0 && conflicts.length===0,observed_session_count:sessions.size,
    verification_status:missing.length===0 && conflicts.length===0?'OBSERVED_NATIVE_MAPPING_VERIFIED':'UNVERIFIED',
    missing_run_ids:missing,conflicts,entries,statistical_independence_verified:false,
    basis:'UNION_OF_EXACT_PRODUCER_OBSERVED_DISJOINT_TRADING_DAY_INTERVALS_NOT_CALENDAR_DATE_FLOORS'};
}

export function readObservedSessionProofs(backend,runIds) {
  // No native adapter is installed in this source revision. Neither caller
  // assertions, fabricated events nor new fields on old contexts can replace it.
  return Object.fromEntries(runIds.map(run_id=>[run_id,{
    context:JSON.parse(backend.one('ow_runs',run_id).context_json),
    proof_error:NATIVE_SESSION_INTEGRATION.reason,integration:NATIVE_SESSION_INTEGRATION
  }]));
}

export function coverageOverlaps(coverage) {
  const conflicts=[],runs=Object.entries(coverage || {});
  for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++) {
    const intervals=[];
    for(const a of runs[i][1] || [])for(const b of runs[j][1] || []) {
      const start=Math.max(Date.parse(a.start_utc),Date.parse(b.start_utc)),end=Math.min(Date.parse(a.end_utc),Date.parse(b.end_utc));
      if(Number.isFinite(start) && Number.isFinite(end) && start<end)intervals.push({start_utc:iso(start),end_utc:iso(end)});
    }
    if(intervals.length)conflicts.push({run_ids:[runs[i][0],runs[j][0]],intervals,
      reason:'DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN',records_retained:true});
  }
  return conflicts;
}

export function remediationV5(sufficiency) {
  const actions=[];
  if(sufficiency.reasons?.includes('APPROVED_AGGREGATE_TRADE_FLOOR_NOT_MET'))actions.push('Obtain further qualified DISCOVERY executions against the unchanged approved aggregate trade floor.');
  if(sufficiency.session_proof_missing_run_ids?.length || sufficiency.session_conflicts?.length)actions.push('The exact instance TELEMETRY owner must supply native chart trading-day/UTC mappings, session intervals and chart-settings proof for every retained closed trade through the reviewed native logger contract. Current chart timezone or signal labels alone are insufficient.');
  if(sufficiency.session_conflicts?.some(item=>['NATIVE_SESSION_ADAPTER_INTEGRATION_DUE','SUPPORTED_NATIVE_SESSION_PRODUCER_CONTRACT_REQUIRED'].includes(item.reason)))actions.push(`${NATIVE_SESSION_INTEGRATION.next_action} The v543 source audit proves it cannot supply these native facts. Calendar revision/hash must be pinned from that native receipt/configuration, not added to immutable run-context2.1. This is an integration-due core, not a completed native-session repair.`);
  if(sufficiency.reasons?.includes('DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN'))actions.push('Resolve exact overlap/duplicate-observation provenance prospectively. All executed rows and contradictions remain in accounting; overlapping coverage cannot supply aggregate support by repeated counting.');
  if(sufficiency.reasons?.includes('APPROVED_AGGREGATE_SESSION_FLOOR_NOT_MET'))actions.push('After exact observed session mapping is verified, obtain additional qualified discovery sessions if the union still falls below the approved session floor.');
  if(sufficiency.missing_distinct_block_count)actions.push(`Obtain ${sufficiency.missing_distinct_block_count} additional complete, predeclared qualified calendar discovery block(s), then rerun Research; operational contract segments are not independent periods.`);
  if(sufficiency.incomplete_blocks?.length || sufficiency.missing_coverage_run_ids?.length)actions.push('Verify or complete the already declared discovery coverage; do not discard retained child strata or move boundaries after seeing outcomes.');
  if(sufficiency.sample_shortfalls?.length)actions.push('The Research engineering owner must author and test a prospective sampling/protocol revision for the frozen calendar-block sample shortfall. Later months cannot increase a frozen block count. Existing engineering authorization covers this design work; preserve every contradiction and the approved 50/20 policy, and do not tune from holdout results.');
  return {status:actions.length?'QUALIFIED_EVIDENCE_OR_PROTOCOL_WORK_REQUIRED':'NOT_REQUIRED',
    requires_design_review:Boolean(sufficiency.sample_shortfalls?.length),policy_change_authorized:false,
    protocol_engineering_authorized:true,additional_discovery_can_resolve_fixed_sample_shortfalls:false,
    missing_distinct_coverage_count:sufficiency.missing_distinct_block_count || 0,
    frozen_sample_shortfalls:sufficiency.sample_shortfalls || [],next_action:actions.join(' ') || 'The scoped entry-direction screen is assessed; no candidate testing is implied.'};
}

export function evaluateV5(bundle,rows,accounting) {
  const calendar=calendarBlocks(bundle),sessions=sessionEvidence(bundle,rows),policy=bundle.approved_evidence_policy;
  const approved=policy?.status==='APPROVED' && Number.isInteger(policy.minimum_comparable_trades)
    && policy.minimum_comparable_trades>0 && Number.isInteger(policy.minimum_independent_sessions)
    && policy.minimum_independent_sessions>0 && policy.maximum_data_quality_issues===0 && policy.contradictory_evidence_tolerance===0;
  const reasons=[];
  if(!approved)reasons.push('APPROVED_EVIDENCE_POLICY_PROOF_REQUIRED');
  if(approved && rows.length<policy.minimum_comparable_trades)reasons.push('APPROVED_AGGREGATE_TRADE_FLOOR_NOT_MET');
  if(!sessions.verified)reasons.push('OBSERVED_EXECUTION_SESSION_PROOF_REQUIRED');
  const overlaps=coverageOverlaps(bundle.research_coverage);
  if(overlaps.length)reasons.push('DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN');
  if(approved && sessions.verified && sessions.observed_session_count<policy.minimum_independent_sessions)reasons.push('APPROVED_AGGREGATE_SESSION_FLOOR_NOT_MET');
  const eligibility={status:reasons.length?'INSUFFICIENT':'SUFFICIENT',policy:policy || null,policy_hash:policy?objectHash(policy):null,
    observed_comparable_trades:rows.length,observed_session_count:sessions.verified?sessions.observed_session_count:null,
    session_definition:sessions.basis,statistical_independence_verified:false,coverage_overlaps:overlaps,reasons:[...reasons]};
  const complete=calendar.blocks.filter(block=>block.complete);
  if(calendar.missing_run_ids.length)reasons.push('HISTORICAL_COVERAGE_NOT_PROVEN');
  if(calendar.blocks.some(block=>!block.complete))reasons.push('INCOMPLETE_PREDECLARED_CALENDAR_BLOCK');
  if(complete.length<screeningPolicy.minimum_distinct_declared_periods)reasons.push('INSUFFICIENT_PREDECLARED_CALENDAR_BLOCKS');
  const assignment=row=>{
    const entry=sessions.entries.get(`${row.run_id}:${row.trade_id}`);
    if(entry)return month(Date.parse(entry.entry_utc));
    const possible=calendar.blocks.filter(block=>block.child_strata.some(child=>child.run_id===row.run_id));
    return possible.length===1?possible[0].block_id:null;
  };
  if(rows.some(row=>{
    const entry=sessions.entries.get(`${row.run_id}:${row.trade_id}`);
    return entry && !calendar.blocks.some(block=>block.child_strata.some(child=>child.run_id===row.run_id
      && Date.parse(child.start_utc)<=Date.parse(entry.entry_utc) && Date.parse(entry.entry_utc)<Date.parse(child.end_utc)));
  }))reasons.push('OBSERVED_ENTRY_OUTSIDE_DECLARED_CHILD_COVERAGE');
  const experiments=accounting.experiments.map(item=>{
    const selected=rows.filter(row=>row.direction===item.value);
    const blocks=calendar.blocks.map(block=>{const group=selected.filter(row=>assignment(row)===block.block_id);
      return {block_id:block.block_id,complete:block.complete,trades:group.length,net_profit_loss:sum(group),observed_exclusion_delta:-sum(group)};});
    const sufficient=reasons.length===0
      && calendar.blocks.every(block=>block.complete) && blocks.every(block=>block.trades>=10);
    const supported=sufficient && item.runs.every(run=>run.observed_exclusion_delta>0);
    return {...item,blocks,evidence_sufficient:sufficient,supported,reason:!sufficient?'INSUFFICIENT_V5_PROTOCOL_EVIDENCE'
      :supported?'REPEATED_EXPLORATORY_DIRECTION_LOSS':'DIRECTION_LOSS_NOT_REPEATED_IN_EVERY_RETAINED_CHILD_STRATUM'};
  });
  const shortfalls=experiments.flatMap(item=>item.blocks.filter(block=>block.trades<10).map(block=>({direction:item.value,
    block_id:block.block_id,observed_trades:block.trades,required_trades:10})));
  if(shortfalls.length)reasons.push('INSUFFICIENT_DIRECTION_SAMPLE_IN_CALENDAR_BLOCK');
  if(!experiments.length)reasons.push('NO_RECORDED_DIRECTION_GROUPS');
  const sufficiency={status:reasons.length?'INSUFFICIENT':'SUFFICIENT',assessment_complete:reasons.length===0,
    scope:'RECORDED_ENTRY_DIRECTION_DISCOVERY_SCREEN_ONLY',reasons,distinct_declared_periods:complete.length,
    missing_distinct_block_count:Math.max(0,3-complete.length),missing_coverage_run_ids:calendar.missing_run_ids,
    incomplete_blocks:calendar.blocks.filter(block=>!block.complete).map(block=>block.block_id),sample_shortfalls:shortfalls,
    session_proof_missing_run_ids:sessions.missing_run_ids,session_conflicts:sessions.conflicts,
    evaluated_direction_values:experiments.filter(item=>item.evidence_sufficient).map(item=>item.value),
    unevaluated_direction_values:experiments.filter(item=>!item.evidence_sufficient).map(item=>item.value)};
  const proposals=experiments.filter(item=>item.supported),remediation=remediationV5(sufficiency);
  return {...accounting,schema_version:RESEARCH_V5,screening_policy:screeningPolicy,
    protocol:{version:PROTOCOL_VERSION,timezone:zone,boundary_selection:'PREDECLARED_CALENDAR_NOT_OUTCOME_SELECTED',
      child_strata_retained:true,all_qualified_rows_retained:true,statistical_independence_verified:false},
    approved_evidence_eligibility:eligibility,evidence_sufficiency:sufficiency,evidence_remediation:remediation,
    historical_periods:{...accounting.historical_periods,basis:'PREDECLARED_CALENDAR_BLOCKS_WITH_RETAINED_OPERATIONAL_CHILD_STRATA',
      distinct_coverage_count:complete.length,blocks:calendar.blocks},experiments,proposals,
    outcome:proposals.length?'EXPLORATORY_PROPOSAL':reasons.length?'INSUFFICIENT_EVIDENCE':'NO_SUPPORTED_CHANGE',
    next_action:proposals.length?'The owned Brain planning worker must freeze the exact non-live direction hypothesis and prospective comparison protocol, assess current scoped capabilities and retain recoverable owner work. No candidate is approved or tested.'
      :reasons.length?`Keep the baseline. This is insufficient evidence, not an evaluated no-change finding. ${remediation.next_action}`
        :'Keep the baseline. The approved aggregate floor and prospective entry-direction screen were assessed; no supported direction exclusion was found. No candidate was built or tested.',
    limitations:[...accounting.limitations,'V5 calendar blocks and the 3/10 discovery screen are prospective implementation policy, not statistically calibrated human-approved thresholds. Disjoint observed trading-day sessions do not prove statistical independence.']};
}
