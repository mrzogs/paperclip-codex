import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dispatchVwapImprovementEvent, loadVwapContinuousImprovementConfig, readVwapLearningRows,
  scanVwapContinuousImprovement as scanCore } from './vwap-continuous-improvement-monitor.mjs';
import { discoveryFixture, FIXTURE_NOW } from './fixtures/vwap-discovery-fixture.mjs';
import { validateVwapDiscoveryAdmission } from './vwap-discovery-admission.mjs';

const cleanups=[];
after(()=>{for(const cleanup of cleanups.reverse())cleanup();});
const fixtureContext={after:cleanup=>cleanups.push(cleanup)};
const admissionCache=new WeakMap();
// Explicit SOFTWARE-ONLY custody fixtures preserve the existing transport and
// retry tests. Production scanning has no such fallback and is tested via core.
const softwareRows=config=>config.sources.flatMap(source=>readVwapLearningRows(source,config))
    .filter(row=>!row.foreign_account && row.environment==='REPLAY' && row.dataset_role==='DISCOVERY'
      && row.identity_verified && row.telemetry_complete)
    .map(row=>({...row,research_eligible:true,learning_context_complete:true}));
async function softwareAdmission({config,now}){
  const rows=softwareRows(config);
  if(!rows.length)return {admitted:false,admission:null,rows:[],blockers:[{code:'SOFTWARE_FIXTURE_NO_QUALIFIED_ROWS'}]};
  const key=JSON.stringify(rows);let cached=admissionCache.get(config);
  if(!cached || cached.key!==key){
    const fixture=await discoveryFixture(fixtureContext,rows,{now});
    assert.equal(fixture.result.admitted,true,'only a real private admission brand can support this software transport fixture');
    cached={key,fixture};admissionCache.set(config,cached);
  }
  return {...cached.fixture.result,rows:cached.fixture.loaded.reports.learning_rows.document.records,
    publication_sha256:cached.fixture.loaded.publication_sha256};
}
const scanVwapContinuousImprovement=options=>scanCore({clock:()=>FIXTURE_NOW,readAdmission:softwareAdmission,...options});

const PROJECT_ID='11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID='22222222-2222-4222-8222-222222222222';

