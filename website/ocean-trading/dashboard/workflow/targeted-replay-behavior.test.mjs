import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash } from './common.mjs';
import { OperationalCandidateEvaluator } from './operational-candidate-evaluation.mjs';
import {
  TARGETED_REPLAY_CONTRACT_SHA256,
  TARGETED_REPLAY_RESULT_VERSION,
  readTargetedReplayBehaviorContract,
  validateTargetedReplayBehaviorPlan,
  validateTargetedReplayPlanBinding,
  validateTargetedReplayResultBinding,
  verifyTargetedReplayAuthority,
  assessIndependentTrades,
} from './targeted-replay-behavior.mjs';
import { OperationalCandidateDispatch } from './operational-candidate-dispatch.mjs';

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
    independent_acceptance:{source_reference:'human-approved-risk-policy',source_sha256:hash('risk-policy'),max_drawdown:5,max_largest_winner_share:0.5},
    frozen_case_plan_hash:objectHash({cases:discovery,independent_windows:independent})};
}

// Mock authority proves only the pure binding logic. The backend receipt tests
// below exercise the distinct authenticated-human and approval-store boundary.
const bind=(plan,tests)=>validateTargetedReplayPlanBinding(plan,tests,{verifyAuthority:value=>({verified:true,plan_hash:objectHash(value),mock_only:true})});

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
  const plan=readyPlan(),binding=bind(plan,testsFor(plan));
  assert.equal(binding.discovery_case_count,2);assert.equal(binding.independent_window_count,2);
  const missing=testsFor(plan);missing[0].segments=[];
  assert.throws(()=>bind(plan,missing),error=>error.code==='TARGETED_REPLAY_ALL_MATCHES_NOT_SCHEDULED');
});

