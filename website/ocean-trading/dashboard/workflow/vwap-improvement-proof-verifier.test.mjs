import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalVwapProofJson, createVwapProofVerifier, deriveVwapDiscoveryLearningRows, VWAP_PROOF_PROJECT,
  VWAP_PROOF_DOMAIN, VWAP_PROOF_PROJECT_ROOT, VWAP_DISCOVERY_CUSTODY_PURPOSES } from './vwap-improvement-proof-verifier.mjs';

// These keys and all signed evidence are SYNTHETIC software fixtures. They do
// not designate an issuer or provision any operational trust policy.
const SYNTHETIC_RSA = crypto.generateKeyPairSync('rsa', { modulusLength:2048 });
const SYNTHETIC_UNIVERSE_RSA = crypto.generateKeyPairSync('rsa', { modulusLength:2048 });
const NOW = Date.parse('2026-10-29T14:00:00Z');
const SUBJECT = 'A'.repeat(64);
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
const json = value => Buffer.from(canonicalVwapProofJson(value) + '\n');
function fixture(t, mutatePolicy = () => {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'vwap-SYNTHETIC-proof-'));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const evidenceRoot = path.join(temp,'evidence'); fs.mkdirSync(evidenceRoot);
  const policy = { schema_version:'cicd-vwap-proof-trust-policy/v1', strategy_id:VWAP_PROOF_PROJECT,
    domain:VWAP_PROOF_DOMAIN, project_root:VWAP_PROOF_PROJECT_ROOT, evidence_class:'SYNTHETIC', max_age_seconds:86400,
    subject_contracts:Object.fromEntries(['improvement.review',...VWAP_DISCOVERY_CUSTODY_PURPOSES].map(purpose=>[purpose,{schema_versions:[purpose.startsWith('discovery.')?'cicd-vwap-discovery-manifest/v1':'SYNTHETIC-review-subject/v1']} ])),
    issuers:{ 'SYNTHETIC-TEST-ONLY':{ issuer:'synthetic-independent-fixture',
      public_key_pem:SYNTHETIC_RSA.publicKey.export({ type:'spki', format:'pem' }),
      allowed_purposes:['improvement.review',...VWAP_DISCOVERY_CUSTODY_PURPOSES],
      allowed_actor_ids:['SYNTHETIC-reviewer'],
      not_before_utc:'2026-10-28T00:00:00Z', not_after_utc:'2026-11-02T00:00:00Z', revoked:false } } };
  mutatePolicy(policy);
  const policyPath = path.join(temp,'SYNTHETIC-owner-policy.json'); fs.writeFileSync(policyPath,json(policy));
  const options = {policyPath,expectedPolicySha256:sha(fs.readFileSync(policyPath)),evidenceRoot,now:NOW};
  const claims = { strategy_id:VWAP_PROOF_PROJECT, domain:VWAP_PROOF_DOMAIN, project_root:VWAP_PROOF_PROJECT_ROOT,
    purpose:'improvement.review', subject_sha256:SUBJECT, receipt_id:'SYNTHETIC-receipt-1',
    subject_schema_version:'SYNTHETIC-review-subject/v1',
    issuer:'synthetic-independent-fixture', evidence_class:'SYNTHETIC',
    actor_id:'SYNTHETIC-reviewer',
    issued_at_utc:'2026-10-29T13:59:00Z', expires_at_utc:'2026-10-29T15:00:00Z', run_id:'SYNTHETIC-run',
    label:'SYNTHETIC — café 🧪', quantities:['0.52','1.04'], count:2 };
  const sign = (payload = claims, key = SYNTHETIC_RSA.privateKey) => ({schema_version:'cicd-vwap-signed-proof/v1',payload,
    signature:{algorithm:'RS256',key_id:'SYNTHETIC-TEST-ONLY',value:crypto.sign('RSA-SHA256',Buffer.from(canonicalVwapProofJson(payload)),{key,padding:crypto.constants.RSA_PKCS1_PADDING}).toString('base64')}});
  const write = (name,value) => { const raw = json(value), target=path.join(evidenceRoot,name);fs.writeFileSync(target,raw);return {id:name,path:name,sha256:sha(raw),byte_length:raw.length}; };
  return { temp,evidenceRoot,policy,policyPath,options,claims,sign,write };
}

