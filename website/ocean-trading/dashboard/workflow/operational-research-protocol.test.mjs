import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResearch, evaluateResearchV4, RESEARCH_VERSION, LEGACY_RESEARCH_VERSION } from './operational-research.mjs';
import { calendarBlocks, checkSessionObservation, SESSION_SCHEMA, sessionEvidence, readObservedSessionProofs, NATIVE_SESSION_INTEGRATION } from './operational-research-protocol.mjs';
import { digest, objectHash } from './common.mjs';

function sample() {
  const ranges={u:[['2025-08-31T23:00:00Z','2025-09-12T23:00:00Z']],z:[['2025-09-12T23:00:00Z','2025-09-30T23:00:00Z']],
    oct:[['2025-09-30T23:00:00Z','2025-11-01T00:00:00Z']],nov:[['2025-11-01T00:00:00Z','2025-12-01T00:00:00Z']]};
  const rows=[],proofs={};let trade=0;
  for(const [run_id,range] of Object.entries(ranges)) {
    const index=Object.keys(ranges).indexOf(run_id),n=index<2?10:20;
    const context={run_id,context_hash:digest(run_id)};
    const calendarBinding={revision:'EXPLICIT_MOCK_CALENDAR',source_config_hash:digest('EXPLICIT_MOCK_PINNED_CONFIG'),
      chart_settings_hash:digest('EXPLICIT_MOCK_SETTINGS'),effective_chart_timezone:'EXPLICIT_MOCK_ONLY',timezone:'Europe/London'};
    const entries=Array.from({length:n},(_,i)=>{
      const day=index===0?i+1:index===1?i+13:i+1,mon=index<2?9:index===2?10:11;
      const at=Date.UTC(2025,mon-1,day,12),start=at-3600000,end=at+3600000;
      const row={run_id,trade_id:++trade,entry_datetime:46000+trade/24,trade_account:'Sim1',symbol:'EXPLICIT_MOCK_SYMBOL',
        direction:i<n/2?'long':'short',gross_currency_value:i<n/2?20:-10,total_commission:1,net_profit_loss:i<n/2?19:-11,
        session_name:'Asia',regime_label:'unknown',exit_causality:'unknown'};
      rows.push(row);
      return {trade_id:row.trade_id,entry_datetime:row.entry_datetime,entry_utc:new Date(at).toISOString(),trade_account:row.trade_account,symbol:row.symbol,
        trading_day_date:new Date(at).toISOString().slice(0,10),session_start_utc:new Date(start).toISOString(),session_end_utc:new Date(end).toISOString()};
    });
    proofs[run_id]={context,calendar_binding:calendarBinding,source_receipt_ref:`EXPLICIT_MOCK_RECEIPT_${run_id}`,source_receipt_hash:digest(`EXPLICIT_MOCK_RECEIPT_${run_id}`),
      native_contract_verified:true,native_contract_receipt_hash:digest('EXPLICIT_MOCK_ONLY_NATIVE_PROVIDER'),observation:{schema_version:SESSION_SCHEMA,
      run_id,context_hash:context.context_hash,observed_at_utc:'2026-10-08T14:00:00Z',calendar:{...calendarBinding,
        mapping_method:'SIERRA_NATIVE_TRADING_DAY_AND_UTC_CONVERSION',trading_day_method:'sc.GetTradingDayDate',utc_method:'sc.ConvertDateTimeFromChartTimeZone',
        chart_settings_hash:digest('EXPLICIT_MOCK_SETTINGS'),effective_chart_timezone:'EXPLICIT_MOCK_ONLY'},entries}};
  }
  const bundle={cohort:{eligible_runs:Object.keys(ranges).map(run_id=>({run_id})),aggregate:{observed_sample_count:rows.length}},excluded_evidence:[],
    research_coverage:Object.fromEntries(Object.entries(ranges).map(([run,r])=>[run,r.map(([start_utc,end_utc])=>({start_utc,end_utc}))])),
    approved_evidence_policy:{status:'APPROVED',policy_version:'1.0.0',minimum_comparable_trades:50,minimum_independent_sessions:20,
      maximum_data_quality_issues:0,contradictory_evidence_tolerance:0},execution_sessions:proofs};
  return {bundle,rows};
}

