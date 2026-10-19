import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dispatchVwapImprovementEvent, loadVwapContinuousImprovementConfig, scanVwapContinuousImprovement } from './vwap-continuous-improvement-monitor.mjs';

const PROJECT_ID='11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID='22222222-2222-4222-8222-222222222222';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-vwap-monitor-')),dbFile=path.join(root,'telemetry.sqlite'),stateFile=path.join(root,'state.json');
  const db=new DatabaseSync(dbFile);
  db.exec("CREATE TABLE ocean_trade_causal_v1 (trade_id INTEGER PRIMARY KEY, instance_id TEXT, instance_name TEXT, instance_role TEXT, environment TEXT, trade_account TEXT, is_simulated INTEGER, symbol TEXT, run_id TEXT, strategy_id TEXT, strategy_name TEXT, strategy_version TEXT, direction TEXT, status TEXT, entry_datetime TEXT, exit_datetime TEXT, net_profit_loss REAL, max_favourable_excursion REAL, max_adverse_excursion REAL, context_status TEXT, setup_id TEXT, session_name TEXT, side TEXT, regime_label TEXT, volatility_label TEXT, vwap_reclaim_state TEXT, dataset_role TEXT, mfe_points REAL, mae_points REAL, quality_flags TEXT, updated_utc TEXT)");
  db.close();
  const config={schema_version:'ocean-vwap-continuous-improvement-monitor/v1',enabled:true,strategy_id:'cicd-vwap-pull-back-strategy',strategy_name:'VWAP Pullback',baseline_existing_trades_on_first_run:true,
    brain_identity:{domain:'trading-strategy',project:'cicd-vwap-pull-back-strategy',strategy:'cicd-vwap-pull-back-strategy'},
    routing:{mode:'BLOCK_UNTIL_EXACT_PROJECT_ROUTE',required_project_root:'C:\\CICD-VWAP',brain_credential_ref:'D:\\secrets\\cicd-vwap.token',
      required_agent_model:'gpt-6.1-sol',paperclip_project_id:PROJECT_ID,paperclip_project_workspace_id:WORKSPACE_ID},
    critical_quality_flags:['dataset_role_missing','raw_managed_context_conflict','strategy_version_mismatch','vol_state_missing'],sources:[{id:'fixture-replay',environment:'REPLAY',account:'Sim1',database_path:dbFile,run_assignments:{'run-discovery':'DISCOVERY'}}],
    trigger:{enabled:true,api_base_url:'http://127.0.0.1:9/api',company_id:'company',agent_id:'agent'},
    safety:{production_version:null,automatic_approval_enabled:false,brain_normal_ingestion:'OFF',live_real_enabled:false,real_order_routing:'PROHIBITED'}};
  return {root,dbFile,stateFile,config};
}
function insertRows(dbFile,start,count,{role=null,quality='',setup='london-long',loss=true,runId='run-discovery',environment='replay'}={}) {
  const db=new DatabaseSync(dbFile);
  const insert=db.prepare('INSERT INTO ocean_trade_causal_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<count;i++){
    const id=start+i,day=String(1+(id%25)).padStart(2,'0');
    insert.run(id,'instance',environment==='paper'?'Paper Sim1':'Replay Two',environment,environment,'Sim1',1,'MNQZ26_FUT_CME',runId,'cicd-vwap-pull-back-strategy','VWAP Pullback','v0.6.236','long','closed','2026-09-'+day+'T08:00:00Z','2026-09-'+day+'T08:05:00Z',loss?-100:100,20,-30,'complete',setup,'London','long','Trend Up','normal','long_above_vwap',role,20,-30,quality,new Date(Date.UTC(2026,8,1,0,0,id)).toISOString());
  }
  db.close();
}
function exactRoutingAgent(config) {
  return {adapterConfig:{cwd:config.routing.required_project_root,model:config.routing.required_agent_model},metadata:{active_strategy_id:config.strategy_id,
    brain_project:config.brain_identity.project,brain_domain:config.brain_identity.domain,brain_credential_ref:config.routing.brain_credential_ref},permissions:{canUseSecrets:true}};
}
function exactRoutingResource(url,config) {
  if(url==='/api/agents/agent')return exactRoutingAgent(config);
  if(url==='/api/projects/'+PROJECT_ID)return {id:PROJECT_ID,companyId:config.trigger.company_id};
  if(url==='/api/projects/'+PROJECT_ID+'/workspaces')return [{id:WORKSPACE_ID,projectId:PROJECT_ID,cwd:config.routing.required_project_root}];
  return undefined;
}

