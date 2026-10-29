import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './common.mjs';
import { OperationalCandidateEvaluator } from './operational-candidate-evaluation.mjs';
import { adaptVwapTestResult } from './vwap-test-result-adapter.mjs';
import { makeVwapSoftwareFixture as fixture } from './vwap-test-result-adapter.fixtures.mjs';

test('software fixture reconciles partial exits and feeds existing authoritative evaluator without a new verdict enum',t=>{
  const a=fixture(t),b=fixture(t,3),first=adaptVwapTestResult(a.input,a.options),second=adaptVwapTestResult(b.input,b.options);
  assert.equal(first.targeted_behavior.independent_verdict.verdict,'PASS');
  assert.equal(first.targeted_behavior.independent_verdict.candidate_net_pnl,6);
  assert.equal(first.targeted_behavior.independent_verdict.max_drawdown,2);
  assert.equal(first.targeted_behavior.independent_verdict.largest_winner_share,0.5);
  assert.equal(first.adapter_binding.paper_authorized,false);assert.equal(first.adapter_binding.normal_brain_ingestion_authorized,false);
  const evaluator=new OperationalCandidateEvaluator({config:{},db:null,operationalLearning:{}});
  const snapshot={validation_plan:{content_json:JSON.stringify({targeted_replay:{plan:a.input.planBinding.plan}})},
    validation_artifacts:[['WALK_FORWARD',first],['OOS_HOLDOUT',second]].map(([kind,value])=>({kind,
      content_json:JSON.stringify({targeted_behavior:value.targeted_behavior})}))};
  const effective=evaluator.effectiveConclusion(snapshot,{conclusion_type:'BENEFIT_SUPPORTED'});
  assert.equal(effective.targeted_assessment.candidate_net_pnl,12);assert.equal(effective.conclusion,'BENEFIT_NOT_ESTABLISHED');
  assert.equal(effective.targeted_physical_evidence.verified,false);
});

test('caller verified flags cannot replace trusted authenticators',t=>{
  const f=fixture(t);f.input.verified=true;
  assert.throws(()=>adaptVwapTestResult(f.input,{evidenceRoot:f.root}),{code:'VWAP_ADAPTER_AUTHENTICATOR_REQUIRED'});
  assert.throws(()=>adaptVwapTestResult(f.input,{...f.options,verifyPhysicalReceipt:()=>({authenticated:true})}),
    {code:'VWAP_ADAPTER_AUTHENTICATION_UNPROVEN'});
});

