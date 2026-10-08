import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './store.mjs';
import { WorkflowBackend } from './backend.mjs';
import { RunManager } from './run-manager.mjs';
import { digest, objectHash, sealedHash } from './common.mjs';
import { decodeRunnerFields, readAttemptFailure } from './operational-attempt-failure.mjs';

const examples=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url),'utf8'));
const schema=execFileSync('git',['show','b1fb6e642d6a40cb9dac1c295895c2c48d28b2f4:src/sierra_trade_telemetry/schema.sql'],
  {cwd:'D:/Trading/CICD/worktrees/telemetry-s30-2',windowsHide:true});
assert.equal(digest(schema),'sha256:ca4bee67d0e3ba6237e70891ed0cb3475f89d4744438fdf5bf3ab87baec428ef');

// Disposable mock-only authority and native rows. The SQL schema is the exact
// reviewed producer contract; these fixtures are not deployed/native evidence.
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-attempt-failure-mock-'));
  const store=new WorkflowStore(path.join(root,'workflow.sqlite')),db=store.db;
  const telemetryFile=path.join(root,'telemetry.sqlite'),sql=new DatabaseSync(telemetryFile);sql.exec(schema.toString());
  t.after(()=>{sql.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const context={...structuredClone(examples['run-context']),run_id:'mock-failed-u',strategy_id:'mock-vwap',
    execution_instance_id:'mock-replay',expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',
    dataset_partition:'DISCOVERY',learner_permission:'HISTORICAL_DISCOVERY',case_id:null,experiment_id:null,candidate_id:null,
    observed_source_state:{observed_at_utc:'2026-10-08T14:00:00Z',environment:'UNKNOWN',simulation:null,replay:null,
      account_alias:null,source_schema_version:null,quality:'UNKNOWN'}};
  context.context_hash=sealedHash(context,'context_hash');
  const instance={execution_instance_id:context.execution_instance_id,strategy_id:context.strategy_id,
    telemetry_producer_id:'mock-producer',account_alias:'Sim1'};
  const bindingHash=digest('EXPLICIT_MOCK_FACTUAL_BINDING'),requested={start_utc:'2025-08-31T23:00:00.000Z',end_utc:'2025-09-12T23:00:00.000Z'};
  const profile=structuredClone(examples['strategy-profile']),profileKey=`${context.strategy_profile_id}:${context.strategy_profile_version}`;
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(profileKey,context.strategy_id,context.strategy_profile_version,digest('mock-profile'),JSON.stringify(profile));
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(context.strategy_id,profileKey,1,context.strategy_code_hash,JSON.stringify({strategy_id:context.strategy_id}));
  db.prepare('INSERT INTO ow_identities(id,role,metadata_json) VALUES(?,?,?)').run(instance.telemetry_producer_id,'TELEMETRY','{"mock_only":true}');
  const plan={context_hash:context.context_hash,reprocess_of_run_id:'mock-original-completed-u',
    selection:{interval:requested},operational_review:{factual_binding_hash:bindingHash,manifest_key:'mock-manifest',partition_index:0,interval:requested,context}};
  plan.plan_hash=sealedHash(plan,'plan_hash');
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(context.execution_instance_id,context.strategy_id,JSON.stringify(instance));
  db.prepare("INSERT INTO ow_runs VALUES(?,?,?,2,'ACTIVE',?)").run(context.run_id,context.strategy_id,context.execution_instance_id,JSON.stringify(context));
  db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(context.run_id,digest('mock-coverage'),JSON.stringify(plan));
  const manifest={source_id:'mock-source',source_revision:1,manifest_hash:context.dataset_manifest_hash,
    partitions:[{symbol:'MNQU25_FUT_CME'}]};
  db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run('mock-manifest',context.strategy_id,1,manifest.manifest_hash,'OPERATIONAL_MANIFEST',JSON.stringify(manifest));
  const config={schema_version:'ocean-replay-run-bridge/v4',namespace:'OPERATIONAL',workflow_db:store.filename || path.join(root,'workflow.sqlite'),
    telemetry_db:telemetryFile,strategy_id:context.strategy_id,instance_id:context.execution_instance_id,factual_binding_hash:bindingHash,
    source_preflight_status_path:path.join(root,'vwap-replay-status.txt'),account_alias:'Sim1',expected_symbol:'MNQU25_FUT_CME',
    expected_chart_number:1,expected_sierra_exe:path.join(root,'SierraChart_64.exe'),expected_chartbook_path:path.join(root,'Data','mock.cht'),
    expected_strategy_version:'v0.6.237',expected_strategy_module_sha256:digest('mock-strategy-dll'),managed_candidate_id:'mock-managed',
    expected_session_name:'All',expected_session_timezone:'Europe/London'};
  const start={commandId:'mock-attempt3-start',action:'start',tradeAccount:'Sim1',expectedSymbol:config.expected_symbol,
    telemetryRunId:context.run_id,telemetryStrategyId:context.strategy_id,telemetryStrategyVersion:config.expected_strategy_version,
    telemetryDllSha256:config.expected_strategy_module_sha256.slice(7),telemetryCandidateId:config.managed_candidate_id,
    telemetryStrategyCodeHash:context.strategy_code_hash,telemetryStrategyConfigHash:context.strategy_config_hash,
    telemetryContextHash:context.context_hash,telemetryDatasetId:`${context.dataset_manifest_id}:${context.dataset_manifest_revision}`,
    telemetryDatasetRole:context.dataset_partition,telemetryStrategyProfileId:context.strategy_profile_id,
    telemetryStrategyProfileVersion:context.strategy_profile_version,telemetrySessionName:'All',telemetrySessionTimezone:'Europe/London'};
  const encode=value=>Buffer.from(Object.entries(value).map(([key,v])=>`${key}=${v}`).join('\n')+'\n');
  const startBytes=encode(start),badStatus=encode({commandId:'auto-stop',status:'stop_requested'});
  const failure={run_id:context.run_id,reason:'managed_completion_identity_failure',observed_at_utc:'2026-10-08T16:52:11.572Z',
    controller_receipt:{schema:'ocean-trading.sierra-replay-controller.status.v1',action:'stop',isReplayRunning:false,
      replayStatus:0,chartReplayStatus:0,chartNumber:1,chartbookPath:config.expected_chartbook_path,instanceDataFolder:path.join(root,'Data')},
    hook_failure_evidence:{reason:'managed_completion_identity_failure',command_bytes_base64:startBytes.toString('base64'),
      command_sha256:digest(startBytes).slice(7),status_bytes_base64:badStatus.toString('base64'),status_sha256:digest(badStatus).slice(7)}};
  const failureFile=path.join(root,'managed-failure-stop.json'),configFile=path.join(root,'bridge.json');
  fs.writeFileSync(failureFile,JSON.stringify(failure));fs.writeFileSync(configFile,JSON.stringify(config));
  fs.writeFileSync(config.source_preflight_status_path,encode({commandId:'mock-attempt3-failed-start-stop',action:'stop',status:'stopped',
    isReplayRunning:false,replayStatus:0,controllerLifecycleActive:false,chartNumber:1,symbol:config.expected_symbol}));
  const insert=(table,row)=>{const keys=Object.keys(row);sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
  const physical='mock-physical';
  insert('sierra_instance',{instance_id:physical,instance_name:'mock',instance_role:'replay',sierra_exe_path:config.expected_sierra_exe,
    sierra_data_path:path.join(root,'Data'),database_path:telemetryFile});
  insert('replay_runs',{run_id:context.run_id,instance_id:physical,instance_name:'mock',instance_role:'replay',
    run_started_utc:'2026-10-08T14:08:08Z',run_ended_utc:'2026-10-08 16:52:11',strategy_id:context.strategy_id,
    strategy_version:config.expected_strategy_version,chartbook:config.expected_chartbook_path,chart_number:1,dll_hash:start.telemetryDllSha256});
  insert('replay_run_context',{run_id:context.run_id,candidate_id:config.managed_candidate_id,dataset_id:start.telemetryDatasetId,
    dataset_role:context.dataset_partition,strategy_profile_id:context.strategy_profile_id,strategy_profile_version:context.strategy_profile_version,
    strategy_code_hash:context.strategy_code_hash,strategy_config_hash:context.strategy_config_hash,context_hash:context.context_hash,
    session_name:'All',session_timezone:'Europe/London'});
  const attempt={attempt_id:25,run_id:context.run_id,attempt_number:3,attempt_started_utc:'2026-10-08T14:08:08Z',
    attempt_ended_utc:'2026-10-08 16:52:11',start_command_id:start.commandId,stop_command_id:'mock-attempt3-failed-start-stop',starting_trade_id:969,starting_fill_id:1937};
  insert('replay_run_attempts',attempt);
  insert('telemetry_run_receipts',{receipt_id:25,run_id:context.run_id,attempt_id:25,instance_id:physical,instance_name:'mock',
    trade_account:'Sim1',strategy_id:context.strategy_id,strategy_version:config.expected_strategy_version,
    observation_started_utc:attempt.attempt_started_utc,observation_ended_utc:attempt.attempt_ended_utc,
    trade_count:1,closed_trade_count:1,fill_count:2,receipt_kind:'trades_observed',data_quality_flags:null});
  insert('trades',{trade_id:970,run_id:context.run_id,instance_id:physical,instance_name:'mock',instance_role:'replay',
    environment:'replay',trade_account:'Sim1',symbol:config.expected_symbol,is_simulated:1,strategy_id:context.strategy_id,
    direction:'long',status:'closed',final_quantity:0});
  for(const fillId of [1938,1939])insert('fills',{fill_id:fillId,run_id:context.run_id,instance_id:physical,instance_name:'mock',
    trade_account:'Sim1',account_type_guess:'sim',symbol:config.expected_symbol,is_simulated:1,
    internal_order_id:fillId,side:fillId===1938?'buy':'sell',quantity:5,fill_price:22000});
  const b=Object.create(WorkflowBackend.prototype);Object.assign(b,{db,store,environment:{},config:{python_executable:process.env.OCEAN_TRADING_PYTHON || 'python',
    operational_factual_bindings:[{binding_hash:bindingHash,instance}]},operationalLearning:{physicalBindingFile:configFile}});
  b.runs=new RunManager(b);
  const actor={id:instance.telemetry_producer_id,role:'TELEMETRY',namespace:'OPERATIONAL',scopes:['read','event.write'],
    strategyIds:[context.strategy_id],instanceIds:[context.execution_instance_id]};
  const read=()=>readAttemptFailure(config,{run:b.one('ow_runs',context.run_id),context,plan:{...plan,instance,symbol:config.expected_symbol}});
  const end=(lease,patch={})=>b.runs.perform('end',actor,{run_id:context.run_id,expected_revision:b.one('ow_runs',context.run_id).revision,
    outcome:'FAILED',lease_id:lease.lease_id,failure_proof_hash:read().proof_hash,...patch});
  return {root,b,actor,context,config,plan,sql,db,read,end,failure,failureFile,configFile};
}

test('actual schema terminal failure retains observations and grants no full coverage',t=>{
  const f=fixture(t),before=digest(fs.readFileSync(f.config.telemetry_db)),proof=f.read();
  assert.equal(proof.logger_attempt.attempt_id,25);assert.equal(proof.retained_trade_count,1);assert.equal(proof.retained_fill_count,2);
  assert.equal(proof.full_requested_coverage_verified,false);assert.equal(digest(fs.readFileSync(f.config.telemetry_db)),before);
  assert.equal(f.b.runs.read(f.actor,f.context.run_id).execution.status,'FAILED_STOP_VERIFIED');
  const lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});
  assert.equal(f.end(lease).state,'COMPLETING');
  const done=f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease.lease_id,expected_revision:3});
  assert.equal(done.state,'FAILED');assert.equal(done.completion.status,'FAILED');assert.deepEqual(done.completion.observed_coverage,[]);
  assert.equal(done.completion.unique_canonical_trade_count,0);assert.equal(done.completion.no_trade_interval_count,0);
  assert.equal(done.lease,null);assert.equal(done.execution.retained_trade_count,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ow_runs WHERE instance_id=? AND state IN ('READY','ACTIVE','COMPLETING')").get(f.context.execution_instance_id).n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ow_coverage_receipts WHERE status='COMPLETED'").get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM trades').get().n,1);
  assert.equal(done.execution.reconciliation_status,'RECONCILED');
  assert.ok(done.execution.next_action.startsWith('Reserve fresh exact coverage'));
});

