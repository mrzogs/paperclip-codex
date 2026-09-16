import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {WorkflowBackend} from './backend.mjs';
import {startUiTestHost} from './ui-test-host.mjs';
import {digest,sealedHash} from './common.mjs';
import {PURPOSES,interval,merge,subtract,intersect,countNoTradeIntervals} from './run-manager.mjs';

const root=process.env.OCEAN_S21_ROOT;assert.ok(root);
const results=[];const apiExamples=new Map();let app;let browser;let activePage;
const evidence=path.join(root,'artifacts/evidence');fs.mkdirSync(evidence,{recursive:true});
const check=async(name,work)=>{const start=Date.now();try{await work();results.push({name,status:'PASS',type:'ACTUAL_ISOLATED_HTTP_SQLITE_SYNTHETIC_TEST_DATA',elapsed_ms:Date.now()-start});console.log(`PASS ${name}`);}catch(error){results.push({name,status:'FAILED',error:error.message});throw error;}};
try {
  app=await startUiTestHost({extraInstances:['test-s22-second','test-s22-code2'],fixtureOptions:{instanceOverrides:{0:{capabilities:['REPLAY','PAPER_FORWARD']},1:{version_binding:'test-candidate-1',capabilities:['REPLAY','PAPER_FORWARD']}},authorizedTests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT','VALIDATION','RESEARCH_EXPERIMENT']}});
  const f=app.fixture;const call=f.call;const rm=async(action,data,expected=200,role='HUMAN')=>{const response=await call(`run-manager/${action}`,{data,expected,role});if(expected===200)apiExamples.set(action,{operation:action,data,response});return response;};
  const first=f.registered[0];const second=f.registered[1];const getRun=runId=>call(`run-manager/context/${runId}`);
  const intervalA={start_utc:'2026-05-01T00:00:00.000Z',end_utc:'2026-05-02T00:00:00.000Z'};
  const ids=[];const permissions={};let currentRun;let lease;
  const baseSelection={strategy_id:first.profile.strategy_id,version_id:'test-s22-baseline',expected_environment:'REPLAY',instance_id:first.instance.execution_instance_id,purpose:'HISTORICAL_BUILD',permission_id:'test-permission-0-DISCOVERY',partition_index:0,interval:intervalA,warmup_interval:null,build_mode:'ADD_MISSING_HISTORY',case_id:null,experiment_id:null};
  const prepare=async(selection=baseSelection)=>{const p=await rm('preview',{selection});return rm('prepare',{run_id:f.id('managed'),selection,review_hash:p.review_hash,confirmed:true});};
  const claim=async(run)=>rm('claim',{run_id:run.run_id,expected_revision:run.revision},200,'TELEMETRY');
  const activate=async(run,l)=>rm('activate',{run_id:run.run_id,expected_revision:run.revision,lease_id:l.lease_id,observed_handshake:{instance:run.plan.instance,context_hash:run.context.context_hash,plan_hash:run.plan.plan_hash,source_state:{observed_at_utc:new Date().toISOString(),environment:run.context.expected_environment,simulation:true,replay:run.context.expected_environment==='REPLAY',account_alias:run.plan.instance.account_alias,source_schema_version:'2.1.0',quality:'VERIFIED'}}},200,'TELEMETRY');
  const progress=async(run,l,axes=Object.fromEntries(['source_market','strategy_execution','processing_review'].map(k=>[k,run.plan.scored_intervals])),extra={})=>rm('progress',{run_id:run.run_id,lease_id:l.lease_id,axes,watermark:run.plan.scored_intervals.at(-1).end_utc,pending_events:0,gaps:[],failures:[],...extra},200,'TELEMETRY');
  const end=async(run,outcome='COMPLETED')=>rm('end',{run_id:run.run_id,expected_revision:(await getRun(run.run_id)).revision,outcome});
  const finish=async(run,l,expected=200)=>rm('finish',{run_id:run.run_id,lease_id:l.lease_id,expected_revision:(await getRun(run.run_id)).revision},expected,'TELEMETRY');
  const pin=async(run,l,trade,state='OPEN')=>rm('pin',{run_id:run.run_id,lease_id:l.lease_id,trade_id:trade,state,context_hash:run.context.context_hash},200,'TELEMETRY');
  const facts={entry_price:100,exit_price:102,quantity:1,pnl:4};
  const record=async(run,l,trade,changes={},expected=200)=>rm('evidence',{run_id:run.run_id,lease_id:l.lease_id,event_id:f.id('event'),legacy_trade_id:f.id('legacy'),trade_id:trade,symbol:run.plan.symbol,entry_time_utc:'2026-05-01T01:00:00Z',exit_time_utc:'2026-05-01T02:00:00Z',side:'LONG',entry_order_key:'source-order-1',exit_order_key:'source-order-2',market_event_keys:['market-event-1','market-event-2'],facts,...changes},expected,'TELEMETRY');

  await check('ID-04 registered baseline/candidate/settings; S19 remains pending and disabled',async()=>{
    await f.change(f.secondary.caseId,{action:'resume'});
    await rm('version',{version_id:'test-s22-baseline',strategy_id:first.profile.strategy_id,kind:'BASELINE',version:first.profile.baseline_version,code_hash:first.profile.strategy_code_hash,profile_key:`${first.profile.profile_id}:${first.profile.profile_version}`,case_id:null,artifact_id:null});
    const db=new DatabaseSync(app.config.db_file,{readOnly:true});const candidate=db.prepare("SELECT id,candidate_hash FROM ow_artifacts WHERE kind='CANDIDATE'").get();db.close();
    await rm('version',{version_id:'test-s22-candidate',strategy_id:second.profile.strategy_id,kind:'CANDIDATE',version:'test-candidate-1',code_hash:candidate.candidate_hash,profile_key:`${second.profile.profile_id}:${second.profile.profile_version}`,case_id:f.secondary.caseId,artifact_id:candidate.id});
    const duplicate={...first.instance,execution_instance_id:'test-s22-second'};
    await call('instances',{data:{strategy_id:first.profile.strategy_id,instance:duplicate},expected:409});
    await call('instances',{data:{strategy_id:first.profile.strategy_id,instance:{...duplicate,chart_id:'test-second-chart'}}});
    for(const instance of [first.instance.execution_instance_id,second.instance.execution_instance_id,'test-s22-second'])await rm('settings',{instance_id:instance,chart_settings_hash:digest('same-settings'),time_basis:'UTC',session_calendar_revision:'TEST-24h-v1',fill_model_version:'TEST-FILL-v1'});
    const manifestPlan=JSON.parse(fs.readFileSync(path.join(root,'artifacts/consumer-snapshots/S19/dataset-manifest.json'),'utf8'));
    await call('dataset-plans',{data:{strategy_id:manifestPlan.strategy_id,manifest:manifestPlan}});
    await rm('permission',{permission_id:'test-illegal-plan',strategy_id:first.profile.strategy_id,manifest_key:`${manifestPlan.plan_id}:${manifestPlan.revision}`,manifest_hash:manifestPlan.plan_hash,purposes:['HISTORICAL_BUILD'],expires_at_utc:new Date(Date.now()+3600000).toISOString(),prior_exposure:'UNKNOWN',test_only:true},403);
    for(let i=0;i<2;i++)for(const role of ['DISCOVERY','DEVELOPMENT','VALIDATION','HOLDOUT','FORWARD']){
      const manifest={...structuredClone(first.dataset),dataset_manifest_id:`test-s22-dataset-${i}-${role}`,source_id:`test-source-${role}`,source_revision:'test-revision-1',quality_status:'VERIFIED',gaps:[],partitions:[{...intervalA,partition:role,symbol:'MNQU26',coverage_status:'COMPLETE'}],protected_intervals:[]};manifest.manifest_hash=sealedHash(manifest,'manifest_hash');
      await call('datasets',{data:{strategy_id:f.registered[i].profile.strategy_id,manifest}});
      const permission={permission_id:`test-permission-${i}-${role}`,strategy_id:f.registered[i].profile.strategy_id,manifest_key:`${manifest.dataset_manifest_id}:${manifest.revision}`,manifest_hash:manifest.manifest_hash,purposes:[...PURPOSES.filter(p=>p[2]===role).map(p=>p[1]),'NOT_ELIGIBLE'],expires_at_utc:new Date(Date.now()+3600000).toISOString(),prior_exposure:role==='HOLDOUT'?'UNTOUCHED':'EXPOSED',test_only:true};permissions[`${i}-${role}`]={manifest,permission};await rm('permission',permission);
    }
    const o=await call('run-manager/options');assert.equal(o.actual_ingestion,'OFF');assert.equal(o.pending_plans.length,1);assert.ok(o.disabled_environments.includes('LIVE_REAL'));
  });
  await check('DATA-04 purpose matrix, immutable roles, validation and shadow candidate approval',async()=>{
    for(const rule of PURPOSES.filter(p=>p[1]!=='SHADOW_FORWARD')){
      const candidate=!['LEARNING','HISTORICAL_BUILD'].includes(rule[1]);const selection={...baseSelection,strategy_id:candidate?second.profile.strategy_id:first.profile.strategy_id,version_id:candidate?'test-s22-candidate':'test-s22-baseline',instance_id:candidate?second.instance.execution_instance_id:first.instance.execution_instance_id,expected_environment:rule[0],purpose:rule[1],permission_id:`test-permission-${candidate?1:0}-${rule[2]}`,build_mode:rule[1]==='HISTORICAL_BUILD'?'ADD_MISSING_HISTORY':null,case_id:candidate?f.secondary.caseId:null,experiment_id:candidate?'test-experiment-matrix':null};
      const p=await rm('preview',{selection});assert.equal(p.learner_permission,rule[3]);const r=await prepare(selection);const l=await claim(r);await end(r,'CANCELLED');await progress(r,l,{source_market:[],strategy_execution:[],processing_review:[]},{watermark:null});await finish(r,l);
    }
    for(const environment of ['BACKTEST','IMPORT','LIVE_REAL'])await rm('preview',{selection:{...baseSelection,expected_environment:environment}},403);
    await rm('preview',{selection:{...baseSelection,learner_permission:'HISTORICAL_DISCOVERY'}},422);
    await rm('preview',{selection:{...baseSelection,permission_id:'test-permission-0-HOLDOUT'}},403);
    const shadow={...baseSelection,strategy_id:second.profile.strategy_id,version_id:'test-s22-candidate',instance_id:second.instance.execution_instance_id,expected_environment:'PAPER_FORWARD',purpose:'SHADOW_FORWARD',permission_id:'test-permission-1-FORWARD',build_mode:null,case_id:f.secondary.caseId,experiment_id:'test-shadow'};
    await rm('preview',{selection:shadow},409);
    for(const kind of ['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']){const a=await f.artifact(f.secondary.caseId,kind,{},'STRATEGY');await call('tasks',{role:'STRATEGY',data:{case_id:f.secondary.caseId,expected_revision:(await call(`cases/${f.secondary.caseId}`)).revision,kind,status:'PASS',artifact_id:a.manifest.artifact_id}});}
    await f.change(f.secondary.caseId,{action:'advance',to_stage:'CANDIDATE_EVALUATION'},'STRATEGY');
    const evaluation=await f.artifact(f.secondary.caseId,'EVALUATION');await f.change(f.secondary.caseId,{action:'advance',to_stage:'SHADOW_REVIEW',artifact_id:evaluation.manifest.artifact_id},'BRAIN');
    const a=await call('approvals',{role:'BRAIN',data:{request_id:f.id('shadow-approval'),case_id:f.secondary.caseId,expected_revision:(await call(`cases/${f.secondary.caseId}`)).revision,gate:'SHADOW',artifact_id:evaluation.manifest.artifact_id,recipient_id:'ocean-ui-strategy',authorized_tests:['SHADOW_FORWARD'],expires_at_utc:new Date(Date.now()+3600000).toISOString()}});
    const decision=await call('decisions',{data:{decision_id:f.id('shadow-decision'),case_id:f.secondary.caseId,request_id:a.request_id,expected_revision:(await call(`cases/${f.secondary.caseId}`)).revision,snapshot_hash:a.snapshot_hash,decision:'APPROVED',reason:'S22 synthetic fixture only'}});
    const p=await rm('preview',{selection:shadow});assert.equal(p.learner_permission,'FROZEN_EVALUATION');const r=await prepare(shadow);const l=await claim(r);await end(r,'CANCELLED');await progress(r,l,{source_market:[],strategy_execution:[],processing_review:[]},{watermark:null});await finish(r,l);
    await call('revocations',{data:{decision_id:decision.decision_id,reason:'S22 expiry/revocation regression'}});await rm('preview',{selection:shadow},409);
  });
  await check('ID-06 OPS-02 atomic reservations and authenticated observed activation',async()=>{
    const p=await rm('preview',{selection:baseSelection});
    const payload={selection:baseSelection,review_hash:p.review_hash,confirmed:true};
    const races=await Promise.all(['test-s22-main','test-s22-racing'].map(run_id=>rm('prepare',{...payload,run_id},[200,409])));
    assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);currentRun=races.find(r=>r.status===200).value;ids.push(currentRun.run_id);
    const other=await rm('preview',{selection:{...baseSelection,instance_id:'test-s22-second'}});assert.equal(other.can_prepare,false);assert.ok(other.conflicting_runs.includes(currentRun.run_id));
    assert.equal(currentRun.state,'READY');assert.equal(currentRun.reservation_is_actual_sierra_start,false);
    await rm('claim',{run_id:currentRun.run_id,expected_revision:1},403,'BRAIN');
    await rm('claim',{run_id:currentRun.run_id,expected_revision:1,strategy_id:second.profile.strategy_id},422,'TELEMETRY');
    await call(`run-manager/context/${currentRun.run_id}`,{role:null,expected:401});
    await call(`run-manager/context/${currentRun.run_id}`,{role:'TELEMETRY',headers:{'x-role':'HUMAN'},expected:403});
    await rm('preview',{selection:{...baseSelection,strategy_id:second.profile.strategy_id}},403);
    await rm('preview',{selection:{...baseSelection,instance_id:second.instance.execution_instance_id}},403);
    lease=await claim(currentRun);await rm('claim',{run_id:currentRun.run_id,expected_revision:1},409,'TELEMETRY');
    await rm('renew',{run_id:currentRun.run_id,lease_id:lease.lease_id},200,'TELEMETRY');
    await rm('activate',{run_id:currentRun.run_id,lease_id:lease.lease_id,expected_revision:1,observed_handshake:{instance:currentRun.plan.instance,context_hash:currentRun.context.context_hash,plan_hash:currentRun.plan.plan_hash,source_state:{observed_at_utc:new Date().toISOString(),environment:'LIVE_REAL',simulation:false,replay:false,account_alias:'Live',source_schema_version:'2.1.0',quality:'VERIFIED'}}},409,'TELEMETRY');
    await activate(currentRun,lease);
    await call('run-events',{data:{run_id:currentRun.run_id,expected_revision:2,state:'COMPLETED'},expected:409});
  });
  await check('DATA-08 pinned trade, missing progress and drain checks; all three completeness axes',async()=>{
    await pin(currentRun,lease,'trade-a');await record(currentRun,lease,'trade-a');await end(currentRun);
    await finish(currentRun,lease,409);await progress(currentRun,lease);await finish(currentRun,lease,409);
    await pin(currentRun,lease,'trade-a','CLOSED');
    await rm('pin',{run_id:currentRun.run_id,lease_id:lease.lease_id,trade_id:'trade-late-open',state:'OPEN',context_hash:currentRun.context.context_hash},409,'TELEMETRY');
    await progress(currentRun,lease,{source_market:[intervalA],strategy_execution:[intervalA],processing_review:[]});await finish(currentRun,lease,409);
    await progress(currentRun,lease);const done=await finish(currentRun,lease);assert.equal(done.state,'COMPLETED');assert.equal(done.unique_canonical_count,1);assert.equal(done.completion.unique_canonical_trade_count,1);
  });
  await check('DATA-09 repeated discovery, append-only enrichment, conflicts and unchanged market provenance',async()=>{
    const p=await rm('preview',{selection:baseSelection});assert.equal(p.can_prepare,false);assert.deepEqual(p.missing,[]);
    await rm('prepare',{run_id:f.id('covered'),selection:baseSelection,review_hash:p.review_hash,confirmed:true},409);
    const run=await prepare({...baseSelection,build_mode:'REPROCESS_EXISTING_HISTORY'});const l=await claim(run);await activate(run,l);await pin(run,l,'trade-b');
    const repeated=await record(run,l,'trade-b');const enriched=await record(run,l,'trade-b',{facts:{...facts,screenshot_hash:digest('synthetic image')}});assert.equal(repeated.canonical_id,enriched.canonical_id);
    await pin(run,l,'trade-b','CLOSED');await end(run);await progress(run,l);await finish(run,l);
    const db=new DatabaseSync(app.config.db_file,{readOnly:true});const count=db.prepare('SELECT COUNT(DISTINCT canonical_id) AS n FROM ow_evidence_revisions').get().n;db.close();assert.equal(count,1);
    const late=await claim(await getRun(run.run_id));const conflict=await record(run,late,'trade-b',{facts:{...facts,pnl:999}});assert.deepEqual(conflict.conflicting_fields,['pnl']);await finish(run,late,409);
    const source={...permissions['0-DISCOVERY'].manifest,dataset_manifest_id:'test-source-revision-2',source_revision:'test-revision-2'};source.manifest_hash=sealedHash(source,'manifest_hash');await call('datasets',{data:{strategy_id:first.profile.strategy_id,manifest:source}});
    await rm('permission',{...permissions['0-DISCOVERY'].permission,permission_id:'test-source-revision-permission',manifest_key:`${source.dataset_manifest_id}:${source.revision}`,manifest_hash:source.manifest_hash});
    const fresh=await rm('preview',{selection:{...baseSelection,permission_id:'test-source-revision-permission'}});assert.equal(fresh.already_covered.length,0);assert.notEqual(fresh.coverage_key,currentRun.plan.coverage_key);
  });
  await check('DATA-08 no-trade intervals, partial cancellation, lost completion and restart persistence',async()=>{
    const selection={...baseSelection,permission_id:'test-source-revision-permission'};const run=await prepare(selection);const l=await claim(run);await activate(run,l);await progress(run,l);
    const db=new DatabaseSync(app.config.db_file,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ow_coverage_receipts WHERE run_id=?').get(run.run_id).n,0);db.close();
    await end(run);const result=await finish(run,l);assert.equal(result.completion.no_trade_interval_count,1);assert.equal(result.completion.unique_canonical_trade_count,0);
    const {WorkflowBackend}=await import('./backend.mjs');const reopened=new WorkflowBackend({...app.config,python_executable:'python'},process.env);assert.equal(reopened.runs.read({role:'HUMAN'},run.run_id).completion.no_trade_interval_count,1);reopened.close();
    const partial=await prepare({...selection,build_mode:'FILL_DATA_GAPS'});const pl=await claim(partial);await activate(partial,pl);await end(partial,'CANCELLED');await progress(partial,pl,{source_market:[intervalA],strategy_execution:[],processing_review:[]},{gaps:['Replay stopped before processing']});const cancelled=await finish(partial,pl);assert.equal(cancelled.completion.status,'CANCELLED');assert.equal(cancelled.completion.observed_coverage.length,0);
  });
  await check('ID-06 OPS-02 stale lease fencing and identity revocation faults in isolated DB',async()=>{
    const run=await prepare({...baseSelection,build_mode:'FILL_DATA_GAPS'});const l=await claim(run);await activate(run,l);await pin(run,l,'lease-trade');
    const db=new DatabaseSync(app.config.db_file);db.prepare('UPDATE ow_run_leases SET expires_ms=0 WHERE id=?').run(run.run_id);db.close();
    await rm('renew',{run_id:run.run_id,lease_id:l.lease_id},409,'TELEMETRY');
    const renewed=await claim(await getRun(run.run_id));assert.notEqual(l.lease_id,renewed.lease_id);await rm('pin',{run_id:run.run_id,lease_id:l.lease_id,trade_id:'lease-trade',state:'CLOSED',context_hash:run.context.context_hash},409,'TELEMETRY');
    await record(run,renewed,'lease-trade');await pin(run,renewed,'lease-trade','CLOSED');await end(run,'CANCELLED');await progress(run,renewed);await finish(run,renewed);
    for(const scope of ['strategy','instance']) {
      const config=structuredClone(app.config);const identity=config.identities.find(i=>i.role==='TELEMETRY');const original=JSON.stringify(identity);
      if(scope==='strategy')identity.strategy_ids=[second.profile.strategy_id];else identity.instance_ids=[second.instance.execution_instance_id];
      const db2=new DatabaseSync(app.config.db_file);db2.prepare('UPDATE ow_identities SET metadata_json=? WHERE id=?').run(JSON.stringify(identity),identity.identity_id);
      const scoped=new WorkflowBackend({...config,python_executable:'python'},process.env);const server=http.createServer((req,res)=>void scoped.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      try {for(const route of [`context/${run.run_id}`,'claim']){const mutation=route==='claim';const response=await fetch(`http://127.0.0.1:${server.address().port}/api/workflow/run-manager/${route}`,{method:mutation?'POST':'GET',headers:{Authorization:`Bearer ${process.env.OCEAN_TELEMETRY_TOKEN}`,...(mutation?{'Content-Type':'application/json'}:{})},body:mutation?JSON.stringify({message_id:f.id('scope-probe'),data:{run_id:run.run_id,expected_revision:1}}):undefined});assert.equal(response.status,403);assert.equal((await response.json()).error.code,scope==='strategy'?'WRONG_STRATEGY_SCOPE':'WRONG_INSTANCE_SCOPE');}}
      finally{await new Promise(resolve=>server.close(resolve));scoped.close();db2.prepare('UPDATE ow_identities SET metadata_json=? WHERE id=?').run(original,identity.identity_id);db2.close();}
    }
  });
  await check('DATA-09 protected overlap across strategies/source revisions, interval algebra and immutable records',async()=>{
    assert.deepEqual(subtract([intervalA],[{start_utc:'2026-05-01T06:00:00Z',end_utc:'2026-05-01T12:00:00Z'}]).length,2);assert.equal(intersect([intervalA],[intervalA]).length,1);assert.equal(merge([intervalA,intervalA]).length,1);assert.throws(()=>interval({start_utc:'2026-05-01',end_utc:'2026-05-02'}));
    const segments=subtract([intervalA],[{start_utc:'2026-05-01T06:00:00Z',end_utc:'2026-05-01T12:00:00Z'}]);assert.equal(countNoTradeIntervals(segments,['2026-05-01T02:00:00.000Z']),1);assert.equal(countNoTradeIntervals(segments,[],1),0);
    const protectedManifest={...permissions['0-DISCOVERY'].manifest,dataset_manifest_id:'test-cross-strategy-holdout',source_revision:'another-revision',partitions:[{...intervalA,partition:'HOLDOUT',symbol:'MNQU26',coverage_status:'COMPLETE'}],protected_intervals:[intervalA]};protectedManifest.manifest_hash=sealedHash(protectedManifest,'manifest_hash');await call('datasets',{data:{strategy_id:second.profile.strategy_id,manifest:protectedManifest}});await rm('preview',{selection:baseSelection},403);
    const db=new DatabaseSync(app.config.db_file);for(const table of ['ow_run_plans','ow_coverage_receipts','ow_evidence_revisions'])assert.throws(()=>db.prepare(`DELETE FROM ${table}`).run(),/immutable/);db.close();
  });
  await check('ID-06 DATA-08 expired permission permits drain but blocks new pins; failed run preserves partial receipt',async()=>{
    const permission={...permissions['0-FORWARD'].permission,permission_id:'test-expiring-forward',expires_at_utc:new Date(Date.now()+2000).toISOString()};await rm('permission',permission);
    const selection={...baseSelection,expected_environment:'PAPER_FORWARD',purpose:'NOT_ELIGIBLE',permission_id:permission.permission_id,build_mode:null};
    const run=await prepare(selection);const l=await claim(run);await activate(run,l);await pin(run,l,'expiry-trade');await record(run,l,'expiry-trade');
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(permission.expires_at_utc)-Date.now()+50)));
    await rm('pin',{run_id:run.run_id,lease_id:l.lease_id,trade_id:'expiry-new',state:'OPEN',context_hash:run.context.context_hash},403,'TELEMETRY');await pin(run,l,'expiry-trade','CLOSED');await end(run,'FAILED');await progress(run,l,{source_market:[intervalA],strategy_execution:[],processing_review:[]},{watermark:null,failures:['Synthetic interrupted execution']});const result=await finish(run,l);assert.equal(result.state,'FAILED');assert.equal(result.completion.failures.length,1);assert.equal(result.completion.observed_coverage.length,0);
  });
  await check('UI-S22 actual Chrome wizard, scope changes, fresh confirmation, READY and mobile layout',async()=>{
    // Diagnostic scope on FORWARD avoids the deliberately protected discovery fixture above.
    browser=await app.chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});activePage=page;const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`${app.base}/improvement/runs`);await page.locator('#credential').fill(process.env.OCEAN_WAYNE_BROWSER_SECRET);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Prepare run',exact:true}).click();
    await page.locator('#run-environment').selectOption('PAPER_FORWARD');await page.locator('#run-purpose').selectOption('NOT_ELIGIBLE');await page.locator('#run-dataset').selectOption('test-permission-0-FORWARD:0');await page.locator('#run-next').click();
    await page.locator('#run-start').fill('2026-05-01T00:00');await page.locator('#run-end').fill('2026-05-02T00:00');await page.locator('#run-next').click();await page.waitForSelector('#run-review .facts');assert.equal(await page.locator('#run-next').isDisabled(),true);
    await page.screenshot({path:path.join(evidence,'s22-wizard-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'s22-wizard-mobile.png'),fullPage:true});assert.equal(await page.locator('#modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.locator('#run-save-name').fill('Forward diagnostic preset');await page.locator('#run-confirm').check();await page.locator('#run-next').click();await page.waitForURL(/\/improvement\/runs\/test-run-/);await page.getByText('Run control',{exact:true}).waitFor();assert.ok((await page.locator('#content').innerText()).includes('Awaiting telemetry'));
    await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(evidence,'s22-ready-desktop.png'),fullPage:true});assert.deepEqual(errors,[]);
    assert.equal(await page.locator('[data-action="end-run"] svg').count(),1);
    await page.getByRole('link',{name:'Runs',exact:true}).click();await page.getByRole('button',{name:'Prepare run',exact:true}).click();
    await page.locator('#run-preset').selectOption({label:'Forward diagnostic preset'});assert.equal(await page.locator('#run-environment').inputValue(),'PAPER_FORWARD');assert.equal(await page.locator('#run-confirm').isChecked(),false);await page.getByRole('button',{name:'Close',exact:true}).click();
    await browser.close();browser=null;
  });
  await check('DATA-09 changed code is a distinct outcome, shared market sample; warmup never scored',async()=>{
    const manifest={...permissions['0-DISCOVERY'].manifest,dataset_manifest_id:'test-code-lineage-source',source_id:'test-source-lineage'};manifest.manifest_hash=sealedHash(manifest,'manifest_hash');await call('datasets',{data:{strategy_id:first.profile.strategy_id,manifest}});
    const permission={...permissions['0-DISCOVERY'].permission,permission_id:'test-code-lineage-permission',manifest_key:`${manifest.dataset_manifest_id}:${manifest.revision}`,manifest_hash:manifest.manifest_hash};await rm('permission',permission);
    const selection={...baseSelection,instance_id:'test-s22-second',permission_id:permission.permission_id,interval:{start_utc:'2026-05-01T06:00:00Z',end_utc:intervalA.end_utc},warmup_interval:{start_utc:intervalA.start_utc,end_utc:'2026-05-01T06:00:00Z'}};
    const a=await prepare(selection);const al=await claim(a);await activate(a,al);await pin(a,al,'code-trade-1');await record(a,al,'code-trade-1',{},403);const one=await record(a,al,'code-trade-1',{entry_time_utc:'2026-05-01T07:00:00Z',exit_time_utc:'2026-05-01T08:00:00Z'});await pin(a,al,'code-trade-1','CLOSED');await end(a);await progress(a,al);await finish(a,al);
    const profile={...first.profile,profile_version:'test-profile-v2',baseline_version:'test-baseline-v2',strategy_code_hash:digest('S22 code revision two')};profile.profile_hash=sealedHash(profile,'profile_hash');await call('profiles',{data:{profile,file_sha256:digest(JSON.stringify(profile))}});
    const registry={...first.registry,registry_revision:2,baseline_version:profile.baseline_version,profile_version:profile.profile_version,profile_hash:profile.profile_hash};await call('strategies',{data:{registry,baseline_hash:profile.strategy_code_hash,expected_revision:1}});
    const instance={...first.instance,execution_instance_id:'test-s22-code2',chart_id:'test-s22-code2-chart',version_binding:profile.baseline_version};await call('instances',{data:{strategy_id:profile.strategy_id,instance}});
    await rm('settings',{instance_id:instance.execution_instance_id,chart_settings_hash:digest('same-settings'),time_basis:'UTC',session_calendar_revision:'TEST-24h-v1',fill_model_version:'TEST-FILL-v1'});
    await rm('version',{version_id:'test-code-lineage-v2',strategy_id:profile.strategy_id,kind:'BASELINE',version:profile.baseline_version,code_hash:profile.strategy_code_hash,profile_key:`${profile.profile_id}:${profile.profile_version}`,case_id:null,artifact_id:null});
    await rm('preview',{selection},409);
    const b=await prepare({...selection,version_id:'test-code-lineage-v2',instance_id:instance.execution_instance_id});const bl=await claim(b);await activate(b,bl);await pin(b,bl,'code-trade-2');const two=await record(b,bl,'code-trade-2',{entry_time_utc:'2026-05-01T07:00:00Z',exit_time_utc:'2026-05-01T08:00:00Z'});assert.notEqual(one.canonical_id,two.canonical_id);assert.equal(one.market_id,two.market_id);await pin(b,bl,'code-trade-2','CLOSED');await end(b);await progress(b,bl);await finish(b,bl);
  });
} catch(error) {console.error(error);process.exitCode=1;}
finally {
  if(process.exitCode&&activePage&&!activePage.isClosed()){await activePage.screenshot({path:path.join(evidence,`s22-browser-failure-${Date.now()}.png`),fullPage:true});console.error(await activePage.locator('#modal .form-error').textContent().catch(()=>''));}
  if(browser)await browser.close();if(app)await app.close();
  const output=path.join(evidence,'s22-runtime-results.json');
  if(fs.existsSync(output))fs.copyFileSync(output,path.join(evidence,`s22-prior-attempt-${Date.now()}.json`));
  fs.writeFileSync(output,JSON.stringify({status:process.exitCode?'FAILED':'PASS',tests:results,mocks:[],fault_injection:'Lease expiry and scope narrowing in isolated SQLite only',actual_ingestion:'OFF',production_services_changed:false},null,2));
  fs.writeFileSync(path.join(evidence,'api-runtime-examples.json'),JSON.stringify({test_type:'ACTUAL_HTTP_DATA_AND_RESPONSES; transport auth/envelope omitted',items:[...apiExamples.values()]},null,2));
}