test('SYNTHETIC standard RS256 returns frozen verified claims and pinned policy hash only', t => {
  const f=fixture(t), verify=createVwapProofVerifier(f.options), receipt=f.sign();
  const claims=verify(receipt,'improvement.review',SUBJECT.toLowerCase());
  assert.equal(claims.verified,true);assert.equal(claims.evidence_class,'SYNTHETIC');
  assert.equal(claims.trust_policy_sha256,f.options.expectedPolicySha256);
  assert.equal(verify.evidenceClass,'SYNTHETIC');assert.ok(Object.isFrozen(claims.quantities));
  receipt.payload.quantities[0]='999';assert.equal(claims.quantities[0],'0.52');
});

test('missing, changed, mismatched or evidence-supplied policy fails closed', t => {
  const f=fixture(t);
  assert.throws(()=>createVwapProofVerifier({evidenceRoot:f.evidenceRoot}),/SHA-256/);
  assert.throws(()=>createVwapProofVerifier({...f.options,expectedPolicySha256:'B'.repeat(64)}),/hash mismatch/);
  const inside=path.join(f.evidenceRoot,'policy.json');fs.copyFileSync(f.policyPath,inside);
  assert.throws(()=>createVwapProofVerifier({...f.options,policyPath:inside}),/outside evidence/);
  const verify=createVwapProofVerifier(f.options);fs.appendFileSync(f.policyPath,' ');
  assert.throws(()=>verify(f.sign(),'improvement.review',SUBJECT),/policy changed/);
  assert.throws(()=>createVwapProofVerifier({...f.options,maxTotalArtifactBytes:128*1024*1024+1}),/BOUNDS_INVALID/);
});

test('signature tampering, algorithm confusion, forged key and malformed base64 fail', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  for (const mutate of [r=>{r.payload.label='tampered';},r=>{r.signature.algorithm='HS256';},
    r=>{r.signature.key_id='attacker';},r=>{r.signature.value+='!';},r=>{r.signature.value='AAAA';}]) {
    const receipt=f.sign();mutate(receipt);assert.throws(()=>verify(receipt,'improvement.review',SUBJECT));
  }
  const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>verify(f.sign(f.claims,other.privateKey),'improvement.review',SUBJECT),/signature invalid/);
});

test('receipt scope, exact root, purpose, subject and evidence class are enforced', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  for (const changes of [{strategy_id:'other'}, {domain:'software'}, {project_root:VWAP_PROOF_PROJECT_ROOT.toLowerCase()},
    {purpose:'discovery.execution_costs'},{subject_sha256:'F'.repeat(64)}, {evidence_class:'AUTHENTICATED_SYSTEM'},
    {receipt_id:''},{issuer:'unknown'},{actor_id:'unauthorized'}]) {
    assert.throws(()=>verify(f.sign({...f.claims,...changes}),'improvement.review',SUBJECT));
  }
  assert.throws(()=>verify(f.sign({...f.claims,subject_schema_version:'unregistered/v1'}),'improvement.review',SUBJECT),/schema not registered/);
});

test('expiry, future, stale, excessive lifetime and invalid calendar timestamps fail', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  for (const changes of [{expires_at_utc:'2026-10-29T14:00:00Z'},
    {issued_at_utc:'2026-10-29T14:00:31Z'},{issued_at_utc:'2026-10-27T14:00:00Z'},
    {expires_at_utc:'2026-10-31T14:00:00Z'}, {issued_at_utc:'2026-02-30T00:00:00Z'},
    {issued_at_utc:'2026-10-29T13:59:00'}]) {
    assert.throws(()=>verify(f.sign({...f.claims,...changes}),'improvement.review',SUBJECT));
  }
});

