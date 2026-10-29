import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { loadConfiguredVwapImprovementReports } from './vwap-improvement-reader.mjs';
import { readVwapImprovementStatus, readVwapImprovementReport, handleVwapImprovementRequest,
  projectVwapImprovementStatus } from './vwap-improvement-status.mjs';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';

test('unsigned integrity diagnostics preserve legacy fields and never promote raw complete/gate flags',async t=>{
  const f=makeVwapStatusSoftwareFixture(t),legacy={schema_version:'legacy/v1',status:'HEALTHY',observed_trade_count:245};
  const result=await readVwapImprovementStatus({legacyState:legacy,websiteMonitor:{status:'HEALTHY'},loadConfigured:f.loadConfigured,now:f.now});
  assert.equal(result.schema_version,'legacy/v1');assert.equal(result.observed_trade_count,245);
  assert.equal(result.website_monitor.status,'HEALTHY');assert.equal(result.evidence_ingestion.status,'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY');
  assert.equal(result.strategy_improvement.status,'STALLED');assert.equal(result.strategy_improvement.proof_status,'UNPROVED');
  assert.equal(result.strategy_improvement.owner,'Protected host custodian');assert.equal(result.observed_economics.closed_trade_count,46);
  assert.equal(result.observed_economics.chart_start,'2026-10-14');assert.equal(result.observed_economics.chart_end,'2026-10-28');
  assert.equal(result.observed_economics.open_excluded,1);
  assert.equal(result.observed_economics.cohort_net,'-2618.86');assert.equal(result.observed_economics.currency,'UNKNOWN');
  const text=JSON.stringify(result);for(const privateValue of ['DO_NOT_PROJECT','database_path','D:\\private','api_token','project_root'])assert.ok(!text.includes(privateValue));
  assert.equal(result.verified_report_links.length,4);assert.ok(result.verified_report_links.every(link=>!Object.hasOwn(link,'path')));
});

test('missing configuration and reader failures stay unavailable/stalled and hide filesystem errors',async()=>{
  const missing=await readVwapImprovementStatus({loadConfigured:options=>loadConfiguredVwapImprovementReports({...options,configFile:null})});
  assert.equal(missing.evidence_ingestion.status,'NOT_CONFIGURED');assert.equal(missing.strategy_improvement.status,'STALLED');
  const failed=await readVwapImprovementStatus({loadConfigured:()=>{throw new Error('C:\\private\\token.txt');}});
  assert.equal(failed.evidence_ingestion.status,'UNAVAILABLE');assert.ok(!JSON.stringify(failed).includes('private'));
  const unsafe=projectVwapImprovementStatus({ingestion:{status:'BLOCKED',blockers:[{code:'C:\\private'}]},reports:{}});
  assert.equal(unsafe.evidence_ingestion.blockers[0].code,'REPORT_READ_FAILED');
});

test('synthetic reports remain software-only even with an injected complete-chain claim',async t=>{
  const f=makeVwapStatusSoftwareFixture(t,{synthetic:true});
  const loaded=await f.loadConfigured({now:f.now});
  const result=projectVwapImprovementStatus(loaded,{now:f.now,verifiedChain:{verified:true,project_id:f.config.project_id,
    publication_sha256:f.config.publication_sha256,proof_sha256:'A'.repeat(64),evidence_class:'OBSERVED',
    material_improvement_proved:true,status:'COMPLETE_FROM_VERIFIED_PROOFS',expires_at_utc:'2026-10-29T12:10:00Z'}});
  assert.equal(result.strategy_improvement.evidence_class,'SOFTWARE_ONLY');assert.equal(result.strategy_improvement.status,'STALLED');
});

test('serialized report flags cannot replace loader provenance in a public projection',async t=>{
  const f=makeVwapStatusSoftwareFixture(t),loaded=await f.loadConfigured({now:f.now});
  const result=projectVwapImprovementStatus(structuredClone(loaded),{now:f.now});
  assert.equal(result.evidence_ingestion.status,'BLOCKED');assert.equal(result.observed_economics.closed_trade_count,null);
  assert.equal(result.strategy_improvement.status,'STALLED');assert.deepEqual(result.verified_report_links,[]);
});

test('controlled downloads revalidate publication pin, content, scope, and freshness',async t=>{
  const f=makeVwapStatusSoftwareFixture(t),options={loadConfigured:f.loadConfigured,now:f.now};
  const valid=await readVwapImprovementReport('cohort',f.config.publication_sha256,options);
  assert.equal(valid.status,200);assert.equal(JSON.parse(valid.bytes).closed,46);
  assert.equal((await readVwapImprovementReport('../reader',f.config.publication_sha256,options)).status,404);
  assert.equal((await readVwapImprovementReport('cohort','A'.repeat(64),options)).status,409);
  fs.appendFileSync(path.join(f.root,'cohort.json'),' ');
  assert.equal((await readVwapImprovementReport('cohort',f.config.publication_sha256,options)).status,409);
  f.publish();assert.equal((await readVwapImprovementReport('cohort',f.config.publication_sha256,{...options,now:f.now+3600000})).status,409);
});

test('HTTP promise handler serves status/download without accepting file paths or POST',async t=>{
  const f=makeVwapStatusSoftwareFixture(t),server=http.createServer((req,res)=>{
    void handleVwapImprovementRequest(req,res,new URL(req.url,'http://fixture'),{loadConfigured:f.loadConfigured,now:f.now,
      legacyState:{schema_version:'legacy/v1',status:'HEALTHY'}}).catch(()=>res.writeHead(500).end());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const status=await fetch(`${base}/api/vwap-improvement-monitor/status`);assert.equal(status.status,200);
  const payload=await status.json();assert.equal(payload.strategy_improvement.status,'STALLED');
  const download=await fetch(base+payload.verified_report_links.find(link=>link.kind==='cohort').href);
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment; filename="vwap-cohort-/);
  assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await fetch(`${base}/api/workflow/vwap-improvement-monitor/reports/cohort?path=C:/private`)).status,404);
  assert.equal((await fetch(`${base}/api/vwap-improvement-monitor/status`,{method:'POST'})).status,405);
});