test('sealed failed read and duplicate end/finish survive website restart and future physical pins without ledger mutation',t=>{
  const f=fixture(t),proof=f.read(),lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});
  assert.equal(f.b.runs.read(f.actor,f.context.run_id).execution.reconciliation_status,'PENDING');
  f.end(lease);
  f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease.lease_id,expected_revision:3});
  const ledger=digest(fs.readFileSync(f.config.workflow_db));
  fs.unlinkSync(f.failureFile);
  fs.writeFileSync(f.configFile,JSON.stringify({...f.config,expected_strategy_version:'mock-future-version',
    expected_strategy_module_sha256:digest('mock-future-dll'),factual_binding_hash:digest('mock-future-facts')}));
  f.b.runs=new RunManager(f.b);
  const history=f.b.runs.read(f.actor,f.context.run_id);
  assert.equal(history.execution.proof_hash,proof.proof_hash);assert.equal(history.execution.reconciliation_status,'RECONCILED');
  assert.ok(!history.execution.next_action.includes('Reconcile'));
  assert.equal(f.b.runs.perform('end',f.actor,{run_id:f.context.run_id,expected_revision:2,outcome:'FAILED',
    failure_proof_hash:proof.proof_hash,lease_id:lease.lease_id}).state,'FAILED');
  assert.equal(f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,expected_revision:3,lease_id:lease.lease_id}).state,'FAILED');
  assert.equal(digest(fs.readFileSync(f.config.workflow_db)),ledger);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_coverage_receipts').get().n,1);
});

