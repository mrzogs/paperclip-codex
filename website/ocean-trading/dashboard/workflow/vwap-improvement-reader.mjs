import fs from 'node:fs';
import { timedSync } from '../request-timing.mjs';
import path from 'node:path';
import { loadVwapImprovementReports } from './vwap-improvement-reports.mjs';
import { validateVwapDiscoveryAdmission } from './vwap-discovery-admission.mjs';
import { createVwapDiscoverySemanticAdapter } from './vwap-discovery-semantic-adapter.mjs';
import { createVwapProofVerifier, VWAP_PROOF_PROJECT, VWAP_PROOF_DOMAIN,
  VWAP_PROOF_PROJECT_ROOT } from './vwap-improvement-proof-verifier.mjs';

export const VWAP_READER_CONFIG_SCHEMA = 'ocean-vwap-improvement-report-reader/v1';
const HASH = /^[a-f0-9]{64}$/i;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const blocked = code => ({ingestion:{status:'BLOCKED',authority:'NONE',blockers:[{code}]},reports:{},proof_links:[]});

// The path is selected by the operator's startup environment, never an HTTP
// parameter or a report. This reads configuration only, not a trading ledger.
export function readVwapImprovementReaderConfig(file) {
  check(typeof file === 'string' && path.isAbsolute(file), 'REPORT_READER_CONFIG_PATH_REQUIRED');
  const absolute = path.resolve(file);
  for (let part = absolute; ; part = path.dirname(part)) {
    check(!fs.lstatSync(part).isSymbolicLink(), 'REPORT_READER_CONFIG_ALIAS');
    if (part === path.dirname(part)) break;
  }
  const before = fs.lstatSync(absolute);
  check(before.isFile() && before.size > 0 && before.size <= 65536, 'REPORT_READER_CONFIG_SIZE');
  const fd = fs.openSync(absolute,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let raw;
  try {
    const opened = fs.fstatSync(fd);
    check(opened.isFile() && opened.ino === before.ino && opened.size === before.size, 'REPORT_READER_CONFIG_CHANGED');
    raw = Buffer.alloc(opened.size);
    let count = 0;
    while (count < raw.length) { const n = fs.readSync(fd,raw,count,raw.length-count,null); if (!n) break; count += n; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(absolute);
    check(count === raw.length && after.size === before.size && after.mtimeMs === before.mtimeMs
      && named.ino === before.ino && named.mtimeMs === before.mtimeMs && !named.isSymbolicLink(), 'REPORT_READER_CONFIG_CHANGED');
  } finally { fs.closeSync(fd); }
  const config = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  check(config.schema_version === VWAP_READER_CONFIG_SCHEMA, 'REPORT_READER_CONFIG_SCHEMA');
  check(config.project_id === VWAP_PROOF_PROJECT && config.domain === VWAP_PROOF_DOMAIN
    && config.project_root === VWAP_PROOF_PROJECT_ROOT, 'REPORT_READER_CONFIG_SCOPE');
  check(typeof config.evidence_root === 'string' && path.isAbsolute(config.evidence_root)
    && typeof config.manifest_path === 'string' && config.manifest_path
    && HASH.test(config.publication_sha256 || ''), 'REPORT_READER_PUBLICATION_BINDING');
  check(config.publication_schema === 'cicd-vwap-report-publication/v1'
    && config.report_schemas && typeof config.report_schemas === 'object'
    && !Array.isArray(config.report_schemas) && Object.keys(config.report_schemas).length <= 6
    && Object.values(config.report_schemas).every(value => typeof value === 'string' && value.length), 'REPORT_READER_SCHEMA_BINDING');
  check(config.required_kinds === undefined || Array.isArray(config.required_kinds)
    && config.required_kinds.length > 0 && config.required_kinds.every(kind => Object.hasOwn(config.report_schemas,kind)), 'REPORT_READER_REQUIRED_KINDS');
  check(config.max_age_ms === undefined || Number.isSafeInteger(config.max_age_ms)
    && config.max_age_ms > 0 && config.max_age_ms <= 86400000, 'REPORT_READER_FRESHNESS_BOUND');
  for (const [name,limit] of [['max_bytes',32*1024*1024],['max_total_bytes',128*1024*1024]]) {
    check(config[name] === undefined || Number.isSafeInteger(config[name]) && config[name] > 0
      && config[name] <= limit, 'REPORT_READER_BYTE_BOUND');
  }
  return Object.freeze(config);
}

export async function loadConfiguredVwapImprovementReports({
  configFile = process.env.OCEAN_VWAP_IMPROVEMENT_REPORT_CONFIG,
  now = Date.now(), loadReports = loadVwapImprovementReports,
  diagnosticTiming = false,
} = {}) {
  if (!configFile) return {ingestion:{status:'NOT_CONFIGURED',authority:'NONE',blockers:[{code:'REPORT_READER_NOT_CONFIGURED'}]},reports:{},proof_links:[]};
  try {
    const config = diagnosticTiming ? timedSync('workflow.companion.reader-config',()=>readVwapImprovementReaderConfig(configFile))
      : readVwapImprovementReaderConfig(configFile);
    // No publication callback is inferred from an unsigned report or a JSON
    // boolean. These reports are diagnostic until independent custody verifies.
    const readReports = () => loadReports({root:config.evidence_root,project:config.project_id,
      domain:config.domain,projectRoot:config.project_root,manifestPath:config.manifest_path,
      expectedPublicationHash:config.publication_sha256,publicationSchema:config.publication_schema,
      reportSchemas:config.report_schemas,requiredKinds:config.required_kinds,
      maxAgeMs:config.max_age_ms,maxBytes:config.max_bytes,maxTotalBytes:config.max_total_bytes,now});
    const loaded = await (diagnosticTiming ? timedSync('workflow.companion.report-loader.sync', readReports) : readReports());
    return {...loaded,config};
  } catch (error) { return blocked(error.code || error.message || 'REPORT_READER_FAILED'); }
}

export async function loadConfiguredVwapDiscoveryAdmission({
  configFile = process.env.OCEAN_VWAP_IMPROVEMENT_REPORT_CONFIG,
  semanticConfigFile = process.env.OCEAN_VWAP_DISCOVERY_SEMANTIC_CONFIG,
  semanticConfigSha256 = process.env.OCEAN_VWAP_DISCOVERY_SEMANTIC_CONFIG_SHA256,
  now = Date.now(), loadReports = loadConfiguredVwapImprovementReports,
  createVerifier = createVwapProofVerifier, validateAdmission = validateVwapDiscoveryAdmission,
  createSemanticAdapter = createVwapDiscoverySemanticAdapter,
} = {}) {
  const loaded = await loadReports({configFile,now});
  const denied = blockers => ({admitted:false,admission:null,blockers,publication_sha256:loaded.publication_sha256 || null,
    ingestion:loaded.ingestion});
  if (!loaded.config || !loaded.reports.discovery_admission || !loaded.reports.learning_rows)
    return denied([{code:'DISCOVERY_PUBLISHED_REPORTS_REQUIRED'},...(loaded.ingestion?.blockers || [])]);
  try {
    const config = loaded.config;
    // Publisher configuration selects diagnostic bytes only. Admission authority
    // comes from a separately pinned Website operator descriptor.
    check(typeof semanticConfigFile === 'string' && path.isAbsolute(semanticConfigFile)
      && HASH.test(semanticConfigSha256 || ''), 'DISCOVERY_SEMANTIC_CONFIG_REQUIRED');
    const semantic = createSemanticAdapter({descriptorPath:semanticConfigFile,expectedDescriptorSha256:semanticConfigSha256});
    const binding = semantic?.admissionBinding;
    check(typeof semantic === 'function' && binding && path.resolve(binding.evidence_root) === path.resolve(config.evidence_root),
      'DISCOVERY_SEMANTIC_EVIDENCE_ROOT_MISMATCH');
    check(typeof binding.trust_policy_file === 'string' && HASH.test(binding.trust_policy_sha256 || ''), 'DISCOVERY_TRUST_POLICY_REQUIRED');
    check(HASH.test(binding.baseline_sha256 || '') && HASH.test(binding.config_sha256 || ''), 'DISCOVERY_ACTIVE_BINDING_REQUIRED');
    const verifier = createVerifier({policyPath:binding.trust_policy_file,expectedPolicySha256:binding.trust_policy_sha256,
      evidenceRoot:config.evidence_root,now:() => now,verifyDiscoverySemantics:semantic});
    const admission = await validateAdmission({report:loaded.reports.discovery_admission,
      learningRowsReport:loaded.reports.learning_rows,verifyAdmission:verifier.verifyDiscoveryAdmission,
      discoverySchema:config.report_schemas.discovery_admission,baselineSha256:binding.baseline_sha256,
      configSha256:binding.config_sha256,now});
    return {...admission,rows:admission.admitted ? loaded.reports.learning_rows.document.records : [],
      publication_sha256:loaded.publication_sha256,ingestion:loaded.ingestion};
  } catch (error) { return denied([{code:error.code || error.message || 'DISCOVERY_AUTHENTICATION_FAILED'}]); }
}
