import fs from 'node:fs';
import { digest, exactKeys, objectHash, requireThat } from './common.mjs';

export const TARGETED_REPLAY_STRATEGY_ID='cicd-vwap-pull-back-strategy';
export const TARGETED_REPLAY_CONTRACT_VERSION='cicd-vwap-targeted-replay-behavior-contract/v1';
export const TARGETED_REPLAY_PLAN_VERSION='cicd-vwap-targeted-replay-plan/v1';
export const TARGETED_REPLAY_RESULT_VERSION='cicd-vwap-targeted-replay-result/v1';
export const TARGETED_REPLAY_CONTRACT_SHA256='sha256:8a6cdfacca4c004f88bdf6c1ffde9182d90cfab37caf8754c04bdaa1dd949def';

const CONTRACT_URL=new URL('./contracts/cicd-vwap-targeted-replay-behavior-v1.json',import.meta.url);
const STAGES=['AS_BUILT_DIAGNOSTIC','DISCOVERY_BEHAVIOR_EXPERIMENT','INDEPENDENT_CONFIRMATION'];
const INDEPENDENT_ROLES=new Set(['VALIDATION','BACKWARD_REGRESSION','PROTECTED_HOLDOUT','FORWARD']);
const TEST_ROLE=Object.freeze({BACKTEST:'DISCOVERY',ROBUSTNESS:'DISCOVERY',WALK_FORWARD:'VALIDATION',OOS_HOLDOUT:'PROTECTED_HOLDOUT'});
const REQUIRED_CASE_FIELDS=Object.freeze(['case_id','dataset_role_and_immutable_source','market_condition_pre_event_definition',
  'selector_version_and_all_match_count','start_end_timezone_warmup','baseline_and_candidate_code_binary_config_hashes',
  'expected_entry_stop_target_exit_behavior','actual_orders_fills_stop_target_exit_trace','fees_slippage_net_pnl',
  'avoided_losers_and_skipped_winners','counterexamples','run_receipt_and_evidence_hashes']);
const validHash=value=>typeof value==='string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value);
const normalizedHash=value=>`sha256:${String(value).toLowerCase().replace(/^sha256:/,'')}`;
const nonempty=value=>typeof value==='string' && value.trim().length>0;
const sameNumber=(left,right)=>Math.abs(Number(left)-Number(right))<=1e-6;

function requireHash(value,code='TARGETED_REPLAY_HASH_REQUIRED'){
  requireThat(validHash(value),422,code);return normalizedHash(value);
}

function validateContract(contract,raw=null){
  requireThat(contract?.schema_version===TARGETED_REPLAY_CONTRACT_VERSION
    && contract.strategy_id===TARGETED_REPLAY_STRATEGY_ID
    && contract.status==='ACTIVE_GOVERNANCE_NO_RUNTIME_AUTHORITY',409,'TARGETED_REPLAY_CONTRACT_IDENTITY_CONFLICT');
  requireThat(Array.isArray(contract.stages) && objectHash(contract.stages.map(stage=>stage.name))===objectHash(STAGES),
    409,'TARGETED_REPLAY_STAGE_ORDER_CONFLICT');
  const discovery=contract.stages[1],independent=contract.stages[2];
  requireThat(objectHash(discovery.allowed_source_roles)===objectHash(['DISCOVERY'])
    && !independent.allowed_source_roles.includes('DISCOVERY')
    && independent.allowed_source_roles.every(role=>INDEPENDENT_ROLES.has(role)),409,'TARGETED_REPLAY_ROLE_SEPARATION_CONFLICT');
  requireThat(objectHash(contract.required_per_case)===objectHash(REQUIRED_CASE_FIELDS),409,'TARGETED_REPLAY_CASE_EVIDENCE_CONFLICT');
  requireThat(contract.acceptance?.profit?.includes('positive net profit') && contract.acceptance.profit.includes('A smaller loss does not pass.'),
    409,'TARGETED_REPLAY_PROFIT_ACCEPTANCE_CONFLICT');
  requireThat(contract.safety?.production_version===null && contract.safety.automatic_approval===false
    && contract.safety.brain_normal_ingestion===false && contract.safety.live_real==='DISABLED'
    && contract.safety.real_order_routing==='PROHIBITED' && contract.safety.paper_requires_human_approval===true,
  409,'TARGETED_REPLAY_SAFETY_CONFLICT');
  if(raw!==null)requireThat(digest(raw)===TARGETED_REPLAY_CONTRACT_SHA256,409,'TARGETED_REPLAY_CONTRACT_HASH_CONFLICT');
  return contract;
}

