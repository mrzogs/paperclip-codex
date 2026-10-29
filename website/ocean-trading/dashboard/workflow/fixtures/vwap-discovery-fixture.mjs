// Synthetic software fixture for the trusted bridge boundary. This is never a
// production verifier, issuer policy, or market-evidence qualification path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadVwapImprovementReports, vwapArtifactSha256 } from '../vwap-improvement-reports.mjs';
import { validateVwapDiscoveryAdmission, vwapDiscoveryRowsSha256 } from '../vwap-discovery-admission.mjs';
import { VWAP_DISCOVERY_CUSTODY_PURPOSES } from '../vwap-improvement-proof-verifier.mjs';

export const FIXTURE_NOW = Date.parse('2026-10-29T12:00:00Z');
export async function discoveryFixture(t, rows, {mutateReport,mutateClaims,unsignedPublication=false,
  now=FIXTURE_NOW,projectRoot='C:\\test-project'} = {}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vwap-admission-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const scope={strategy_id:'cicd-vwap-pull-back-strategy',domain:'trading-strategy',project_root:projectRoot};
  const runIds=[...new Set(rows.map(row=>row.run_id))],runId=runIds.length===1?runIds[0]:'fixture-run';
  const base={...scope,generated_at_utc:'2026-10-29T11:59:00Z'};
  const baselineSha256='B'.repeat(64), configSha256='C'.repeat(64), manifestSha256='D'.repeat(64);
  const learning={...base,schema_version:'cicd-vwap-learning-rows/v1',records:rows};
  const learningPath=path.join(root,'learning.json'); fs.writeFileSync(learningPath,JSON.stringify(learning));
  const reference=(id,file,schema_version,kind)=>{
    const raw=fs.readFileSync(file); return {id,path:file,schema_version,kind,sha256:vwapArtifactSha256(raw),byte_length:raw.length};
  };
  const learningRef=reference('learning',learningPath,learning.schema_version,'learning_rows');
  const report={...base,schema_version:'cicd-vwap-discovery-admission/v1',status:'QUALIFIED_DISCOVERY',eligible_for_candidate_selection:true,evidence_class:'OBSERVED',dataset_role:'DISCOVERY',run_id:runId,errors:[],manifest_sha256:manifestSha256,signed_subject_sha256:manifestSha256,source_binding:{source_sha256:baselineSha256,config_sha256:configSha256},learning_rows_artifact:learningRef,learning_rows_sha256:vwapDiscoveryRowsSha256(rows),required_custody_purposes:[...VWAP_DISCOVERY_CUSTODY_PURPOSES]};
  mutateReport?.(report);
  const reportPath=path.join(root,'discovery.json'); fs.writeFileSync(reportPath,JSON.stringify(report));
  const publication={scope:{project_id:scope.strategy_id,domain:scope.domain,project_root:scope.project_root},schema_version:'cicd-vwap-report-publication/v1',published_at_utc:'2026-10-29T11:59:30Z',provenance:{level:'INTEGRITY_ONLY'},reports:[reference('discovery',reportPath,report.schema_version,'discovery_admission'),learningRef]};
  const publicationPath=path.join(root,'publication.json'); fs.writeFileSync(publicationPath,JSON.stringify(publication));
  const loaded=await loadVwapImprovementReports({root,project:scope.strategy_id,domain:scope.domain,projectRoot:scope.project_root,manifestPath:publicationPath,expectedPublicationHash:vwapArtifactSha256(fs.readFileSync(publicationPath)),publicationSchema:publication.schema_version,reportSchemas:{discovery_admission:report.schema_version,learning_rows:learning.schema_version},requiredKinds:['discovery_admission','learning_rows'],now,
    verifyPublication:unsignedPublication?undefined:({sha256})=>({...scope,verified:true,purpose:'improvement.report_publication',subject_sha256:sha256,expires_at_utc:'2026-10-29T12:10:00Z'})});
  const verifyAdmission=({report_sha256,manifest_sha256,learning_rows_sha256})=>{
    const claims={...scope,verified:true,report_sha256,manifest_sha256,learning_rows_sha256,run_id:runId,verified_custody:report.required_custody_purposes.map(purpose=>({...scope,purpose,verified:true,run_id:runId,subject_sha256:manifestSha256,issuer:purpose==='discovery.market_universe'?'independent-synthetic-market-custodian':'synthetic-test-verifier',verification_key_sha256:purpose==='discovery.market_universe'?'F'.repeat(64):'E'.repeat(64),issued_at_utc:'2026-10-29T11:58:00Z',expires_at_utc:'2026-10-29T12:10:00Z'}))};
    // Trusted verifier mock only; the real implementation reads Python's exact
    // immutable semantic outputs before emitting these claims.
    claims.semantic_admission={status:'QUALIFIED_DISCOVERY',report_sha256:'1'.repeat(64),
      intake_package_sha256:'2'.repeat(64),learning_rows_sha256};
    mutateClaims?.(claims); return claims;
  };
  const options={report:loaded.reports.discovery_admission,learningRowsReport:loaded.reports.learning_rows,discoverySchema:report.schema_version,requiredCustodyPurposes:VWAP_DISCOVERY_CUSTODY_PURPOSES,baselineSha256,configSha256,verifyAdmission,now};
  const result=await validateVwapDiscoveryAdmission(options);
  return {root,report,loaded,options,result};
}
