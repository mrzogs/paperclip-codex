import { canonicalVwapJson, verifiedVwapReportContext, vwapArtifactSha256 } from './vwap-improvement-reports.mjs';
import { VWAP_DISCOVERY_CUSTODY_PURPOSES } from './vwap-improvement-proof-verifier.mjs';

const admissions = new WeakMap();
const HASH = /^[a-f0-9]{64}$/i;
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const sortedRows = rows => [...rows].sort((a,b) => Buffer.compare(Buffer.from(a.trade_id,'utf8'),Buffer.from(b.trade_id,'utf8')));
export const vwapDiscoveryRowsSha256 = rows => vwapArtifactSha256(Buffer.from(canonicalVwapJson(rows), 'utf8'));
const rowContentSetHash = rows => vwapDiscoveryRowsSha256(sortedRows(rows));

/** The publication binds the bytes; independently authenticated original
 * custody receipts establish research admission. Neither caller flags nor counters
 * can stand in for either boundary. Verifiers are trusted owner dependencies. */
export async function validateVwapDiscoveryAdmission({ report, learningRowsReport, verifyAdmission,
  discoverySchema, requiredCustodyPurposes, baselineSha256, configSha256, now = Date.now() } = {}) {
  try {
    const context = verifiedVwapReportContext(report,now), document = report?.document;
    requireValue(context, 'DISCOVERY_VERIFIED_PUBLICATION_REQUIRED');
    requireValue(typeof discoverySchema === 'string' && document.schema_version === discoverySchema, 'DISCOVERY_SCHEMA_MISMATCH');
    requireValue(document.status === 'QUALIFIED_DISCOVERY' && document.eligible_for_candidate_selection === true && document.evidence_class === 'OBSERVED' && document.dataset_role === 'DISCOVERY', 'DISCOVERY_NOT_QUALIFIED');
    requireValue(Array.isArray(document.errors) && !document.errors.length, 'DISCOVERY_ADMISSION_ERRORS');
    requireValue(HASH.test(baselineSha256 || '') && HASH.test(configSha256 || '') && document.source_binding?.source_sha256?.toUpperCase() === baselineSha256.toUpperCase() && document.source_binding?.config_sha256?.toUpperCase() === configSha256.toUpperCase(), 'DISCOVERY_ACTIVE_SOURCE_CONFIG_MISMATCH');
    const learningContext = verifiedVwapReportContext(learningRowsReport,now);
    const learningRows = learningRowsReport?.document?.records;
    requireValue(learningContext && learningContext.publicationHash === context.publicationHash && document.learning_rows_artifact?.sha256?.toUpperCase() === learningRowsReport.sha256 && document.learning_rows_artifact?.path === learningRowsReport.path, 'DISCOVERY_LEARNING_ROWS_PUBLICATION_REQUIRED');
    requireValue(Array.isArray(learningRows) && learningRows.length > 0 && learningRows.length <= 100000, 'DISCOVERY_LEARNING_ROWS_REQUIRED');
    const ids = new Set();
    for (const row of learningRows) {
      requireValue(row && typeof row.trade_id === 'string' && row.trade_id && !ids.has(row.trade_id), 'DISCOVERY_DUPLICATE_OR_MISSING_TRADE_ID');
      requireValue(row.strategy_id === context.project && row.dataset_role === 'DISCOVERY' && row.environment === 'REPLAY' && row.run_id === document.run_id && (row.session_id === null || typeof row.session_id === 'string' && row.session_id.length > 0), 'DISCOVERY_ROW_SCOPE_MISMATCH');
      requireValue((typeof row.net_pnl === 'string' && /^-?\d+(?:\.\d+)?$/.test(row.net_pnl) || typeof row.net_pnl === 'number' && Number.isFinite(row.net_pnl)) && Number.isFinite(Number(row.net_pnl)), 'DISCOVERY_ROW_ECONOMICS_INVALID');
      ids.add(row.trade_id);
    }
    const rowSetHash = vwapDiscoveryRowsSha256(learningRows);
    requireValue(HASH.test(document.learning_rows_sha256 || '') && document.learning_rows_sha256.toUpperCase() === rowSetHash, 'DISCOVERY_ROW_SET_HASH_MISMATCH');
    requireValue(typeof verifyAdmission === 'function', 'DISCOVERY_AUTHENTICATED_RECEIPT_REQUIRED');
    // The authoritative W3 custody receipts sign original manifest bytes, not a
    // locally generated report. The bridge must independently verify that chain
    // and return derived bindings. A publisher signature cannot replace it.
    const claims = await verifyAdmission({document,report_sha256:report.sha256,manifest_sha256:document.signed_subject_sha256,learning_rows_sha256:rowSetHash});
    requireValue(claims?.verified === true && claims.report_sha256?.toUpperCase() === report.sha256 && claims.manifest_sha256?.toUpperCase() === document.signed_subject_sha256?.toUpperCase() && HASH.test(document.signed_subject_sha256 || '') && document.signed_subject_sha256.toUpperCase() === document.manifest_sha256?.toUpperCase() && claims.strategy_id === context.project && claims.domain === context.domain && claims.project_root === context.projectRoot && claims.run_id === document.run_id && claims.learning_rows_sha256?.toUpperCase() === rowSetHash, 'DISCOVERY_RECEIPT_BINDING_MISMATCH');
    requireValue(claims.semantic_admission?.status === 'QUALIFIED_DISCOVERY'
      && HASH.test(claims.semantic_admission.report_sha256 || '')
      && HASH.test(claims.semantic_admission.intake_package_sha256 || '')
      && claims.semantic_admission.learning_rows_sha256?.toUpperCase() === rowSetHash,
    'DISCOVERY_AUTHORITATIVE_SEMANTICS_REQUIRED');
    const expectedPurposes = canonicalVwapJson([...VWAP_DISCOVERY_CUSTODY_PURPOSES].sort());
    requireValue((requiredCustodyPurposes === undefined || Array.isArray(requiredCustodyPurposes) && canonicalVwapJson([...requiredCustodyPurposes].sort()) === expectedPurposes) && Array.isArray(document.required_custody_purposes) && canonicalVwapJson([...document.required_custody_purposes].sort()) === expectedPurposes && Array.isArray(claims.verified_custody) && claims.verified_custody.length === VWAP_DISCOVERY_CUSTODY_PURPOSES.length, 'DISCOVERY_CUSTODY_PURPOSES_REQUIRED');
    let expiresAt = Infinity;
    for (const purpose of document.required_custody_purposes) {
      requireValue(typeof purpose === 'string' && purpose.startsWith('discovery.'), 'DISCOVERY_CUSTODY_PURPOSES_REQUIRED');
      const matching = claims.verified_custody.filter(item => item.purpose === purpose);
      requireValue(matching.length === 1, 'DISCOVERY_CUSTODY_MISSING_OR_DUPLICATE');
      const item = matching[0], issuedAt = timestamp(item.issued_at_utc), expiry = timestamp(item.expires_at_utc);
      requireValue(item.verified === true && item.strategy_id === context.project && item.domain === context.domain && item.run_id === document.run_id && item.subject_sha256?.toUpperCase() === document.manifest_sha256.toUpperCase(), 'DISCOVERY_CUSTODY_BINDING_MISMATCH');
      requireValue(Number.isFinite(issuedAt) && issuedAt <= now + 30000 && expiry > now && expiry > issuedAt, 'DISCOVERY_RECEIPT_EXPIRED_OR_FUTURE');
      expiresAt = Math.min(expiresAt,expiry);
    }
    const universe = claims.verified_custody.find(item=>item.purpose === 'discovery.market_universe');
    const source = claims.verified_custody.find(item=>item.purpose === 'discovery.source_binding');
    requireValue(!universe || typeof universe.issuer === 'string' && universe.issuer.length > 0 && universe.issuer !== source?.issuer && HASH.test(universe.verification_key_sha256 || '') && HASH.test(source?.verification_key_sha256 || '') && universe.verification_key_sha256.toUpperCase() !== source.verification_key_sha256.toUpperCase(), 'DISCOVERY_MARKET_UNIVERSE_INDEPENDENCE_REQUIRED');
    const admission = Object.freeze({ admitted:true, report_sha256:report.sha256, publication_sha256:context.publicationHash, run_id:document.run_id, learning_rows_sha256:rowSetHash,
      semantic_admission:Object.freeze({...claims.semantic_admission}) });
    admissions.set(admission,{report,learningRowsReport,context,rowSetHash,contentSetHash:rowContentSetHash(learningRows),expiresAt,rows:learningRows});
    return { admitted:true, admission, blockers:[] };
  } catch (error) {
    return { admitted:false, admission:null, blockers:[{code:error?.message || 'DISCOVERY_ADMISSION_FAILED'}] };
  }
}

export function verifiedVwapDiscoveryRows(admission, rows, { strategyId, now = Date.now() } = {}) {
  const trusted = admissions.get(admission);
  if (!trusted) return {rows:[],blockers:[{code:'DISCOVERY_ADMISSION_REQUIRED'}]};
  if (!verifiedVwapReportContext(trusted.report,now) || !verifiedVwapReportContext(trusted.learningRowsReport,now) || now >= trusted.expiresAt) return {rows:[],blockers:[{code:'DISCOVERY_ADMISSION_EXPIRED'}]};
  if (strategyId !== trusted.context.project) return {rows:[],blockers:[{code:'DISCOVERY_ADMISSION_SCOPE_MISMATCH'}]};
  try {
    if (rows.length !== trusted.rows.length || rowContentSetHash(rows) !== trusted.contentSetHash) return {rows:[],blockers:[{code:'DISCOVERY_ADMISSION_ROW_SET_MISMATCH'}]};
  } catch {
    return {rows:[],blockers:[{code:'DISCOVERY_ADMISSION_ROW_SET_MISMATCH'}]};
  }
  return {rows:trusted.rows,blockers:[],report_sha256:trusted.report.sha256};
}