test('two-lease restart drains frozen FAILED proof even after source file replacement; duplicate end is immutable',t=>{
  const f=fixture(t),proof=f.read(),lease1=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});
  f.end(lease1);const events=f.db.prepare('SELECT COUNT(*) n FROM ow_events').get().n;
  fs.writeFileSync(f.failureFile,'{}');f.b.runs=new RunManager(f.b);
  const input={run_id:f.context.run_id,expected_revision:2,outcome:'FAILED',failure_proof_hash:proof.proof_hash,lease_id:lease1.lease_id};
  assert.equal(f.b.runs.perform('end',f.actor,input).state,'COMPLETING');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events').get().n,events);
  assert.throws(()=>f.b.runs.perform('end',f.actor,{...input,failure_proof_hash:digest('wrong')}),/IMMUTABLE_FAILURE_PROOF_CONFLICT/);
  f.db.prepare('UPDATE ow_run_leases SET expires_ms=0').run();
  const lease2=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:3});
  assert.notEqual(lease1.lease_id,lease2.lease_id);
  assert.throws(()=>f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease1.lease_id,expected_revision:3}),/STALE_OR_FOREIGN_RUN_LEASE/);
  assert.equal(f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease2.lease_id,expected_revision:3}).state,'FAILED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_coverage_receipts').get().n,1);
});

