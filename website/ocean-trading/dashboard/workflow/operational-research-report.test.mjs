import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './common.mjs';
import { REPORT_REFERENCE_VERSION, researchReportContent, readResearchReport } from './operational-research-report.mjs';

// Explicit mock report/job rows; this suite tests encoding and integrity only.
function fixture({large=true}={}) {
  const result={schema_version:'ocean-cumulative-research/v6',outcome:'NO_SUPPORTED_CHANGE',
    contradictions:[{reason:'RETAINED_CONTRADICTION',detail:'x'.repeat(large?150000:10)}]};
  const input_json=JSON.stringify({result}),job={id:'research-mock',case_id:'mock-case',analysis_version:result.schema_version,
    artifact_id:'mock-recommendation',artifact_hash:digest('mock-source'),input_json,input_hash:digest(input_json),
    completed_at_utc:'2026-10-08T18:00:00.000Z',result_artifact_id:'mock-outcome'};
  const report={...result,brain_record:{record_id:'mock-record',content_hash:digest('mock-record'),correlation:{job_id:job.id}},
    job_id:job.id,case_id:job.case_id,source_recommendation_id:job.artifact_id,
    source_recommendation_hash:job.artifact_hash,completed_at_utc:job.completed_at_utc};
  return {job,report};
}
function seal(job,content) {
  const hash=digest(content);
  return {job:{...job,result_hash:hash},artifact:{id:job.result_artifact_id,
    content:Buffer.from(content),manifest_json:JSON.stringify({content_hash:hash})}};
}
function read(job,content) {const sealed=seal(job,content);return readResearchReport(sealed.job,sealed.artifact);}

test('report reference losslessly binds frozen evidence and post-capture receipt with deterministic UTF8 hashes',()=>{
  const {job,report}=fixture(),snapshot=JSON.parse(job.input_json);
  snapshot.result.contradictions[0].detail+='\u03bb';report.contradictions=snapshot.result.contradictions;
  job.input_json=JSON.stringify(snapshot);job.input_hash=digest(job.input_json);
  const before=job.input_json;
  const content=researchReportContent(job,report),reference=JSON.parse(content);
  assert.equal(reference.schema_version,REPORT_REFERENCE_VERSION);assert.ok(Buffer.byteLength(content)<128*1024);
  assert.equal(reference.full_report.bytes,Buffer.byteLength(JSON.stringify(report,null,2)));
  assert.equal(reference.full_report.content_hash,digest(JSON.stringify(report,null,2)));
  assert.deepEqual(read(job,content),report);assert.equal(researchReportContent(job,report),content);
  assert.equal(job.input_json,before,'encoding and reading never rewrite the frozen input');
});

test('small and historical inline reports preserve exact serialized bytes without snapshot migration',()=>{
  const {job,report}=fixture({large:false}),content=researchReportContent(job,report);
  assert.equal(content,JSON.stringify(report,null,2));
  for(const version of ['ocean-cumulative-research/v2','ocean-cumulative-research/v4','ocean-cumulative-research/v5']) {
    const historical={...report,schema_version:version},inline=JSON.stringify(historical,null,2);
    assert.deepEqual(read({...job,input_json:null,input_hash:null,analysis_version:version},inline),historical);
  }
});

test('report reference threshold uses bytes, including exact limit and multibyte oversize',()=>{
  const {job,report}=fixture({large:false});delete report.brain_record;
  const baseBytes=Buffer.byteLength(JSON.stringify(report,null,2));
  report.contradictions[0].detail+='x'.repeat(128*1024-baseBytes);
  assert.equal(Buffer.byteLength(researchReportContent(job,report)),128*1024);
  report.contradictions[0].detail+='\u03bb';
  const snapshot={result:{schema_version:report.schema_version,outcome:report.outcome,contradictions:report.contradictions}};
  job.input_json=JSON.stringify(snapshot);job.input_hash=digest(job.input_json);
  const content=researchReportContent(job,report);
  assert.equal(JSON.parse(content).full_report.bytes,128*1024+2);assert.deepEqual(read(job,content),report);
});

test('oversized report cannot replace, omit or add frozen result/contradiction fields',()=>{
  const {job,report}=fixture();
  for(const change of [value=>value.outcome='EXPLORATORY_PROPOSAL',value=>delete value.contradictions,
    value=>value.contradictions[0].reason='CLIPPED',value=>value.authority={candidate_approved:true}]) {
    const changed=structuredClone(report);change(changed);
    // Keep this branch oversized when testing omission of its original bulk.
    if(!changed.contradictions)changed.other='y'.repeat(150000);
    assert.throws(()=>researchReportContent(job,changed),/RESEARCH_(?:FULL_REPORT_HASH|REPORT_INPUT)_CONFLICT/);
  }
});

test('report resolver rejects wrong job/case/input/metadata/full hash and unverified Brain additions',()=>{
  const {job,report}=fixture(),content=researchReportContent(job,report);
  for(const change of [value=>value.source.job_id='other',value=>value.source.case_id='other',
    value=>value.source.input_hash=digest('other'),value=>value.source.frozen_result_hash=digest('other'),
    value=>value.completion.source_recommendation_hash=digest('other'),value=>value.completion.completed_at_utc='2026-10-09T00:00:00Z',
    value=>value.full_report.content_hash=digest('other'),value=>value.full_report.bytes++,
    value=>value.additions.brain_record.record_id='other',value=>value.additions.outcome='EXPLORATORY_PROPOSAL']) {
    const reference=JSON.parse(content);change(reference);
    assert.throws(()=>read(job,JSON.stringify(reference)),/CONFLICT|UNKNOWN_OR_AUTHORITY_FIELD/);
  }
  const sealed=seal(job,content);
  assert.throws(()=>readResearchReport({...sealed.job,input_json:job.input_json+' '},sealed.artifact),/RESEARCH_SNAPSHOT_HASH_CONFLICT/);
  assert.throws(()=>readResearchReport({...sealed.job,input_json:null},sealed.artifact),/RESEARCH_SNAPSHOT_HASH_CONFLICT/);
  assert.throws(()=>readResearchReport({...sealed.job,result_artifact_id:'other'},sealed.artifact),/RESEARCH_RESULT_HASH_CONFLICT/);
  assert.throws(()=>readResearchReport(sealed.job,{...sealed.artifact,content:Buffer.from(content+' ')}),/RESEARCH_RESULT_HASH_CONFLICT/);
});

test('oversized reference preserves the existing full-report active-content rejection',()=>{
  const {job,report}=fixture();
  for(const dangerous of ['<script>','<iframe>','javascript:','file:','data:',String.raw` C:\unsafe`,String.raw` \\host`]) {
    const changed=structuredClone(report);changed.contradictions[0].detail+=dangerous;
    assert.throws(()=>researchReportContent(job,changed),/ACTIVE_ARTIFACT_CONTENT_REJECTED/);
  }
});
