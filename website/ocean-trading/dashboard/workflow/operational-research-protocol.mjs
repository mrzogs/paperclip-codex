import { objectHash, requireThat } from './common.mjs';
import { sessionEvidence, nativeDateLabel } from './operational-native-sessions.mjs';
export { SESSION_SCHEMA, sessionEvidence, readObservedSessionProofs } from './operational-native-sessions.mjs';

export const RESEARCH_V5='ocean-cumulative-research/v5';
export const RESEARCH_V6='ocean-cumulative-research/v6';
export const PROTOCOL_VERSION='ocean-native-day-direction-discovery/v3';
export const REASSESSMENT_ORIGIN='OPERATIONAL_RESEARCH_REASSESSMENT';
// These inherited, uncalibrated 3/10 checks describe robustness only. They do
// not replace the frozen approved aggregate policy or prevent plan authoring.
export const screeningPolicy=Object.freeze({minimum_distinct_declared_periods:3,
  minimum_direction_trades_per_calendar_block:10,positive_net_exclusion_required_in_every_retained_run:true,
  sampling_unit:'PREDECLARED_CALENDAR_BLOCK_WITH_RETAINED_CONTRACT_CHILDREN',
  role:'ROBUSTNESS_DIAGNOSTIC_NOT_EVIDENCE_ELIGIBILITY_OR_CANDIDATE_ACCEPTANCE',
  basis:'EXISTING_IMPLEMENTATION_POLICY_NOT_STATISTICALLY_CALIBRATED_NOT_APPROVED_EVIDENCE_POLICY'});
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

// Uses sealed accounting counts, including old reports, without recomputing or
// rewriting their returns. A zero-trade remainder is strategy-disable context.
export function directionExclusionExposure(report,proposal) {
  const baseline=report?.aggregate?.trades;
  const counts=Array.isArray(proposal?.runs)?proposal.runs.map(run=>run?.trades):null;
  const valid=Number.isSafeInteger(baseline) && baseline>0 && counts?.length>0
    && counts.every(count=>Number.isSafeInteger(count) && count>=0);
  const excluded=valid?counts.reduce((total,count)=>total+count,0):null;
  const verified=valid && excluded>0 && excluded<=baseline;
  const retained=verified?baseline-excluded:null;
  return {basis:'RECORDED_TRADE_COUNTS_NOT_EXECUTED_FILTER_PERFORMANCE',
    baseline_trades:Number.isSafeInteger(baseline)?baseline:null,excluded_trades:excluded,retained_trades:retained,
    disposition:!verified?'INSUFFICIENT_RETAINED_EXPOSURE_EVIDENCE'
      :retained===0?'RISK_DISABLE_REVIEW_REQUIRED':'ENTRY_FILTER_WITH_RETAINED_EXPOSURE'};
}

export function requireDirectionExclusionExposure(report,proposal) {
  const exposure=directionExclusionExposure(report,proposal);
  requireThat(exposure.disposition==='ENTRY_FILTER_WITH_RETAINED_EXPOSURE',409,
    exposure.retained_trades===0?'ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE':'RETAINED_EXPOSURE_NOT_VERIFIED');
  return exposure;
}

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


export function remediationV6(sufficiency) {
  const actions=[];
  if(sufficiency.reasons?.includes('APPROVED_AGGREGATE_TRADE_FLOOR_NOT_MET'))
    actions.push('Obtain further qualified DISCOVERY executions against the unchanged approved aggregate trade floor.');
  if(sufficiency.session_proof_missing_run_ids?.length || sufficiency.session_conflicts?.length)
    actions.push('Telemetry and Research owners must resolve the exact listed native mapping or recorded producer-build proof gaps. Use native ENTRY trading-day/settings/actual-fill/accepted-attempt joins; current disk pins, floored dates and signal labels are not past native proof. v543 evidence cannot be retro-upgraded: an unmapped frozen segment needs an exact-coverage fresh managed native-observation replay that legitimately supersedes it, or independently proven original native facts. Later months alone cannot repair that immutable gap. Preserve the old run and all contradictions.');
  if(sufficiency.reasons?.includes('APPROVED_AGGREGATE_SESSION_FLOOR_NOT_MET'))
    actions.push('Obtain further qualified discovery ENTRY trading-day units under the same verified native configuration until the approved union floor is met; never sum reruns or exit-only dates.');
  if(sufficiency.reasons?.includes('DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN'))
    actions.push('Resolve overlapping observation provenance prospectively; retain all recorded rows and contradictions without double-counting support.');
  if(sufficiency.reasons?.includes('NO_RECORDED_DIRECTION_GROUPS'))
    actions.push('Research engineering owner: verify recorded entry-direction availability; unknown labels do not supply a hypothesis.');
  if(sufficiency.reasons?.includes('HISTORICAL_COVERAGE_NOT_PROVEN'))
    actions.push('Research owner: recover exact declared discovery coverage, not result-selected boundaries.');
  return {status:actions.length?'QUALIFIED_EVIDENCE_REQUIRED':'NOT_REQUIRED',requires_design_review:false,
    policy_change_authorized:false,protocol_engineering_authorized:true,
    additional_discovery_can_resolve_fixed_sample_shortfalls:false,missing_distinct_coverage_count:0,
    frozen_sample_shortfalls:[],next_action:actions.join(' ') || 'The qualified direction hypothesis screen is assessed. Candidate validation remains separately not due.'};
}
// Older frozen snapshots retain their saved remediation verbatim.
export const remediationV5=remediationV6;

