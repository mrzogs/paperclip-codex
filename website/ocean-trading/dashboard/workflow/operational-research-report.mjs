import { digest, exactKeys, objectHash, requireThat } from './common.mjs';

export const REPORT_REFERENCE_VERSION='ocean-frozen-research-report-reference/v1';
const artifactLimit=128*1024;
const completionKeys=['job_id','case_id','source_recommendation_id','source_recommendation_hash','completed_at_utc'];
const serialize=report=>JSON.stringify(report,null,2);
const sourceFor=(job,result)=>({table:'ow_research_jobs',job_id:job.id,case_id:job.case_id,
  input_hash:job.input_hash,frozen_result_hash:objectHash(result)});

function frozenResult(job) {
  requireThat(job.input_json && digest(job.input_json)===job.input_hash,409,'RESEARCH_SNAPSHOT_HASH_CONFLICT');
  const result=JSON.parse(job.input_json).result;
  requireThat(result && typeof result==='object' && !Array.isArray(result)
    && result.schema_version===job.analysis_version,409,'RESEARCH_REPORT_INPUT_CONFLICT');
  return result;
}
function restore(job,reference) {
  exactKeys(reference,['schema_version','source','completion','additions','full_report']);
  const result=frozenResult(job);
  requireThat(objectHash(reference.source)===objectHash(sourceFor(job,result)),409,'RESEARCH_REPORT_SOURCE_CONFLICT');
  exactKeys(reference.completion,completionKeys);exactKeys(reference.additions,['brain_record']);
  exactKeys(reference.full_report,['content_hash','bytes']);
  const metadata=reference.completion;
  requireThat(metadata.job_id===job.id && metadata.case_id===job.case_id
    && metadata.source_recommendation_id===job.artifact_id && metadata.source_recommendation_hash===job.artifact_hash
    && typeof metadata.completed_at_utc==='string' && Number.isFinite(Date.parse(metadata.completed_at_utc)),
  409,'RESEARCH_REPORT_COMPLETION_CONFLICT');
  // Only the post-capture Brain receipt may be added. Never replace frozen
  // accounting, contradictory evidence, policy, authority or outcome fields.
  requireThat(!Object.keys(reference.additions).some(key=>Object.hasOwn(result,key)),409,'RESEARCH_REPORT_INPUT_CONFLICT');
  const report={...result,...reference.additions,...metadata},content=serialize(report);
  requireThat(digest(content)===reference.full_report.content_hash
    && Buffer.byteLength(content,'utf8')===reference.full_report.bytes,409,'RESEARCH_FULL_REPORT_HASH_CONFLICT');
  return report;
}

// Keep existing inline reports byte-identical. Large reports already exist in
// immutable input_json; the small OUTCOME binds their exact restored bytes and
// completion receipt. result_hash remains the OUTCOME artifact hash, not a
// silently redefined full-report hash. No evidence is summarized or discarded.
// Restoring/exporting a referenced report requires retaining its immutable job
// row alongside the artifact; the reference alone is explicitly not a report.
export function researchReportContent(job,report) {
  const content=serialize(report);
  if(Buffer.byteLength(content,'utf8')<=artifactLimit)return content;
  // A reference must not bypass writeArtifact's rejection for the full report.
  requireThat(!/<\s*(?:script|iframe|object|embed)|(?:javascript|file|data):|(?:^|[\s"'(])[A-Za-z]:[\\/]|\\\\[A-Za-z]/i.test(content),
    422,'ACTIVE_ARTIFACT_CONTENT_REJECTED');
  const result=frozenResult(job);
  const reference={schema_version:REPORT_REFERENCE_VERSION,source:sourceFor(job,result),
    completion:Object.fromEntries(completionKeys.map(key=>[key,report[key]])),
    additions:Object.hasOwn(report,'brain_record') && !Object.hasOwn(result,'brain_record')?{brain_record:report.brain_record}:{},
    full_report:{content_hash:digest(content),bytes:Buffer.byteLength(content,'utf8')}};
  requireThat(serialize(restore(job,reference))===content,409,'RESEARCH_REPORT_INPUT_CONFLICT');
  return JSON.stringify(reference);
}

export function readResearchReport(job,artifact) {
  const bytes=Buffer.from(artifact.content),manifest=JSON.parse(artifact.manifest_json);
  requireThat(artifact.id===job.result_artifact_id && digest(bytes)===job.result_hash
    && manifest.content_hash===job.result_hash,409,'RESEARCH_RESULT_HASH_CONFLICT');
  const report=JSON.parse(bytes.toString('utf8'));
  if(report.schema_version!==REPORT_REFERENCE_VERSION)return report;
  requireThat(report.completion?.completed_at_utc===job.completed_at_utc,409,'RESEARCH_REPORT_COMPLETION_CONFLICT');
  return restore(job,report);
}