export function readTargetedReplayBehaviorContract(){
  const raw=fs.readFileSync(CONTRACT_URL);
  return validateContract(JSON.parse(raw.toString('utf8')),raw);
}

function validateWindow(value,roleSet,idField){
  requireThat(value && typeof value==='object' && !Array.isArray(value),422,'TARGETED_REPLAY_CASE_REQUIRED');
  requireThat(nonempty(value[idField]) && roleSet.has(value.source_role),422,'TARGETED_REPLAY_CASE_ROLE_REQUIRED');
  requireThat(nonempty(value.dataset_id) && Number.isInteger(value.dataset_revision) && value.dataset_revision>0
    && validHash(value.dataset_manifest_sha256) && validHash(value.source_sha256),422,'TARGETED_REPLAY_IMMUTABLE_SOURCE_REQUIRED');
  requireThat(nonempty(value.contract) && nonempty(value.timezone),422,'TARGETED_REPLAY_CASE_SCOPE_REQUIRED');
  const warmup=Date.parse(value.warmup_start_utc),start=Date.parse(value.start_utc),end=Date.parse(value.end_utc);
  requireThat(Number.isFinite(warmup) && Number.isFinite(start) && Number.isFinite(end) && warmup<start && start<end
    && Number.isInteger(value.warmup_bars) && value.warmup_bars>0,422,'TARGETED_REPLAY_CASE_INTERVAL_REQUIRED');
  for(const field of ['baseline_source_sha256','baseline_binary_sha256','candidate_source_sha256','candidate_binary_sha256','config_sha256'])
    requireHash(value[field],'TARGETED_REPLAY_EXECUTION_IDENTITY_REQUIRED');
  requireThat(nonempty(value.expected_behavior) && nonempty(value.cost_model)
    && value.expected_behavior_detail && typeof value.expected_behavior_detail==='object'
    && !Array.isArray(value.expected_behavior_detail),422,'TARGETED_REPLAY_EXPECTATION_REQUIRED');
  exactKeys(value.expected_behavior_detail,['entry','stop','target','exit']);
  requireThat(Object.values(value.expected_behavior_detail).every(nonempty),422,'TARGETED_REPLAY_EXPECTATION_REQUIRED');
  return structuredClone(value);
}

function validateDiscoveryCase(value){
  const result=validateWindow(value,new Set(['DISCOVERY']),'case_id');
  requireThat(nonempty(value.pre_event_condition) && nonempty(value.selector_version)
    && value.all_match_count===1
    && Array.isArray(value.match_ids) && value.match_ids.length===value.all_match_count
    && value.match_ids[0]===value.case_id,422,'TARGETED_REPLAY_ALL_MATCHES_REQUIRED');
  return result;
}

function validateIndependentWindow(value){
  const result=validateWindow(value,INDEPENDENT_ROLES,'window_id');
  requireThat(value.predeclared===true && nonempty(value.pre_event_condition) && nonempty(value.selector_version)
    && value.eligible_window_count===1
    && Array.isArray(value.eligible_window_ids) && value.eligible_window_ids.length===value.eligible_window_count
    && value.eligible_window_ids[0]===value.window_id,422,'TARGETED_REPLAY_ALL_INDEPENDENT_WINDOWS_REQUIRED');
  return result;
}