test('a frozen selector can enumerate multiple matches but cannot silently omit one',()=>{
  const plan=readyPlan();
  plan.cases[1].selector_version=plan.cases[0].selector_version;
  plan.cases[1].pre_event_condition=plan.cases[0].pre_event_condition;
  for(const item of plan.cases){item.all_match_count=2;item.match_ids=['backtest','robustness'];}
  plan.frozen_case_plan_hash=objectHash({cases:plan.cases,independent_windows:plan.independent_windows});
  assert.equal(bind(plan,testsFor(plan)).discovery_case_count,2);
  plan.cases.pop();
  assert.throws(()=>validateTargetedReplayBehaviorPlan(plan),error=>error.code==='TARGETED_REPLAY_SELECTOR_UNIVERSE_INCOMPLETE');
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

function resultFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-targeted-trace-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const plan=readyPlan(),tests=testsFor(plan),binding=bind(plan,tests),testPlan=tests[2],item=plan.independent_windows[0];
  const segment={segment_id:item.window_id,baseline:{run_id:'baseline-run',trade_count:1,fees:1,net_pnl:-10,completion_receipt_hash:hash('baseline-receipt')},
    candidate:{run_id:'candidate-run',trade_count:1,fees:1,net_pnl:-2,completion_receipt_hash:hash('candidate-receipt')},source_files:[]};
  const record=targetedCase(item,segment),ledger={};
  for(const side of ['baseline','candidate']){
    const value=segment[side],trade={trade_id:`${side}-trade`,run_id:value.run_id,
      exit_utc:item.start_utc,exit_sierra_datetime:Date.parse(item.start_utc)/86400000+25569,native_exit_sequence:1,gross_pnl:value.net_pnl+value.fees,fees:value.fees,slippage:0,net_pnl:value.net_pnl};
    const event={event_id:`${side}-event`,trade_id:trade.trade_id,at_utc:trade.exit_utc,action:'observed'};
    const trace={orders:[event],fills:[event],stops:[event],targets:[event],exits:[event]};
    const evidence={schema_version:'cicd-vwap-targeted-replay-trace/v1',run_id:value.run_id,case_id:item.window_id,
      config_sha256:item.config_sha256,trace,trades:[trade],zero_trade_case:false,expected_behavior:behavior,
      behavior_checks:{entry:true,stop:true,target:true,exit:true,unrelated_rules_unchanged:true}};
    const bytes=JSON.stringify(evidence),file=path.join(root,`${side}-trace.json`),sha256=hash(bytes);
    fs.writeFileSync(file,bytes);segment.source_files.push({path:file,sha256});
    record.actual_orders_fills_stop_target_exit_trace[side]=trace;
    record.run_receipt_and_evidence_hashes[side].evidence_sha256=sha256;
    ledger[side]=[{trade_id:trade.trade_id,exit_datetime:trade.exit_sierra_datetime,exit_utc:trade.exit_utc,native_exit_sequence:trade.native_exit_sequence,gross_currency_value:trade.gross_pnl,
      total_commission:trade.fees,net_profit_loss:trade.net_pnl}];
  }
  const targeted={schema_version:TARGETED_REPLAY_RESULT_VERSION,contract_sha256:TARGETED_REPLAY_CONTRACT_SHA256,
    plan_hash:binding.plan_hash,cases:[record],independent_verdict:{all_predeclared_windows_reported:true,
      positive_net_after_costs:true,controlled_drawdown:true,no_single_trade_dependence:true,candidate_net_pnl:-2,max_drawdown:2,
      largest_winner_share:0,limits:{max_drawdown:5,max_largest_winner_share:0.5},verdict:'PASS'}};
  const result={segments:[segment],candidate:{net_pnl:-2}};
  return {plan,binding,testPlan,targeted,result,options:{ledgerBySegment:new Map([[item.window_id,ledger]])}};
}

test('independent verdict rejects a smaller loss even when the generic evidence-integrity result is PASS',t=>{
  const {binding,testPlan,targeted,result,options}=resultFixture(t);
  assert.throws(()=>validateTargetedReplayResultBinding(binding,testPlan,targeted,result,options),
    error=>error.code==='TARGETED_REPLAY_INDEPENDENT_VERDICT_CONFLICT');
  targeted.independent_verdict.positive_net_after_costs=false;targeted.independent_verdict.no_single_trade_dependence=false;
  targeted.independent_verdict.verdict='FAIL';
  assert.equal(validateTargetedReplayResultBinding(binding,testPlan,targeted,result,options).independent_verdict.verdict,'FAIL');
});

test('legacy trace reader bounds per-file and aggregate bytes before parsing or verdict math',t=>{
  const f=resultFixture(t),call=extra=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,{...f.options,...extra});
  assert.throws(()=>call({maxArtifactBytes:16}),{code:'TARGETED_REPLAY_ARTIFACT_BYTE_LIMIT'});
  const baseline=f.result.segments[0].source_files[0];
  assert.throws(()=>call({maxTotalArtifactBytes:fs.statSync(baseline.path).size}),{code:'TARGETED_REPLAY_ARTIFACT_AGGREGATE_BYTE_LIMIT'});
  assert.throws(()=>call({artifactRoot:path.dirname(path.dirname(baseline.path))+'-unrelated'}));
});

test('legacy trace reader rejects nonregular files and directory aliases',t=>{
  const f=resultFixture(t),file=f.result.segments[0].source_files[0],original=file.path;
  const directory=path.join(path.dirname(original),'not-a-file');fs.mkdirSync(directory);file.path=directory;
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),{code:'TARGETED_REPLAY_ARTIFACT_NOT_REGULAR'});
  const alias=path.join(path.dirname(original),'alias');fs.symlinkSync(path.dirname(original),alias,'junction');
  file.path=path.join(alias,path.basename(original));
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),{code:'TARGETED_REPLAY_ARTIFACT_ALIAS_PATH_REJECTED'});
});

test('legacy trace reader rejects a file that grows during its bounded descriptor read',t=>{
  const f=resultFixture(t),file=f.result.segments[0].source_files[0],originalStat=fs.fstatSync;let grew=false;
  fs.fstatSync=function(fd,...args){const stat=originalStat.call(this,fd,...args);
    if(!grew){grew=true;fs.appendFileSync(file.path,' ');}return stat;};
  try{assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),{code:'TARGETED_REPLAY_ARTIFACT_CHANGED_DURING_READ'});}
  finally{fs.fstatSync=originalStat;}
});

