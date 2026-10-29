import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { digest, objectHash } from './common.mjs';
import { canonicalVwapProofJson } from './vwap-improvement-proof-verifier.mjs';
import { OperationalCandidateEvaluator } from './operational-candidate-evaluation.mjs';
import { targetedEvaluationFixture } from './fixtures/vwap-targeted-evaluation-fixture.mjs';
import { VwapTargetedBrainClient,VWAP_TARGETED_BRAIN_ROUTE,VWAP_TARGETED_BRAIN_REQUEST,VWAP_TARGETED_BRAIN_RESULT,VWAP_TARGETED_BRAIN_SCHEMA_SHA256 } from './vwap-targeted-brain-client.mjs';

const sha=value=>digest(value).slice(7).toUpperCase();
const policy='A'.repeat(64),now=Date.parse('2026-10-29T10:00:00Z');
const authority={strategy_changed:false,candidate_approved:false,candidate_promoted:false,paper_authorized:false,live_authorized:false,normal_ingestion_enabled:false,runtime_trade_decision_dependency:false};
// Deliberately synthetic trusted-dependency fixtures. They authenticate no real
// issuer, service, physical run or deployed receiver; the HTTP stub is local.
function fixture(t){
  const f=targetedEvaluationFixture(t),evaluator=new OperationalCandidateEvaluator({config:{},db:null,operationalLearning:{},targetedReplayVerification:f.verification});
  const context={job:{id:'test-job'},snapshot:f.snapshot,effective:evaluator.effectiveConclusion(f.snapshot,{conclusion_type:'BENEFIT_SUPPORTED'})};
  assert.equal(context.effective.conclusion,'BENEFIT_SUPPORTED');
  const artifact=(artifact_id,value)=>{const content_json=typeof value==='string'?value:JSON.stringify(value);return {artifact_id,content_json,sha256:sha(content_json)};};
  const plan=artifact('plan',JSON.parse(f.snapshot.validation_plan.content_json).targeted_replay.plan);
  const protocolArtifact=artifact('protocol',fs.readFileSync(f.fixtures[0].input.protocol_ref.path,'utf8'));
  const candidate=artifact('candidate',{schema_version:'SOFTWARE_FIXTURE_ONLY',arm:'candidate'}),baseline=artifact('baseline',{schema_version:'SOFTWARE_FIXTURE_ONLY',arm:'baseline'});
  const bindings={candidate_sha256:f.snapshot.case.candidate_hash.slice(7).toUpperCase(),baseline_sha256:f.snapshot.case.baseline_hash.slice(7).toUpperCase(),
    config_sha256:f.fixtures[0].input.planBinding.plan.cases[0].config_sha256.slice(7).toUpperCase(),protocol_sha256:protocolArtifact.sha256,plan_sha256:plan.sha256};
  const source=[plan,protocolArtifact,candidate,baseline];
  const assessment=artifact('assessment',{schema_version:'vwap-targeted-evaluation-assessment/v1',...bindings,bindings,
    verdict:'PASS',ocean_assessment:context.effective.targeted_assessment,window_ids:['window-0','window-1','window-2','window-3'],
    evidence_artifact_sha256:source.map(a=>a.sha256).sort(),terminal_receipt_sha256:context.effective.targeted_physical_evidence.adapter_bindings.flatMap(b=>b.physical_runs.map(run=>run.terminal_receipt_sha256.slice(7).toUpperCase())).sort()});
  const request={schema_version:VWAP_TARGETED_BRAIN_REQUEST,project:f.snapshot.case.strategy_id,domain:'trading-strategy',strategy_id:f.snapshot.case.strategy_id,
    case_id:f.snapshot.case.case_id,job_id:'test-job',...bindings,assessment_sha256:assessment.sha256,artifacts:[...source,assessment],
    receipts:Array.from({length:8},(_,index)=>artifact('receipt-'+index,{schema_version:'cicd-vwap-signed-proof/v1',payload:{fixture:index},signature:{SOFTWARE_FIXTURE_ONLY:true}}))};
  const proof={verified:true,route:VWAP_TARGETED_BRAIN_ROUTE,schema_version:VWAP_TARGETED_BRAIN_REQUEST,schema_sha256:VWAP_TARGETED_BRAIN_SCHEMA_SHA256,
    deployed_source_sha256:'B'.repeat(64),trust_policy_sha256:policy,project:request.project,domain:'trading-strategy',project_root:String.raw`C:\Users\wayne\OneDrive\Documents\Brady - Optimization`,
    authentication:{scope:'TRADING',principal_id:'software-fixture-principal',strategy_ids:[request.strategy_id],credential_source:'OCEAN_OPERATIONAL_LEARNING_BRAIN_TOKEN_FILE'},
    verified_at_utc:'2026-10-29T09:59:00Z',expires_at_utc:'2026-10-29T10:10:00Z'};
  const options={now:()=>now,receiverSourceSha256:proof.deployed_source_sha256,trustPolicySha256:policy,verifyCompatibility:async()=>proof,evidenceBundleProvider:async()=>request,
    verifyEvidenceBundle:async({request})=>({verified:true,trust_policy_sha256:policy,assessment_sha256:request.assessment_sha256,input_sha256:sha(canonicalVwapProofJson(request))})};
  return {...f,context,request,proof,options};
}
function response(request){
  const input=sha(canonicalVwapProofJson(request));
  const admission={verdict:'PASS',window_count:4,physical_run_count:8,verdict_receipt_sha256:request.receipts.at(-1).sha256,
    artifact_sha256:request.artifacts.map(item=>item.sha256).sort(),receipt_sha256:request.receipts.map(item=>item.sha256).sort()};
  const content_json=canonicalVwapProofJson({schema_version:'brain-targeted-evaluation-content/v1',request,admission,trust_policy_sha256:policy,authority});
  return {schema_version:VWAP_TARGETED_BRAIN_RESULT,record_id:`TARGETED-EVALUATION-${input}`,input_sha256:input,content_sha256:sha(content_json),content_json,
    relative_path:`evidence/targeted-evaluations/${request.strategy_id}/records/${input.slice(0,24)}.md`,conclusion_type:'BENEFIT_SUPPORTED',admission,trust_policy_sha256:policy,authority,readback_verified:true};
}
test('sender is OFF by default and exact deployment/TRADING compatibility precedes all transport',async t=>{
  const f=fixture(t);let calls=0;
  await assert.rejects(new VwapTargetedBrainClient().prepare(f.context),{code:'VWAP_TARGETED_BRAIN_COMPATIBILITY_REQUIRED'});
  for(const mutate of [p=>{p.authentication.scope='PROJECT';},p=>{p.route='/trading/learning/candidate-evaluation';},p=>{p.schema_sha256='C'.repeat(64);},
    p=>{p.authentication.strategy_ids=['other'];},p=>{p.verified_at_utc='2026-10-28T00:00:00Z';},p=>{p.expires_at_utc='2026-10-29T09:00:00Z';},
    p=>{p.deployed_source_sha256='C'.repeat(64);},p=>{p.trust_policy_sha256='D'.repeat(64);}]){
    const proof=structuredClone(f.proof);mutate(proof);
    const client=new VwapTargetedBrainClient({...f.options,verifyCompatibility:async()=>proof,transport:async()=>{calls++;}});
    await assert.rejects(client.prepare(f.context),{code:'VWAP_TARGETED_BRAIN_COMPATIBILITY_UNPROVEN'});
  }
  assert.equal(calls,0);
});
test('tampered bytes, cross-project/candidate/job, changed math and unverifiable custody make zero calls',async t=>{
  const f=fixture(t);let calls=0;
  for(const mutate of [r=>{r.artifacts[0].content_json+=' ';},r=>{r.project='other';},r=>{r.candidate_sha256='F'.repeat(64);},r=>{r.job_id='other-job';},
    r=>{const a=r.artifacts.at(-1);const value=JSON.parse(a.content_json);value.ocean_assessment.candidate_net_pnl=999;a.content_json=JSON.stringify(value);a.sha256=sha(a.content_json);r.assessment_sha256=a.sha256;}]){
    const request=structuredClone(f.request);mutate(request);
    const client=new VwapTargetedBrainClient({...f.options,evidenceBundleProvider:async()=>request,transport:async()=>{calls++;}});
    await assert.rejects(client.prepare(f.context));
  }
  const client=new VwapTargetedBrainClient({...f.options,verifyEvidenceBundle:async()=>({verified:true}),transport:async()=>{calls++;}});
  await assert.rejects(client.prepare(f.context),{code:'VWAP_TARGETED_BRAIN_LOCAL_BUNDLE_AUTHENTICATION_REQUIRED'});assert.equal(calls,0);
});
test('typed software request uses the separate local HTTP route and exact immutable readback',async t=>{
  const f=fixture(t),requests=[];
  const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push({path:req.url,request:JSON.parse(body)});res.setHeader('content-type','application/json');res.end(JSON.stringify(response(JSON.parse(body))));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const transport=async({route,request})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});return r.json();};
  const client=new VwapTargetedBrainClient({...f.options,transport}),request=await client.prepare(f.context);
  const first=await client.exchange(request,f.context),readback=await client.exchange(request,f.context);
  assert.deepEqual(first,readback);assert.equal(requests.length,2);assert.ok(requests.every(item=>item.path===VWAP_TARGETED_BRAIN_ROUTE));
  assert.equal(first.authority.normal_ingestion_enabled,false);
  const altered={...first,readback_verified:false};assert.throws(()=>client.verifyResponse(altered,request,policy));
});