export function validateTargetedReplayBehaviorPlan(plan,{requireReady=false}={}){
  readTargetedReplayBehaviorContract();
  requireThat(plan?.schema_version===TARGETED_REPLAY_PLAN_VERSION && plan.strategy_id===TARGETED_REPLAY_STRATEGY_ID,
    422,'TARGETED_REPLAY_PLAN_IDENTITY_REQUIRED');
  requireThat(plan.paper_use==='DESCRIPTIVE_ALARM_AND_AS_BUILT_DIAGNOSTIC_ONLY'
    && plan.paper_or_live_authorized===false,409,'TARGETED_REPLAY_PAPER_AUTHORITY_CONFLICT');
  requireThat(objectHash(plan.planned_replay_sequence)===objectHash([
    'AS_BUILT_DIAGNOSTIC_FOR_EXACT_SEEN_EPISODES_PARITY_ONLY',
    'DISCOVERY_BEHAVIOR_EXPERIMENT_FOR_ALL_PREDECLARED_QUALIFIED_MATCHES',
    'FROZEN_CANDIDATE_ALL_ELIGIBLE_INDEPENDENT_WINDOWS',
    'HUMAN_PAPER_REVIEW_ONLY_IF_PROFIT_AND_RISK_GATES_PASS']),409,'TARGETED_REPLAY_SEQUENCE_CONFLICT');
  if(plan.status!=='READY_FOR_GOVERNED_REPLAY'){
    requireThat(typeof plan.status==='string' && plan.status.startsWith('BLOCKED_'),422,'TARGETED_REPLAY_PLAN_STATUS_REQUIRED');
    requireThat(plan.candidate_selected===false && plan.selector_frozen===false && plan.qualified_causal_source===false
      && plan.physical_replay_host_attested===false && plan.separate_run_authority===false
      && Array.isArray(plan.blocked_by) && plan.blocked_by.length>0,409,'TARGETED_REPLAY_BLOCKED_PLAN_AUTHORITY_CONFLICT');
    requireThat(!requireReady,409,'TARGETED_REPLAY_PLAN_BLOCKED');
    return {status:'BLOCKED',plan_status:plan.status,strategy_id:plan.strategy_id,candidate_selected:false,run_authorized:false,
      plan_hash:objectHash(plan),contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256};
  }
  requireThat(hashesEqual(plan.contract_sha256,TARGETED_REPLAY_CONTRACT_SHA256),409,'TARGETED_REPLAY_CONTRACT_HASH_CONFLICT');
  requireThat(plan.candidate_selected===true && nonempty(plan.candidate_change_id) && plan.selector_frozen===true
    && plan.qualified_causal_source===true && plan.physical_replay_host_attested===true
    && plan.separate_run_authority===true,409,'TARGETED_REPLAY_EXECUTION_GATES_INCOMPLETE');
  requireThat(validHash(plan.physical_replay_host_attestation_sha256) && nonempty(plan.run_authority_id)
    && validHash(plan.run_authority_sha256),422,'TARGETED_REPLAY_AUTHORITY_RECEIPT_REQUIRED');
  requireThat(Array.isArray(plan.cases) && plan.cases.length>0
    && Array.isArray(plan.independent_windows) && plan.independent_windows.length>0,422,'TARGETED_REPLAY_FROZEN_UNIVERSE_REQUIRED');
  const cases=plan.cases.map(validateDiscoveryCase),independentWindows=plan.independent_windows.map(validateIndependentWindow);
  const ids=[...cases.map(value=>value.case_id),...independentWindows.map(value=>value.window_id)];
  requireThat(new Set(ids).size===ids.length,409,'TARGETED_REPLAY_CASE_DUPLICATE');
  const frozenCasePlanHash=objectHash({cases,independent_windows:independentWindows});
  requireThat(plan.frozen_case_plan_hash===frozenCasePlanHash,409,'TARGETED_REPLAY_FROZEN_PLAN_HASH_CONFLICT');
  return {status:'PLAN_VALIDATED_ONLY',strategy_id:plan.strategy_id,candidate_change_id:plan.candidate_change_id,
    case_count:cases.length,independent_window_count:independentWindows.length,plan_hash:objectHash(plan),
    frozen_case_plan_hash:frozenCasePlanHash,contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,cases,independent_windows:independentWindows};
}

