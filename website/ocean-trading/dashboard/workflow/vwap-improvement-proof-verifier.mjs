import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createVwapBoundedArtifactReader } from './vwap-bounded-artifacts.mjs';

export const VWAP_PROOF_PROJECT = 'cicd-vwap-pull-back-strategy';
export const VWAP_PROOF_DOMAIN = 'trading-strategy';
export const VWAP_PROOF_PROJECT_ROOT = String.raw`C:\Users\wayne\OneDrive\Documents\Brady - Optimization`;
export const VWAP_DISCOVERY_CUSTODY_PURPOSES = Object.freeze([
  'discovery.source_binding', 'discovery.opportunity_coverage', 'discovery.pre_event_features',
  'discovery.execution_costs', 'discovery.pre_outcome_freeze',
  'discovery.market_universe',
]);
const ROLES = ['opportunities', 'features', 'orders', 'fills', 'economics', 'coverage', 'freeze', 'market_universe'];
const HASH = /^[a-f0-9]{64}$/i;
const MAX_BYTES = 32 * 1024 * 1024;
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const object = value => value !== null && !Array.isArray(value) && typeof value === 'object';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const hash = value => { requireValue(typeof value === 'string' && HASH.test(value), 'SHA-256 required'); return value.toUpperCase(); };
const sameHash = (a, b) => hash(a) === hash(b);
const compareUnicode = (a, b) => {
  const left = Array.from(a, char => char.codePointAt(0)), right = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
};

/** Python's sorted compact UTF-8 JSON, restricted to the interoperable integer
 * domain. Decimal economics belong in strings. Ambiguous JS/Python floating
 * representations fail closed rather than changing the signed payload. */
export function canonicalVwapProofJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    requireValue(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'Invalid Unicode scalar');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    requireValue(Number.isSafeInteger(value) && !Object.is(value, -0), 'Canonical proof numbers must be safe integers; encode decimals as strings');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalVwapProofJson).join(',') + ']';
  requireValue(object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Canonical JSON value invalid');
  return '{' + Object.keys(value).sort(compareUnicode).map(key => canonicalVwapProofJson(key) + ':' + canonicalVwapProofJson(value[key])).join(',') + '}';
}
const canonicalBytes = value => Buffer.from(canonicalVwapProofJson(value), 'utf8');
const sameValue = (a, b) => canonicalVwapProofJson(a) === canonicalVwapProofJson(b);
const freeze = value => { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function decodeJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true }).decode(bytes);
  const value = JSON.parse(text);
  requireValue(object(value), 'JSON object required');
  const stack = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    if (token === '{') stack.push({ keys:new Set(), key:true });
    else if (token === '[') stack.push({});
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)?.keys) stack.at(-1).key = true;
    else if (token === ':' && stack.at(-1)?.keys) stack.at(-1).key = false;
    else if (token.startsWith('"') && stack.at(-1)?.keys && stack.at(-1).key) {
      const key = JSON.parse(token), frame = stack.at(-1);
      requireValue(!frame.keys.has(key), 'Duplicate JSON key'); frame.keys.add(key);
    } else if (/^-?\d/.test(token)) {
      requireValue(/^-?(?:0|[1-9]\d*)$/.test(token) && token !== '-0' && Number.isSafeInteger(Number(token)), 'Non-interoperable JSON number');
    }
  }
  canonicalBytes(value);
  return value;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function components(file) {
  for (let current = file;;) {
    requireValue(!fs.lstatSync(current).isSymbolicLink(), 'Symlink or reparse path forbidden');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  requireValue(fs.realpathSync.native(file).toLowerCase() === file.toLowerCase(), 'Aliased path forbidden');
}
function boundedFile(file, maxBytes, root = null) {
  requireValue(typeof file === 'string' && file.length > 0 && !file.includes('\0'), 'Artifact path required');
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_BYTES, 'Invalid artifact limit');
  const absolute = root ? path.resolve(root, file) : path.resolve(file);
  requireValue(root !== null || path.isAbsolute(file), 'Absolute policy path required');
  requireValue(root === null || inside(root, absolute) && absolute !== root, 'Artifact outside evidence root');
  return createVwapBoundedArtifactReader({...(root ? {root}:{}),maxArtifactBytes:maxBytes,maxTotalArtifactBytes:maxBytes,codePrefix:'VWAP_PROOF_ARTIFACT_'}).read({path:absolute});
}
function timestamp(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Timestamp with timezone required');
  const date = value.slice(0, 10), parsed = new Date(date + 'T00:00:00Z');
  requireValue(parsed.toISOString().slice(0, 10) === date, 'Invalid calendar date');
  requireValue(Number(value.slice(11,13)) < 24 && Number(value.slice(14,16)) < 60 && Number(value.slice(17,19)) < 60, 'Invalid clock time');
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value.replace(/\.\d{1,6}/,''))) * 1000n + BigInt(fraction.padEnd(6,'0'));
}
const refBinding = ref => ({ id:ref.id, role:ref.role, sha256:ref.sha256, byte_length:ref.byte_length });
const sortBindings = refs => refs.map(refBinding).sort((a,b) => compareUnicode(a.id,b.id));

