import fs from 'node:fs';
import path from 'node:path';
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
const fields=(value,keys)=>{
  exactKeys(value,keys);
  requireThat(keys.every(key=>Object.hasOwn(value,key)),422,'TARGETED_REPLAY_REQUIRED_FIELD_MISSING');
};

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
  fields(value.expected_behavior_detail,['entry','stop','target','exit']);
  requireThat(Object.values(value.expected_behavior_detail).every(nonempty),422,'TARGETED_REPLAY_EXPECTATION_REQUIRED');
  return structuredClone(value);
}

function validateDiscoveryCase(value){
  const result=validateWindow(value,new Set(['DISCOVERY']),'case_id');
  requireThat(nonempty(value.pre_event_condition) && nonempty(value.selector_version)
    && Number.isSafeInteger(value.all_match_count) && value.all_match_count>0
    && Array.isArray(value.match_ids) && value.match_ids.length===value.all_match_count
    && new Set(value.match_ids).size===value.all_match_count && value.match_ids.every(nonempty)
    && value.match_ids.includes(value.case_id),422,'TARGETED_REPLAY_ALL_MATCHES_REQUIRED');
  return result;
}

function validateIndependentWindow(value){
  const result=validateWindow(value,INDEPENDENT_ROLES,'window_id');
  requireThat(value.predeclared===true && nonempty(value.pre_event_condition) && nonempty(value.selector_version)
    && Number.isSafeInteger(value.eligible_window_count) && value.eligible_window_count>0
    && Array.isArray(value.eligible_window_ids) && value.eligible_window_ids.length===value.eligible_window_count
    && new Set(value.eligible_window_ids).size===value.eligible_window_count && value.eligible_window_ids.every(nonempty)
    && value.eligible_window_ids.includes(value.window_id),422,'TARGETED_REPLAY_ALL_INDEPENDENT_WINDOWS_REQUIRED');
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
  for(const [items,idField,listField] of [[cases,'case_id','match_ids'],[independentWindows,'window_id','eligible_window_ids']]){
    for(const item of items){
      const group=items.filter(other=>other.selector_version===item.selector_version
        && other.pre_event_condition===item.pre_event_condition && other.source_role===item.source_role);
      requireThat(objectHash(group.map(other=>other[idField]).sort())===objectHash([...item[listField]].sort()),
        409,'TARGETED_REPLAY_SELECTOR_UNIVERSE_INCOMPLETE');
    }
  }
  fields(plan.independent_acceptance,['source_reference','source_sha256','max_drawdown','max_largest_winner_share']);
  requireThat(nonempty(plan.independent_acceptance.source_reference) && validHash(plan.independent_acceptance.source_sha256)
    && Number.isFinite(plan.independent_acceptance.max_drawdown) && plan.independent_acceptance.max_drawdown>=0
    && Number.isFinite(plan.independent_acceptance.max_largest_winner_share)
    && plan.independent_acceptance.max_largest_winner_share>0 && plan.independent_acceptance.max_largest_winner_share<1,
    422,'TARGETED_REPLAY_PREDECLARED_RISK_LIMITS_REQUIRED');
  const frozenCasePlanHash=objectHash({cases,independent_windows:independentWindows});
  requireThat(plan.frozen_case_plan_hash===frozenCasePlanHash,409,'TARGETED_REPLAY_FROZEN_PLAN_HASH_CONFLICT');
  return {status:'PLAN_VALIDATED_ONLY',strategy_id:plan.strategy_id,candidate_change_id:plan.candidate_change_id,
    case_count:cases.length,independent_window_count:independentWindows.length,plan_hash:objectHash(plan),
    authority_status:'UNPROVEN',run_authorized:false,
    frozen_case_plan_hash:frozenCasePlanHash,contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,cases,independent_windows:independentWindows};
}

function hashesEqual(left,right){return validHash(left) && validHash(right) && normalizedHash(left)===normalizedHash(right);}

