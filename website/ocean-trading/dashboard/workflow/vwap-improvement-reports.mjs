import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalVwapProofJson } from './vwap-improvement-proof-verifier.mjs';

const verifiedReports = new WeakMap();
const HASH = /^[a-f0-9]{64}$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const fail = code => { throw new Error(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };
export const vwapArtifactSha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

// Same sorted, compact UTF-8 JSON contract as vwap_improvement_contracts.py.
export const canonicalVwapJson = canonicalVwapProofJson;

function checkComponents(absolute) {
  let current = absolute;
  while (true) {
    requireValue(!fs.lstatSync(current).isSymbolicLink(), 'REPORT_ALIAS_PATH_REJECTED');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function boundedFile(file, root, maxBytes) {
  requireValue(typeof file === 'string' && file.length > 0 && !file.includes('\0'), 'REPORT_PATH_INVALID');
  const candidate = path.resolve(root, file);
  requireValue(!candidate.slice(path.parse(candidate).root.length).includes(':'), 'REPORT_ALTERNATE_STREAM_REJECTED');
  const relative = path.relative(root, candidate);
  requireValue(relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'REPORT_OUTSIDE_ROOT');
  checkComponents(candidate);
  requireValue(fs.realpathSync.native(candidate) === candidate, 'REPORT_ALIAS_PATH_REJECTED');
  requireValue(fs.lstatSync(candidate).isFile(), 'REPORT_REGULAR_FILE_REQUIRED');
  const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    requireValue(before.isFile(), 'REPORT_REGULAR_FILE_REQUIRED');
    requireValue(before.size <= maxBytes, 'REPORT_SIZE_LIMIT');
    const bytes = Buffer.alloc(before.size);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(fd), named = fs.statSync(candidate);
    requireValue(length <= maxBytes && length === before.size, 'REPORT_SIZE_CHANGED');
    requireValue(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino && named.ino === before.ino && named.size === before.size && named.mtimeMs === before.mtimeMs, 'REPORT_CHANGED_DURING_READ');
    checkComponents(candidate);
    return { bytes:bytes.subarray(0, length), path:candidate };
  } finally { fs.closeSync(fd); }
}

function objectJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal:true }).decode(bytes);
  const document = JSON.parse(text);
  requireValue(document && !Array.isArray(document) && typeof document === 'object', 'REPORT_OBJECT_REQUIRED');
  const stack = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    if (token === '{') stack.push({ keys:new Set(), key:true });
    else if (token === '[') stack.push({});
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
    else if (token === ':' && stack.at(-1)?.keys) stack.at(-1).key = false;
    else if (token.startsWith('"') && stack.at(-1)?.keys && stack.at(-1).key) {
      const key = JSON.parse(token), frame = stack.at(-1);
      requireValue(!frame.keys.has(key), 'REPORT_DUPLICATE_JSON_KEY'); frame.keys.add(key);
    }
  }
  return document;
}
function timestamp(value) {
  requireValue(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'REPORT_TIMESTAMP_INVALID');
  return Date.parse(value);
}
function fresh(value, now, maxAgeMs) {
  const issued = timestamp(value);
  requireValue(issued <= now + 30000 && now - issued <= maxAgeMs, 'REPORT_STALE_OR_FUTURE');
}
function scope(document, expected) {
  requireValue(document && (document.project_id ?? document.strategy_id) === expected.project && (!Object.hasOwn(document,'strategy_id') || document.strategy_id === expected.project) && document.domain === expected.domain && document.project_root === expected.projectRoot, 'REPORT_SCOPE_MISMATCH');
}
function reportScope(document, expected) {
  requireValue((document.project_id ?? document.strategy_id) === expected.project && (!Object.hasOwn(document,'domain') || document.domain === expected.domain) && (!Object.hasOwn(document,'project_root') || document.project_root === expected.projectRoot), 'REPORT_SCOPE_MISMATCH');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Read only local published originals. The verifier comes from trusted owner
 * configuration, never from report content. Integrity alone grants no authority.
 * Schema identifiers are supplied from the authoritative shared contract. */
export async function loadVwapImprovementReports({ root, project, domain, projectRoot, manifestPath,
  expectedPublicationHash, publicationSchema, reportSchemas, requiredKinds = ['collector_health','cohort','exit_reconciliation','improvement_liveness'],
  verifyPublication, now = Date.now(), maxAgeMs = 15 * 60 * 1000, maxBytes = MAX_BYTES, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
  try {
    requireValue(typeof root === 'string' && path.isAbsolute(root) && !root.startsWith('\\\\'), 'REPORT_ROOT_REQUIRED');
    requireValue([project,domain,projectRoot,publicationSchema].every(value => typeof value === 'string' && value.length), 'REPORT_TRUSTED_SCOPE_REQUIRED');
    requireValue(HASH.test(expectedPublicationHash || ''), 'REPORT_PUBLICATION_HASH_REQUIRED');
    requireValue(Number.isFinite(now) && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_BYTES && Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && maxTotalBytes <= 128*1024*1024, 'REPORT_LIMITS_INVALID');
    checkComponents(root);
    requireValue(fs.statSync(root).isDirectory() && fs.realpathSync.native(root) === path.resolve(root), 'REPORT_ROOT_ALIAS_REJECTED');
    const publication = boundedFile(manifestPath, root, maxBytes);
    const publicationHash = vwapArtifactSha256(publication.bytes);
    requireValue(publicationHash === expectedPublicationHash.toUpperCase(), 'REPORT_PUBLICATION_HASH_MISMATCH');
    const manifest = objectJson(publication.bytes), expected = {project,domain,projectRoot};
    scope(manifest.scope, expected);
    requireValue(manifest.schema_version === publicationSchema && ['INTEGRITY_ONLY','SIGNED_CUSTODY'].includes(manifest.provenance?.level), 'REPORT_PUBLICATION_INCOMPLETE');
    requireValue(manifest.provenance.level !== 'SIGNED_CUSTODY' || manifest.signed_publication?.purpose === 'improvement.report_publication' && typeof verifyPublication === 'function', 'REPORT_PUBLICATION_AUTHENTICATION_REQUIRED');
    fresh(manifest.published_at_utc, now, maxAgeMs);
    let claims = null;
    if (verifyPublication !== undefined) {
      requireValue(typeof verifyPublication === 'function', 'REPORT_PUBLICATION_AUTHENTICATION_REQUIRED');
      claims = await verifyPublication({ document:freeze(manifest), sha256:publicationHash, bytes:Buffer.from(publication.bytes) });
      requireValue(claims?.verified === true && claims.purpose === 'improvement.report_publication' && claims.subject_sha256?.toUpperCase() === publicationHash, 'REPORT_PUBLICATION_AUTHENTICATION_FAILED');
      scope(claims, expected);
      requireValue(timestamp(claims.expires_at_utc) > now, 'REPORT_PUBLICATION_AUTHENTICATION_EXPIRED');
    }
    requireValue(Array.isArray(manifest.reports) && manifest.reports.length > 0 && manifest.reports.length <= 64, 'REPORT_REFERENCE_SET_INVALID');
    const reports = Object.create(null), ids = new Set(), paths = new Set();
    let totalBytes = publication.bytes.length;
    requireValue(totalBytes <= maxTotalBytes, 'REPORT_AGGREGATE_SIZE_LIMIT');
    for (const ref of manifest.reports) {
      requireValue(ref && typeof ref.kind === 'string' && !Object.hasOwn(reports, ref.kind) && typeof ref.id === 'string' && ref.id && !ids.has(ref.id), 'REPORT_DUPLICATE_OR_INVALID_REFERENCE');
      requireValue(Object.hasOwn(reportSchemas || {}, ref.kind) && typeof ref.schema_version === 'string' && ref.schema_version && HASH.test(ref.sha256 || '') && Number.isSafeInteger(ref.byte_length) && ref.byte_length >= 0 && ref.byte_length <= maxBytes, 'REPORT_REFERENCE_INVALID');
      totalBytes += ref.byte_length;
      requireValue(totalBytes <= maxTotalBytes, 'REPORT_AGGREGATE_SIZE_LIMIT');
      const original = boundedFile(ref.path, root, maxBytes), sha256 = vwapArtifactSha256(original.bytes);
      requireValue(!paths.has(original.path), 'REPORT_DUPLICATE_PATH');
      requireValue(sha256 === ref.sha256.toUpperCase() && original.bytes.length === ref.byte_length, 'REPORT_HASH_OR_LENGTH_MISMATCH');
      const document = objectJson(original.bytes);
      reportScope(document, expected);
      requireValue(document.schema_version === reportSchemas[ref.kind] && (!ref.schema_version || ref.schema_version === document.schema_version), 'REPORT_SCHEMA_MISMATCH');
      const generatedAt = document.generated_at_utc ?? (['discovery_admission','learning_rows'].includes(ref.kind) ? manifest.published_at_utc : undefined);
      fresh(generatedAt, now, maxAgeMs);
      requireValue(timestamp(generatedAt) <= timestamp(manifest.published_at_utc), 'REPORT_POSTDATES_PUBLICATION');
      const report = freeze({ document, path:original.path, sha256, kind:ref.kind });
      verifiedReports.set(report, { ...expected, publicationHash, authentication:claims ? 'AUTHENTICATED_PUBLICATION' : 'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY', expiresAt:claims ? timestamp(claims.expires_at_utc) : timestamp(manifest.published_at_utc)+maxAgeMs, validUntil:Math.min(timestamp(generatedAt),timestamp(manifest.published_at_utc)) + maxAgeMs });
      reports[ref.kind] = report; ids.add(ref.id); paths.add(original.path);
    }
    requireValue(requiredKinds.every(kind => Object.hasOwn(reports, kind)), 'REPORT_REQUIRED_SET_INCOMPLETE');
    return freeze({ ingestion:{status:claims ? 'HEALTHY' : 'INTEGRITY_VERIFIED_DIAGNOSTIC_ONLY',authority:claims ? 'AUTHENTICATED_PUBLICATION_ONLY' : 'DIAGNOSTIC_ONLY',blockers:[]}, reports, publication_sha256:publicationHash,
      proof_links:Object.values(reports).map(report => ({kind:report.kind,path:report.path,sha256:report.sha256})) });
  } catch (error) {
    return { ingestion:{status:'BLOCKED',blockers:[{code:error?.message || 'REPORT_READ_FAILED'}]}, reports:{}, proof_links:[] };
  }
}

export function verifiedVwapReportContext(report, now = Date.now()) {
  const binding = verifiedReports.get(report);
  if (!binding || now >= binding.expiresAt || now > binding.validUntil) return null;
  return { ...binding };
}
