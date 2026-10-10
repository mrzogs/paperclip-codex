import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash } from './common.mjs';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { OperationalResults } from './operational-results.mjs';
import { OperationalResearch, RESEARCH_VERSION } from './operational-research.mjs';
import { OperationalLearning, cumulativeLearningProposal, criticalCausalQualityFlags, parseSttl2Identity,
  REVIEWED_V238_PROFILE6, reviewedPhysicalProfileBinding, TELEMETRY_READ_BUSY_TIMEOUT_MS } from './operational-learning.mjs';

const strategyId = 'cicd-vwap-pull-back-strategy';
const instanceId = 'cicd-vwap-pull-back-strategy:replay-two:chart1';

test('learning telemetry reads fail fast enough to preserve website liveness', () => {
  assert.ok(TELEMETRY_READ_BUSY_TIMEOUT_MS > 0 && TELEMETRY_READ_BUSY_TIMEOUT_MS <= 100);
});

test('pending scan does not requalify an immutable completed continuation', () => {
  let classified = 0;
  const run={id:'operational-complete',strategy_id:strategyId,context_json:JSON.stringify({context_hash:digest('complete')})};
  const stored={result:{result_id:'result-complete'},callback:{status:'COMPLETED'}};
  const learner=Object.assign(Object.create(OperationalLearning.prototype),{
    strategyId,retry:new Map(),db:{prepare:()=>({all:()=>[run]})},resultFor:()=>stored,
    currentContinuationResult:()=>true,continuationRecorded:()=>true,completionEventRecorded:()=>true,
    classification:()=>{classified+=1;throw new Error('completed continuation must not be requalified');},
  });
  assert.equal(learner.pendingRun({record_sha256:digest('registry')}),null);
  assert.equal(classified,0);
});

test('reviewed v238 successor requires the exact physical and unchanged logical tuple', () => {
  const mapping = REVIEWED_V238_PROFILE6;
  assert.equal(reviewedPhysicalProfileBinding(mapping, mapping.module_sha256), mapping);
  assert.equal(reviewedPhysicalProfileBinding(mapping, mapping.module_sha256.slice(7).toUpperCase()), mapping);
  for (const key of ['strategy_id', 'strategy_profile_id', 'strategy_profile_version', 'strategy_code_hash',
    'strategy_config_hash', 'strategy_version', 'candidate_id']) {
    assert.equal(reviewedPhysicalProfileBinding({ ...mapping, [key]: 'wrong' }, mapping.module_sha256), null, key);
  }
  for (const hash of [null, '', digest('generic DLL'), 'sha256:9a79f333273b88bb6f4d97a405c9d08eb32506a8604bec273638bc1970a6713e']) {
    assert.equal(reviewedPhysicalProfileBinding(mapping, hash), null, String(hash));
  }
  assert.equal(Object.isFrozen(mapping), true);
});

function fixture({file=false,currentProofMock=false}={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-learning-'));
  const tokenFile = path.join(root, 'brain.token');
  fs.writeFileSync(tokenFile, 'protected-test-token-value-123456');
  const dbPath=file?path.join(root,'workflow.sqlite'):':memory:';
  let db = new DatabaseSync(dbPath);
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
    CREATE TABLE ow_cases (id TEXT PRIMARY KEY, run_id TEXT, payload_json TEXT, owner_id TEXT, strategy_id TEXT, instance_id TEXT);
    CREATE TABLE ow_artifacts (id TEXT PRIMARY KEY, case_id TEXT, kind TEXT, content BLOB, manifest_json TEXT, producer_id TEXT, run_id TEXT);
    CREATE TABLE ow_research_jobs (id TEXT PRIMARY KEY, case_id TEXT, artifact_id TEXT, artifact_hash TEXT, analysis_version TEXT);
    CREATE TABLE ow_events (entity_id TEXT, action TEXT, payload_json TEXT);
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
    store:{transaction(work){db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}
      catch(error){db.exec('ROLLBACK');throw error;}}},
    config:{ identities:[brainIdentity] },
    runs:{ summary:run=>summaries.get(run.id) },
    operationalResults:{
      register(actor,input) {
        const result={ result_id:`result:${input.run_id}:${input.content_sha256.slice(-12)}`, producer_id:actor.id, run_id:input.run_id, context_hash:input.context_hash, content:input.content, content_sha256:input.content_sha256, correlation:input.correlation };
        db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?)').run(result.result_id,input.run_id,JSON.stringify(result));
        return result;
      },
      callback(actor,input) {
        const existing=db.prepare('SELECT payload_json FROM ow_operational_brain_callbacks WHERE result_id=?').get(input.result_id);
        if(existing)return JSON.parse(existing.payload_json);
        const callback={...input};db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?)').run(input.result_id,JSON.stringify(callback));return callback;
      },
    },
    createOperationalLearningContinuation(actor,input){
      continuations.push(input);
      const content=JSON.stringify({...input.recommendation,result_id:input.result_id});
      db.prepare('INSERT OR IGNORE INTO ow_cases VALUES(?,?,?,?,?,?)').run(input.case_id,input.run_id,
        JSON.stringify({origin:'OPERATIONAL_LEARNING',result_id:input.result_id,registry_record_sha256:input.registry_record_sha256}),actor.id,strategyId,instanceId);
      db.prepare('INSERT OR IGNORE INTO ow_artifacts VALUES(?,?,?,?,?,?,?)').run(input.artifact_id,input.case_id,
        'RECOMMENDATION',content,JSON.stringify({content_hash:digest(content)}),actor.id,input.run_id);
      db.prepare('INSERT OR IGNORE INTO ow_research_jobs VALUES(?,?,?,?,?)').run(`job:${input.case_id}`,input.case_id,input.artifact_id,digest(content),RESEARCH_VERSION);
      return {case_id:input.case_id,artifact_id:input.artifact_id,recipient_id:'strategy-worker',stage:'RESEARCH',work_status:'READY',next_action:'Strategy Research evaluation queued'};
    },
    operationalResearch:{
      version:RESEARCH_VERSION,continuations:{ownerCurrent:()=>true},
      async flushOnce(){},
      queueEvidenceReview(run,actor,result,details,bundle){
        const suffix=digest(result.result_id).slice(7,31),caseId=`research-evidence-${suffix}`,artifactId=`test-research-evidence-${suffix}`;
        const content=JSON.stringify({learning_result_id:result.result_id,learning_result_hash:result.content_sha256,cohort_hash:objectHash(bundle.cohort)});
        db.prepare('INSERT OR IGNORE INTO ow_cases VALUES(?,?,?,?,?,?)').run(caseId,run.id,
          JSON.stringify({origin:'OPERATIONAL_RESEARCH_REASSESSMENT',registry_record_sha256:details.registry_record_sha256}),actor.id,strategyId,instanceId);
        db.prepare('INSERT OR IGNORE INTO ow_artifacts VALUES(?,?,?,?,?,?,?)').run(artifactId,caseId,'EVIDENCE',content,
          JSON.stringify({content_hash:digest(content)}),actor.id,run.id);
        db.prepare('INSERT OR IGNORE INTO ow_research_jobs VALUES(?,?,?,?,?)').run(`job:${caseId}`,caseId,artifactId,digest(content),RESEARCH_VERSION);
        return {case_id:caseId,artifact_id:artifactId};
      },
      statusForCase(caseId){return db.prepare('SELECT id FROM ow_cases WHERE id=?').get(caseId)
        ?{state:'PENDING',loop_stage:'PENDING_RESEARCH'}:null;},
    },
    event(entity,action,actor,payload){events.push({entity,action,actor,payload});
      db.prepare('INSERT INTO ow_events VALUES(?,?,?)').run(entity,action,JSON.stringify({actor_id:actor.id,payload}));},
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
  // Explicit mock-only provider for Brain/queue tests, never physical provenance evidence.
  const options={enabled:true,strategy_id:strategyId,token_file:tokenFile,fetch,interval_ms:60000,telemetry_required:false};
  let learner=new OperationalLearning(backend,options);
  const mockCurrentProof=instance=>{
    if(!currentProofMock)return;
    const classify=instance.classification.bind(instance);
    instance.classification=run=>{
      const value=classify(run);
      return {...value,telemetry:{...value.telemetry,verified:true,bypassed:false}};
    };
  };
  mockCurrentProof(learner);
  const result={root,db,backend,learner,requests,events,continuations,registry,prior,trigger,addRun,
    restart(){
      assert.equal(file,true,'restart requires file-backed SQLite');
      const currentFetch=learner.fetch;
      learner.stop();db.close();db=new DatabaseSync(dbPath);backend.db=db;
      learner=new OperationalLearning(backend,{...options,fetch:currentFetch});mockCurrentProof(learner);
      result.db=db;result.learner=learner;
    },
    close(){learner.stop();db.close();fs.rmSync(root,{recursive:true,force:true});}};
  return result;
}

function mockBrainConclusion(f, conclusionType) {
  const original=f.learner.fetch;
  f.learner.fetch=async(url,options={})=>{
    if(!options.body)return original(url,options);
    const input=JSON.parse(options.body);f.requests.push(input);
    const conclusion={type:conclusionType,reasons:['isolated persistence boundary']};
    if(conclusionType==='RECOMMENDATION')conclusion.recommendation={
      title:'Isolated Research hypothesis',content:'Test only; no candidate or approval.'};
    const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,
      registry_record_sha256:input.registry_record_sha256,conclusion});
    return {ok:true,status:200,json:async()=>({schema_version:'ocean-operational-learning-result/v1',
      record_id:`reasoning-isolated-${conclusionType}`,relative_path:`reasoning/isolated-${conclusionType}.md`,
      content,content_sha256:digest(content),conclusion_type:conclusionType,
      source_record_ids:[...input.cohort.eligible_runs,...input.excluded_evidence].map(row=>row.run_id),
      correlation:input.correlation})};
  };
}