test('candidate evaluation cannot call independently losing targeted evidence a benefit',()=>{
  const evaluator=new OperationalCandidateEvaluator({db:null,config:{},operationalLearning:{}});
  const snapshot={validation_plan:{content_json:JSON.stringify({targeted_replay:{plan:readyPlan()}})},
    validation_artifacts:['WALK_FORWARD','OOS_HOLDOUT'].map((kind,index)=>({kind,content_json:JSON.stringify({targeted_behavior:{
      independent_verdict:{verdict:'FAIL'},verified_candidate_trades:[{run_id:`run-${index}`,trade_id:'1',net_pnl:-2,
        exit_utc:`2025-01-0${index+1}T00:00:00Z`,native_exit_sequence:1,exit_sierra_datetime:Date.parse(`2025-01-0${index+1}T00:00:00Z`)/86400000+25569,behavior_passed:true}]}})}))};
  const effective=evaluator.effectiveConclusion(snapshot,{conclusion_type:'BENEFIT_SUPPORTED'});
  assert.equal(effective.targeted_assessment.candidate_net_pnl,-4);
  assert.equal(effective.conclusion,'BENEFIT_NOT_ESTABLISHED');
});

test('losing independent evidence persists a visible terminal rejection across restart with zero Brain calls',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-targeted-rejection-')),file=path.join(root,'workflow.sqlite');
  let db=new DatabaseSync(file);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  db.exec(`CREATE TABLE ow_cases(id TEXT,stage TEXT,revision INTEGER,owner_id TEXT,waiting_on TEXT,
    strategy_id TEXT,instance_id TEXT,run_id TEXT,candidate_hash TEXT,baseline_hash TEXT);
    CREATE TABLE ow_events(id INTEGER PRIMARY KEY,entity_id TEXT,action TEXT,payload_json TEXT);
    CREATE TABLE ow_candidate_evaluation_jobs(id TEXT,case_id TEXT,state TEXT,attempts INTEGER,next_attempt_ms INTEGER,
    lease_id TEXT,lease_until_ms INTEGER,completion_event_id INTEGER,plan_hash TEXT,candidate_hash TEXT,
    brain_record_id TEXT,conclusion TEXT,result_artifact_id TEXT,result_hash TEXT,last_error TEXT,completed_at_utc TEXT);
    CREATE TABLE ow_artifacts(id TEXT PRIMARY KEY,content TEXT);
    CREATE TABLE ow_tasks(id TEXT PRIMARY KEY,case_id TEXT,kind TEXT,status TEXT,artifact_id TEXT,required INTEGER,UNIQUE(case_id,kind));`);
  db.prepare('INSERT INTO ow_cases VALUES(?,?,?,?,?,?,?,?,?,?)').run('case','CANDIDATE_EVALUATION',1,'strategy','evaluate',
    'cicd-vwap-pull-back-strategy','replay-two','run',hash('candidate'),hash('baseline'));
  db.prepare('INSERT INTO ow_events VALUES(?,?,?,?)').run(1,'case','operational.candidate.validation.completed','{}');
  db.prepare('INSERT INTO ow_candidate_evaluation_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('job','case','RUNNING',1,0,'lease',Date.now()+60_000,1,hash('plan'),hash('candidate'),null,null,null,null,null,null);
  let brainCalls=0;
  const backend={config:{},get db(){return db;},store:{transaction:fn=>{db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}},
    one:(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
    writeArtifact:(_actor,data)=>{assert.equal(hash(data.content),data.content_hash);db.prepare('INSERT INTO ow_artifacts VALUES(?,?)').run(data.artifact_id,data.content);},
    event:(id,action,_actor,payload)=>db.prepare('INSERT INTO ow_events(entity_id,action,payload_json) VALUES(?,?,?)').run(id,action,JSON.stringify(payload)),
    operationalLearning:{enabled:true,token:()=>{brainCalls++;throw new Error('No token may be obtained');},
      brainActor:()=>({id:'brain-owner',role:'BRAIN'})},
    operationalCandidateDispatch:{validationPlan:()=>({plan_hash:hash('plan')}),completion:()=>({recipient_id:'strategy',plan_artifact_id:'plan-artifact'}),
      registration:()=>({candidate_artifact_id:'candidate-artifact'})}};
  const evaluator=new OperationalCandidateEvaluator(backend),job=backend.one('ow_candidate_evaluation_jobs','job');
  const snapshot={candidate_governance:{parsed:{governance_hash:hash('governance')}},
    validation_plan:{content_json:JSON.stringify({targeted_replay:{plan:readyPlan()}})},
    validation_artifacts:['WALK_FORWARD','OOS_HOLDOUT'].map((kind,index)=>({kind,artifact_id:`source-${index}`,
      manifest_sha256:hash(`manifest-${index}`),content_sha256:hash(`source-${index}`),
      content_json:JSON.stringify({targeted_behavior:{independent_verdict:{verdict:'FAIL'},
        verified_candidate_trades:[{run_id:`run-${index}`,trade_id:'1',net_pnl:-2,exit_utc:`2025-01-0${index+1}T00:00:00Z`,native_exit_sequence:1,exit_sierra_datetime:Date.parse(`2025-01-0${index+1}T00:00:00Z`)/86400000+25569,behavior_passed:true}]}})}))};
  const response=await evaluator.recordInBrain(job,snapshot);
  assert.equal(brainCalls,0);assert.equal(response.local_gate_rejection.conclusion,'BENEFIT_NOT_ESTABLISHED');
  const status=evaluator.completeTargetedAssessment(job,snapshot,response.local_gate_rejection);
  assert.equal(status.status,'COMPLETED');assert.equal(status.benefit_conclusion,'BENEFIT_NOT_ESTABLISHED');
  assert.equal(status.pipeline_status,'LOCAL_ASSESSMENT_COMPLETE_BRAIN_WRITEBACK_REQUIRED');
  const artifact=JSON.parse(db.prepare('SELECT content FROM ow_artifacts').get().content);
  assert.equal(artifact.targeted_assessment.candidate_net_pnl,-4);
  assert.equal(artifact.brain_record,null);assert.equal(artifact.sources.length,2);
  assert.equal(artifact.brain_writeback.normal_ingestion_authorized,false);
  assert.match(artifact.next_action,/unverified local diagnostic/);
  db.close();db=new DatabaseSync(file);evaluator.db=db;
  assert.equal(evaluator.claim(),null,'terminal rejection cannot re-enter the retry loop after restart');
  const task=db.prepare('SELECT * FROM ow_tasks').get();
  assert.equal(task.kind,'CANDIDATE_BRAIN_WRITEBACK');assert.equal(task.status,'BLOCKED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ow_artifacts').get().n,1);assert.equal(brainCalls,0);
});