/** Owner configuration supplies policyPath and its independently obtained hash.
 * No key, policy, credential, remote call or authority is provisioned here. */
export function createVwapProofVerifier({ policyPath, expectedPolicySha256, evidenceRoot, now = () => Date.now(),
  maxArtifactBytes = MAX_BYTES, maxTotalArtifactBytes = 64 * 1024 * 1024 } = {}) {
  hash(expectedPolicySha256);
  requireValue(typeof evidenceRoot === 'string' && path.isAbsolute(evidenceRoot) && fs.statSync(evidenceRoot).isDirectory(), 'Absolute existing evidence root required');
  const root = path.resolve(evidenceRoot);
  components(root);
  const newArtifactReader = () => createVwapBoundedArtifactReader({root,maxArtifactBytes,maxTotalArtifactBytes,codePrefix:'VWAP_PROOF_ARTIFACT_'});
  newArtifactReader(); // Validate owner-configured bounds before accepting policy.
  requireValue(typeof policyPath === 'string' && path.isAbsolute(policyPath) && !inside(root, path.resolve(policyPath)), 'Trust policy must be outside evidence root');
  const policyBytes = boundedFile(policyPath, 1024 * 1024).bytes;
  requireValue(digest(policyBytes) === hash(expectedPolicySha256), 'Trust policy hash mismatch');
  const policy = decodeJson(policyBytes);
  requireValue(policy.schema_version === 'cicd-vwap-proof-trust-policy/v1', 'Unsupported trust policy');
  requireValue(policy.strategy_id === VWAP_PROOF_PROJECT && policy.domain === VWAP_PROOF_DOMAIN, 'Trust policy scope mismatch');
  requireValue(typeof policy.project_root === 'string' && path.win32.resolve(policy.project_root).toLowerCase() === VWAP_PROOF_PROJECT_ROOT.toLowerCase(), 'Trust policy registered root mismatch');
  requireValue(['AUTHENTICATED_SYSTEM','SYNTHETIC'].includes(policy.evidence_class), 'Trust policy evidence class required');
  requireValue(object(policy.subject_contracts), 'Exact subject contracts required');
  requireValue(object(policy.issuers) && Object.keys(policy.issuers).length > 0, 'Trust policy has no issuers');
  freeze(policy);
  const policySha = digest(policyBytes);
  const verifyArtifactWithReader = (ref, maxBytes, reader) => {
    requireValue(object(ref) && typeof ref.id === 'string' && ref.id.trim(), 'Artifact id required');
    const expected = hash(ref.sha256);
    requireValue(Number.isSafeInteger(ref.byte_length) && ref.byte_length >= 0 && ref.byte_length <= maxBytes, 'Artifact byte_length required');
    requireValue(typeof ref.path === 'string' && ref.path.length > 0 && !ref.path.includes('\0'), 'Artifact path required');
    const original = reader.read({...ref,path:path.resolve(root,ref.path),sha256:'sha256:'+expected.toLowerCase()});
    requireValue(original.bytes.length === ref.byte_length && digest(original.bytes) === expected, 'Artifact byte length or SHA-256 mismatch');
    return { ...original, document:decodeJson(original.bytes), sha256:expected };
  };
  const verifyArtifact = (ref, maxBytes = maxArtifactBytes) => verifyArtifactWithReader(ref,Math.min(maxBytes,maxArtifactBytes),newArtifactReader());
  const verifyReceipt = (receipt, purpose, subjectSha256) => {
    // An owner revoking/replacing the configured file invalidates this instance.
    requireValue(digest(boundedFile(policyPath, 1024 * 1024).bytes) === policySha, 'Trust policy changed');
    requireValue(receipt?.schema_version === 'cicd-vwap-signed-proof/v1' && object(receipt.payload) && object(receipt.signature), 'Signed envelope required');
    const claims = receipt.payload, signature = receipt.signature;
    requireValue(claims.strategy_id === VWAP_PROOF_PROJECT && claims.domain === VWAP_PROOF_DOMAIN && claims.project_root === policy.project_root, 'Receipt scope mismatch');
    requireValue(claims.purpose === purpose && sameHash(claims.subject_sha256, subjectSha256), 'Receipt purpose or subject mismatch');
    const subjectContract = Object.hasOwn(policy.subject_contracts,purpose) ? policy.subject_contracts[purpose] : null;
    requireValue(object(subjectContract) && Array.isArray(subjectContract.schema_versions) && typeof claims.subject_schema_version === 'string' && subjectContract.schema_versions.includes(claims.subject_schema_version), 'Subject schema not registered for purpose');
    requireValue(typeof claims.receipt_id === 'string' && claims.receipt_id.trim() && typeof claims.issuer === 'string' && claims.issuer.trim(), 'Receipt and issuer identity required');
    requireValue(claims.evidence_class === policy.evidence_class, 'Receipt evidence class mismatch');
    const issued = timestamp(claims.issued_at_utc), expires = timestamp(claims.expires_at_utc), clockMs = typeof now === 'function' ? now() : now;
    requireValue(Number.isSafeInteger(clockMs), 'Verifier clock required');
    const clock = BigInt(clockMs) * 1000n;
    const maxAge = policy.max_age_seconds ?? 7 * 86400;
    requireValue(Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 366 * 86400, 'Invalid policy receipt lifetime');
    requireValue(issued <= clock + 30000000n && expires > clock && expires > issued && clock - issued <= BigInt(maxAge) * 1000000n && expires - issued <= BigInt(maxAge) * 1000000n, 'Receipt expired, future or stale');
    requireValue(signature.algorithm === 'RS256' && typeof signature.key_id === 'string' && signature.key_id.length > 0 && signature.key_id.length <= 256 && Object.hasOwn(policy.issuers, signature.key_id), 'Untrusted issuer key or algorithm');
    const issuer = policy.issuers[signature.key_id];
    requireValue(object(issuer) && issuer.issuer === claims.issuer && Array.isArray(issuer.allowed_purposes) && issuer.allowed_purposes.every(value=>typeof value==='string') && issuer.allowed_purposes.includes(purpose), 'Issuer not authorized for purpose');
    if (['improvement.candidate','improvement.review','improvement.verdict','improvement.paper_approval'].includes(purpose)) {
      requireValue(Array.isArray(issuer.allowed_actor_ids) && issuer.allowed_actor_ids.every(value=>typeof value==='string') && typeof claims.actor_id === 'string' && issuer.allowed_actor_ids.includes(claims.actor_id), 'Issuer policy does not bind this actor identity');
    }
    requireValue(issuer.revoked !== true, 'Issuer key revoked');
    if (issuer.not_before_utc) requireValue(issued >= timestamp(issuer.not_before_utc), 'Key not valid when issued');
    if (issuer.not_after_utc) requireValue(expires <= timestamp(issuer.not_after_utc), 'Receipt outlives issuer key');
    requireValue(typeof signature.value === 'string' && signature.value.length > 0 && signature.value.length <= 16384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature.value), 'Invalid signature encoding');
    requireValue(typeof issuer.public_key_pem === 'string' && /^-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(issuer.public_key_pem) && /^[\x00-\x7F]*$/.test(issuer.public_key_pem), 'Issuer public key PEM required');
    const publicKey = crypto.createPublicKey(issuer.public_key_pem);
    requireValue(publicKey.asymmetricKeyType === 'rsa' && publicKey.asymmetricKeyDetails.modulusLength >= 2048, 'Issuer must use RSA key of at least 2048 bits');
    requireValue(crypto.verify('RSA-SHA256', canonicalBytes(claims), { key:publicKey, padding:crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(signature.value,'base64')), 'Receipt signature invalid');
    return freeze({ ...structuredClone(claims), verified:true, trust_policy_sha256:policySha,
      verification_key_sha256:digest(publicKey.export({type:'spki',format:'der'})) });
  };
  const verifyDiscoveryAdmission = async ({ document, report_sha256, manifest_sha256, learning_rows_sha256 } = {}) => {
    // One budget covers every evidence read in this admission, including nested
    // originals and all receipt envelopes. Do not reset the counter per file.
    const admissionReader = newArtifactReader();
    const verifyOriginal = (ref, maxBytes = maxArtifactBytes) => verifyArtifactWithReader(ref,Math.min(maxBytes,maxArtifactBytes),admissionReader);
    requireValue(object(document), 'Discovery report required');
    hash(report_sha256);
    requireValue(document.schema_version === 'cicd-vwap-discovery-admission/v1' && document.strategy_id === VWAP_PROOF_PROJECT && document.domain === VWAP_PROOF_DOMAIN && document.project_root === policy.project_root, 'Discovery report scope mismatch');
    requireValue(document.evidence_class === (policy.evidence_class === 'AUTHENTICATED_SYSTEM' ? 'OBSERVED':'SYNTHETIC'), 'Synthetic evidence cannot qualify market research');
    const manifestOriginal = verifyOriginal(document.manifest_artifact), manifest = manifestOriginal.document;
    requireValue(sameHash(manifestOriginal.sha256, manifest_sha256) && sameHash(manifestOriginal.sha256, document.manifest_sha256) && sameHash(manifestOriginal.sha256, document.signed_subject_sha256), 'Discovery manifest hash mismatch');
    requireValue(manifest.schema_version === 'cicd-vwap-discovery-manifest/v1' && manifest.strategy_id === VWAP_PROOF_PROJECT && manifest.domain === VWAP_PROOF_DOMAIN && manifest.dataset_role === 'DISCOVERY' && document.dataset_role === 'DISCOVERY' && manifest.evidence_class === document.evidence_class && typeof manifest.run_id === 'string' && manifest.run_id && document.run_id === manifest.run_id, 'Discovery manifest identity mismatch');
    requireValue(sameValue(document.source_binding, manifest.source_binding), 'Discovery source binding mismatch');
    requireValue(object(manifest.source_binding), 'Discovery source binding required');
    for (const field of ['source_sha256','built_dll_sha256','loaded_dll_sha256','config_sha256','context_sha256']) hash(manifest.source_binding[field]);
    requireValue(sameHash(manifest.source_binding.built_dll_sha256,manifest.source_binding.loaded_dll_sha256), 'Discovery built and loaded DLL differ');
    const start=timestamp(manifest.start_utc),end=timestamp(manifest.end_utc);
    requireValue(start < end && timestamp(manifest.role_preassigned_at_utc) < start && timestamp(manifest.warmup_start_utc) <= start && timestamp(manifest.source_binding.effective_from_utc) <= start && timestamp(manifest.source_binding.effective_to_utc) >= end, 'Discovery source/role interval invalid');
    const refs = document.original_artifacts;
    requireValue(Array.isArray(refs) && refs.length === ROLES.length && new Set(refs.map(ref=>ref?.id)).size === refs.length && sameValue(refs.map(ref=>ref?.role).sort(), [...ROLES].sort()), 'Discovery original roles missing or duplicate');
    requireValue(Array.isArray(manifest.artifacts) && sameValue(sortBindings(refs), [...manifest.artifacts].sort((a,b)=>compareUnicode(a.id,b.id))) && sameValue(document.verified_originals,sortBindings(refs)), 'Discovery originals not bound to manifest');
    const originals = Object.fromEntries(refs.map(ref => [ref.role, verifyOriginal(ref)]));
    for (const role of ROLES) {
      const original = originals[role].document;
      requireValue(original.schema_version === `cicd-vwap-discovery-${role.replaceAll('_','-')}/v1` && original.strategy_id === VWAP_PROOF_PROJECT && original.run_id === manifest.run_id, 'Discovery original identity mismatch');
    }
    const universe=originals.market_universe.document;
    const market=verifyOriginal(universe.market_data_ref).document, calendar=verifyOriginal(universe.calendar_ref).document;
    requireValue(market.schema_version === 'cicd-vwap-market-bars/v1' && market.contract === manifest.contract && calendar.schema_version === 'cicd-vwap-market-calendar/v1' && calendar.contract === manifest.contract && calendar.timezone === manifest.timezone, 'Discovery market/calendar original identity mismatch');
    const opportunities = originals.opportunities.document.records;
    requireValue(Array.isArray(opportunities) && opportunities.length > 0 && opportunities.length <= 100000, 'Discovery opportunities required');
    requireValue(sameHash(digest(canonicalBytes(opportunities)), document.row_set_sha256), 'Discovery opportunity rowset changed');
    const opportunityRef = document.opportunity_rows_artifact;
    requireValue(object(opportunityRef) && sameValue(opportunityRef,refs.find(ref=>ref.role==='opportunities')), 'Discovery opportunity reference mismatch');
    const receipts = document.custody_receipt_artifacts;
    requireValue(Array.isArray(receipts) && receipts.length >= VWAP_DISCOVERY_CUSTODY_PURPOSES.length && receipts.length <= 64, 'Discovery custody receipts required');
    const envelopes = receipts.map(ref => verifyOriginal(ref, 1024*1024).document);
    const verified = [], receiptIds = new Set();
    for (const purpose of VWAP_DISCOVERY_CUSTODY_PURPOSES) {
      const matches = envelopes.filter(envelope => envelope.payload?.purpose === purpose);
      requireValue(matches.length === 1, 'Discovery custody purpose missing or duplicate');
      const claims = verifyReceipt(matches[0],purpose,manifestOriginal.sha256);
      requireValue(claims.run_id === manifest.run_id && claims.subject_schema_version === manifest.schema_version && !receiptIds.has(claims.receipt_id), 'Discovery custody run/schema mismatch or replayed receipt');
      if (purpose === 'discovery.pre_outcome_freeze') {
        const frozen = originals.freeze.document, issued = timestamp(claims.issued_at_utc);
        requireValue(timestamp(frozen.frozen_at_utc) <= issued && issued < timestamp(frozen.outcome_access_started_at_utc),
          'Authenticated freeze must be sealed before outcome access');
      }
      receiptIds.add(claims.receipt_id); verified.push(claims);
    }
    const sourceCustody = verified.find(claim=>claim.purpose==='discovery.source_binding');
    const universeCustody = verified.find(claim=>claim.purpose==='discovery.market_universe');
    requireValue(sourceCustody.issuer !== universeCustody.issuer && sourceCustody.verification_key_sha256 !== universeCustody.verification_key_sha256, 'Discovery market universe needs independent custody');
    const learning = verifyOriginal(document.learning_rows_artifact);
    requireValue(Array.isArray(learning.document.records), 'Discovery learning records required');
    const projected = deriveVwapDiscoveryLearningRows(manifest, Object.fromEntries(ROLES.map(role=>[role,originals[role].document])),Object.fromEntries(refs.map(ref=>[ref.role,ref])),manifestOriginal.sha256);
    requireValue(sameValue(learning.document, projected) && sameValue(document.learning_rows,projected), 'Discovery learning rows differ from authenticated originals');
    const rowHash = digest(canonicalBytes(projected.records));
    requireValue(sameHash(rowHash, learning_rows_sha256) && sameHash(rowHash, document.learning_rows_sha256), 'Discovery learning rowset hash mismatch');
    requireValue(policy.evidence_class === 'AUTHENTICATED_SYSTEM' && manifest.evidence_class === 'OBSERVED', 'Synthetic evidence cannot qualify market research');
    return freeze({ verified:true, report_sha256:hash(report_sha256), manifest_sha256:manifestOriginal.sha256,
      run_id:manifest.run_id, strategy_id:VWAP_PROOF_PROJECT, domain:VWAP_PROOF_DOMAIN, project_root:policy.project_root,
      verified_custody:verified, learning_rows_sha256:rowHash, trust_policy_sha256:policySha });
  };
  return Object.freeze(Object.assign(verifyReceipt, { verifyReceipt, verifyDiscoveryAdmission, verifyArtifact,
    evidenceClass:policy.evidence_class, policySha256:policySha, trust_policy_sha256:policySha }));
}