function productionFixture() {
  const root=fs.mkdtempSync(path.join(process.env.OCEAN_G11_PRODUCTION_EVIDENCE || os.tmpdir(),'ocean-learning-production-'));
  const filename=path.join(root,'workflow.sqlite');
  const tokenFile=path.join(root,'isolated-brain.token');
  fs.writeFileSync(tokenFile,'isolated-test-token-not-operational',{flag:'wx'});
  let store=new WorkflowStore(filename),learner;
  const backend=Object.create(WorkflowBackend.prototype);
  const brain={identity_id:'isolated-brain',role:'BRAIN',namespace:'OPERATIONAL',audience:'Ocean workflow operational v1',
    strategy_ids:[strategyId],instance_ids:[instanceId],scopes:['read','artifact.write','event.write'],
    expires_at_utc:new Date(Date.now()+3600000).toISOString()};
  const recipient={...brain,identity_id:'isolated-strategy',role:'STRATEGY'};
  Object.assign(backend,{db:store.db,store,config:{identities:[brain,recipient],browser:{subject_id:'isolated-human'}},
    environment:{},auth:{human:{state:'CONFIGURED'},bindingErrors:new Map()},
    validate:kind=>assert.equal(kind,'artifact-manifest')});
  store.registerIdentity(brain);store.registerIdentity(recipient);
  const baseline=digest('isolated-baseline');
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('isolated-profile',strategyId,'1',digest('isolated-profile'),'{}');
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(strategyId,'isolated-profile',1,baseline,
    JSON.stringify({strategy_name:'EXPLICIT_MOCK_ONLY'}));
  backend.db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(instanceId,strategyId,'{}');
  const registry={record_sha256:digest('isolated-registry'),reconciliation_id:'isolated-registry',
    normal_brain_ingestion_eligible:true,development_recommendations_allowed:true};
  const requests=[];
  let brainError=null,conclusionType='NO_CHANGE';
  function addRun(id,month) {
    const context={run_id:id,strategy_id:strategyId,execution_instance_id:instanceId,strategy_profile_id:'isolated-profile',
      strategy_profile_version:'1',strategy_version:'v1',strategy_code_hash:baseline,strategy_config_hash:digest('config'),
      dataset_manifest_id:'isolated-discovery',dataset_manifest_revision:1,dataset_manifest_hash:digest('dataset'),
      source_installation_id:'isolated',expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',
      dataset_partition:'DISCOVERY',learner_permission:'HISTORICAL_DISCOVERY',
      requested_coverage:[{start_utc:`2025-${month}-01T00:00:00Z`,end_utc:`2025-${month}-02T00:00:00Z`}]};
    context.context_hash=objectHash(context);
    backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run(id,strategyId,instanceId,'COMPLETED',JSON.stringify(context));
    backend.db.prepare('INSERT INTO ow_operational_releases VALUES(?,?,?)').run(id,context.context_hash,'{}');
    return id;
  }
  const triggerId=addRun('production-trigger','01');
  function attach() {
    backend.operationalResults=new OperationalResults(backend);
    backend.operationalResearch=new OperationalResearch(backend);
    learner=new OperationalLearning(backend,{enabled:true,strategy_id:strategyId,token_file:tokenFile});
    learner.registryContext=registry;
    // Only Brain/physical/native providers and artifact-schema validation are mocks.
    // Store migrations, queue, artifacts, identity, result, callback and event paths are production.
    learner.classification=run=>({eligible:true,reasons:[],context:JSON.parse(run.context_json),
      telemetry:{verified:true,bypassed:false,proof_basis:'EXPLICIT_MOCK_ONLY'},
      summary:{completion:{status:'COMPLETED',requested_coverage:JSON.parse(run.context_json).requested_coverage}}});
    learner.evidencePolicy=()=>({project:'isolated',strategy_name:'EXPLICIT_MOCK_ONLY',
      minimum_sample_count:2,minimum_independent_session_count:1});
    learner.runSummary=run=>({summary:{run_id:run.id,context_hash:JSON.parse(run.context_json).context_hash,
      completion_hash:digest(`completion-${run.id}`),observed_sample_count:2,independent_session_count:1,
      source_record_ids:[run.id],evidence_status:'SUFFICIENT',as_of_utc:'2026-10-08T01:00:00Z'},metrics:{},telemetry:{}});
    learner.nativeSessionEvidence=ids=>({verified:true,observed_session_count:ids.length,proof_basis:'EXPLICIT_MOCK_ONLY'});
    learner.call=async(route,token,input)=>{
      if(input===undefined) {
        assert.equal(token,fs.readFileSync(tokenFile,'utf8'),'worker uses only its isolated credential');
        if(route==='/auth/me')return {client:{scope:'TRADING',strategy_ids:[strategyId],proof_basis:'EXPLICIT_MOCK_ONLY'}};
        if(route===`/strategy-registry/${strategyId}`)return {status:'ok',strategy:{
          reconciliation:{reconciliation_id:registry.reconciliation_id,record_sha256:registry.record_sha256},
          governance:{normal_brain_ingestion_eligible:true,development_recommendations_allowed:true}}};
      }
      assert.equal(route,learner.path);
      const frozen=JSON.parse(backend.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action='operational.learning.input'")
        .get(input.trigger.run_id).payload_json).payload;
      assert.deepEqual(frozen.input,input,'exact input is durable before dispatch');
      requests.push(structuredClone(input));
      if(brainError)throw new Error(brainError);
      const conclusion={type:conclusionType,reasons:['EXPLICIT_MOCK_ONLY']};
      if(conclusionType==='RECOMMENDATION')conclusion.recommendation={title:'Isolated hypothesis',content:'No approval or candidate.'};
      const content=JSON.stringify({registry_reconciliation_id:input.registry_reconciliation_id,
        registry_record_sha256:input.registry_record_sha256,conclusion});
      return {schema_version:'ocean-operational-learning-result/v1',record_id:'isolated-reasoning',relative_path:'reasoning/isolated.md',
        content,content_sha256:digest(content),conclusion_type:conclusionType,
        source_record_ids:[...input.cohort.eligible_runs,...input.excluded_evidence].map(row=>row.run_id),correlation:input.correlation};
    };
    backend.operationalLearning=learner;
  }
  attach();
  return {backend,registry,requests,root,addRun,brain,
    get learner(){return learner;},
    trigger:()=>backend.one('ow_runs',triggerId),
    brainError(value){brainError=value;},conclusion(value){conclusionType=value;},
    restart(){learner.stop();store.close();store=new WorkflowStore(filename);backend.db=store.db;backend.store=store;attach();},
    rows:table=>backend.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    fault(table,condition='1'){backend.db.exec(`CREATE TRIGGER isolated_fault BEFORE INSERT ON ${table} WHEN ${condition}
      BEGIN SELECT RAISE(ABORT,'isolated-sqlite-fault'); END`);},
    unfault(){backend.db.exec('DROP TRIGGER isolated_fault');},
    close(){
      learner.stop();
      try {
        if(process.env.OCEAN_G11_PRODUCTION_EVIDENCE)fs.writeFileSync(path.join(root,'proof.json'),JSON.stringify({
          classification:'PRODUCTION_SQLITE_QUEUE_CAPTURE_WITH_EXPLICIT_MOCK_BRAIN_PHYSICAL_NATIVE_AND_SCHEMA_PROVIDERS',
          requests,events:backend.db.prepare('SELECT * FROM ow_events ORDER BY rowid').all(),
          jobs:backend.db.prepare('SELECT * FROM ow_research_jobs ORDER BY rowid').all(),
        },null,2),{flag:'wx'});
      }finally{store.close();}
      if(!process.env.OCEAN_G11_PRODUCTION_EVIDENCE)fs.rmSync(root,{recursive:true,force:true});
    }};
}

function captureProductionResearch(f) {
  const telemetry=path.join(f.root,'synthetic-telemetry.sqlite'),database=new DatabaseSync(telemetry);
  try {
    database.exec(`CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(13);
      CREATE TABLE ocean_trade_causal_v2(trade_id TEXT,run_id TEXT,entry_datetime REAL,trade_account TEXT,
      symbol TEXT,direction TEXT,gross_currency_value REAL,total_commission REAL,net_profit_loss REAL,
      exit_causality TEXT,session_name TEXT,regime_label TEXT,status TEXT);
      INSERT INTO ocean_trade_causal_v2 VALUES('original-trade','production-trigger',45700,'Sim1','MOCK','LONG',10,1,9,'MOCK','MOCK','MOCK','closed');
      INSERT INTO ocean_trade_causal_v2 VALUES('original-trade-2','production-trigger',45700,'Sim1','MOCK','SHORT',-3,1,-4,'MOCK','MOCK','MOCK','closed');
      INSERT INTO ocean_trade_causal_v2 VALUES('later-trade','production-later',45730,'Sim1','MOCK','LONG',1000,1,999,'MOCK','MOCK','MOCK','closed');`);
  }finally{database.close();}
  f.learner.telemetryDb=telemetry;
  const research=f.backend.operationalResearch,job=research.claim();
  assert.ok(job);assert.equal(research.qualification(job).verified,true);
  const evidence=research.evidence(job);
  assert.deepEqual(evidence.bundle.cohort,f.requests[0].cohort);
  assert.deepEqual(evidence.rows.map(row=>row.trade_id),['original-trade','original-trade-2']);
  const snapshot=research.capture(job);
  assert.deepEqual(snapshot.evidence.bundle.cohort,f.requests[0].cohort);
  assert.deepEqual(snapshot.result.eligible_run_ids,[f.trigger().id]);
  assert.equal(snapshot.result.aggregate.net_profit_loss,5);
  assert.equal(snapshot.result.aggregate.trades,2);
  assert.equal(snapshot.result.evidence_hash,objectHash(evidence.rows));
  assert.equal(Object.values(snapshot.evidence.bundle.execution_sessions)[0].proof_error,'NATIVE_SESSION_SCHEMA_14_REQUIRED',
    'synthetic SQL rows never fabricate native session proof');
  return snapshot;
}