test('targeted delivery persists request/response/readback in the existing job and rejects changed retry input',async t=>{
  const f=fixture(t),db=new DatabaseSync(':memory:');t.after(()=>db.close());let calls=0,renewals=0;
  db.exec(`CREATE TABLE ow_candidate_evaluation_jobs(id TEXT PRIMARY KEY,state TEXT,lease_id TEXT,lease_until_ms INTEGER,case_id TEXT,candidate_hash TEXT,plan_hash TEXT,completion_event_id INTEGER,
    brain_request_json TEXT,brain_request_hash TEXT,brain_response_json TEXT,brain_response_hash TEXT,
    brain_record_id TEXT,brain_relative_path TEXT,brain_content_hash TEXT,brain_readback_json TEXT,brain_readback_hash TEXT);
    CREATE TABLE ow_cases(id TEXT PRIMARY KEY,stage TEXT,candidate_hash TEXT,baseline_hash TEXT);
    CREATE TABLE ow_events(id INTEGER PRIMARY KEY,entity_id TEXT,action TEXT);`);
  db.prepare('INSERT INTO ow_candidate_evaluation_jobs(id,state,lease_id,lease_until_ms,case_id,candidate_hash,plan_hash,completion_event_id) VALUES(?,?,?,?,?,?,?,?)')
    .run('test-job','RUNNING','lease',Date.now()+60000,f.snapshot.case.case_id,f.snapshot.case.candidate_hash,f.snapshot.validation_plan.plan_hash,1);
  db.prepare('INSERT INTO ow_cases VALUES(?,?,?,?)').run(f.snapshot.case.case_id,'CANDIDATE_EVALUATION',f.snapshot.case.candidate_hash,f.snapshot.case.baseline_hash);
  db.prepare('INSERT INTO ow_events VALUES(?,?,?)').run(1,f.snapshot.case.case_id,'operational.candidate.validation.completed');
  const client=new VwapTargetedBrainClient({...f.options,transport:async({request})=>{calls++;return response(request);}});
  const evaluator=new OperationalCandidateEvaluator({config:{},db,operationalLearning:{},targetedBrainClient:client,
    operationalCandidateDispatch:{validationPlan:()=>({plan_hash:f.snapshot.validation_plan.plan_hash})},
    one:(table,id)=>db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)});
  evaluator.renew=()=>{renewals++;}; // Lease fencing itself is covered by the existing evaluator suite.
  const job={id:'test-job',lease_id:'lease'};
  const first=await evaluator.recordTargetedInBrain(job,f.snapshot,f.context.effective);
  assert.equal(calls,2);assert.ok(renewals>=3);
  const stored=db.prepare('SELECT * FROM ow_candidate_evaluation_jobs').get();
  assert.equal(JSON.parse(stored.brain_request_json).schema_version,VWAP_TARGETED_BRAIN_REQUEST);
  assert.equal(stored.brain_record_id,first.record_id);assert.ok(stored.brain_readback_hash);
  const retry=await evaluator.recordTargetedInBrain(job,f.snapshot,f.context.effective);
  assert.deepEqual(retry,first);assert.equal(calls,2,'persisted exact readback requires no duplicate send');
  const altered=JSON.parse(f.request.receipts[0].content_json);altered.payload.fixture=999;
  f.request.receipts[0].content_json=JSON.stringify(altered);f.request.receipts[0].sha256=sha(f.request.receipts[0].content_json);
  await assert.rejects(evaluator.recordTargetedInBrain(job,f.snapshot,f.context.effective),{code:'CANDIDATE_EVALUATION_REQUEST_HASH_CONFLICT'});
  assert.equal(calls,2,'same job cannot send a changed immutable evidence request');
  db.prepare('INSERT INTO ow_events VALUES(?,?,?)').run(2,f.snapshot.case.case_id,'operational.candidate.validation.revalidation_required');
  await assert.rejects(evaluator.recordTargetedInBrain(job,f.snapshot,f.context.effective),{code:'CANDIDATE_EVALUATION_EVIDENCE_INVALIDATED'});
  assert.equal(calls,2,'a superseding lifecycle blocks delivery before transport');
});
