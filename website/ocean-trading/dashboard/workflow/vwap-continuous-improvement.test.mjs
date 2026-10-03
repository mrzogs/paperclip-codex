import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VWAP_LEARNING_POLICY, detectRecurringVwapFailures, evaluateVwapEvidenceSufficiency, VWAP_STRATEGY_ID } from './vwap-continuous-improvement.mjs';

function rows({ count = 60, losingPattern = true } = {}) {
  return Array.from({ length:count }, (_, index) => ({
    trade_id:`trade-${String(index).padStart(3, '0')}`,
    strategy_id:VWAP_STRATEGY_ID,
    dataset_role:'DISCOVERY', environment:'REPLAY',
    session_id:`session-${index % 20}`,
    setup_id:index < 12 && losingPattern ? 'late-reclaim' : `baseline-${index}`,
    session_name:'All Sessions', side:'LONG', regime_label:index < 12 ? 'TREND_DOWN' : 'MIXED',
    volatility_label:index < 12 ? 'HIGH' : 'NORMAL', vwap_reclaim_state:index < 12 ? 'FAILED' : 'HELD',
    net_pnl:index < 12 && losingPattern ? -10 : 1, mfe:2, mae:index < 12 ? -12 : -1,
    telemetry_complete:true, identity_verified:true,
  }));
}

test('refuses learning when discovery evidence or quality is insufficient', () => {
  const input = rows({ count:49 });
  input[0].telemetry_complete = false;
  const result = evaluateVwapEvidenceSufficiency(input);
  assert.equal(result.sufficient, false);
  assert.deepEqual(result.blockers.map(item => item.code), ['INSUFFICIENT_DISCOVERY_TRADES', 'TELEMETRY_OR_IDENTITY_GAPS']);
});

test('uses only discovery evidence for thresholds and excludes protected roles and Live', () => {
  const input = rows();
  input.push({ ...input[0], trade_id:'validation-1', dataset_role:'VALIDATION', net_pnl:-9999 });
  input.push({ ...input[0], trade_id:'paper-1', dataset_role:'PAPER_ELIGIBLE', environment:'PAPER', net_pnl:-9999 });
  input.push({ ...input[0], trade_id:'live-1', dataset_role:'LIVE_REAL', environment:'LIVE_REAL', net_pnl:-9999 });
  const result = detectRecurringVwapFailures(input);
  assert.equal(result.disposition, 'INVESTIGATE');
  assert.equal(result.sufficiency.threshold_source, 'PREASSIGNED_POLICY_DISCOVERY_ONLY');
  assert.equal(result.sufficiency.eligible_paper_trade_count, 1);
  assert.equal(result.investigation_queue[0].net_pnl, -120);
  assert.ok(!result.source_trade_ids.includes('validation-1'));
  assert.ok(!result.source_trade_ids.includes('paper-1'));
  assert.ok(!result.source_trade_ids.includes('live-1'));
});

test('preserves source rows and produces deterministic ordering and hashes', () => {
  const first = detectRecurringVwapFailures(rows());
  const second = detectRecurringVwapFailures([...rows()].reverse());
  assert.equal(first.analysis_hash, second.analysis_hash);
  assert.deepEqual(first.investigation_queue, second.investigation_queue);
  assert.equal(first.investigation_queue[0].trade_count, 12);
  assert.equal(first.investigation_queue[0].loss_rate, 1);
  assert.equal(first.investigation_queue[0].source_trade_ids.length, 12);
  assert.equal(first.candidate_created, false);
});

test('records NO_CHANGE instead of manufacturing a candidate', () => {
  const result = detectRecurringVwapFailures(rows({ losingPattern:false }), { policy:DEFAULT_VWAP_LEARNING_POLICY });
  assert.equal(result.disposition, 'NO_CHANGE');
  assert.deepEqual(result.investigation_queue, []);
  assert.equal(result.candidate_created, false);
  assert.match(result.next_action, /NO_CHANGE/);
});

test('strategy identity contamination blocks sufficiency', () => {
  const input = rows();
  input.push({ ...input[0], trade_id:'other-1', strategy_id:'another-strategy' });
  const result = detectRecurringVwapFailures(input);
  assert.equal(result.disposition, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.sufficiency.blockers.some(item => item.code === 'STRATEGY_ID_MISMATCH'));
});