// The exact W3 learning-row bridge is shared with vwap_discovery_intake.py.
// It is deliberately a projection, not a second feature/coverage/P&L evaluator.
export function deriveVwapDiscoveryLearningRows(manifest, artifacts, originals, manifestSha256) {
  requireValue(Array.isArray(artifacts.opportunities?.records) && Array.isArray(artifacts.features?.records) && Array.isArray(artifacts.economics?.records), 'Learning projection originals required');
  const opportunities = new Map(artifacts.opportunities.records.map(row=>[row.opportunity_key,row]));
  const features = new Map(artifacts.features.records.map(row=>[row.opportunity_key,row]));
  requireValue(opportunities.size === artifacts.opportunities.records.length && features.size === artifacts.features.records.length, 'Duplicate learning opportunity or feature key');
  const binding = manifest.source_binding, rows = [], ids = new Set(), optional=(value,key)=>value[key] ?? null;
  for (const economic of artifacts.economics.records) {
    if (economic.status !== 'OBSERVED_CLOSED') continue;
    const key = economic.opportunity_key, opportunity = opportunities.get(key), feature = features.get(key);
    requireValue(opportunity && feature && typeof economic.trade_id === 'string' && economic.trade_id && !ids.has(economic.trade_id), 'Learning closed-trade identity missing or duplicate');
    ids.add(economic.trade_id);
    const row = { strategy_id:VWAP_PROOF_PROJECT,run_id:manifest.run_id,dataset_role:'DISCOVERY',environment:'REPLAY',trade_id:economic.trade_id,opportunity_key:key,
      setup_id:optional(opportunity,'setup_id'),signal_id:optional(opportunity,'signal_id'),session_id:optional(opportunity,'session_id'),session_name:opportunity.session,
      trading_day:optional(opportunity,'trading_day'),side:opportunity.side,regime_label:optional(feature.hmm.output,'regime'),
      volatility_label:optional(feature.atr.output,'volatility_label'),vwap_reclaim_state:optional(feature.vwap.output,'reclaim_state'),
      net_pnl:economic.net,gross_pnl:economic.gross,fees:economic.fees,slippage:economic.slippage,quantity:economic.quantity,contract_value:economic.contract_value,currency:economic.currency,
      mfe:optional(economic,'mfe'),mae:optional(economic,'mae'),excursion_units:optional(economic,'excursion_units'),
      code_hash:binding.source_sha256,config_hash:binding.config_sha256,context_hash:binding.context_sha256,dataset_id:manifest.dataset_id,contract:manifest.contract,fill_ids:[...economic.fill_ids] };
    row.research_eligible=opportunity.opportunity_preconditions_met === true && opportunity.proposal_state === 'PROPOSED' &&
      ['hmm','vwap','atr'].every(family=>feature[family]?.ready === true && feature[family]?.prefix_evidence_status === 'COMPLETE_EPOCH') &&
      feature.hmm?.provenance_status === 'EXACT_EXPORTED';
    const context = ['setup_id','signal_id','session_id','regime_label','volatility_label','vwap_reclaim_state','mfe','mae','excursion_units'];
    row.quality_flags=context.filter(field=>row[field]===null || row[field]==='').map(field=>field+'_missing');
    if (!row.research_eligible) row.quality_flags.push('pre_event_mechanism_evidence_incomplete');
    row.learning_context_complete=row.quality_flags.length===0;
    rows.push(row);
  }
  return { schema_version:'cicd-vwap-learning-rows/v1',strategy_id:VWAP_PROOF_PROJECT,run_id:manifest.run_id,manifest_sha256:hash(manifestSha256),
    mapping_version:'discovery-originals-to-closed-trades/v1',original_opportunities_sha256:originals.opportunities.sha256,
    original_economics_sha256:originals.economics.sha256,records:rows };
}