function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-vwap-monitor-')),dbFile=path.join(root,'telemetry.sqlite'),stateFile=path.join(root,'state.json');
  const db=new DatabaseSync(dbFile);
  cleanups.push(()=>fs.rmSync(root,{recursive:true,force:true}));
  db.exec("CREATE TABLE ocean_trade_causal_v1 (trade_id INTEGER PRIMARY KEY, instance_id TEXT, instance_name TEXT, instance_role TEXT, environment TEXT, trade_account TEXT, is_simulated INTEGER, symbol TEXT, run_id TEXT, strategy_id TEXT, strategy_name TEXT, strategy_version TEXT, direction TEXT, status TEXT, entry_datetime TEXT, exit_datetime TEXT, net_profit_loss REAL, max_favourable_excursion REAL, max_adverse_excursion REAL, context_status TEXT, setup_id TEXT, session_name TEXT, side TEXT, regime_label TEXT, volatility_label TEXT, vwap_reclaim_state TEXT, dataset_role TEXT, mfe_points REAL, mae_points REAL, quality_flags TEXT, updated_utc TEXT)");
  db.close();
  const config={schema_version:'ocean-vwap-continuous-improvement-monitor/v1',enabled:true,strategy_id:'cicd-vwap-pull-back-strategy',strategy_name:'VWAP Pullback',baseline_existing_trades_on_first_run:true,discovery_report_reader_config:'',
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
  return {companyId:config.trigger.company_id,status:'idle',adapterType:'codex_local',
    adapterConfig:{cwd:config.routing.required_project_root,model:config.routing.required_agent_model},metadata:{active_strategy_id:config.strategy_id,
    brain_project:config.brain_identity.project,brain_domain:config.brain_identity.domain,brain_credential_ref:config.routing.brain_credential_ref,
    paperclip_project_id:config.routing.paperclip_project_id,paperclip_workspace_id:config.routing.paperclip_project_workspace_id,
    environment:'TEST_ONLY',live_real_enabled:false},permissions:{canUseSecrets:true,canCreateAgents:false,canUseLiveTrading:false}};
}
function exactRoutingResource(url,config) {
  if(url==='/api/agents/agent')return exactRoutingAgent(config);
  if(url==='/api/projects/'+PROJECT_ID)return {id:PROJECT_ID,companyId:config.trigger.company_id,primaryWorkspace:{id:WORKSPACE_ID}};
  if(url==='/api/projects/'+PROJECT_ID+'/workspaces')return [{id:WORKSPACE_ID,projectId:PROJECT_ID,cwd:config.routing.required_project_root,isPrimary:true}];
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
test('checked-in monitor config pins the approved isolated coordinator route',()=>{
  const config=loadVwapContinuousImprovementConfig(new URL('../config/vwap-continuous-improvement-monitor.json',import.meta.url));
  assert.equal(config.trigger.agent_id,'75618a1a-a7ba-44bd-b391-48d58617433c');
  assert.equal(config.routing.paperclip_project_id,'e0a78492-01d4-4ba8-b733-3dbefa68ae34');
  assert.equal(config.routing.paperclip_project_workspace_id,'fa3a13dc-7189-4891-8f01-f859886a87b1');
  assert.equal(config.safety.production_version,null);
  assert.equal(config.safety.automatic_approval_enabled,false);
  assert.equal(config.safety.live_real_enabled,false);
  assert.equal(config.safety.real_order_routing,'PROHIBITED');
  const source=config.sources.find(item=>item.id==='replay-two-v013');
  const runId='cicd-vwap-v238-discovery-20250913-20251001-z25-20261020-r1';
  assert.equal(source.run_assignments[runId],'DISCOVERY');
  assert.equal(source.run_contracts[runId].run_release_approval_id,'f3b264eb-f081-4b51-b105-6a09c2b42860');
  assert.equal(source.run_contracts[runId].registered_before_rows,true);
  assert.equal(source.run_contracts[runId].materialization_authorized,false);
  assert.equal(source.run_contracts[runId].materialization_attestation,null);
  assert.equal(source.run_contracts[runId].playback_authorized,false);
});
test('first scan baselines rows and incomplete telemetry fails closed',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{quality:'vol_state_missing'});let calls=0;
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;}});
  assert.equal(state.baseline_applied,true);assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');assert.equal(state.sources[0].observed_trade_count,60);assert.equal(state.sources[0].eligible_trade_count,0);assert.equal(calls,0);
});
test('Paper Sim1 monitoring excludes closed Sim4 rows from counts and detector evidence',async()=>{
  const f=fixture();f.config.sources=[{id:'fixture-paper',environment:'PAPER',account:'Sim1',database_path:f.dbFile,require_explicit_dataset_role:true}];
  insertRows(f.dbFile,1,1,{environment:'paper',role:'PAPER'});
  insertRows(f.dbFile,2,1,{environment:'paper',role:'PAPER'});
  const db=new DatabaseSync(f.dbFile);
  db.prepare("UPDATE ocean_trade_causal_v1 SET trade_account='Sim4' WHERE trade_id=2").run();
  db.close();
  let calls=0;const kinds=[];
  const first=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;return {triggered:true};}});
  assert.equal(first.status,'HEALTHY');
  assert.equal(first.observed_trade_count,1);
  assert.equal(first.sources[0].observed_trade_count,1);
  assert.equal(first.foreign_account_trade_count,1);
  assert.equal(first.sources[0].foreign_account_trade_count,1);
  assert.equal(first.eligible_trade_count,0,'Paper identity flags are descriptive and supply no Discovery admission');
  assert.equal(first.detector.sufficiency.eligible_paper_trade_count,1);
  assert.equal(first.paper_provenance_issue_count,0);
  assert.deepEqual(first.observed_trade_ids,['fixture-paper:1']);
  assert.match(first.account_scope_anomaly_action,/FOREIGN_ACCOUNT_ROWS_EXCLUDED/);
  assert.equal(calls,0);
  insertRows(f.dbFile,3,1,{environment:'paper',role:'PAPER'});
  const nextDb=new DatabaseSync(f.dbFile);
  nextDb.prepare("UPDATE ocean_trade_causal_v1 SET trade_account='Sim4' WHERE trade_id=3").run();
  nextDb.close();
  const second=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async(_config,event)=>{calls++;kinds.push(event.kind);return {triggered:true};}});
  assert.equal(second.new_trade_count,0);
  assert.equal(second.observed_trade_count,1);
  assert.equal(second.foreign_account_trade_count,2);
  assert.equal(calls,1);assert.deepEqual(kinds,['EVIDENCE_BLOCKED'],'missing admission can request evidence recovery, never a strategy investigation');
});
test('raw and managed identity conflict fails closed even if context status claims complete',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY',quality:'raw_managed_context_conflict|strategy_version_mismatch'});
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  assert.equal(state.detector.sufficiency.discovery_trade_count,0);
  assert.ok(state.detector.sufficiency.blockers.some(item=>item.code==='DISCOVERY_ADMISSION_REQUIRED'));
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
test('production default missing admission leaves even complete raw Discovery rows unqualified',async()=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
  const state=await scanCore({config:f.config,stateFile:f.stateFile,force:true,clock:()=>FIXTURE_NOW,dispatch:async()=>({triggered:false})});
  assert.equal(state.observed_trade_count,60);assert.equal(state.eligible_trade_count,0);
  assert.equal(state.sources[0].declared_identity_complete_trade_count,60);
  assert.equal(state.detector.sufficiency.discovery_trade_count,0);assert.equal(state.disposition,'INSUFFICIENT_EVIDENCE');
  assert.equal(state.discovery_admission.authority,'UNPROVED');
});