test('locally passing evidence retains a visible receiver-compatibility dependency without calling the incompatible Brain v2 route',async()=>{
  const evaluator=new OperationalCandidateEvaluator({config:{},db:null,operationalLearning:{token:()=>{throw new Error('No runtime token use');}}});
  const snapshot={validation_plan:{content_json:JSON.stringify({targeted_replay:{plan:readyPlan()}})},
    validation_artifacts:['WALK_FORWARD','OOS_HOLDOUT'].map((kind,index)=>({kind,content_json:JSON.stringify({targeted_behavior:{
      independent_verdict:{verdict:'PASS'},verified_candidate_trades:[4,-2,4].map((net_pnl,i)=>({run_id:`r-${index}`,trade_id:String(i),
        net_pnl,exit_utc:`2025-0${index+1}-0${i+1}T00:00:00Z`,native_exit_sequence:i+1,exit_sierra_datetime:Date.parse(`2025-0${index+1}-0${i+1}T00:00:00Z`)/86400000+25569,behavior_passed:true}))}})}))};
  const response=await evaluator.recordInBrain({},snapshot);
  assert.equal(response.local_gate_rejection.targeted_assessment.verdict,'PASS');
  assert.equal(response.local_gate_rejection.brain_writeback_reason,'TARGETED_REPLAY_CURRENT_PHYSICAL_VERIFICATION_REQUIRED');
  assert.equal(response.local_gate_rejection.targeted_physical_evidence.verified,false);
});

