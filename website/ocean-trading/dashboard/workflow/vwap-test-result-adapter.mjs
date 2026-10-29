import path from 'node:path';
import { digest, objectHash, requireThat } from './common.mjs';
import { createVwapBoundedArtifactReader } from './vwap-bounded-artifacts.mjs';
import { TARGETED_REPLAY_RESULT_VERSION, TARGETED_REPLAY_CONTRACT_SHA256, TARGETED_REPLAY_STRATEGY_ID,
  assessIndependentTrades, validateTargetedReplayBehaviorPlan, validateTargetedReplayResultBinding } from './targeted-replay-behavior.mjs';

export const VWAP_TEST_RESULT_ADAPTER_VERSION='vwap-test-result-adapter/v1';
const sides=['baseline','candidate'];
const roles={BACKTEST:'DISCOVERY',ROBUSTNESS:'DISCOVERY',WALK_FORWARD:'VALIDATION',OOS_HOLDOUT:'PROTECTED_HOLDOUT'};
const hash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const nonempty=value=>typeof value==='string' && value.trim().length>0;
const same=(a,b)=>Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=1e-6;
const timestamp=value=>{const parsed=typeof value==='string'?Date.parse(value):NaN;
  requireThat(Number.isFinite(parsed),422,'VWAP_ADAPTER_TIMESTAMP_REQUIRED');return parsed;};
const check=(condition,code)=>requireThat(condition,409,`VWAP_ADAPTER_${code}`);

// Artifact roots and authenticators are application-owned dependencies. Nothing in
// the submitted JSON can supply an authenticator or an authenticated=true flag.
function artifact(ref,purpose,reader){
  check(ref && nonempty(ref.id) && ref.purpose===purpose && hash(ref.sha256)
    && (purpose==='TRACE'&&ref.byte_length===undefined || Number.isSafeInteger(ref.byte_length)&&ref.byte_length>0&&ref.byte_length<=reader.maxArtifactBytes),
  'ARTIFACT_REFERENCE_INVALID');
  check(path.isAbsolute(ref.path),'ARTIFACT_PATH_REQUIRED');
  const {bytes}=reader.read(ref);
  check((ref.byte_length===undefined||bytes.length===ref.byte_length) && digest(bytes)===ref.sha256,'ARTIFACT_HASH_CONFLICT');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{check(false,'ARTIFACT_JSON_INVALID');}
  return {ref:{...structuredClone(ref),byte_length:bytes.length},bytes,value};
}

function authenticated(verifier,item,expected,dependencies=null){
  check(typeof verifier==='function','AUTHENTICATOR_REQUIRED');
  const verification=verifier({artifact:structuredClone(item.ref),bytes:Buffer.from(item.bytes),
    payload:structuredClone(item.value),expected:structuredClone(expected),expected_dependencies:structuredClone(dependencies)});
  check(verification && typeof verification.then!=='function' && verification.authenticated===true
    && nonempty(verification.principal_id) && hash(verification.trust_policy_sha256) && verification.payload_sha256===item.ref.sha256
    && verification.claims && typeof verification.claims==='object','AUTHENTICATION_UNPROVEN');
  if(dependencies)check(Object.entries(dependencies).every(([key,value])=>verification.verified_dependencies?.[key]===value),
    'PHYSICAL_AUTHORITY_CHAIN_UNPROVEN');
  return {claims:structuredClone(verification.claims),trust_policy_sha256:verification.trust_policy_sha256,
    principal_id:verification.principal_id};
}

function scope(claims,expected){
  check(Object.entries(expected).every(([key,value])=>claims[key]===value),'AUTHENTICATED_SCOPE_CONFLICT');
}

