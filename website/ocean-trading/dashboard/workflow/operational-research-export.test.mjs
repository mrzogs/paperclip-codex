import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { digest } from './common.mjs';
import { exportFixture } from './operational-research-export.test-fixtures.mjs';

const reportRoute=f=>`artifacts/${f.artifactId}/research-report`;
async function rejected(response,status,code) {
  assert.equal(response.status,status);
  assert.equal((await response.json()).error.code,code);
}

test('actual HTTP full-report export restores all immutable evidence without changing raw artifact bytes or workflow state',async()=>{
  const f=await exportFixture();
  try {
    const before=f.snapshot(),raw=await (await f.request(`artifacts/${f.artifactId}`)).json();
    const metadata=await (await f.request(reportRoute(f))).json();
    const response=await f.request(reportRoute(f)+'/download'),bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/research-report\.json/);
    assert.equal(response.headers.get('content-security-policy'),"sandbox; default-src 'none'");
    assert.equal(metadata.read_only,true);assert.equal(metadata.representation,'RESTORED_IMMUTABLE_REPORT');
    assert.ok(bytes.length>128*1024);assert.deepEqual(JSON.parse(bytes.toString()),f.report);
    assert.equal(metadata.report_manifest.bytes,bytes.length);assert.equal(metadata.report_manifest.content_hash,digest(bytes));
    assert.equal(metadata.source_artifact.content_hash,raw.manifest.content_hash);
    assert.notEqual(digest(bytes),raw.manifest.content_hash);
    assert.deepEqual(Buffer.from(await (await f.request(`artifacts/${f.artifactId}/download`)).arrayBuffer()),Buffer.from(f.content));
    assert.deepEqual(f.snapshot(),before);
  }finally{await f.close();}
});

for(const identity of ['brain','strategy'])test(`actual operational route retains exact ${identity} producer/recipient access`,async()=>{
  const f=await exportFixture();
  try {
    const metadata=await f.request('operational/v1/'+reportRoute(f),{identity});assert.equal(metadata.status,200);
    const full=await f.request('operational/v1/'+reportRoute(f)+'/download',{identity});assert.equal(full.status,200);
    assert.deepEqual(JSON.parse(await full.text()),f.report);
    const raw=await f.request(`operational/v1/artifacts/${f.artifactId}/download`,{identity});assert.equal(await raw.text(),f.content);
  }finally{await f.close();}
});

for(const [identity,code] of [['intruder','EVIDENCE_DOWNLOAD_DENIED'],['wrong-instance','WRONG_INSTANCE_SCOPE'],
  ['wrong-strategy','WRONG_STRATEGY_SCOPE'],['no-read','WRONG_ACTION_SCOPE']]) {
  test(`actual auth rejects ${identity} full-report reads on both metadata and export`,async()=>{
    const f=await exportFixture();
    try {for(const suffix of ['','/download'])await rejected(await f.request('operational/v1/'+reportRoute(f)+suffix,{identity}),403,code);}
    finally{await f.close();}
  });
}

test('full-report endpoint does not accept missing credentials, forged identity headers or operational tokens on TEST routes',async()=>{
  const f=await exportFixture();
  try {
    const url=f.base+'/api/workflow/'+reportRoute(f);
    await rejected(await fetch(url),401,'AUTHENTICATION_REQUIRED');
    await rejected(await fetch(url,{headers:{'X-Actor-Id':'brain','X-Actor-Role':'HUMAN'}}),403,'FORGED_AUTHORITY_HEADER');
    await rejected(await f.request(reportRoute(f),{identity:'brain'}),403,'OPERATIONAL_IDENTITY_ON_TEST_ROUTE');
  }finally{await f.close();}
});

for(const version of [2,4,5,6])test(`historical inline v${version} export retains original compact formatting and hash`,async()=>{
  const f=await exportFixture({large:false,compactInline:true,version:`ocean-cumulative-research/v${version}`});
  try {
    const before=f.snapshot(),metadata=await (await f.request(reportRoute(f))).json();
    const bytes=Buffer.from(await (await f.request(reportRoute(f)+'/download')).arrayBuffer());
    assert.equal(metadata.representation,'ORIGINAL_INLINE_REPORT');assert.deepEqual(bytes,Buffer.from(f.content));
    assert.equal(bytes.at(-1),10);assert.equal(metadata.report_manifest.content_hash,metadata.source_artifact.content_hash);
    assert.deepEqual(f.snapshot(),before);
  }finally{await f.close();}
});