test('risk limits cannot be relaxed in the result after independent evidence is seen',t=>{
  const {binding,testPlan,targeted,result,options}=resultFixture(t);
  targeted.independent_verdict.limits.max_drawdown=1e12;
  assert.throws(()=>validateTargetedReplayResultBinding(binding,testPlan,targeted,result,options),
    error=>error.code==='TARGETED_REPLAY_PREDECLARED_RISK_LIMITS_CONFLICT');
});

test('nonzero trades cannot use empty trace arrays or an unretained evidence hash',t=>{
  const f=resultFixture(t);
  f.targeted.cases[0].actual_orders_fills_stop_target_exit_trace.candidate={orders:[],fills:[],stops:[],targets:[],exits:[]};
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),
    error=>error.code==='TARGETED_REPLAY_TRACE_ARTIFACT_SCOPE_CONFLICT');
  f.targeted.cases[0].run_receipt_and_evidence_hashes.candidate.evidence_sha256=hash('absent');
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),
    error=>error.code==='TARGETED_REPLAY_TRACE_ARTIFACT_REQUIRED');
});

test('metadata flags and hash-shaped strings never prove physical or run authority',()=>{
  const plan=readyPlan();
  assert.equal(validateTargetedReplayBehaviorPlan(plan).authority_status,'UNPROVEN');
  assert.throws(()=>validateTargetedReplayPlanBinding(plan,testsFor(plan)),error=>error.code==='TARGETED_REPLAY_AUTHORITY_UNPROVEN');
  const backend={config:{browser:{subject_id:'wayne-ocean-ui'}},artifactFor:()=>({producer_id:'strategy',content:Buffer.from('{}')})};
  assert.throws(()=>verifyTargetedReplayAuthority(backend,{strategy_id:plan.strategy_id},plan),
    error=>error.code==='TARGETED_REPLAY_TRUSTED_ATTESTATION_REQUIRED');
});

test('authority requires three current human artifacts and the exact stored approval binding',()=>{
  const plan=readyPlan(),row={strategy_id:plan.strategy_id,instance_id:'replay-two',candidate_hash:hash('registered-candidate')};
  const common={strategy_id:row.strategy_id,instance_id:row.instance_id,candidate_hash:row.candidate_hash,
    frozen_case_plan_hash:plan.frozen_case_plan_hash,acceptance_policy_hash:objectHash(plan.independent_acceptance),status:'VERIFIED',
    verified_at_utc:new Date(Date.now()-1000).toISOString(),expires_at_utc:new Date(Date.now()+60_000).toISOString()};
  const approval={decision:{id:plan.run_authority_id},binding:{candidate_hash:row.candidate_hash}};
  const contents={host:{...common,schema_version:'cicd-vwap-physical-replay-host-attestation/v1',gate_issue_id:'OCEA-55'},
    universe:{...common,schema_version:'cicd-vwap-source-universe-attestation/v1',gate_issue_id:'OCEA-89',qualified_causal_source:true,
      selector_uses_pre_event_inputs_only:true,all_matches_verified:true,all_independent_windows_verified:true,
      case_ids:plan.cases.map(item=>item.case_id),independent_window_ids:plan.independent_windows.map(item=>item.window_id)},
    run:{...common,schema_version:'cicd-vwap-targeted-replay-run-authority/v1',decision_id:approval.decision.id,
      scope:'BOUNDED_REPLAY_TESTS_ONLY',paper_or_live_authorized:false,approval_binding_sha256:objectHash(approval.binding)}};
  plan.physical_replay_host_attestation_artifact_id='host';plan.physical_replay_host_attestation_sha256=hash(JSON.stringify(contents.host));
  plan.source_universe_attestation_artifact_id='universe';plan.source_universe_attestation_sha256=hash(JSON.stringify(contents.universe));
  plan.run_authority_artifact_id='run';plan.run_authority_sha256=hash(JSON.stringify(contents.run));
  const backend={config:{browser:{subject_id:'wayne-ocean-ui'}},
    artifactFor:(_row,id)=>({producer_id:'wayne-ocean-ui',content:Buffer.from(JSON.stringify(contents[id]))}),approved:()=>approval};
  assert.equal(verifyTargetedReplayAuthority(backend,row,plan).verified,true);
  contents.run.scope='ANY_RUNTIME';plan.run_authority_sha256=hash(JSON.stringify(contents.run));
  assert.throws(()=>verifyTargetedReplayAuthority(backend,row,plan),error=>error.code==='TARGETED_REPLAY_RUN_AUTHORITY_UNPROVEN');
  contents.run.scope='BOUNDED_REPLAY_TESTS_ONLY';plan.run_authority_sha256=hash(JSON.stringify(contents.run));
  plan.independent_acceptance.max_drawdown=999;
  assert.throws(()=>verifyTargetedReplayAuthority(backend,row,plan),error=>error.code==='TARGETED_REPLAY_ATTESTATION_SCOPE_CONFLICT');
});

