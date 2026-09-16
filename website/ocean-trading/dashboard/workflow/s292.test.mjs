import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {prepareOperation,commitOperation} from './operator.mjs';
import {setupOperation} from './setup-operator.mjs';
import {integrationOperation,integrationStatus} from './integration.mjs';
import {WorkflowBackend} from './backend.mjs';
import {WorkflowStore} from './store.mjs';
import {issueOceanIdentity} from './auth.mjs';
import {objectHash,digest,sealedHash} from './common.mjs';
import {operationalPolicy} from './operational-transition.mjs';
import {OperationalPreparation,RELEASE_SCOPES} from './operational-preparation.mjs';

const evidence=process.env.OCEAN_S292_EVIDENCE;
assert.ok(evidence,'Verified prerequisite evidence directory required');
const verified=JSON.parse(fs.readFileSync(path.join(evidence,'input-verification.json')));
const inputs=Array.isArray(verified)?verified:verified.results;
assert.ok(inputs?.length===10);
const snapshots=path.join(evidence,'../consumer-snapshots');
const doc=(task,name)=>JSON.parse(fs.readFileSync(path.join(snapshots,task,'artifacts',name)));
const request=task=>{const row=inputs.find(r=>r.task_id===task);return {task_id:task,bundle_path:row.path,bundle_sha256:row.sha256};};
const operator_id='S-1-5-21-1000';
const iso=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s292-'));
  const p=prepareOperation({action:'bootstrap',operator_id,root});commitOperation(p);
  return {root,state:p.next,close(){assert.ok(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}};
};
function consumers(state){
  const b=doc('S24.1','brain-ocean-binding.json').consumer_config;
  const g=doc('S26.2','gateway-provider-binding.json').ocean;
  const s=doc('S27.2','strategy-provider-binding.json');
  for(const [role,binding] of [['BRAIN',b],['TELEMETRY',g],['STRATEGY',{identity_id:s.tooling_identity,credential_ref:s.credential_reference,strategy_ids:[s.canonical_strategy_id],instance_ids:[s.test_communication_instance_id],scopes:s.scope}]]) {
    // These randomly issued fixture values never leave this temporary software store.
    state.config.identities.push(issueOceanIdentity({identity_id:binding.identity_id,role,namespace:'TEST',audience:'Ocean workflow TEST',credential_ref:binding.credential_ref,strategy_ids:binding.strategy_ids,instance_ids:binding.instance_ids,scopes:binding.scopes},state.environment,new Date(Date.now()+3600000).toISOString()));
  }
  const store=new WorkflowStore(state.config.db_file);for(const identity of state.config.identities)store.registerIdentity(identity);store.close();
}