for(const [name,change,code] of [
  ['stale frozen protocol',({protocol})=>{if(protocol)protocol.expires_at_utc='2026-10-29T09:00:00Z';},'PROTOCOL_STALE'],
  ['candidate author evaluates own work',({protocol})=>{if(protocol)protocol.independent_evaluator_id=protocol.candidate_author_id;},'INDEPENDENT_ACTOR_REQUIRED'],
  ['missing frozen window',({protocol})=>{if(protocol)protocol.windows.pop();},'FROZEN_WINDOW_COVERAGE_CONFLICT'],
  ['different currency',({originals})=>{if(originals)originals.currency='GBP';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['missing original fee',({originals})=>{if(originals)delete originals.fills[0].fees;},'ORIGINAL_FILL_INVALID'],
  ['reconciled fee differs from fill fees',({originals})=>{if(originals)originals.fills[0].fees+=0.5;},'ORIGINAL_COST_QUANTITY_RECONCILIATION_CONFLICT'],
  ['incorrect leg quantity',({originals})=>{if(originals)originals.fills[1].quantity=3;},'ORIGINAL_EXIT_QUANTITY_CONFLICT'],
  ['cross-project receipt',({terminalPayload})=>{if(terminalPayload)terminalPayload.project_id='another-project';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['discovery contamination',({terminalPayload})=>{if(terminalPayload)terminalPayload.source_role='DISCOVERY';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['wrong execution namespace',({terminalPayload})=>{if(terminalPayload)terminalPayload.execution_namespace='PAPER';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['dataset role drift',({terminalPayload})=>{if(terminalPayload)terminalPayload.dataset_role='TEST';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['wrong source',({startPayload})=>{if(startPayload)startPayload.strategy_source_sha256=digest('wrong-source');},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['wrong physical run',({startPayload})=>{if(startPayload)startPayload.run_id='test-unrelated';},'AUTHENTICATED_SCOPE_CONFLICT'],
  ['unsealed start chain',({terminalPayload})=>{if(terminalPayload)terminalPayload.start_receipt_sha256=digest('wrong-start');},'PHYSICAL_LIFECYCLE_CONFLICT'],
  ['start preceding protocol freeze',({startPayload})=>{if(startPayload)startPayload.started_at_utc='2026-10-29T07:00:00Z';},'PHYSICAL_LIFECYCLE_CONFLICT'],
  ['stale receipt',({protocol})=>{if(protocol)protocol.max_receipt_age_ms=60_000;},'PHYSICAL_LIFECYCLE_CONFLICT'],
  ['missing comparison',({record})=>{if(record)record.trade_comparisons.pop();},'COMPARISON_INCOMPLETE'],
  ['unproved skipped winner',({record})=>{if(record)record.trade_comparisons[0].status='SKIPPED_WINNER';},'COUNTERFACTUAL_CLASSIFICATION_CONFLICT'],
  ['boundary closure',({originals})=>{if(originals)originals.trades[0].entry_utc='2025-01-01T00:00:00Z';},'BOUNDARY_TRADE_UNSCORED_REQUIRED'],
  ['native fill link mismatch',({tracePayload})=>{if(tracePayload)tracePayload.trace.fills[0].order_id='wrong-order';},'ORIGINAL_NATIVE_FILL_LINK_CONFLICT'],
  ['extra native fill',({tracePayload})=>{if(tracePayload)tracePayload.trace.fills.push({...tracePayload.trace.fills[0],fill_id:'extra'});},'ORIGINAL_NATIVE_FILL_COVERAGE_CONFLICT'],
  ['omitted retained counterexample',({tracePayload})=>{if(tracePayload)tracePayload.counterexamples.push({reason:'Observed contradiction'});},'COUNTEREXAMPLE_COVERAGE_CONFLICT'],
])test(`software fixture fails closed: ${name}`,t=>{
  const f=fixture(t,2,change);assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:`VWAP_ADAPTER_${code}`});
});

test('a trusted physical callback must verify both prior host attestation and run authority',t=>{
  const f=fixture(t),original=f.options.verifyPhysicalReceipt;
  for(const missing of ['host_attestation_sha256','run_authority_sha256']){
    const options={...f.options,verifyPhysicalReceipt:request=>{
      const verification=original(request);delete verification.verified_dependencies[missing];return verification;
    }};
    assert.throws(()=>adaptVwapTestResult(f.input,options),{code:'VWAP_ADAPTER_PHYSICAL_AUTHORITY_CHAIN_UNPROVEN'});
  }
});

test('tampered artifact bytes, duplicate/extra runs, changed test, and cross-candidate reuse fail closed',t=>{
  const f=fixture(t);
  const ref=f.input.physical_runs[0].terminal_receipt_ref,bytes=fs.readFileSync(ref.path);
  fs.writeFileSync(ref.path,Buffer.from(bytes.toString().replace('COMPLETED','TAMPERED!')));
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_ARTIFACT_HASH_CONFLICT'});fs.writeFileSync(ref.path,bytes);
  f.input.physical_runs.push(f.input.physical_runs[0]);
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_PHYSICAL_RUN_COVERAGE_CONFLICT'});f.input.physical_runs.pop();
  f.input.test.segments[0].dataset_revision=2;
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_FROZEN_TEST_BINDING_CONFLICT'});
  f.input.test.segments[0].dataset_revision=1;f.input.candidate_hash=digest('another-candidate');
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_AUTHENTICATED_SCOPE_CONFLICT'});
});

test('all mutable caller objects stay outside the returned proof binding',t=>{
  const f=fixture(t),output=adaptVwapTestResult(f.input,f.options),before=JSON.stringify(output);
  f.input.physical_runs[0].run_id='mutated';f.input.planBinding.plan.independent_acceptance.max_drawdown=1e9;
  assert.equal(JSON.stringify(output),before);
});

test('unequal exposure cannot silently pass an equal-quantity protocol',t=>{
  const f=fixture(t,2,({side,originals})=>{
    if(side!=='candidate' || !originals)return;
    for(const fill of originals.fills)fill.quantity*=2;
    for(const trade of originals.trades){trade.quantity*=2;trade.gross_pnl*=2;trade.net_pnl=trade.gross_pnl-trade.fees;}
  });
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_UNEQUAL_EXPOSURE'});
});

test('single winning trade uses existing FAIL verdict and never changes the stored enum',t=>{
  const f=fixture(t,2,({originals})=>{
    if(!originals)return;
    originals.trades=originals.trades.slice(0,1);originals.fills=originals.fills.filter(fill=>fill.trade_id==='trade-0');
  });
  const output=adaptVwapTestResult(f.input,f.options);
  assert.equal(output.targeted_behavior.independent_verdict.candidate_net_pnl,4);
  assert.equal(output.targeted_behavior.independent_verdict.no_single_trade_dependence,false);
  assert.equal(output.targeted_behavior.independent_verdict.verdict,'FAIL');
});

test('unestimable counterfactual stays UNKNOWN without becoming an avoided loser or skipped winner',t=>{
  const f=fixture(t,2,({record})=>{if(record)record.trade_comparisons[0].status='UNKNOWN';});
  const output=adaptVwapTestResult(f.input,f.options);
  assert.equal(output.adapter_binding.comparisons[0].trades[0].status,'UNKNOWN');
  assert.equal(output.targeted_behavior.cases[0].avoided_losers_and_skipped_winners.avoided_loser_count,0);
});

test('scale-in after partial exit reconciles each exit at its then-current weighted cost',t=>{
  const f=fixture(t,2,({originals})=>{
    if(!originals)return;
    const trade=originals.trades[0],fills=originals.fills.filter(fill=>fill.trade_id===trade.trade_id);
    fills[1].price=104;fills[1].fees=0.2;
    const added={...fills[1],fill_id:'trade-0-added',leg_id:'leg-0-added',order_id:'order-0-added',native_sequence:3,action:'ENTRY',quantity:1,price:104};
    fills[2].quantity=2;fills[2].price=103;fills[2].fees=0.2;fills[2].native_sequence=4;trade.native_exit_sequence=4;
    originals.fills.splice(2,0,added);
    trade.quantity=3;trade.gross_pnl=6;trade.net_pnl=5;trade.slippage=0.4;trade.fill_ids.splice(2,0,added.fill_id);
  });
  const output=adaptVwapTestResult(f.input,f.options);
  assert.equal(output.targeted_behavior.independent_verdict.candidate_net_pnl,7);
});

test('MATCHED and CHANGED_FILL require the same original native opportunity on both sides',t=>{
  for(const status of ['MATCHED','CHANGED_FILL']){
    const f=fixture(t,2,({record})=>{if(record){const [a,b]=record.trade_comparisons;
      [a.candidate_trade_id,b.candidate_trade_id]=[b.candidate_trade_id,a.candidate_trade_id];a.status=status;}});
    assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_COMPARISON_NATIVE_OPPORTUNITY_CONFLICT'});
  }
  const f=fixture(t,2,({tracePayload})=>{if(tracePayload)tracePayload.trades[0].opportunity_id='unrelated-opportunity';});
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_ORIGINAL_TRACE_RECONCILIATION_CONFLICT'});
});

function avoidedLoserFixture(t,mutateEvent=()=>{}){
  let candidateOriginals;
  return fixture(t,2,({protocol,side,originals,tracePayload,record})=>{
    if(protocol)protocol.exposure_policy='REPORT_DIFFERENCE';
    if(originals&&side==='candidate'){
      originals.trades=originals.trades.filter(trade=>trade.trade_id!=='trade-1');
      originals.fills=originals.fills.filter(fill=>fill.trade_id!=='trade-1');candidateOriginals=originals;
    }
    if(tracePayload&&side==='candidate'){
      const event={event_id:'verified-no-entry',opportunity_id:'opportunity-1',reason:'Frozen candidate suppressed this opportunity',
        at_utc:candidateOriginals.trades[0].entry_utc,run_id:candidateOriginals.run_id,window_id:candidateOriginals.window_id,
        project_id:candidateOriginals.project_id,candidate_hash:candidateOriginals.candidate_hash,
        plan_hash:candidateOriginals.plan_hash,source_sha256:candidateOriginals.source_sha256};
      mutateEvent(event);tracePayload.no_entries=[event];
    }
    if(record){const comparison=record.trade_comparisons.find(item=>item.baseline_trade_id==='trade-1');
      comparison.candidate_trade_id=null;comparison.status='AVOIDED_LOSER';
      record.avoided_losers_and_skipped_winners.avoided_loser_count=1;
      record.avoided_losers_and_skipped_winners.avoided_loser_trade_ids=['trade-1'];}
  });
}
test('known counterfactual requires a native no-entry inside the exact run/window/source/plan',t=>{
  const valid=avoidedLoserFixture(t);
  assert.equal(adaptVwapTestResult(valid.input,valid.options).targeted_behavior.independent_verdict.verdict,'PASS');
  for(const mutate of [event=>{event.at_utc='1900-01-01T00:00:00Z';},event=>{event.run_id='other-run';},
    event=>{event.window_id='other-window';},event=>{event.source_sha256=digest('other-source');},
    event=>{event.plan_hash=digest('other-plan');},event=>{delete event.project_id;}]){
    const f=avoidedLoserFixture(t,mutate);
    assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_COUNTERFACTUAL_NATIVE_OPPORTUNITY_UNPROVEN'});
  }
});

test('file growth after stat is rejected without consuming bytes beyond the validated size',t=>{
  const f=fixture(t),originalStat=fs.fstatSync,originalRead=fs.readSync;let grew=false,consumed=0,targetFd;
  fs.fstatSync=function(fd,...args){const stat=originalStat.call(this,fd,...args);
    if(!grew){grew=true;targetFd=fd;fs.appendFileSync(f.input.protocol_ref.path,Buffer.alloc(65536,32));}return stat;};
  fs.readSync=function(...args){const count=originalRead.apply(this,args);if(args[0]===targetFd)consumed+=count;return count;};
  try{
    assert.throws(()=>adaptVwapTestResult(f.input,{...f.options,maxArtifactBytes:32768}),{code:'VWAP_ADAPTER_ARTIFACT_CHANGED_DURING_READ'});
    assert.equal(consumed,f.input.protocol_ref.byte_length);
  }finally{fs.fstatSync=originalStat;fs.readSync=originalRead;}
});

test('aggregate budget applies across receipts/originals/traces and rejects aliases and nonregular paths',t=>{
  const f=fixture(t);
  const firstTwo=f.input.protocol_ref.byte_length+f.input.case_evidence_ref.byte_length;
  assert.throws(()=>adaptVwapTestResult(f.input,{...f.options,maxTotalArtifactBytes:firstTwo}),{code:'VWAP_ADAPTER_ARTIFACT_AGGREGATE_BYTE_LIMIT'});
  const originalPath=f.input.protocol_ref.path;
  const directory=path.join(f.root,'directory');fs.mkdirSync(directory);f.input.protocol_ref.path=directory;
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_ARTIFACT_NOT_REGULAR'});
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,'junction');
  f.input.protocol_ref.path=path.join(alias,path.basename(originalPath));
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_ARTIFACT_ALIAS_PATH_REJECTED'});
  f.input.protocol_ref.path=path.join(f.root,'..','outside.json');
  assert.throws(()=>adaptVwapTestResult(f.input,f.options),{code:'VWAP_ADAPTER_ARTIFACT_ROOT_CONFLICT'});
  f.input.protocol_ref.path=originalPath;
});

test('admitted traces are read once and reused through legacy result validation',t=>{
  const f=fixture(t),originalOpen=fs.openSync,counts=new Map();
  const paths=new Set(f.input.result.segments.flatMap(segment=>segment.source_files.map(file=>file.path)));
  fs.openSync=function(file,...args){if(paths.has(file))counts.set(file,(counts.get(file)||0)+1);return originalOpen.call(this,file,...args);};
  try{
    assert.equal(adaptVwapTestResult(f.input,f.options).targeted_behavior.independent_verdict.verdict,'PASS');
    assert.equal(counts.size,2);assert.ok([...counts.values()].every(count=>count===1));
  }finally{fs.openSync=originalOpen;}
});

test('a fully reported zero-trade window remains covered and receives the existing FAIL verdict',t=>{
  const f=fixture(t,2,({originals,tracePayload})=>{
    if(originals){originals.trades=[];originals.fills=[];}
    if(tracePayload)tracePayload.zero_trade_case=true;
  });
  const output=adaptVwapTestResult(f.input,f.options);
  assert.equal(output.targeted_behavior.cases.length,1);
  assert.equal(output.targeted_behavior.independent_verdict.all_predeclared_windows_reported,true);
  assert.equal(output.targeted_behavior.independent_verdict.candidate_net_pnl,0);
  assert.equal(output.targeted_behavior.independent_verdict.verdict,'FAIL');
  assert.equal(output.adapter_binding.physical_runs.length,2);
});

function orderingRiskFixture(t,forgeSerial=false){
  return fixture(t,2,({originals})=>{
    if(!originals)return;
    const source=structuredClone(originals.trades[2]),sourceFills=originals.fills.filter(fill=>fill.trade_id===source.trade_id).map(fill=>({...fill}));
    for(const trade of originals.trades){const fills=originals.fills.filter(fill=>fill.trade_id===trade.trade_id);
      if(trade.trade_id==='trade-0'){fills[1].price=104;fills[2].price=105;trade.gross_pnl=9;trade.net_pnl=8;}
      else{fills.at(-1).price=98;trade.gross_pnl=-2;trade.net_pnl=-3;}}
    const entry=new Date(Date.parse(source.entry_utc)+20*60*1000).toISOString(),exit=new Date(Date.parse(source.exit_utc)+20*60*1000).toISOString();
    const addedFills=sourceFills.map((fill,index)=>({...fill,trade_id:'trade-3',fill_id:`trade-3-${index}`,order_id:`order-trade-3-${index}`,
      leg_id:`leg-trade-3-${index}`,native_sequence:31+index,at_utc:fill.action==='ENTRY'?entry:exit,price:fill.action==='EXIT'?109:fill.price}));
    originals.fills.push(...addedFills);
    originals.trades.push({...source,trade_id:'trade-3',opportunity_id:'opportunity-3',entry_utc:entry,exit_utc:exit,
      exit_sierra_datetime:Date.parse(exit)/86400000+25569,native_exit_sequence:addedFills.at(-1).native_sequence,
      gross_pnl:9,net_pnl:8,fill_ids:addedFills.map(fill=>fill.fill_id)});
    if(forgeSerial)originals.trades.forEach((trade,index)=>{trade.exit_sierra_datetime=[1,2,4,3][index];});
  });
}
test('forged Sierra serial ordering cannot reduce the verified UTC drawdown or turn FAIL into PASS',t=>{
  const actual=orderingRiskFixture(t),forged=orderingRiskFixture(t,true);
  const baseline=adaptVwapTestResult(actual.input,actual.options),result=adaptVwapTestResult(forged.input,forged.options);
  assert.deepEqual(result.targeted_behavior.independent_verdict,baseline.targeted_behavior.independent_verdict);
  assert.equal(result.targeted_behavior.independent_verdict.candidate_net_pnl,10);
  assert.equal(result.targeted_behavior.independent_verdict.max_drawdown,6);
  assert.equal(result.targeted_behavior.independent_verdict.verdict,'FAIL');
  assert.equal(result.targeted_behavior.verified_candidate_trades[0].exit_sierra_datetime,1,'reported Sierra value is preserved separately');
  assert.equal(result.adapter_binding.ordering.basis,'VERIFIED_EXIT_UTC_THEN_NATIVE_EXIT_SEQUENCE');
});

test('UTC exits must match the independently observed final fill and trace',t=>{
  const original=fixture(t,2,({originals})=>{if(originals)originals.trades[0].exit_utc=new Date(Date.parse(originals.trades[0].exit_utc)+1000).toISOString();});
  assert.throws(()=>adaptVwapTestResult(original.input,original.options),{code:'VWAP_ADAPTER_ORIGINAL_TRADE_BOUNDARY_CONFLICT'});
  const trace=fixture(t,2,({tracePayload})=>{if(tracePayload)tracePayload.trades[0].exit_utc=new Date(Date.parse(tracePayload.trades[0].exit_utc)+1000).toISOString();});
  assert.throws(()=>adaptVwapTestResult(trace.input,trace.options),{code:'VWAP_ADAPTER_ORIGINAL_TRACE_RECONCILIATION_CONFLICT'});
});

function tiedExitFixture(t,unknownSequence=false){
  return fixture(t,2,({originals})=>{
    if(!originals)return;
    const end=originals.trades.at(-1).exit_utc;let entrySequence=0,exitSequence=3;
    for(const trade of originals.trades){
      trade.exit_utc=end;trade.exit_sierra_datetime=Date.parse(end)/86400000+25569;
      for(const fill of originals.fills.filter(value=>value.trade_id===trade.trade_id)){
        if(fill.action==='ENTRY')fill.native_sequence=++entrySequence;
        else{fill.at_utc=end;fill.native_sequence=++exitSequence;}
        if(unknownSequence)delete fill.native_sequence;
      }
      trade.native_exit_sequence=exitSequence;if(unknownSequence)delete trade.native_exit_sequence;
    }
  });
}
test('equal UTC exits require verified native sequence rather than trade ID ordering',t=>{
  const valid=tiedExitFixture(t),unknown=tiedExitFixture(t,true);
  assert.equal(adaptVwapTestResult(valid.input,valid.options).targeted_behavior.independent_verdict.verdict,'PASS');
  assert.throws(()=>adaptVwapTestResult(unknown.input,unknown.options),{code:'VWAP_ADAPTER_EXIT_CHRONOLOGY_UNRESOLVED'});
  const mismatch=fixture(t,2,({originals})=>{if(originals)originals.trades[0].native_exit_sequence=999;});
  assert.throws(()=>adaptVwapTestResult(mismatch.input,mismatch.options),{code:'VWAP_ADAPTER_ORIGINAL_NATIVE_EXIT_SEQUENCE_CONFLICT'});
});
