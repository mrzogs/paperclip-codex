import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowStore } from './store.mjs';
import { issueOceanIdentity, passwordVerifier, humanBinding } from './auth.mjs';
import { exactKeys, objectHash, digest, requireThat, ROLES } from './common.mjs';
import { setupOperation } from './setup-operator.mjs';
import { testFixtureOperation } from './test-communication.mjs';

export const PENDING = [
  { role: 'BRAIN', direction: 'Brain-to-Ocean', owner: 'Brain', due_step: 'S24' },
  { role: 'TELEMETRY', direction: 'gateway-to-Ocean', owner: 'Telemetry', due_step: 'S26' },
  { role: 'STRATEGY', direction: 'strategy-to-Ocean', owner: 'Strategy', due_step: 'S27' },
].map(row => ({ ...row, state: 'PENDING', reason: 'Actual caller identity and exact scopes await owner enrollment.' }));

export function prepareOperation({ action, state, password, request, operator_id, root }) {
  requireThat(typeof operator_id === 'string' && operator_id.startsWith('S-1-'), 403, 'WINDOWS_OPERATOR_SID_REQUIRED');
  requireThat(path.isAbsolute(root), 422, 'ABSOLUTE_OPERATOR_ROOT_REQUIRED');
  requireThat(['initialize','bootstrap'].includes(action) ? !state || (action === 'initialize' && state.config?.browser?.state === 'UNENROLLED') : state?.config?.operator_managed, 409, 'OPERATOR_STATE_CONFLICT');
  const next = state ? structuredClone(state) : {
    revision: 0, config: { operator_managed: true, contract_release: '2.1.0', test_only: true,
      db_file: path.join(root, 'workflow.sqlite'), allowed_origins: ['http://localhost:3102', 'http://127.0.0.1:3102'],
      python_executable: 'C:\\Users\\wayne\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      browser: { state: 'UNENROLLED', subject_id: 'wayne-ocean-ui', credential_ref: 'OCEAN_WAYNE_PASSWORD_SECRET' },
      identities: [], pending_services: PENDING, brain_submission: 'OFF', dispatch_worker: 'OFF', live_real: 'DISABLED' }, environment: {},
  };
  requireThat(next.config.db_file === path.join(root, 'workflow.sqlite'), 403, 'WORKFLOW_ROOT_CONFLICT');
  let identityId = action === 'bootstrap' ? 'ocean-machine-foundation' : 'wayne-ocean-ui';
  if (action === 'bootstrap') requireThat(!password && !request,422,'BOOTSTRAP_CANNOT_ENROLL_IDENTITIES');
  else if (action === 'initialize' || action === 'reset-password') {
    next.config.browser = { state:'CONFIGURED', subject_id:'wayne-ocean-ui', credential_ref:'OCEAN_WAYNE_PASSWORD_SECRET' };
    next.environment[next.config.browser.credential_ref] = passwordVerifier(password);
  }
  else {
    exactKeys(request, ['identity_id','role','namespace','credential_ref','strategy_ids','instance_ids','scopes','expires_at_utc','owner','evidence_path','evidence_sha256','verification_only','renewal_policy']);
    requireThat(request && typeof request.owner === 'string' && request.owner.length && path.isAbsolute(request.evidence_path || ''), 422, 'VERIFIED_OWNER_EVIDENCE_REQUIRED');
    requireThat(/^[a-f0-9]{64}$/.test(request.evidence_sha256) && digest(fs.readFileSync(request.evidence_path)) === `sha256:${request.evidence_sha256}`, 409, 'OWNER_EVIDENCE_HASH_CONFLICT');
    identityId = request.identity_id;
    requireThat(/^[A-Za-z0-9_.-]+$/.test(identityId || ''),422,'SAFE_HANDOFF_ID_REQUIRED');
    const old = next.config.identities.find(item => item.identity_id === identityId);
    if(action==='enroll' && !old)requireThat(next.config.identities.length<32,409,'IDENTITY_REGISTRY_CAPACITY_REACHED');
    requireThat(Array.isArray(request.scopes) && request.scopes.length && request.scopes.every(value => ROLES[request.role]?.includes(value)), 422, 'EXACT_ACTION_SCOPE_REQUIRED');
    if (request.verification_only) requireThat(/^test-s23[12]-/.test(identityId) && request.scopes.every(value => value === 'read') && request.strategy_ids.every(value => /^test_s23[12]_/.test(value)) && request.instance_ids.every(value => /^test-s23[12]-/.test(value)), 403, 'SEGREGATED_VERIFICATION_SCOPE_REQUIRED');
    if (request.renewal_policy) {
      exactKeys(request.renewal_policy,['lifetime_seconds','renew_before_seconds','runner','destination']);
      const policy=request.renewal_policy;
      requireThat(Number.isInteger(policy.lifetime_seconds) && policy.lifetime_seconds >= 120 && policy.lifetime_seconds <= 90*86400 &&
        Number.isInteger(policy.renew_before_seconds) && policy.renew_before_seconds >= 30 && policy.renew_before_seconds < policy.lifetime_seconds &&
        policy.runner === 'ocean-website-maintenance' && policy.destination === 'dpapi-current-operator',422,'INVALID_RENEWAL_POLICY');
    }
    const immutable = ['identity_id','role','namespace','credential_ref','strategy_ids','instance_ids','scopes','owner','verification_only','renewal_policy'];
    if (old) for (const key of immutable) requireThat(objectHash(old[key] ?? null) === objectHash(request[key] ?? null), 409, 'IDENTITY_OR_SCOPE_CHANGE_REJECTED');
    if (action === 'enroll' && old) {
      requireThat(!old.revoked && Date.parse(old.expires_at_utc)>Date.now(),409,'IDENTITY_LIFECYCLE_CONFLICT');
      return { operation_id:randomUUID(),action,identity_id:identityId,operator_id,previous_hash:objectHash(state),next,next_hash:objectHash(next) };
    }
    requireThat(action === 'enroll' ? !old : old && (!old.revoked || action === 'revoke'), 409, 'IDENTITY_LIFECYCLE_CONFLICT');
    if (action === 'verify') {
      const proof = JSON.parse(fs.readFileSync(request.evidence_path,'utf8').replace(/^\uFEFF/,''));
      requireThat(proof.schema_version === 'ocean-consumer-verification/v1' && proof.identity_id === identityId && proof.audience === old.audience && proof.credential_hash === old.credential_hash && Date.parse(old.expires_at_utc) > Date.now(),409,'CONSUMER_PROOF_BINDING_CONFLICT');
      for (const key of ['strategy_ids','instance_ids','scopes']) requireThat(objectHash(proof[key]) === objectHash(old[key]),409,'CONSUMER_PROOF_SCOPE_CONFLICT');
      const due = ['allowed','missing','invalid','wrong_strategy','wrong_instance','wrong_action','forged_human','expired_or_revoked'];
      requireThat(due.every(name => proof.tests?.some(row => row.name === name && row.status === 'PASS' && row.test_type === 'ACTUAL_CONSUMER_TO_OCEAN')),422,'ACTUAL_CONSUMER_PROOF_REQUIRED');
      old.verification_state = 'VERIFIED';
      old.verification_evidence_sha256 = request.evidence_sha256;
      old.verified_at_utc = new Date().toISOString();
    } else if (action === 'revoke') old.revoked = true;
    else {
      requireThat(['enroll','rotate'].includes(action), 422, 'UNKNOWN_OPERATOR_ACTION');
      const { expires_at_utc, evidence_path, evidence_sha256, ...identity } = request;
      const issued = issueOceanIdentity({ ...identity, credential_version:(old?.credential_version || 0)+1, owner_evidence_sha256: evidence_sha256, audience: 'Ocean workflow TEST', verification_state: 'CONFIGURED_NOT_VERIFIED' }, next.environment, expires_at_utc);
      requireThat(!next.config.identities.some(item => item.identity_id !== identityId && item.credential_ref === issued.credential_ref), 409, 'CREDENTIAL_REFERENCE_IN_USE');
      if (old) next.config.identities[next.config.identities.indexOf(old)] = issued;
      else next.config.identities.push(issued);
    }
  }
  next.revision += 1;
  return { operation_id: randomUUID(), action, identity_id: identityId, operator_id,
    previous_hash: state ? objectHash(state) : null, next, next_hash: objectHash(next) };
}