test('failure end/finish are atomic on ledger event failure and can recover without phantom terminal receipts',t=>{
  const f=fixture(t),lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});
  const event=f.b.event.bind(f.b);f.b.event=()=>{throw Error('MOCK_EVENT_FAILURE');};
  assert.throws(()=>f.end(lease),/MOCK_EVENT_FAILURE/);
  assert.equal(f.b.one('ow_runs',f.context.run_id).state,'ACTIVE');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_run_progress').get().n,0);
  f.b.event=event;f.end(lease);f.b.event=()=>{throw Error('MOCK_EVENT_FAILURE');};
  const finish=()=>f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease.lease_id,expected_revision:3});
  assert.throws(finish,/MOCK_EVENT_FAILURE/);
  assert.equal(f.b.one('ow_runs',f.context.run_id).state,'COMPLETING');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_coverage_receipts').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_run_leases').get().n,1);
  f.b.event=event;assert.equal(finish().state,'FAILED');
});

test('a new logger attempt after frozen end blocks stale failure finalization',t=>{
  const f=fixture(t),lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});f.end(lease);
  f.sql.exec("INSERT INTO replay_run_attempts(run_id,attempt_number,attempt_started_utc,start_command_id) VALUES('mock-failed-u',4,'2026-10-08T17:00:00Z','new-start')");
  assert.throws(()=>f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease.lease_id,expected_revision:3}),/FAILURE_BOUNDARY_SUPERSEDED/);
  assert.equal(f.b.one('ow_runs',f.context.run_id).state,'COMPLETING');
});

