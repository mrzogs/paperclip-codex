import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readVwapImprovementReaderConfig, loadConfiguredVwapImprovementReports,
  loadConfiguredVwapDiscoveryAdmission } from './vwap-improvement-reader.mjs';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';
import { discoveryFixture, FIXTURE_NOW } from './fixtures/vwap-discovery-fixture.mjs';
import { verifiedVwapDiscoveryRows } from './vwap-discovery-admission.mjs';
import { VWAP_PROOF_PROJECT, VWAP_PROOF_DOMAIN, VWAP_PROOF_PROJECT_ROOT } from './vwap-improvement-proof-verifier.mjs';

const learningRows=()=>[{trade_id:'trade-1',strategy_id:VWAP_PROOF_PROJECT,run_id:'reader-software-run',
  dataset_role:'DISCOVERY',environment:'REPLAY',session_id:'session-1',net_pnl:'-1.04',research_eligible:true,learning_context_complete:true}];
async function admissionConfig(t){
  const f=await discoveryFixture(t,learningRows(),{projectRoot:VWAP_PROOF_PROJECT_ROOT,unsignedPublication:true});
  const config={schema_version:'ocean-vwap-improvement-report-reader/v1',project_id:VWAP_PROOF_PROJECT,domain:VWAP_PROOF_DOMAIN,
    project_root:VWAP_PROOF_PROJECT_ROOT,evidence_root:f.root,manifest_path:'publication.json',publication_sha256:f.loaded.publication_sha256,
    publication_schema:'cicd-vwap-report-publication/v1',report_schemas:{discovery_admission:'cicd-vwap-discovery-admission/v1',learning_rows:'cicd-vwap-learning-rows/v1'},
    required_kinds:['discovery_admission','learning_rows'],max_age_ms:900000,max_bytes:1048576,max_total_bytes:8388608,
    trust_policy_file:path.join(f.root,'missing-owner-policy.json'),trust_policy_sha256:'A'.repeat(64),
    baseline_sha256:f.options.baselineSha256,config_sha256:f.options.configSha256};
  const configFile=path.join(f.root,'reader.json'),write=()=>fs.writeFileSync(configFile,JSON.stringify(config));write();
  const operatorBinding={evidence_root:f.root,trust_policy_file:config.trust_policy_file,trust_policy_sha256:config.trust_policy_sha256,
    baseline_sha256:config.baseline_sha256,config_sha256:config.config_sha256};
  const semanticOptions={semanticConfigFile:path.join(path.dirname(f.root),'website-owned-semantic.json'),semanticConfigSha256:'B'.repeat(64),
    createSemanticAdapter:()=>Object.assign(async()=>{throw new Error('software verifier mock must not execute Python');},
      {admissionBinding:operatorBinding})};
  return {...f,config,configFile,write,semanticOptions};
}

test('missing operator configuration is NOT_CONFIGURED and cannot admit rows',async()=>{
  const loaded=await loadConfiguredVwapImprovementReports({configFile:null});assert.equal(loaded.ingestion.status,'NOT_CONFIGURED');
  assert.deepEqual(loaded.reports,{});
  const admission=await loadConfiguredVwapDiscoveryAdmission({configFile:null});assert.equal(admission.admitted,false);assert.equal(admission.admission,null);
});

test('operator config strictly binds schema, canonical project scope, publication hash and bounded limits',t=>{
  const f=makeVwapStatusSoftwareFixture(t),original=structuredClone(f.config);
  assert.equal(readVwapImprovementReaderConfig(f.configFile).project_root,VWAP_PROOF_PROJECT_ROOT);
  for(const patch of [{schema_version:'other/v1'},{project_id:'other'},{domain:'other'},{project_root:'C:\\other'},
    {publication_sha256:'sha256:'+'A'.repeat(64)},{publication_schema:'other/v1'},{report_schemas:{cohort:''}},
    {required_kinds:['not-published']},{max_age_ms:86400001},{max_bytes:0},{max_total_bytes:129*1024*1024}]){
    fs.writeFileSync(f.configFile,JSON.stringify({...original,...patch}));assert.throws(()=>readVwapImprovementReaderConfig(f.configFile));
  }
  fs.writeFileSync(f.configFile,' '.repeat(65537));assert.throws(()=>readVwapImprovementReaderConfig(f.configFile),/CONFIG_SIZE/);
  fs.writeFileSync(f.configFile,JSON.stringify(original));
  assert.throws(()=>readVwapImprovementReaderConfig('reader.json'),/CONFIG_PATH_REQUIRED/);
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias,'junction');
  assert.throws(()=>readVwapImprovementReaderConfig(path.join(alias,'reader.json')),/CONFIG_ALIAS/);
});