test('owner key authorization, revocation and validity windows fail closed', t => {
  for (const mutate of [key=>{key.revoked=true;},key=>{key.allowed_purposes=[];},
    key=>{key.not_before_utc='2026-10-29T14:00:00Z';},key=>{key.not_after_utc='2026-10-29T14:30:00Z';}]) {
    const f=fixture(t,policy=>mutate(policy.issuers['SYNTHETIC-TEST-ONLY']));
    assert.throws(()=>createVwapProofVerifier(f.options)(f.sign(),'improvement.review',SUBJECT));
  }
});

test('undersized RSA issuer is rejected even with a valid fixture signature', t => {
  const key=crypto.generateKeyPairSync('rsa',{modulusLength:1024});
  const f=fixture(t,policy=>{policy.issuers['SYNTHETIC-TEST-ONLY'].public_key_pem=key.publicKey.export({type:'spki',format:'pem'});});
  assert.throws(()=>createVwapProofVerifier(f.options)(f.sign(f.claims,key.privateKey),'improvement.review',SUBJECT),/at least 2048/);
});

test('artifact references enforce regular bounded files, exact length and raw-byte hashes', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options),ref=f.write('original.json',{valid:true});
  assert.deepEqual(verify.verifyArtifact(ref).document,{valid:true});
  for (const change of [{sha256:'B'.repeat(64)},{byte_length:ref.byte_length+1}, {path:'../SYNTHETIC-owner-policy.json'},
    {id:''},{byte_length:-1},{path:'.'}]) assert.throws(()=>verify.verifyArtifact({...ref,...change}));
  assert.throws(()=>verify.verifyArtifact(ref,1),/byte_length/);
  fs.appendFileSync(path.join(f.evidenceRoot,ref.path),' ');
  assert.throws(()=>verify.verifyArtifact(ref),/SIZE_CONFLICT|HASH_CONFLICT/);
});

test('duplicate JSON keys and noninteroperable floating/unsafe numbers are rejected', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  for (const [index,raw] of ['{"a":1,"a":2}','{"a":{"key":1,"k\\u0065y":2}}','{"a":1.0}','{"a":9007199254740992}','{"a":-0}'].entries()) {
    const bytes=Buffer.from(raw),name=`bad-${index}.json`;fs.writeFileSync(path.join(f.evidenceRoot,name),bytes);
    assert.throws(()=>verify.verifyArtifact({id:name,path:name,byte_length:bytes.length,sha256:sha(bytes)}));
  }
  assert.throws(()=>canonicalVwapProofJson({value:NaN}));assert.throws(()=>canonicalVwapProofJson({value:0.5}));
});

test('symlinked policy, evidence roots and original paths are rejected', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options),ref=f.write('source.json',{valid:true});
  const alias=path.join(f.temp,'alias');fs.symlinkSync(f.evidenceRoot,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>createVwapProofVerifier({...f.options,evidenceRoot:alias}),/Symlink|reparse/);
  fs.symlinkSync(f.temp,path.join(f.evidenceRoot,'escape'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>verify.verifyArtifact({...ref,path:'escape/SYNTHETIC-owner-policy.json'}),/Symlink|reparse|ALIAS_PATH/);
});

test('SYNTHETIC trust can never qualify a market Discovery admission', async t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  await assert.rejects(verify.verifyDiscoveryAdmission({document:{schema_version:'cicd-vwap-discovery-admission/v1',
    strategy_id:VWAP_PROOF_PROJECT,domain:VWAP_PROOF_DOMAIN,project_root:VWAP_PROOF_PROJECT_ROOT,evidence_class:'OBSERVED'},report_sha256:SUBJECT}),/Synthetic evidence/);
});

