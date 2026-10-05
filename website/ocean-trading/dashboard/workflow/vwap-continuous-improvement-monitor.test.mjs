import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { loadVwapContinuousImprovementConfig, scanVwapContinuousImprovement } from './vwap-continuous-improvement-monitor.mjs';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-vwap-monitor-')),dbFile=path.join(root,'telemetry.sqlite'),stateFile=path.join(root,'state.json');
  const db=new DatabaseSync(dbFile);
  db.exec("CREATE TABLE ocean_trade_causal_v1 (trade_id INTEGER PRIMARY KEY, instance_id TEXT, instance_name TEXT, instance_role TEXT, environment TEXT, trade_account TEXT, is_simulated INTEGER, symbol TEXT, run_id TEXT, strategy_id TEXT, strategy_name TEXT, strategy_version TEXT, direction TEXT, status TEXT, entry_datetime TEXT, exit_datetime TEXT, net_profit_loss REAL, max_favourable_excursion REAL, max_adverse_excursion REAL, context_status TEXT, setup_id TEXT, session_name TEXT, side TEXT, regime_label TEXT, volatility_label TEXT, vwap_reclaim_state TEXT, dataset_role TEXT, mfe_points REAL, mae_points REAL, quality_flags TEXT, updated_utc TEXT)");
  db.close();
  const config={schema_version:'ocean-vwap-continuous-improvement-monitor/v1',enabled:true,strategy_id:'cicd-vwap-pull-back-strategy',strategy_name:'VWAP Pullback',baseline_existing_trades_on_first_run:true,
    critical_quality_flags:['dataset_role_missing','vol_state_missing'],sources:[{id:'fixture-replay',environment:'REPLAY',account:'Sim1',database_path:dbFile,run_assignments:{'run-discovery':'DISCOVERY'}}],
    trigger:{enabled:true,api_base_url:'http://127.0.0.1:9/api',company_id:'company',agent_id:'agent'},
    safety:{production_version:null,automatic_approval_enabled:false,brain_normal_ingestion:'OFF',live_real_enabled:false,real_order_routing:'PROHIBITED'}};
  return {root,dbFile,stateFile,config};
}
function insertRows(dbFile,start,count,{role=null,quality='',setup='london-long',loss=true}={}) {
  const db=new DatabaseSync(dbFile);
  const insert=db.prepare('INSERT INTO ocean_trade_causal_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<count;i++){
    const id=start+i,day=String(1+(id%25)).padStart(2,'0');
    insert.run(id,'instance','Replay Two','replay','replay','Sim1',1,'MNQZ26_FUT_CME','run-discovery','cicd-vwap-pull-back-strategy','VWAP Pullback','v0.6.236','long','closed','2026-09-'+day+'T08:00:00Z','2026-09-'+day+'T08:05:00Z',loss?-100:100,20,-30,'complete',setup,'London','long','Trend Up','normal','long_above_vwap',role,20,-30,quality,new Date(Date.UTC(2026,8,1,0,0,id)).toISOString());
  }
  db.close();
}

test('config enforces non-live safety boundaries',()=>{
  const f=fixture(),file=path.join(f.root,'config.json');fs.writeFileSync(file,JSON.stringify(f.config));
  assert.equal(loadVwapContinuousImprovementConfig(file).strategy_id,'cicd-vwap-pull-back-strategy');
  fs.writeFileSync(file,JSON.stringify({...f.config,safety:{...f.config.safety,automatic_approval_enabled:true}}));
  assert.throws(()=>loadVwapContinuousImprovementConfig(file),/SAFETY_BOUNDARY/);
});
test('first scan baselines rows and incomplete telemetry fails closed',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{quality:'vol_state_missing'});let calls=0;
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;}});
  assert.equal(state.baseline_applied,true);assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');assert.equal(state.sources[0].observed_trade_count,60);assert.equal(state.sources[0].eligible_trade_count,0);assert.equal(calls,0);
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
test('actionable evidence reaches issue and wakeup HTTP endpoints',async()=>{
  const f=fixture();insertRows(f.dbFile,1,50);await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});insertRows(f.dbFile,51,10);
  const requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-1',identifier:'OCEA-TEST'}));else res.end(JSON.stringify({id:'wake-1'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});await new Promise(resolve=>server.close(resolve));
  assert.equal(state.last_trigger_receipt.triggered,true);
  assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/companies/company/issues?limit=100','POST /api/companies/company/issues','POST /api/agents/agent/wakeup?companyId=company']);
  assert.equal(requests[2].body.idempotencyKey.startsWith('vwap-ci-'),true);
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
