import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, objectHash } from './common.mjs';
import { OperationalCandidateEvaluator } from './operational-candidate-evaluation.mjs';
import {
  TARGETED_REPLAY_CONTRACT_SHA256,
  TARGETED_REPLAY_RESULT_VERSION,
  readTargetedReplayBehaviorContract,
  validateTargetedReplayBehaviorPlan,
  validateTargetedReplayPlanBinding,
  validateTargetedReplayResultBinding,
} from './targeted-replay-behavior.mjs';

const sequence=[
  'AS_BUILT_DIAGNOSTIC_FOR_EXACT_SEEN_EPISODES_PARITY_ONLY',
  'DISCOVERY_BEHAVIOR_EXPERIMENT_FOR_ALL_PREDECLARED_QUALIFIED_MATCHES',
  'FROZEN_CANDIDATE_ALL_ELIGIBLE_INDEPENDENT_WINDOWS',
  'HUMAN_PAPER_REVIEW_ONLY_IF_PROFIT_AND_RISK_GATES_PASS',
];
const hash=name=>digest(name);
const behavior={entry:'Enter only when the frozen pre-event selector matches.',stop:'Preserve the declared initial stop.',
  target:'Preserve the declared target.',exit:'Record the terminal exit without changing unrelated VWAP rules.'};

function window(id,role,index){
  const start=`2025-0${index+1}-02T00:00:00.000Z`,end=`2025-0${index+1}-03T00:00:00.000Z`;
  return {window_id:id,source_role:role,predeclared:true,pre_event_condition:`condition-${id}`,selector_version:'selector-v1',
    eligible_window_count:1,eligible_window_ids:[id],dataset_id:`dataset-${id}`,dataset_revision:1,
    dataset_manifest_sha256:hash(`manifest-${id}`),source_sha256:hash(`source-${id}`),contract:'MNQZ25_FUT_CME',
    warmup_start_utc:`2025-0${index+1}-01T23:00:00.000Z`,start_utc:start,end_utc:end,timezone:'UTC',warmup_bars:12,
    baseline_source_sha256:hash('baseline-source'),baseline_binary_sha256:hash('baseline-binary'),
    candidate_source_sha256:hash('candidate-source'),candidate_binary_sha256:hash('candidate-binary'),config_sha256:hash('config'),
    expected_behavior:'Declared entry, stop, target and exit behavior.',expected_behavior_detail:behavior,cost_model:'Observed all-in fees plus declared slippage.'};
}

function readyPlan(){
  const discovery=['backtest','robustness'].map((id,index)=>{
    const value=window(id,'DISCOVERY',index);
    delete value.window_id;delete value.predeclared;delete value.eligible_window_count;delete value.eligible_window_ids;
    return {...value,case_id:id,all_match_count:1,match_ids:[id]};
  });
  const independent=[window('walk-forward','VALIDATION',2),window('holdout','PROTECTED_HOLDOUT',3)];
  return {schema_version:'cicd-vwap-targeted-replay-plan/v1',strategy_id:'cicd-vwap-pull-back-strategy',
    contract:'onboarding/targeted-replay-behavior-contract-v1.json',contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,
    status:'READY_FOR_GOVERNED_REPLAY',paper_use:'DESCRIPTIVE_ALARM_AND_AS_BUILT_DIAGNOSTIC_ONLY',planned_replay_sequence:sequence,
    candidate_change_id:'candidate-v1',candidate_selected:true,selector_frozen:true,qualified_causal_source:true,
    physical_replay_host_attested:true,physical_replay_host_attestation_sha256:hash('host-attestation'),
    separate_run_authority:true,run_authority_id:'authority-1',run_authority_sha256:hash('authority'),paper_or_live_authorized:false,
    cases:discovery,independent_windows:independent,
    frozen_case_plan_hash:objectHash({cases:discovery,independent_windows:independent})};
}

