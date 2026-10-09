import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResearch, evaluateResearchV4, RESEARCH_VERSION, LEGACY_RESEARCH_VERSION } from './operational-research.mjs';
import { calendarBlocks, sessionEvidence, directionExclusionExposure, requireDirectionExclusionExposure } from './operational-research-protocol.mjs';
import { checkNativeSessionProof, nativeConfigurationHash, nativeDateLabel } from './operational-native-sessions.mjs';
import { mockNativeProof } from './operational-native-sessions.test-fixtures.mjs';
import { digest, objectHash } from './common.mjs';

function sample() {
  const ranges={u:[['2025-08-31T23:00:00Z','2025-09-12T23:00:00Z']],z:[['2025-09-12T23:00:00Z','2025-09-30T23:00:00Z']],
    oct:[['2025-09-30T23:00:00Z','2025-11-01T00:00:00Z']],nov:[['2025-11-01T00:00:00Z','2025-12-01T00:00:00Z']]};
  const rows=[],proofs={};let trade=0;
  for(const [index,run_id] of Object.keys(ranges).entries()) {
    const n=index<2?10:20;
    const group=Array.from({length:n},(_,i)=>({run_id,trade_id:++trade,direction:i<n/2?'long':'short',
      gross_currency_value:i<n/2?20:-10,total_commission:1,net_profit_loss:i<n/2?19:-11,
      session_name:'Asia',regime_label:'unknown',exit_causality:'unknown'}));
    proofs[run_id]=mockNativeProof({run_id,context_hash:digest(run_id)},group,{month:index<2?9:index===2?10:11,firstDay:index===1?13:1});
    rows.push(...group);
  }
  const bundle={cohort:{eligible_runs:Object.keys(ranges).map(run_id=>({run_id})),aggregate:{observed_sample_count:rows.length}},excluded_evidence:[],
    research_coverage:Object.fromEntries(Object.entries(ranges).map(([run,r])=>[run,r.map(([start_utc,end_utc])=>({start_utc,end_utc}))])),
    approved_evidence_policy:{status:'APPROVED',policy_version:'1.0.0',minimum_comparable_trades:50,minimum_independent_sessions:20,
      maximum_data_quality_issues:0,contradictory_evidence_tolerance:0},execution_sessions:proofs};
  return {bundle,rows};
}

test('v6 separates native aggregate eligibility, direction hypotheses, uncalibrated robustness and candidate acceptance',()=>{
  const {bundle,rows}=sample(),before=objectHash({bundle,rows});
  const v4=evaluateResearchV4(bundle,rows),result=evaluateResearch(bundle,rows);
  assert.equal(v4.schema_version,LEGACY_RESEARCH_VERSION);assert.equal(v4.historical_periods.distinct_coverage_count,4);
  assert.equal(result.schema_version,RESEARCH_VERSION);assert.equal(result.historical_periods.distinct_coverage_count,3);
  assert.equal(result.historical_periods.blocks[0].child_strata.length,2);assert.equal(result.aggregate.trades,60);
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');assert.equal(result.proposals[0].value,'short');
  assert.equal(result.screening_policy.minimum_distinct_declared_periods,3);assert.equal(result.screening_policy.minimum_direction_trades_per_calendar_block,10);
  assert.match(result.screening_policy.role,/NOT_EVIDENCE_ELIGIBILITY/);assert.match(result.screening_policy.basis,/NOT_APPROVED_EVIDENCE_POLICY/);
  assert.equal(result.approved_evidence_eligibility.policy.minimum_comparable_trades,50);
  assert.equal(result.approved_evidence_eligibility.policy.minimum_independent_sessions,20);
  assert.equal(result.protocol.statistical_independence_verified,false);assert.equal(result.candidate_validation.status,'NOT_DUE');
  assert.equal(objectHash({bundle,rows}),before);
});