function hashesEqual(left,right){return validHash(left) && validHash(right) && normalizedHash(left)===normalizedHash(right);}

export function validateTargetedReplayPlanBinding(plan,tests){
  const validated=validateTargetedReplayBehaviorPlan(plan,{requireReady:true});
  requireThat(Array.isArray(tests),422,'TARGETED_REPLAY_VALIDATION_TESTS_REQUIRED');
  const entries=new Map([
    ...validated.cases.map(value=>[value.case_id,value]),
    ...validated.independent_windows.map(value=>[value.window_id,value]),
  ]),used=new Set();
  for(const test of tests){
    const expectedRole=TEST_ROLE[test.kind];
    requireThat(expectedRole && Array.isArray(test.segments),422,'TARGETED_REPLAY_TEST_ROLE_REQUIRED');
    for(const segment of test.segments){
      const item=entries.get(segment.segment_id);
      requireThat(item && item.source_role===expectedRole && !used.has(segment.segment_id),409,'TARGETED_REPLAY_UNIVERSE_BINDING_CONFLICT');
      used.add(segment.segment_id);
      requireThat(item.dataset_id===segment.dataset_id && item.dataset_revision===segment.dataset_revision
        && hashesEqual(item.dataset_manifest_sha256,segment.dataset_manifest_hash) && item.contract===segment.contract
        && Date.parse(item.warmup_start_utc)===Date.parse(segment.warmup_start_utc)
        && Date.parse(item.start_utc)===Date.parse(segment.scored_start_utc)
        && Date.parse(item.end_utc)===Date.parse(segment.scored_end_utc),409,'TARGETED_REPLAY_WINDOW_BINDING_CONFLICT');
      requireThat(hashesEqual(item.baseline_source_sha256,test.baseline_execution_source_hash)
        && hashesEqual(item.baseline_binary_sha256,test.baseline_strategy_hash)
        && hashesEqual(item.candidate_source_sha256,test.candidate_execution_source_hash)
        && hashesEqual(item.candidate_binary_sha256,test.candidate_execution_hash),409,'TARGETED_REPLAY_EXECUTION_BINDING_CONFLICT');
    }
  }
  requireThat(used.size===entries.size,409,'TARGETED_REPLAY_ALL_MATCHES_NOT_SCHEDULED');
  return {schema_version:'cicd-vwap-targeted-replay-binding/v1',strategy_id:validated.strategy_id,
    contract_sha256:validated.contract_sha256,plan_hash:validated.plan_hash,frozen_case_plan_hash:validated.frozen_case_plan_hash,
    discovery_case_count:validated.case_count,independent_window_count:validated.independent_window_count,
    plan:structuredClone(plan)};
}

function validateTrace(value){
  requireThat(value && typeof value==='object' && !Array.isArray(value),422,'TARGETED_REPLAY_TRACE_REQUIRED');
  exactKeys(value,['orders','fills','stops','targets','exits']);
  requireThat(['orders','fills','stops','targets','exits'].every(key=>Array.isArray(value[key])),422,'TARGETED_REPLAY_TRACE_REQUIRED');
}