test('Node and authoritative Python canonical bytes and RS256 signatures interoperate both ways', t => {
  const f=fixture(t),verify=createVwapProofVerifier(f.options);
  const contractRoot=process.env.VWAP_PYTHON_CONTRACT_ROOT;
  const python=process.env.VWAP_PROOF_TEST_PYTHON || 'python';
  assert.ok(contractRoot,'Set VWAP_PYTHON_CONTRACT_ROOT to the authoritative Optimization checkout');
  const script = String.raw`
import base64,datetime as dt,json,sys
from pathlib import Path
sys.stdin.reconfigure(encoding='utf-8')
sys.path.insert(0,sys.argv[1])
from scripts.vwap_improvement_contracts import canonical_bytes
from scripts.vwap_improvement_proofs import TrustedReceiptVerifier
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding
value=json.load(sys.stdin)
verifier=TrustedReceiptVerifier.from_policy(Path(value['policy_path']),value['policy_sha'],Path(value['evidence_root']),now=dt.datetime(2026,10,29,14,tzinfo=dt.timezone.utc))
claims=verifier(value['receipt'],'improvement.review','A'*64)
private=serialization.load_pem_private_key(value['synthetic_private_pem'].encode('ascii'),password=None)
receipt=value['receipt'];receipt['signature']['value']=base64.b64encode(private.sign(canonical_bytes(receipt['payload']),padding.PKCS1v15(),hashes.SHA256())).decode('ascii')
print(json.dumps({'canonical':canonical_bytes(value['canonical_probe']).decode('utf8'),'verified':claims['verified'],'receipt':receipt}))
`;
  const probe={'\uE000':'BMP','\u{10000}':'supplementary',text:'SYNTHETIC café 🧪',nested:{z:1,a:['1.00',null,true]}};
  const result=spawnSync(python,['-B','-c',script,contractRoot],{encoding:'utf8',timeout:20000,input:JSON.stringify({
    policy_path:f.policyPath,policy_sha:f.options.expectedPolicySha256,evidence_root:f.evidenceRoot,
    receipt:f.sign(),synthetic_private_pem:SYNTHETIC_RSA.privateKey.export({type:'pkcs8',format:'pem'}),canonical_probe:probe})});
  assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);
  assert.equal(output.canonical,canonicalVwapProofJson(probe));assert.equal(output.verified,true);
  assert.equal(verify(output.receipt,'improvement.review',SUBJECT).verified,true);
});