test('S29.2 verified actual input imports: literal IDs, diagnostics, exact owners, duplicates and binding scopes',()=>{
  const a=iso();try{
    consumers(a.state);
    for(const input of inputs) {
      const args={state:a.state,operator_id,action:'setup-import',request:request(input.task_id)};
      assert.equal(setupOperation(args).idempotent,false);
      assert.equal(setupOperation(args).idempotent,true);
    }
    const all=setupOperation({state:a.state,operator_id,action:'setup-export'});
    assert.equal(all.items.length,10);
    for(const task of ['S23','S23.1','S24']) {
      const r=JSON.parse(all.items.find(r=>r.id===task).payload_json);assert.equal(r.status ?? r.final_status,'BLOCKED');
    }
    assert.throws(()=>setupOperation({state:a.state,operator_id,action:'setup-import',request:{...request('S23.3'),bundle_sha256:'0'.repeat(64)}}),/SETUP_BUNDLE_REJECTED/);
    assert.throws(()=>setupOperation({state:a.state,operator_id:'service',action:'setup-export'}),/WINDOWS_OPERATOR_SID_REQUIRED/);
    for(const task of ['S23.3','S24.1','S25.1','S26.2','S27.2','S28.2']) {
      const args={state:a.state,operator_id,action:'integration-import',request:request(task)};
      assert.equal(integrationOperation(args).idempotent,false);
      assert.equal(integrationOperation(args).idempotent,true);
    }
    const wrong=structuredClone(a.state);wrong.config.identities[0].scopes=['read'];
    assert.throws(()=>integrationOperation({state:wrong,operator_id,action:'integration-import',request:request('S24.1')}),/CONSUMER_SCOPE_CONFLICT/);
    const backend=new WorkflowBackend(a.state.config,a.state.environment);
    try {
      const status=integrationStatus(backend,{role:'HUMAN'});assert.equal(status.items.length,3);
      assert.ok(status.items.every(r=>r.credential_state==='READY' && !r.analysis_completion_claimed));
      const own=integrationStatus(backend,{role:'BRAIN',id:a.state.config.identities[0].identity_id,scopes:['read']});assert.equal(own.items.length,1);
      assert.equal(backend.db.prepare('SELECT COUNT(*) n FROM ow_operational_pending').get().n,2);
      for(const table of ['ow_runs','ow_decisions','ow_events','ow_datasets','ow_instances'])assert.equal(backend.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
    }finally{backend.close();}
  }finally{a.close();}
});

test('S29.2 unchanged legacy receipt remains idempotent without new metadata; conflicting receipt is rejected',()=>{
  const a=iso();try{
    const r=request('S23.3'),receipt=JSON.parse(fs.readFileSync(path.join(snapshots,'S23.3/receipt.json')));
    const store=new WorkflowStore(a.state.config.db_file);
    store.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run('S23.3',digest('old verification metadata'),JSON.stringify({...receipt,verified_bundle_sha256:r.bundle_sha256,operator_id}));store.close();
    assert.equal(setupOperation({state:a.state,operator_id,action:'setup-import',request:r}).idempotent,true);
    const other=iso();try {
      const db=new WorkflowStore(other.state.config.db_file);
      db.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run('S23.3',digest('different'),JSON.stringify({...receipt,status:'FAILED',verified_bundle_sha256:r.bundle_sha256,operator_id}));db.close();
      assert.throws(()=>setupOperation({state:other.state,operator_id,action:'setup-import',request:r}),/SETUP_RECEIPT_CONFLICT/);
    }finally{other.close();}
  }finally{a.close();}
});

test('S29.2 operational scope cannot be minted from current incomplete factual exports or TEST bindings',()=>{
  const a=iso();try {
    const proofFile=path.join(a.root,'owner.json');fs.writeFileSync(proofFile,'{}');
    const r={identity_id:'operational-caller',role:'TELEMETRY',namespace:'OPERATIONAL',credential_ref:'OCEAN_OPERATIONAL_FIXTURE_TOKEN',strategy_ids:['strategy_one'],instance_ids:['physical-one'],scopes:['read','event.write'],expires_at_utc:new Date(Date.now()+60000).toISOString(),owner:'Isolated fixture',evidence_path:proofFile,evidence_sha256:digest('{}').slice(7),factual_binding_hash:digest('missing')};
    assert.throws(()=>prepareOperation({action:'enroll',state:a.state,operator_id,root:a.root,request:r}),/VERIFIED_FACTUAL_BINDING_REQUIRED/);
    assert.throws(()=>prepareOperation({action:'register-facts',state:a.state,operator_id,root:a.root,request:doc('S27.2','strategy-factual-binding-attestation.json')}),/FACTUAL_BINDING_PROVENANCE_REJECTED/);
    assert.equal(a.state.config.identities.length,0);
    const p=operationalPolicy();assert.equal(p.modes.REPLAY.enabled,false);assert.equal(p.modes.PAPER_FORWARD.enabled,false);assert.equal(p.live_real,'DISABLED');
  }finally{a.close();}
});

test('S29.2 isolated real HTTP: service/browser isolation and disabled operational requests',async()=>{
  const a=iso();let backend;const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,`http://${req.headers.host}`)));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    consumers(a.state);a.state.config.allowed_origins=[base];backend=new WorkflowBackend(a.state.config,a.state.environment);
    const caller=a.state.config.identities[1],token=a.state.environment[caller.credential_ref];
    const call=async(route,body,headers={Authorization:`Bearer ${token}`})=>{
      const r=await fetch(base+'/api/workflow/'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};
    };
    assert.equal((await call('integrations/v1/status')).status,200);
    assert.equal((await call('integrations/v1/status',undefined,{})).status,401);
    assert.equal((await call('integrations/v1/status',undefined,{Authorization:'Bearer invalid'})).status,401);
    assert.equal((await call('integrations/v1/status',undefined,{Authorization:`Bearer ${token}`,Origin:base})).status,403);
    assert.equal((await call('setup-receipts')).status,403);
    const input={environment:'REPLAY',strategy_id:caller.strategy_ids[0],instance_id:caller.instance_ids[0],run_id:'run-one',context_hash:digest('one'),source_handshake:null};
    assert.equal((await call('operational/v1/context/resolve',input)).body.error.code,'TEST_IDENTITY_PROMOTION_REJECTED');
    assert.equal((await call('operational/v1/context/resolve',{...input,instance_id:'physical-one'})).body.error.code,'SEPARATE_OPERATIONAL_CREDENTIAL_REQUIRED');
    assert.equal((await call('operational/v1/activate',{...input,instance_id:'physical-one'})).body.error.code,'HUMAN_RELEASE_REQUIRED');
    assert.equal((await call('operational/v1/activate',{...input,environment:'LIVE_REAL'})).body.error.code,'LIVE_REAL_DISABLED');
    assert.equal((await call('operational/v1/dataset-manifests',{})).body.error.code,'BRAIN_PROPOSAL_SCOPE_REQUIRED');
    const brain=a.state.config.identities[0];
    const proposal={strategy_id:brain.strategy_ids[0],instance_id:brain.instance_ids[0],manifest_text:'{}',source_task:'S31.2',source_bundle_sha256:'0'.repeat(64),source_member:'artifacts/manifest.json'};
    assert.equal((await call('operational/v1/dataset-manifests',proposal,{Authorization:`Bearer ${a.state.environment[brain.credential_ref]}`})).body.error.code,'SEALED_DATASET_OWNER_RECEIPT_MISSING');
    for(const table of ['ow_runs','ow_events','ow_decisions'])assert.equal(backend.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  }finally{await new Promise(r=>server.close(r));backend?.close();a.close();}
});