test('config enforces non-live safety boundaries',()=>{
  const f=fixture(),file=path.join(f.root,'config.json');fs.writeFileSync(file,JSON.stringify(f.config));
  assert.equal(loadVwapContinuousImprovementConfig(file).strategy_id,'cicd-vwap-pull-back-strategy');
  fs.writeFileSync(file,JSON.stringify({...f.config,brain_identity:{...f.config.brain_identity,project:'oql-vwap-wave-pullback'}}));
  assert.throws(()=>loadVwapContinuousImprovementConfig(file),/BRAIN_IDENTITY_MISMATCH/);
  fs.writeFileSync(file,JSON.stringify({...f.config,routing:{...f.config.routing,paperclip_project_id:undefined}}));
  assert.throws(()=>loadVwapContinuousImprovementConfig(file),/ROUTING_BOUNDARY_INVALID/);
  fs.writeFileSync(file,JSON.stringify({...f.config,safety:{...f.config.safety,automatic_approval_enabled:true}}));
  assert.throws(()=>loadVwapContinuousImprovementConfig(file),/SAFETY_BOUNDARY/);
});
test('first scan baselines rows and incomplete telemetry fails closed',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{quality:'vol_state_missing'});let calls=0;
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;}});
  assert.equal(state.baseline_applied,true);assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');assert.equal(state.sources[0].observed_trade_count,60);assert.equal(state.sources[0].eligible_trade_count,0);assert.equal(calls,0);
});
test('raw and managed identity conflict fails closed even if context status claims complete',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY',quality:'raw_managed_context_conflict|strategy_version_mismatch'});
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  assert.equal(state.detector.sufficiency.discovery_trade_count,60);
  assert.equal(state.detector.sufficiency.blockers[0].code,'TELEMETRY_OR_IDENTITY_GAPS');
  assert.equal(state.eligible_trade_count,0);
});
test('new discovery evidence triggers once and unchanged scans stay local',async()=>{
  const f=fixture();insertRows(f.dbFile,1,50);let calls=0;
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  insertRows(f.dbFile,51,10);
  const second=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;return {triggered:true};}});
  assert.equal(second.disposition,'INVESTIGATE');assert.equal(second.new_trade_count,10);assert.equal(calls,1);
  const third=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;return {triggered:true};}});
  assert.equal(third.new_trade_count,0);assert.equal(calls,1);
  const fourth=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async()=>{calls++;}});
  assert.equal(fourth.skipped_unchanged,true);assert.equal(calls,1);
});
test('validation rows never select thresholds or wake an agent',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'VALIDATION'});let calls=0;
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;}});
  assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');assert.equal(state.detector.sufficiency.discovery_trade_count,0);assert.equal(calls,0);
});
test('embedded DISCOVERY cannot override the frozen Replay run-role map',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY',runId:'test-cand-v240-holdout-m26-202605'});let calls=0,kind=null;
  const dispatch=async(_config,event)=>{calls++;kind=event.kind;return {triggered:true};};
  const first=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(first.detector.sufficiency.discovery_trade_count,0);
  assert.equal(first.eligible_trade_count,0);
  assert.equal(calls,0);
  insertRows(f.dbFile,61,1,{role:'DISCOVERY',runId:'test-cand-v240-holdout-m26-202605'});
  const second=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(second.detector.sufficiency.discovery_trade_count,0);
  assert.equal(second.disposition,'INSUFFICIENT_EVIDENCE');
  assert.equal(kind,'EVIDENCE_BLOCKED');
  assert.equal(calls,1);
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(calls,1);
});
test('conflicting embedded role cannot override an assigned discovery run',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'VALIDATION'});
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  assert.equal(state.detector.sufficiency.discovery_trade_count,0);
  assert.equal(state.eligible_trade_count,0);
});
test('missing Replay run-role map never falls back to the embedded label',async()=>{
  const f=fixture();delete f.config.sources[0].run_assignments;insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  assert.equal(state.detector.sufficiency.discovery_trade_count,0);
  assert.equal(state.role_issue_count,60);
  assert.equal(state.eligible_trade_count,0);
});
test('new unassigned Paper trades raise one provenance recovery, not a strategy investigation',async()=>{
  const f=fixture();f.config.sources=[{id:'fixture-paper',environment:'PAPER',account:'Sim1',database_path:f.dbFile,require_explicit_dataset_role:true}];
  insertRows(f.dbFile,1,1,{environment:'paper'});let calls=0,kind=null;
  const dispatch=async(_config,event)=>{calls++;kind=event.kind;return {triggered:true};};
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  insertRows(f.dbFile,2,1,{environment:'paper'});
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');
  assert.equal(state.paper_provenance_issue_count,2);
  assert.match(state.next_action,/PAPER_PROVENANCE_BLOCKED/);
  assert.equal(kind,'EVIDENCE_BLOCKED');
  assert.equal(calls,1);
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(calls,1);
});
test('actionable evidence reaches issue and wakeup HTTP endpoints',async()=>{
  const f=fixture();insertRows(f.dbFile,1,50);await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});insertRows(f.dbFile,51,10);
  const requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-1',identifier:'OCEA-TEST'}));else res.end(JSON.stringify({id:'wake-1'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});await new Promise(resolve=>server.close(resolve));
  assert.equal(state.last_trigger_receipt.triggered,true);
  assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/projects/'+PROJECT_ID,
    'GET /api/projects/'+PROJECT_ID+'/workspaces','GET /api/companies/company/issues?limit=100','POST /api/companies/company/issues','POST /api/agents/agent/wakeup?companyId=company']);
  assert.equal(requests[4].body.status,'todo');assert.equal(requests[5].body.idempotencyKey.startsWith('vwap-ci-'),true);
  assert.equal(requests[4].body.projectId,PROJECT_ID);assert.equal(requests[4].body.projectWorkspaceId,WORKSPACE_ID);
  assert.match(requests[4].body.description,/Exact strategy ID: cicd-vwap-pull-back-strategy/);
  assert.match(requests[4].body.description,/Brain project: cicd-vwap-pull-back-strategy/);
  assert.match(requests[4].body.description,/Do not substitute or access any sibling strategy/);
  assert.deepEqual({strategyId:requests[5].body.payload.strategyId,brainProject:requests[5].body.payload.brainProject,
    brainDomain:requests[5].body.payload.brainDomain,isolationScope:requests[5].body.payload.isolationScope},{
    strategyId:'cicd-vwap-pull-back-strategy',brainProject:'cicd-vwap-pull-back-strategy',brainDomain:'trading-strategy',isolationScope:'EXACT_STRATEGY_ONLY'});
});
test('dispatch fails closed before HTTP when the event strategy identity differs',async()=>{
  const f=fixture();
  await assert.rejects(()=>dispatchVwapImprovementEvent(f.config,{kind:'EVIDENCE_BLOCKED',event_id:'wrong-strategy',
    strategy_id:'vwap_wave_pullback_balanced_nasdaq_v0434',analysis_hash:'sha256:test',blockers:[],role_issue_count:0,
    paper_provenance_issue_count:0,source_ids:[],next_action:'none'}),/DISPATCH_IDENTITY_MISMATCH/);
});
test('wrong coordinator workspace creates only a blocked containment issue',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');if(req.url==='/api/agents/agent')res.end(JSON.stringify({adapterConfig:{cwd:'D:\\ExternalRepos\\ocean-quant-lab'},metadata:{active_strategy_id:'vwap_wave_pullback_balanced_nasdaq_v0434'},permissions:{canUseSecrets:false}}));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-blocked-route',identifier:'OCEA-ROUTE'}));else res.end(JSON.stringify({id:'unexpected-wake'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'EVIDENCE_BLOCKED',event_id:'routing-blocked',strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',blockers:[],role_issue_count:1,paper_provenance_issue_count:0,source_ids:['fixture'],next_action:'reconcile'});
    assert.equal(receipt.routing_state,'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED');
    assert.equal(requests[2].body.status,'blocked');assert.match(requests[2].body.description,/Keep this issue blocked/);
    assert.equal(requests[2].body.projectId,null);assert.equal(requests[2].body.projectWorkspaceId,null);
    assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/companies/company/issues?limit=100','POST /api/companies/company/issues']);
    assert.equal(receipt.wakeup_id,null);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('correct agent identity remains blocked until exact Paperclip project bindings exist',async()=>{
  const f=fixture();f.config.routing.paperclip_project_id=null;f.config.routing.paperclip_project_workspace_id=null;
  const requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');if(req.url==='/api/agents/agent')res.end(JSON.stringify(exactRoutingAgent(f.config)));else if(req.method==='GET')res.end('[]');else res.end(JSON.stringify({id:'issue-unprovisioned',identifier:'OCEA-UNPROVISIONED'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'EVIDENCE_BLOCKED',event_id:'project-unprovisioned',strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',blockers:[],role_issue_count:1,paper_provenance_issue_count:0,source_ids:['fixture'],next_action:'provision'});
    assert.equal(receipt.routing_state,'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED');assert.equal(receipt.wakeup_id,null);
    assert.equal(requests[2].body.projectId,null);assert.equal(requests[2].body.projectWorkspaceId,null);
    assert.match(requests[2].body.description,/Paperclip project ID: NOT_PROVISIONED/);
    assert.equal(requests.length,3);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('a substituted Brain credential scope blocks before project routing or wakeup',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');if(req.url==='/api/agents/agent')res.end(JSON.stringify({...exactRoutingAgent(f.config),metadata:{...exactRoutingAgent(f.config).metadata,brain_credential_ref:'D:\\secrets\\another-project.token'}}));else if(req.method==='GET')res.end('[]');else res.end(JSON.stringify({id:'issue-wrong-credential',identifier:'OCEA-WRONG-CREDENTIAL'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'EVIDENCE_BLOCKED',event_id:'credential-mismatch',strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',blockers:[],role_issue_count:1,paper_provenance_issue_count:0,source_ids:['fixture'],next_action:'repair credential scope'});
    assert.equal(receipt.routing_state,'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED');assert.equal(receipt.wakeup_id,null);
    assert.equal(requests.some(item=>item.url.startsWith('/api/projects/')),false);
    assert.equal(requests.some(item=>item.url.includes('/wakeup')),false);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('configured project IDs remain blocked when the Paperclip workspace root is different',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');if(req.url==='/api/agents/agent')res.end(JSON.stringify(exactRoutingAgent(f.config)));else if(req.url==='/api/projects/'+PROJECT_ID)res.end(JSON.stringify({id:PROJECT_ID,companyId:f.config.trigger.company_id}));else if(req.url==='/api/projects/'+PROJECT_ID+'/workspaces')res.end(JSON.stringify([{id:WORKSPACE_ID,projectId:PROJECT_ID,cwd:'D:\\ExternalRepos\\ocean-quant-lab'}]));else if(req.method==='GET')res.end('[]');else res.end(JSON.stringify({id:'issue-wrong-workspace',identifier:'OCEA-WRONG-WORKSPACE'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'EVIDENCE_BLOCKED',event_id:'workspace-mismatch',strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',blockers:[],role_issue_count:1,paper_provenance_issue_count:0,source_ids:['fixture'],next_action:'repair route'});
    assert.equal(receipt.routing_state,'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED');assert.equal(receipt.wakeup_id,null);
    assert.equal(requests.at(-1).body.status,'blocked');assert.equal(requests.at(-1).body.projectId,null);
    assert.equal(requests.some(item=>item.url.includes('/wakeup')),false);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('repeated database failure wakes the coordinator once',async()=>{
  const f=fixture();f.config.sources[0].database_path=path.join(f.root,'missing.sqlite');f.config.trigger.failure_threshold=3;let calls=0;const events=[];
  const dispatch=async(_config,event)=>{calls++;events.push(event);return {triggered:true,issue_id:'failure-issue'};};
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  const third=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  const fourth=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch});
  assert.equal(third.status,'DEGRADED');assert.equal(third.consecutive_failures,3);assert.equal(calls,1);assert.equal(events[0].kind,'MONITOR_DEGRADED');assert.equal(fourth.consecutive_failures,4);assert.equal(calls,1);
});
test('a degraded monitor retries unchanged databases and recovers',async()=>{
  const f=fixture();insertRows(f.dbFile,1,5);
  const healthy=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  fs.writeFileSync(f.stateFile,JSON.stringify({...healthy,status:'DEGRADED',consecutive_failures:1,last_error:'transient lock'}));
  const recovered=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async()=>({triggered:false})});
  assert.equal(recovered.status,'HEALTHY');assert.equal(recovered.skipped_unchanged,false);assert.equal(recovered.consecutive_failures,0);assert.equal(recovered.database_query_count,healthy.database_query_count+1);
});
test('a frozen role-map change rechecks unchanged databases',async()=>{
  const f=fixture();insertRows(f.dbFile,1,5,{role:'DISCOVERY'});
  const before=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  f.config.sources[0].run_assignments={'another-run':'DISCOVERY'};
  const after=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async()=>({triggered:false})});
  assert.equal(after.skipped_unchanged,false);
  assert.equal(after.database_query_count,before.database_query_count+1);
  assert.equal(after.role_issue_count,5);
  assert.equal(after.eligible_trade_count,0);
  assert.match(after.next_action,/REPLAY_RUN_ROLE_PROVENANCE_BLOCKED/);
});
test('source interrogation yields the event loop while an auxiliary read is pending',async()=>{
  const f=fixture();let timerObserved=false;
  const pending=scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false}),
    readSource:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return [];}});
  setTimeout(()=>{timerObserved=true;},0);
  const state=await pending;
  assert.equal(timerObserved,true);assert.equal(state.status,'HEALTHY');assert.equal(state.sources[0].observed_trade_count,0);
});
test('transport test reaches the normal issue and wakeup path without authorizing strategy action',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-test',identifier:'OCEA-E2E'}));else res.end(JSON.stringify({id:'wake-test'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'TRANSPORT_TEST',event_id:'vwap-ci-e2e-fixture',strategy_id:f.config.strategy_id,analysis_hash:'sha256:test',transport_test:true,new_trade_ids:[],investigation_queue:[],next_action:'none'});await new Promise(resolve=>server.close(resolve));
  assert.equal(receipt.triggered,true);assert.match(requests[4].body.description,/No strategy, Sierra, approval, promotion, Paper, or Live action is authorized/);assert.equal(requests[5].body.triggerDetail,'system');assert.equal(requests[5].body.reason,'vwap_continuous_improvement_transport_test');
});
test('evidence blocker reaches recovery issue and wakeup without strategy authority',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-blocked',identifier:'OCEA-BLOCKED'}));else res.end(JSON.stringify({id:'wake-blocked'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    insertRows(f.dbFile,1,50,{role:'DISCOVERY',runId:'unregistered-holdout'});
    await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});
    insertRows(f.dbFile,51,1,{role:'DISCOVERY',runId:'unregistered-holdout'});
    const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});
    assert.equal(state.last_trigger_receipt.triggered,true);
    assert.equal(state.last_trigger_receipt.issue_identifier,'OCEA-BLOCKED');
    assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/projects/'+PROJECT_ID,
      'GET /api/projects/'+PROJECT_ID+'/workspaces','GET /api/companies/company/issues?limit=100','POST /api/companies/company/issues','POST /api/agents/agent/wakeup?companyId=company']);
    assert.match(requests[4].body.description,/do not relabel historical validation\/holdout trades/);
    assert.match(requests[4].body.description,/no automatic approval/);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