test('configured unsigned diagnostics stay visible without authenticating an improvement or Discovery gate',async t=>{
  const f=makeVwapStatusSoftwareFixture(t),result=await loadConfiguredVwapImprovementReports({configFile:f.configFile,now:f.now});
  assert.equal(result.ingestion.status,'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY');assert.equal(result.reports.cohort.document.closed,46);
  assert.equal(result.config.publication_sha256,f.config.publication_sha256);
  const admission=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:f.now,
    createSemanticAdapter:()=>{throw new Error('diagnostics must never start Python');}});
  assert.equal(admission.admitted,false);assert.equal(admission.blockers[0].code,'DISCOVERY_PUBLISHED_REPORTS_REQUIRED');
  f.config.publication_sha256='A'.repeat(64);fs.writeFileSync(f.configFile,JSON.stringify(f.config));
  const tampered=await loadConfiguredVwapImprovementReports({configFile:f.configFile,now:f.now});
  assert.equal(tampered.ingestion.status,'BLOCKED');assert.deepEqual(tampered.reports,{});
});

test('missing Website semantic descriptor and unavailable authentication fail closed despite publisher authority flags',async t=>{
  const f=await admissionConfig(t);f.config.verified=true;f.config.admitted=true;f.write();
  let verifierCalls=0;
  const missing=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:FIXTURE_NOW,
    semanticConfigFile:null,semanticConfigSha256:null,
    createVerifier:()=>{verifierCalls++;throw new Error('must not be called');}});
  assert.equal(missing.admitted,false);assert.equal(missing.blockers[0].code,'DISCOVERY_SEMANTIC_CONFIG_REQUIRED');assert.equal(verifierCalls,0);
  const unavailable=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:FIXTURE_NOW,...f.semanticOptions});
  assert.equal(unavailable.admitted,false);assert.equal(unavailable.admission,null);
  const badVerifier=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:FIXTURE_NOW,
    ...f.semanticOptions,
    createVerifier:()=>({verifyDiscoveryAdmission:()=>({verified:true})})});
  assert.equal(badVerifier.admitted,false);assert.equal(badVerifier.blockers[0].code,'DISCOVERY_RECEIPT_BINDING_MISMATCH');
});

test('publisher cannot replace Website-owned source, policy or semantic execution bindings',async t=>{
  const f=await admissionConfig(t);let captured;
  Object.assign(f.config,{trust_policy_file:'publisher-policy',trust_policy_sha256:'C'.repeat(64),baseline_sha256:'D'.repeat(64),config_sha256:'E'.repeat(64)});f.write();
  const semantic=f.semanticOptions.createSemanticAdapter();
  const result=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:FIXTURE_NOW,...f.semanticOptions,
    createSemanticAdapter:()=>semantic,createVerifier:options=>{captured=options;return {verifyDiscoveryAdmission:f.options.verifyAdmission};}});
  assert.equal(result.admitted,true);assert.equal(captured.verifyDiscoverySemantics,semantic);
  assert.equal(captured.policyPath,semantic.admissionBinding.trust_policy_file);
  assert.equal(captured.expectedPolicySha256,'A'.repeat(64));
  const wrong=Object.assign(async()=>{}, {admissionBinding:{...semantic.admissionBinding,evidence_root:path.dirname(f.root)}});
  const denied=await loadConfiguredVwapDiscoveryAdmission({configFile:f.configFile,now:FIXTURE_NOW,...f.semanticOptions,createSemanticAdapter:()=>wrong});
  assert.equal(denied.admitted,false);assert.equal(denied.blockers[0].code,'DISCOVERY_SEMANTIC_EVIDENCE_ROOT_MISMATCH');
});

test('SOFTWARE custody bridge returns actual private-brand rows only after exact independently verified binding',async t=>{
  const f=await admissionConfig(t),options={configFile:f.configFile,now:FIXTURE_NOW,...f.semanticOptions,
    createVerifier:()=>({verifyDiscoveryAdmission:f.options.verifyAdmission})};
  const result=await loadConfiguredVwapDiscoveryAdmission(options);
  assert.equal(result.admitted,true);assert.equal(result.rows.length,1);assert.equal(result.rows[0].run_id,'reader-software-run');
  assert.equal(verifiedVwapDiscoveryRows(result.admission,result.rows,{strategyId:VWAP_PROOF_PROJECT,now:FIXTURE_NOW}).rows.length,1);
  assert.equal(verifiedVwapDiscoveryRows(structuredClone(result.admission),result.rows,{strategyId:VWAP_PROOF_PROJECT,now:FIXTURE_NOW}).rows.length,0);
  const expired=await loadConfiguredVwapDiscoveryAdmission({...options,now:FIXTURE_NOW+11*60*1000});
  assert.equal(expired.admitted,false);assert.equal(expired.admission,null);
  fs.appendFileSync(path.join(f.root,'learning.json'),' ');
  const tampered=await loadConfiguredVwapDiscoveryAdmission(options);assert.equal(tampered.admitted,false);assert.equal(tampered.admission,null);
});