function testsFor(plan){
  const entries=[plan.cases[0],plan.cases[1],plan.independent_windows[0],plan.independent_windows[1]];
  return ['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].map((kind,index)=>{
    const item=entries[index];
    return {kind,baseline_strategy_hash:item.baseline_binary_sha256,baseline_execution_source_hash:item.baseline_source_sha256,
      candidate_execution_hash:item.candidate_binary_sha256,candidate_execution_source_hash:item.candidate_source_sha256,
      segments:[{segment_id:item.case_id || item.window_id,dataset_id:item.dataset_id,dataset_revision:item.dataset_revision,
        dataset_manifest_hash:item.dataset_manifest_sha256,contract:item.contract,warmup_start_utc:item.warmup_start_utc,
        scored_start_utc:item.start_utc,scored_end_utc:item.end_utc}]};
  });
}

function blockedPlan(){return {schema_version:'cicd-vwap-targeted-replay-plan/v1',strategy_id:'cicd-vwap-pull-back-strategy',
  status:'BLOCKED_NO_QUALIFIED_CAUSAL_DISCOVERY_OR_HOST_ATTESTATION',paper_use:'DESCRIPTIVE_ALARM_AND_AS_BUILT_DIAGNOSTIC_ONLY',
  planned_replay_sequence:sequence,candidate_selected:false,selector_frozen:false,qualified_causal_source:false,
  physical_replay_host_attested:false,separate_run_authority:false,paper_or_live_authorized:false,blocked_by:['OCEA-89','OCEA-55']};}

test('source-controlled contract preserves the approved immutable bytes and role separation',()=>{
  const contract=readTargetedReplayBehaviorContract();
  assert.equal(contract.strategy_id,'cicd-vwap-pull-back-strategy');
  assert.deepEqual(contract.stages.map(stage=>stage.name),['AS_BUILT_DIAGNOSTIC','DISCOVERY_BEHAVIOR_EXPERIMENT','INDEPENDENT_CONFIRMATION']);
});

test('blocked v0.6.235-class plans remain descriptive and fail closed when execution readiness is required',()=>{
  assert.equal(validateTargetedReplayBehaviorPlan(blockedPlan()).status,'BLOCKED');
  assert.throws(()=>validateTargetedReplayBehaviorPlan(blockedPlan(),{requireReady:true}),error=>error.code==='TARGETED_REPLAY_PLAN_BLOCKED');
});

test('ready plans bind every discovery match and independent window to the sealed Replay validation matrix',()=>{
  const plan=readyPlan(),binding=validateTargetedReplayPlanBinding(plan,testsFor(plan));
  assert.equal(binding.discovery_case_count,2);assert.equal(binding.independent_window_count,2);
  const missing=testsFor(plan);missing[0].segments=[];
  assert.throws(()=>validateTargetedReplayPlanBinding(plan,missing),error=>error.code==='TARGETED_REPLAY_ALL_MATCHES_NOT_SCHEDULED');
});

function targetedCase(item,segment){
  const ids=item.match_ids || item.eligible_window_ids;
  return {case_id:item.case_id || item.window_id,
    dataset_role_and_immutable_source:{dataset_id:item.dataset_id,dataset_revision:item.dataset_revision,source_role:item.source_role,
      dataset_manifest_sha256:item.dataset_manifest_sha256,source_sha256:item.source_sha256},
    market_condition_pre_event_definition:item.pre_event_condition,
    selector_version_and_all_match_count:{selector_version:item.selector_version,all_match_count:ids.length,match_ids:ids},
    start_end_timezone_warmup:{warmup_start_utc:item.warmup_start_utc,start_utc:item.start_utc,end_utc:item.end_utc,
      timezone:item.timezone,warmup_bars:item.warmup_bars},
    baseline_and_candidate_code_binary_config_hashes:{baseline_source_sha256:item.baseline_source_sha256,
      baseline_binary_sha256:item.baseline_binary_sha256,candidate_source_sha256:item.candidate_source_sha256,
      candidate_binary_sha256:item.candidate_binary_sha256,config_sha256:item.config_sha256},
    expected_entry_stop_target_exit_behavior:behavior,
    actual_orders_fills_stop_target_exit_trace:{baseline:{orders:[],fills:[],stops:[],targets:[],exits:[]},
      candidate:{orders:[],fills:[],stops:[],targets:[],exits:[]}},
    fees_slippage_net_pnl:{baseline:{fees:segment.baseline.fees,slippage:0,net_pnl:segment.baseline.net_pnl},
      candidate:{fees:segment.candidate.fees,slippage:0,net_pnl:segment.candidate.net_pnl}},
    avoided_losers_and_skipped_winners:{avoided_loser_count:0,avoided_loser_trade_ids:[],skipped_winner_count:0,skipped_winner_trade_ids:[]},
    counterexamples:[],run_receipt_and_evidence_hashes:{baseline:{run_id:segment.baseline.run_id,
      run_receipt_sha256:segment.baseline.completion_receipt_hash,evidence_sha256:hash('baseline-evidence')},
      candidate:{run_id:segment.candidate.run_id,run_receipt_sha256:segment.candidate.completion_receipt_hash,
        evidence_sha256:hash('candidate-evidence')}}};
}