// The encrypted pending transaction is persisted by the OS wrapper before this commit.
// A stale active file cannot revive old credentials; resume publishes the committed candidate.
export function commitOperation(plan) {
  requireThat(plan.next_hash === objectHash(plan.next), 409, 'OPERATOR_PLAN_HASH_CONFLICT');
  const store = new WorkflowStore(plan.next.config.db_file);
  try {
    const backupDir = path.join(path.dirname(plan.next.config.db_file),'backups');
    fs.mkdirSync(backupDir,{recursive:true});
    requireThat(/^[a-f0-9-]{36}$/.test(plan.operation_id),422,'INVALID_OPERATOR_OPERATION_ID');
    const snapshot = path.join(backupDir,`${plan.operation_id}.sqlite`);
    if (!fs.existsSync(snapshot)) store.db.prepare('VACUUM INTO ?').run(snapshot);
    const probe = new DatabaseSync(snapshot,{readOnly:true});
    try { requireThat(probe.prepare('PRAGMA quick_check').get().quick_check === 'ok',503,'WORKFLOW_BACKUP_FAILED'); }
    finally { probe.close(); }
    return store.transaction(() => {
      const current = store.db.prepare("SELECT credential_hash FROM ow_auth_state WHERE id='bundle'").get()?.credential_hash ?? null;
      if (current === plan.next_hash) return { committed: true, idempotent: true, revision: plan.next.revision };
      requireThat(current === plan.previous_hash, 409, 'STALE_OPERATOR_TRANSACTION');
      const browserHash = humanBinding(plan.next.config,plan.next.environment).hash || 'HUMAN_DISABLED';
      if (!store.browserCurrent(browserHash)) {
        store.db.exec('DELETE FROM ow_sessions');
        store.db.prepare("INSERT INTO ow_auth_state VALUES('browser',?) ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash").run(browserHash);
      }
      for (const identity of plan.next.config.identities) store.db.prepare('INSERT INTO ow_identities VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json').run(identity.identity_id, identity.role, JSON.stringify(identity));
      store.db.prepare("INSERT INTO ow_auth_state VALUES('bundle',?) ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash").run(plan.next_hash);
      store.db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run(plan.action, plan.identity_id, plan.previous_hash, plan.next_hash, plan.operator_id, new Date().toISOString());
      return { committed: true, idempotent: false, revision: plan.next.revision };
    });
  } finally { store.close(); }
}