test('S29.2 pending manifest validates exact source member bytes and remains ineligible across restart',()=>{
  const a=iso();let b;try{
    consumers(a.state);b=new WorkflowBackend(a.state.config,a.state.environment);
    const identity=a.state.config.identities[0],actor={id:identity.identity_id,role:'BRAIN',scopes:identity.scopes,strategyIds:identity.strategy_ids,instanceIds:identity.instance_ids};
    const examples=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url)));
    const manifest={...examples['dataset-manifest'],dataset_manifest_id:'isolated-proposed-dataset'};
    manifest.manifest_hash=sealedHash(manifest,'manifest_hash');const text=JSON.stringify(manifest);
    // Synthetic future owner receipt in this private test DB only, not S31.2 execution.
    const source='artifacts/proposed-manifest.json',hash=digest('isolated owner fixture').slice(7);
    b.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run('S31.2',digest('fixture'),JSON.stringify({task_id:'S31.2',status:'PASS',verified_bundle_sha256:hash,verified_members:{[source]:digest(text).slice(7)}}));
    const input={strategy_id:actor.strategyIds[0],instance_id:actor.instanceIds[0],manifest_text:text,source_task:'S31.2',source_bundle_sha256:hash,source_member:source};
    const first=b.operational.manifest(actor,input);assert.equal(first.runtime_eligible,false);assert.equal(first.learner_permission,'NONE');
    assert.equal(b.operational.manifest(actor,input).idempotent,true);
    assert.throws(()=>b.operational.manifest(actor,{...input,manifest_text:text+' '}),/MANIFEST_MEMBER_PROVENANCE_CONFLICT/);
    assert.throws(()=>b.operational.manifest(actor,{...input,strategy_id:'other_strategy'}),/WRONG_PROPOSAL_SCOPE/);
    b.close();b=new WorkflowBackend(a.state.config,a.state.environment);
    assert.equal(b.operational.pending(actor).items.length,1);
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM ow_datasets').get().n,0);
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM ow_decisions').get().n,0);
  }finally{b?.close();a.close();}
});

