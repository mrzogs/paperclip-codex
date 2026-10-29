import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { digest,objectHash } from './common.mjs';
import { OperationalCandidateDispatch } from './operational-candidate-dispatch.mjs';
import { OperationalCandidateEvaluator } from './operational-candidate-evaluation.mjs';
import { makeVwapSoftwareFixture } from './vwap-test-result-adapter.fixtures.mjs';

const london=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value)).replace('T',' ');
const costModel={schema_version:'ocean-observed-cost-model/v2',fee_model_version:'fixture-fees/v1',fee_schedule_hash:digest('fixture-fee-schedule'),broker_profile:'SOFTWARE_FIXTURE_ONLY',product:'MNQ',fee_tier:'fixture',currency:'USD',total_fee_per_side:0.5,effective_from:'2025-01-01',source_reference:'SOFTWARE_FIXTURE_ONLY',source_type:'custom'};
const ref=(root,name,content)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return {path:file,sha256:digest(content)};};

function dispatchFixture(t,index){
  const native={},physical={};
  const f=makeVwapSoftwareFixture(t,index,({side,originals,terminalPayload,root,item,testPlan})=>{
    if(originals)native[side]=originals;
    if(!terminalPayload)return;
    const source=ref(root,`${side}-source.cpp`,`${side}-source`),dll=ref(root,`${side}.dll`,`${side}-binary`),marker=ref(root,`${side}-marker.txt`,`${side}-marker-${index}`);
    const metrics={trade_count:native[side].trades.length,gross_pnl:native[side].trades.reduce((n,t)=>n+t.gross_pnl,0),fees:native[side].trades.reduce((n,t)=>n+t.fees,0),net_pnl:native[side].trades.reduce((n,t)=>n+t.net_pnl,0),short_trade_count:0,zero_trade_periods:0,open_trade_count:0};
    const version=side==='baseline'?testPlan.baseline_version:testPlan.candidate_execution_version;
    Object.assign(terminalPayload,{schema_version:'ocean-replay-test-completion/v1',run_kind:'TEST',
      requested_replay_window:{start_chart_time:london(item.warmup_start_utc),end_chart_time:london(item.end_utc)},
      execution_identity:{strategy_id:native[side].project_id,strategy_version:version,trade_strategy_version:version,symbol:item.contract,chart_number:1},
      logger_receipt:{closed_trade_count:metrics.trade_count,scored_closed_trade_count:metrics.trade_count},
      runner_boundary_proof:{scored_boundary_open_trade_excluded:false,test_boundary_close:{applied:false}},
      physical_binaries:{replay_source:source,replay_dll:dll,replay_marker:marker},
      safety:{simulation_account:'Sim1',all_trades_simulated:true,all_fills_simulated:true,live_real:'DISABLED',workflow_status_mutated:false}});
    physical[side]={source,dll,marker,metrics,version};
  },{decorateTest:test=>Object.assign(test,{baseline_version:'v0.6.240-fixture-baseline',candidate_version:'v0.6.238-fixture-candidate',candidate_execution_version:'v0.6.240-fixture-candidate',telemetry_version:'v0.5.54-fixture',telemetry_hash:digest('telemetry-fixture'),cost_model:costModel,cost_model_hash:objectHash(costModel)})});
  const segment=f.input.result.segments[0],telemetry=ref(f.root,'telemetry.dll','telemetry-fixture');
  for(const side of ['baseline','candidate']){
    const p=physical[side],run=f.input.physical_runs.find(run=>run.side===side),runId=run.run_id;
    const snapshot=ref(f.root,`${side}/run-snapshot.json`,JSON.stringify({schema_version:'ocean-candidate-validation-run-snapshot/v1',
      run:{run_id:runId,strategy_id:f.input.project_id,strategy_version:p.version},logger_receipt:{run_id:runId,trade_account:'Sim1',closed_trade_count:p.metrics.trade_count},
      context:{data_quality_flags:null},metrics:p.metrics,terminal_metrics:{trade_count:p.metrics.trade_count},
      scored_boundary:{cleanup_applied:false,scored_closed_trade_count:p.metrics.trade_count,terminal_trade_count:p.metrics.trade_count,cleanup_trade_id:null},
      duplicate_check:{total_rows:p.metrics.trade_count,distinct_rows:p.metrics.trade_count}}));
    const db=new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE replay_runs(run_id TEXT PRIMARY KEY);CREATE TABLE replay_run_context(run_id TEXT PRIMARY KEY,fee_model_version TEXT,fee_schedule_hash TEXT);
      CREATE TABLE trades(run_id TEXT,trade_id TEXT,trade_account TEXT,is_simulated INTEGER,strategy_id TEXT,fees_available INTEGER,total_fee_per_side REAL,total_commission REAL,
        fee_broker_profile TEXT,fee_product_code TEXT,fee_tier TEXT,fee_source_type TEXT,exit_datetime REAL,gross_currency_value REAL,net_profit_loss REAL);`);
    db.prepare('INSERT INTO replay_runs VALUES(?)').run(runId);db.prepare('INSERT INTO replay_run_context VALUES(?,?,?)').run(runId,costModel.fee_model_version,costModel.fee_schedule_hash);
    for(const trade of native[side].trades)db.prepare('INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,trade.trade_id,'Sim1',1,f.input.project_id,1,0.5,trade.fees,costModel.broker_profile,'MNQ','fixture','custom',trade.exit_sierra_datetime,trade.gross_pnl,trade.net_pnl);
    const database=ref(f.root,`${side}/telemetry.sqlite`,db.serialize());db.close();
    const receipt={path:run.terminal_receipt_ref.path,sha256:run.terminal_receipt_ref.sha256};
    segment.source_files.push(p.source,p.dll,p.marker,receipt,snapshot,database);
    Object.assign(segment[side],{strategy_version:p.version,strategy_hash:p.dll.sha256,telemetry_version:f.input.test.telemetry_version,telemetry_hash:telemetry.sha256,
      short_trade_count:0,zero_trade_periods:0,terminal_trade_count:p.metrics.trade_count,boundary_cleanup_trade_id:null,data_quality_flags:[],
      physical_hashes:{strategy_source_hash:p.source.sha256,strategy_dll_hash:p.dll.sha256,strategy_marker_hash:p.marker.sha256,completion_receipt_hash:receipt.sha256}});
    const {run_id,completion_receipt_hash,physical_hashes,terminal_trade_count,boundary_cleanup_trade_id,...aggregate}=segment[side];
    f.input.result[side]=aggregate;
  }
  segment.source_files.push(telemetry);
  Object.assign(f.input.result,{status:'PASS',checks:{physical_strategy_hash_verified:true,telemetry_attribution_complete:true,fees_reconciled:true,duplicates_absent:true,zero_trade_periods_recorded:true,completion_receipt_verified:true,same_window_and_cost_model:true,database_read_completed:true},
    comparison:{reported_delta:0},contradictions:[],limitations:[],provenance:{cost_model:costModel,cost_model_hash:objectHash(costModel)},targeted_behavior:{},
    targeted_physical_evidence:{schema_version:'ocean-vwap-targeted-physical-evidence/v1',protocol_ref:f.input.protocol_ref,case_evidence_ref:f.input.case_evidence_ref,physical_runs:f.input.physical_runs}});
  return f;
}
function dispatch(f,verification=f.options){
  const owner=Object.create(OperationalCandidateDispatch.prototype);owner.b={targetedReplayVerification:verification};
  const row={id:'case',strategy_id:f.input.project_id,baseline_hash:f.input.planBinding.plan.cases[0].baseline_source_sha256};
  const completed={plan_artifact_id:'plan',completion_hash:digest('completion'),candidate:{candidate_version:'v0.6.238-fixture-candidate'}};
  const registered={candidate_hash:f.input.candidate_hash},plan={targeted_replay:f.input.planBinding,plan_hash:digest('outer-plan')};
  return ()=>owner.validateResult(row,completed,registered,plan,f.input.test,f.input.result);
}

test('verified dispatch reports preserve private trace refs through artifact storage and evaluator revalidation',t=>{
  const fixtures=[0,1,2,3].map(index=>dispatchFixture(t,index)),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const verification={...fixtures[0].options,evidenceRoot:os.tmpdir()};
  db.exec('CREATE TABLE artifacts(kind TEXT,content_json TEXT,content_sha256 TEXT)');
  for(const f of fixtures){const report=dispatch(f,verification)();assert.ok(report.segments[0].source_files.every(file=>path.isAbsolute(file.path)));
    const content=JSON.stringify(report);db.prepare('INSERT INTO artifacts VALUES(?,?,?)').run(f.input.test.kind,content,digest(content));}
  const outer={targeted_replay:fixtures[0].input.planBinding,tests:fixtures.map(f=>f.input.test)},planJson=JSON.stringify(outer);
  const snapshot={case:{case_id:'case',strategy_id:fixtures[0].input.project_id,candidate_hash:fixtures[0].input.candidate_hash,baseline_hash:outer.targeted_replay.plan.cases[0].baseline_source_sha256},
    validation_plan:{content_json:planJson,content_sha256:digest(planJson)},validation_artifacts:db.prepare('SELECT * FROM artifacts').all()};
  const evaluator=new OperationalCandidateEvaluator({config:{},db:null,operationalLearning:{},targetedReplayVerification:verification});
  const effective=evaluator.effectiveConclusion(snapshot,{conclusion_type:'BENEFIT_SUPPORTED'});
  assert.equal(effective.conclusion,'BENEFIT_SUPPORTED');assert.equal(effective.targeted_physical_evidence.adapter_bindings.length,4);
  for(const mutate of [parsed=>{delete parsed.segments[0].source_files[0].path;},parsed=>{parsed.segments[0].source_files[0].sha256=digest('tampered-trace-ref');}]){
    const altered=structuredClone(snapshot),first=altered.validation_artifacts[0],parsed=JSON.parse(first.content_json);mutate(parsed);
    first.content_json=JSON.stringify(parsed);first.content_sha256=digest(first.content_json);
    assert.equal(evaluator.effectiveConclusion(altered,{conclusion_type:'BENEFIT_SUPPORTED'}).conclusion,'BENEFIT_NOT_ESTABLISHED');
  }
});

test('typed dispatch pre-reads reject oversize, escaped roots and aggregate exhaustion without readFileSync',t=>{
  const f=dispatchFixture(t,2),original=fs.readFileSync;let unbounded=0;
  const paths=new Set(f.input.result.segments[0].source_files.map(file=>file.path));
  fs.readFileSync=function(file,...args){if(paths.has(file))unbounded++;return original.call(this,file,...args);};
  try{
    assert.throws(dispatch(f,{...f.options,maxArtifactBytes:16}));
    assert.throws(dispatch(f,{...f.options,maxTotalArtifactBytes:fs.statSync(f.input.result.segments[0].source_files[0].path).size}));
    assert.throws(dispatch(f,{...f.options,evidenceRoot:path.join(f.root,'baseline')}));
    assert.equal(unbounded,0);
  }finally{fs.readFileSync=original;}
});