function validateCaseResult(record,item,segmentResult){
  exactKeys(record,REQUIRED_CASE_FIELDS);
  requireThat(record.case_id===(item.case_id || item.window_id),409,'TARGETED_REPLAY_RESULT_CASE_BINDING_CONFLICT');
  const source=record.dataset_role_and_immutable_source;
  exactKeys(source,['dataset_id','dataset_revision','source_role','dataset_manifest_sha256','source_sha256']);
  requireThat(source.dataset_id===item.dataset_id && source.dataset_revision===item.dataset_revision
    && source.source_role===item.source_role && hashesEqual(source.dataset_manifest_sha256,item.dataset_manifest_sha256)
    && hashesEqual(source.source_sha256,item.source_sha256),409,'TARGETED_REPLAY_RESULT_SOURCE_CONFLICT');
  requireThat(record.market_condition_pre_event_definition===item.pre_event_condition,409,'TARGETED_REPLAY_RESULT_CONDITION_CONFLICT');
  const selector=record.selector_version_and_all_match_count;
  exactKeys(selector,['selector_version','all_match_count','match_ids']);
  const expectedIds=item.match_ids || item.eligible_window_ids;
  requireThat(selector.selector_version===item.selector_version && selector.all_match_count===expectedIds.length
    && objectHash(selector.match_ids)===objectHash(expectedIds),409,'TARGETED_REPLAY_RESULT_SELECTOR_CONFLICT');
  const interval=record.start_end_timezone_warmup;
  exactKeys(interval,['warmup_start_utc','start_utc','end_utc','timezone','warmup_bars']);
  requireThat(Date.parse(interval.warmup_start_utc)===Date.parse(item.warmup_start_utc)
    && Date.parse(interval.start_utc)===Date.parse(item.start_utc) && Date.parse(interval.end_utc)===Date.parse(item.end_utc)
    && interval.timezone===item.timezone && interval.warmup_bars===item.warmup_bars,409,'TARGETED_REPLAY_RESULT_INTERVAL_CONFLICT');
  const hashes=record.baseline_and_candidate_code_binary_config_hashes;
  exactKeys(hashes,['baseline_source_sha256','baseline_binary_sha256','candidate_source_sha256','candidate_binary_sha256','config_sha256']);
  requireThat(Object.keys(hashes).every(key=>hashesEqual(hashes[key],item[key])),409,'TARGETED_REPLAY_RESULT_EXECUTION_IDENTITY_CONFLICT');
  const expected=record.expected_entry_stop_target_exit_behavior;
  exactKeys(expected,['entry','stop','target','exit']);
  requireThat(Object.values(expected).every(nonempty) && objectHash(expected)===objectHash(item.expected_behavior_detail),
    409,'TARGETED_REPLAY_RESULT_EXPECTATION_CONFLICT');
  const traces=record.actual_orders_fills_stop_target_exit_trace;
  exactKeys(traces,['baseline','candidate']);validateTrace(traces.baseline);validateTrace(traces.candidate);
  const costs=record.fees_slippage_net_pnl;
  exactKeys(costs,['baseline','candidate']);
  for(const side of ['baseline','candidate']){
    exactKeys(costs[side],['fees','slippage','net_pnl']);
    requireThat(Number.isFinite(costs[side].fees) && costs[side].fees>=0 && Number.isFinite(costs[side].slippage)
      && costs[side].slippage>=0 && Number.isFinite(costs[side].net_pnl)
      && sameNumber(costs[side].fees,segmentResult[side].fees) && sameNumber(costs[side].net_pnl,segmentResult[side].net_pnl),
    409,'TARGETED_REPLAY_RESULT_COST_CONFLICT');
  }
  const avoided=record.avoided_losers_and_skipped_winners;
  exactKeys(avoided,['avoided_loser_count','avoided_loser_trade_ids','skipped_winner_count','skipped_winner_trade_ids']);
  requireThat(Number.isInteger(avoided.avoided_loser_count) && avoided.avoided_loser_count>=0
    && Array.isArray(avoided.avoided_loser_trade_ids) && avoided.avoided_loser_trade_ids.length===avoided.avoided_loser_count
    && Number.isInteger(avoided.skipped_winner_count) && avoided.skipped_winner_count>=0
    && Array.isArray(avoided.skipped_winner_trade_ids) && avoided.skipped_winner_trade_ids.length===avoided.skipped_winner_count,
  422,'TARGETED_REPLAY_RESULT_COUNTERFACTUAL_REQUIRED');
  requireThat(Array.isArray(record.counterexamples),422,'TARGETED_REPLAY_RESULT_COUNTEREXAMPLES_REQUIRED');
  const receipts=record.run_receipt_and_evidence_hashes;
  exactKeys(receipts,['baseline','candidate']);
  for(const side of ['baseline','candidate']){
    exactKeys(receipts[side],['run_id','run_receipt_sha256','evidence_sha256']);
    requireThat(receipts[side].run_id===segmentResult[side].run_id
      && hashesEqual(receipts[side].run_receipt_sha256,segmentResult[side].completion_receipt_hash)
      && validHash(receipts[side].evidence_sha256),409,'TARGETED_REPLAY_RESULT_RECEIPT_CONFLICT');
  }
}