for(const direction of ['long','short'])test(`excluding the only losing ${direction} direction is risk-disable context, not an entry-filter proposal`,()=>{
  const {bundle,rows}=sample();
  for(const row of rows)Object.assign(row,{direction,gross_currency_value:-10,net_profit_loss:-11});
  const before=objectHash({bundle,rows}),result=evaluateResearch(bundle,rows),experiment=result.experiments[0];
  assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');assert.deepEqual(result.proposals,[]);
  assert.equal(result.aggregate.trades,60);assert.equal(result.aggregate.net_profit_loss,-660);
  assert.equal(result.approved_evidence_eligibility.status,'SUFFICIENT');
  assert.equal(result.approved_evidence_eligibility.policy.minimum_comparable_trades,50);
  assert.equal(result.approved_evidence_eligibility.policy.minimum_independent_sessions,20);
  assert.equal(experiment.observed_exclusion_delta,660);assert.equal(experiment.hypothesis_generated,true);
  assert.equal(experiment.supported,false);assert.equal(experiment.reason,'ZERO_RETAINED_EXPOSURE_STRATEGY_DISABLE');
  assert.deepEqual(experiment.retained_exposure,{basis:'RECORDED_TRADE_COUNTS_NOT_EXECUTED_FILTER_PERFORMANCE',
    baseline_trades:60,excluded_trades:60,retained_trades:0,disposition:'RISK_DISABLE_REVIEW_REQUIRED'});
  assert.equal(result.hypotheses[0].qualification,'STRATEGY_DISABLE_OBSERVATION_ONLY');
  assert.equal(result.direction_exclusion_dispositions[0].disposition,'RISK_DISABLE_REVIEW_REQUIRED');
  assert.match(result.next_action,/zero retained exposure|Zero retained exposure/);
  assert.doesNotMatch(result.next_action,/planning worker freezes this exact/);
  assert.equal(result.candidate_validation.status,'NOT_DUE');assert.equal(result.candidate_validation.candidate_hash,null);
  assert.ok(Object.values(result.authority).every(value=>value===false));
  assert.equal(objectHash({bundle,rows}),before);
});

test('nonzero retained exposure preserves the existing exploratory proposal, not a tested performance claim',()=>{
  const {bundle,rows}=sample(),before=objectHash({bundle,rows}),result=evaluateResearch(bundle,rows);
  const proposal=result.proposals.find(item=>item.value==='short');
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');assert.equal(proposal.retained_exposure.retained_trades,30);
  assert.equal(proposal.retained_exposure.disposition,'ENTRY_FILTER_WITH_RETAINED_EXPOSURE');
  assert.equal(proposal.retained_exposure.basis,'RECORDED_TRADE_COUNTS_NOT_EXECUTED_FILTER_PERFORMANCE');
  assert.equal(result.candidate_validation.status,'NOT_DUE');assert.equal(result.aggregate.trades,60);
  assert.equal(objectHash({bundle,rows}),before);
});

test('zero retained exposure does not bypass the unchanged approved evidence floor',()=>{
  const {bundle,rows}=sample();
  for(const row of rows)Object.assign(row,{direction:'short',gross_currency_value:-10,net_profit_loss:-11});
  bundle.approved_evidence_policy.status='NOT_APPROVED';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.deepEqual(result.proposals,[]);
  assert.ok(result.approved_evidence_eligibility.reasons.includes('APPROVED_EVIDENCE_POLICY_PROOF_REQUIRED'));
  assert.equal(result.direction_exclusion_dispositions[0].disposition,'RISK_DISABLE_REVIEW_REQUIRED');
  assert.equal(result.candidate_validation.status,'NOT_DUE');
});

test('missing or inconsistent frozen exposure counts cannot authorize planning',()=>{
  for(const [report,proposal] of [[{},{}],[{aggregate:{trades:60}},{runs:[{trades:61}]}],
    [{aggregate:{trades:60}},{runs:[{trades:-1}]}],[{aggregate:{trades:60}},{runs:[{trades:'30'}]}],
    [{aggregate:{trades:60}},{runs:[{trades:0}]}],[{aggregate:{trades:60}},{runs:{trades:30}}]]) {
    const before=objectHash({report,proposal}),exposure=directionExclusionExposure(report,proposal);
    assert.equal(exposure.disposition,'INSUFFICIENT_RETAINED_EXPOSURE_EVIDENCE');
    assert.equal(exposure.retained_trades,null);
    assert.throws(()=>requireDirectionExclusionExposure(report,proposal),/RETAINED_EXPOSURE_NOT_VERIFIED/);
    assert.equal(objectHash({report,proposal}),before);
  }
});