test('S29.2 dormant operational provider: independent pins, human gates, disabled default, durable isolated receipts',()=>{
  const a=iso();let b;try {
    b=new WorkflowBackend(a.state.config,a.state.environment);
    const e=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url)));
    let c={...e['run-context'],case_id:null,experiment_id:null,candidate_id:null};
    const m={...e['dataset-manifest'],quality_status:'VERIFIED',gaps:[],partitions:e['dataset-manifest'].partitions.map(p=>({...p,coverage_status:'COMPLETE'}))};
    m.manifest_hash=sealedHash(m,'manifest_hash');c.dataset_manifest_hash=m.manifest_hash;c.context_hash=sealedHash(c,'context_hash');
    const instance={execution_instance_id:c.execution_instance_id,strategy_id:c.strategy_id,source_installation_id:c.source_installation_id,chartbook_id:'isolated-chartbook',chart_id:'isolated-chart',source_study_instance_id:'isolated-study',telemetry_producer_id:'isolated-producer',version_binding:c.strategy_version,config_hash:c.strategy_config_hash,account_alias:'paper-account',capabilities:['PAPER_FORWARD','REPLAY'],status:'DRAFT',lease_run_id:null};
    const profile={...e['strategy-profile'],strategy_id:c.strategy_id,profile_id:c.strategy_profile_id,profile_version:c.strategy_profile_version};profile.profile_hash=sealedHash(profile,'profile_hash');
    const binding={instance,strategy_id:c.strategy_id,strategy_code_hash:c.strategy_code_hash,profile_hash:profile.profile_hash,state:'VERIFIED_FACTS_ONLY'};binding.binding_hash=objectHash(binding);
    b.config.operational_factual_bindings=[binding];
    const actor={id:'isolated-producer',role:'TELEMETRY',namespace:'OPERATIONAL',audience:'Ocean workflow operational v1',strategyIds:[c.strategy_id],instanceIds:[instance.execution_instance_id],scopes:['read','event.write'],factualBindingHash:binding.binding_hash};
    const observed={...c.observed_source_state,observed_at_utc:new Date().toISOString()};
    c.observed_source_state={observed_at_utc:new Date().toISOString(),environment:'UNKNOWN',quality:'UNKNOWN',simulation:null,replay:null,account_alias:null,source_schema_version:null};
    // Isolated source/proposal fixtures only. Decisions and READY use the real provider methods.
    b.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(`${c.strategy_profile_id}:${c.strategy_profile_version}`,c.strategy_id,c.strategy_profile_version,objectHash(profile),JSON.stringify(profile));
    b.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(c.strategy_id,`${c.strategy_profile_id}:${c.strategy_profile_version}`,1,c.strategy_code_hash,'{}');
    b.db.prepare('INSERT INTO ow_operational_pending VALUES(?,?,?,?,?,?)').run(m.dataset_manifest_id,c.strategy_id,'DATASET_MANIFEST',objectHash(m),JSON.stringify({manifest_text:JSON.stringify(m)}),new Date().toISOString());
    const prep=new OperationalPreparation(b),human={role:'HUMAN',id:'wayne-ocean-ui'};
    const proposal={context:c,manifest_key:m.dataset_manifest_id,factual_binding_hash:binding.binding_hash,interval:{start_utc:'2026-09-01T00:00:00Z',end_utc:'2026-09-02T00:00:00Z'},prior_exposure:'UNKNOWN',expires_at_utc:new Date(Date.now()+3600000).toISOString()};
    const reviewed=prep.perform('reviews',human,proposal),request={review:proposal,review_hash:reviewed.review_hash};
    assert.throws(()=>prep.perform('runs/prepare',human,request),/STRATEGY_ONBOARDING_REQUIRED/);
    assert.throws(()=>prep.perform('reviews',actor,proposal),/WAYNE_BROWSER_ONLY/);
    for(const scope of RELEASE_SCOPES) {
      const decision={...request,decision_id:'isolated-'+scope,scope,decision:'APPROVED',reason:'ISOLATED FIXTURE, NOT WAYNE PARTICIPATION'};
      assert.throws(()=>prep.perform('decisions',actor,decision),/WAYNE_BROWSER_ONLY/);
      prep.perform('decisions',human,decision);
    }
    const ready=prep.perform('runs/prepare',human,request);assert.equal(ready.state,'READY');assert.equal(ready.actual_source_start,false);
    assert.equal(prep.perform('runs/prepare',human,request).idempotent,true);c=ready.context;
    const input={environment:c.expected_environment,strategy_id:c.strategy_id,instance_id:instance.execution_instance_id,run_id:c.run_id,context_hash:c.context_hash,source_handshake:{instance,context_hash:c.context_hash,source_state:observed}};
    assert.throws(()=>b.operational.perform('context/resolve',actor,input),/OPERATIONAL_RELEASE_DISABLED/);
    b.operational.perform('activate',human,input);
    assert.equal(b.operational.perform('context/resolve',actor,input).context.context_hash,c.context_hash);
    assert.throws(()=>b.operational.perform('activate',actor,input),/HUMAN_RELEASE_REQUIRED/);
    assert.throws(()=>b.operational.perform('context/resolve',{...actor,strategyIds:['other']},input),/OPERATIONAL_SCOPE_CONFLICT/);
    assert.throws(()=>b.operational.perform('context/resolve',{...actor,id:'other-producer'},input),/OBSERVED_PRODUCER_REQUIRED/);
    assert.throws(()=>b.operational.perform('context/resolve',actor,{...input,context_hash:digest('other')}),/PINNED_CONTEXT_CONFLICT/);
    assert.throws(()=>b.operational.perform('context/resolve',actor,{...input,source_handshake:{...input.source_handshake,source_state:{...input.source_handshake.source_state,replay:true}}}),/OPERATIONAL_SOURCE_HANDSHAKE_CONFLICT/);
    const event={...e['workflow-event'],...c,event_id:'isolated-event',producer_id:actor.id,actor_role:'TELEMETRY',run_context_hash:c.context_hash,run_context_revision:c.revision};
    for(const key of Object.keys(c))if(!(key in e['workflow-event']))delete event[key];event.payload_hash=sealedHash(event,'payload_hash');
    const first=b.operational.perform('events',actor,{...input,event});assert.equal(first.persisted,true);assert.equal(first.analysis_complete,false);assert.equal(first.dispatch_state,'DISABLED');
    assert.deepEqual(b.operational.perform('events',actor,{...input,event}),first);
    const changed={...event,source_sequence:2};changed.payload_hash=sealedHash(changed,'payload_hash');
    assert.throws(()=>b.operational.perform('events',actor,{...input,event:changed}),/OPERATIONAL_EVENT_CONFLICT/);
    prep.perform('decisions/revoke',human,{decision_id:'isolated-RUN_RELEASE',reason:'fixture revoked'});
    assert.throws(()=>b.operational.perform('events',actor,{...input,event}),/RUN_RELEASE_REQUIRED/);
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM ow_test_receipts').get().n,0);
  }finally{b?.close();a.close();}
});