for(const conclusion of ['NO_CHANGE','BLOCKED','RECOMMENDATION']) {
  for(const boundary of ['child','callback','event']) {
    test(`production file SQLite: ${conclusion} ${boundary} failure/restart retains exact original cohort`,async()=>{
      const f=productionFixture();
      try {
        f.conclusion(conclusion);
        f.fault(boundary==='child'?'ow_cases':boundary==='callback'?'ow_operational_brain_callbacks':'ow_events',
          boundary==='event'?"NEW.action='operational.learning.complete'":'1');
        await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
        const result=f.rows('ow_operational_brain_results'),children=f.rows('ow_cases'),artifacts=f.rows('ow_artifacts');
        const inputEvents=f.rows('ow_events').filter(row=>row.action==='operational.learning.input');
        assert.equal(result.length,1);assert.equal(f.requests.length,1);
        assert.equal(children.length,boundary==='child'?0:1);
        assert.equal(f.rows('ow_operational_brain_callbacks').length,boundary==='event'?1:0);
        f.unfault();f.addRun('production-later','02');f.restart();
        assert.notEqual(objectHash(f.learner.cohort(f.trigger()).cohort),objectHash(f.requests[0].cohort));
        assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger().id);
        await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
        f.restart();await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
        assert.equal(f.requests.length,1,'stored result never dispatches Brain again');
        assert.deepEqual(f.rows('ow_operational_brain_results'),result);
        assert.deepEqual(f.rows('ow_events').filter(row=>row.action==='operational.learning.input'),inputEvents);
        if(children.length)assert.deepEqual(f.rows('ow_cases'),children);
        if(artifacts.length)assert.deepEqual(f.rows('ow_artifacts'),artifacts);
        assert.equal(f.rows('ow_cases').length,1);assert.equal(f.rows('ow_research_jobs').length,1);
        assert.equal(f.rows('ow_operational_brain_callbacks').length,1);
        const events=f.rows('ow_events').filter(row=>row.action==='operational.learning.complete');
        assert.equal(events.length,1);
        const payload=JSON.parse(events[0].payload_json).payload;
        assert.deepEqual(payload.cohort_run_ids,[f.trigger().id]);
        assert.equal(payload.cohort_hash,objectHash(f.requests[0].cohort));
        assert.equal(payload.input_sha256,f.requests[0].correlation.input_sha256);
        const artifact=f.rows('ow_artifacts')[0];
        const source=f.learner.continuationSource(f.trigger(),artifact);
        assert.deepEqual(source.cohort,f.requests[0].cohort,'Research capture reads original membership too');
        if(conclusion!=='RECOMMENDATION')assert.equal(JSON.parse(Buffer.from(artifact.content)).cohort_hash,payload.cohort_hash);
        assert.equal(f.learner.completionEventRecorded(f.trigger(),JSON.parse(result[0].payload_json)),true);
        captureProductionResearch(f);
      }finally{f.close();}
    });
  }
}

test('production file SQLite: failed first dispatch resends the durable original request after cohort drift',async()=>{
  const f=productionFixture();
  try {
    f.brainError('isolated-dispatch-fault');
    await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-dispatch-fault/);
    assert.equal(f.rows('ow_operational_brain_results').length,0);
    f.addRun('production-later','02');f.brainError(null);f.restart();
    await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
    assert.deepEqual(f.requests[1],f.requests[0]);
    assert.equal(f.rows('ow_events').filter(row=>row.action==='operational.learning.input').length,1);
    await f.learner.process(f.backend.one('ow_runs','production-later'),'isolated-test-token',f.registry);
    assert.equal(f.requests.length,3,'separate trigger gets a separately correlated analysis');
    assert.notEqual(f.requests[2].correlation.input_sha256,f.requests[0].correlation.input_sha256);
    assert.equal(f.rows('ow_cases').length,2);
  }finally{f.close();}
});

test('production file SQLite: input publication rollback prevents dispatch and partial lineage',async()=>{
  const f=productionFixture();
  try {
    assert.equal(f.learner.lineageBlock(f.trigger(),{result:{}},f.registry.record_sha256),null,
      'historical display-only result shapes do not supply a keyed lineage blocker');
    f.fault('ow_events',"NEW.action='operational.learning.input'");
    await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
    assert.equal(f.requests.length,0);assert.equal(f.rows('ow_events').length,0);
    assert.equal(f.rows('ow_operational_brain_results').length,0);
    f.unfault();f.restart();await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
    const event=f.rows('ow_events').find(row=>row.action==='operational.learning.input');
    assert.throws(()=>f.backend.db.prepare('DELETE FROM ow_events WHERE id=?').run(event.id),/immutable/i);
  }finally{f.close();}
});

for(const drift of [false,true]) {
  test(`production file SQLite: legacy v1 input recovery ${drift?'blocks newer history':'requires exact correlation'}`,async()=>{
    const f=productionFixture();
    try {
      const run=f.trigger(),actor=f.learner.brainActor(run.strategy_id,run.instance_id);
      const input=f.learner.analysisInput(run,f.learner.classification(run),f.registry);
      const details={schema_version:'ocean-operational-learning-result/v1',storage_mode:'BRAIN_IMMUTABLE_REFERENCE',
        conclusion_type:'NO_CHANGE',registry_reconciliation_id:f.registry.reconciliation_id,
        registry_record_sha256:f.registry.record_sha256,verified_run_ids:input.cohort.eligible_runs.map(row=>row.run_id)};
      const content=JSON.stringify(details);
      const result=f.backend.operationalResults.register(actor,{run_id:run.id,context_hash:input.trigger.context_hash,
        content,content_sha256:digest(content),correlation:input.correlation});
      if(drift)f.addRun('production-later','02');
      f.restart();
      if(!drift) {
        await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
        assert.equal(f.requests.length,0);assert.equal(f.rows('ow_cases').length,1);
        return;
      }
      for(let retry=0;retry<2;retry++) {
        let failure;
        try {await f.learner.process(f.trigger(),'isolated-test-token',f.registry);}catch(error){failure=error;}
        assert.equal(failure?.code,'OPERATIONAL_LEARNING_ORIGINAL_INPUT_REQUIRED');
        f.learner.fail(f.trigger(),failure);f.restart();
        const status=f.learner.statusForRun(run.id);
        assert.equal(status.stage,'BLOCKED');assert.equal(status.loop_stage,'BLOCKED');
        assert.equal(status.research,null);assert.equal(status.continuation_case_id,null);
        assert.match(status.next_action,/exact original immutable analysis input/);
      }
      assert.equal(f.rows('ow_events').filter(row=>row.action==='operational.learning.blocked').length,1);
      assert.equal(f.rows('ow_operational_brain_results').length,1);
      assert.equal(f.rows('ow_operational_brain_callbacks').length,0);assert.equal(f.rows('ow_cases').length,0);
      assert.equal(f.requests.length,0);assert.deepEqual(JSON.parse(f.rows('ow_operational_brain_results')[0].payload_json),result);
    }finally{f.close();}
  });
}

test('production file SQLite: blocked legacy A does not starve B in the batch or after restart',async()=>{
  const f=productionFixture();
  try {
    const run=f.trigger(),actor=f.learner.brainActor(run.strategy_id,run.instance_id);
    const input=f.learner.analysisInput(run,f.learner.classification(run),f.registry);
    const details={schema_version:'ocean-operational-learning-result/v1',storage_mode:'BRAIN_IMMUTABLE_REFERENCE',
      conclusion_type:'NO_CHANGE',registry_reconciliation_id:f.registry.reconciliation_id,
      registry_record_sha256:f.registry.record_sha256,verified_run_ids:input.cohort.eligible_runs.map(row=>row.run_id)};
    const content=JSON.stringify(details);
    const original=f.backend.operationalResults.register(actor,{run_id:run.id,context_hash:input.trigger.context_hash,
      content,content_sha256:digest(content),correlation:input.correlation});
    f.addRun('production-later','02');f.restart();
    f.backend.operationalResearch.stop(); // This test exercises the learning worker, not external Research dispatch.
    const first=await f.learner.flushOnce();
    assert.equal(first.items.find(row=>row.run_id===run.id).stage,'BLOCKED');
    assert.equal(first.items.find(row=>row.run_id==='production-later').stage,'COMPLETE');
    assert.deepEqual(f.requests.map(request=>request.trigger.run_id),['production-later']);
    const events=f.rows('ow_events'),children=f.rows('ow_cases'),results=f.rows('ow_operational_brain_results');
    assert.equal(events.filter(row=>row.action==='operational.learning.blocked').length,1);
    assert.equal(f.rows('ow_operational_brain_callbacks').length,1);
    assert.equal(children.length,1);assert.equal(children[0].run_id,'production-later');
    for(let restart=0;restart<2;restart++) {
      f.restart();f.backend.operationalResearch.stop();
      assert.equal(f.learner.pendingRun(f.registry),null,'unrecoverable A is not leased again');
      await f.learner.flushOnce();
      assert.equal(f.learner.statusForRun(run.id).last_error,'OPERATIONAL_LEARNING_ORIGINAL_INPUT_REQUIRED');
      assert.match(f.learner.statusForRun(run.id).next_action,/exact original immutable analysis input/);
      assert.deepEqual(f.rows('ow_events'),events,'read-only recovery checks do not republish blockers or inputs');
      assert.deepEqual(f.rows('ow_cases'),children);assert.deepEqual(f.rows('ow_operational_brain_results'),results);
    }
    assert.equal(f.requests.length,1);
    assert.deepEqual(JSON.parse(results.find(row=>row.run_id===run.id).payload_json),original);
    assert.equal(events.some(row=>row.entity_id===run.id && row.action==='operational.learning.complete'),false);
  }finally{f.close();}
});