test('fee-driven single-direction losses still describe zero-exposure disable, not profitable filtering',()=>{
  const {bundle,rows}=sample();
  for(const row of rows)Object.assign(row,{direction:'long',gross_currency_value:0.5,total_commission:1,net_profit_loss:-0.5});
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.gross_profit_loss,30);assert.equal(result.aggregate.fees,60);
  assert.equal(result.aggregate.net_profit_loss,-30);assert.equal(result.experiments[0].observed_exclusion_delta,30);
  assert.equal(result.direction_exclusion_dispositions[0].retained_trades,0);assert.deepEqual(result.proposals,[]);
  assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');assert.equal(result.candidate_validation.status,'NOT_DUE');
});

test('Sierra DateValue encoding keeps raw45904 for2025-09-04 and rejects YYYYMMDD or ISO-string substitutions',()=>{
  assert.equal(nativeDateLabel(45904),'2025-09-04');
  for(const value of [20250904,20260904,'45904','2025-09-04',45904.5])
    assert.throws(()=>nativeDateLabel(value),/NATIVE_SESSION_DATE_VALUE_ENCODING_REQUIRED/);
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.u;
  proof.observations[0].trading_day_date=20250901;
  assert.equal(sessionEvidence(bundle,rows).verified,false);
  assert.ok(sessionEvidence(bundle,rows).conflicts.some(item=>item.reason==='NATIVE_SESSION_DATE_VALUE_ENCODING_REQUIRED'));
});

test('September U/Z alone can support owned exploratory planning at unchanged50/20 without inventing third coverage',()=>{
  const {bundle,rows}=sample();
  bundle.cohort.eligible_runs=bundle.cohort.eligible_runs.filter(run=>['u','z'].includes(run.run_id));
  const selected=rows.filter(row=>['u','z'].includes(row.run_id));
  for(const run_id of ['u','z']) {
    const group=selected.filter(row=>row.run_id===run_id);
    for(let i=0;i<15;i++)group.push({...group[i%10],trade_id:1000+(run_id==='z'?100:0)+i});
    bundle.execution_sessions[run_id]=mockNativeProof({run_id,context_hash:digest(run_id)},group,{month:9});
    selected.splice(0,selected.length,...selected.filter(row=>row.run_id!==run_id),...group);
  }
  bundle.cohort.aggregate.observed_sample_count=selected.length;
  const result=evaluateResearch(bundle,selected);
  assert.equal(result.aggregate.trades,50);assert.equal(result.approved_evidence_eligibility.observed_session_count,25);
  assert.equal(result.historical_periods.distinct_coverage_count,1);assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');
  assert.equal(result.proposals[0].robustness.status,'NOT_ESTABLISHED');
  assert.ok(result.proposals[0].robustness.reasons.includes('FEWER_THAN_THREE_COMPLETE_CALENDAR_BLOCKS'));
  assert.equal(result.evidence_remediation.missing_distinct_coverage_count,0);
});

test('50/20 is unchanged:49 trades or19 verified entry days is insufficient; descriptive hypotheses remain visible',()=>{
  for(const kind of ['trades','days']) {
    const {bundle,rows}=sample();
    let selected=rows;
    if(kind==='trades') {
      selected=rows.slice(0,49);
      for(const run of bundle.cohort.eligible_runs) {
        const proof=bundle.execution_sessions[run.run_id],group=selected.filter(row=>row.run_id===run.run_id);
        bundle.execution_sessions[run.run_id]=mockNativeProof(proof.context,group,{month:9});
      }
    } else {
      for(const run of bundle.cohort.eligible_runs) {
        const group=rows.filter(row=>row.run_id===run.run_id);
        const proof=mockNativeProof(bundle.execution_sessions[run.run_id].context,group,{month:9});
        for(const obs of proof.observations)if(obs.trading_day_date>proof.observations[0].trading_day_date+18) {
          obs.trading_day_date=proof.observations[0].trading_day_date+18;
          obs.trading_day_start_datetime=obs.trading_day_date;
        }
        bundle.execution_sessions[run.run_id]=proof;
      }
    }
    bundle.cohort.aggregate.observed_sample_count=selected.length;
    const result=evaluateResearch(bundle,selected);
    assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(result.proposals.length,0);
    assert.ok(result.hypotheses.length>0);assert.ok(result.hypotheses.every(item=>item.qualification==='DESCRIPTIVE_ONLY'));
    assert.ok(result.approved_evidence_eligibility.reasons.includes(kind==='trades'?'APPROVED_AGGREGATE_TRADE_FLOOR_NOT_MET':'APPROVED_AGGREGATE_SESSION_FLOOR_NOT_MET'));
  }
});