function reconcileOriginals(originals,{project_id,candidate_hash,plan_hash,run_id,window_id,source_role,
  source_sha256,currency,cost_model_sha256},item,protocol,trace){
  const traceTrades=trace.trades;
  scope(originals,{project_id,candidate_hash,plan_hash,run_id,window_id,source_role,source_sha256,currency,cost_model_sha256});
  check(originals.schema_version==='vwap-trade-originals/v1' && Array.isArray(originals.trades)
    && Array.isArray(originals.fills),'ORIGINALS_REQUIRED');
  check(originals.trades.length===traceTrades.length,'ORIGINAL_TRADE_COVERAGE_CONFLICT');
  check(Array.isArray(trace.trace?.fills) && trace.trace.fills.length===originals.fills.length
    && new Set(trace.trace.fills.map(fill=>fill.fill_id)).size===originals.fills.length,'ORIGINAL_NATIVE_FILL_COVERAGE_CONFLICT');
  const tradeIds=new Set(),fillIds=new Set(),usedFills=new Set();
  for(const fill of originals.fills){
    check(nonempty(fill.fill_id) && !fillIds.has(fill.fill_id) && nonempty(fill.trade_id)
      && nonempty(fill.order_id) && nonempty(fill.leg_id) && fill.currency===currency
      && ['ENTRY','EXIT'].includes(fill.action) && Number.isFinite(fill.quantity) && fill.quantity>0
      && Number.isFinite(fill.price) && Number.isFinite(fill.fees) && fill.fees>=0
      && Number.isFinite(fill.slippage) && fill.slippage>=0,'ORIGINAL_FILL_INVALID');
    timestamp(fill.at_utc);fillIds.add(fill.fill_id);
    const observed=trace.trace?.fills?.find(event=>event.fill_id===fill.fill_id);
    check(observed && ['trade_id','order_id','leg_id','at_utc','action','currency'].every(key=>observed[key]===fill[key])
      && ['quantity','price','fees','slippage'].every(key=>same(observed[key],fill[key]))
      && trace.trace?.orders?.some(event=>event.order_id===fill.order_id && event.trade_id===fill.trade_id),
    'ORIGINAL_NATIVE_FILL_LINK_CONFLICT');
    if(fill.native_sequence!==undefined&&fill.native_sequence!==null || observed?.native_sequence!==undefined&&observed.native_sequence!==null)
      check(Number.isSafeInteger(fill.native_sequence)&&fill.native_sequence>=0&&observed.native_sequence===fill.native_sequence,'ORIGINAL_NATIVE_SEQUENCE_CONFLICT');
  }
  let totalQuantity=0;
  for(const trade of originals.trades){
    check(nonempty(trade.trade_id) && !tradeIds.has(trade.trade_id) && ['LONG','SHORT'].includes(trade.side)
      && nonempty(trade.opportunity_id)
      && Number.isFinite(trade.quantity) && trade.quantity>0 && Array.isArray(trade.fill_ids)
      && trade.fill_ids.length>0 && new Set(trade.fill_ids).size===trade.fill_ids.length,'ORIGINAL_TRADE_INVALID');
    tradeIds.add(trade.trade_id);
    const observed=traceTrades.find(row=>row.trade_id===trade.trade_id);
    const entry=timestamp(trade.entry_utc),exit=timestamp(trade.exit_utc);
    check(entry>=timestamp(item.start_utc) && exit>=entry && exit<timestamp(item.end_utc),'BOUNDARY_TRADE_UNSCORED_REQUIRED');
    check(observed && observed.run_id===run_id && observed.opportunity_id===trade.opportunity_id && observed.exit_utc===trade.exit_utc
      && same(observed.exit_sierra_datetime,trade.exit_sierra_datetime)
      && ['gross_pnl','fees','slippage','net_pnl'].every(key=>same(trade[key],observed[key])),'ORIGINAL_TRACE_RECONCILIATION_CONFLICT');
    const fills=originals.fills.filter(fill=>fill.trade_id===trade.trade_id);
    check(objectHash(fills.map(fill=>fill.fill_id).sort())===objectHash([...trade.fill_ids].sort()),'ORIGINAL_FILL_COVERAGE_CONFLICT');
    let quantity=0,average=0,gross=0,fees=0,slippage=0,entries=0,last=-Infinity;
    for(const fill of fills){
      const at=timestamp(fill.at_utc);
      check(at>=last && at>=entry && at<=exit && !usedFills.has(fill.fill_id),'ORIGINAL_FILL_ORDER_CONFLICT');
      last=at;usedFills.add(fill.fill_id);fees+=fill.fees;slippage+=fill.slippage;
      if(fill.action==='ENTRY'){
        average=(average*quantity+fill.price*fill.quantity)/(quantity+fill.quantity);
        quantity+=fill.quantity;entries+=fill.quantity;
      }else{
        check(fill.quantity<=quantity+1e-9,'ORIGINAL_EXIT_QUANTITY_CONFLICT');
        gross+=(fill.price-average)*fill.quantity*protocol.point_value*(trade.side==='LONG'?1:-1);
        quantity-=fill.quantity;
      }
    }
    // Execution slippage is already reflected in observed fill prices. Subtracting
    // it again would conflict with Ocean/Sierra's gross-minus-fees ledger contract.
    check(same(quantity,0) && same(entries,trade.quantity) && same(gross,trade.gross_pnl)
      && same(fees,trade.fees) && same(slippage,trade.slippage)
      && same(trade.net_pnl,gross-fees),'ORIGINAL_COST_QUANTITY_RECONCILIATION_CONFLICT');
    check(fills[0].action==='ENTRY' && timestamp(fills[0].at_utc)===entry
      && fills.at(-1).action==='EXIT' && timestamp(fills.at(-1).at_utc)===exit,'ORIGINAL_TRADE_BOUNDARY_CONFLICT');
    if(trade.native_exit_sequence!==undefined&&trade.native_exit_sequence!==null)
      check(Number.isSafeInteger(trade.native_exit_sequence)&&trade.native_exit_sequence>=0
        &&trade.native_exit_sequence===fills.at(-1).native_sequence&&observed.native_exit_sequence===trade.native_exit_sequence,
      'ORIGINAL_NATIVE_EXIT_SEQUENCE_CONFLICT');
    totalQuantity+=entries;
  }
  check(usedFills.size===originals.fills.length,'EXTRA_ORIGINAL_FILL');
  return {trades:originals.trades,total_entry_quantity:totalQuantity};
}