for(const boundary of ['child','callback']) {
  test(`production file SQLite: ${boundary} blocked A resumes only when its exact original owner is restored`,async()=>{
    const f=productionFixture();
    try {
      f.fault(boundary==='child'?'ow_cases':'ow_operational_brain_callbacks');
      await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
      f.unfault();
      const originalInput=f.rows('ow_events').find(row=>row.action==='operational.learning.input');
      const originalResult=f.rows('ow_operational_brain_results')[0];
      const originalChild=f.rows('ow_cases'),originalArtifacts=f.rows('ow_artifacts');
      const replacement={...f.brain,identity_id:'isolated-new-brain'};
      f.backend.store.registerIdentity(replacement);
      f.backend.config.identities=[replacement,...f.backend.config.identities.filter(row=>row.role!=='BRAIN')];
      f.addRun('production-later','02');f.restart();f.backend.operationalResearch.stop();
      await f.learner.flushOnce();
      assert.equal(f.learner.statusForRun(f.trigger().id).stage,'BLOCKED');
      assert.equal(f.learner.statusForRun('production-later').stage,'COMPLETE');
      const block=f.rows('ow_events').find(row=>row.action==='operational.learning.blocked');
      assert.equal(JSON.parse(block.payload_json).payload.reason,'OPERATIONAL_LEARNING_INPUT_LINEAGE_CONFLICT');
      f.restart();f.backend.operationalResearch.stop();
      const before=f.rows('ow_events');
      assert.equal(f.learner.pendingRun(f.registry),null);
      await f.learner.flushOnce();assert.deepEqual(f.rows('ow_events'),before);
      assert.deepEqual(f.requests.map(request=>request.trigger.run_id),[f.trigger().id,'production-later']);
      // Restore current owner configuration, not immutable rows or workflow statuses.
      f.backend.config.identities=[f.brain,...f.backend.config.identities.filter(row=>row.role!=='BRAIN')];
      f.brain.revoked=true;f.restart();
      assert.equal(f.learner.pendingRun(f.registry),null,'revoked original owner is not recovery');
      delete f.brain.revoked;f.restart();f.backend.operationalResearch.stop();
      const originalSummary=f.learner.runSummary;
      f.learner.runSummary=run=>{
        const value=originalSummary(run);
        if(run.id===f.trigger().id)value.summary.completion_hash=digest('changed-original-source');
        return value;
      };
      assert.equal(f.learner.pendingRun(f.registry),null,'restored owner cannot hide changed original source proof');
      f.learner.runSummary=originalSummary;
      const checkEvents=f.rows('ow_events');
      assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger().id,'exact restoration is detected without status clears');
      assert.deepEqual(f.rows('ow_events'),checkEvents,'selection is read-only');
      await f.learner.flushOnce();f.restart();f.backend.operationalResearch.stop();
      await f.learner.flushOnce();
      assert.equal(f.learner.statusForRun(f.trigger().id).stage,'COMPLETE');
      assert.equal(f.requests.length,2,'original result recovery never calls Brain again');
      assert.deepEqual(f.rows('ow_operational_brain_results').find(row=>row.run_id===f.trigger().id),originalResult);
      assert.deepEqual(f.rows('ow_events').find(row=>row.id===originalInput.id),originalInput);
      assert.deepEqual(f.rows('ow_events').find(row=>row.id===block.id),block,'immutable blocker remains in history');
      assert.equal(f.rows('ow_cases').filter(row=>row.run_id===f.trigger().id).length,1);
      if(originalChild.length) {
        assert.deepEqual(f.rows('ow_cases').find(row=>row.id===originalChild[0].id),originalChild[0]);
        assert.deepEqual(f.rows('ow_artifacts').find(row=>row.id===originalArtifacts[0].id),originalArtifacts[0]);
      }
      const completion=f.rows('ow_events').filter(row=>row.entity_id===f.trigger().id && row.action==='operational.learning.complete');
      assert.equal(completion.length,1);
      assert.deepEqual(JSON.parse(completion[0].payload_json).payload.cohort_run_ids,[f.trigger().id]);
    }finally{f.close();}
  });
}

test('production file SQLite: durable-child recovery still rejects revoked owner',async()=>{
  const f=productionFixture();
  try {
    f.fault('ow_operational_brain_callbacks');
    await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
    f.unfault();f.brain.revoked=true;f.restart();
    await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),{code:'RESEARCH_CURRENT_OWNER_REQUIRED'});
    assert.equal(f.requests.length,1);assert.equal(f.rows('ow_cases').length,1);
    assert.equal(f.rows('ow_operational_brain_callbacks').length,0);
  }finally{f.close();}
});

test('production Research input capture retains original membership, not newer history',async()=>{
  const f=productionFixture();
  try {
    await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
    f.addRun('production-later','02');f.restart();
    const snapshot=captureProductionResearch(f);
    const stored=f.rows('ow_research_jobs')[0];
    f.restart();
    const resumed=f.backend.operationalResearch.capture(stored);
    assert.deepEqual(resumed,snapshot);
    assert.equal(f.requests.length,1);
    const separatelyVersioned=JSON.stringify({schema_version:'ocean-operational-research-reassessment/v1',
      source_continuation_case_id:'isolated-follow-up',evidence_revision_hash:digest('new-evidence')});
    assert.equal(f.learner.continuationSource(f.trigger(),{content:separatelyVersioned}),null,
      'separate reassessments retain their existing new-evidence capture path');
  }finally{f.close();}
});

test('production SQLite: immutable conflicting terminal envelope remains blocked, not completed by existence',async()=>{
  const f=productionFixture();
  try {
    f.fault('ow_operational_brain_callbacks');
    await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
    f.unfault();
    const stored=f.learner.resultFor(f.trigger().id,f.registry.record_sha256);
    const actor=f.learner.brainActor(strategyId,instanceId);
    f.backend.event(f.trigger().id,'operational.learning.complete',actor,{result_id:stored.result.result_id,
      cohort_hash:digest('wrong-new-cohort'),cohort_run_ids:['wrong'],excluded_run_ids:[],
      continuation_case_id:f.rows('ow_cases')[0].id,continuation_artifact_id:f.rows('ow_artifacts')[0].id});
    let failure;
    try{await f.learner.process(f.trigger(),'isolated-test-token',f.registry);}catch(error){failure=error;}
    assert.equal(failure?.code,'OPERATIONAL_LEARNING_CONTINUATION_LINEAGE_CONFLICT');
    f.learner.fail(f.trigger(),failure);f.restart();
    assert.equal(f.learner.statusForRun(f.trigger().id).stage,'BLOCKED');
    assert.equal(f.rows('ow_events').filter(row=>row.action==='operational.learning.complete').length,1);
    assert.equal(f.rows('ow_operational_brain_callbacks').length,1);
    assert.equal(f.requests.length,1);
    const conflictEvent=f.rows('ow_events').find(row=>row.action==='operational.learning.complete');
    f.addRun('production-later','02');f.restart();f.backend.operationalResearch.stop();
    assert.equal(f.learner.pendingRun(f.registry)?.id,'production-later','malformed terminal proof is not recovery');
    await f.learner.flushOnce();f.restart();
    assert.equal(f.learner.pendingRun(f.registry),null);
    assert.equal(f.learner.statusForRun(f.trigger().id).stage,'BLOCKED');
    assert.deepEqual(f.rows('ow_events').find(row=>row.id===conflictEvent.id),conflictEvent);
    assert.deepEqual(f.requests.map(request=>request.trigger.run_id),[f.trigger().id,'production-later']);
  }finally{f.close();}
});

test('production Research qualification rejects drift in an original source, not just in cohort membership',async()=>{
  const f=productionFixture();
  try {
    await f.learner.process(f.trigger(),'isolated-test-token',f.registry);
    const summary=f.learner.runSummary;
    f.learner.runSummary=run=>{
      const value=summary(run);
      return {...value,summary:{...value.summary,completion_hash:digest('replaced-source')}};
    };
    const job=f.rows('ow_research_jobs')[0],research=f.backend.operationalResearch;
    const qualification=research.qualification(job);
    assert.equal(qualification.verified,false);
    assert.equal(qualification.reason,'OPERATIONAL_LEARNING_INPUT_LINEAGE_CONFLICT');
    assert.match(qualification.required_action,/Owner isolated-brain: recover the exact original immutable analysis input/);
    assert.equal(research.claim(),null);
    assert.match(research.statusForCase(job.case_id).next_action,/Do not substitute newer history/);
    assert.equal(f.rows('ow_research_jobs')[0].input_json,null);
    assert.equal(f.requests.length,1);
  }finally{f.close();}
});

