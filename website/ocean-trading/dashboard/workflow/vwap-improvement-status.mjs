import { verifiedVwapReportContext } from './vwap-improvement-reports.mjs';
import { loadConfiguredVwapImprovementReports } from './vwap-improvement-reader.mjs';
import { createVwapBoundedArtifactReader } from './vwap-bounded-artifacts.mjs';
import { timedSync } from '../request-timing.mjs';

export const VWAP_IMPROVEMENT_STATUS_VERSION='ocean-vwap-improvement-status/v1';
export const VWAP_IMPROVEMENT_PROJECT='cicd-vwap-pull-back-strategy';
const reportKinds=new Set(['collector_health','cohort','exit_reconciliation','improvement_liveness','discovery_admission','learning_rows']);
const hash=value=>typeof value==='string' && /^[a-f0-9]{64}$/i.test(value);
const code=value=>typeof value==='string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value)?value:'REPORT_READ_FAILED';
const text=value=>typeof value==='string'?value.replace(/Bearer\s+\S+/gi,'[redacted]')
  .replace(/\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,'[redacted]')
  .replace(/[A-Za-z]:[\\/][^\s,;]+/g,'[private path]').replace(/[\u0000-\u001f]/g,' ').slice(0,600):null;
const count=value=>Number.isSafeInteger(value) && value>=0?value:null;
const decimal=value=>typeof value==='string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length<80?value:
  Number.isFinite(value)?String(value):null;
const date=value=>typeof value==='string' && Number.isFinite(Date.parse(value))?value:null;
const day=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value?value:null;
const readConfigured=loadConfiguredVwapImprovementReports;
const readStatusConfigured=options=>loadConfiguredVwapImprovementReports({...options,diagnosticTiming:true});

function safeBlocker(item){
  if(!item || typeof item!=='object')return null;
  return {code:text(item.code ?? item.issue ?? item.id),owner:text(item.owner),
    detail:text(item.blocker ?? item.detail ?? (Array.isArray(item.missing)?item.missing.join('; '):item.missing)),
    next_action:text(item.next_action ?? item.resolution_action)};
}

/** Whitelist public diagnostics. A report saying COMPLETE or true cannot establish
 * an improvement gate; publication authentication alone is not proof of a loop. */
export function projectVwapImprovementStatus(loaded,{now=Date.now(),verifiedChain=null}={}){
  const submittedReports=loaded?.reports || {},reports=Object.fromEntries(Object.entries(submittedReports)
    .filter(([,report])=>verifiedVwapReportContext(report,now)));
  const liveness=reports.improvement_liveness?.document || {},cohort=reports.cohort?.document || {};
  const publication=hash(loaded?.publication_sha256)?loaded.publication_sha256.toUpperCase():null;
  const ingestionStatus=Object.keys(reports).length!==Object.keys(submittedReports).length?'BLOCKED':
    ['HEALTHY','INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY','BLOCKED','NOT_CONFIGURED','UNAVAILABLE'].includes(loaded?.ingestion?.status)
    ?loaded.ingestion.status:'UNAVAILABLE';
  const synthetic=Object.values(reports).some(report=>report.document?.evidence_class==='SYNTHETIC'
    || report.document?.status==='SOFTWARE_FIXTURE_VALIDATED' || report.document?.software_only===true);
  const proven=ingestionStatus==='HEALTHY' && Object.keys(reports).length>0 && !synthetic
    && verifiedChain?.verified===true && verifiedChain.project_id===VWAP_IMPROVEMENT_PROJECT
    && verifiedChain.publication_sha256?.toUpperCase()===publication && hash(verifiedChain.proof_sha256)
    && verifiedChain.evidence_class==='OBSERVED' && verifiedChain.material_improvement_proved===true
    && verifiedChain.status==='COMPLETE_FROM_VERIFIED_PROOFS' && Date.parse(verifiedChain.expires_at_utc)>now;
  const blockers=(Array.isArray(liveness.blockers)?liveness.blockers:[]).slice(0,12).map(safeBlocker).filter(Boolean);
  if(liveness.task)blockers.unshift(safeBlocker(liveness.task));
  if(!proven)blockers.push({code:'AUTHENTICATED_IMPROVEMENT_CHAIN_UNPROVED',owner:null,
    detail:'The complete improvement proof chain has not been independently authenticated.',next_action:null});
  const currency=typeof cohort.currency==='string' && /^[A-Z]{3}$/.test(cohort.currency)?cohort.currency:'UNKNOWN';
  return {improvement_projection_version:VWAP_IMPROVEMENT_STATUS_VERSION,strategy_id:VWAP_IMPROVEMENT_PROJECT,
    evidence_ingestion:{status:ingestionStatus,authority:ingestionStatus==='HEALTHY'?'AUTHENTICATED_PUBLICATION_ONLY':
      ingestionStatus==='INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY'?'DIAGNOSTIC_ONLY':'NONE',
      publication_sha256:publication,blockers:(loaded?.ingestion?.blockers || []).slice(0,8).map(item=>({code:code(item.code)}))},
    strategy_improvement:{status:proven?'COMPLETE_FROM_VERIFIED_PROOFS':'STALLED',proof_status:proven?'VERIFIED':'UNPROVED',
      evidence_class:synthetic?'SOFTWARE_ONLY':proven?'OBSERVED':'UNPROVED',reported_stage:text(liveness.current_stage),
      owner:text(liveness.task?.owner ?? liveness.owner ?? blockers.find(item=>item?.owner)?.owner),
      next_action:text(liveness.next_permitted_action ?? liveness.next_action ?? liveness.task?.action)
        || 'The authorized owner must provide the missing authenticated evidence and verify the proof chain.',
      blockers:blockers.filter(Boolean),paper_authorized:false,live_authorized:false,normal_brain_ingestion_authorized:false},
    observed_economics:{closed_trade_count:count(cohort.observed_closed_trade_count ?? cohort.closed_trade_count ?? cohort.closed),
      cohort_net:decimal(cohort.net_ledger_units ?? cohort.cohort_net ?? cohort.net_pnl),currency,
      chart_start:day(cohort.chart_start),chart_end:day(cohort.chart_end),open_excluded:count(cohort.open_excluded),
      interpretation:'DESCRIPTIVE_OBSERVATION_ONLY',generated_at_utc:date(cohort.generated_at_utc)},
    verified_report_links:publication?Object.values(reports).filter(report=>reportKinds.has(report.kind)
      && verifiedVwapReportContext(report,now)).map(report=>({kind:report.kind,sha256:report.sha256,
      href:`/api/workflow/vwap-improvement-monitor/reports/${report.kind}?publication_sha256=${publication}`})):[]};
}