function comparisonCoverage(comparisons,baseline,candidate,record,tracePayloads,{item,runs,expected}){
  check(Array.isArray(comparisons),'COMPARISON_COVERAGE_REQUIRED');
  const seen={baseline:new Set(),candidate:new Set()},avoided=[],skipped=[];
  for(const comparison of comparisons){
    check(nonempty(comparison.reason) && ['MATCHED','CHANGED_FILL','AVOIDED_LOSER','SKIPPED_WINNER','UNKNOWN'].includes(comparison.status),
      'COMPARISON_CLASSIFICATION_REQUIRED');
    const matched={};
    for(const side of sides){
      const id=comparison[`${side}_trade_id`];
      if(id===null){matched[side]=null;continue;}
      matched[side]=(side==='baseline'?baseline:candidate).find(trade=>trade.trade_id===id);
      check(matched[side] && !seen[side].has(id),'COMPARISON_TRADE_COVERAGE_CONFLICT');seen[side].add(id);
    }
    check(matched.baseline || matched.candidate,'COMPARISON_EMPTY');
    if(['AVOIDED_LOSER','SKIPPED_WINNER'].includes(comparison.status)){
      check(matched.baseline && !matched.candidate && (comparison.status==='AVOIDED_LOSER'
        ?matched.baseline.net_pnl<0:matched.baseline.net_pnl>0),'COUNTERFACTUAL_CLASSIFICATION_CONFLICT');
      check(nonempty(comparison.opportunity_id) && matched.baseline.opportunity_id===comparison.opportunity_id
        && tracePayloads.candidate.no_entries?.some(event=>event.opportunity_id===comparison.opportunity_id
          && nonempty(event.event_id) && nonempty(event.reason) && Number.isFinite(Date.parse(event.at_utc))
          && timestamp(event.at_utc)>=timestamp(item.start_utc)&&timestamp(event.at_utc)<timestamp(item.end_utc)
          && event.run_id===runs.candidate&&event.window_id===(item.case_id||item.window_id)
          && event.project_id===expected.project_id&&event.candidate_hash===expected.candidate_hash
          && event.plan_hash===expected.plan_hash&&event.source_sha256===item.source_sha256),
      'COUNTERFACTUAL_NATIVE_OPPORTUNITY_UNPROVEN');
      (comparison.status==='AVOIDED_LOSER'?avoided:skipped).push(matched.baseline.trade_id);
    }
    if(['MATCHED','CHANGED_FILL'].includes(comparison.status)){
      check(matched.baseline && matched.candidate,'COMPARISON_PAIR_REQUIRED');
      check(matched.baseline.opportunity_id===matched.candidate.opportunity_id
        && comparison.opportunity_id===matched.baseline.opportunity_id,'COMPARISON_NATIVE_OPPORTUNITY_CONFLICT');
    }
  }
  check(seen.baseline.size===baseline.length && seen.candidate.size===candidate.length,'COMPARISON_INCOMPLETE');
  const summary=record.avoided_losers_and_skipped_winners;
  check(summary && summary.avoided_loser_count===avoided.length && summary.skipped_winner_count===skipped.length
    && objectHash([...summary.avoided_loser_trade_ids].sort())===objectHash(avoided.sort())
    && objectHash([...summary.skipped_winner_trade_ids].sort())===objectHash(skipped.sort()),'COUNTERFACTUAL_SUMMARY_CONFLICT');
  check(sides.every(side=>Array.isArray(tracePayloads[side].counterexamples))
    && objectHash(record.counterexamples)===objectHash(sides.flatMap(side=>tracePayloads[side].counterexamples)),
  'COUNTEREXAMPLE_COVERAGE_CONFLICT');
}