test('v5 retains v4 evaluator and treats September U/Z as one predeclared block, not independent contract runs',()=>{
  const {bundle,rows}=sample(),before=objectHash({bundle,rows});
  const v4=evaluateResearchV4(bundle,rows),v5=evaluateResearch(bundle,rows);
  assert.equal(v4.schema_version,LEGACY_RESEARCH_VERSION);assert.equal(v4.outcome,'INSUFFICIENT_EVIDENCE');
  assert.equal(v4.historical_periods.distinct_coverage_count,4);
  assert.equal(v5.schema_version,RESEARCH_VERSION);assert.equal(v5.historical_periods.distinct_coverage_count,3);
  assert.equal(v5.historical_periods.blocks[0].child_strata.length,2);assert.equal(v5.aggregate.trades,60);
  assert.equal(v5.outcome,'EXPLORATORY_PROPOSAL');assert.equal(v5.proposals[0].value,'short');
  assert.equal(v5.proposals[0].blocks[0].trades,10);assert.equal(v5.proposals[0].runs.length,4);
  assert.equal(v5.screening_policy.minimum_distinct_declared_periods,3);assert.equal(v5.screening_policy.minimum_direction_trades_per_calendar_block,10);
  assert.match(v5.screening_policy.basis,/NOT_APPROVED_EVIDENCE_POLICY/);assert.equal(v5.approved_evidence_eligibility.policy.minimum_comparable_trades,50);
  assert.equal(v5.approved_evidence_eligibility.policy.minimum_independent_sessions,20);assert.equal(v5.protocol.statistical_independence_verified,false);
  assert.equal(objectHash({bundle,rows}),before);
});

test('September alone remains one block and insufficient; October would be only a second block under v5',()=>{
  const {bundle,rows}=sample();bundle.cohort.eligible_runs=bundle.cohort.eligible_runs.filter(run=>['u','z'].includes(run.run_id));
  const selected=rows.filter(row=>['u','z'].includes(row.run_id));bundle.cohort.aggregate.observed_sample_count=selected.length;
  const result=evaluateResearch(bundle,selected);
  assert.equal(result.historical_periods.distinct_coverage_count,1);assert.equal(result.evidence_remediation.missing_distinct_coverage_count,2);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(result.proposals.length,0);
  assert.ok(result.approved_evidence_eligibility.reasons.includes('APPROVED_AGGREGATE_TRADE_FLOOR_NOT_MET'));
  assert.equal(result.approved_evidence_eligibility.observed_session_count,20);
});

test('v5 never hides profitable contradictory children inside a losing month',()=>{
  const {bundle,rows}=sample();
  for(const row of rows.filter(row=>row.run_id==='z' && row.direction==='short')){row.gross_currency_value=2;row.net_profit_loss=1;}
  const result=evaluateResearch(bundle,rows),short=result.experiments.find(item=>item.value==='short');
  assert.ok(short.blocks[0].observed_exclusion_delta>0);assert.equal(short.evidence_sufficient,true);assert.equal(short.supported,false);
  assert.equal(short.reason,'DIRECTION_LOSS_NOT_REPEATED_IN_EVERY_RETAINED_CHILD_STRATUM');assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');
  assert.equal(result.aggregate.trades,60);assert.equal(result.excluded_evidence.length,0);
});

test('20 session floor cannot be satisfied by Sierra dates, signal labels, upstream sums or a current timezone alone',()=>{
  const {bundle,rows}=sample();delete bundle.execution_sessions;
  bundle.cohort.aggregate.independent_session_count=1000;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.approved_evidence_eligibility.observed_session_count,null);assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.evidence_sufficiency.session_proof_missing_run_ids,['u','z','oct','nov']);
  assert.match(result.next_action,/native chart trading-day\/UTC mappings/);assert.ok(result.observational_breakdowns.every(item=>!item.supported));
});

test('exact producer-observed sessions count once across runs, conflicts and overlapping different identities fail closed',()=>{
  const {bundle,rows}=sample(),row=rows.find(row=>row.run_id==='z'),entry=bundle.execution_sessions.z.observation.entries[0];
  const u=bundle.execution_sessions.u.observation.entries[0];
  Object.assign(entry,{entry_utc:u.entry_utc,trading_day_date:u.trading_day_date,session_start_utc:u.session_start_utc,session_end_utc:u.session_end_utc});
  assert.equal(sessionEvidence(bundle,rows).observed_session_count,59);
  entry.trading_day_date='2025-09-02';assert.equal(sessionEvidence(bundle,rows).verified,false);
  assert.ok(row); // No accounting row was removed to repair the session conflict.
});

test('requested coverage has deterministic DST-aware calendar boundaries and gaps are not invented as complete periods',()=>{
  const {bundle}=sample(),oct=calendarBlocks(bundle).blocks.find(block=>block.block_id==='2025-10');
  assert.equal(oct.start_utc,'2025-09-30T23:00:00.000Z');assert.equal(oct.end_utc,'2025-11-01T00:00:00.000Z');
  bundle.research_coverage.z[0].start_utc='2025-09-13T23:00:00Z';
  const sept=calendarBlocks(bundle).blocks[0];assert.equal(sept.complete,false);assert.equal(sept.gaps.length,1);
});