export function evaluateV6(bundle,rows,accounting) {
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
  if(approved && sessions.verified && sessions.observed_session_count<policy.minimum_independent_sessions)
    reasons.push('APPROVED_AGGREGATE_SESSION_FLOOR_NOT_MET');
  if(calendar.missing_run_ids.length)reasons.push('HISTORICAL_COVERAGE_NOT_PROVEN');
  const eligibility={status:reasons.length?'INSUFFICIENT':'SUFFICIENT',policy:policy || null,policy_hash:policy?objectHash(policy):null,
    observed_comparable_trades:rows.length,observed_session_count:sessions.verified?sessions.observed_session_count:null,
    session_definition:sessions.basis,statistical_independence_verified:false,
    full_market_session_coverage_verified:false,zero_trade_coverage_verified:false,
    market_coverage_status:sessions.market_coverage_status,coverage_overlaps:overlaps,reasons:[...reasons]};
  const complete=calendar.blocks.filter(block=>block.complete);
  const assignment=row=>{
    const entry=sessions.entries.get(`${row.run_id}:${row.trade_id}`);
    // Native date is a Sierra date integer. This formats its calendar label,
    // not the fill's UTC timestamp or a statistical independence claim.
    if(entry)return nativeDateLabel(entry.trading_day_date).slice(0,7);
    return null;
  };
  const experiments=accounting.experiments.filter(item=>['long','short'].includes(item.value)).map(item=>{
    const selected=rows.filter(row=>row.direction===item.value);
    const blocks=calendar.blocks.map(block=>{const group=selected.filter(row=>assignment(row)===block.block_id);
      return {block_id:block.block_id,complete:block.complete,trades:group.length,net_profit_loss:sum(group),observed_exclusion_delta:-sum(group)};});
    const contradictory=item.runs.filter(run=>run.trades>0 && run.observed_exclusion_delta<=0);
    const empty=item.runs.filter(run=>run.trades===0);
    const diagnosticReasons=[
      ...(complete.length<3?['FEWER_THAN_THREE_COMPLETE_CALENDAR_BLOCKS']:[]),
      ...(calendar.blocks.some(block=>!block.complete)?['INCOMPLETE_CALENDAR_BLOCK']:[]),
      ...(blocks.some(block=>block.trades<10)?['FEWER_THAN_TEN_DIRECTION_TRADES_IN_CALENDAR_BLOCK']:[]),
      ...(contradictory.length?['CONTRADICTORY_RETAINED_CHILD_STRATA']:[]),
      ...(empty.length?['UNOBSERVED_DIRECTION_IN_RETAINED_CHILD_STRATUM']:[]),
      ...(!sessions.mapping_verified?['NATIVE_BLOCK_ASSIGNMENT_UNVERIFIED']:[])];
    const hypothesis=item.observed_exclusion_delta>0;
    const exposure=directionExclusionExposure(accounting,item);
    const supported=reasons.length===0 && hypothesis && contradictory.length===0
      && exposure.disposition==='ENTRY_FILTER_WITH_RETAINED_EXPOSURE';
    return {...item,blocks,evidence_sufficient:reasons.length===0,supported,hypothesis_generated:hypothesis,
      retained_exposure:exposure,
      contradictory_child_run_ids:contradictory.map(run=>run.run_id),unobserved_child_run_ids:empty.map(run=>run.run_id),
      robustness:{status:contradictory.length?'CONTRADICTED':diagnosticReasons.length?'NOT_ESTABLISHED':'DESCRIPTIVE_CHECKS_MET',
        reasons:diagnosticReasons,statistical_calibration:'NOT_CALIBRATED',candidate_acceptance:false},
      reason:reasons.length?'APPROVED_AGGREGATE_EVIDENCE_NOT_VERIFIED':!hypothesis?'NO_AGGREGATE_DIRECTION_LOSS'
        :exposure.retained_trades===0?'ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE'
        :exposure.retained_trades===null?'RETAINED_EXPOSURE_NOT_VERIFIED'
        :contradictory.length?'CONTRADICTORY_RETAINED_CHILD_STRATA'
        :'QUALIFIED_EXPLORATORY_HYPOTHESIS_NOT_CANDIDATE_ACCEPTANCE'};
  });
  if(!experiments.length)reasons.push('NO_RECORDED_DIRECTION_GROUPS');
  const sufficiency={status:reasons.length?'INSUFFICIENT':'SUFFICIENT',assessment_complete:reasons.length===0,
    scope:'RECORDED_ENTRY_DIRECTION_DISCOVERY_SCREEN_ONLY',reasons,distinct_declared_periods:calendar.blocks.length,
    missing_distinct_block_count:0,missing_coverage_run_ids:calendar.missing_run_ids,incomplete_blocks:[],
    sample_shortfalls:[],session_proof_missing_run_ids:sessions.missing_run_ids,session_conflicts:sessions.conflicts,
    evaluated_direction_values:reasons.length?[]:experiments.map(item=>item.value),
    unevaluated_direction_values:reasons.length?experiments.map(item=>item.value):[]};
  const proposals=experiments.filter(item=>item.supported),remediation=remediationV6(sufficiency);
  const hypotheses=experiments.filter(item=>item.hypothesis_generated).map(item=>({dimension:item.dimension,value:item.value,
    observed_exclusion_delta:item.observed_exclusion_delta,
    qualification:item.retained_exposure.retained_trades===0?'STRATEGY_DISABLE_OBSERVATION_ONLY'
      :reasons.length || item.retained_exposure.retained_trades===null?'DESCRIPTIVE_ONLY':'QUALIFIED_DISCOVERY',
    retained_exposure:item.retained_exposure,
    contradictory_child_run_ids:item.contradictory_child_run_ids,robustness:item.robustness}));
  const dispositions=experiments.filter(item=>item.retained_exposure.disposition!=='ENTRY_FILTER_WITH_RETAINED_EXPOSURE')
    .map(item=>({dimension:item.dimension,value:item.value,...item.retained_exposure}));
  const disableAction=dispositions.some(item=>item.retained_trades===0)
    ?' Zero retained exposure means excluding the only observed direction would disable all observed trading, not establish a profitable entry filter. Keep this as risk-disable review context under separate governance; no strategy disable, candidate or execution is authorized.' :'';
  return {...accounting,schema_version:RESEARCH_V6,screening_policy:screeningPolicy,
    descriptive_excluded_history:bundle.descriptive_excluded_history || null,
    protocol:{version:PROTOCOL_VERSION,timezone:zone,boundary_selection:'PREDECLARED_CALENDAR_NOT_OUTCOME_SELECTED',
      native_block_assignment:'NATIVE_TRADING_DAY_CALENDAR_LABEL_NOT_FILL_UTC',
      hypothesis_generation:'RECORDED_ENTRY_DIRECTION_AGGREGATE_LOSS_DESCRIPTIVE_NO_MINIMUM_MONTH_GATE',
      proposal_rule:'APPROVED_AGGREGATE_FLOOR_NO_CONTRADICTORY_RETAINED_CHILD_STRATA_AND_NONZERO_RETAINED_EXPOSURE',
      robustness_role:'REPORT_3_COMPLETE_BLOCKS_10_DIRECTION_TRADES_PER_BLOCK_NOT_PLANNING_GATE',
      candidate_acceptance:'SEPARATE_FROZEN_CANDIDATE_AND_REVIEWED_VALIDATION_NOT_EVALUATED',
      child_strata_retained:true,all_qualified_rows_retained:true,statistical_independence_verified:false},
    approved_evidence_eligibility:eligibility,evidence_sufficiency:sufficiency,evidence_remediation:remediation,hypotheses,
    direction_exclusion_dispositions:dispositions,
    native_session_evidence:{verification_status:sessions.verification_status,mapping_verified:sessions.mapping_verified,
      mapped_entry_day_count:sessions.mapped_entry_day_count,session_config_hash:sessions.session_config_hash,
      market_coverage_status:sessions.market_coverage_status,exit_audit:sessions.exit_audit},
    historical_periods:{...accounting.historical_periods,basis:'PREDECLARED_CALENDAR_BLOCKS_WITH_RETAINED_OPERATIONAL_CHILD_STRATA',
      distinct_coverage_count:calendar.blocks.length,complete_calendar_block_count:complete.length,blocks:calendar.blocks},
    experiments,proposals,outcome:proposals.length?'EXPLORATORY_PROPOSAL':reasons.length?'INSUFFICIENT_EVIDENCE':'NO_SUPPORTED_CHANGE',
    next_action:proposals.length?'The existing owned Brain planning worker freezes this exact non-live hypothesis, retained contradictions and prospective comparison scope. Report unresolved 3/10 robustness checks in the plan; do not treat them as aggregate eligibility or invent candidate acceptance. No candidate is approved or tested.'
      :reasons.length?`Keep the baseline. This is insufficient verified evidence, not an evaluated no-change finding. ${remediation.next_action}${disableAction}`
        :`Keep the baseline. The qualified aggregate direction hypothesis screen found no contradiction-free entry filter with retained exposure. This is a scoped discovery no-change finding, not candidate validation or a conclusion about all improvements.${disableAction}`,
    limitations:[...accounting.limitations,'V6 prospectively separates approved 50/20/DQ0 eligibility from descriptive hypotheses, uncalibrated 3/10 robustness diagnostics and separately governed candidate acceptance. Native entry trading-day units do not prove IID or full market-session coverage. Frozen v4/v5 reports are not rewritten.',
      'Retained-exposure counts are recorded accounting, not an executed filter backtest. A loss-exclusion delta leaving zero trades is strategy-disable context, not evidence of a profitable entry-filter candidate. Frozen reports remain unchanged; new protocol v3 captures this distinction.']};
}