test('authoritative Python synthetic originals project identically; full signed chain never becomes market admission', async t => {
  const f=fixture(t,policy=>{policy.issuers['SYNTHETIC-MARKET-ONLY']={
    ...policy.issuers['SYNTHETIC-TEST-ONLY'],issuer:'synthetic-independent-market-fixture',
    public_key_pem:SYNTHETIC_UNIVERSE_RSA.publicKey.export({type:'spki',format:'pem'}),
    allowed_purposes:['discovery.market_universe']};});
  const verify=createVwapProofVerifier(f.options);
  const contractRoot=process.env.VWAP_PYTHON_CONTRACT_ROOT;
  const python=process.env.VWAP_PROOF_TEST_PYTHON || 'python';
  assert.ok(contractRoot,'Set VWAP_PYTHON_CONTRACT_ROOT to the authoritative Optimization checkout');
  const script=String.raw`
import copy,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from scripts.test_vwap_discovery_intake import build_pack
from scripts.vwap_discovery_intake import admit_discovery_pack,learning_rows
from scripts.vwap_improvement_contracts import canonical_bytes,read_json
root=Path(sys.argv[2]);pack=build_pack(root)
report=admit_discovery_pack(pack,root,software_fixture=True)
assert report['status']=='SOFTWARE_FIXTURE_VALIDATED',report
manifest=read_json(root/report['manifest_artifact']['path'])
originals={ref['role']:ref for ref in report['original_artifacts']}
artifacts={role:read_json(root/ref['path']) for role,ref in originals.items()}
cases=[]
for family,field,value in [('atr','prefix_evidence_status','SHORT_PREFIX'),('hmm','provenance_status','UNKNOWN'),('vwap','ready',False),('opportunity','opportunity_preconditions_met',False),('opportunity','proposal_state','NOT_APPLICABLE')]:
    changed=copy.deepcopy(artifacts)
    target=changed['opportunities']['records'][0] if family=='opportunity' else changed['features']['records'][0][family]
    target[field]=value
    opportunities={row['opportunity_key']:row for row in changed['opportunities']['records']}
    projection=learning_rows(manifest,opportunities,changed['features']['records'],changed['economics']['records'],originals,report['manifest_sha256'])
    cases.append({'artifacts':changed,'projection':projection})
print(json.dumps({'report':report,'projection_cases':cases}))
`;
  const result=spawnSync(python,['-B','-c',script,contractRoot,f.evidenceRoot],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout),report=output.report;
  const manifest=verify.verifyArtifact(report.manifest_artifact).document;
  const artifacts=Object.fromEntries(report.original_artifacts.map(ref=>[ref.role,verify.verifyArtifact(ref).document]));
  const refs=Object.fromEntries(report.original_artifacts.map(ref=>[ref.role,ref]));
  const projected=deriveVwapDiscoveryLearningRows(manifest,artifacts,refs,report.manifest_sha256);
  assert.equal(canonicalVwapProofJson(projected),canonicalVwapProofJson(report.learning_rows));
  assert.equal(sha(Buffer.from(canonicalVwapProofJson(projected.records))),report.learning_rows_sha256);
  assert.equal(typeof projected.records[0].research_eligible,'boolean');
  for (const item of output.projection_cases) {
    const derived=deriveVwapDiscoveryLearningRows(manifest,item.artifacts,refs,report.manifest_sha256);
    assert.equal(canonicalVwapProofJson(derived),canonicalVwapProofJson(item.projection));
    assert.equal(derived.records[0].research_eligible,false);
    assert.ok(derived.records[0].quality_flags.includes('pre_event_mechanism_evidence_incomplete'));
    assert.equal(derived.records[0].learning_context_complete,false);
  }
  assert.ok(projected.records.length>0);assert.equal(report.eligible_for_candidate_selection,false);
  const changed=structuredClone(artifacts);changed.economics.records.find(row=>row.status==='OBSERVED_CLOSED').net='999';
  assert.notEqual(canonicalVwapProofJson(deriveVwapDiscoveryLearningRows(manifest,changed,refs,report.manifest_sha256)),canonicalVwapProofJson(projected));
  assert.equal(report.project_root,VWAP_PROOF_PROJECT_ROOT,'Actual Python producer must supply its registered project root');
  report.signed_subject_sha256=report.manifest_sha256;
  report.learning_rows_artifact=f.write('learning-rows.json',report.learning_rows);
  report.custody_receipt_artifacts=VWAP_DISCOVERY_CUSTODY_PURPOSES.map((purpose,index)=>{
    const isMarket=purpose==='discovery.market_universe';
    const envelope=f.sign({...f.claims,purpose,subject_schema_version:manifest.schema_version,subject_sha256:report.manifest_sha256,
      issued_at_utc:purpose==='discovery.pre_outcome_freeze'?'2026-10-29T13:00:30Z':f.claims.issued_at_utc,
      run_id:manifest.run_id,receipt_id:`SYNTHETIC-custody-${index}`,issuer:isMarket?'synthetic-independent-market-fixture':f.claims.issuer},
      isMarket?SYNTHETIC_UNIVERSE_RSA.privateKey:SYNTHETIC_RSA.privateKey);
    if(isMarket) envelope.signature.key_id='SYNTHETIC-MARKET-ONLY';
    return f.write(`SYNTHETIC-custody-${index}.json`,envelope);
  });
  const call=document=>verify.verifyDiscoveryAdmission({document,report_sha256:sha(json(document)),manifest_sha256:document.manifest_sha256,learning_rows_sha256:document.learning_rows_sha256});
  const freezeIndex=report.custody_receipt_artifacts.findIndex(ref=>verify.verifyArtifact(ref).document.payload.purpose==='discovery.pre_outcome_freeze');
  const withSignedFreeze=(issued,id)=>{
    const modified=structuredClone(report),payload={...f.claims,purpose:'discovery.pre_outcome_freeze',
      subject_schema_version:manifest.schema_version,subject_sha256:report.manifest_sha256,run_id:manifest.run_id,
      receipt_id:`SYNTHETIC-freeze-${id}`,issued_at_utc:issued};
    const envelope=f.sign(payload);
    assert.equal(verify.verifyReceipt(envelope,'discovery.pre_outcome_freeze',report.manifest_sha256).verified,true,
      'The boundary case must have a genuine valid SYNTHETIC fixture signature');
    modified.custody_receipt_artifacts[freezeIndex]=f.write(`SYNTHETIC-freeze-${id}.json`,envelope);
    return modified;
  };
  await t.test('valid signed freeze can equal frozen time or precede outcome access while later unrelated custody remains valid',async()=>{
    for(const [index,issued] of ['2026-10-29T13:00:00Z','2026-10-29T13:00:30Z','2026-10-29T13:00:59.999999Z'].entries()){
      // Passing chronology must reach the final synthetic-only market boundary.
      // This establishes software acceptance of chronology, never market authority.
      await assert.rejects(call(withSignedFreeze(issued,`timely-${index}`)),/Synthetic evidence cannot qualify market research/);
    }
  });
  await t.test('actual signed chain rejects a backdated freeze attestation issued before freeze, at outcome access, or later',async()=>{
    for(const [index,issued] of ['2026-10-29T12:59:59Z','2026-10-29T13:01:00Z','2026-10-29T13:20:00Z'].entries()){
      await assert.rejects(call(withSignedFreeze(issued,`late-${index}`)),/Authenticated freeze must be sealed before outcome access/);
    }
  });
  await assert.rejects(call(report),/Synthetic evidence cannot qualify market research/);
  const wrongRoot=structuredClone(report);wrongRoot.project_root='C:\\another-project';
  await assert.rejects(call(wrongRoot),/scope mismatch/);
  const universe=artifacts.market_universe;
  const totalBytes=[report.manifest_artifact,...report.original_artifacts,universe.market_data_ref,universe.calendar_ref,
    ...report.custody_receipt_artifacts,report.learning_rows_artifact].reduce((total,ref)=>total+ref.byte_length,0);
  const limited=createVwapProofVerifier({...f.options,maxTotalArtifactBytes:totalBytes-1});
  await assert.rejects(limited.verifyDiscoveryAdmission({document:report,report_sha256:sha(json(report)),
    manifest_sha256:report.manifest_sha256,learning_rows_sha256:report.learning_rows_sha256}),/AGGREGATE_BYTE_LIMIT/);
  // A new admission receives a fresh budget; one call must never reset its
  // budget between manifest, originals, nested references, receipts and rows.
  await assert.rejects(call(report),/Synthetic evidence cannot qualify market research/);
  const badManifest=structuredClone(report);badManifest.manifest_sha256='F'.repeat(64);
  await assert.rejects(call(badManifest),/manifest hash/);
  const badLearning=structuredClone(report);badLearning.learning_rows.records[0].net_pnl='999';
  await assert.rejects(call(badLearning),/learning rows differ/);
  const missing=structuredClone(report);missing.custody_receipt_artifacts.pop();
  await assert.rejects(call(missing),/custody receipts required/);
  const duplicate=structuredClone(report);duplicate.custody_receipt_artifacts.push(duplicate.custody_receipt_artifacts[0]);
  await assert.rejects(call(duplicate),/purpose missing or duplicate/);
  const wrongRun=structuredClone(report);wrongRun.run_id='another-run';
  await assert.rejects(call(wrongRun),/manifest identity/);
  const corruptOriginal=structuredClone(report);corruptOriginal.original_artifacts[0].sha256='F'.repeat(64);
  await assert.rejects(call(corruptOriginal),/not bound to manifest/);
  const sameCustodian=structuredClone(report);
  const universeReceipt=f.sign({...f.claims,purpose:'discovery.market_universe',subject_schema_version:manifest.schema_version,
    subject_sha256:report.manifest_sha256,run_id:manifest.run_id,receipt_id:'SYNTHETIC-not-independent'});
  sameCustodian.custody_receipt_artifacts[sameCustodian.custody_receipt_artifacts.length-1]=f.write('SYNTHETIC-not-independent.json',universeReceipt);
  await assert.rejects(call(sameCustodian),/independent custody/);
  const wrongSource=structuredClone(report);wrongSource.source_binding.config_sha256='F'.repeat(64);
  await assert.rejects(call(wrongSource),/source binding mismatch/);
  const calendarPath=path.join(f.evidenceRoot,artifacts.market_universe.calendar_ref.path);
  fs.appendFileSync(calendarPath,' ');
  await assert.rejects(call(report),/SIZE_CONFLICT|HASH_CONFLICT/);
});
