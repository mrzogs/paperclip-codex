import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalVwapJson, loadVwapImprovementReports, verifiedVwapReportContext, vwapArtifactSha256 } from './vwap-improvement-reports.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vwap-publication-test-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const now = Date.parse('2026-10-29T12:00:00Z');
  const scope = {strategy_id:'cicd-vwap-pull-back-strategy',domain:'trading-strategy',project_root:'C:\\approved-project'};
  const document = {schema_version:'test-report/v1',...scope,generated_at_utc:'2026-10-29T11:59:00Z',status:'STALLED'};
  const manifest = {schema_version:'cicd-vwap-report-publication/v1',scope:{project_id:scope.strategy_id,domain:scope.domain,project_root:scope.project_root},published_at_utc:'2026-10-29T11:59:30Z',provenance:{level:'INTEGRITY_ONLY'},reports:[]};
  const options = {root,project:scope.strategy_id,domain:scope.domain,projectRoot:scope.project_root,manifestPath:'publication.json',publicationSchema:manifest.schema_version,reportSchemas:{liveness:document.schema_version},requiredKinds:['liveness'],now};
  function publish(raw = Buffer.from(JSON.stringify(document))) {
    fs.writeFileSync(path.join(root,'report.json'),raw);
    manifest.reports = [{kind:'liveness',schema_version:document.schema_version,id:'liveness',path:'report.json',sha256:vwapArtifactSha256(raw),byte_length:raw.length}];
    fs.writeFileSync(path.join(root,'publication.json'),JSON.stringify(manifest));
    options.expectedPublicationHash = vwapArtifactSha256(fs.readFileSync(path.join(root,'publication.json')));
    options.verifyPublication = ({sha256}) => ({verified:true,purpose:'improvement.report_publication',subject_sha256:sha256,...scope,expires_at_utc:'2026-10-29T12:10:00Z'});
  }
  publish();
  return {root,now,scope,document,manifest,options,publish};
}
test('authenticated collection health remains separate from a stalled improvement stage',async t => {
  const f = fixture(t); f.document.average_pnl=1.04; f.publish();
  const result = await loadVwapImprovementReports(f.options);
  assert.equal(result.ingestion.status,'HEALTHY');
  assert.equal(result.reports.liveness.document.status,'STALLED');
  assert.equal(result.reports.liveness.document.average_pnl,1.04);
  assert.equal(result.proof_links[0].sha256,f.manifest.reports[0].sha256);
  assert.ok(verifiedVwapReportContext(result.reports.liveness,f.now));
  assert.equal(verifiedVwapReportContext(structuredClone(result.reports.liveness),f.now),null);
  assert.equal(verifiedVwapReportContext(result.reports.liveness,f.now + 16*60*1000),null);
  assert.ok(Object.isFrozen(result.reports.liveness.document));
});
test('unsigned diagnostics remain visible; configured authentication requires exact scope/hash', async t => {
  const f = fixture(t);
  const diagnostic=await loadVwapImprovementReports({...f.options,verifyPublication:undefined});
  assert.equal(diagnostic.ingestion.status,'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY');
  assert.equal(diagnostic.ingestion.authority,'DIAGNOSTIC_ONLY');
  for (const verifyPublication of [null,() => ({verified:true}),({sha256}) => ({verified:true,purpose:'improvement.report_publication',subject_sha256:sha256,...f.scope,project_root:'C:\\other',expires_at_utc:'2026-10-29T12:10:00Z'})]) {
    const result = await loadVwapImprovementReports({...f.options,verifyPublication});
    assert.equal(result.ingestion.status,'BLOCKED'); assert.deepEqual(Object.keys(result.reports),[]);
  }
  assert.equal((await loadVwapImprovementReports({...f.options,expectedPublicationHash:'A'.repeat(64)})).ingestion.blockers[0].code,'REPORT_PUBLICATION_HASH_MISMATCH');
});
test('rejects stale, future, cross-project, wrong schema, partial and post-publication reports',async t => {
  const f = fixture(t);
  for (const mutate of [
    () => {f.document.generated_at_utc='2026-10-29T10:00:00Z';},
    () => {f.document.generated_at_utc='2026-10-29T12:01:00Z';},
    () => {f.document.strategy_id='other-project';},
    () => {f.document.schema_version='other/v1';},
    () => {f.manifest.provenance={level:'UNKNOWN'};},
    () => {f.document.generated_at_utc='2026-10-29T11:59:40Z';},
  ]) {
    const oldDocument = {...f.document}, oldManifest = {...f.manifest};
    mutate(); f.publish();
    assert.equal((await loadVwapImprovementReports(f.options)).ingestion.status,'BLOCKED');
    Object.assign(f.document,oldDocument); Object.assign(f.manifest,oldManifest);
  }
  f.publish();
  assert.equal((await loadVwapImprovementReports({...f.options,requiredKinds:['case','liveness']})).ingestion.blockers[0].code,'REPORT_REQUIRED_SET_INCOMPLETE');
});
test('rejects tampered, oversized, duplicated and nonregular inputs',async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root,'report.json'),' ');
  assert.equal((await loadVwapImprovementReports(f.options)).ingestion.blockers[0].code,'REPORT_HASH_OR_LENGTH_MISMATCH');
  f.publish();
  assert.equal((await loadVwapImprovementReports({...f.options,maxBytes:16})).ingestion.blockers[0].code,'REPORT_SIZE_LIMIT');
  assert.equal((await loadVwapImprovementReports({...f.options,maxTotalBytes:fs.statSync(path.join(f.root,'publication.json')).size})).ingestion.blockers[0].code,'REPORT_AGGREGATE_SIZE_LIMIT');
  f.publish(Buffer.from(JSON.stringify(f.document).replace('"status":"STALLED"','"status":"HEALTHY","status":"STALLED"')));
  assert.equal((await loadVwapImprovementReports(f.options)).ingestion.blockers[0].code,'REPORT_DUPLICATE_JSON_KEY');
  f.publish(); f.manifest.reports.push({...f.manifest.reports[0]});
  fs.writeFileSync(path.join(f.root,'publication.json'),JSON.stringify(f.manifest));
  f.options.expectedPublicationHash=vwapArtifactSha256(fs.readFileSync(path.join(f.root,'publication.json')));
  assert.equal((await loadVwapImprovementReports(f.options)).ingestion.blockers[0].code,'REPORT_DUPLICATE_OR_INVALID_REFERENCE');
  f.publish(); fs.rmSync(path.join(f.root,'report.json')); fs.mkdirSync(path.join(f.root,'report.json'));
  assert.equal((await loadVwapImprovementReports(f.options)).ingestion.blockers[0].code,'REPORT_REGULAR_FILE_REQUIRED');
});
test('rejects path escape and directory aliases',async t => {
  const f = fixture(t);
  f.manifest.reports[0].path='../outside.json';
  fs.writeFileSync(path.join(f.root,'publication.json'),JSON.stringify(f.manifest));
  f.options.expectedPublicationHash=vwapArtifactSha256(fs.readFileSync(path.join(f.root,'publication.json')));
  assert.equal((await loadVwapImprovementReports(f.options)).ingestion.blockers[0].code,'REPORT_OUTSIDE_ROOT');
  f.publish();
  assert.equal((await loadVwapImprovementReports({...f.options,manifestPath:'publication.json:other-stream'})).ingestion.blockers[0].code,'REPORT_ALTERNATE_STREAM_REJECTED');
  const alias=path.join(f.root,'alias'); fs.symlinkSync(f.root,alias,'junction');
  const result=await loadVwapImprovementReports({...f.options,manifestPath:path.join(alias,'publication.json')});
  assert.equal(result.ingestion.blockers[0].code,'REPORT_ALIAS_PATH_REJECTED');
});
test('canonical JSON matches Python fixture ordering and Unicode bytes',()=>{
  assert.equal(canonicalVwapJson({z:[true,null,'£'],a:{b:2,a:'1.04'}}),'{"a":{"a":"1.04","b":2},"z":[true,null,"£"]}');
  assert.throws(()=>canonicalVwapJson({nan:NaN}),/safe integers/);
  assert.throws(()=>canonicalVwapJson({unsafe:9007199254740992}),/safe integers/);
});
