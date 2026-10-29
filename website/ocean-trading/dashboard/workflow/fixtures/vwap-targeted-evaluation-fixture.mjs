import os from 'node:os';
import { digest, objectHash } from '../common.mjs';
import { makeVwapSoftwareFixture } from '../vwap-test-result-adapter.fixtures.mjs';
import { adaptVwapTestResult } from '../vwap-test-result-adapter.mjs';

export function targetedEvaluationFixture(t){
  const fixtures=[0,1,2,3].map(index=>makeVwapSoftwareFixture(t,index));
  const plan={targeted_replay:fixtures[0].input.planBinding,tests:fixtures.map(f=>f.input.test)};
  const planJson=JSON.stringify(plan);
  const snapshot={case:{case_id:'test-case',strategy_id:fixtures[0].input.project_id,candidate_hash:fixtures[0].input.candidate_hash,
    baseline_hash:plan.targeted_replay.plan.cases[0].baseline_source_sha256},
    validation_plan:{plan_hash:objectHash(plan),content_json:planJson,content_sha256:digest(planJson)},validation_artifacts:fixtures.map(f=>{
      const output=adaptVwapTestResult(f.input,f.options),content_json=JSON.stringify({...f.input.result,targeted_behavior:output.targeted_behavior,
        targeted_physical_evidence:{schema_version:'ocean-vwap-targeted-physical-evidence/v1',protocol_ref:f.input.protocol_ref,
          case_evidence_ref:f.input.case_evidence_ref,physical_runs:f.input.physical_runs}});
      return {kind:f.input.test.kind,artifact_id:f.input.test.kind,content_json,content_sha256:digest(content_json)};
    })};
  return {fixtures,snapshot,verification:{...fixtures[0].options,evidenceRoot:os.tmpdir()}};
}