test('session proof binds exact account/symbol/fill timestamp/context/settings and never accepts duplicate trades',()=>{
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.u,selected=rows.filter(row=>row.run_id==='u');
  for(const change of [p=>{p.context_hash=digest('wrong');},p=>{p.entries[0].trade_account='Sim2';},
    p=>{p.entries[0].symbol='other';},p=>{p.entries[0].entry_datetime++;},p=>{p.calendar.chart_settings_hash=null;},
    p=>{p.entries[1]=p.entries[0];},p=>{p.calendar.mapping_method='FLOOR_SIERRA_DATE';}]) {
    const observation=structuredClone(proof.observation);change(observation);
    assert.throws(()=>checkSessionObservation(observation,proof.context,selected,proof.calendar_binding),/OBSERVED_SESSION_/);
  }
});

test('calendar pins are separate from immutable run-context2.1 and mismatched revisions or hashes fail closed',()=>{
  const {bundle,rows}=sample(),proof=bundle.execution_sessions.u,selected=rows.filter(row=>row.run_id==='u');
  const before=objectHash(proof.context);assert.equal('session_calendar_revision' in proof.context,false);
  assert.equal(checkSessionObservation(proof.observation,proof.context,selected,proof.calendar_binding),proof.observation);
  for(const binding of [undefined,{...proof.calendar_binding,revision:'other'},
    {...proof.calendar_binding,source_config_hash:digest('other')},{...proof.calendar_binding,chart_settings_hash:digest('other')}])
    assert.throws(()=>checkSessionObservation(proof.observation,proof.context,selected,binding),/OBSERVED_SESSION_CALENDAR_PROOF_REQUIRED/);
  assert.equal(objectHash(proof.context),before);
});

test('production core explicitly requires actual native adapter integration, without fabricated events or verifier hooks',()=>{
  const {bundle,rows}=sample();let lookups=0;
  const backend={one:(table,run_id)=>{assert.equal(table,'ow_runs');lookups++;return {context_json:JSON.stringify(bundle.execution_sessions[run_id].context)};},
    verifyNativeSessionReceipt:()=>{throw Error('caller hook must never create native proof');}};
  const proofs=readObservedSessionProofs(backend,['u','z'],rows);
  assert.equal(lookups,2);assert.equal(NATIVE_SESSION_INTEGRATION.status,'INTEGRATION_DUE');
  assert.equal(proofs.u.proof_error,'NATIVE_SESSION_ADAPTER_INTEGRATION_DUE');
  bundle.execution_sessions=proofs;const result=evaluateResearch(bundle,rows);
  assert.equal(result.approved_evidence_eligibility.observed_session_count,null);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.match(result.next_action,/before deployment acceptance/);
  assert.equal(result.proposals.length,0);
});

test('immutable block direction shortfall is owned prospective engineering, not a promise that later months can fill it',()=>{
  const {bundle,rows}=sample();rows.find(row=>row.run_id==='u' && row.direction==='short').direction='long';
  const result=evaluateResearch(bundle,rows);
  assert.ok(result.evidence_sufficiency.sample_shortfalls.some(item=>item.block_id==='2025-09' && item.observed_trades===9));
  assert.equal(result.evidence_remediation.additional_discovery_can_resolve_fixed_sample_shortfalls,false);
  assert.equal(result.evidence_remediation.protocol_engineering_authorized,true);assert.match(result.next_action,/Existing engineering authorization covers/);
  assert.doesNotMatch(result.next_action,/Wayne.*approve|collect.*until/);
});

test('50/20 eligibility does not imply favorable performance approval or candidate/test authority',()=>{
  const {bundle,rows}=sample();for(const row of rows){row.gross_currency_value=-10;row.net_profit_loss=-11;}
  const result=evaluateResearch(bundle,rows);assert.equal(result.proposals.length,2);
  assert.equal(result.approved_evidence_eligibility.status,'SUFFICIENT');assert.equal(result.candidate_validation.status,'NOT_DUE');
  assert.equal(Object.values(result.authority).every(value=>value===false),true);
});

test('non-identical overlapping run coverage blocks support without removing trades or contradictory children',()=>{
  const {bundle,rows}=sample();bundle.research_coverage.z[0].start_utc='2025-09-11T23:00:00Z';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.trades,60);assert.equal(result.per_run.length,4);assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.ok(result.approved_evidence_eligibility.reasons.includes('DECLARED_COVERAGE_OVERLAP_OBSERVATION_DUPLICATION_NOT_PROVEN'));
  assert.equal(result.approved_evidence_eligibility.coverage_overlaps.length,1);assert.equal(result.proposals.length,0);
});