test('S29.2 isolated Chrome setup-history projection of verified receipts, without Wayne enrollment',async()=>{
  const {chromium}=await import('@playwright/test');const a=iso();let backend,browser;
  const publicRoot=path.resolve('website/ocean-trading/dashboard/public/workflow');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,`http://${req.headers.host}`);
    if(url.pathname.startsWith('/api/workflow/')){void backend.handle(req,res,url);return;}
    const file=url.pathname.startsWith('/workflow/')?url.pathname.slice(10):'index.html';
    if(url.pathname==='/assets/ocean-trading-icon.png'){res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(path.join(publicRoot,'../assets/ocean-trading-icon.png')));return;}
    if(!['index.html','ui.js','ui.css','icons.js','run-wizard.js'].includes(file)){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(publicRoot,file)));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const password=`isolated-${randomUUID()}`;
    const p=prepareOperation({action:'initialize',state:a.state,operator_id,root:a.root,password});commitOperation(p);a.state=p.next;
    for(const row of inputs)setupOperation({state:a.state,operator_id,action:'setup-import',request:request(row.task_id)});
    backend=new WorkflowBackend({...a.state.config,allowed_origins:[base]},a.state.environment);
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(base+'/improvement/history');await page.locator('#credential').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('#setup-history summary').click();await page.getByText('Historical installation records. Not strategy approvals.',{exact:true}).waitFor();
    const ids=await page.locator('#setup-history tbody tr td:first-child').allTextContents();assert.equal(ids.length,10);assert.ok(ids.includes('S24.1') && ids.includes('S26.2') && ids.includes('S28.2'));
    assert.ok(!(await page.content()).includes(password));
    await page.screenshot({path:path.join(evidence,'s292-isolated-history.png'),fullPage:true});
  }finally{await browser?.close();await new Promise(r=>server.close(r));backend?.close();a.close();}
});