export function validateTargetedReplayPlanBinding(plan,tests,{verifyAuthority}={}){
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
  // This callback is supplied only by the backend. Plan JSON cannot supply it.
  requireThat(typeof verifyAuthority==='function',409,'TARGETED_REPLAY_AUTHORITY_UNPROVEN');
  const authorityReceipt=verifyAuthority(plan);
  requireThat(authorityReceipt?.verified===true && authorityReceipt.plan_hash===validated.plan_hash,
    409,'TARGETED_REPLAY_AUTHORITY_UNPROVEN');
  return {schema_version:'cicd-vwap-targeted-replay-binding/v1',strategy_id:validated.strategy_id,
    contract_sha256:validated.contract_sha256,plan_hash:validated.plan_hash,frozen_case_plan_hash:validated.frozen_case_plan_hash,
    discovery_case_count:validated.case_count,independent_window_count:validated.independent_window_count,
    authority_receipt:structuredClone(authorityReceipt),plan:structuredClone(plan)};
}

export function verifyTargetedReplayAuthority(backend,row,plan){
  const humanId=backend.config.browser.subject_id;
  const readAttestation=(artifactId,expectedHash,schema)=>{
    const artifact=backend.artifactFor(row,artifactId,'EVIDENCE'),bytes=Buffer.from(artifact.content);
    requireThat(artifact.producer_id===humanId && hashesEqual(digest(bytes),expectedHash),409,'TARGETED_REPLAY_TRUSTED_ATTESTATION_REQUIRED');
    const receipt=JSON.parse(bytes.toString('utf8'));
    requireThat(receipt.schema_version===schema && receipt.strategy_id===row.strategy_id
      && receipt.instance_id===row.instance_id && receipt.candidate_hash===row.candidate_hash
      && receipt.frozen_case_plan_hash===plan.frozen_case_plan_hash && receipt.status==='VERIFIED'
      && receipt.acceptance_policy_hash===objectHash(plan.independent_acceptance)
      && Number.isFinite(Date.parse(receipt.verified_at_utc)) && Date.parse(receipt.verified_at_utc)<=Date.now()
      && Date.parse(receipt.expires_at_utc)>Date.now(),409,'TARGETED_REPLAY_ATTESTATION_SCOPE_CONFLICT');
    return receipt;
  };
  const host=readAttestation(plan.physical_replay_host_attestation_artifact_id,plan.physical_replay_host_attestation_sha256,
    'cicd-vwap-physical-replay-host-attestation/v1');
  requireThat(host.gate_issue_id==='OCEA-55',409,'TARGETED_REPLAY_HOST_GATE_UNPROVEN');
  const universe=readAttestation(plan.source_universe_attestation_artifact_id,plan.source_universe_attestation_sha256,
    'cicd-vwap-source-universe-attestation/v1');
  requireThat(universe.gate_issue_id==='OCEA-89' && universe.qualified_causal_source===true
    && universe.selector_uses_pre_event_inputs_only===true && universe.all_matches_verified===true
    && universe.all_independent_windows_verified===true
    && objectHash(universe.case_ids)===objectHash(plan.cases.map(item=>item.case_id))
    && objectHash(universe.independent_window_ids)===objectHash(plan.independent_windows.map(item=>item.window_id)),
    409,'TARGETED_REPLAY_SOURCE_UNIVERSE_UNPROVEN');
  const approval=backend.approved(row,'DEVELOPMENT',plan.run_authority_id);
  const runAuthority=readAttestation(plan.run_authority_artifact_id,plan.run_authority_sha256,
    'cicd-vwap-targeted-replay-run-authority/v1');
  requireThat(approval.decision.id===plan.run_authority_id && approval.binding.candidate_hash===row.candidate_hash
    && runAuthority.decision_id===approval.decision.id && runAuthority.scope==='BOUNDED_REPLAY_TESTS_ONLY'
    && runAuthority.paper_or_live_authorized===false
    && hashesEqual(objectHash(approval.binding),runAuthority.approval_binding_sha256),409,'TARGETED_REPLAY_RUN_AUTHORITY_UNPROVEN');
  return {verified:true,plan_hash:objectHash(plan),host_artifact_id:plan.physical_replay_host_attestation_artifact_id,
    universe_artifact_id:plan.source_universe_attestation_artifact_id,run_authority_artifact_id:plan.run_authority_artifact_id,
    decision_id:approval.decision.id};
}

