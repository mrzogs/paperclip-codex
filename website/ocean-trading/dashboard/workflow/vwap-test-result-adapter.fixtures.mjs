import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, objectHash } from './common.mjs';
import { TARGETED_REPLAY_CONTRACT_SHA256, validateTargetedReplayPlanBinding } from './targeted-replay-behavior.mjs';

const project='cicd-vwap-pull-back-strategy',candidate=digest('fixture-candidate');
const behavior={entry:'Frozen entry',stop:'Frozen stop',target:'Frozen target',exit:'Frozen exit'};
const now=Date.parse('2026-10-29T10:00:00Z');

function planFixture(){
  const sequence=['AS_BUILT_DIAGNOSTIC_FOR_EXACT_SEEN_EPISODES_PARITY_ONLY',
    'DISCOVERY_BEHAVIOR_EXPERIMENT_FOR_ALL_PREDECLARED_QUALIFIED_MATCHES',
    'FROZEN_CANDIDATE_ALL_ELIGIBLE_INDEPENDENT_WINDOWS','HUMAN_PAPER_REVIEW_ONLY_IF_PROFIT_AND_RISK_GATES_PASS'];
  const windows=['DISCOVERY','DISCOVERY','VALIDATION','PROTECTED_HOLDOUT'].map((source_role,index)=>{
    const id=`window-${index}`;
    return {window_id:id,source_role,predeclared:true,pre_event_condition:id,selector_version:'fixture-selector',
      eligible_window_count:1,eligible_window_ids:[id],dataset_id:`dataset-${index}`,dataset_revision:1,
      dataset_manifest_sha256:digest(`manifest-${id}`),source_sha256:digest(`source-${id}`),contract:'MNQ',
      warmup_start_utc:`2025-0${index+1}-01T23:00:00Z`,start_utc:`2025-0${index+1}-02T00:00:00Z`,
      end_utc:`2025-0${index+1}-03T00:00:00Z`,timezone:'UTC',warmup_bars:12,
      baseline_source_sha256:digest('baseline-source'),baseline_binary_sha256:digest('baseline-binary'),
      candidate_source_sha256:digest('candidate-source'),candidate_binary_sha256:digest('candidate-binary'),
      config_sha256:digest('config'),expected_behavior:'Frozen behavior',expected_behavior_detail:behavior,cost_model:'Fixture fills and fees'};
  });
  const cases=windows.slice(0,2).map(({window_id,predeclared,eligible_window_count,eligible_window_ids,...item})=>
    ({...item,case_id:window_id,all_match_count:1,match_ids:[window_id]}));
  const plan={schema_version:'cicd-vwap-targeted-replay-plan/v1',strategy_id:project,status:'READY_FOR_GOVERNED_REPLAY',
    contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,paper_use:'DESCRIPTIVE_ALARM_AND_AS_BUILT_DIAGNOSTIC_ONLY',
    paper_or_live_authorized:false,planned_replay_sequence:sequence,candidate_selected:true,candidate_change_id:'fixture',
    selector_frozen:true,qualified_causal_source:true,physical_replay_host_attested:true,separate_run_authority:true,
    physical_replay_host_attestation_sha256:digest('mock-host'),run_authority_id:'mock-authority',run_authority_sha256:digest('mock-authority'),
    cases,independent_windows:windows.slice(2),independent_acceptance:{source_reference:'fixture-policy',source_sha256:digest('fixture-policy'),
      max_drawdown:5,max_largest_winner_share:0.5},frozen_case_plan_hash:objectHash({cases,independent_windows:windows.slice(2)})};
  const tests=['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].map((kind,index)=>{
    const item=windows[index];
    return {kind,baseline_strategy_hash:item.baseline_binary_sha256,baseline_execution_source_hash:item.baseline_source_sha256,
      candidate_execution_hash:item.candidate_binary_sha256,candidate_execution_source_hash:item.candidate_source_sha256,
      segments:[{segment_id:item.window_id,dataset_id:item.dataset_id,dataset_revision:1,dataset_manifest_hash:item.dataset_manifest_sha256,
        contract:item.contract,warmup_start_utc:item.warmup_start_utc,scored_start_utc:item.start_utc,scored_end_utc:item.end_utc,
        baseline_run_id:`test-${index}-baseline`,candidate_run_id:`test-${index}-candidate`}]};
  });
  const binding=validateTargetedReplayPlanBinding(plan,tests,{verifyAuthority:()=>({verified:true,plan_hash:objectHash(plan),mock_only:true})});
  return {plan,windows,tests,binding};
}