export function verifyState(state) {
  const store = new WorkflowStore(state.config.db_file);
  try {
    requireThat(store.db.prepare("SELECT credential_hash FROM ow_auth_state WHERE id='bundle'").get()?.credential_hash === objectHash(state), 503, 'OPERATOR_RESUME_REQUIRED');
    return { revision: state.revision, test_only: state.config.test_only, brain_submission: state.config.brain_submission,
      dispatch_worker: state.config.dispatch_worker, db_file: state.config.db_file, allowed_origins: state.config.allowed_origins,
      browser: { subject_id: 'wayne-ocean-ui', state:humanBinding(state.config,state.environment).state,
        configured: Boolean(humanBinding(state.config,state.environment).hash && store.browserCurrent(humanBinding(state.config,state.environment).hash)) },
      identities: state.config.identities.map(({ credential_hash, ...identity }) => ({ ...identity, state: identity.revoked ? 'REVOKED' : Date.parse(identity.expires_at_utc) <= Date.now() ? 'EXPIRED' : identity.verification_state })),
      pending_services: state.config.pending_services, audit_events: store.db.prepare('SELECT COUNT(*) AS n FROM ow_auth_audit').get().n };
  } finally { store.close(); }
}

export function prepareMaintenance({state,operator_id,root}) {
  verifyState(state);
  const next=structuredClone(state);
  const renewed=[];
  for (const old of next.config.identities) {
    const policy=old.renewal_policy;
    if (!policy || old.revoked || Date.parse(old.expires_at_utc)<=Date.now() || Date.parse(old.expires_at_utc)-Date.now()>policy.renew_before_seconds*1000) continue;
    requireThat(policy.runner === 'ocean-website-maintenance' && policy.destination === 'dpapi-current-operator',403,'MAINTENANCE_POLICY_CONFLICT');
    const identity=issueOceanIdentity({...old,credential_version:(old.credential_version || 0)+1},next.environment,new Date(Date.now()+policy.lifetime_seconds*1000).toISOString());
    next.config.identities[next.config.identities.indexOf(old)]=identity;
    renewed.push(identity.identity_id);
  }
  if (!renewed.length) return {no_change:true,revision:state.revision};
  next.revision+=1;
  return {operation_id:randomUUID(),action:'renew',identity_id:renewed.join(','),operator_id,previous_hash:objectHash(state),next,next_hash:objectHash(next)};
}

export function cancelPendingRenewal({state,pending,request,operator_id,root}) {
  requireThat(pending?.action==='renew',409,'ONLY_PENDING_RENEWAL_CAN_BE_CANCELLED');
  // Either side of the durable registry commit can be revoked without publishing the candidate.
  let current=state;
  try { verifyState(current); } catch { current=pending.next;verifyState(current); }
  return prepareOperation({action:'revoke',state:current,request,operator_id,root});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    if(['setup','test-fixture'].includes(input.mode))verifyState(input.state);
    let result;
    if(input.mode==='test-fixture') {
      const store=new WorkflowStore(input.state.config.db_file);
      try {result=testFixtureOperation(input,store);} finally {store.close();}
    } else result = input.mode === 'setup' ? setupOperation(input) : input.mode === 'cancel-renewal' ? cancelPendingRenewal(input) : input.mode === 'prepare' ? prepareOperation(input) : input.mode === 'maintenance' ? prepareMaintenance(input) : input.mode === 'commit' ? commitOperation(input.plan) : verifyState(input.state);
    process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.code || 'OPERATOR_FAILED' })); process.exitCode = 1; }
}