test('risk metrics use the complete ordered trade series and reject one-trade dependence',()=>{
  const limits={max_drawdown:5,max_largest_winner_share:0.6};
  const trades=[4,-2,4].map((net_pnl,index)=>({net_pnl,exit_utc:`2025-01-0${index+1}T00:00:00Z`,native_exit_sequence:index+1,exit_sierra_datetime:Date.parse(`2025-01-0${index+1}T00:00:00Z`)/86400000+25569,run_id:'r',trade_id:String(index),behavior_passed:true}));
  assert.deepEqual(assessIndependentTrades(trades,limits),{candidate_net_pnl:6,max_drawdown:2,largest_winner_share:0.5,
    positive_net_after_costs:true,controlled_drawdown:true,no_single_trade_dependence:true,behavior_passed:true,ordering_proved:true,ordering_blocker:null,verdict:'PASS'});
  assert.equal(assessIndependentTrades(trades.slice(0,1),limits).verdict,'FAIL');
});

test('the shared evaluator fails closed on missing UTC and ambiguous native ordering',()=>{
  const limits={max_drawdown:5,max_largest_winner_share:0.5};
  const rows=[4,-2,4].map((net_pnl,index)=>({net_pnl,run_id:'run',trade_id:String(index),exit_utc:'2025-01-01T00:00:00Z',native_exit_sequence:index+1,behavior_passed:true}));
  assert.equal(assessIndependentTrades([...rows].reverse(),limits).verdict,'PASS');
  const missing=rows.map(({exit_utc,...row})=>row);
  assert.equal(assessIndependentTrades(missing,limits).ordering_blocker,'EXIT_UTC_UNPROVED');
  assert.equal(assessIndependentTrades(missing,limits).max_drawdown,null);
  assert.equal(assessIndependentTrades(missing,limits).verdict,'FAIL');
  for(const altered of [rows.map(({native_exit_sequence,...row})=>row),rows.map((row,index)=>({...row,native_exit_sequence:index===2?1:row.native_exit_sequence})),rows.map((row,index)=>({...row,run_id:index?'other':'run'}))]){
    assert.equal(assessIndependentTrades(altered,limits).ordering_blocker,'EXIT_UTC_TIE_UNRESOLVED');
    assert.equal(assessIndependentTrades(altered,limits).verdict,'FAIL');
  }
});

test('legacy validation requires the ledger UTC and sequence instead of a trace-only timestamp assertion',t=>{
  const f=resultFixture(t),ledger=f.options.ledgerBySegment.values().next().value;
  const originalUtc=ledger.candidate[0].exit_utc;
  delete ledger.candidate[0].exit_utc;
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),{code:'TARGETED_REPLAY_TRACE_EXIT_UTC_UNPROVED'});
  ledger.candidate[0].exit_utc=originalUtc;ledger.candidate[0].native_exit_sequence=999;
  assert.throws(()=>validateTargetedReplayResultBinding(f.binding,f.testPlan,f.targeted,f.result,f.options),{code:'TARGETED_REPLAY_TRACE_EXIT_SEQUENCE_UNPROVED'});
});

test('legacy CICD VWAP evidence is quarantined without changing tasks or reinterpreting its approval',()=>{
  const dispatch=Object.create(OperationalCandidateDispatch.prototype);
  const result=dispatch.reconcileValidationArtifacts(null,{id:'legacy',strategy_id:'cicd-vwap-pull-back-strategy'},{},[]);
  assert.equal(result.status,'LEGACY_TARGETED_REPLAY_PLAN_QUARANTINED');
});