/**
 * Offline admission into the existing targeted replay evaluator contract.
 * Verifiers are trusted host/service adapters, never fields accepted from a client.
 * This function neither runs a Replay nor writes a workflow job or Brain record.
 */
export function adaptVwapTestResult(input,{evidenceRoot,verifyProtocol,verifyPhysicalReceipt,evaluatorPrincipalId,now=Date.now(),maxArtifactBytes=16*1024*1024,maxTotalArtifactBytes=64*1024*1024,artifactReader}={}){
  check(typeof verifyProtocol==='function' && typeof verifyPhysicalReceipt==='function','AUTHENTICATOR_REQUIRED');
  check(Number.isFinite(now) && Number.isSafeInteger(maxArtifactBytes) && maxArtifactBytes>0,'BOUNDS_REQUIRED');
  check(typeof evidenceRoot==='string'&&path.isAbsolute(evidenceRoot),'EVIDENCE_ROOT_REQUIRED');
  const reader=artifactReader || createVwapBoundedArtifactReader({root:evidenceRoot,maxArtifactBytes,maxTotalArtifactBytes,codePrefix:'VWAP_ADAPTER_ARTIFACT_'});
  const {project_id,candidate_hash,planBinding,test,result}=input;
  check(project_id===TARGETED_REPLAY_STRATEGY_ID && hash(candidate_hash) && planBinding?.strategy_id===project_id
    && objectHash(planBinding.plan)===planBinding.plan_hash && planBinding.authority_receipt?.verified===true,
  'PLAN_BINDING_CONFLICT');
  validateTargetedReplayBehaviorPlan(planBinding.plan,{requireReady:true});
  const protocolItem=artifact(input.protocol_ref,'FROZEN_PROTOCOL',reader);
  const expected={project_id,candidate_hash,plan_hash:planBinding.plan_hash};
  const protocolVerification=authenticated(verifyProtocol,protocolItem,expected),protocol=protocolVerification.claims;
  scope(protocol,expected);
  check(nonempty(protocol.candidate_author_id) && nonempty(protocol.independent_reviewer_id)
    && nonempty(protocol.independent_evaluator_id) && protocol.candidate_author_id!==protocol.independent_reviewer_id
    && protocol.candidate_author_id!==protocol.independent_evaluator_id && evaluatorPrincipalId===protocol.independent_evaluator_id,
  'INDEPENDENT_ACTOR_REQUIRED');
  check(protocol.schema_version==='vwap-independent-protocol/v1' && nonempty(protocol.currency)
    && hash(protocol.cost_model_sha256) && protocol.slippage_accounting==='IN_FILL_PRICES'
    && Number.isFinite(protocol.point_value) && protocol.point_value>0
    && Number.isSafeInteger(protocol.max_receipt_age_ms) && protocol.max_receipt_age_ms>0
    && ['EQUAL_TOTAL_ENTRY_QUANTITY','REPORT_DIFFERENCE'].includes(protocol.exposure_policy),'FROZEN_COST_POLICY_REQUIRED');
  const frozen=timestamp(protocol.frozen_at_utc),expires=timestamp(protocol.expires_at_utc);
  check(frozen<=now && frozen<expires && expires>now,'PROTOCOL_STALE');
  const items=[...planBinding.plan.cases,...planBinding.plan.independent_windows];
  const windows=items.map(item=>({window_id:item.case_id || item.window_id,source_role:item.source_role,source_sha256:item.source_sha256}));
  check(objectHash(protocol.windows)===objectHash(windows),'FROZEN_WINDOW_COVERAGE_CONFLICT');
  check(protocol.authority_receipt_sha256===objectHash(planBinding.authority_receipt)
    && protocol.test_hashes?.[test?.kind]===objectHash(test),'FROZEN_TEST_BINDING_CONFLICT');
  check(roles[test?.kind] && Array.isArray(test.segments) && test.segments.length>0
    && Array.isArray(result?.segments) && result.segments.length===test.segments.length,'TEST_SEGMENT_COVERAGE_CONFLICT');
  if(roles[test.kind]!=='DISCOVERY')check(objectHash(test.segments.map(segment=>segment.segment_id).sort())===objectHash(
    planBinding.plan.independent_windows.filter(window=>window.source_role===roles[test.kind]).map(window=>window.window_id).sort()),
  'INDEPENDENT_WINDOW_COVERAGE_CONFLICT');
  const evidence=artifact(input.case_evidence_ref,'TARGETED_CASE_EVIDENCE',reader);
  scope(evidence.value,expected);
  check(evidence.value.schema_version==='vwap-case-evidence/v1' && Array.isArray(evidence.value.cases)
    && evidence.value.cases.length===test.segments.length && Array.isArray(input.physical_runs)
    && input.physical_runs.length===test.segments.length*2,'PHYSICAL_RUN_COVERAGE_CONFLICT');
  const ledgers=new Map(),proofs=[],exposure=[],used=new Set(),runIds=new Set(),retainedTraces=new Map();
  for(let index=0;index<test.segments.length;index++){
    const segment=test.segments[index],measured=result.segments[index],record=evidence.value.cases[index];
    const item=items.find(value=>(value.case_id || value.window_id)===segment.segment_id);
    check(item && item.source_role===roles[test.kind] && measured.segment_id===segment.segment_id
      && record.case_id===segment.segment_id && !used.has(segment.segment_id),'SEGMENT_SCOPE_CONFLICT');used.add(segment.segment_id);
    const ledger={},originals={},tracePayloads={},runs={};
    for(const side of sides){
      const run=input.physical_runs.find(value=>value.window_id===segment.segment_id && value.side===side);
      check(run && run.run_id===measured[side].run_id && run.run_id===segment[`${side}_run_id`]
        && !runIds.has(run.run_id),'PHYSICAL_RUN_IDENTITY_CONFLICT');runIds.add(run.run_id);
      runs[side]=run.run_id;
      const runExpected={...expected,run_id:run.run_id,window_id:segment.segment_id,side,source_role:item.source_role,
        execution_namespace:'TEST',dataset_role:item.source_role,
        source_sha256:item.source_sha256,config_sha256:item.config_sha256,
        strategy_source_sha256:item[`${side}_source_sha256`],strategy_binary_sha256:item[`${side}_binary_sha256`],
        protocol_sha256:input.protocol_ref.sha256,warmup_start_utc:item.warmup_start_utc,
        start_utc:item.start_utc,end_utc:item.end_utc,timezone:item.timezone};
      const start=artifact(run.start_receipt_ref,'PHYSICAL_START',reader);
      const terminal=artifact(run.terminal_receipt_ref,'PHYSICAL_TERMINAL',reader);
      const dependencies={host_attestation_sha256:planBinding.plan.physical_replay_host_attestation_sha256,
        run_authority_sha256:planBinding.plan.run_authority_sha256};
      const startVerification=authenticated(verifyPhysicalReceipt,start,{...runExpected,purpose:'PHYSICAL_START'},dependencies);
      const endVerification=authenticated(verifyPhysicalReceipt,terminal,{...runExpected,purpose:'PHYSICAL_TERMINAL'},dependencies);
      const startClaims=startVerification.claims,endClaims=endVerification.claims;
      scope(startClaims,runExpected);scope(endClaims,runExpected);
      const started=timestamp(startClaims.started_at_utc),ended=timestamp(endClaims.completed_at_utc);
      check(startClaims.status==='STARTED' && endClaims.status==='COMPLETED'
        && startClaims.physical_test===true && endClaims.physical_test===true
        && startClaims.simulation===true && endClaims.simulation===true
        && nonempty(startClaims.host_id) && startClaims.host_id===endClaims.host_id
        && nonempty(startClaims.observer_id) && startClaims.observer_id===endClaims.observer_id
        && endClaims.start_receipt_sha256===start.ref.sha256 && ended>started && started>frozen
        && ended<=now && now-ended<=protocol.max_receipt_age_ms,'PHYSICAL_LIFECYCLE_CONFLICT');
      check(terminal.ref.sha256===measured[side].completion_receipt_hash,'PHYSICAL_RESULT_BINDING_CONFLICT');
      const original=artifact(run.originals_ref,'TRADE_ORIGINALS',reader);
      check(endClaims.originals_sha256===original.ref.sha256,'ORIGINALS_RECEIPT_BINDING_CONFLICT');
      const traceHash=record.run_receipt_and_evidence_hashes?.[side]?.evidence_sha256;
      check(endClaims.trace_sha256===traceHash,'TRACE_RECEIPT_BINDING_CONFLICT');
      const traceRef=measured.source_files?.find(file=>file.sha256===traceHash);
      check(traceRef && typeof traceRef.path==='string' && path.isAbsolute(traceRef.path),'TRACE_ARTIFACT_REQUIRED');
      const trace=artifact({...traceRef,id:`${run.run_id}-trace`,purpose:'TRACE'},'TRACE',reader);
      retainedTraces.set(traceHash,trace);
      tracePayloads[side]=trace.value;
      originals[side]=reconcileOriginals(original.value,{...expected,run_id:run.run_id,window_id:segment.segment_id,
        source_role:item.source_role,source_sha256:item.source_sha256,currency:protocol.currency,
        cost_model_sha256:protocol.cost_model_sha256},item,protocol,trace.value);
      check(originals[side].trades.length===measured[side].trade_count
        && ['gross_pnl','fees','net_pnl'].every(key=>same(originals[side].trades.reduce((sum,trade)=>sum+trade[key],0),
          measured[side][key])),'SEGMENT_METRICS_RECONCILIATION_CONFLICT');
      ledger[side]=originals[side].trades.map(trade=>({trade_id:trade.trade_id,exit_datetime:trade.exit_sierra_datetime,
        exit_utc:trade.exit_utc,native_exit_sequence:trade.native_exit_sequence,
        gross_currency_value:trade.gross_pnl,total_commission:trade.fees,net_profit_loss:trade.net_pnl}));
      proofs.push({window_id:segment.segment_id,side,run_id:run.run_id,start_receipt_sha256:start.ref.sha256,
        terminal_receipt_sha256:terminal.ref.sha256,originals_sha256:original.ref.sha256,trace_sha256:traceHash,
        host_attestation_sha256:dependencies.host_attestation_sha256,run_authority_sha256:dependencies.run_authority_sha256,
        start_trust_policy_sha256:startVerification.trust_policy_sha256,terminal_trust_policy_sha256:endVerification.trust_policy_sha256,
        start_principal_id:startVerification.principal_id,terminal_principal_id:endVerification.principal_id});
    }
    comparisonCoverage(record.trade_comparisons,originals.baseline.trades,originals.candidate.trades,record,tracePayloads,{item,runs,expected});
    const quantities={window_id:segment.segment_id,baseline_entry_quantity:originals.baseline.total_entry_quantity,
      candidate_entry_quantity:originals.candidate.total_entry_quantity};
    if(protocol.exposure_policy==='EQUAL_TOTAL_ENTRY_QUANTITY')check(same(quantities.baseline_entry_quantity,
      quantities.candidate_entry_quantity),'UNEQUAL_EXPOSURE');
    exposure.push(quantities);ledgers.set(segment.segment_id,ledger);
  }
  // trade_comparisons belongs to this adapter's evidence envelope, not the legacy
  // targeted case schema. Preserve it in adapter_binding after strict admission.
  const cases=evidence.value.cases.map(({trade_comparisons,...record})=>record);
  const candidateTrades=proofs.filter(proof=>proof.side==='candidate').flatMap(proof=>{
    const payload=retainedTraces.get(proof.trace_sha256).value;
    return payload.trades.map(trade=>({...trade,behavior_passed:Object.values(payload.behavior_checks || {}).every(value=>value===true)}));
  });
  const assessment=assessIndependentTrades(candidateTrades,planBinding.plan.independent_acceptance);
  check(assessment.ordering_proved,'EXIT_CHRONOLOGY_UNRESOLVED');
  const {candidate_net_pnl,max_drawdown,largest_winner_share,positive_net_after_costs,controlled_drawdown,
    no_single_trade_dependence,verdict}=assessment;
  const metrics={candidate_net_pnl,max_drawdown,largest_winner_share,positive_net_after_costs,controlled_drawdown,no_single_trade_dependence,verdict};
  const targeted={schema_version:TARGETED_REPLAY_RESULT_VERSION,contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,
    plan_hash:planBinding.plan_hash,cases,independent_verdict:roles[test.kind]==='DISCOVERY'?null:{
      all_predeclared_windows_reported:true,...metrics,limits:{max_drawdown:planBinding.plan.independent_acceptance.max_drawdown,
        max_largest_winner_share:planBinding.plan.independent_acceptance.max_largest_winner_share}}};
  const targeted_behavior=validateTargetedReplayResultBinding(planBinding,test,targeted,result,{ledgerBySegment:ledgers,
    readTraceArtifact:file=>{const retained=retainedTraces.get(file.sha256);
      check(retained&&retained.ref.path===file.path,'TRACE_ARTIFACT_REQUIRED');return Buffer.from(retained.bytes);}});
  const binding={schema_version:VWAP_TEST_RESULT_ADAPTER_VERSION,project_id,candidate_hash,plan_hash:planBinding.plan_hash,
    protocol_sha256:protocolItem.ref.sha256,case_evidence_sha256:evidence.ref.sha256,currency:protocol.currency,
    protocol_trust_policy_sha256:protocolVerification.trust_policy_sha256,protocol_principal_id:protocolVerification.principal_id,
    candidate_author_id:protocol.candidate_author_id,independent_reviewer_id:protocol.independent_reviewer_id,
    independent_evaluator_id:protocol.independent_evaluator_id,
    cost_model_sha256:protocol.cost_model_sha256,physical_runs:proofs,exposure,
    ordering:{basis:'VERIFIED_EXIT_UTC_THEN_NATIVE_EXIT_SEQUENCE',proved:assessment.ordering_proved,blocker:assessment.ordering_blocker},
    comparisons:evidence.value.cases.map(item=>({window_id:item.case_id,trades:item.trade_comparisons})),
    evaluator:'assessIndependentTrades',paper_authorized:false,live_authorized:false,normal_brain_ingestion_authorized:false};
  return {targeted_behavior,adapter_binding:{...binding,binding_sha256:objectHash(binding)}};
}