test('same SQLite IDs with changed authenticated context/publication trigger one new investigation',async t=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
  const rows=softwareRows(f.config),first=await discoveryFixture(t,rows);
  let active=first,calls=0;const events=[];
  const readAdmission=async()=>({...active.result,rows:active.loaded.reports.learning_rows.document.records,
    publication_sha256:active.loaded.publication_sha256});
  const scan=force=>scanCore({config:f.config,stateFile:f.stateFile,force,clock:()=>FIXTURE_NOW,readAdmission,
    dispatch:async(_config,event)=>{calls++;events.push(event);return {triggered:true,dispatch_committed:true};}});
  const baseline=await scan(true);assert.equal(baseline.eligible_trade_count,60);
  const changedRows=rows.map(row=>({...row,setup_id:'new-authenticated-context'}));
  active=await discoveryFixture(t,changedRows,{mutateReport:report=>{report.software_revision='second-publication';}});
  const changed=await scan(false);
  assert.equal(changed.new_trade_count,0);assert.equal(changed.newly_eligible_trade_count,0);
  assert.equal(changed.database_signature,baseline.database_signature);assert.equal(changed.disposition,'INVESTIGATE');
  assert.equal(calls,1);assert.equal(events[0].trigger_reason,'ELIGIBLE_EVIDENCE_CHANGED');
  assert.notEqual(changed.discovery_admission_signature,baseline.discovery_admission_signature);
  await scan(false);assert.equal(calls,1);
});

test('admission expiry or tamper with unchanged SQLite revokes eligibility and never retries the old investigation',async t=>{
  for(const mode of ['expiry','tamper']){
    const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
    const admitted=await discoveryFixture(t,softwareRows(f.config));let currentNow=FIXTURE_NOW,deny=false;
    const kinds=[];
    const readAdmission=async()=>deny?{admitted:false,admission:null,rows:[],publication_sha256:admitted.loaded.publication_sha256,
      blockers:[{code:mode==='expiry'?'DISCOVERY_ADMISSION_EXPIRED':'REPORT_HASH_OR_LENGTH_MISMATCH'}]}:
      {...admitted.result,rows:admitted.loaded.reports.learning_rows.document.records,publication_sha256:admitted.loaded.publication_sha256};
    const scan=force=>scanCore({config:f.config,stateFile:f.stateFile,force,clock:()=>currentNow,readAdmission,
      dispatch:async(_config,event)=>{kinds.push(event.kind);return {triggered:false,dispatch_committed:false,reason:'MOCK_BLOCKED_ROUTE'};}});
    const baseline=await scan(true);
    // Start a pending investigation using a changed, still-authenticated context.
    insertRows(f.dbFile,61,1,{role:'DISCOVERY'});
    const pending=await scan(true);assert.equal(pending.pending_dispatch.event.kind,'INVESTIGATE');
    const before=kinds.length;deny=true;if(mode==='expiry')currentNow+=11*60*1000;
    const revoked=await scan(false);
    assert.equal(revoked.eligible_trade_count,0);assert.equal(revoked.disposition,'INSUFFICIENT_EVIDENCE');
    assert.equal(revoked.discovery_admission.authority,'UNPROVED');
    assert.ok(kinds.slice(before).every(kind=>kind==='EVIDENCE_BLOCKED'));
    assert.equal(revoked.pending_dispatch.event.kind,'EVIDENCE_BLOCKED');
    const retry=await scan(false);assert.equal(retry.eligible_trade_count,0);
    assert.ok(kinds.slice(before).every(kind=>kind==='EVIDENCE_BLOCKED'));
    assert.notEqual(revoked.discovery_admission_signature,baseline.discovery_admission_signature);
  }
});

