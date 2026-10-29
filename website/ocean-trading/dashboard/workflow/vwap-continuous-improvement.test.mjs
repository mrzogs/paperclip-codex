import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VWAP_LEARNING_POLICY, detectRecurringVwapFailures, evaluateVwapEvidenceSufficiency, VWAP_STRATEGY_ID } from './vwap-continuous-improvement.mjs';
import { discoveryFixture, FIXTURE_NOW } from './fixtures/vwap-discovery-fixture.mjs';

function rows({ count = 60, losingPattern = true } = {}) {
  return Array.from({ length:count }, (_, index) => ({
    trade_id:`trade-${String(index).padStart(3, '0')}`,
    strategy_id:VWAP_STRATEGY_ID,
    dataset_role:'DISCOVERY', environment:'REPLAY', run_id:'fixture-run',
    session_id:`session-${index % 20}`,
    setup_id:index < 12 && losingPattern ? 'late-reclaim' : `baseline-${index}`,
    session_name:'All Sessions', side:'LONG', regime_label:index < 12 ? 'TREND_DOWN' : 'MIXED',
    volatility_label:index < 12 ? 'HIGH' : 'NORMAL', vwap_reclaim_state:index < 12 ? 'FAILED' : 'HELD',
    net_pnl:index < 12 && losingPattern ? -10 : 1, mfe:2, mae:index < 12 ? -12 : -1,
    telemetry_complete:true, identity_verified:true, research_eligible:true,
  }));
}

test('caller booleans and counts cannot qualify Discovery evidence', () => {
  const input = rows({ count:49 });
  input[0].telemetry_complete = false;
  const result = evaluateVwapEvidenceSufficiency(input);
  assert.equal(result.sufficient, false);
  assert.deepEqual(result.blockers.map(item => item.code), ['DISCOVERY_ADMISSION_REQUIRED','INSUFFICIENT_DISCOVERY_TRADES','INSUFFICIENT_DISCOVERY_SESSIONS']);
  assert.equal(result.discovery_trade_count,0);
  assert.equal(result.unqualified_discovery_trade_count,49);
});

test('uses only authenticated discovery evidence for thresholds and excludes protected roles and Live', async t => {
  const input = rows();
  const fixture=await discoveryFixture(t,input);
  assert.equal(fixture.result.admitted,true);
  input.push({ ...input[0], trade_id:'validation-1', dataset_role:'VALIDATION', net_pnl:-9999 });
  input.push({ ...input[0], trade_id:'paper-1', dataset_role:'PAPER_ELIGIBLE', environment:'PAPER', net_pnl:-9999 });
  input.push({ ...input[0], trade_id:'live-1', dataset_role:'LIVE_REAL', environment:'LIVE_REAL', net_pnl:-9999 });
  const result = detectRecurringVwapFailures(input,{admission:fixture.result.admission,now:FIXTURE_NOW});
  assert.equal(result.disposition, 'INVESTIGATE');
  assert.equal(result.sufficiency.threshold_source, 'PREASSIGNED_POLICY_DISCOVERY_ONLY');
  assert.equal(result.sufficiency.eligible_paper_trade_count, 1);
  assert.equal(result.investigation_queue[0].net_pnl, -120);
  assert.ok(!result.source_trade_ids.includes('validation-1'));
  assert.ok(!result.source_trade_ids.includes('paper-1'));
  assert.ok(!result.source_trade_ids.includes('live-1'));
});

test('preserves source rows and produces deterministic ordering and hashes', async t => {
  const fixture=await discoveryFixture(t,rows()),options={admission:fixture.result.admission,now:FIXTURE_NOW};
  const first = detectRecurringVwapFailures(rows(),options);
  const second = detectRecurringVwapFailures([...rows()].reverse(),options);
  assert.equal(first.analysis_hash, second.analysis_hash);
  assert.deepEqual(first.investigation_queue, second.investigation_queue);
  assert.equal(first.investigation_queue[0].trade_count, 12);
  assert.equal(first.investigation_queue[0].loss_rate, 1);
  assert.equal(first.investigation_queue[0].source_trade_ids.length, 12);
  assert.equal(first.candidate_created, false);
});

test('records NO_CHANGE instead of manufacturing a candidate', async t => {
  const input=rows({losingPattern:false}),fixture=await discoveryFixture(t,input);
  const result = detectRecurringVwapFailures(input, { policy:DEFAULT_VWAP_LEARNING_POLICY,admission:fixture.result.admission,now:FIXTURE_NOW });
  assert.equal(result.disposition, 'NO_CHANGE');
  assert.deepEqual(result.investigation_queue, []);
  assert.equal(result.candidate_created, false);
  assert.match(result.next_action, /NO_CHANGE/);
});

