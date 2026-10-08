import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest, sealedHash } from './common.mjs';
import { RunManager } from './run-manager.mjs';
import { exportFixture } from './operational-research-export.test-fixtures.mjs';

// Explicit mock native rows/receipts in the exact reviewed v545 SQL schema.
// Real WorkflowStore, RunManager load/read/summary, auth and HTTP/UI projection;
// current governance and learning responses are labelled mocks. No native calls.
const schema=execFileSync('git',['show','b1fb6e642d6a40cb9dac1c295895c2c48d28b2f4:src/sierra_trade_telemetry/schema.sql'],
  {cwd:'D:/Trading/CICD/worktrees/telemetry-s30-2',windowsHide:true});
if(digest(schema)!=='sha256:ca4bee67d0e3ba6237e70891ed0cb3475f89d4744438fdf5bf3ab87baec428ef')throw Error('MOCK_SCHEMA_PIN_CHANGED');
const encode=value=>Object.entries(value).map(([key,v])=>`${key}=${v}\n`).join('');

export async function currentFixture() {
  const f=await exportFixture({large:false}),b=f.backend,db=b.db;
  const workflowDb=db.prepare('PRAGMA database_list').get().file,root=path.dirname(workflowDb);
  const runId='mock-current-u25',instance={execution_instance_id:'i',strategy_id:'s',account_alias:'Sim1',telemetry_producer_id:'strategy'};
  const config={schema_version:'ocean-replay-run-bridge/v4',namespace:'OPERATIONAL',base_url:'http://127.0.0.1:3102',
    workflow_db:workflowDb,telemetry_db:path.join(root,'telemetry.sqlite'),handoff_path:path.join(root,'mock-handoff.dpapi'),
    strategy_id:'s',instance_id:'i',identity_id:'strategy',credential_ref:'OCEAN_MOCK_STRATEGY_TOKEN',account_alias:'Sim1',
    expected_symbol:'MNQU25_FUT_CME',expected_strategy_version:'v0.6.238',expected_telemetry_version:'v0.5.45',
    expected_sierra_exe:path.join(root,'SierraChart_64.exe'),poll_seconds:10,state_file:path.join(root,'mock-bridge-state.json'),
    factual_binding_hash:b.config.identities[0].factual_binding_hash,minimum_schema_version:14,freshness_seconds:120,
    expected_chartbook_path:path.join(root,'Data','mock-frozen.Cht'),expected_chart_number:1,expected_chartbook_sha256:digest('mock-cht'),
    time_basis:'Native chart display; no assumed UTC conversion',session_calendar_revision:'mock-calendar',fill_model_version:'mock-native',
    managed_candidate_id:'mock-managed',expected_session_name:'All',expected_session_timezone:'Europe/London',
    expected_bar_period_seconds:300,expected_strategy_module_path:path.join(root,'mock-strategy.dll'),
    expected_strategy_module_sha256:digest('mock-strategy'),expected_telemetry_module_path:path.join(root,'mock-logger.dll'),
    expected_telemetry_module_sha256:digest('mock-logger'),source_preflight_status_path:path.join(root,'vwap-replay-status.txt')};
  const context={schema_version:'2.1.0',run_id:runId,revision:1,strategy_id:'s',execution_instance_id:'i',
    strategy_version:config.expected_strategy_version,expected_environment:'REPLAY',candidate_id:null,
    strategy_code_hash:digest('mock-code'),strategy_config_hash:digest('mock-config'),dataset_manifest_id:'mock-discovery',
    dataset_manifest_revision:1,dataset_manifest_hash:digest('mock-manifest'),dataset_partition:'DISCOVERY',
    strategy_profile_id:'mock-profile6',strategy_profile_version:'v0.1.3',evidence_purpose:'HISTORICAL_BUILD',
    learner_permission:'HISTORICAL_DISCOVERY',observed_source_state:{environment:'REPLAY',quality:'VERIFIED',
      observed_at_utc:'2026-01-01T00:00:00Z',account_alias:'Sim1',simulation:true,replay:true}};
  context.context_hash=sealedHash(context,'context_hash');
  const requested={start_utc:'2025-08-31T23:00:00.000Z',end_utc:'2025-09-12T23:00:00.000Z'};
  const storedPlan={selection:{strategy_id:'s',instance_id:'i',interval:requested,purpose:'HISTORICAL_BUILD'},
    context_hash:context.context_hash,operational_review:{context,factual_binding_hash:config.factual_binding_hash,
      manifest_key:'mock-current-manifest',partition_index:0,interval:requested}};
  storedPlan.plan_hash=sealedHash(storedPlan,'plan_hash');
  db.prepare("INSERT INTO ow_runs VALUES(?,?,?,2,'ACTIVE',?)").run(runId,'s','i',JSON.stringify(context));
  db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(runId,digest('mock-coverage'),JSON.stringify(storedPlan));
  db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run('mock-current-manifest','s',1,context.dataset_manifest_hash,
    'OPERATIONAL_MANIFEST',JSON.stringify({source_id:'mock-source',source_revision:1,manifest_hash:context.dataset_manifest_hash,
      partitions:[{symbol:config.expected_symbol}]}));
  db.prepare('INSERT INTO ow_operational_releases VALUES(?,?,?)').run(runId,context.context_hash,'{}');
  const physical='mock-physical-writer',started=new Date(Date.now()-600000),startId='mock-attempt26-start';
  const sql=new DatabaseSync(config.telemetry_db);sql.exec(schema.toString());
  const insert=(table,row)=>{const keys=Object.keys(row);sql.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));};
  insert('sierra_instance',{instance_id:physical,instance_name:'mock',instance_role:'replay',sierra_exe_path:config.expected_sierra_exe,
    sierra_data_path:path.join(root,'Data'),database_path:config.telemetry_db});
  insert('logger_health',{instance_id:physical,instance_name:'mock',database_path:config.telemetry_db,message:'logger_started version=v0.5.45'});
  insert('account_snapshot',{instance_id:physical,instance_name:'mock',trade_account:'Sim1',account_type_guess:'simulated',is_simulated:1,
    snapshot_utc:new Date().toISOString()});
  insert('instrument_snapshot',{instance_id:physical,instance_name:'mock',trade_account:'Sim1',symbol:config.expected_symbol,chart_number:1});
  insert('replay_runs',{run_id:runId,instance_id:physical,instance_name:'mock',instance_role:'replay',run_started_utc:started.toISOString(),
    strategy_id:'s',strategy_version:config.expected_strategy_version,chartbook:config.expected_chartbook_path,chart_number:1,
    bar_period:'seconds=300',dll_hash:config.expected_strategy_module_sha256});
  insert('replay_run_context',{run_id:runId,candidate_id:config.managed_candidate_id,dataset_id:'mock-discovery:1',dataset_role:'DISCOVERY',
    strategy_profile_id:context.strategy_profile_id,strategy_profile_version:context.strategy_profile_version,
    strategy_code_hash:context.strategy_code_hash,strategy_config_hash:context.strategy_config_hash,context_hash:context.context_hash,
    session_name:'All',session_timezone:'Europe/London'});
  insert('replay_run_attempts',{attempt_id:26,run_id:runId,attempt_number:1,attempt_started_utc:started.toISOString(),start_command_id:startId});
  const start={commandId:startId,action:'start',expectedSymbol:config.expected_symbol,tradeAccount:'Sim1',
    startDateTime:'2025-08-18 00:00:00',tradeStartDateTime:'2025-09-01 00:00:00',endDateTime:'2025-09-13 00:00:00',
    telemetryRunId:runId,telemetryStrategyId:'s',telemetryStrategyVersion:config.expected_strategy_version,
    telemetryRunStartedUtc:started.toISOString(),telemetryDllSha256:config.expected_strategy_module_sha256,
    telemetryContextHash:context.context_hash,telemetryCandidateId:config.managed_candidate_id,telemetryDatasetId:'mock-discovery:1',
    telemetryDatasetRole:'DISCOVERY',telemetryStrategyProfileId:context.strategy_profile_id,telemetryStrategyProfileVersion:context.strategy_profile_version,
    telemetryStrategyCodeHash:context.strategy_code_hash,telemetryStrategyConfigHash:context.strategy_config_hash,
    telemetrySessionName:'All',telemetrySessionTimezone:'Europe/London'};
  const commandFile=path.join(root,'vwap-replay-command.txt');fs.writeFileSync(commandFile,encode(start));
  const hook={commandId:startId,action:'start',status:'running',controllerLifecycleActive:'true',chartNumber:1,
    symbol:config.expected_symbol,secondsPerBar:300,chartDataType:2,isReplayRunning:'true',replayStatus:1,
    detail:`StartChartReplay result=1; startDateTime=${start.startDateTime}; effectiveStartDateTime=${start.startDateTime}; endDateTime=${start.endDateTime}; tradeStartDateTime=${start.tradeStartDateTime}; transition_confirmed=true`};
  fs.writeFileSync(config.source_preflight_status_path,encode(hook));fs.utimesSync(commandFile,started,started);
  fs.utimesSync(config.source_preflight_status_path,new Date(started.getTime()+1000),new Date(started.getTime()+1000));
  const controllerRoot=path.join(root,'connector-control','patrading-tp');fs.mkdirSync(controllerRoot,{recursive:true});
  const controllerFile=path.join(controllerRoot,'replay-status.json'),controllerCommandFile=path.join(controllerRoot,'replay-command.json');
  const controllerId=`oql-managed-status-${'a'.repeat(32)}`;
  const request={schema:'ocean-trading.sierra-replay-controller.command.v1',commandId:controllerId,action:'status',chartNumber:1,
    saveChartbook:false,expectedInstanceDataFolder:path.join(root,'Data')};
  const receipt={schema:'ocean-trading.sierra-replay-controller.status.v1',controllerVersion:'v0.2.1-cicd-vwap-time-basis',
    commandId:controllerId,action:'status',status:'status',chartNumber:1,chartbookPath:config.expected_chartbook_path,
    statusFilePath:controllerFile,instanceDataFolder:request.expectedInstanceDataFolder,isReplayRunning:true,replayStatus:1,
    chartReplayStatus:1,error:null,currentChartDateTime:'2025-08-18 14:03:00'};
  fs.writeFileSync(controllerCommandFile,JSON.stringify(request));fs.writeFileSync(controllerFile,JSON.stringify(receipt));
  const configFile=path.join(root,'mock-bridge.json');fs.writeFileSync(configFile,JSON.stringify(config));
  b.config.operational_factual_bindings=[{binding_hash:config.factual_binding_hash,strategy_id:'s',instance}];
  b.operationalLearning={physicalBindingFile:configFile,statusForRun:()=>({eligible:false,stage:'NOT_DUE',loop_stage:'NOT_DUE',reasons:['RUN_NOT_COMPLETED']})};
  b.runs=new RunManager(b);b.runs.current=()=>{}; // Explicit governance mock; native/read guards execute unchanged.
  const human={role:'HUMAN',id:'wayne-ocean-ui'},read=()=>b.runs.read(human,runId);
  const close=f.close.bind(f);
  return {...f,root,runId,config,configFile,sql,context,storedPlan,start,hook,commandFile,controllerFile,controllerCommandFile,
    read,caller:()=>({...b.runs.load(human,runId),storedPlan}),
    runSnapshot:()=>Object.fromEntries(['ow_runs','ow_run_plans','ow_run_progress','ow_run_leases','ow_coverage_receipts','ow_operational_releases']
      .map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()])),
    otherLatestAttempt:()=>{
      const replay=sql.prepare('SELECT * FROM replay_runs WHERE run_id=?').get(runId);
      insert('replay_runs',{...replay,run_id:'mock-other-run'});
      insert('replay_run_attempts',{attempt_id:27,run_id:'mock-other-run',attempt_number:1,
        attempt_started_utc:new Date().toISOString(),start_command_id:'mock-other-start'});
    },
    nativeFiles:[configFile,commandFile,config.source_preflight_status_path,controllerFile,controllerCommandFile],
    nativeSnapshot:()=>sql.prepare('SELECT * FROM replay_run_attempts').all(),
    async close(){sql.close();await close();}};
}
export const changeJson=(file,change)=>fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,'utf8')),...change}));