test('changed authoritative intake package rechecks the same publication without duplicating an investigation',async t=>{
  const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
  const evidence=await discoveryFixture(t,softwareRows(f.config));let active=evidence.result,calls=0;
  const scan=()=>scanCore({config:f.config,stateFile:f.stateFile,clock:()=>FIXTURE_NOW,
    readAdmission:async()=>({...active,rows:evidence.loaded.reports.learning_rows.document.records,
      publication_sha256:evidence.loaded.publication_sha256}),dispatch:async()=>{calls++;return {triggered:true,dispatch_committed:true};}});
  const first=await scan();assert.equal(first.eligible_trade_count,60);
  active=await validateVwapDiscoveryAdmission({...evidence.options,verifyAdmission:request=>{
    const claims=evidence.options.verifyAdmission(request);claims.semantic_admission.intake_package_sha256='3'.repeat(64);return claims;
  }});
  assert.equal(active.admitted,true);
  const second=await scan();assert.equal(second.skipped_unchanged,false);
  assert.notEqual(second.discovery_admission_signature,first.discovery_admission_signature);
  assert.equal(second.discovery_admission.semantic_admission.intake_package_sha256,'3'.repeat(64));
  await scan();const unchanged=await scan();assert.equal(unchanged.skipped_unchanged,true);assert.equal(calls,1);
});

test('null P&L and excursions remain unknown and cannot enter authenticated rows as zero',async t=>{
  const f=fixture();insertRows(f.dbFile,1,1,{role:'DISCOVERY'});const db=new DatabaseSync(f.dbFile);
  db.exec('UPDATE ocean_trade_causal_v1 SET net_profit_loss=NULL,mfe_points=NULL,mae_points=NULL,max_favourable_excursion=NULL,max_adverse_excursion=NULL');db.close();
  const rows=readVwapLearningRows(f.config.sources[0],f.config);
  assert.equal(rows[0].net_pnl,null);assert.equal(rows[0].mfe,null);assert.equal(rows[0].mae,null);
  const fixtureAdmission=await discoveryFixture(t,rows);
  assert.equal(fixtureAdmission.result.admitted,false);
  assert.equal(fixtureAdmission.result.blockers[0].code,'DISCOVERY_ROW_ECONOMICS_INVALID');
});