for(const conflict of ['input-hash','duplicate-input','changed-producer','child-cohort']) {
  test(`production SQLite: ${conflict} is a lineage conflict, never a retry with new history`,async()=>{
    const f=productionFixture();
    try {
      if(conflict==='input-hash') {
        const input=f.learner.analysisInput(f.trigger(),f.learner.classification(f.trigger()),f.registry);
        input.correlation.input_sha256=digest('wrong');
        f.backend.event(f.trigger().id,'operational.learning.input',f.learner.brainActor(strategyId,instanceId),
          {schema_version:'ocean-operational-learning-input/v1',registry_record_sha256:f.registry.record_sha256,
            input_sha256:input.correlation.input_sha256,research_version:RESEARCH_VERSION,input});
      }else {
        f.fault('ow_operational_brain_callbacks');
        await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),/isolated-sqlite-fault/);
        f.unfault();
        if(conflict==='duplicate-input') {
          const payload=JSON.parse(f.rows('ow_events').find(row=>row.action==='operational.learning.input').payload_json).payload;
          f.backend.event(f.trigger().id,'operational.learning.input',f.learner.brainActor(strategyId,instanceId),payload);
        }else if(conflict==='changed-producer') {
          f.brain.identity_id='new-isolated-brain';f.backend.store.registerIdentity(f.brain);
        }else {
          // A fault-injected alternate immutable child cannot replace the original result's lineage.
          const result=f.learner.resultFor(f.trigger().id,f.registry.record_sha256);
          f.backend.operationalResearch.queueEvidenceReview(f.trigger(),f.learner.brainActor(strategyId,instanceId),
            result.result,result.details,{cohort:{eligible_runs:[],aggregate:{}}});
        }
      }
      f.restart();
      await assert.rejects(f.learner.process(f.trigger(),'isolated-test-token',f.registry),
        {code:conflict==='child-cohort'?'OPERATIONAL_LEARNING_CONTINUATION_LINEAGE_CONFLICT':'OPERATIONAL_LEARNING_INPUT_LINEAGE_CONFLICT'});
      assert.equal(f.requests.length,conflict==='input-hash'?0:1);
      assert.equal(f.rows('ow_operational_brain_callbacks').length,0);
    }finally{f.close();}
  });
}

test('EXPLICIT MOCK: a real SQLite child insert failure leaves callback pending; restart reuses Brain result',async()=>{
  const f=fixture({file:true,currentProofMock:true});
  try {
    f.db.prepare("UPDATE ow_runs SET state='FAILED' WHERE id=?").run(f.prior);
    mockBrainConclusion(f,'NO_CHANGE');
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    f.db.exec("CREATE TRIGGER isolated_child_fault BEFORE INSERT ON ow_cases BEGIN SELECT RAISE(ABORT,'isolated-child-sqlite-fault'); END");
    await assert.rejects(f.learner.process(run,'isolated-test-token',f.registry),/isolated-child-sqlite-fault/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_results').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_callbacks').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,0);
    f.db.exec('DROP TRIGGER isolated_child_fault');
    f.restart();
    assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger);
    await f.learner.flushOnce();
    assert.equal(f.requests.length,1,'restart must not call Brain again');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_callbacks').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
    assert.equal(f.learner.pendingRun(f.registry),null);
    await f.learner.process(f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger),'isolated-test-token',f.registry);
    assert.equal(f.requests.length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
  }finally{f.close();}
});

test('EXPLICIT MOCK: callback SQLite failure retains one durable child and restart completes without a second Brain call',async()=>{
  const f=fixture({file:true,currentProofMock:true});
  try {
    f.db.prepare("UPDATE ow_runs SET state='FAILED' WHERE id=?").run(f.prior);
    mockBrainConclusion(f,'RECOMMENDATION');
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    f.db.exec("CREATE TRIGGER isolated_callback_fault BEFORE INSERT ON ow_operational_brain_callbacks BEGIN SELECT RAISE(ABORT,'isolated-callback-sqlite-fault'); END");
    await assert.rejects(f.learner.process(run,'isolated-test-token',f.registry),/isolated-callback-sqlite-fault/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_callbacks').get().n,0);
    f.db.exec('DROP TRIGGER isolated_callback_fault');
    f.restart();
    assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger);
    await f.learner.flushOnce();
    assert.equal(f.requests.length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_callbacks').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
  }finally{f.close();}
});

for(const conclusionType of ['NO_CHANGE','BLOCKED','RECOMMENDATION']) {
  test(`EXPLICIT MOCK: stranded current ${conclusionType} callback recovers its Research child after restart`,async()=>{
    const f=fixture({file:true,currentProofMock:true});
    try {
      f.db.prepare("UPDATE ow_runs SET state='FAILED' WHERE id=?").run(f.prior);
      mockBrainConclusion(f,conclusionType);
      const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
      f.db.exec("CREATE TRIGGER isolated_child_fault BEFORE INSERT ON ow_cases BEGIN SELECT RAISE(ABORT,'isolated-child-sqlite-fault'); END");
      await assert.rejects(f.learner.process(run,'isolated-test-token',f.registry),/isolated-child-sqlite-fault/);
      const stored=f.learner.resultFor(f.trigger,f.registry.record_sha256);
      f.backend.operationalResults.callback(null,{run_id:f.trigger,context_hash:stored.result.context_hash,
        result_id:stored.result.result_id,result_sha256:stored.result.content_sha256,
        status:'COMPLETED',correlation:stored.result.correlation});
      f.db.exec('DROP TRIGGER isolated_child_fault');
      f.restart();f.learner.registryContext=f.registry;
      const before=f.learner.statusForRun(f.trigger);
      assert.equal(before.stage,'BRAIN_RECORDED');
      assert.equal(before.loop_stage,'RESEARCH_REQUIRED');
      assert.equal(before.research,null);
      assert.equal(before.continuation_case_id,null);
      assert.equal(before.continuation_artifact_id,null);
      assert.match(before.next_action,/same immutable result/);
      assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger);
      await f.learner.flushOnce();
      assert.equal(f.requests.length,1,'recovery must not call Brain again');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_brain_callbacks').get().n,1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
      assert.equal(f.learner.pendingRun(f.registry),null);
    }finally{f.close();}
  });
}

test('EXPLICIT MOCK: missing completion event is repaired once without duplicating child or Brain call',async()=>{
  const f=fixture({file:true,currentProofMock:true});
  try {
    f.db.prepare("UPDATE ow_runs SET state='FAILED' WHERE id=?").run(f.prior);
    mockBrainConclusion(f,'NO_CHANGE');
    await f.learner.process(f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger),'isolated-test-token',f.registry);
    f.db.prepare("DELETE FROM ow_events WHERE action='operational.learning.complete'").run();
    f.restart();
    assert.equal(f.learner.pendingRun(f.registry)?.id,f.trigger);
    await f.learner.flushOnce();
    assert.equal(f.requests.length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
    await f.learner.flushOnce();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE action=?').get('operational.learning.complete').n,1);
  }finally{f.close();}
});

test('EXPLICIT MOCK: completed older-format callback stays historical and is not silently requeued',()=>{
  const f=fixture({currentProofMock:true});
  try {
    const context=JSON.parse(f.db.prepare('SELECT context_json FROM ow_runs WHERE id=?').get(f.trigger).context_json);
    const content=JSON.stringify({conclusion_type:'NO_CHANGE',registry_record_sha256:f.registry.record_sha256});
    f.db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?)').run('older-format-result',f.trigger,
      JSON.stringify({result_id:'older-format-result',context_hash:context.context_hash,content}));
    f.db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?)').run('older-format-result',JSON.stringify({status:'COMPLETED'}));
    assert.equal(f.learner.pendingRun(f.registry)?.id,f.prior);
    f.db.prepare("UPDATE ow_runs SET state='FAILED' WHERE id=?").run(f.prior);
    assert.equal(f.learner.pendingRun(f.registry),null);
    f.learner.registryContext=f.registry;
    assert.equal(f.learner.statusForRun(f.trigger).stage,'COMPLETE');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_cases').get().n,0);
  }finally{f.close();}
});

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
    assert.match(trigger.next_action,/provenance owner/,'Mock-only completion retains an explicit current qualification action');
    assert.equal(trigger.loop_stage,'QUALIFICATION_REQUIRED','Mock-only provenance cannot claim current completion');
    assert.equal(trigger.recorded_loop_stage,'PENDING_RESEARCH');
    await f.learner.flushOnce();
    assert.equal(f.continuations.length,2,'completed continuation must remain idempotent');
  }finally{f.close();}
});