test('fixed9 direction trades in a month report robustness shortfall without permanent planning deadlock',()=>{
  const {bundle,rows}=sample();rows.find(row=>row.run_id==='u' && row.direction==='short').direction='long';
  const result=evaluateResearch(bundle,rows),short=result.experiments.find(item=>item.value==='short');
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');assert.equal(short.supported,true);
  assert.equal(short.blocks[0].trades,9);
  assert.ok(short.robustness.reasons.includes('FEWER_THAN_TEN_DIRECTION_TRADES_IN_CALENDAR_BLOCK'));
  assert.equal(short.robustness.status,'NOT_ESTABLISHED');
  assert.equal(result.evidence_sufficiency.sample_shortfalls.length,0);assert.doesNotMatch(result.next_action,/collect.*until|Wayne.*approve/i);
});

test('contradictory profitable children remain accounted and prevent supported proposal even in losing month',()=>{
  const {bundle,rows}=sample();
  for(const row of rows.filter(row=>row.run_id==='z' && row.direction==='short')){row.gross_currency_value=2;row.net_profit_loss=1;}
  const result=evaluateResearch(bundle,rows),short=result.experiments.find(item=>item.value==='short');
  assert.ok(short.blocks[0].observed_exclusion_delta>0);assert.equal(short.hypothesis_generated,true);
  assert.equal(short.supported,false);assert.equal(short.robustness.status,'CONTRADICTED');
  assert.deepEqual(short.contradictory_child_run_ids,['z']);assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');
  assert.equal(result.aggregate.trades,60);assert.equal(result.excluded_evidence.length,0);
});

test('native ENTRY union deduplicates U/Z day units and never counts exit-only or untraded dates as extra sessions',()=>{
  const {bundle,rows}=sample();
  const zrows=rows.filter(row=>row.run_id==='z');
  bundle.execution_sessions.z=mockNativeProof(bundle.execution_sessions.z.context,zrows,{month:9});
  const proof=sessionEvidence(bundle,rows);assert.equal(proof.verified,true);assert.equal(proof.observed_session_count,50);
  assert.equal(proof.statistical_independence_verified,false);assert.equal(proof.full_market_session_coverage_verified,false);
  assert.equal(proof.zero_trade_coverage_verified,false);
  bundle.execution_sessions.z.links=bundle.execution_sessions.z.links.filter(link=>link.link_role==='entry');
  assert.equal(sessionEvidence(bundle,rows).observed_session_count,50);
});

test('missing native proof, current timezone, signal labels and upstream dates cannot claim20 sessions',()=>{
  const {bundle,rows}=sample();delete bundle.execution_sessions;bundle.cohort.aggregate.independent_session_count=1000;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.approved_evidence_eligibility.observed_session_count,null);assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.evidence_sufficiency.session_proof_missing_run_ids,['u','z','oct','nov']);
  assert.ok(result.observational_breakdowns.every(item=>!item.supported));
  assert.match(result.next_action,/native ENTRY/);assert.match(result.next_action,/Later months alone cannot repair/);
});

test('actual native fields exact account/symbol/fill/attempt/settings hashes and unique links are required',()=>{
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.u,selected=rows.filter(row=>row.run_id==='u');
  assert.equal(checkNativeSessionProof(proof,proof.context,selected).entries.length,10);
  for(const change of [p=>{p.managed_context.context_hash=digest('wrong');},p=>{p.links[0].source_fill_datetime++;},
    p=>{p.observations[0].trade_account='Sim2';},p=>{p.observations[0].symbol='other';},
    p=>{p.observations[0].start_time1=3600;},p=>{p.observations[0].attempt_id=2;},
    p=>{p.links.push(p.links[0]);},p=>{p.fills=[];},p=>{p.observations[0].brain_eligible=1;}]) {
    const copy=structuredClone(proof);change(copy);
    assert.throws(()=>checkNativeSessionProof(copy,copy.context,selected),/NATIVE_SESSION_/);
  }
  assert.equal('session_calendar_revision' in proof.context,false);
  assert.equal('entry_utc' in proof.trades[0],false);assert.equal('session_end_utc' in proof.observations[0],false);
});