// Every authenticator below is a SOFTWARE FIXTURE. These tests establish only
// local admission behavior; they authenticate no actual host or physical Replay.
function fixture(t,index=2,change=()=>{},{decorateTest}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-w6-software-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {plan,windows,tests,binding}=planFixture(),item=windows[index],testPlan=tests[index];
  if(decorateTest)tests.forEach((test,i)=>decorateTest(test,windows[i]));
  const write=(id,purpose,value)=>{const bytes=Buffer.from(JSON.stringify(value));const file=path.join(root,`${id}.json`);
    fs.writeFileSync(file,bytes);return {id,path:file,sha256:digest(bytes),byte_length:bytes.length,purpose};};
  const protocol={schema_version:'vwap-independent-protocol/v1',project_id:project,candidate_hash:candidate,plan_hash:binding.plan_hash,
    authority_receipt_sha256:objectHash(binding.authority_receipt),test_hashes:Object.fromEntries(tests.map(value=>[value.kind,objectHash(value)])),
    windows:[...plan.cases,...plan.independent_windows].map(value=>({window_id:value.case_id || value.window_id,
      source_role:value.source_role,source_sha256:value.source_sha256})),frozen_at_utc:'2026-10-29T08:00:00Z',
    expires_at_utc:'2026-10-30T08:00:00Z',currency:'USD',point_value:1,cost_model_sha256:digest('fixture-costs'),
    slippage_accounting:'IN_FILL_PRICES',max_receipt_age_ms:3600000,exposure_policy:'EQUAL_TOTAL_ENTRY_QUANTITY',
    candidate_author_id:'fixture-author',independent_reviewer_id:'fixture-reviewer',independent_evaluator_id:'fixture-evaluator'};
  change({protocol});
  const protocolRef=write('protocol','FROZEN_PROTOCOL',protocol),runs=[],source_files=[],traces={},costs={},receipts={};
  const segment={segment_id:item.window_id,source_files};
  const originalsBySide={};
  for(const side of ['baseline','candidate']){
    const run_id=testPlan.segments[0][`${side}_run_id`];
    const originals={schema_version:'vwap-trade-originals/v1',project_id:project,candidate_hash:candidate,plan_hash:binding.plan_hash,
      run_id,window_id:item.window_id,source_role:item.source_role,source_sha256:item.source_sha256,currency:'USD',
      cost_model_sha256:protocol.cost_model_sha256,trades:[],fills:[]};
    for(let i=0;i<3;i++){
      const trade_id=`trade-${i}`,entry_utc=new Date(Date.parse(item.start_utc)+i*20*60*1000).toISOString(),exit_utc=new Date(Date.parse(entry_utc)+10*60*1000).toISOString();
      const shapes=i===0?[['ENTRY',2,100,0.4],['EXIT',1,102,0.3],['EXIT',1,103,0.3]]:
        [['ENTRY',1,100,0.5],['EXIT',1,i===1?99:105,0.5]];
      const fills=shapes.map(([action,quantity,price,fees],n)=>({fill_id:`${trade_id}-${n}`,trade_id,order_id:`order-${trade_id}-${n}`,
        leg_id:`leg-${trade_id}-${n}`,native_sequence:i*10+n+1,at_utc:action==='ENTRY'?entry_utc:exit_utc,action,quantity,price,fees,slippage:0.1,currency:'USD'}));
      originals.fills.push(...fills);
      originals.trades.push({trade_id,side:'LONG',entry_utc,exit_utc,exit_sierra_datetime:Date.parse(exit_utc)/86400000+25569,native_exit_sequence:fills.at(-1).native_sequence,quantity:i===0?2:1,
        opportunity_id:`opportunity-${i}`,gross_pnl:i===1?-1:5,fees:1,slippage:fills.length*0.1,net_pnl:i===1?-2:4,fill_ids:fills.map(fill=>fill.fill_id)});
    }
    change({side,originals});originalsBySide[side]=originals;
    const trace={orders:originals.fills.map(fill=>({event_id:`order-event-${fill.fill_id}`,trade_id:fill.trade_id,order_id:fill.order_id,
      at_utc:fill.at_utc,action:'OBSERVED'})),fills:originals.fills.map(fill=>({...fill,event_id:`fill-event-${fill.fill_id}`})),
      stops:[],targets:[],exits:[]};
    for(const trade of originals.trades)for(const key of ['stops','targets','exits'])trace[key].push({event_id:`${key}-${trade.trade_id}`,
      trade_id:trade.trade_id,at_utc:trade.exit_utc,action:'OBSERVED'});
    const tracePayload={schema_version:'cicd-vwap-targeted-replay-trace/v1',run_id,case_id:item.window_id,config_sha256:item.config_sha256,
      trace,trades:originals.trades.map(({entry_utc,side,quantity,fill_ids,...trade})=>({...trade,run_id})),zero_trade_case:false,
      expected_behavior:behavior,behavior_checks:{entry:true,stop:true,target:true,exit:true,unrelated_rules_unchanged:true},
      no_entries:[],counterexamples:[]};
    change({side,tracePayload});
    const originalRef=write(`${side}-originals`,'TRADE_ORIGINALS',originals),traceRef=write(`${side}-trace`,'TRACE',tracePayload);
    source_files.push({path:traceRef.path,sha256:traceRef.sha256});
    const common={project_id:project,candidate_hash:candidate,plan_hash:binding.plan_hash,run_id,window_id:item.window_id,side,
      execution_namespace:'TEST',dataset_role:item.source_role,
      source_role:item.source_role,source_sha256:item.source_sha256,config_sha256:item.config_sha256,
      strategy_source_sha256:item[`${side}_source_sha256`],strategy_binary_sha256:item[`${side}_binary_sha256`],
      protocol_sha256:protocolRef.sha256,warmup_start_utc:item.warmup_start_utc,start_utc:item.start_utc,end_utc:item.end_utc,
      timezone:item.timezone,physical_test:true,simulation:true,host_id:'mock-only-host',observer_id:'mock-only-observer'};
    const startPayload={...common,status:'STARTED',started_at_utc:'2026-10-29T09:00:00Z'};
    change({side,startPayload});const startRef=write(`${side}-start`,'PHYSICAL_START',startPayload);
    const terminalPayload={...common,status:'COMPLETED',completed_at_utc:'2026-10-29T09:30:00Z',start_receipt_sha256:startRef.sha256,
      originals_sha256:originalRef.sha256,trace_sha256:traceRef.sha256};
    change({side,terminalPayload,root,item,testPlan});const terminalRef=write(`${side}-terminal`,'PHYSICAL_TERMINAL',terminalPayload);
    runs.push({window_id:item.window_id,side,run_id,start_receipt_ref:startRef,terminal_receipt_ref:terminalRef,originals_ref:originalRef});
    const sum=key=>originals.trades.reduce((total,trade)=>total+trade[key],0);
    segment[side]={run_id,trade_count:originals.trades.length,fees:sum('fees'),gross_pnl:sum('gross_pnl'),net_pnl:sum('net_pnl'),
      completion_receipt_hash:terminalRef.sha256};
    costs[side]={fees:sum('fees'),slippage:sum('slippage'),net_pnl:sum('net_pnl')};traces[side]=trace;
    receipts[side]={run_id,run_receipt_sha256:terminalRef.sha256,evidence_sha256:traceRef.sha256};
  }
  const ids=item.match_ids || item.eligible_window_ids;
  const record={case_id:item.window_id,dataset_role_and_immutable_source:{dataset_id:item.dataset_id,dataset_revision:1,
    source_role:item.source_role,dataset_manifest_sha256:item.dataset_manifest_sha256,source_sha256:item.source_sha256},
    market_condition_pre_event_definition:item.pre_event_condition,selector_version_and_all_match_count:{selector_version:item.selector_version,
      all_match_count:ids.length,match_ids:ids},start_end_timezone_warmup:{warmup_start_utc:item.warmup_start_utc,start_utc:item.start_utc,
      end_utc:item.end_utc,timezone:item.timezone,warmup_bars:item.warmup_bars},baseline_and_candidate_code_binary_config_hashes:{
      baseline_source_sha256:item.baseline_source_sha256,baseline_binary_sha256:item.baseline_binary_sha256,
      candidate_source_sha256:item.candidate_source_sha256,candidate_binary_sha256:item.candidate_binary_sha256,config_sha256:item.config_sha256},
    expected_entry_stop_target_exit_behavior:behavior,actual_orders_fills_stop_target_exit_trace:traces,fees_slippage_net_pnl:costs,
    avoided_losers_and_skipped_winners:{avoided_loser_count:0,avoided_loser_trade_ids:[],skipped_winner_count:0,skipped_winner_trade_ids:[]},
    counterexamples:[],run_receipt_and_evidence_hashes:receipts,trade_comparisons:originalsBySide.baseline.trades.map(trade=>({
      baseline_trade_id:trade.trade_id,candidate_trade_id:trade.trade_id,opportunity_id:trade.opportunity_id,status:'MATCHED',reason:'Software fixture identical observed legs'}))};
  change({record});
  const caseRef=write('cases','TARGETED_CASE_EVIDENCE',{schema_version:'vwap-case-evidence/v1',project_id:project,
    candidate_hash:candidate,plan_hash:binding.plan_hash,cases:[record]});
  const input={project_id:project,candidate_hash:candidate,planBinding:binding,test:testPlan,
    result:{segments:[segment],baseline:{net_pnl:segment.baseline.net_pnl},candidate:{net_pnl:segment.candidate.net_pnl}},
    protocol_ref:protocolRef,case_evidence_ref:caseRef,physical_runs:runs};
  const mockAuthenticate=({artifact,payload,expected_dependencies})=>({authenticated:true,principal_id:'SOFTWARE_FIXTURE_ONLY',
    trust_policy_sha256:digest('SOFTWARE_FIXTURE_ONLY_POLICY'),payload_sha256:artifact.sha256,claims:payload,
    verified_dependencies:expected_dependencies});
  return {input,root,options:{evidenceRoot:root,now,evaluatorPrincipalId:'fixture-evaluator',
    verifyProtocol:mockAuthenticate,verifyPhysicalReceipt:mockAuthenticate}};
}

export { fixture as makeVwapSoftwareFixture, planFixture as makeVwapSoftwarePlan };