test('independent verdict rejects a smaller loss even when the generic evidence-integrity result is PASS',()=>{
  const plan=readyPlan(),tests=testsFor(plan),binding=validateTargetedReplayPlanBinding(plan,tests),testPlan=tests[2],item=plan.independent_windows[0];
  const segment={segment_id:item.window_id,baseline:{run_id:'baseline-run',fees:1,net_pnl:-10,completion_receipt_hash:hash('baseline-receipt')},
    candidate:{run_id:'candidate-run',fees:1,net_pnl:-2,completion_receipt_hash:hash('candidate-receipt')}};
  const targeted={schema_version:TARGETED_REPLAY_RESULT_VERSION,contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,
    plan_hash:binding.plan_hash,cases:[targetedCase(item,segment)],independent_verdict:{all_predeclared_windows_reported:true,
      positive_net_after_costs:true,controlled_drawdown:true,no_single_trade_dependence:true,candidate_net_pnl:-2,max_drawdown:2,
      largest_winner_share:0.4,limits:{max_drawdown:5,max_largest_winner_share:0.5},verdict:'PASS'}};
  const result={segments:[segment],candidate:{net_pnl:-2}};
  assert.throws(()=>validateTargetedReplayResultBinding(binding,testPlan,targeted,result),
    error=>error.code==='TARGETED_REPLAY_INDEPENDENT_VERDICT_CONFLICT');
  targeted.independent_verdict.positive_net_after_costs=false;targeted.independent_verdict.verdict='FAIL';
  assert.equal(validateTargetedReplayResultBinding(binding,testPlan,targeted,result).independent_verdict.verdict,'FAIL');
});

test('candidate evaluation cannot call independently losing targeted evidence a benefit',()=>{
  const evaluator=new OperationalCandidateEvaluator({db:null,config:{},operationalLearning:{}});
  const request={evaluation_policy:{status:'PREDECLARED',minimum_positive_tests:2,maximum_negative_tests:0,
    minimum_cumulative_net_pnl_delta:1,minimum_candidate_trade_count:2},
    validation_plan:{content_json:JSON.stringify({targeted_replay:{schema_version:'cicd-vwap-targeted-replay-binding/v1'}})}};
  const echoes=['WALK_FORWARD','OOS_HOLDOUT'].map(kind=>({kind,baseline_net_pnl:-10,candidate_net_pnl:-2,candidate_trade_count:1,
    targeted_independent_verdict:{verdict:'FAIL',all_predeclared_windows_reported:true,positive_net_after_costs:false,
      controlled_drawdown:true,no_single_trade_dependence:true}}));
  const assessment=evaluator.policyAssessment(request,echoes);
  assert.equal(assessment.cumulative_net_pnl_delta,16);
  assert.equal(assessment.targeted_independent.candidate_net_pnl,-4);
  assert.equal(assessment.thresholds_met,false);
});