export function validateTargetedReplayResultBinding(planBinding,test,targeted,result){
  requireThat(planBinding?.schema_version==='cicd-vwap-targeted-replay-binding/v1',409,'TARGETED_REPLAY_BINDING_REQUIRED');
  exactKeys(targeted,['schema_version','contract_sha256','plan_hash','cases','independent_verdict']);
  requireThat(targeted.schema_version===TARGETED_REPLAY_RESULT_VERSION
    && hashesEqual(targeted.contract_sha256,TARGETED_REPLAY_CONTRACT_SHA256) && targeted.plan_hash===planBinding.plan_hash,
  409,'TARGETED_REPLAY_RESULT_BINDING_CONFLICT');
  requireThat(Array.isArray(targeted.cases) && targeted.cases.length===test.segments.length,
    422,'TARGETED_REPLAY_RESULT_CASES_REQUIRED');
  const sourceItems=new Map([
    ...planBinding.plan.cases.map(value=>[value.case_id,value]),
    ...planBinding.plan.independent_windows.map(value=>[value.window_id,value]),
  ]);
  for(let index=0;index<test.segments.length;index++)
    validateCaseResult(targeted.cases[index],sourceItems.get(test.segments[index].segment_id),result.segments[index]);
  if(TEST_ROLE[test.kind]==='DISCOVERY')requireThat(targeted.independent_verdict===null,409,'TARGETED_REPLAY_DISCOVERY_VERDICT_PROHIBITED');
  else{
    const verdict=targeted.independent_verdict;
    exactKeys(verdict,['all_predeclared_windows_reported','positive_net_after_costs','controlled_drawdown','no_single_trade_dependence',
      'candidate_net_pnl','max_drawdown','largest_winner_share','limits','verdict']);
    exactKeys(verdict.limits,['max_drawdown','max_largest_winner_share']);
    requireThat(Number.isFinite(verdict.candidate_net_pnl) && sameNumber(verdict.candidate_net_pnl,result.candidate.net_pnl)
      && Number.isFinite(verdict.max_drawdown) && verdict.max_drawdown>=0 && Number.isFinite(verdict.largest_winner_share)
      && verdict.largest_winner_share>=0 && verdict.largest_winner_share<=1 && Number.isFinite(verdict.limits.max_drawdown)
      && verdict.limits.max_drawdown>=0 && Number.isFinite(verdict.limits.max_largest_winner_share)
      && verdict.limits.max_largest_winner_share>=0 && verdict.limits.max_largest_winner_share<=1,
    422,'TARGETED_REPLAY_INDEPENDENT_METRICS_REQUIRED');
    const positive=verdict.candidate_net_pnl>0,drawdown=verdict.max_drawdown<=verdict.limits.max_drawdown,
      dependence=verdict.largest_winner_share<=verdict.limits.max_largest_winner_share;
    const passes=verdict.all_predeclared_windows_reported===true && positive && drawdown && dependence;
    requireThat(verdict.positive_net_after_costs===positive && verdict.controlled_drawdown===drawdown
      && verdict.no_single_trade_dependence===dependence && verdict.verdict===(passes?'PASS':'FAIL'),
    409,'TARGETED_REPLAY_INDEPENDENT_VERDICT_CONFLICT');
  }
  return structuredClone(targeted);
}