test('G08 read-only run status separates preserved completion from current qualification and restores qualified positive support',()=>{
  const f=fixture();
  try {
    const content=JSON.stringify({conclusion_type:'NO_CHANGE',registry_record_sha256:f.registry.record_sha256,
      continuation:{case_id:'preserved-research-case'},next_action:'Keep current baseline.'});
    f.db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?)').run('preserved-result',f.trigger,
      JSON.stringify({result_id:'preserved-result',content}));
    f.db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?)').run('preserved-result',JSON.stringify({status:'COMPLETED'}));
    f.learner.registryContext=f.registry;
    let research={state:'COMPLETED',historical:true,qualified_for_new_support:false,analysis_version:'ocean-cumulative-research/v2',
      report:{outcome:'NO_SUPPORTED_CHANGE',next_action:'Keep current baseline.'},next_action:'Resolve current provenance; preserve the prior report.'};
    f.backend.operationalResearch={statusForCase:()=>research};
    const classify=f.learner.classification.bind(f.learner);
    let telemetry={verified:false,bypassed:false,required_action:'Resolve physical strategy binding and raw STTL2 identity conflict.'};
    // Explicit qualification fixture; no native replay or operational authority is represented.
    f.learner.classification=run=>({...classify(run),eligible:telemetry.verified,telemetry,
      reasons:telemetry.verified?[]:['PHYSICAL_STRATEGY_BINDING_CONFLICT','RAW_STTL2_IDENTITY_CONFLICT']});
    const snapshot=()=>objectHash(['ow_runs','ow_run_plans','ow_operational_brain_results','ow_operational_brain_callbacks']
      .map(table=>f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    const before=snapshot(),reportHash=objectHash(research);
    for(let i=0;i<2;i++) {
      const status=f.learner.statusForRun(f.trigger);
      assert.equal(status.stage,'COMPLETE','Recorded callback stays complete');
      assert.equal(status.current_provenance_qualified,false);
      assert.equal(status.loop_stage,'QUALIFICATION_REQUIRED');
      assert.equal(status.current_qualification_status,'QUALIFICATION_REQUIRED');
      assert.deepEqual(status.historical_result,{learning_stage:'COMPLETE',loop_stage:'COMPLETE',
        conclusion_type:'NO_CHANGE',research_outcome:'NO_SUPPORTED_CHANGE'});
      assert.match(status.next_action,/physical strategy binding and raw STTL2 identity conflict/);
      assert.doesNotMatch(status.next_action,/Keep current baseline/);
    }
    assert.equal(snapshot(),before);assert.equal(objectHash(research),reportHash);
    telemetry={verified:true,bypassed:false};
    assert.equal(f.learner.statusForRun(f.trigger).loop_stage,'QUALIFICATION_REQUIRED','Historical report is not new support even if physical proof is restored');
    research={...research,historical:false,qualified_for_new_support:true,analysis_version:'ocean-cumulative-research/v6',
      next_action:'Keep current baseline. Qualified direction screen found no supported change.'};
    const current=f.learner.statusForRun(f.trigger);
    assert.equal(current.loop_stage,'COMPLETE');assert.equal(current.current_qualification_status,'CURRENT');
    assert.equal(current.current_provenance_qualified,true);assert.equal(current.historical_result,null);
    assert.match(current.next_action,/Qualified direction screen/);
    f.backend.operationalResearch.statusForCase=()=>null;telemetry={verified:false,bypassed:false};
    assert.equal(f.learner.statusForRun(f.trigger).loop_stage,'QUALIFICATION_REQUIRED','A completed callback alone does not grant current support');
    assert.match(f.learner.statusForRun(f.trigger).next_action,/provenance owner/);
    assert.equal(snapshot(),before);
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

test('same coverage with a different strategy configuration retains accounting, not independent support',()=>{
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

test('prospective source summaries never promote floored dates or causal session proxies to the approved native session floor',()=>{
  const f=fixture();try {
    f.learner.legacyTelemetrySummary=()=>({trades:30,independent_sessions:100});
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger),classification=f.learner.classification(run);
    classification.telemetry={causal_summary:{trades:30,independent_sessions:100}};
    const summary=f.learner.runSummary(run,classification,{minimum_sample_count:2,minimum_independent_session_count:1});
    assert.equal(summary.summary.observed_sample_count,30);assert.equal(summary.summary.independent_session_count,0);
    assert.equal(summary.summary.evidence_status,'INSUFFICIENT');assert.equal(summary.native_session_evidence.verified,false);
    assert.match(summary.native_session_evidence.basis,/NO_CALENDAR_DATE_PROXY/);
    const bundle=f.learner.cohort(run);assert.equal(bundle.cohort.aggregate.independent_session_count,0);
    assert.equal(bundle.cohort.aggregate.evidence_status,'INSUFFICIENT');assert.equal(bundle.cohort.aggregate.confidence,0);
    bundle.diagnostics[0].telemetry={causal_summary:{trades:3,groups:[{direction:'LONG',trades:3,wins:1,losses:2,flat:0,averages:{net_profit_loss:-1}}]}};
    const proposal=JSON.parse(cumulativeLearningProposal(bundle).content);
    assert.equal(proposal.schema_version,'ocean-evidence-bound-learning-proposal/v3');assert.equal(proposal.cumulative_evidence.independent_sessions_verified,false);
    assert.equal(proposal.prospective_source_eligibility.aggregate_support_verified,false);
  }finally{f.close();}
});

test('source aggregate uses one observed session union, not per-run sums; overlap remains accounted and cannot be sufficient',()=>{
  const f=fixture();try {
    // Explicit mock-only native union, not a deployed telemetry source claim.
    f.learner.nativeSessionEvidence=ids=>({verified:true,observed_session_count:ids.length>1?2:2,
      missing_run_ids:[],conflicts:[],statistical_independence_verified:false,basis:'EXPLICIT_MOCK_ONLY_NATIVE_SESSION_UNION'});
    const trigger=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    let bundle=f.learner.cohort(trigger);
    assert.equal(bundle.cohort.eligible_runs.reduce((n,run)=>n+run.independent_session_count,0),4);
    assert.equal(bundle.cohort.aggregate.independent_session_count,2);assert.equal(bundle.cohort.aggregate.evidence_status,'SUFFICIENT');
    const overlap=f.addRun({id:'overlap-different-interval',pnl:[-500],coverage:[{start_utc:'2025-09-15T00:00:00Z',end_utc:'2025-10-15T00:00:00Z'}]});
    bundle=f.learner.cohort(f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(overlap));
    assert.equal(bundle.cohort.aggregate.observed_sample_count,4);assert.equal(bundle.cohort.aggregate.independent_session_count,0);
    assert.equal(bundle.cohort.aggregate.evidence_status,'INSUFFICIENT');assert.equal(bundle.native_session_evidence.coverage_overlaps.length,2);
    assert.ok(bundle.cohort.eligible_runs.some(run=>run.run_id===overlap));
    assert.ok(bundle.native_session_evidence.coverage_overlaps.every(item=>item.records_retained));
    assert.deepEqual(Object.keys(bundle.cohort.aggregate).sort(),['eligible_run_count','observed_sample_count','independent_session_count',
      'minimum_sample_count','minimum_independent_session_count','confidence','uncertainty','evidence_status','source_record_ids','aggregate_sha256'].sort());
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

test('STTL2 identity parser follows bounded decoded fields and fails closed on ambiguous input',()=>{
  const hash=digest('context');
  const raw=`Strategy |STTL2|run_id=run%3Bwith%3Dequals;dataset=manifest%3A3;context_hash=${encodeURIComponent(hash)};session=London+literal`;
  assert.deepEqual(parseSttl2Identity(raw),{run_id:'run;with=equals',dataset:'manifest:3',context_hash:hash,session:'London+literal'});
  for(const tag of [null,'Strategy |STTL1|run_id=r','Strategy |STTL2|',
    'Strategy |STTL2|run_id=a;run_id=b','Strategy |STTL2|run_id=%zz',
    'Strategy |STTL2|run_id=%0A','Strategy |STTL2|bogus=x',
    'Strategy |STTL2|run_id=a;context_hash=bad','Strategy |STTL2|run_id',
    `Strategy |STTL2|run_id=${'a'.repeat(257)}`,`Strategy |STTL2|run_id=${'a'.repeat(2049)}`]) {
    assert.equal(parseSttl2Identity(tag),null,`must reject ${String(tag).slice(0,80)}`);
  }
});

test('learning requires recorded DLL and raw STTL2 proof for both logical and mapped binding',()=>{
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
      ALTER TABLE ocean_run_lineage_v1 ADD COLUMN candidate_id TEXT;
      ALTER TABLE ocean_run_lineage_v1 ADD COLUMN session_name TEXT DEFAULT 'All';
      ALTER TABLE ocean_run_lineage_v1 ADD COLUMN session_timezone TEXT DEFAULT 'Europe/London';
      CREATE TABLE replay_runs(run_id TEXT,instance_id TEXT,strategy_id TEXT,strategy_version TEXT,dll_hash TEXT);
      CREATE TABLE sierra_instance(instance_id TEXT,instance_role TEXT,sierra_exe_path TEXT);
      CREATE TABLE trades(trade_id INTEGER,run_id TEXT,instance_id TEXT,trade_account TEXT,symbol TEXT,strategy_id TEXT,strategy_version TEXT,dll_hash TEXT,status TEXT,text_tag TEXT);
      CREATE TABLE trade_causal_context(trade_id INTEGER,run_id TEXT,instance_id TEXT,trade_account TEXT,symbol TEXT,
        strategy_id TEXT,strategy_version TEXT,strategy_profile_id TEXT,strategy_profile_version TEXT,
        strategy_code_hash TEXT,strategy_config_hash TEXT,context_hash TEXT,candidate_id TEXT,dataset_id TEXT,dataset_role TEXT,raw_text_tag TEXT,
        session_name TEXT DEFAULT 'London',session_timezone TEXT DEFAULT 'Europe/London');
    `);
    const run=f.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(f.trigger);
    const context=JSON.parse(run.context_json);
    telemetry.prepare('INSERT INTO ocean_run_lineage_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      f.trigger,strategyId,context.strategy_version,context.context_hash,`${context.dataset_manifest_id}:${context.dataset_manifest_revision}`,context.dataset_partition,
      context.strategy_profile_id,context.strategy_profile_version,context.strategy_code_hash,context.strategy_config_hash,'closed','complete',0,2,2,0,1,1,1,
      'TELEMETRY_COMPLETE_COVERAGE_UNVERIFIED','2025-11-01T00:00:00Z','2025-11-01T00:00:00Z','candidate','All','Europe/London');
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
    assert.ok(f.learner.classification(run).reasons.includes('PHYSICAL_STRATEGY_BINDING_REQUIRED'),'logical exact cannot bypass physical proof');
    const moduleFile=path.join(f.root,'approved-strategy.dll');
    fs.writeFileSync(moduleFile,'explicit mock strategy module');
    const moduleHash=digest(fs.readFileSync(moduleFile));
    const physicalBindingFile=path.join(f.root,'replay-run-bridge.json');
    const writeBinding=version=>fs.writeFileSync(physicalBindingFile,JSON.stringify({
      schema_version:'ocean-replay-run-bridge/v4',strategy_id:strategyId,instance_id:instanceId,
      expected_strategy_version:version,factual_binding_hash:digest('factual-binding'),
      expected_strategy_module_path:moduleFile,expected_strategy_module_sha256:moduleHash,
      expected_sierra_exe:path.join(f.root,'SierraChart_64.exe'),
      managed_candidate_id:'candidate',expected_session_name:'All',expected_session_timezone:'Europe/London',
    }));
    writeBinding(context.strategy_version);
    f.learner.physicalBindingFile=physicalBindingFile;
    const rawFields={setup_family:'vwap_pullback_long',setup_instance:'mock-setup',run_id:f.trigger,strategy_id:strategyId,
      strategy_v:context.strategy_version,profile:context.strategy_profile_id,profile_v:context.strategy_profile_version,
      code_hash:context.strategy_code_hash,config_hash:context.strategy_config_hash,context_hash:context.context_hash,
      candidate:'candidate',dataset:`${context.dataset_manifest_id}:${context.dataset_manifest_revision}`,dataset_role:context.dataset_partition,
      session:'London',tz:'Europe/London'};
    const encodeTag=fields=>`Mock strategy |STTL2|${Object.entries(fields).map(([key,value])=>`${key}=${encodeURIComponent(value)}`).join(';')}`;
    const tag=encodeTag(rawFields);
    telemetry.prepare('INSERT INTO replay_runs VALUES(?,?,?,?,?)').run(f.trigger,instanceId,strategyId,context.strategy_version,moduleHash.slice(7).toUpperCase());
    telemetry.prepare('INSERT INTO sierra_instance VALUES(?,?,?)').run(instanceId,'replay',path.join(f.root,'SierraChart_64.exe'));
    telemetry.prepare('INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?)').run(1,f.trigger,instanceId,'Sim1','NQ',strategyId,context.strategy_version,moduleHash,'closed',tag);
    telemetry.prepare('INSERT INTO trade_causal_context VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1,f.trigger,instanceId,'Sim1','NQ',
      strategyId,context.strategy_version,context.strategy_profile_id,context.strategy_profile_version,
      context.strategy_code_hash,context.strategy_config_hash,context.context_hash,'candidate',rawFields.dataset,context.dataset_partition,tag,'London','Europe/London');
    const accepted=f.learner.classification(run);
    assert.equal(accepted.eligible,true,accepted.reasons.join(','));
    assert.equal(accepted.telemetry.contract,'telemetry-causal-export/v4');
    assert.equal(accepted.telemetry.physical_strategy_binding.kind,'LOGICAL_VERSION_EXACT');
    assert.equal(accepted.telemetry.raw_identity_qualification.verified,true);
    assert.equal(accepted.telemetry.physical_strategy_binding.independent_historical_execution_attestation,false);
    const physicalInstance='mock-sierra-recorded-instance';
    telemetry.prepare('UPDATE replay_runs SET instance_id=?').run(physicalInstance);
    telemetry.prepare('UPDATE trades SET instance_id=?').run(physicalInstance);
    telemetry.prepare('UPDATE trade_causal_context SET instance_id=?').run(physicalInstance);
    telemetry.prepare('UPDATE sierra_instance SET instance_id=?').run(physicalInstance);
    assert.equal(f.learner.classification(run).eligible,true,'logical Ocean and recorded Sierra IDs need not be equal');
    telemetry.prepare('UPDATE trades SET instance_id=?').run('wrong-sierra-instance');
    assert.ok(f.learner.classification(run).reasons.includes('RECORDED_STRATEGY_PROVENANCE_SCOPE_CONFLICT'));
    telemetry.prepare('UPDATE replay_runs SET instance_id=?').run(instanceId);
    telemetry.prepare('UPDATE trades SET instance_id=?').run(instanceId);
    telemetry.prepare('UPDATE trade_causal_context SET instance_id=?').run(instanceId);
    telemetry.prepare('UPDATE sierra_instance SET instance_id=?').run(instanceId);
    fs.writeFileSync(moduleFile,'changed mock strategy module');
    assert.ok(f.learner.classification(run).reasons.includes('APPROVED_STRATEGY_MODULE_HASH_CONFLICT'));
    fs.writeFileSync(moduleFile,'explicit mock strategy module');
    assert.equal(accepted.telemetry.causal_summary.groups[0].setup_family,'vwap_pullback_long');
    assert.equal(accepted.telemetry.causal_summary.groups[0].averages.net_profit_loss,125);
    assert.match(accepted.telemetry.completion_binding.receipt_sha256,/^sha256:[a-f0-9]{64}$/);
    for(const [table,field,value,reason] of [
      ['replay_runs','dll_hash',null,'RECORDED_STRATEGY_DLL_PROVENANCE_REQUIRED'],
      ['trades','dll_hash','not-a-hash','RECORDED_STRATEGY_DLL_PROVENANCE_REQUIRED'],
      ['replay_runs','dll_hash',digest('generic DLL'),'RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT'],
      ['trades','dll_hash',digest('generic DLL'),'RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT'],
      ['trades','trade_account','Sim2','RECORDED_STRATEGY_PROVENANCE_SCOPE_CONFLICT'],
    ]) {
      telemetry.prepare(`UPDATE ${table} SET ${field}=?`).run(value);
      const rejected=f.learner.classification(run);
      assert.ok(rejected.reasons.includes(reason),rejected.reasons.join(','));
      assert.equal(rejected.telemetry.causal_summary.trades,1,'excluded context keeps executed accounting');
      assert.match(rejected.telemetry.required_action,/provenance owner/);
      telemetry.prepare(`UPDATE ${table} SET ${field}=?`).run(field==='dll_hash'?moduleHash:'Sim1');
    }
    for(const [key,value] of [['context_hash',digest('October context')],['dataset','manifest:2'],['run_id','other-run'],['code_hash',digest('other-code')],['profile','other-profile'],['session','Asia'],['tz','UTC'],['candidate','other-candidate'],['config_hash',digest('other-config')]]) {
      telemetry.prepare('UPDATE trade_causal_context SET raw_text_tag=?').run(encodeTag({...rawFields,[key]:value}));
      const rejected=f.learner.classification(run);
      assert.ok(rejected.reasons.includes('RAW_STTL2_IDENTITY_CONFLICT'));
      assert.ok(rejected.telemetry.raw_identity_qualification.discrepancies[0].fields.includes(key));
      assert.equal(rejected.telemetry.causal_summary.trades,1);
    }
    telemetry.prepare('UPDATE trade_causal_context SET raw_text_tag=?').run(tag);
    telemetry.prepare('UPDATE trade_causal_context SET raw_text_tag=NULL').run();
    assert.ok(f.learner.classification(run).reasons.includes('RAW_STTL2_IDENTITY_CONFLICT'));
    telemetry.prepare('UPDATE trade_causal_context SET raw_text_tag=?').run(tag);
    // Retain a bad historical run as context, without contributing to support.
    const badId=f.addRun({id:'bad-old-metadata',pnl:[125]});
    const badContext=JSON.parse(f.db.prepare('SELECT context_json FROM ow_runs WHERE id=?').get(badId).context_json);
    telemetry.prepare(`INSERT INTO ocean_run_lineage_v1 SELECT ?,strategy_id,strategy_version,?,dataset_id,dataset_role,
      strategy_profile_id,strategy_profile_version,strategy_code_hash,strategy_config_hash,run_lifecycle_status,run_context_status,
      open_trade_count,attempt_count,attempt_receipt_count,partial_receipt_count,closed_trade_count,causal_row_count,
      complete_causal_row_count,telemetry_qualification_status,created_utc,updated_utc,candidate_id,session_name,session_timezone FROM ocean_run_lineage_v1 WHERE run_id=?`).run(badId,badContext.context_hash,f.trigger);
    telemetry.prepare(`INSERT INTO ocean_trade_causal_v2 SELECT 2,entry_datetime,?,direction,status,net_profit_loss,exit_causality,
      context_status,quality_flags,setup_family,session_name,regime_label,volatility_label,vwap_distance_points,initial_risk_points,
      continuation_state,exhaustion_state,exhaustion_score,quality_scaler_distance_atr,price_change_60m,price_change_120m,
      vwap_slope_60m,atr_change_60m_pct,mfe_points,mae_points,gross_currency_value,total_commission FROM ocean_trade_causal_v2 WHERE run_id=?`).run(badId,f.trigger);
    telemetry.prepare('INSERT INTO replay_runs VALUES(?,?,?,?,?)').run(badId,instanceId,strategyId,context.strategy_version,digest('generic DLL'));
    const badTag=encodeTag({...rawFields,run_id:badId,context_hash:digest('October context'),dataset:'manifest:2'});
    telemetry.prepare('INSERT INTO trades VALUES(?,?,?,?,?,?,?,?,?,?)').run(2,badId,instanceId,'Sim1','NQ',strategyId,context.strategy_version,digest('generic DLL'),'closed',badTag);
    telemetry.prepare('INSERT INTO trade_causal_context VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(2,badId,instanceId,'Sim1','NQ',strategyId,
      context.strategy_version,context.strategy_profile_id,context.strategy_profile_version,context.strategy_code_hash,
      context.strategy_config_hash,badContext.context_hash,'candidate',rawFields.dataset,context.dataset_partition,
      badTag,'London','Europe/London');
    const badReceipt=JSON.parse(fs.readFileSync(path.join(completionRoot,`${f.trigger}-completion.json`),'utf8'));
    fs.writeFileSync(path.join(completionRoot,`${badId}-completion.json`),JSON.stringify({...badReceipt,run_id:badId}));
    const bundle=f.learner.cohort(run);
    assert.deepEqual(bundle.cohort.eligible_runs.map(item=>item.run_id),[f.trigger]);
    assert.equal(bundle.cohort.aggregate.observed_sample_count,1);
    const excluded=bundle.excluded_evidence.find(item=>item.run_id===badId);
    assert.equal(excluded.observed_sample_count,1);
    assert.match(excluded.exclusion_reason,/RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT.*RAW_STTL2_IDENTITY_CONFLICT/);
    assert.equal(bundle.diagnostics.find(item=>item.run_id===badId).telemetry.causal_summary.trades,1);
    // The following mapping/attempt regressions operate only on the trigger fixture.
    telemetry.prepare('DELETE FROM ocean_run_lineage_v1 WHERE run_id=?').run(badId);
    telemetry.prepare('DELETE FROM ocean_trade_causal_v2 WHERE run_id=?').run(badId);
    telemetry.prepare('DELETE FROM replay_runs WHERE run_id=?').run(badId);
    telemetry.prepare('DELETE FROM trades WHERE run_id=?').run(badId);
    telemetry.prepare('DELETE FROM trade_causal_context WHERE run_id=?').run(badId);
    writeBinding('v0.6.237');
    telemetry.prepare("UPDATE ocean_run_lineage_v1 SET strategy_version='v0.6.237'").run();
    telemetry.prepare("UPDATE replay_runs SET strategy_version='v0.6.237'").run();
    telemetry.prepare("UPDATE trades SET strategy_version='v0.6.237'").run();
    telemetry.prepare("UPDATE trade_causal_context SET strategy_version='v0.6.237',raw_text_tag=?").run(encodeTag({...rawFields,strategy_v:'v0.6.237'}));
    telemetry.prepare('UPDATE trades SET text_tag=?').run(encodeTag({...rawFields,strategy_v:'v0.6.237'}));
    const mapped=f.learner.classification(run);
    assert.equal(mapped.eligible,true,mapped.reasons.join(','));
    assert.equal(mapped.telemetry.physical_strategy_binding.kind,'APPROVED_LOGICAL_TO_PHYSICAL');
    telemetry.prepare('UPDATE trades SET dll_hash=?').run(digest('generic DLL'));
    assert.ok(f.learner.classification(run).reasons.includes('RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT'),'mapped branch also requires recorded DLL proof');
    telemetry.prepare('UPDATE trades SET dll_hash=?').run(moduleHash);
    writeBinding('v0.6.238');
    const mappingRejected=f.learner.classification(run);
    assert.equal(mappingRejected.eligible,false);
    assert.ok(mappingRejected.reasons.includes('PHYSICAL_STRATEGY_BINDING_CONFLICT'));
    writeBinding('v0.6.237');
    const logicalProfile='cicd-vwap-pull-back-strategy.profile-v0.1.0-source-bound';
    const physicalProfile='nasdaq_v0608_us_trendup_weak_distance_qty1_replay_status_preserve_risk1100_qty5_candidate';
    const physicalVersion='v0.6.237-managed-lineage-candidate';
    const approvedCode='sha256:8b26b689b013f1473304a1fdde4bcf265ddbfd4cf05e58e11a97e9f777ed7909';
    const approvedConfig='sha256:21968c73dbff8646ff15bfffafaa0d85e4e8db5b8273f5b0a88eec001942af4d';
    const setProfile=({profile=physicalProfile,version=physicalVersion,code=approvedCode,config=approvedConfig,profileVersion='v0.1.3'}={})=>{
      telemetry.prepare('UPDATE ocean_run_lineage_v1 SET strategy_profile_id=?,strategy_profile_version=?,strategy_code_hash=?,strategy_config_hash=?')
        .run(logicalProfile,profileVersion,code,config);
      const physicalTag=encodeTag({...rawFields,strategy_v:version,profile,profile_v:version,code_hash:code,config_hash:config});
      telemetry.prepare('UPDATE trades SET strategy_version=?,text_tag=?').run(version,physicalTag);
      telemetry.prepare('UPDATE trade_causal_context SET strategy_version=?,strategy_profile_id=?,strategy_profile_version=?,strategy_code_hash=?,strategy_config_hash=?,raw_text_tag=?')
        .run(version,profile,version,code,config,physicalTag);
      return {...run,context_json:JSON.stringify({...context,strategy_version:'v0.1.1',strategy_profile_id:logicalProfile,
        strategy_profile_version:profileVersion,strategy_code_hash:code,strategy_config_hash:config})};
    };
    const profileRun=setProfile();
    const approvedProfile=f.learner.classification(profileRun);
    assert.equal(approvedProfile.eligible,true,approvedProfile.reasons.join(','));
    assert.equal(approvedProfile.telemetry.raw_identity_qualification.approved_profile_mapping.rule,'FROZEN_V013_PROFILE6_EXACT_LOGICAL_PINS');
    assert.deepEqual(approvedProfile.telemetry.raw_identity_qualification.approved_profile_mapping.trade_ids,[1]);
    telemetry.prepare('UPDATE trade_causal_context SET strategy_profile_id=?,strategy_profile_version=?').run(logicalProfile,'v0.1.3');
    assert.equal(f.learner.classification(profileRun).eligible,true,'explicit approved logical normalization is also accepted');
    for(const variant of [{profile:'nasdaq_v0449_hmm_risk1000_qty5_control'},{profile:'unapproved-physical-profile'},
      {profile:`${physicalProfile}-alias`},{code:digest('different-code')},{config:digest('different-config')},
      {profileVersion:'v0.1.2'},{version:'v0.6.238-managed-lineage-candidate'}]) {
      const rejected=f.learner.classification(setProfile(variant));
      assert.equal(rejected.eligible,false,JSON.stringify(variant));
      assert.ok(rejected.reasons.includes('RAW_STTL2_IDENTITY_CONFLICT'),JSON.stringify(variant));
      assert.deepEqual(rejected.telemetry.raw_identity_qualification.approved_profile_mapping.trade_ids,[]);
    }
    assert.equal(f.learner.classification(setProfile()).eligible,true,'restoring exact approved pins qualifies the fixture again');
    // TEST-only telemetry fixture: validate new raw mapping separately from the
    // physical module gate. The mock binary must never attest the reviewed build.
    const successor=REVIEWED_V238_PROFILE6;
    writeBinding(successor.strategy_version);
    telemetry.prepare('UPDATE ocean_run_lineage_v1 SET strategy_version=?,candidate_id=?')
      .run(successor.strategy_version,successor.candidate_id);
    telemetry.prepare('UPDATE replay_runs SET strategy_version=?').run(successor.strategy_version);
    rawFields.candidate=successor.candidate_id;
    const successorRun=setProfile({version:successor.raw_version});
    telemetry.prepare('UPDATE trade_causal_context SET candidate_id=?').run(successor.candidate_id);
    const successorBinding=JSON.parse(fs.readFileSync(physicalBindingFile,'utf8'));
    successorBinding.managed_candidate_id=successor.candidate_id;
    fs.writeFileSync(physicalBindingFile,JSON.stringify(successorBinding));
    const successorResult=f.learner.classification(successorRun);
    assert.equal(successorResult.telemetry.raw_identity_qualification.verified,true);
    assert.ok(successorResult.reasons.includes('REVIEWED_PHYSICAL_SUCCESSOR_MAPPING_CONFLICT'));
    assert.equal(successorResult.eligible,false,'mock hash cannot qualify a real reviewed v238 release');
    successorBinding.expected_strategy_module_sha256=successor.module_sha256;
    fs.writeFileSync(physicalBindingFile,JSON.stringify(successorBinding));
    assert.ok(f.learner.classification(successorRun).reasons.includes('APPROVED_STRATEGY_MODULE_HASH_CONFLICT'),
      'reviewed hash in config cannot replace actual module bytes');
    for (const version of ['v0.6.238-managed-lineage-candidate',physicalVersion]) {
      assert.equal(f.learner.classification(setProfile({version})).telemetry.raw_identity_qualification.verified,false);
    }
    assert.equal(f.learner.classification(setProfile({version:successor.raw_version,profile:'nasdaq_v0449_hmm_risk1000_qty5_control'}))
      .telemetry.raw_identity_qualification.verified,false,'Profile3 cannot stand in for frozen Profile6');
    writeBinding('v0.6.237');
    telemetry.prepare("UPDATE ocean_run_lineage_v1 SET strategy_version='v0.6.237',candidate_id='candidate'").run();
    telemetry.prepare("UPDATE replay_runs SET strategy_version='v0.6.237'").run();
    rawFields.candidate='candidate';
    telemetry.prepare("UPDATE trade_causal_context SET candidate_id='candidate'").run();
    assert.equal(f.learner.classification(setProfile()).eligible,true,'v237 mapping is preserved, not replaced');
    telemetry.prepare('UPDATE ocean_run_lineage_v1 SET strategy_profile_id=?,strategy_profile_version=?,strategy_code_hash=?,strategy_config_hash=?')
      .run(context.strategy_profile_id,context.strategy_profile_version,context.strategy_code_hash,context.strategy_config_hash);
    const mappedTag=encodeTag({...rawFields,strategy_v:'v0.6.237'});
    telemetry.prepare('UPDATE trades SET strategy_version=?,text_tag=?').run('v0.6.237',mappedTag);
    telemetry.prepare('UPDATE trade_causal_context SET strategy_version=?,strategy_profile_id=?,strategy_profile_version=?,strategy_code_hash=?,strategy_config_hash=?,raw_text_tag=?')
      .run('v0.6.237',context.strategy_profile_id,context.strategy_profile_version,context.strategy_code_hash,context.strategy_config_hash,mappedTag);
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
