import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { WorkflowBackend } from './backend.mjs';
import { issueOceanIdentity, issueTestBrowserSecret } from './auth.mjs';
import { handleVwapImprovementRequest } from './vwap-improvement-status.mjs';
import { loadConfiguredVwapImprovementReports } from './vwap-improvement-reader.mjs';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';

// Disposable HTTP + real OceanAuth/WorkflowBackend only. No production config,
// credentials, service endpoints, source probes, strategy facts, or telemetry DB.
async function app(t){
  const cleanups=[],f=makeVwapStatusSoftwareFixture({after:cleanup=>cleanups.push(cleanup)});
  const now=Date.now();
  for(const document of Object.values(f.documents))document.generated_at_utc=new Date(now-60000).toISOString();
  f.manifest.published_at_utc=new Date(now-30000).toISOString();f.publish();
  const environment={OCEAN_VWAP_IMPROVEMENT_REPORT_CONFIG:f.configFile};let backend;
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url,`http://${request.headers.host}`);
    const fail=()=>{if(!response.headersSent)response.writeHead(500);response.end('{}');};
    if(url.pathname==='/api/vwap-improvement-monitor/status'){
      void handleVwapImprovementRequest(request,response,url,{loadConfigured:options=>
        loadConfiguredVwapImprovementReports({...options,configFile:f.configFile})}).catch(fail);return;
    }
    void backend.handle(request,response,url).then(handled=>{if(!handled)response.writeHead(404).end('{}');}).catch(fail);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));backend?.close();
    for(const cleanup of cleanups.reverse())cleanup();
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const config={test_only:true,contract_release:'2.1.0',db_file:path.join(f.root,'private-workflow.sqlite'),allowed_origins:[base],
    python_executable:'python',lease_ms:30000,onboarding_brain_sync:{enabled:false},operational_learning:{enabled:false},
    strategy_onboarding_root:path.join(f.root,'unused-onboarding'),
    browser:{subject_id:'wayne-ocean-ui',credential_ref:'OCEAN_WAYNE_BROWSER_SECRET'},
    identities:['BRAIN','TELEMETRY','STRATEGY'].map(role=>issueOceanIdentity({identity_id:`software-download-${role.toLowerCase()}`,
      role,namespace:'TEST',credential_ref:`OCEAN_${role}_TOKEN`,strategy_ids:[f.config.project_id],instance_ids:['test-download-instance']},
    environment,new Date(now+3600000).toISOString()))};
  issueTestBrowserSecret(environment,config.browser.credential_ref);backend=new WorkflowBackend(config,environment);
  const login=await fetch(`${base}/api/workflow/session`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
    body:JSON.stringify({credential:''}),signal:AbortSignal.timeout(5000)});
  assert.equal(login.status,200);const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'),/Path=\/api\/workflow; HttpOnly; SameSite=Strict/);
  const get=(route,{role='HUMAN',method='GET',headers={}}={})=>fetch(base+route,{method,signal:AbortSignal.timeout(5000),headers:{
    ...(role==='HUMAN'?{Cookie:cookie,Origin:base,'X-CSRF-Token':session.csrf_token}:role?{Authorization:`Bearer ${environment[`OCEAN_${role}_TOKEN`]}`} : {}),...headers}});
  const route=`/api/workflow/vwap-improvement-monitor/reports/cohort?publication_sha256=${f.config.publication_sha256}`;
  return {f,base,backend,environment,get,route};
}

test('real backend denies anonymous and every TEST service identity before serving raw report bytes',async t=>{
  const a=await app(t);
  const anonymous=await a.get(a.route,{role:null});assert.equal(anonymous.status,401);
  assert.equal((await anonymous.json()).error.code,'AUTHENTICATION_REQUIRED');
  for(const role of ['BRAIN','TELEMETRY','STRATEGY']){
    const denied=await a.get(a.route,{role});assert.equal(denied.status,403);
    const payload=await denied.json();assert.equal(payload.error.code,'WAYNE_BROWSER_ONLY');
    assert.ok(!JSON.stringify(payload).includes('net_ledger_units'));
    assert.ok(!JSON.stringify(payload).includes(a.environment[`OCEAN_${role}_TOKEN`]));
  }
  const publicStatus=await a.get('/api/vwap-improvement-monitor/status',{role:null});assert.equal(publicStatus.status,200);
  const publicProjection=await publicStatus.json();assert.equal(publicProjection.strategy_improvement.status,'STALLED');
  assert.ok(!JSON.stringify(publicProjection).includes('DO_NOT_PROJECT'));
  assert.equal((await a.get(`/api/vwap-improvement-monitor/reports/cohort?publication_sha256=${a.f.config.publication_sha256}`,{role:null})).status,404);
});

test('HUMAN session gets exact pinned bytes and safe attachment headers, while stale pin fails',async t=>{
  const a=await app(t),response=await a.get(a.route),expected=fs.readFileSync(path.join(a.f.root,'cohort.json'));
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
  assert.match(response.headers.get('content-disposition'),/^attachment; filename="vwap-cohort-[A-F0-9]{64}\.json"$/);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');
  const stale=await a.get(a.route.replace(a.f.config.publication_sha256,'A'.repeat(64)));
  assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'REPORT_PUBLICATION_CHANGED');
  fs.appendFileSync(path.join(a.f.root,'cohort.json'),' ');
  const tampered=await a.get(a.route);assert.equal(tampered.status,409);
  assert.ok(!JSON.stringify(await tampered.json()).includes(a.f.root));
});

test('report query exception admits exactly one publication pin and rejects arbitrary paths and traversal',async t=>{
  const a=await app(t),prefix='/api/workflow/vwap-improvement-monitor/reports/cohort';
  for(const route of [`${a.route}&path=C:/private`,`${a.route}&publication_sha256=${a.f.config.publication_sha256}`,
    `${prefix}?path=C:/private`,`${prefix}?publication_sha256=not-a-hash`,
    `/api/workflow/vwap-improvement-monitor/reports/cohort%2fsecret?publication_sha256=${a.f.config.publication_sha256}`,
    `/api/workflow/vwap-improvement-monitor/reports/cohort%5csecret?publication_sha256=${a.f.config.publication_sha256}`]){
    const response=await a.get(route);assert.equal(response.status,400,route);
    assert.equal((await response.json()).error.code,'UNSAFE_ROUTE_OR_QUERY');
  }
  assert.equal((await a.get(prefix)).status,404);
  assert.equal((await a.get(a.route.replace('/cohort?','/unknown_report?'))).status,404);
});

test('POST cannot use the report GET query exception and remains blocked after valid HUMAN CSRF authentication',async t=>{
  const a=await app(t);
  const queried=await a.get(a.route,{method:'POST'});assert.equal(queried.status,400);
  assert.equal((await queried.json()).error.code,'UNSAFE_ROUTE_OR_QUERY');
  const plain=await a.get('/api/workflow/vwap-improvement-monitor/reports/cohort',{method:'POST'});
  assert.equal(plain.status,405);assert.equal((await plain.json()).error.code,'METHOD_NOT_ALLOWED');
});

test('unrelated workflow routes retain their existing global query rejection',async t=>{
  const a=await app(t);
  const session=await a.get('/api/workflow/session');assert.equal(session.status,200);
  for(const suffix of [`?publication_sha256=${a.f.config.publication_sha256}`,'?resource_key=anything','?path=anything']){
    const rejected=await a.get('/api/workflow/session'+suffix);assert.equal(rejected.status,400);
    assert.equal((await rejected.json()).error.code,'UNSAFE_ROUTE_OR_QUERY');
  }
});