test('unrelated artifacts cannot be exported as full Research reports',async()=>{
  const f=await exportFixture();
  try {await rejected(await f.request(`artifacts/${f.sourceId}/research-report`),409,'RESEARCH_OUTCOME_REQUIRED');}
  finally{await f.close();}
});

for(const [label,change,code] of [
  ['unfinished job',db=>db.prepare("UPDATE ow_research_jobs SET state='RETRY'").run(),'RESEARCH_COMPLETED_REPORT_REQUIRED'],
  ['wrong job case',db=>{
    const row=db.prepare('SELECT * FROM ow_cases').get(),keys=Object.keys(row);
    db.prepare(`INSERT INTO ow_cases(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`)
      .run(...keys.map(key=>key==='id'?'other-case':row[key]));
    db.prepare("UPDATE ow_research_jobs SET case_id='other-case'").run();
  },'RESEARCH_COMPLETED_REPORT_REQUIRED'],
  ['changed result hash',db=>db.prepare("UPDATE ow_research_jobs SET result_hash=?").run(digest('changed')),'RESEARCH_RESULT_HASH_CONFLICT'],
  ['changed snapshot',db=>{db.exec('DROP TRIGGER ow_research_input_no_rewrite');db.prepare("UPDATE ow_research_jobs SET input_json='{}'").run();},'RESEARCH_SNAPSHOT_HASH_CONFLICT'],
  ['changed completion',db=>db.prepare("UPDATE ow_research_jobs SET completed_at_utc='2026-10-08T19:00:00.000Z'").run(),'RESEARCH_REPORT_COMPLETION_CONFLICT'],
  ['changed analysis version',db=>db.prepare("UPDATE ow_research_jobs SET analysis_version='ocean-cumulative-research/v99'").run(),'RESEARCH_REPORT_INPUT_CONFLICT'],
])test(`actual resolver rejects ${label} rather than presenting unbound full bytes`,async()=>{
  const f=await exportFixture();
  try {
    // Explicit isolated DB fault injection only; immutable production rows are not edited.
    change(f.backend.db);
    for(const suffix of ['','/download'])await rejected(await f.request(reportRoute(f)+suffix),409,code);
  }finally{await f.close();}
});

test('missing or ambiguous completed-job binding fails closed',async()=>{
  const f=await exportFixture();
  try {
    f.backend.db.prepare("UPDATE ow_research_jobs SET result_artifact_id=NULL").run();
    await rejected(await f.request(reportRoute(f)),409,'RESEARCH_COMPLETED_REPORT_REQUIRED');
    f.backend.db.prepare('UPDATE ow_research_jobs SET result_artifact_id=?').run(f.artifactId);
    const row=f.backend.db.prepare('SELECT * FROM ow_research_jobs').get(),keys=Object.keys(row);
    f.backend.db.prepare(`INSERT INTO ow_research_jobs(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`)
      .run(...keys.map(key=>key==='id'?'research-mock-duplicate':key==='analysis_version'?'mock-other-version':row[key]));
    await rejected(await f.request(reportRoute(f)),409,'RESEARCH_COMPLETED_REPORT_REQUIRED');
  }finally{await f.close();}
});

test('source catalog advertises read-only typed export and Research case link selects the full-report view',()=>{
  const catalog=fs.readFileSync(new URL('./export-bindings.mjs',import.meta.url),'utf8');
  // Source-only route declaration check. The pre-existing generator's missing
  // operational-runtime-v1.json contract is not replaced by a fabricated fixture.
  const declaration=catalog.match(/^  get_routes: (.*),$/m);assert.ok(declaration);
  const routes=vm.runInNewContext(declaration[1]);
  for(const suffix of ['','/download'])assert.ok(routes.some(row=>row.path===`/api/workflow/artifacts/{id}/research-report${suffix}` && row.method==='GET'));
  const source=fs.readFileSync(new URL('../public/workflow/ui.js',import.meta.url),'utf8');
  assert.match(source,/\['Result',research\.result_artifact_id\?fullReportLink\(research\.result_artifact_id\)/);
  assert.match(source,/#full-research-report/);assert.match(source,/RESEARCH_FULL_REPORT_HASH_CONFLICT/);
});