function validateTrace(value,trades){
  requireThat(value && typeof value==='object' && !Array.isArray(value),422,'TARGETED_REPLAY_TRACE_REQUIRED');
  fields(value,['orders','fills','stops','targets','exits']);
  requireThat(['orders','fills','stops','targets','exits'].every(key=>Array.isArray(value[key])),422,'TARGETED_REPLAY_TRACE_REQUIRED');
  for(const events of Object.values(value))for(const event of events){
    requireThat(nonempty(event.event_id) && nonempty(event.trade_id) && Number.isFinite(Date.parse(event.at_utc))
      && nonempty(event.action),422,'TARGETED_REPLAY_TRACE_EVENT_REQUIRED');
  }
  for(const trade of trades)requireThat(['orders','fills','stops','targets','exits'].every(key=>value[key].some(event=>event.trade_id===trade.trade_id)),
    409,'TARGETED_REPLAY_NONZERO_TRADE_TRACE_REQUIRED');
}

function validateCaseResult(record,item,segmentResult,ledger){
  fields(record,REQUIRED_CASE_FIELDS);
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
  fields(hashes,['baseline_source_sha256','baseline_binary_sha256','candidate_source_sha256','candidate_binary_sha256','config_sha256']);
  requireThat(Object.keys(hashes).every(key=>hashesEqual(hashes[key],item[key])),409,'TARGETED_REPLAY_RESULT_EXECUTION_IDENTITY_CONFLICT');
  const expected=record.expected_entry_stop_target_exit_behavior;
  exactKeys(expected,['entry','stop','target','exit']);
  requireThat(Object.values(expected).every(nonempty) && objectHash(expected)===objectHash(item.expected_behavior_detail),
    409,'TARGETED_REPLAY_RESULT_EXPECTATION_CONFLICT');
  const traces=record.actual_orders_fills_stop_target_exit_trace;
  fields(traces,['baseline','candidate']);
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
  fields(receipts,['baseline','candidate']);
  const verifiedTrades={};
  for(const side of ['baseline','candidate']){
    fields(receipts[side],['run_id','run_receipt_sha256','evidence_sha256']);
    requireThat(receipts[side].run_id===segmentResult[side].run_id
      && hashesEqual(receipts[side].run_receipt_sha256,segmentResult[side].completion_receipt_hash)
      && validHash(receipts[side].evidence_sha256),409,'TARGETED_REPLAY_RESULT_RECEIPT_CONFLICT');
    const file=segmentResult.source_files?.find(file=>hashesEqual(file.sha256,receipts[side].evidence_sha256));
    requireThat(file && path.isAbsolute(file.path) && fs.statSync(file.path).isFile(),409,'TARGETED_REPLAY_TRACE_ARTIFACT_REQUIRED');
    const bytes=fs.readFileSync(file.path);
    requireThat(hashesEqual(digest(bytes),receipts[side].evidence_sha256),409,'TARGETED_REPLAY_TRACE_ARTIFACT_HASH_CONFLICT');
    const evidence=JSON.parse(bytes.toString('utf8'));
    requireThat(evidence.schema_version==='cicd-vwap-targeted-replay-trace/v1'
      && evidence.run_id===segmentResult[side].run_id && evidence.case_id===record.case_id
      && hashesEqual(evidence.config_sha256,item.config_sha256)
      && objectHash(evidence.trace)===objectHash(traces[side]) && Array.isArray(evidence.trades)
      && evidence.trades.length===segmentResult[side].trade_count
      && typeof evidence.zero_trade_case==='boolean' && evidence.zero_trade_case===(evidence.trades.length===0),
      409,'TARGETED_REPLAY_TRACE_ARTIFACT_SCOPE_CONFLICT');
    const tradeIds=new Set();
    requireThat(Array.isArray(ledger?.[side]) && ledger[side].length===evidence.trades.length,
      409,'TARGETED_REPLAY_TELEMETRY_TRADE_LEDGER_REQUIRED');
    for(const trade of evidence.trades){
      const observed=ledger[side].find(row=>String(row.trade_id)===trade.trade_id);
      requireThat(nonempty(trade.trade_id) && !tradeIds.has(trade.trade_id) && trade.run_id===evidence.run_id
        && Number.isFinite(Date.parse(trade.exit_utc)) && Date.parse(item.start_utc)<=Date.parse(trade.exit_utc)
        && Date.parse(trade.exit_utc)<Date.parse(item.end_utc)
        && ['gross_pnl','fees','slippage','net_pnl'].every(key=>Number.isFinite(trade[key]))
        && trade.fees>=0 && trade.slippage>=0 && sameNumber(trade.net_pnl,trade.gross_pnl-trade.fees)
        && observed && Number.isFinite(observed.exit_datetime) && trade.exit_sierra_datetime===observed.exit_datetime
        && sameNumber(trade.gross_pnl,observed.gross_currency_value) && sameNumber(trade.fees,observed.total_commission)
        && sameNumber(trade.net_pnl,observed.net_profit_loss),
        409,'TARGETED_REPLAY_TRACE_TRADE_INVALID');
      tradeIds.add(trade.trade_id);
    }
    validateTrace(evidence.trace,evidence.trades);
    requireThat(['fees','slippage','net_pnl'].every(key=>sameNumber(
      evidence.trades.reduce((sum,trade)=>sum+trade[key],0),costs[side][key])),409,'TARGETED_REPLAY_TRACE_METRICS_CONFLICT');
    requireThat(objectHash(evidence.expected_behavior)===objectHash(expected)
      && evidence.behavior_checks && ['entry','stop','target','exit','unrelated_rules_unchanged'].every(key=>typeof evidence.behavior_checks[key]==='boolean'),
      409,'TARGETED_REPLAY_BEHAVIOR_ASSESSMENT_REQUIRED');
    verifiedTrades[side]=evidence.trades.map(trade=>({...trade,behavior_passed:Object.values(evidence.behavior_checks).every(value=>value===true)}));
  }
  return verifiedTrades;
}