for(const [name,mutation,code] of [
  ['missing end',"UPDATE replay_run_attempts SET attempt_ended_utc=NULL",'FAILURE_LATEST_LOGGER_STOP_ACK_REQUIRED'],
  ['wrong stop',"UPDATE replay_run_attempts SET stop_command_id='other-stop'",'FAILURE_LATEST_LOGGER_STOP_ACK_REQUIRED'],
  ['wrong start',"UPDATE replay_run_attempts SET start_command_id='earlier-start'",'FAILURE_LATEST_LOGGER_STOP_ACK_REQUIRED'],
  ['wrong context',"UPDATE replay_run_context SET context_hash='wrong'",'FAILURE_RECORDED_CONTEXT_CONFLICT'],
  ['missing receipt',"DELETE FROM telemetry_run_receipts",'FAILURE_TERMINAL_LOGGER_RECEIPT_REQUIRED'],
  ['wrong count',"UPDATE telemetry_run_receipts SET closed_trade_count=0",'FAILURE_TERMINAL_COUNTS_CONFLICT'],
  ['open position',"UPDATE trades SET final_quantity=1",'FAILURE_OPEN_OR_FOREIGN_OBSERVATIONS'],
  ['foreign physical instance',"UPDATE sierra_instance SET sierra_exe_path='D:/foreign/SierraChart_64.exe'",'FAILURE_RECORDED_PHYSICAL_SCOPE_CONFLICT'],
  ['wrong account',"UPDATE trades SET trade_account='Sim2'",'FAILURE_OPEN_OR_FOREIGN_OBSERVATIONS'],
])test(`null DQ alone cannot pass ${name}`,t=>{const f=fixture(t);f.sql.exec(mutation);assert.throws(f.read,new RegExp(code));});

test('latest unfinished attempt cannot be reconciled by an earlier valid failure',t=>{
  const f=fixture(t);f.sql.exec("INSERT INTO replay_run_attempts(run_id,attempt_number,attempt_started_utc,start_command_id) VALUES('mock-failed-u',4,'2026-10-08T17:00:00Z','new-start')");
  assert.throws(f.read,/FAILURE_LATEST_LOGGER_STOP_ACK_REQUIRED/);
});

test('retained bytes require exact hash and duplicate command fields are rejected',t=>{
  const f=fixture(t);f.failure.hook_failure_evidence.command_sha256='0'.repeat(64);fs.writeFileSync(f.failureFile,JSON.stringify(f.failure));
  assert.throws(f.read,/FAILURE_RAW_HASH_CONFLICT/);
  assert.throws(()=>decodeRunnerFields(Buffer.from('action=start\naction=stop\n')),/RUNNER_FIELD_DUPLICATE_OR_INVALID/);
});

test('missing failure artifact is not guessed from stopped logger or null DQ',t=>{
  const f=fixture(t);fs.unlinkSync(f.failureFile);assert.equal(f.read(),null);
  assert.equal(f.b.runs.read(f.actor,f.context.run_id).execution.status,'CURRENT_EXECUTION_UNVERIFIED');
});

test('foreign owner, TEST isolation, stale lease and pending workflow drain fail closed',t=>{
  const f=fixture(t),proof=f.read(),lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});
  const input={run_id:f.context.run_id,expected_revision:2,outcome:'FAILED',lease_id:lease.lease_id,failure_proof_hash:proof.proof_hash};
  assert.throws(()=>f.b.runs.perform('end',{...f.actor,id:'other'},input),/OBSERVED_PRODUCER_REQUIRED/);
  assert.throws(()=>f.b.runs.perform('end',{...f.actor,namespace:'TEST'},input),/OBSERVED_PRODUCER_REQUIRED/);
  assert.throws(()=>f.end({lease_id:'old'}),/STALE_OR_FOREIGN_RUN_LEASE/);
  f.db.prepare('INSERT INTO ow_run_progress(run_id,payload_json) VALUES(?,?)').run(f.context.run_id,JSON.stringify({pending_events:1}));
  assert.throws(()=>f.end(lease),/RUN_NOT_DRAINED/);assert.equal(f.b.one('ow_runs',f.context.run_id).state,'ACTIVE');
});

test('persistent CLI discovers failure before waiting for impossible completion artifacts',t=>{
  const f=fixture(t),script=new URL('./replay-run-evidence.mjs',import.meta.url);
  const run=()=>JSON.parse(execFileSync(process.execPath,[script.pathname.replace(/^\/(\w:)/,'$1'),f.configFile,'--failure-only'],{encoding:'utf8',windowsHide:true}));
  assert.equal(run().status,'TERMINAL_FAILURE_READY');
  const lease=f.b.runs.perform('claim',f.actor,{run_id:f.context.run_id,expected_revision:2});f.end(lease);
  fs.unlinkSync(f.failureFile);assert.equal(run().status,'TERMINAL_FAILURE_READY');
  f.b.runs.perform('finish',f.actor,{run_id:f.context.run_id,lease_id:lease.lease_id,expected_revision:3});
  assert.equal(run().status,'NO_TERMINAL_FAILURE');
});