export async function readVwapImprovementStatus({legacyState={},websiteMonitor=null,loadConfigured=readStatusConfigured,
  verifyImprovementChain,now=Date.now()}={}){
  let loaded;
  try{loaded=await loadConfigured({now});}catch{loaded={ingestion:{status:'UNAVAILABLE',blockers:[{code:'REPORT_READER_UNAVAILABLE'}]},reports:{}};}
  let verifiedChain=null;
  if(typeof verifyImprovementChain==='function'){
    try{verifiedChain=await verifyImprovementChain({loaded,now});}catch{/* No authority on verifier failure. */}
  }
  return {...legacyState,website_monitor:websiteMonitor,...timedSync('workflow.companion.status-project',()=>projectVwapImprovementStatus(loaded,{now,verifiedChain}))};
}

/** Controlled kind + current publication pin only. Re-read the entire publication
 * and report set, then verify the chosen bytes again before handing out a file. */
export async function readVwapImprovementReport(kind,publicationHash,{loadConfigured=readConfigured,now=Date.now()}={}){
  if(!reportKinds.has(kind) || !hash(publicationHash))return {status:404,error:'REPORT_NOT_AVAILABLE'};
  let loaded;try{loaded=await loadConfigured({now});}catch{return {status:503,error:'REPORT_READER_UNAVAILABLE'};}
  if(loaded?.publication_sha256?.toUpperCase()!==publicationHash.toUpperCase())return {status:409,error:'REPORT_PUBLICATION_CHANGED'};
  const report=loaded.reports?.[kind],binding=report && verifiedVwapReportContext(report,now);
  if(!binding)return {status:409,error:'REPORT_NOT_CURRENT'};
  // Reloading through the loader revalidates configured bounds, scope, schemas,
  // publication hash and freshness. Never accept a request-selected file path.
  let bytes;
  try{
    bytes=createVwapBoundedArtifactReader({maxTotalArtifactBytes:32*1024*1024,
      codePrefix:'VWAP_REPORT_DOWNLOAD_'}).read({path:report.path,
        sha256:`sha256:${report.sha256.toLowerCase()}`}).bytes;
  }catch{return {status:409,error:'REPORT_CHANGED_DURING_DOWNLOAD'};}
  return {status:200,bytes,sha256:report.sha256,filename:`vwap-${kind}-${report.sha256}.json`};
}

export async function handleVwapImprovementRequest(req,res,url,options={}){
  const json=(status,payload,diagnosticTiming=false)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(diagnosticTiming?timedSync('workflow.companion.status-serialize',()=>JSON.stringify(payload)):JSON.stringify(payload));};
  if(req.method!=='GET'){json(405,{error:{code:'METHOD_NOT_ALLOWED'}});return;}
  if(url.pathname==='/api/vwap-improvement-monitor/status'){
    json(200,await readVwapImprovementStatus(options),true);return;
  }
  const match=url.pathname.match(/^\/api\/workflow\/vwap-improvement-monitor\/reports\/([a-z_]+)$/);
  if(!match || [...url.searchParams.keys()].some(key=>key!=='publication_sha256')
    || url.searchParams.getAll('publication_sha256').length!==1){json(404,{error:{code:'REPORT_NOT_AVAILABLE'}});return;}
  const download=await readVwapImprovementReport(match[1],url.searchParams.get('publication_sha256'),options);
  if(download.status!==200){json(download.status,{error:{code:download.error}});return;}
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${download.filename}"`,
    'Content-Security-Policy':"sandbox; default-src 'none'",
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',ETag:`"${download.sha256}"`});res.end(download.bytes);
}