test('same configuration/date requires same native start; different native settings or inverted day starts fail closed',()=>{
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.z;
  proof.observations[0].chart_timezone='Europe/London';
  proof.observations[0].session_config_hash=nativeConfigurationHash(proof.observations[0]);
  assert.equal(sessionEvidence(bundle,rows).verified,false);
  assert.ok(sessionEvidence(bundle,rows).conflicts.some(item=>item.reason==='NATIVE_SESSION_COMPARABLE_CONFIGURATION_CONFLICT'));
  proof.observations[0].chart_timezone='UTC';proof.observations[0].session_config_hash=nativeConfigurationHash(proof.observations[0]);
  proof.observations[1].trading_day_start_datetime=proof.observations[0].trading_day_start_datetime;
  assert.equal(sessionEvidence(bundle,rows).verified,false);
});

test('mapping-only all0 view flags are accepted as limitations, never converted to fullcoverage/IID claims',()=>{
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.u;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.approved_evidence_eligibility.status,'SUFFICIENT');
  assert.equal(result.approved_evidence_eligibility.full_market_session_coverage_verified,false);
  assert.equal(result.approved_evidence_eligibility.market_coverage_status,'MAPPING_ONLY_NOT_COMPLETE_MARKET_COVERAGE');
  proof.producer_verification={verified:false,reason:'NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED'};
  const unverified=evaluateResearch(bundle,rows);
  assert.equal(unverified.native_session_evidence.mapping_verified,true);assert.equal(unverified.outcome,'INSUFFICIENT_EVIDENCE');
});

test('predeclared blocks are DST-aware; incomplete month is visible robustness context not a new eligibility requirement',()=>{
  const {bundle,rows}=sample(),oct=calendarBlocks(bundle).blocks.find(block=>block.block_id==='2025-10');
  assert.equal(oct.start_utc,'2025-09-30T23:00:00.000Z');assert.equal(oct.end_utc,'2025-11-01T00:00:00.000Z');
  bundle.research_coverage.z[0].start_utc='2025-09-13T23:00:00Z';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.historical_periods.blocks[0].complete,false);assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');
  assert.ok(result.proposals[0].robustness.reasons.includes('INCOMPLETE_CALENDAR_BLOCK'));
});

test('non-identical overlapping observations block support without deleting accounting or contradictory strata',()=>{
  const {bundle,rows}=sample();bundle.research_coverage.z[0].start_utc='2025-09-11T23:00:00Z';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.trades,60);assert.equal(result.per_run.length,4);assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.ok(result.approved_evidence_eligibility.reasons.includes('DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN'));
  assert.equal(result.proposals.length,0);
});

test('excluded legacy execution context stays distinct from qualified accounting and cannot supply native/session/proposal support',()=>{
  const {bundle,rows}=sample();delete bundle.execution_sessions;
  bundle.descriptive_excluded_history={status:'DESCRIPTIVE_EXCLUDED_HISTORY_NOT_CURRENT_CAUSAL_SUPPORT',recorded_trade_count:251,
    runs:[{run_id:'legacy-u',current_causal_support:false,exclusion_reason:'PHYSICAL_STRATEGY_DLL_HASH_CONFLICT; RAW_STTL2_IDENTITY_CONFLICT',
      recorded_physical_strata:[{recorded_raw_profile:'EXPLICIT_MOCK_PHYSICAL3',recorded_strategy_dll_hash:'EXPLICIT_MOCK_BAD_PIN'}]}]};
  const before=objectHash(bundle.descriptive_excluded_history),result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.trades,60);assert.equal(result.descriptive_excluded_history.recorded_trade_count,251);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(result.proposals.length,0);
  assert.equal(objectHash(result.descriptive_excluded_history),before);
  assert.equal(result.approved_evidence_eligibility.observed_session_count,null);
});