export function assessIndependentTrades(trades,limits){
  const sorted=[...trades].sort((a,b)=>a.exit_sierra_datetime-b.exit_sierra_datetime||a.run_id.localeCompare(b.run_id)||a.trade_id.localeCompare(b.trade_id));
  let equity=0,peak=0,maxDrawdown=0,grossWinners=0,largestWinner=0;
  for(const trade of sorted){equity+=trade.net_pnl;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,peak-equity);
    if(trade.net_pnl>0){grossWinners+=trade.net_pnl;largestWinner=Math.max(largestWinner,trade.net_pnl);}}
  const share=grossWinners>0?largestWinner/grossWinners:0;
  const positive=equity>0,drawdown=maxDrawdown<=limits.max_drawdown,
    dependence=share<=limits.max_largest_winner_share && equity-largestWinner>0;
  const behaviorPassed=sorted.every(trade=>trade.behavior_passed===true);
  return {candidate_net_pnl:equity,max_drawdown:maxDrawdown,largest_winner_share:share,
    positive_net_after_costs:positive,controlled_drawdown:drawdown,no_single_trade_dependence:dependence,
    behavior_passed:behaviorPassed,verdict:positive && drawdown && dependence && behaviorPassed?'PASS':'FAIL'};
}

export function validateTargetedReplayResultBinding(planBinding,test,targeted,result,{ledgerBySegment}={}){
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
  const candidateTrades=[];
  for(let index=0;index<test.segments.length;index++){
    const item=sourceItems.get(test.segments[index].segment_id);
    requireThat(item,409,'TARGETED_REPLAY_RESULT_CASE_BINDING_CONFLICT');
    candidateTrades.push(...validateCaseResult(targeted.cases[index],item,result.segments[index],ledgerBySegment?.get(test.segments[index].segment_id)).candidate);
  }
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
    const limits=planBinding.plan.independent_acceptance;
    requireThat(verdict.limits.max_drawdown===limits.max_drawdown
      && verdict.limits.max_largest_winner_share===limits.max_largest_winner_share,
      409,'TARGETED_REPLAY_PREDECLARED_RISK_LIMITS_CONFLICT');
    const actual=assessIndependentTrades(candidateTrades,limits);
    requireThat(['candidate_net_pnl','max_drawdown','largest_winner_share'].every(key=>sameNumber(verdict[key],actual[key]))
      && ['positive_net_after_costs','controlled_drawdown','no_single_trade_dependence'].every(key=>verdict[key]===actual[key])
      && verdict.verdict===(verdict.all_predeclared_windows_reported===true?actual.verdict:'FAIL'),
    409,'TARGETED_REPLAY_INDEPENDENT_VERDICT_CONFLICT');
  }
  return {...structuredClone(targeted),verified_candidate_trades:candidateTrades};
}
