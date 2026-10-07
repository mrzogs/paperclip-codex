import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash } from './common.mjs';
import { OperationalLearning, cumulativeLearningProposal, criticalCausalQualityFlags } from './operational-learning.mjs';

const strategyId = 'cicd-vwap-pull-back-strategy';
const instanceId = 'cicd-vwap-pull-back-strategy:replay-two:chart1';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-learning-'));
  const tokenFile = path.join(root, 'brain.token');
  fs.writeFileSync(tokenFile, 'protected-test-token-value-123456');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ow_strategies (id TEXT PRIMARY KEY, profile_id TEXT, revision INTEGER, baseline_hash TEXT, payload_json TEXT);
    CREATE TABLE ow_profiles (id TEXT PRIMARY KEY, strategy_id TEXT, version TEXT, content_hash TEXT, payload_json TEXT);
    CREATE TABLE ow_instances (id TEXT PRIMARY KEY, strategy_id TEXT, payload_json TEXT);
    CREATE TABLE ow_runs (id TEXT PRIMARY KEY, strategy_id TEXT, instance_id TEXT, state TEXT, context_json TEXT);
    CREATE TABLE ow_run_plans (id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE ow_operational_releases (run_id TEXT PRIMARY KEY, context_hash TEXT);
    CREATE TABLE ow_evidence_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event_id TEXT, canonical_id TEXT, payload_json TEXT);
    CREATE TABLE ow_operational_brain_results (id TEXT PRIMARY KEY, run_id TEXT, payload_json TEXT);
    CREATE TABLE ow_operational_brain_callbacks (result_id TEXT PRIMARY KEY, payload_json TEXT);
  `);
  const summaries = new Map();
  const events = [];
  const requests = [];
  const continuations = [];
  const registry = {
    reconciliation_id:'registry-reconciliation-20261007090000-aaaaaaaa',
    record_sha256:`sha256:${'9'.repeat(64)}`,
    lifecycle_status:'ACTIVE',
    normal_brain_ingestion_eligible:true,
    development_recommendations_allowed:true,
  };
  const brainIdentity = { identity_id:'brain-operational', role:'BRAIN', namespace:'OPERATIONAL', audience:'Ocean workflow operational v1', scopes:['read','artifact.write','event.write'], strategy_ids:[strategyId], instance_ids:[instanceId], factual_binding_hash:`sha256:${'1'.repeat(64)}` };
  const profileId='profile:1';
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(strategyId,profileId,1,digest('baseline'),JSON.stringify({strategy_id:strategyId,strategy_name:'VWAP Pullback',profile_id:'profile'}));
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(profileId,strategyId,'1',digest('profile'),JSON.stringify({
    owner_project:strategyId,
    evidence_policy:{status:'APPROVED',minimum_comparable_trades:2,minimum_independent_sessions:1,maximum_data_quality_issues:0},
  }));
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(instanceId,strategyId,JSON.stringify({
    execution_instance_id:instanceId,account_alias:'Sim1',capabilities:['REPLAY'],
  }));
  const backend = {
    db,
    config:{ identities:[brainIdentity] },
    runs:{ summary:run=>summaries.get(run.id) },
    operationalResults:{
      register(actor,input) {
        const result={ result_id:`result:${input.run_id}:${input.content_sha256.slice(-12)}`, run_id:input.run_id, context_hash:input.context_hash, content:input.content, content_sha256:input.content_sha256, correlation:input.correlation };
        db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?)').run(result.result_id,input.run_id,JSON.stringify(result));
        return result;
      },
      callback(actor,input) {
        const existing=db.prepare('SELECT payload_json FROM ow_operational_brain_callbacks WHERE result_id=?').get(input.result_id);
        if(existing)return JSON.parse(existing.payload_json);
        const callback={...input};db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?)').run(input.result_id,JSON.stringify(callback));return callback;
      },
    },
    createOperationalLearningContinuation(actor,input){continuations.push(input);return {case_id:input.case_id,artifact_id:input.artifact_id,recipient_id:'strategy-worker',stage:'RESEARCH',work_status:'READY',next_action:'Strategy Research evaluation queued'};},
    event(entity,action,actor,payload){events.push({entity,action,actor,payload});},
  };
  const addRun = ({id, partition='DISCOVERY', permission='HISTORICAL_DISCOVERY', testRun=false, current=true, pnl=[], contextHash=null, coverage=null, configHash=null}) => {
    const runId=testRun?`test-${id}`:id;
    const context={strategy_id:strategyId,strategy_profile_id:'profile',strategy_profile_version:'1',strategy_version:'v1',strategy_code_hash:digest('code'),strategy_config_hash:configHash||digest('config'),execution_instance_id:instanceId,source_installation_id:'replay-two',expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',dataset_manifest_id:'manifest',dataset_manifest_revision:1,dataset_manifest_hash:digest('manifest'),dataset_partition:partition,learner_permission:permission,context_hash:contextHash||digest(runId)};
    db.prepare('INSERT INTO ow_runs VALUES(?,?,?,?,?)').run(runId,strategyId,instanceId,'COMPLETED',JSON.stringify(context));
    db.prepare('INSERT INTO ow_run_plans VALUES(?,?)').run(runId,JSON.stringify({operational_review:{review_hash:digest('review'),factual_binding_hash:digest('factual-binding')}}));
    db.prepare('INSERT INTO ow_operational_releases VALUES(?,?)').run(runId,context.context_hash);
    const completion={status:'COMPLETED',requested_coverage:coverage||[{start_utc:'2025-10-01T00:00:00Z',end_utc:'2025-11-01T00:00:00Z'}],no_trade_interval_count:0};
    summaries.set(runId,{completion_current:current,completion,open_pins:0,unresolved_records:0,progress:{pending_events:0,gaps:[],failures:[]}});
    pnl.forEach((value,index)=>db.prepare('INSERT INTO ow_evidence_revisions(run_id,event_id,canonical_id,payload_json) VALUES(?,?,?,?)').run(runId,`${runId}-event-${index}`,`${runId}-trade-${index}`,JSON.stringify({facts:{pnl:value},provenance:{side:index%2?'SHORT':'LONG'}})));
    return runId;
  };
  const prior=addRun({id:'operational-prior',pnl:[100,-25],coverage:[{start_utc:'2025-09-01T00:00:00Z',end_utc:'2025-10-01T00:00:00Z'}]});
  const trigger=addRun({id:'operational-trigger',pnl:[50]});
  addRun({id:'protected-validation',partition:'VALIDATION',permission:'NONE',pnl:[999]});
  addRun({id:'synthetic',testRun:true,pnl:[888]});
  const fetch = async (url,options={}) => {
    if(url.endsWith('/auth/me'))return {ok:true,status:200,json:async()=>({client:{scope:'TRADING',strategy_ids:[strategyId]}})};
    if(url.includes(`/strategy-registry/${strategyId}`))return {ok:true,status:200,json:async()=>({status:'ok',strategy:{reconciliation:{reconciliation_id:registry.reconciliation_id,record_sha256:registry.record_sha256,lifecycle_status:registry.lifecycle_status},governance:{normal_brain_ingestion_eligible:registry.normal_brain_ingestion_eligible,development_recommendations_allowed:registry.development_recommendations_allowed}}})};
    const input=JSON.parse(options.body);requests.push(input);
    const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,registry_record_sha256:input.registry_record_sha256,conclusion:{type:'NO_CHANGE',reasons:['no change required']},finding:'Cumulative evidence reviewed; no automatic strategy change.'});
    return {ok:true,status:200,json:async()=>({schema_version:'ocean-operational-learning-result/v1',record_id:'reasoning-verified-learning',relative_path:'reasoning/verified-learning.md',content,content_sha256:digest(content),conclusion_type:'NO_CHANGE',source_record_ids:[...input.cohort.eligible_runs,...input.excluded_evidence].map(run=>run.run_id),correlation:input.correlation})};
  };
  const learner=new OperationalLearning(backend,{enabled:true,strategy_id:strategyId,token_file:tokenFile,fetch,interval_ms:60000,telemetry_required:false});
  return {root,db,backend,learner,requests,events,continuations,registry,prior,trigger,addRun,close(){learner.stop();db.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('completed operational runs are analysed cumulatively and protected or TEST evidence is excluded',async()=>{
  const f=fixture();
  try{
    await f.learner.flushOnce();
    assert.equal(f.requests.length,2);
    const triggerRequest=f.requests.find(value=>value.trigger.run_id===f.trigger);
    assert.deepEqual(triggerRequest.cohort.eligible_runs.map(value=>value.run_id),[f.prior,f.trigger]);
    assert.equal(triggerRequest.cohort.aggregate.observed_sample_count,3);
    assert.equal(triggerRequest.cohort.aggregate.minimum_sample_count,2);
    assert.equal(triggerRequest.cohort.aggregate.evidence_status,'INSUFFICIENT');
    assert.ok(triggerRequest.excluded_evidence.some(value=>value.run_id==='protected-validation' && value.exclusion_reason.includes('LEARNER_PERMISSION_DENIED')));
    assert.ok(triggerRequest.excluded_evidence.some(value=>value.run_id==='test-synthetic' && value.exclusion_reason.includes('TEST_RUN')));
    assert.equal(f.learner.statusForRun(f.trigger).stage,'COMPLETE');
    assert.equal(f.learner.statusForRun(f.trigger).brain_record_id,'reasoning-verified-learning');
    assert.equal(f.learner.statusForRun(f.trigger).conclusion_type,'NO_CHANGE');
    assert.equal(f.events.filter(value=>value.action==='operational.learning.complete').length,2);
    await f.learner.flushOnce();
    assert.equal(f.requests.length,2,'completed callbacks must remain idempotent');
  }finally{f.close();}
});

test('a changed registry fingerprint triggers one append-only reanalysis per completed run',async()=>{
  const f=fixture();
  try{
    await f.learner.flushOnce();
    assert.equal(f.requests.length,2);
    const firstFingerprint=f.registry.record_sha256;
    f.registry.reconciliation_id='registry-reconciliation-20261007100000-bbbbbbbb';
    f.registry.record_sha256=`sha256:${'8'.repeat(64)}`;
    await f.learner.flushOnce();
    assert.equal(f.requests.length,4);
    assert.ok(f.requests.slice(0,2).every(value=>value.registry_record_sha256===firstFingerprint));
    assert.ok(f.requests.slice(2).every(value=>value.registry_record_sha256===f.registry.record_sha256));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_results').get().n,4);
    await f.learner.flushOnce();
    assert.equal(f.requests.length,4,'the same governance fingerprint must remain idempotent');
    assert.equal(f.learner.statusForRun(f.trigger).stage,'COMPLETE');
  }finally{f.close();}
});

test('a Brain recommendation creates one deterministic Research continuation',async()=>{
  const f=fixture();
  try{
    f.learner.fetch=async (url,options={})=>{
      if(url.endsWith('/auth/me'))return {ok:true,status:200,json:async()=>({client:{scope:'TRADING',strategy_ids:[strategyId]}})};
      if(url.includes(`/strategy-registry/${strategyId}`))return {ok:true,status:200,json:async()=>({status:'ok',strategy:{reconciliation:{reconciliation_id:f.registry.reconciliation_id,record_sha256:f.registry.record_sha256,lifecycle_status:f.registry.lifecycle_status},governance:{normal_brain_ingestion_eligible:true,development_recommendations_allowed:true}}})};
      const input=JSON.parse(options.body);f.requests.push(input);
      const recommendation={title:'Investigate the weak short-side segment',content:'Evaluate one bounded Research hypothesis. No candidate or trading authority is granted.'};
      const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,registry_record_sha256:input.registry_record_sha256,conclusion:{type:'RECOMMENDATION',reasons:['evidence policy permits a development recommendation'],recommendation}});
      return {ok:true,status:200,json:async()=>({schema_version:'ocean-operational-learning-result/v1',record_id:`reasoning-${input.trigger.run_id}`,relative_path:`reasoning/${input.trigger.run_id}.md`,content,content_sha256:digest(content),conclusion_type:'RECOMMENDATION',source_record_ids:[...input.cohort.eligible_runs,...input.excluded_evidence].map(run=>run.run_id),correlation:input.correlation})};
    };
    await f.learner.flushOnce();
    assert.equal(f.continuations.length,2);
    const trigger=f.learner.statusForRun(f.trigger);
    assert.equal(trigger.conclusion_type,'RECOMMENDATION');
    assert.match(trigger.continuation_case_id,/^CASE-OPERATIONAL-/);
    assert.match(trigger.continuation_artifact_id,/^test-operational-learning-recommendation-/);
    assert.match(trigger.next_action,/persist and complete Research/);
    assert.equal(trigger.loop_stage,'PENDING_RESEARCH');
    await f.learner.flushOnce();
    assert.equal(f.continuations.length,2,'completed continuation must remain idempotent');
  }finally{f.close();}
});

test('sufficient cumulative causal evidence produces a bounded review proposal while excluded evidence stays contextual',()=>{
  const group=(direction,trades,wins,net)=>({
    setup_family:'vwap_pullback',direction,session_name:'London',regime_label:'trend',
    volatility_label:'normal',continuation_state:'continuation',exhaustion_state:'not_exhausted',
    exit_causality:'target',trades,wins,losses:trades-wins,flat:0,
    averages:{net_profit_loss:net/trades},
  });
  const proposal=cumulativeLearningProposal({
    policy:{project:strategyId,strategy_name:'VWAP Pullback'},
    cohort:{aggregate:{evidence_status:'SUFFICIENT',independent_session_count:24}},
    diagnostics:[
      {run_id:'run-october',eligible:true,reasons:[],metrics:{trades:60,pnl:500},telemetry:{causal_summary:{trades:60,groups:[group('LONG',30,18,900),group('SHORT',30,12,-400)]}}},
      {run_id:'run-partial-history',eligible:false,reasons:['TELEMETRY_RUN_CONTEXT_INCOMPLETE'],metrics:{trades:40,pnl:-200},telemetry:{causal_summary:{trades:40,groups:[group('LONG',40,16,-200)]}}},
    ],
  });
  assert.ok(proposal);
  const content=JSON.parse(proposal.content);
  assert.equal(content.cumulative_evidence.trades,60);
  assert.equal(content.cumulative_evidence.net_profit_loss,500);
  assert.equal(content.schema_version,'ocean-evidence-bound-learning-proposal/v2');
  assert.equal(content.cumulative_evidence.independent_sessions_verified,false);
  assert.match(content.cumulative_evidence.accounting_basis,/simulated.*not an independent broker/);
  assert.match(content.cumulative_evidence.fee_provenance,/not independently verified/);
  assert.match(content.legacy_segment_field_semantics,/not demonstrated repeatability/);
  assert.ok(content.interpretation.some(value=>value.includes('lookahead')));
  assert.equal(content.strongest_repeatable_segments[0].value,'LONG');
  assert.equal(content.weakest_repeatable_segments[0].value,'SHORT');
  assert.equal(content.excluded_context[0].use,'CONTEXT_ONLY_NOT_ELIGIBLE_FOR_AGGREGATE');
  assert.equal(content.authority.automatic_strategy_change,false);
});

test('an exact governed rerun supersedes rather than double-counts the same coverage',()=>{
  const f=fixture();
  try{
    const first=f.addRun({id:'october-r7',pnl:[100,-20]});
    const rerun=f.addRun({id:'october-r8',pnl:[100,-20]});
    const trigger=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(rerun);
    const bundle=f.learner.cohort(trigger);
    assert.ok(bundle.cohort.eligible_runs.some(value=>value.run_id===rerun));
    assert.ok(!bundle.cohort.eligible_runs.some(value=>value.run_id===first));
    assert.equal(bundle.cohort.aggregate.observed_sample_count,4);
    const superseded=bundle.excluded_evidence.find(value=>value.run_id===first);
    assert.equal(superseded.exclusion_reason_code,'SUPERSEDED_BY_LATEST_EXACT_COVERAGE');
    assert.match(superseded.exclusion_reason,/october-r8/);
    const diagnostic=bundle.diagnostics.find(value=>value.run_id===first);
    assert.equal(diagnostic.eligible,false);
    assert.equal(diagnostic.superseded_by_run_id,rerun);
  }finally{f.close();}
});

test('same coverage with a different strategy configuration remains independent evidence',()=>{
  const f=fixture();
  try{
    const first=f.addRun({id:'october-config-a',pnl:[100,-20],configHash:digest('config-a')});
    const second=f.addRun({id:'october-config-b',pnl:[90,-10],configHash:digest('config-b')});
    const trigger=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(second);
    const bundle=f.learner.cohort(trigger);
    assert.ok(bundle.cohort.eligible_runs.some(value=>value.run_id===first));
    assert.ok(bundle.cohort.eligible_runs.some(value=>value.run_id===second));
  }finally{f.close();}
});

test('only explicitly informational causal feature gaps are allowed into learning',()=>{
  assert.deepEqual(criticalCausalQualityFlags('pre_entry_features_missing|pre_entry_continuation_exhaustion_missing'),[]);
  assert.deepEqual(criticalCausalQualityFlags('pre_entry_features_missing|strategy_version_mismatch'),['strategy_version_mismatch']);
});

test('an incomplete receipt cannot enter the learning cohort',()=>{
  const f=fixture();
  try{
    f.backend.runs.summary=run=>run.id===f.trigger?{...f.backend.runs.summary,completion_current:false}:null;
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    const status=f.learner.classification(run);
    assert.equal(status.eligible,false);
    assert.ok(status.reasons.includes('CURRENT_COMPLETION_RECEIPT_REQUIRED'));
  }finally{f.close();}
});

test('Brain result must prove that every cumulative cohort run was used',async()=>{
  const f=fixture();
  try{
    f.learner.fetch=async (url,options={})=>{
      if(url.endsWith('/auth/me'))return {ok:true,status:200,json:async()=>({client:{scope:'TRADING',strategy_ids:[strategyId]}})};
      if(url.includes(`/strategy-registry/${strategyId}`))return {ok:true,status:200,json:async()=>({status:'ok',strategy:{reconciliation:{reconciliation_id:f.registry.reconciliation_id,record_sha256:f.registry.record_sha256,lifecycle_status:f.registry.lifecycle_status},governance:{normal_brain_ingestion_eligible:true,development_recommendations_allowed:true}}})};
      const input=JSON.parse(options.body);
      const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,registry_record_sha256:input.registry_record_sha256,conclusion:{type:'NO_CHANGE',reasons:['incomplete provenance']},finding:'Incomplete provenance must be rejected.'});
      return {ok:true,status:200,json:async()=>({
        schema_version:'ocean-operational-learning-result/v1',record_id:'reasoning-incomplete-provenance',
        relative_path:'reasoning/incomplete-provenance.md',content,content_sha256:digest(content),
        conclusion_type:'NO_CHANGE',source_record_ids:[input.trigger.run_id],correlation:input.correlation,
      })};
    };
    await f.learner.flushOnce();
    assert.equal(f.learner.statusForRun(f.prior).stage,'PENDING');
    assert.equal(f.learner.statusForRun(f.trigger).stage,'PENDING');
    assert.equal(f.learner.statusForRun(f.prior).last_error,'OPERATIONAL_LEARNING_BRAIN_RESPONSE_INVALID');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_results').get().n,0);
  }finally{f.close();}
});

test('large Brain results are stored as verified immutable references',async()=>{
  const f=fixture();
  try{
    const largeFinding='verified cumulative evidence '.repeat(12000);
    let expectedContentSha256=null;
    f.learner.fetch=async (url,options={})=>{
      if(url.endsWith('/auth/me'))return {ok:true,status:200,json:async()=>({client:{scope:'TRADING',strategy_ids:[strategyId]}})};
      if(url.includes(`/strategy-registry/${strategyId}`))return {ok:true,status:200,json:async()=>({status:'ok',strategy:{reconciliation:{reconciliation_id:f.registry.reconciliation_id,record_sha256:f.registry.record_sha256,lifecycle_status:f.registry.lifecycle_status},governance:{normal_brain_ingestion_eligible:true,development_recommendations_allowed:true}}})};
      const input=JSON.parse(options.body);
      const sourceRecordIds=[...input.cohort.eligible_runs,...input.excluded_evidence].map(run=>run.run_id);
      const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,registry_record_sha256:input.registry_record_sha256,conclusion:{type:'NO_CHANGE',reasons:['no change required']},finding:largeFinding,source_record_ids:sourceRecordIds});
      expectedContentSha256=digest(content);
      return {ok:true,status:200,json:async()=>({
        schema_version:'ocean-operational-learning-result/v1',record_id:'reasoning-large-result',
        relative_path:'reasoning/large-result.md',content,content_sha256:digest(content),
        conclusion_type:'NO_CHANGE',source_record_ids:sourceRecordIds,correlation:input.correlation,
      })};
    };
    await f.learner.flushOnce();
    const row=f.db.prepare('SELECT payload_json FROM ow_operational_brain_results WHERE run_id=?').get(f.trigger);
    const result=JSON.parse(row.payload_json);
    const envelope=JSON.parse(result.content);
    assert.equal(f.learner.statusForRun(f.trigger).stage,'COMPLETE');
    assert.equal(envelope.storage_mode,'BRAIN_IMMUTABLE_REFERENCE');
    assert.equal(envelope.record_id,'reasoning-large-result');
    assert.equal(envelope.brain_content_sha256,expectedContentSha256);
    assert.ok(envelope.brain_content_bytes>200000);
    assert.ok(result.content.length<200000);
    assert.equal(Object.hasOwn(envelope,'content'),false);
  }finally{f.close();}
});

test('Brain HTTP validation errors retain only actionable location and message',async()=>{
  const f=fixture();
  try{
    f.learner.fetch=async()=>({
      ok:false,
      status:422,
      json:async()=>({detail:[{
        loc:['body','cohort','aggregate','aggregate_sha256'],
        msg:'String should match pattern',
        input:{secret:'must not appear'},
      }]}),
    });
    await assert.rejects(
      f.learner.call('/trading/learning/operational','protected-token',{sample:true}),
      error=>{
        assert.match(error.message,/OPERATIONAL_LEARNING_BRAIN_HTTP_422: body\.cohort\.aggregate\.aggregate_sha256: String should match pattern/);
        assert.doesNotMatch(error.message,/must not appear|protected-token/);
        return true;
      },
    );
  }finally{f.close();}
});

test('learning requires exact Telemetry v3 lineage and physical completion binding',()=>{
  const f=fixture();
  const telemetryFile=path.join(f.root,'telemetry.sqlite');
  const completionRoot=path.join(f.root,'evidence');
  fs.mkdirSync(completionRoot);
  const telemetry=new DatabaseSync(telemetryFile);
  try{
    telemetry.exec(`
      CREATE TABLE schema_version(version INTEGER);
      INSERT INTO schema_version VALUES(13);
      CREATE TABLE ocean_run_lineage_v1(
        run_id TEXT, strategy_id TEXT, strategy_version TEXT, context_hash TEXT,
        dataset_id TEXT, dataset_role TEXT, strategy_profile_id TEXT, strategy_profile_version TEXT,
        strategy_code_hash TEXT, strategy_config_hash TEXT,
        run_lifecycle_status TEXT, run_context_status TEXT, open_trade_count INTEGER,
        attempt_count INTEGER, attempt_receipt_count INTEGER, partial_receipt_count INTEGER,
        closed_trade_count INTEGER, causal_row_count INTEGER, complete_causal_row_count INTEGER,
        telemetry_qualification_status TEXT, created_utc TEXT, updated_utc TEXT
      );
      CREATE TABLE ocean_trade_causal_v2(
        trade_id INTEGER,entry_datetime TEXT,run_id TEXT,direction TEXT,status TEXT,net_profit_loss REAL,exit_causality TEXT,
        context_status TEXT,quality_flags TEXT,setup_family TEXT,session_name TEXT,regime_label TEXT,
        volatility_label TEXT,vwap_distance_points REAL,initial_risk_points REAL,continuation_state TEXT,
        exhaustion_state TEXT,exhaustion_score REAL,quality_scaler_distance_atr REAL,price_change_60m REAL,
        price_change_120m REAL,vwap_slope_60m REAL,atr_change_60m_pct REAL,mfe_points REAL,mae_points REAL,
        gross_currency_value REAL,total_commission REAL
      );
      CREATE TABLE replay_run_attempts(
        attempt_id INTEGER PRIMARY KEY,run_id TEXT,attempt_number INTEGER,attempt_started_utc TEXT,attempt_ended_utc TEXT,
        starting_trade_id INTEGER,starting_fill_id INTEGER
      );
      CREATE TABLE telemetry_run_receipts(
        run_id TEXT,attempt_id INTEGER,trade_count INTEGER,closed_trade_count INTEGER,fill_count INTEGER,
        receipt_kind TEXT,data_quality_flags TEXT
      );
    `);
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    const context=JSON.parse(run.context_json);
    telemetry.prepare('INSERT INTO ocean_run_lineage_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      f.trigger,strategyId,context.strategy_version,context.context_hash,`${context.dataset_manifest_id}:${context.dataset_manifest_revision}`,context.dataset_partition,
      context.strategy_profile_id,context.strategy_profile_version,context.strategy_code_hash,context.strategy_config_hash,'closed','complete',0,2,2,0,1,1,1,
      'TELEMETRY_COMPLETE_COVERAGE_UNVERIFIED','2025-11-01T00:00:00Z','2025-11-01T00:00:00Z');
    telemetry.prepare('INSERT INTO ocean_trade_causal_v2 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      1,'45931.5',f.trigger,'LONG','closed',125,'target','complete','pre_entry_features_missing|pre_entry_continuation_exhaustion_missing', 'vwap_pullback_long','London','trend','normal',
      2.5,5,'continuation','not_exhausted',0.5,1.25,12.5,20,0.75,-4.5,10,-3,126,1);
    fs.writeFileSync(path.join(completionRoot,`${f.trigger}-completion.json`),JSON.stringify({
      schema_version:'ocean-replay-completion/v1',run_id:f.trigger,status:'COMPLETED',
      replay_start_utc:'2025-09-17T00:00:00Z',scored_start_utc:'2025-10-01T00:00:00Z',
      end_exclusive_utc:'2025-11-01T00:00:00Z',completed_at_utc:'2025-11-01T00:00:01Z',
      simulation_account:'Sim1',live_real:'DISABLED',
    }));
    f.learner.telemetryRequired=true;
    f.learner.telemetryDb=telemetryFile;
    f.learner.completionRoot=completionRoot;
    const accepted=f.learner.classification(run);
    assert.equal(accepted.eligible,true,accepted.reasons.join(','));
    assert.equal(accepted.telemetry.contract,'telemetry-causal-export/v3');
    assert.equal(accepted.telemetry.causal_summary.groups[0].setup_family,'vwap_pullback_long');
    assert.equal(accepted.telemetry.causal_summary.groups[0].averages.net_profit_loss,125);
    assert.match(accepted.telemetry.completion_binding.receipt_sha256,/^sha256:[a-f0-9]{64}$/);
    const physicalBindingFile=path.join(f.root,'replay-run-bridge.json');
    fs.writeFileSync(physicalBindingFile,JSON.stringify({
      schema_version:'ocean-replay-run-bridge/v4',strategy_id:strategyId,instance_id:instanceId,
      expected_strategy_version:'v0.6.237',factual_binding_hash:digest('factual-binding'),
    }));
    f.learner.physicalBindingFile=physicalBindingFile;
    telemetry.prepare("UPDATE ocean_run_lineage_v1 SET strategy_version='v0.6.237'").run();
    const mapped=f.learner.classification(run);
    assert.equal(mapped.eligible,true,mapped.reasons.join(','));
    assert.equal(mapped.telemetry.physical_strategy_binding.kind,'APPROVED_LOGICAL_TO_PHYSICAL');
    fs.writeFileSync(physicalBindingFile,JSON.stringify({
      schema_version:'ocean-replay-run-bridge/v4',strategy_id:strategyId,instance_id:instanceId,
      expected_strategy_version:'v0.6.238',factual_binding_hash:digest('factual-binding'),
    }));
    const mappingRejected=f.learner.classification(run);
    assert.equal(mappingRejected.eligible,false);
    assert.ok(mappingRejected.reasons.includes('PHYSICAL_STRATEGY_BINDING_CONFLICT'));
    fs.writeFileSync(physicalBindingFile,JSON.stringify({
      schema_version:'ocean-replay-run-bridge/v4',strategy_id:strategyId,instance_id:instanceId,
      expected_strategy_version:'v0.6.237',factual_binding_hash:digest('factual-binding'),
    }));
    telemetry.prepare("UPDATE ocean_trade_causal_v2 SET quality_flags='strategy_version_mismatch'").run();
    const criticalFlagRejected=f.learner.classification(run);
    assert.equal(criticalFlagRejected.eligible,false);
    assert.ok(criticalFlagRejected.reasons.includes('TELEMETRY_CAUSAL_ROWS_NOT_CLEAN'));
    telemetry.prepare("UPDATE ocean_trade_causal_v2 SET quality_flags='pre_entry_features_missing'").run();
    telemetry.prepare('UPDATE ocean_run_lineage_v1 SET partial_receipt_count=1').run();
    telemetry.prepare('INSERT INTO replay_run_attempts VALUES(?,?,?,?,?,?,?)').run(1,f.trigger,1,'2025-10-01T00:00:00Z','2025-10-01T00:01:00Z',100,200);
    telemetry.prepare('INSERT INTO replay_run_attempts VALUES(?,?,?,?,?,?,?)').run(2,f.trigger,2,'2025-10-01T00:02:00Z','2025-11-01T00:00:00Z',100,200);
    telemetry.prepare('INSERT INTO telemetry_run_receipts VALUES(?,?,?,?,?,?,?)').run(f.trigger,1,0,0,0,'no_events','pre_order_setup_outcome_unavailable');
    telemetry.prepare('INSERT INTO telemetry_run_receipts VALUES(?,?,?,?,?,?,?)').run(f.trigger,2,1,1,2,'trades_observed',null);
    telemetry.prepare("UPDATE ocean_run_lineage_v1 SET telemetry_qualification_status='RUN_RECEIPT_PARTIAL'").run();
    const supersededAttempt=f.learner.classification(run);
    assert.equal(supersededAttempt.eligible,true,supersededAttempt.reasons.join(','));
    assert.deepEqual(supersededAttempt.telemetry.attempt_qualification.superseded_zero_event_attempts,[1]);
    telemetry.prepare('UPDATE telemetry_run_receipts SET trade_count=1 WHERE attempt_id=1').run();
    const rejected=f.learner.classification(run);
    assert.equal(rejected.eligible,false);
    assert.ok(rejected.reasons.includes('TELEMETRY_RUN_RECEIPT_PARTIAL'));
  }finally{telemetry.close();f.close();}
});
