import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vwapArtifactSha256 } from './vwap-improvement-reports.mjs';
import { loadConfiguredVwapImprovementReports } from './vwap-improvement-reader.mjs';
import { VWAP_PROOF_PROJECT, VWAP_PROOF_DOMAIN, VWAP_PROOF_PROJECT_ROOT } from './vwap-improvement-proof-verifier.mjs';

export function makeVwapStatusSoftwareFixture(t,{synthetic=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-w7-software-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=Date.parse('2026-10-29T12:00:00Z'),scope={strategy_id:VWAP_PROOF_PROJECT,domain:VWAP_PROOF_DOMAIN,project_root:VWAP_PROOF_PROJECT_ROOT};
  const common={...scope,generated_at_utc:'2026-10-29T11:59:00Z',evidence_class:synthetic?'SYNTHETIC':'OBSERVED'};
  const documents={collector_health:{...common,schema_version:'fixture-collector/v1',status:'HEALTHY',api_token:'DO_NOT_PROJECT'},
    cohort:{...common,schema_version:'fixture-cohort/v1',closed:46,net_ledger_units:'-2618.86',chart_start:'2026-10-14',chart_end:'2026-10-28',open_excluded:1,database_path:'D:\\private\\ledger.sqlite'},
    exit_reconciliation:{...common,schema_version:'fixture-reconciliation/v1',status:'MATCHED',private_detail:'DO_NOT_PROJECT'},
    improvement_liveness:{...common,schema_version:'fixture-liveness/v1',liveness:'COMPLETE',material_improvement_proved:true,
      current_stage:'CANDIDATE_SOURCE_REVIEW_PENDING',gates:{physical_test:true,profit:true,paper:true},
      blockers:[{issue:'OCEA-55',owner:'Protected host custodian',missing:['Authenticated physical start and terminal receipts']}],
      next_permitted_action:'Supply the exact approved host receipt and retained originals.'}};
  const manifest={schema_version:'cicd-vwap-report-publication/v1',scope:{project_id:VWAP_PROOF_PROJECT,domain:VWAP_PROOF_DOMAIN,
    project_root:VWAP_PROOF_PROJECT_ROOT},published_at_utc:'2026-10-29T11:59:30Z',provenance:{level:'INTEGRITY_ONLY'},reports:[]};
  const config={schema_version:'ocean-vwap-improvement-report-reader/v1',project_id:VWAP_PROOF_PROJECT,domain:VWAP_PROOF_DOMAIN,
    project_root:VWAP_PROOF_PROJECT_ROOT,evidence_root:root,manifest_path:'publication.json',publication_schema:manifest.schema_version,
    report_schemas:Object.fromEntries(Object.entries(documents).map(([kind,document])=>[kind,document.schema_version])),
    required_kinds:Object.keys(documents),max_age_ms:900000,max_bytes:1048576,max_total_bytes:8388608};
  const configFile=path.join(root,'reader.json');
  const publish=()=>{
    manifest.reports=Object.entries(documents).map(([kind,document])=>{
      const bytes=Buffer.from(JSON.stringify(document)),file=`${kind}.json`;fs.writeFileSync(path.join(root,file),bytes);
      return {kind,id:`fixture-${kind}`,path:file,schema_version:document.schema_version,byte_length:bytes.length,sha256:vwapArtifactSha256(bytes)};
    });
    const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(root,'publication.json'),bytes);
    config.publication_sha256=vwapArtifactSha256(bytes);fs.writeFileSync(configFile,JSON.stringify(config));
  };
  publish();
  return {root,now,documents,manifest,config,configFile,publish,
    loadConfigured:options=>loadConfiguredVwapImprovementReports({...options,configFile})};
}