test('cached private admission expiry and row mutation are checked before unchanged-database skipping',async t=>{
  for(const mode of ['expiry','row-mutation']){
    const f=fixture();insertRows(f.dbFile,1,60,{role:'DISCOVERY'});
    const admitted=await discoveryFixture(t,softwareRows(f.config));let now=FIXTURE_NOW;
    let rows=admitted.loaded.reports.learning_rows.document.records;
    const readAdmission=async()=>({...admitted.result,rows,publication_sha256:admitted.loaded.publication_sha256});
    const scan=force=>scanCore({config:f.config,stateFile:f.stateFile,force,clock:()=>now,readAdmission,
      dispatch:async()=>({triggered:true,dispatch_committed:true})});
    const baseline=await scan(true);assert.equal(baseline.eligible_trade_count,60);
    if(mode==='expiry')now+=11*60*1000;
    else rows=rows.map((row,index)=>index===0?{...row,setup_id:'unbound-context'}:row);
    const revoked=await scan(false);
    assert.equal(revoked.skipped_unchanged,false);assert.equal(revoked.database_signature,baseline.database_signature);
    assert.equal(revoked.eligible_trade_count,0);assert.equal(revoked.disposition,'INSUFFICIENT_EVIDENCE');
    assert.ok(revoked.discovery_admission.blockers.some(item=>item.code===(mode==='expiry'
      ?'DISCOVERY_ADMISSION_EXPIRED':'DISCOVERY_ADMISSION_ROW_SET_MISMATCH')));
  }
});
test('frozen assignment alone stays unqualified; authenticated evidence makes existing IDs eligible once',async()=>{
  const f=fixture();delete f.config.sources[0].run_assignments;insertRows(f.dbFile,1,60,{role:null,runId:'prospective-run'});let calls=0,event=null;
  await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});
  f.config.sources[0].run_assignments={'prospective-run':'DISCOVERY'};
  const assignmentOnly=await scanCore({config:f.config,stateFile:f.stateFile,force:false,clock:()=>FIXTURE_NOW,
    dispatch:async()=>{calls++;return {triggered:true,dispatch_committed:true};}});
  assert.equal(assignmentOnly.eligible_trade_count,0);assert.equal(assignmentOnly.detector.sufficiency.discovery_trade_count,0);
  assert.equal(assignmentOnly.disposition,'INSUFFICIENT_EVIDENCE');
  calls=0;
  const second=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async(_config,value)=>{calls++;event=value;return {triggered:true,dispatch_committed:true};}});
  assert.equal(second.new_trade_count,0);assert.equal(second.newly_eligible_trade_count,60);assert.equal(second.disposition,'INVESTIGATE');
  assert.equal(calls,1);assert.equal(event.trigger_reason,'EXISTING_TRADES_BECAME_ELIGIBLE');assert.equal(event.newly_eligible_trade_ids.length,60);
  const third=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async()=>{calls++;return {triggered:true,dispatch_committed:true};}});
  assert.equal(third.skipped_unchanged,true);assert.equal(calls,1);
});
test('a prospective run publication cannot make pre-materialization or forged rows eligible',async()=>{
  const f=fixture(),runId='prospective-governed-run',hash='sha256:'+'a'.repeat(64);
  f.config.sources[0].run_assignments={[runId]:'DISCOVERY'};
  f.config.sources[0].run_contracts={[runId]:{dataset_role:'DISCOVERY',contract_id:'prospective-contract',
    contract_hash:hash,document_hash:'sha256:'+'b'.repeat(64),context_hash:'sha256:'+'c'.repeat(64),
    run_release_approval_id:'33333333-3333-4333-8333-333333333333',run_release_scope:'RUN_RELEASE',
    materialization_authorized:false,materialization_blocker:'POST_STAGING_CHARTBOOK_HASH_NOT_BOUND_BY_EXISTING_RUN_RELEASE',
    materialization_attestation:null,playback_authorized:false,registered_before_rows:true}};
  insertRows(f.dbFile,1,60,{role:'DISCOVERY',runId});let calls=0;
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;return {triggered:true,dispatch_committed:true};}});
  assert.equal(state.eligible_trade_count,0);
  assert.equal(state.role_issue_count,60);
  assert.equal(state.detector.sufficiency.discovery_trade_count,0);
  assert.equal(calls,0);
  assert.equal(state.run_contract_publication.contracts[0].materialization_authorized,false);
});
test('an uncommitted route-blocked dispatch retries after route repair without new database rows',async()=>{
  const f=fixture();insertRows(f.dbFile,1,50);await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});insertRows(f.dbFile,51,10);
  let calls=0;
  const blocked=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>{calls++;return {triggered:false,dispatch_committed:false,reason:'EXACT_PROJECT_ROUTE_NOT_READY',issue_id:'same-issue'};}});
  assert.equal(blocked.pending_dispatch.receipt.issue_id,'same-issue');assert.equal(blocked.last_triggered_analysis_hash,null);
  const recovered=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async()=>{calls++;return {triggered:true,dispatch_committed:true,issue_id:'same-issue',wakeup_id:'wake'};}});
  assert.equal(recovered.skipped_unchanged,false);assert.equal(recovered.pending_dispatch,null);assert.equal(recovered.last_triggered_analysis_hash,recovered.detector.analysis_hash);assert.equal(calls,2);
});
test('a failure after issue creation preserves the pending event and retries the same event',async()=>{
  const f=fixture();insertRows(f.dbFile,1,50);await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async()=>({triggered:false})});insertRows(f.dbFile,51,10);
  let calls=0,firstEvent=null,secondEvent=null;
  const failed=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true,dispatch:async(_config,event)=>{calls++;firstEvent=event;throw new Error('WAKE_FAILED_AFTER_ISSUE_CREATE');}});
  assert.equal(failed.status,'DEGRADED');assert.equal(failed.pending_dispatch.event.event_id,firstEvent.event_id);
  const recovered=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:false,dispatch:async(_config,event)=>{calls++;secondEvent=event;return {triggered:true,dispatch_committed:true,issue_id:'same-issue'};}});
  assert.equal(recovered.status,'HEALTHY');assert.equal(recovered.pending_dispatch,null);assert.equal(secondEvent.event_id,firstEvent.event_id);assert.equal(calls,2);
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
  const requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const parsed=body?JSON.parse(body):null;requests.push({url:req.url,method:req.method,body:parsed});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-1',identifier:'OCEA-TEST'}));else res.end(JSON.stringify({id:'wake-1',agentId:'agent',status:'running',startedAt:'2026-10-20T13:00:00Z',contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});await new Promise(resolve=>server.close(resolve));
  assert.equal(state.last_trigger_receipt.triggered,true);
  assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/projects/'+PROJECT_ID,
    'GET /api/projects/'+PROJECT_ID+'/workspaces','GET '+requests[3].url,'POST /api/companies/company/issues','POST /api/agents/agent/wakeup?companyId=company']);
  assert.match(requests[3].url,/^\/api\/companies\/company\/issues\?limit=5&q=vwap-ci-/);
  assert.equal(requests[4].body.status,'todo');assert.equal(requests[5].body.idempotencyKey.startsWith('vwap-ci-'),true);
  assert.equal(requests[4].body.projectId,PROJECT_ID);assert.equal(requests[4].body.projectWorkspaceId,WORKSPACE_ID);
  assert.match(requests[4].body.description,/Exact strategy ID: cicd-vwap-pull-back-strategy/);
  assert.match(requests[4].body.description,/Brain project: cicd-vwap-pull-back-strategy/);
  assert.match(requests[4].body.description,/Do not substitute or access any sibling strategy/);
  assert.deepEqual({strategyId:requests[5].body.payload.strategyId,brainProject:requests[5].body.payload.brainProject,
    brainDomain:requests[5].body.payload.brainDomain,isolationScope:requests[5].body.payload.isolationScope},{
    strategyId:'cicd-vwap-pull-back-strategy',brainProject:'cicd-vwap-pull-back-strategy',brainDomain:'trading-strategy',isolationScope:'EXACT_STRATEGY_ONLY'});
});
test('a queued wake receipt is not committed until the heartbeat proves it started',async()=>{
  const f=fixture();f.config.trigger.wake_start_timeout_ms=5;f.config.trigger.wake_poll_interval_ms=1;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const parsed=body?JSON.parse(body):null;res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);
    if(resource!==undefined)res.end(JSON.stringify(resource));
    else if(req.method==='GET'&&req.url.includes('/issues?'))res.end('[]');
    else if(req.method==='POST'&&req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-queued',identifier:'OCEA-QUEUED'}));
    else if(req.method==='POST'&&req.url.includes('/wakeup'))res.end(JSON.stringify({id:'wake-queued',agentId:'agent',status:'queued',startedAt:null,contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));
    else if(req.method==='GET'&&req.url==='/api/heartbeat-runs/wake-queued')res.end(JSON.stringify({id:'wake-queued',agentId:'agent',status:'queued',startedAt:null,contextSnapshot:{issueId:'issue-queued',wakeReason:'vwap_continuous_improvement_evidence_deadbeefdeadbeef'}}));
    else res.writeHead(404).end(JSON.stringify({error:'not found'}));
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try{
    await assert.rejects(()=>dispatchVwapImprovementEvent(f.config,{kind:'INVESTIGATE',event_id:'queued-event',strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',new_trade_ids:[],newly_eligible_trade_ids:[],investigation_queue:[],next_action:'none'}),/WAKE_NOT_PROVEN_STARTED/);
  } finally {await new Promise(resolve=>server.close(resolve));}
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
    assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/companies/company/issues?limit=5&q=routing-blocked','POST /api/companies/company/issues']);
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
test('approval, project metadata, and non-live permission mismatches never wake a coordinator',async()=>{
  for(const [label,mutate] of [
    ['pending approval',agent=>{agent.status='pending_approval';}],
    ['wrong company',agent=>{agent.companyId='other-company';}],
    ['wrong project metadata',agent=>{agent.metadata.paperclip_project_id='other-project';}],
    ['wrong workspace metadata',agent=>{agent.metadata.paperclip_workspace_id='other-workspace';}],
    ['live permission',agent=>{agent.permissions.canUseLiveTrading=true;}],
    ['agent creation permission',agent=>{agent.permissions.canCreateAgents=true;}],
  ]){
    const f=fixture(),requests=[];
    const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      requests.push({url:req.url,method:req.method,body:body?JSON.parse(body):null});res.setHeader('content-type','application/json');
      if(req.url==='/api/agents/agent'){const agent=exactRoutingAgent(f.config);mutate(agent);res.end(JSON.stringify(agent));}
      else if(req.method==='GET')res.end('[]');
      else res.end(JSON.stringify({id:'issue-'+label,identifier:'OCEA-ROUTE-BLOCKED'}));
    });});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
    try{
      const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'TRANSPORT_TEST',event_id:'route-'+label,
        strategy_id:f.config.strategy_id,analysis_hash:'sha256:test',transport_test:true});
      assert.equal(receipt.routing_state,'BLOCKED_EXACT_PROJECT_ROUTE_REQUIRED',label);
      assert.equal(receipt.wakeup_id,null,label);
      assert.equal(requests.some(item=>item.url.startsWith('/api/projects/')),false,label);
      assert.equal(requests.some(item=>item.url.includes('/wakeup')),false,label);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  }
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
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const parsed=body?JSON.parse(body):null;requests.push({url:req.url,method:req.method,body:parsed});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-test',identifier:'OCEA-E2E'}));else res.end(JSON.stringify({id:'wake-test',agentId:'agent',status:'running',startedAt:'2026-10-20T13:00:00Z',contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'TRANSPORT_TEST',event_id:'vwap-ci-e2e-fixture',strategy_id:f.config.strategy_id,analysis_hash:'sha256:test',transport_test:true,new_trade_ids:[],investigation_queue:[],next_action:'none'});await new Promise(resolve=>server.close(resolve));
  assert.equal(receipt.triggered,true);assert.equal(receipt.downstream_investigation_complete,false);assert.match(requests[4].body.description,/No strategy, Sierra, approval, promotion, Paper, or Live action is authorized/);assert.equal(requests[5].body.triggerDetail,'system');assert.match(requests[5].body.reason,/^vwap_continuous_improvement_transport_test_[0-9a-f]{16}$/);
});
test('scoped event lookup reuses only an exact existing issue',async()=>{
  const f=fixture(),requests=[],eventId='vwap-ci-existing-event';
  const title='[VWAP CI]['+f.config.strategy_id+'] TRANSPORT_TEST '+eventId;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push({url:req.url,method:req.method});res.setHeader('content-type','application/json');
    const resource=exactRoutingResource(req.url,f.config);
    if(resource!==undefined)res.end(JSON.stringify(resource));
    else if(req.method==='GET'&&req.url.includes('/issues?'))res.end(JSON.stringify([
      {id:'wrong-issue',title:'another strategy '+eventId},
      {id:'existing-issue',identifier:'OCEA-EXISTING',title}]));
    else if(req.method==='POST'&&req.url.includes('/wakeup')){const parsed=body?JSON.parse(body):null;res.end(JSON.stringify({id:'existing-wakeup',agentId:'agent',status:'running',startedAt:'2026-10-20T13:00:00Z',contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));}
    else res.end(JSON.stringify({id:'unexpected-issue-creation'}));
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try{
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'TRANSPORT_TEST',event_id:eventId,
      strategy_id:f.config.strategy_id,analysis_hash:'sha256:test',transport_test:true});
    assert.equal(receipt.issue_id,'existing-issue');assert.equal(receipt.wakeup_id,'existing-wakeup');
    assert.equal(requests.some(item=>item.method==='POST'&&item.url.endsWith('/issues')),false);
    assert.equal(requests[3].url,'/api/companies/company/issues?limit=5&q='+eventId);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('a route-created blocked event issue is rebound and reopened before the exact wake',async()=>{
  const f=fixture(),requests=[],eventId='vwap-ci-route-repair',title='[VWAP CI]['+f.config.strategy_id+'] TRANSPORT_TEST '+eventId;
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    const parsed=body?JSON.parse(body):null;requests.push({url:req.url,method:req.method,body:parsed});res.setHeader('content-type','application/json');
    const resource=exactRoutingResource(req.url,f.config);
    if(resource!==undefined)res.end(JSON.stringify(resource));
    else if(req.method==='GET'&&req.url.includes('/issues?'))res.end(JSON.stringify([{id:'route-blocked-issue',identifier:'OCEA-ROUTE',title,
      status:'blocked',assigneeAgentId:'agent',projectId:null,projectWorkspaceId:null}]));
    else if(req.method==='PATCH'&&req.url==='/api/issues/route-blocked-issue')res.end(JSON.stringify({id:'route-blocked-issue',identifier:'OCEA-ROUTE',title,
      status:'todo',assigneeAgentId:'agent',projectId:PROJECT_ID,projectWorkspaceId:WORKSPACE_ID}));
    else if(req.method==='POST'&&req.url.includes('/wakeup'))res.end(JSON.stringify({id:'route-repair-wake',agentId:'agent',status:'running',
      startedAt:'2026-10-20T13:00:00Z',contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));
    else res.writeHead(404).end(JSON.stringify({error:'not found'}));
  });});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try{
    const receipt=await dispatchVwapImprovementEvent(f.config,{kind:'TRANSPORT_TEST',event_id:eventId,strategy_id:f.config.strategy_id,
      analysis_hash:'sha256:test',transport_test:true});
    assert.equal(receipt.triggered,true);assert.equal(receipt.issue_created,false);assert.equal(receipt.delivery_proven,true);
    const patchRequest=requests.find(item=>item.method==='PATCH');
    assert.deepEqual(patchRequest.body,{status:'todo',assigneeAgentId:'agent',projectId:PROJECT_ID,projectWorkspaceId:WORKSPACE_ID});
    assert.ok(requests.findIndex(item=>item.method==='PATCH')<requests.findIndex(item=>item.url.includes('/wakeup')));
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('evidence blocker reaches recovery issue and wakeup without strategy authority',async()=>{
  const f=fixture(),requests=[],server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const parsed=body?JSON.parse(body):null;requests.push({url:req.url,method:req.method,body:parsed});res.setHeader('content-type','application/json');const resource=exactRoutingResource(req.url,f.config);if(resource!==undefined)res.end(JSON.stringify(resource));else if(req.method==='GET')res.end('[]');else if(req.url.includes('/issues'))res.end(JSON.stringify({id:'issue-blocked',identifier:'OCEA-BLOCKED'}));else res.end(JSON.stringify({id:'wake-blocked',agentId:'agent',status:'running',startedAt:'2026-10-20T13:00:00Z',contextSnapshot:{issueId:parsed.payload.issueId,wakeReason:parsed.reason}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.config.trigger.api_base_url='http://127.0.0.1:'+server.address().port+'/api';
  try {
    insertRows(f.dbFile,1,50,{role:'DISCOVERY',runId:'unregistered-holdout'});
    await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});
    insertRows(f.dbFile,51,1,{role:'DISCOVERY',runId:'unregistered-holdout'});
    const state=await scanVwapContinuousImprovement({config:f.config,stateFile:f.stateFile,force:true});
    assert.equal(state.last_trigger_receipt.triggered,true);
    assert.equal(state.last_trigger_receipt.issue_identifier,'OCEA-BLOCKED');
    assert.deepEqual(requests.map(item=>item.method+' '+item.url),['GET /api/agents/agent','GET /api/projects/'+PROJECT_ID,
      'GET /api/projects/'+PROJECT_ID+'/workspaces','GET '+requests[3].url,'POST /api/companies/company/issues','POST /api/agents/agent/wakeup?companyId=company']);
    assert.match(requests[3].url,/^\/api\/companies\/company\/issues\?limit=5&q=vwap-ci-/);
    assert.match(requests[4].body.description,/do not relabel historical validation\/holdout trades/);
    assert.match(requests[4].body.description,/no automatic approval/);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
