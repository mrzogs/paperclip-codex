import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVwapDiscoveryAdmission, verifiedVwapDiscoveryRows } from './vwap-discovery-admission.mjs';
import { discoveryFixture, FIXTURE_NOW } from './fixtures/vwap-discovery-fixture.mjs';

const rows=()=>[{trade_id:'trade-1',strategy_id:'cicd-vwap-pull-back-strategy',run_id:'fixture-run',dataset_role:'DISCOVERY',environment:'REPLAY',session_id:'session-1',net_pnl:'-1.04'}];

test('authenticated custody and report flags cannot replace the authoritative semantic result',async t=>{
  for(const mutateClaims of [claims=>{delete claims.semantic_admission;},
    claims=>{claims.semantic_admission.status='SOFTWARE_FIXTURE_VALIDATED';},
    claims=>{claims.semantic_admission.learning_rows_sha256='A'.repeat(64);},
    claims=>{delete claims.semantic_admission.intake_package_sha256;}]){
    const f=await discoveryFixture(t,rows(),{mutateReport:report=>{
      report.semantic_verified=true;report.semantic_admission={status:'QUALIFIED_DISCOVERY'};
    },mutateClaims});
    assert.equal(f.result.admitted,false);assert.equal(f.result.blockers[0].code,'DISCOVERY_AUTHORITATIVE_SEMANTICS_REQUIRED');
  }
});
test('private admission requires original-manifest custody and exact row bridge',async t=>{
  const f=await discoveryFixture(t,rows(),{unsignedPublication:true});
  assert.equal(f.loaded.ingestion.status,'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY');
  assert.equal(f.result.admitted,true);
  assert.equal(verifiedVwapDiscoveryRows(f.result.admission,rows(),{strategyId:f.report.strategy_id,now:FIXTURE_NOW}).rows.length,1);
  assert.equal(verifiedVwapDiscoveryRows(structuredClone(f.result.admission),rows(),{strategyId:f.report.strategy_id,now:FIXTURE_NOW}).blockers[0].code,'DISCOVERY_ADMISSION_REQUIRED');
  assert.equal(verifiedVwapDiscoveryRows(f.result.admission,rows(),{strategyId:'other',now:FIXTURE_NOW}).blockers[0].code,'DISCOVERY_ADMISSION_SCOPE_MISMATCH');
  assert.equal(verifiedVwapDiscoveryRows(f.result.admission,rows(),{strategyId:f.report.strategy_id,now:FIXTURE_NOW+11*60*1000}).blockers[0].code,'DISCOVERY_ADMISSION_EXPIRED');
});
test('publication or report assertions cannot replace authenticated custody',async t=>{
  const f=await discoveryFixture(t,rows());
  for(const options of [
    {...f.options,report:structuredClone(f.options.report)},
    {...f.options,learningRowsReport:undefined},
    {...f.options,verifyAdmission:undefined},
    {...f.options,verifyAdmission:()=>({verified:true})},
    {...f.options,baselineSha256:'A'.repeat(64)},
    {...f.options,requiredCustodyPurposes:f.options.requiredCustodyPurposes.slice(1)},
  ]) assert.equal((await validateVwapDiscoveryAdmission(options)).admitted,false);
});
test('synthetic, incomplete, wrong-source and wrong-scope reports stay ineligible',async t=>{
  for(const mutateReport of [
    r=>{r.status='SOFTWARE_FIXTURE_VALIDATED';r.evidence_class='SYNTHETIC';r.eligible_for_candidate_selection=false;},
    r=>{r.errors.push({code:'INCOMPLETE_CAPTURE'});},
    r=>{r.learning_rows_sha256='A'.repeat(64);},
    r=>{r.source_binding.config_sha256='A'.repeat(64);},
    r=>{r.signed_subject_sha256='A'.repeat(64);},
    r=>{r.required_custody_purposes.pop();},
  ]) {
    const f=await discoveryFixture(t,rows(),{mutateReport});
    assert.equal(f.result.admitted,false);
  }
});
test('missing, duplicate, expired and cross-run custody is rejected',async t=>{
  for(const mutateClaims of [
    c=>{c.verified_custody.pop();},
    c=>{c.verified_custody.push({...c.verified_custody[0]});},
    c=>{c.verified_custody[0].expires_at_utc='2026-10-29T11:59:59Z';},
    c=>{c.verified_custody[0].subject_sha256='A'.repeat(64);},
    c=>{c.verified_custody[0].run_id='other-run';},
    c=>{c.verified_custody[0].verified=false;},
    c=>{c.project_root='C:\\other-project';},
    c=>{c.learning_rows_sha256='A'.repeat(64);},
    c=>{c.verified_custody.find(item=>item.purpose==='discovery.market_universe').issuer=c.verified_custody[0].issuer;},
    c=>{c.verified_custody.find(item=>item.purpose==='discovery.market_universe').verification_key_sha256=c.verified_custody[0].verification_key_sha256;},
  ]) {
    const f=await discoveryFixture(t,rows(),{mutateClaims});
    assert.equal(f.result.admitted,false);
  }
});