test('different causal tuples cannot collide through delimiter characters',async t=>{
  const input=rows({count:2});
  Object.assign(input[0],{setup_id:'A|B',session_name:'C',regime_label:'same'});
  Object.assign(input[1],{setup_id:'A',session_name:'B|C',regime_label:'same'});
  const f=await discoveryFixture(t,input);
  const result=detectRecurringVwapFailures(input,{admission:f.result.admission,now:FIXTURE_NOW,
    policy:{...DEFAULT_VWAP_LEARNING_POLICY,minimum_comparable_trades:2,minimum_sessions:2,minimum_pattern_trades:2}});
  assert.equal(result.disposition,'NO_CHANGE');
  assert.deepEqual(result.investigation_queue,[]);
});

test('observed not-ready and unknown pre-event rows remain ledger evidence, not research cases',async t=>{
  const input=rows(); input[0].research_eligible=false; delete input[1].research_eligible;
  const f=await discoveryFixture(t,input);
  const result=detectRecurringVwapFailures(input,{admission:f.result.admission,now:FIXTURE_NOW});
  assert.equal(result.sufficiency.authenticated_closed_discovery_trade_count,60);
  assert.equal(result.sufficiency.discovery_trade_count,58);
  assert.equal(result.sufficiency.non_research_discovery_trade_count,2);
  assert.ok(!result.source_trade_ids.includes(input[0].trade_id));
  assert.ok(!result.source_trade_ids.includes(input[1].trade_id));
});

test('strategy identity contamination blocks sufficiency', async t => {
  const input = rows();
  const fixture=await discoveryFixture(t,input);
  input.push({ ...input[0], trade_id:'other-1', strategy_id:'another-strategy' });
  const result = detectRecurringVwapFailures(input,{admission:fixture.result.admission,now:FIXTURE_NOW});
  assert.equal(result.disposition, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.sufficiency.blockers.some(item => item.code === 'STRATEGY_ID_MISMATCH'));
});

test('authenticated coverage derives counts independently of caller quality flags',async t=>{
  const input=rows({count:49}); input[0].telemetry_complete=false; input[0].identity_verified=false;
  const fixture=await discoveryFixture(t,input);
  const result=evaluateVwapEvidenceSufficiency(input,{admission:fixture.result.admission,now:FIXTURE_NOW});
  assert.equal(result.discovery_trade_count,49);
  assert.deepEqual(result.blockers.map(item=>item.code),['INSUFFICIENT_DISCOVERY_TRADES']);
});

test('omitted, duplicated or changed rows invalidate the admitted cohort',async t=>{
  const input=rows(),fixture=await discoveryFixture(t,input),options={admission:fixture.result.admission,now:FIXTURE_NOW};
  for(const altered of [input.slice(1),[...input,input[0]],input.map((row,index)=>index?row:{...row,net_pnl:999})]){
    const result=evaluateVwapEvidenceSufficiency(altered,options);
    assert.equal(result.sufficient,false);assert.equal(result.discovery_trade_count,0);
    assert.equal(result.blockers[0].code,'DISCOVERY_ADMISSION_ROW_SET_MISMATCH');
  }
});

test('unknown causal context remains qualified ledger evidence but blocks inference',async t=>{
  const input=rows(); input[0]={...input[0],session_id:null,setup_id:null,regime_label:null,learning_context_complete:false};
  const fixture=await discoveryFixture(t,input);
  assert.equal(fixture.result.admitted,true);
  const result=detectRecurringVwapFailures(input,{admission:fixture.result.admission,now:FIXTURE_NOW});
  assert.equal(result.sufficiency.discovery_trade_count,60);
  assert.equal(result.disposition,'INSUFFICIENT_EVIDENCE');
  assert.ok(result.sufficiency.blockers.some(item=>item.code==='DISCOVERY_LEARNING_CONTEXT_GAPS'));
});

test('missing MFE and MAE stay unknown and never become numeric zero',async t=>{
  const input=rows().map(row=>({...row,mfe:null,mae:null}));
  const fixture=await discoveryFixture(t,input);
  const result=detectRecurringVwapFailures(input,{admission:fixture.result.admission,now:FIXTURE_NOW});
  assert.equal(result.disposition,'INVESTIGATE');
  assert.equal(result.investigation_queue[0].median_mfe,null);
  assert.equal(result.investigation_queue[0].median_mae,null);
});

test('null economics and boolean metrics cannot be coerced into zero',async t=>{
  const invalid=rows();invalid[0].net_pnl=null;
  assert.equal((await discoveryFixture(t,invalid)).result.admitted,false);
  const input=rows();input[0].mfe=false;
  const fixture=await discoveryFixture(t,input);
  assert.throws(()=>detectRecurringVwapFailures(input,{admission:fixture.result.admission,now:FIXTURE_NOW}),/TRADE_NUMERIC_FIELD_INVALID/);
});
