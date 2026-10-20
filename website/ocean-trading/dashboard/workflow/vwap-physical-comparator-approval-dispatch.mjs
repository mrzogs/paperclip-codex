import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVwapPhysicalComparatorContract, DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT } from './vwap-physical-comparator-contract.mjs';
import { projectVwapContinuity, currentVwapContinuity } from './vwap-continuity-projection.mjs';

export const APPROVAL_DISPATCH_SCHEMA = 'ocean-vwap-physical-comparator-approval-dispatch/v1';
export const APPROVAL_DISPATCH_STATE_SCHEMA = 'ocean-vwap-physical-comparator-approval-dispatch-state/v1';
export const DEFAULT_VWAP_APPROVAL_DISPATCH_CONFIG = process.env.OCEAN_VWAP_APPROVAL_DISPATCH_CONFIG
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'cicd-vwap-v238-approval-dispatch.json');
export const DEFAULT_VWAP_APPROVAL_DISPATCH_STATE = process.env.OCEAN_VWAP_APPROVAL_DISPATCH_STATE
  || 'D:\\OceanTradingData\\website\\ocean-runtime\\cicd-vwap-v238-approval-dispatch-state.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const APPROVAL_SCOPES = new Set(['DATASET_PHYSICAL_SELECTION', 'RUN_RELEASE']);
const WAITING_STATUSES = new Set(['pending', 'revision_requested']);
const DENIED_STATUSES = new Set(['rejected', 'cancelled']);
const STARTED_STATUSES = new Set(['running', 'succeeded', 'failed', 'timed_out']);
const nowUtc = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const bufferDigest = value => crypto.createHash('sha256').update(value).digest('hex');

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive:true });
  const temporary = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}
function samePath(left, right) {
  return path.win32.normalize(String(left || '')).toLowerCase() === path.win32.normalize(String(right || '')).toLowerCase();
}
function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}
function publicState(config, status, details = {}) {
  return {
    schema_version:APPROVAL_DISPATCH_STATE_SCHEMA,
    strategy_id:config.strategy_id,
    enabled:config.enabled,
    status,
    checked_at_utc:nowUtc(),
    contract_id:config.sealed_authority.contract_id,
    contract_hash:config.sealed_authority.contract_hash,
    document_hash:config.sealed_authority.document_hash,
    run_id:config.sealed_authority.run_id,
    context_hash:config.sealed_authority.context_hash,
    issue_id:config.paperclip.issue_id,
    issue_identifier:config.paperclip.issue_identifier,
    coordinator_agent_id:config.paperclip.coordinator_agent_id,
    gate:{...config.coordinator_gate},
    safety:{...config.safety},
    ...details,
  };
}

function validatePreflightOutcome(config) {
  const outcome = config.preflight_outcome || {};
  requireValue(outcome.status === 'BLOCKED_PHYSICAL_BINDING_MISMATCH'
    && UUID.test(String(outcome.heartbeat_run_id || ''))
    && Number.isFinite(Date.parse(outcome.completed_at_utc))
    && /^reasoning-[0-9]{14}-[0-9a-f]{8}$/.test(String(outcome.brain_record_id || ''))
    && /^reasoning-[0-9]{14}-[0-9a-f]{8}$/.test(String(outcome.supplemental_brain_record_id || ''))
    && outcome.account_alias === 'Sim1'
    && samePath(outcome.chartbook_path, 'D:\\Trading\\SierraChart-Replay Two\\Data\\CICD - VWAP Pull Back Strategy.Cht'),
  'APPROVAL_DISPATCH_PREFLIGHT_OUTCOME_INVALID');
  for (const artifact of [outcome.strategy_artifact, outcome.telemetry_artifact]) {
    requireValue(artifact && SHA256.test(String(artifact.saved_hash || '').toLowerCase())
      && SHA256.test(String(artifact.selected_hash || '').toLowerCase())
      && artifact.saved_hash.toLowerCase() !== artifact.selected_hash.toLowerCase()
      && path.win32.isAbsolute(String(artifact.selected_source_path || '')),
    'APPROVAL_DISPATCH_PREFLIGHT_ARTIFACT_INVALID');
  }
  requireValue(UUID.test(String(outcome.next_task?.issue_id || ''))
    && /^OCEA-[0-9]+$/.test(String(outcome.next_task?.issue_identifier || ''))
    && outcome.next_task?.status_source === 'PAPERCLIP_LIVE'
    && /^http:\/\/127\.0\.0\.1:3100\/OCEA\/issues\/OCEA-[0-9]+$/.test(String(outcome.next_task?.url || '')),
  'APPROVAL_DISPATCH_PREFLIGHT_TASK_INVALID');
}

function validateStagingAuthorityConfig(config) {
  const staging = config.staging_authority || {}, outcome = config.preflight_outcome || {};
  requireValue(UUID.test(String(staging.issue_id || '')) && staging.issue_id === outcome.next_task?.issue_id
    && staging.issue_identifier === outcome.next_task?.issue_identifier
    && UUID.test(String(staging.approval_id || '')) && UUID.test(String(staging.attachment_id || ''))
    && staging.package_schema_version === 'cicd-vwap-sim1-staging-authority-package/v1'
    && RAW_SHA256.test(String(staging.package_sha256 || ''))
    && staging.approval_scope === 'TEST_STAGING_WRITE_SINGLE_DIAGNOSTIC_START_ONLY'
    && staging.approval_url === `http://127.0.0.1:3100/OCEA/approvals/${staging.approval_id}`
    && staging.package_url === `http://127.0.0.1:3100/api/attachments/${staging.attachment_id}/content`,
  'APPROVAL_DISPATCH_STAGING_AUTHORITY_INVALID');
  requireValue(staging.timeframe?.bar_seconds === 300 && staging.timeframe?.display === '5 minutes'
    && staging.timeframe?.one_minute_disposition === 'SUPERSEDED_UNQUALIFIED_OBSERVATION_SETUP',
  'APPROVAL_DISPATCH_STAGING_TIMEFRAME_INVALID');
  requireValue(path.win32.isAbsolute(String(staging.mutable_reference?.path || ''))
    && RAW_SHA256.test(String(staging.mutable_reference?.captured_sha256 || ''))
    && staging.mutable_reference?.classification === 'INFORMATIONAL_SNAPSHOT_NOT_PHYSICAL_PREFLIGHT_PIN'
    && staging.mutable_reference?.fresh_reauthentication_required === true,
  'APPROVAL_DISPATCH_STAGING_MUTABLE_REFERENCE_INVALID');
  requireValue(staging.continuation?.requester_agent_id === config.paperclip.coordinator_agent_id
    && staging.continuation?.approval_resolution_wakes_requester === true
    && staging.continuation?.ocean_liveness_repair_enabled === true
    && Number(staging.continuation?.paperclip_wakeup_grace_ms) >= 0
    && staging.continuation?.next_action === 'REAUTHENTICATE_PACKAGE_AND_DERIVE_ONLY_EXACT_APPROVED_FILESYSTEM_SCOPE'
    && UUID.test(String(staging.continuation?.existing_run_release_approval_id || ''))
    && staging.continuation?.existing_run_release_scope === 'RUN_RELEASE'
    && path.win32.isAbsolute(String(staging.continuation?.run_release_output_root || ''))
    && staging.continuation?.combine_existing_scopes_after_gates === false
    && staging.continuation?.existing_run_release_reuse_status === 'BLOCKED_POST_STAGING_CHARTBOOK_HASH_NOT_PREAUTHORIZED'
    && staging.continuation?.playback_authorized === false
    && staging.continuation?.next_human_gate === 'CONSOLIDATED_POST_STAGING_RUN_RELEASE_AND_REPLAY_MEASUREMENT_START_AFTER_CONTROLLER_PROOF'
    && staging.continuation?.staging_success_receipt?.schema_version === 'cicd-vwap-sim1-staging-success-receipt/v1'
    && path.win32.isAbsolute(String(staging.continuation?.staging_success_receipt?.path || ''))
    && staging.continuation?.staging_success_receipt?.authority === 'PACKAGE_BOUND_CICD_COORDINATOR_READBACK'
    && staging.continuation?.staging_success_receipt?.required_status === 'STAGED_DIAGNOSTIC_VERIFIED_AWAITING_POST_STAGING_RUN_AUTHORITY'
    && staging.continuation?.staging_success_receipt?.accepted_before_playback === true
    && staging.continuation?.staging_success_receipt?.immutable_hash_required === true
    && staging.continuation?.execution_route?.mode === 'REQUIRE_APPROVAL_BOUND_NARROW_EXECUTOR'
    && staging.continuation?.execution_route?.adapter_config_mutation_authorized === false
    && staging.continuation?.execution_route?.command_policy_enforced === false
    && UUID.test(String(staging.continuation?.execution_route?.engineering_issue_id || ''))
    && /^OCEA-[0-9]+$/.test(String(staging.continuation?.execution_route?.engineering_issue_identifier || ''))
    && typeof staging.continuation?.execution_route?.engineering_issue_title === 'string'
    && staging.continuation.execution_route.engineering_issue_title.length > 0
    && staging.continuation?.execution_route?.engineering_issue_owner_agent_id === config.paperclip.coordinator_agent_id
    && Array.isArray(staging.continuation?.execution_route?.required_source_read_paths)
    && staging.continuation.execution_route.required_source_read_paths.length === 2
    && staging.continuation.execution_route.required_source_read_paths.every(value => path.win32.isAbsolute(String(value)))
    && JSON.stringify(staging.continuation?.execution_route?.diagnostic_commands_only) === JSON.stringify(['STATUS','DIAGNOSTICS','STUDY_INPUT_EXPORT'])
    && staging.continuation?.execution_route?.measurement_start_allowed === false
    && staging.continuation?.no_ocean_approval_authority === true,
  'APPROVAL_DISPATCH_STAGING_CONTINUATION_INVALID');
  const runReleaseApproval = config.sealed_authority?.approvals?.find(item => item.decision_scope === 'RUN_RELEASE');
  requireValue(runReleaseApproval?.approval_id === staging.continuation.existing_run_release_approval_id,
    'APPROVAL_DISPATCH_STAGING_RUN_RELEASE_SCOPE_INVALID');
  requireValue(Array.isArray(staging.allowed_future_write_paths) && staging.allowed_future_write_paths.length > 0
    && new Set(staging.allowed_future_write_paths.map(value => path.win32.normalize(String(value)).toLowerCase())).size === staging.allowed_future_write_paths.length
    && staging.allowed_future_write_paths.every(value => path.win32.isAbsolute(String(value))),
  'APPROVAL_DISPATCH_STAGING_WRITE_PATHS_INVALID');
}

export function loadVwapPhysicalComparatorApprovalDispatchConfig(configPath = DEFAULT_VWAP_APPROVAL_DISPATCH_CONFIG) {
  const config = readJson(configPath);
  requireValue(config?.schema_version === APPROVAL_DISPATCH_SCHEMA, 'APPROVAL_DISPATCH_CONFIG_INVALID');
  requireValue(config.strategy_id === 'cicd-vwap-pull-back-strategy' && config.namespace === 'TEST', 'APPROVAL_DISPATCH_IDENTITY_INVALID');
  requireValue(config.enabled === true && Number(config.poll_interval_ms) >= 1000, 'APPROVAL_DISPATCH_SCHEDULE_INVALID');
  const paperclip = config.paperclip || {};
  requireValue(['company_id','project_id','workspace_id','issue_id','coordinator_agent_id'].every(key => UUID.test(String(paperclip[key] || ''))), 'APPROVAL_DISPATCH_PAPERCLIP_BINDING_INVALID');
  requireValue(paperclip.issue_identifier === 'OCEA-20' && paperclip.coordinator_name === 'CICD VWAP Recovery Coordinator', 'APPROVAL_DISPATCH_TARGET_INVALID');
  const sealed = config.sealed_authority || {};
  requireValue(SHA256.test(sealed.contract_hash) && SHA256.test(sealed.document_hash) && SHA256.test(sealed.context_hash), 'APPROVAL_DISPATCH_HASH_INVALID');
  requireValue(Array.isArray(sealed.approvals) && sealed.approvals.length === 2
    && new Set(sealed.approvals.map(item => item.approval_id)).size === 2
    && new Set(sealed.approvals.map(item => item.decision_scope)).size === 2
    && sealed.approvals.every(item => UUID.test(String(item.approval_id || '')) && APPROVAL_SCOPES.has(item.decision_scope)), 'APPROVAL_DISPATCH_APPROVAL_BINDING_INVALID');
  const gate = config.coordinator_gate || {};
  requireValue(gate.action === 'READ_ONLY_PREFLIGHT_ONLY'
    && gate.current_permission_state === 'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE'
    && gate.post_preflight_gate === 'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED'
    && gate.post_preflight_action === 'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT'
    && Array.isArray(gate.required_read_only_paths) && gate.required_read_only_paths.length >= 4, 'APPROVAL_DISPATCH_GATE_INVALID');
  const safety = config.safety || {};
  requireValue(Object.values(safety).every(value => value === false), 'APPROVAL_DISPATCH_SAFETY_INVALID');
  validatePreflightOutcome(config);
  validateStagingAuthorityConfig(config);
  return {...config, config_path:configPath};
}

export function readVwapPhysicalComparatorApprovalDispatchState(statePath = DEFAULT_VWAP_APPROVAL_DISPATCH_STATE, strategyId = 'cicd-vwap-pull-back-strategy') {
  const state = readJson(statePath);
  if (!state) return {schema_version:APPROVAL_DISPATCH_STATE_SCHEMA, strategy_id:strategyId, enabled:true, status:'NOT_OBSERVED', checked_at_utc:null,
    gate:{action:'READ_ONLY_PREFLIGHT_ONLY', current_permission_state:'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE', post_preflight_gate:'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED', post_preflight_action:'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT'},
    safety:{execution_authority:false,runtime_write_scope_authorized:false,replay_start_authorized:false,paper_authorized:false,live_authorized:false,automatic_approval_enabled:false}};
  const safe = state?.safety || {}, gate = state?.gate || {};
  if (state.schema_version !== APPROVAL_DISPATCH_STATE_SCHEMA || state.strategy_id !== strategyId
    || Object.values(safe).some(value => value !== false)
    || gate.action !== 'READ_ONLY_PREFLIGHT_ONLY'
    || gate.current_permission_state !== 'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE'
    || gate.post_preflight_gate !== 'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED'
    || gate.post_preflight_action !== 'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT'
    || (state.status === 'PREFLIGHT_BLOCKED_PHYSICAL_BINDING' && state.staging_authority?.authoritative !== true)) return {schema_version:APPROVAL_DISPATCH_STATE_SCHEMA, strategy_id:strategyId, enabled:true, status:'ATTENTION_REQUIRED', reason:'APPROVAL_DISPATCH_STATE_INVALID', checked_at_utc:nowUtc(),
      gate:{action:'READ_ONLY_PREFLIGHT_ONLY', current_permission_state:'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE', post_preflight_gate:'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED', post_preflight_action:'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT'},
      safety:{execution_authority:false,runtime_write_scope_authorized:false,replay_start_authorized:false,paper_authorized:false,live_authorized:false,automatic_approval_enabled:false}};
  return {...state,continuity:currentVwapContinuity(state.continuity)};
}

async function requestJson(config, relative, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.request_timeout_ms || 5000));
  try {
    const base = String(config.paperclip.api_base_url).replace(/\/+$/, '');
    const response = await fetchImpl(base + relative, {...options, signal:controller.signal, headers:{Accept:'application/json', ...(options.headers || {})}});
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error('PAPERCLIP_' + response.status + ':' + text.slice(0, 300));
    return body;
  } finally { clearTimeout(timer); }
}
async function requestBytes(config, relative, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.request_timeout_ms || 5000));
  try {
    const base = String(config.paperclip.api_base_url).replace(/\/+$/, '');
    const response = await fetchImpl(base + relative, {...options, signal:controller.signal, headers:{Accept:'application/json', ...(options.headers || {})}});
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error('PAPERCLIP_' + response.status + ':' + bytes.toString('utf8', 0, 300));
    return bytes;
  } finally { clearTimeout(timer); }
}
function validateContract(config, contract) {
  const sealed = config.sealed_authority;
  requireValue(contract.state === 'AVAILABLE', 'APPROVAL_DISPATCH_CONTRACT_UNAVAILABLE');
  requireValue(contract.strategy_id === config.strategy_id && contract.namespace === config.namespace
    && contract.contract_id === sealed.contract_id && contract.contract_hash === sealed.contract_hash
    && contract.document_hash === sealed.document_hash && contract.run_context?.run_id === sealed.run_id
    && contract.run_context?.context_hash === sealed.context_hash, 'APPROVAL_DISPATCH_CONTRACT_CHANGED');
  const actual = new Map(contract.required_human_approvals.map(item => [item.approval_id, item.decision_scope]));
  requireValue(sealed.approvals.every(item => actual.get(item.approval_id) === item.decision_scope), 'APPROVAL_DISPATCH_CONTRACT_APPROVALS_CHANGED');
}
function validateApproval(config, expected, approval) {
  const payload = approval?.payload || {}, sealed = config.sealed_authority;
  requireValue(approval?.id === expected.approval_id && approval?.companyId === config.paperclip.company_id
    && approval?.type === 'request_board_approval' && payload.strategy_id === config.strategy_id
    && payload.namespace === config.namespace && payload.contract_id === sealed.contract_id
    && payload.contract_hash === sealed.contract_hash && payload.context_hash === sealed.context_hash
    && payload.run_id === sealed.run_id && payload.decision_scope === expected.decision_scope,
  'APPROVAL_DISPATCH_APPROVAL_MISMATCH:' + expected.decision_scope);
  if (expected.decision_scope === 'RUN_RELEASE') requireValue(
    samePath(payload.output_root, config.staging_authority.continuation.run_release_output_root),
    'APPROVAL_DISPATCH_RUN_RELEASE_OUTPUT_ROOT_MISMATCH');
}
function validateIssueAndAgent(config, issue, agent, stagingApproved) {
  const expected = config.paperclip;
  requireValue(issue?.id === expected.issue_id && issue?.identifier === expected.issue_identifier
    && issue?.companyId === expected.company_id && issue?.projectId === expected.project_id
    && issue?.projectWorkspaceId === expected.workspace_id && issue?.assigneeAgentId === expected.coordinator_agent_id,
  'APPROVAL_DISPATCH_ISSUE_BINDING_INVALID');
  requireValue(!['done','cancelled'].includes(String(issue.status || '').toLowerCase()), 'APPROVAL_DISPATCH_ISSUE_CLOSED');
  const blockerId = config.preflight_outcome.next_task.issue_id;
  requireValue((issue.blockedBy || []).some(blocker => blocker?.id === blockerId), 'APPROVAL_DISPATCH_ACTIVE_BLOCKER_LINK_MISSING');
  requireValue(agent?.id === expected.coordinator_agent_id && agent?.companyId === expected.company_id
    && agent?.name === expected.coordinator_name && agent?.adapterType === 'codex_local'
    && samePath(agent?.adapterConfig?.cwd, expected.coordinator_project_root)
    && agent?.adapterConfig?.model === expected.coordinator_model
    && agent?.metadata?.active_strategy_id === config.strategy_id
    && agent?.metadata?.brain_project === config.strategy_id && agent?.metadata?.brain_domain === 'trading-strategy'
    && agent?.metadata?.paperclip_project_id === expected.project_id && agent?.metadata?.paperclip_workspace_id === expected.workspace_id
    && agent?.metadata?.environment === 'TEST_ONLY' && agent?.metadata?.live_real_enabled === false
    && agent?.permissions?.canUseLiveTrading === false && agent?.adapterConfig?.dangerouslyBypassApprovalsAndSandbox === false,
  'APPROVAL_DISPATCH_COORDINATOR_BINDING_INVALID');
  const writePaths = coordinatorGrantPaths(agent, 'write');
  const allowedWrites = new Set(approvedCoordinatorWritePaths(config).map(value => path.win32.normalize(value).toLowerCase()));
  if (!stagingApproved) requireValue(writePaths.length === 0, 'APPROVAL_DISPATCH_COORDINATOR_WRITE_GRANT_PRESENT');
  else requireValue(writePaths.every(value => allowedWrites.has(value)), 'APPROVAL_DISPATCH_COORDINATOR_UNAPPROVED_WRITE_GRANT_PRESENT');
  const readPaths = coordinatorGrantPaths(agent, 'read');
  for (const requiredPath of config.coordinator_gate.required_read_only_paths) {
    requireValue(readPaths.some(granted => pathCoveredByGrant(requiredPath, granted)), 'APPROVAL_DISPATCH_REQUIRED_READ_GRANT_MISSING');
  }
}
function approvedCoordinatorWritePaths(config) {
  return [...config.staging_authority.allowed_future_write_paths];
}
function coordinatorGrantPaths(agent, access) {
  const args = (agent?.adapterConfig?.extraArgs || []).join('\n').replace(/\\/g, '/');
  const pattern = new RegExp('"([^"]+)"\\s*=\\s*"' + access + '"', 'gi');
  return [...args.matchAll(pattern)].map(match => path.win32.normalize(match[1]).toLowerCase());
}
function pathCoveredByGrant(required, granted) {
  const child=path.win32.normalize(String(required)).toLowerCase();
  const parent=path.win32.normalize(String(granted)).toLowerCase().replace(/[\\/]+$/,'');
  return child===parent||child.startsWith(parent+path.win32.sep);
}
function coordinatorScopeHash(config) {
  return 'sha256:' + digest(JSON.stringify({
    reads:config.staging_authority.continuation.execution_route.required_source_read_paths.map(value => path.win32.normalize(value).toLowerCase()).sort(),
    writes:approvedCoordinatorWritePaths(config).map(value => path.win32.normalize(value).toLowerCase()).sort(),
    commands:[...config.staging_authority.continuation.execution_route.diagnostic_commands_only].sort(),
    measurement_start_allowed:false,
  }));
}
function inspectApprovedCoordinatorExecutionScope(config, agent, stagingAuthority) {
  const route=stagingAuthority.continuation.execution_route;
  if (stagingAuthority.approval_status !== 'APPROVED') return {...stagingAuthority,execution_route:{...route,
    state:'AWAITING_PAPERCLIP_STAGING_APPROVAL',coordinator_can_execute:false,mutation_attempted:false}};
  const required = approvedCoordinatorWritePaths(config);
  const requiredNormalized = new Set(required.map(value => path.win32.normalize(value).toLowerCase()));
  const current = coordinatorGrantPaths(agent, 'write');
  const unexpected = current.filter(value => !requiredNormalized.has(value));
  requireValue(unexpected.length === 0, 'APPROVAL_DISPATCH_COORDINATOR_UNAPPROVED_WRITE_GRANT_PRESENT:' + unexpected.join('|'));
  const expectedHash = coordinatorScopeHash(config);
  const missing = required.filter(value => !current.includes(path.win32.normalize(value).toLowerCase()));
  const currentReads=coordinatorGrantPaths(agent, 'read');
  const requiredReads=route.required_source_read_paths;
  const missingReads=requiredReads.filter(value=>!currentReads.some(granted=>pathCoveredByGrant(value,granted)));
  const commandPolicyReady = route.command_policy_enforced === true;
  const state = missingReads.length ? 'BLOCKED_COORDINATOR_SOURCE_READ_SCOPE_MISSING'
    : missing.length ? 'BLOCKED_COORDINATOR_WRITE_SCOPE_MISSING'
    : commandPolicyReady ? 'EXACT_APPROVAL_BOUND_EXECUTOR_READY' : 'BLOCKED_DIAGNOSTIC_COMMAND_POLICY_NOT_ENFORCED';
  return {...stagingAuthority,execution_route:{...route,state,
    scope_hash:expectedHash,required_write_paths:[...required],missing_write_paths:missing,
    required_source_read_paths:[...requiredReads],missing_source_read_paths:missingReads,
    observed_write_paths:current,observed_read_paths:currentReads,
    coordinator_can_execute:missing.length===0&&missingReads.length===0&&commandPolicyReady,
    mutation_attempted:false,dangerously_bypass_approvals_and_sandbox:false,
    blocker:'Paperclip approval does not override filesystem restrictions, and connector-control writes require a trusted diagnostics-only command policy.'}};
}
function wakeReason(config) {
  return 'vwap_v238_dual_approval_read_only_preflight_' + digest([config.sealed_authority.contract_hash, config.sealed_authority.context_hash, ...config.sealed_authority.approvals.map(item => item.approval_id).sort()].join('|')).slice(0, 20);
}
function matchingRuns(config, runs, reason) {
  return (Array.isArray(runs) ? runs : runs?.items || []).filter(run => run?.agentId === config.paperclip.coordinator_agent_id
    && run?.contextSnapshot?.issueId === config.paperclip.issue_id && run?.contextSnapshot?.wakeReason === reason);
}
function observedStartedRun(runs) {
  return runs.find(run => UUID.test(String(run?.id || '')) && STARTED_STATUSES.has(String(run?.status || '').toLowerCase())
    && Number.isFinite(Date.parse(run?.startedAt || ''))) || null;
}
function validateNextTask(config, task) {
  const expected = config.preflight_outcome.next_task;
  requireValue(task?.id === expected.issue_id && task?.identifier === expected.issue_identifier
    && task?.companyId === config.paperclip.company_id && task?.projectId === config.paperclip.project_id
    && task?.projectWorkspaceId === config.paperclip.workspace_id && task?.parentId === config.paperclip.issue_id
    && task?.title === expected.title && task?.assigneeAgentId === config.paperclip.coordinator_agent_id
    && (task?.blockedBy || []).some(blocker => blocker?.id === config.staging_authority.continuation.execution_route.engineering_issue_id),
  'APPROVAL_DISPATCH_PREFLIGHT_TASK_BINDING_INVALID');
}
function validateExecutorIssue(config, issue) {
  const expected=config.staging_authority.continuation.execution_route;
  requireValue(issue?.id===expected.engineering_issue_id
    &&issue?.identifier===expected.engineering_issue_identifier
    &&issue?.companyId===config.paperclip.company_id
    &&issue?.projectId===config.paperclip.project_id
    &&issue?.projectWorkspaceId===config.paperclip.workspace_id
    &&issue?.parentId===config.staging_authority.issue_id
    &&issue?.title===expected.engineering_issue_title
    &&issue?.assigneeAgentId===expected.engineering_issue_owner_agent_id
    &&!['done','cancelled'].includes(String(issue?.status||'').toLowerCase()),
  'APPROVAL_DISPATCH_EXECUTOR_ISSUE_BINDING_INVALID');
}
function validateStagingApproval(config, approval, task, packageBytes) {
  const expected = config.staging_authority, payload = approval?.payload || {};
  validateNextTask(config, task);
  requireValue(approval?.id === expected.approval_id && approval?.companyId === config.paperclip.company_id
    && approval?.type === 'request_board_approval' && approval?.requestedByAgentId === config.paperclip.coordinator_agent_id
    && payload.attachmentId === expected.attachment_id && String(payload.package_sha256 || '').toLowerCase() === expected.package_sha256
    && payload.scope === expected.approval_scope && payload.target?.account === 'Sim1' && payload.target?.bar_seconds === 300
    && samePath(payload.target?.chartbook, config.preflight_outcome.chartbook_path),
  'APPROVAL_DISPATCH_STAGING_APPROVAL_MISMATCH');
  const selectedHashes = new Set((payload.selected_artifacts || []).map(item => String(item.sha256 || '').toLowerCase()));
  requireValue(selectedHashes.has(config.preflight_outcome.strategy_artifact.selected_hash.replace(/^sha256:/, '').toLowerCase())
    && selectedHashes.has(config.preflight_outcome.telemetry_artifact.selected_hash.replace(/^sha256:/, '').toLowerCase()),
  'APPROVAL_DISPATCH_STAGING_ARTIFACT_MISMATCH');
  const excluded = String(payload.excluded || '');
  requireValue(['RUN_RELEASE','playback','bridge activation','Paper/Live','real orders','historical role/row edits','threshold selection']
    .every(value => excluded.includes(value)), 'APPROVAL_DISPATCH_STAGING_EXCLUSIONS_INVALID');
  const approvedWritePaths = (payload.allowed_future_write_paths || []).map(value => path.win32.normalize(String(value)).toLowerCase()).sort();
  const expectedWritePaths = expected.allowed_future_write_paths.map(value => path.win32.normalize(value).toLowerCase()).sort();
  requireValue(JSON.stringify(approvedWritePaths) === JSON.stringify(expectedWritePaths), 'APPROVAL_DISPATCH_STAGING_WRITE_PATHS_MISMATCH');
  requireValue(bufferDigest(packageBytes) === expected.package_sha256, 'APPROVAL_DISPATCH_STAGING_PACKAGE_HASH_MISMATCH');
  let sealed;
  try { sealed = JSON.parse(packageBytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('APPROVAL_DISPATCH_STAGING_PACKAGE_JSON_INVALID'); }
  requireValue(sealed?.schema_version === expected.package_schema_version
    && sealed?.status === 'PREPARED_NOT_AUTHORIZED_NOT_EXECUTED'
    && sealed?.issue === expected.issue_identifier
    && sealed?.target?.account === 'Sim1' && sealed?.target?.bar_seconds === 300
    && sealed?.approval_request?.decision === expected.approval_scope
    && sealed?.approval_request?.approval_granted === false,
  'APPROVAL_DISPATCH_STAGING_PACKAGE_CONTENT_INVALID');
  const status = String(approval.status || '').toUpperCase();
  requireValue(['PENDING','REVISION_REQUESTED','APPROVED','REJECTED','CANCELLED'].includes(status), 'APPROVAL_DISPATCH_STAGING_STATUS_INVALID');
  return {
    authoritative:true,
    approval_id:expected.approval_id,
    approval_status:status,
    action_required:['PENDING','REVISION_REQUESTED'].includes(status),
    approval_url:expected.approval_url,
    requested_by_agent_id:approval.requestedByAgentId,
    decided_at_utc:approval.decidedAt || null,
    updated_at_utc:approval.updatedAt || null,
    title:payload.title || 'Exact Sim1 TEST staging authority',
    approval_scope:expected.approval_scope,
    attachment_id:expected.attachment_id,
    package_url:expected.package_url,
    package_sha256:expected.package_sha256,
    package_bytes:packageBytes.length,
    package_recovery:'BYTE_IDENTICAL_SHA256_VERIFIED',
    database_rule:payload.database_rule,
    excluded:payload.excluded,
    risks:Array.isArray(payload.risks) ? payload.risks : [],
    timeframe:{...expected.timeframe},
    mutable_reference:{...expected.mutable_reference},
    allowed_future_write_paths:[...expected.allowed_future_write_paths],
    scope_authority:{staging_write_and_single_diagnostic_start_granted:status === 'APPROVED',
      existing_run_release_approval_granted:true,combined_sequence_eligible:false,
      existing_run_release_reuse_status:expected.continuation.existing_run_release_reuse_status,
      post_staging_consolidated_approval_required:true,playback_granted:false,paper_granted:false,live_granted:false,
      composition_rule:'STAGING_ONLY_THEN_NEW_POST_STAGING_BINDING_AND_MEASUREMENT_START_GATE'},
    continuation:{...expected.continuation, state:status === 'APPROVED' ? 'AWAITING_PAPERCLIP_REQUESTER_WAKE' : status === 'PENDING' ? 'AWAITING_PAPERCLIP_HUMAN_DECISION' : status === 'REVISION_REQUESTED' ? 'REVISION_REQUIRED_NO_CONTINUATION' : 'NOT_GRANTED_NO_CONTINUATION'},
  };
}
function completedPreflightDetails(config, run, statuses, reason, task, executorIssue, stagingAuthority) {
  const outcome = config.preflight_outcome;
  if (run?.id !== outcome?.heartbeat_run_id || String(run?.status || '').toLowerCase() !== 'succeeded') return null;
  return {
    approval_statuses:statuses,
    dispatched:true,
    wake_reason:reason,
    heartbeat_run_id:run.id,
    heartbeat_run_status:run.status,
    heartbeat_started_at_utc:run.startedAt,
    heartbeat_finished_at_utc:run.finishedAt || outcome.completed_at_utc,
    preflight_outcome:{...outcome, next_task:{...outcome.next_task, status:String(task.status || 'unknown').toUpperCase(), execution_run_id:task.executionRunId || null}},
    workflow_lineage:{blocked_issue:{id:config.paperclip.issue_id,identifier:config.paperclip.issue_identifier},
      active_blocker:{id:outcome.next_task.issue_id,identifier:outcome.next_task.issue_identifier,status:String(task.status || 'unknown').toUpperCase(),
        owner_agent_id:config.paperclip.coordinator_agent_id},relationship:'BLOCKED_BY',legacy_path:'SUPERSEDED_NOT_WOKEN',
      executor_blocker:{id:executorIssue.id,identifier:executorIssue.identifier,status:String(executorIssue.status||'unknown').toUpperCase(),
        owner_agent_id:executorIssue.assigneeAgentId,relationship:'OCEA_22_BLOCKED_BY_EXECUTOR'},
      brain_continuity_record_id:'reasoning-20261020145924-1caa3931'},
    staging_authority:stagingAuthority,
  };
}

function approvalResolutionRuns(config, runs) {
  return (Array.isArray(runs) ? runs : runs?.items || []).filter(run => run?.agentId === config.paperclip.coordinator_agent_id
    && run?.contextSnapshot?.approvalId === config.staging_authority.approval_id
    && run?.contextSnapshot?.issueId === config.staging_authority.issue_id
    && run?.contextSnapshot?.wakeReason === 'approval_approved');
}
function continuationWakeReason(config) {
  return 'vwap_v238_staging_liveness_repair_' + digest([
    config.staging_authority.approval_id,
    config.staging_authority.package_sha256,
    config.staging_authority.continuation.existing_run_release_approval_id,
  ].join('|')).slice(0, 20);
}
function fallbackContinuationRuns(config, runs, reason) {
  return (Array.isArray(runs) ? runs : runs?.items || []).filter(run => run?.agentId === config.paperclip.coordinator_agent_id
    && run?.contextSnapshot?.issueId === config.staging_authority.issue_id
    && run?.contextSnapshot?.wakeReason === reason);
}
function continuationWithRun(stagingAuthority, state, source, run) {
  return {...stagingAuthority, continuation:{...stagingAuthority.continuation,state,source,
    heartbeat_run_id:run?.id || null,heartbeat_run_status:run?.status || null,
    heartbeat_started_at_utc:run?.startedAt || null,heartbeat_finished_at_utc:run?.finishedAt || null}};
}
function observedQueuedRun(runs) {
  return runs.find(run => String(run?.status || '').toLowerCase() === 'queued') || null;
}
async function reconcileApprovedContinuation(config, stagingAuthority, initialRuns, resolvedState, fetchImpl, sleepImpl) {
  if (stagingAuthority.approval_status !== 'APPROVED') return stagingAuthority;
  const classify = runs => {
    const paperclip = approvalResolutionRuns(config, runs), fallback = fallbackContinuationRuns(config, runs, continuationWakeReason(config));
    const paperclipStarted = observedStartedRun(paperclip);
    const fallbackStarted = observedStartedRun(fallback);
    if (paperclipStarted) return continuationWithRun(stagingAuthority, 'PAPERCLIP_REQUESTER_WAKE_STARTED', 'PAPERCLIP_APPROVAL_RESOLUTION', paperclipStarted);
    const paperclipQueued = observedQueuedRun(paperclip);
    if (paperclipQueued) return continuationWithRun(stagingAuthority, 'PAPERCLIP_REQUESTER_WAKE_QUEUED', 'PAPERCLIP_APPROVAL_RESOLUTION', paperclipQueued);
    if (fallbackStarted) return continuationWithRun(stagingAuthority, 'OCEAN_LIVENESS_REPAIR_STARTED', 'OCEAN_FAIL_CLOSED_LIVENESS_REPAIR', fallbackStarted);
    const fallbackQueued = observedQueuedRun(fallback);
    if (fallbackQueued) return continuationWithRun(stagingAuthority, 'OCEAN_LIVENESS_REPAIR_QUEUED', 'OCEAN_FAIL_CLOSED_LIVENESS_REPAIR', fallbackQueued);
    requireValue(paperclip.length === 0 && fallback.length === 0, 'APPROVAL_DISPATCH_CONTINUATION_PRIOR_START_NOT_PROVEN');
    return null;
  };
  const observed = classify(initialRuns);
  if (observed) return observed;
  const decidedAt = Date.parse(stagingAuthority.decided_at_utc || stagingAuthority.updated_at_utc || '');
  requireValue(Number.isFinite(decidedAt), 'APPROVAL_DISPATCH_STAGING_DECISION_TIME_INVALID');
  const graceMs = Number(stagingAuthority.continuation.paperclip_wakeup_grace_ms);
  const remaining = decidedAt + graceMs - Date.now();
  if (remaining > 0) return {...stagingAuthority, continuation:{...stagingAuthority.continuation,
    state:'AWAITING_PAPERCLIP_REQUESTER_WAKE',source:'PAPERCLIP_APPROVAL_RESOLUTION',grace_remaining_ms:remaining}};
  requireValue(stagingAuthority.continuation.ocean_liveness_repair_enabled === true, 'APPROVAL_DISPATCH_CONTINUATION_WAKE_MISSING');
  fs.mkdirSync(path.dirname(resolvedState), {recursive:true});
  const lockPath = resolvedState + '.continuation.lock';
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) {
    if (error?.code === 'EEXIST') return {...stagingAuthority, continuation:{...stagingAuthority.continuation,
      state:'OCEAN_LIVENESS_REPAIR_LOCKED',source:'OCEAN_FAIL_CLOSED_LIVENESS_REPAIR'}};
    throw error;
  }
  try {
    const insideRuns = await requestJson(config, '/companies/' + config.paperclip.company_id + '/heartbeat-runs?agentId=' + config.paperclip.coordinator_agent_id + '&limit=1000', {}, fetchImpl);
    const insideObserved = classify(insideRuns);
    if (insideObserved) return insideObserved;
    const reason = continuationWakeReason(config);
    const wake = await requestJson(config, '/agents/' + config.paperclip.coordinator_agent_id + '/wakeup?companyId=' + config.paperclip.company_id, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
        source:'automation', triggerDetail:'system', reason, idempotencyKey:reason,
        payload:{issueId:config.staging_authority.issue_id,approvalId:config.staging_authority.approval_id,
          approvalStatus:'approved',strategyId:config.strategy_id,namespace:config.namespace,
          packageAttachmentId:config.staging_authority.attachment_id,packageSha256:config.staging_authority.package_sha256,
          allowedFutureWritePaths:config.staging_authority.allowed_future_write_paths,
          existingRunReleaseApprovalId:config.staging_authority.continuation.existing_run_release_approval_id,
          action:'CONTINUE_APPROVED_STAGING_OR_REPORT_EXECUTOR_BLOCKER_NO_PLAYBACK',
          stagingWriteScopeAuthorized:stagingAuthority.execution_route?.coordinator_can_execute===true,
          singleDiagnosticStartAuthorized:stagingAuthority.execution_route?.coordinator_can_execute===true,
          runReleaseMaterializationAuthorized:false,
          replayPlaybackAuthorized:false,paperAuthorized:false,liveAuthorized:false,realOrdersAuthorized:false,
          brainContinuityRecordId:'reasoning-20261020145924-1caa3931',
          instruction:'Reauthenticate the exact approved attachment, package digest, Sim1 TEST identity, stopped Replay, flat/no-order state, and the six exact allowed staging paths. Paperclip approval does not override filesystem restrictions. If an approval-bound narrow executor with write-time live approval validation and a diagnostics-only command policy is not proven, record that exact blocker and do not stage. Never mutate this agent adapter configuration. A vwap-hook START is a measurement START that calls Sierra replay/order-reset paths; never treat it as the diagnostic start and do not invoke it here. The existing RUN_RELEASE approval pins the pre-staging chartbook hash and cannot be reused after chartbook selection changes without an approved deterministic pre/post transformation or a superseding contract. Require fresh loaded-controller identity and lifecycle proof; the historical v0.2.0 receipt is not current proof, while disk v0.2.3 facts are recorded in Brain reasoning-20261020151153-961eaa4a. Do not advance replay/playback, place orders, mutate historical evidence, touch Paper/Live, or broaden filesystem scope. After a staging receipt and controller proof, prepare one consolidated human gate for the post-staging run contract plus measurement START.'},
      }),
    }, fetchImpl);
    requireValue(UUID.test(String(wake?.id || '')), 'APPROVAL_DISPATCH_CONTINUATION_WAKE_RECEIPT_INVALID');
    const deadline = Date.now() + Number(config.wake_start_timeout_ms || 30000);
    let run = wake;
    while (Date.now() < deadline) {
      run = await requestJson(config, '/heartbeat-runs/' + wake.id, {}, fetchImpl);
      if (observedStartedRun([run])) break;
      await sleepImpl(Number(config.wake_poll_interval_ms || 500));
    }
    requireValue(observedStartedRun([run]), 'APPROVAL_DISPATCH_CONTINUATION_WAKE_NOT_PROVEN_STARTED');
    requireValue(run?.id === wake.id && run?.agentId === config.paperclip.coordinator_agent_id
      && run?.contextSnapshot?.issueId === config.staging_authority.issue_id
      && run?.contextSnapshot?.wakeReason === reason, 'APPROVAL_DISPATCH_CONTINUATION_WAKE_READBACK_MISMATCH');
    return continuationWithRun(stagingAuthority, 'OCEAN_LIVENESS_REPAIR_STARTED', 'OCEAN_FAIL_CLOSED_LIVENESS_REPAIR', run);
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
function stagingSuccessReceiptReadback(config) {
  const expected = config.staging_authority.continuation.staging_success_receipt;
  const waiting = {schema_version:expected.schema_version,status:'AWAITING_PACKAGE_BOUND_RECEIPT',path:expected.path,
    authority:expected.authority,accepted_before_playback:true,immutable_hash_required:true};
  if (!fs.existsSync(expected.path)) return waiting;
  const bytes = fs.readFileSync(expected.path), receiptHash = 'sha256:' + bufferDigest(bytes);
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('APPROVAL_DISPATCH_STAGING_SUCCESS_RECEIPT_JSON_INVALID'); }
  requireValue(receipt?.schema_version === expected.schema_version
    && receipt?.status === expected.required_status
    && receipt?.strategy_id === config.strategy_id && receipt?.namespace === config.namespace
    && receipt?.issue_id === config.staging_authority.issue_id
    && receipt?.approval_id === config.staging_authority.approval_id
    && receipt?.package_attachment_id === config.staging_authority.attachment_id
    && String(receipt?.package_sha256 || '').toLowerCase() === config.staging_authority.package_sha256
    && receipt?.run_release_approval_id === config.staging_authority.continuation.existing_run_release_approval_id
    && receipt?.run_id === config.sealed_authority.run_id
    && receipt?.target?.account === 'Sim1' && receipt?.target?.bar_seconds === 300
    && samePath(receipt?.target?.chartbook, config.preflight_outcome.chartbook_path)
    && String(receipt?.selected_artifacts?.strategy_sha256 || '').toLowerCase() === config.preflight_outcome.strategy_artifact.selected_hash
    && String(receipt?.selected_artifacts?.telemetry_sha256 || '').toLowerCase() === config.preflight_outcome.telemetry_artifact.selected_hash
    && receipt?.gates?.dry_run_passed === true && receipt?.gates?.stopped_flat_no_orders_verified === true
    && receipt?.gates?.diagnostic_process_started === true && receipt?.gates?.run_release_materialized === false
    && receipt?.safety?.playback_started === false && receipt?.safety?.measurement_start_invoked === false
    && receipt?.safety?.paper_touched === false && receipt?.safety?.live_touched === false
    && receipt?.safety?.real_orders_authorized === false
    && Number.isFinite(Date.parse(receipt?.created_at_utc || '')),
  'APPROVAL_DISPATCH_STAGING_SUCCESS_RECEIPT_MISMATCH');
  return {schema_version:expected.schema_version,status:'CONTENT_MATCHED_AUTHORITY_UNVERIFIED',path:expected.path,
    authority:expected.authority,receipt_hash:receiptHash,created_at_utc:receipt.created_at_utc,
    run_id:receipt.run_id,playback_started:false,measurement_start_invoked:false,
    runtime_execution_authorized:false,
    blocker:'Independent receipt custody and current exclusive booking authority have not been verified.'};
}

async function continuityReadback(config,executorIssue,stagingAuthority,fetchImpl) {
  try { return await projectVwapContinuity({config,executorIssue,stagingAuthority,
    getJson:relative=>requestJson(config,relative,{},fetchImpl)}); }
  catch(error) { return {schema_version:'ocean-vwap-continuity-projection/v1',source:'PAPERCLIP_UNAVAILABLE',
    observed_at_utc:null,freshness:{state:'UNAVAILABLE',max_age_ms:90000},
    reason:String(error?.message||'CONTINUITY_READBACK_FAILED').split(':')[0],next_automatic_job:null,
    authority:{runtime_execution_authorized:false}}; }
}

export async function scanVwapPhysicalComparatorApprovalDispatch({config, stateFile, contractPath, fetchImpl = fetch, sleepImpl = sleep} = {}) {
  const resolvedState = stateFile || config?.state_path || DEFAULT_VWAP_APPROVAL_DISPATCH_STATE;
  if (!config?.enabled) return {enabled:false, status:'DISABLED'};
  const write = (status, details = {}) => { const state = publicState(config, status, details); writeJson(resolvedState, state); return state; };
  try {
    const contract = readVwapPhysicalComparatorContract(contractPath || config.contract_path || DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT, config.strategy_id);
    validateContract(config, contract);
    const approvals = await Promise.all(config.sealed_authority.approvals.map(item => requestJson(config, '/approvals/' + item.approval_id, {}, fetchImpl)));
    approvals.forEach((approval, index) => validateApproval(config, config.sealed_authority.approvals[index], approval));
    const statuses = Object.fromEntries(approvals.map(item => [item.payload.decision_scope, String(item.status || '').toUpperCase()]));
    if (approvals.some(item => DENIED_STATUSES.has(String(item.status || '').toLowerCase()))) return write('BLOCKED_APPROVAL_NOT_GRANTED', {approval_statuses:statuses, dispatched:false});
    if (approvals.some(item => WAITING_STATUSES.has(String(item.status || '').toLowerCase()))) return write('WAITING_FOR_BOTH_APPROVALS', {approval_statuses:statuses, dispatched:false});
    requireValue(approvals.every(item => String(item.status || '').toLowerCase() === 'approved'), 'APPROVAL_DISPATCH_APPROVAL_STATUS_INVALID');

    const [issue, agent, runList, nextTask, executorIssue, stagingApproval, stagingPackage] = await Promise.all([
      requestJson(config, '/issues/' + config.paperclip.issue_id, {}, fetchImpl),
      requestJson(config, '/agents/' + config.paperclip.coordinator_agent_id, {}, fetchImpl),
      requestJson(config, '/companies/' + config.paperclip.company_id + '/heartbeat-runs?agentId=' + config.paperclip.coordinator_agent_id + '&limit=1000', {}, fetchImpl),
      requestJson(config, '/issues/' + config.preflight_outcome.next_task.issue_id, {}, fetchImpl),
      requestJson(config, '/issues/' + config.staging_authority.continuation.execution_route.engineering_issue_id, {}, fetchImpl),
      requestJson(config, '/approvals/' + config.staging_authority.approval_id, {}, fetchImpl),
      requestBytes(config, '/attachments/' + config.staging_authority.attachment_id + '/content', {}, fetchImpl),
    ]);
    validateExecutorIssue(config, executorIssue);
    let stagingAuthority = validateStagingApproval(config, stagingApproval, nextTask, stagingPackage);
    validateIssueAndAgent(config, issue, agent, stagingAuthority.approval_status === 'APPROVED');
    stagingAuthority = inspectApprovedCoordinatorExecutionScope(config, agent, stagingAuthority);
    const reason = wakeReason(config), prior = matchingRuns(config, runList, reason);
    const priorStarted = observedStartedRun(prior);
    if (priorStarted) {
      const completed = completedPreflightDetails(config, priorStarted, statuses, reason, nextTask, executorIssue, stagingAuthority);
      if (completed) {
        completed.staging_authority = await reconcileApprovedContinuation(config, stagingAuthority, runList, resolvedState, fetchImpl, sleepImpl);
        completed.staging_authority.staging_success_receipt = stagingSuccessReceiptReadback(config);
        completed.continuity = await continuityReadback(config,executorIssue,completed.staging_authority,fetchImpl);
        return write('PREFLIGHT_BLOCKED_PHYSICAL_BINDING', completed);
      }
      return write('ALREADY_DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:priorStarted.id, heartbeat_run_status:priorStarted.status, heartbeat_started_at_utc:priorStarted.startedAt});
    }
    if (prior.length) return write('ATTENTION_REQUIRED', {reason:'PRIOR_WAKE_NOT_PROVEN_STARTED', approval_statuses:statuses, dispatched:false, wake_reason:reason, heartbeat_run_id:prior[0].id, heartbeat_run_status:prior[0].status});
    requireValue(String(issue.status || '').toLowerCase() === 'blocked', 'APPROVAL_DISPATCH_ISSUE_NOT_BLOCKED_BEFORE_WAKE');

    fs.mkdirSync(path.dirname(resolvedState), {recursive:true});
    const lockPath = resolvedState + '.lock';
    let lock;
    try { lock = fs.openSync(lockPath, 'wx'); }
    catch (error) { if (error?.code === 'EEXIST') return write('SCAN_LOCKED', {approval_statuses:statuses, dispatched:false}); throw error; }
    try {
      const insideList = await requestJson(config, '/companies/' + config.paperclip.company_id + '/heartbeat-runs?agentId=' + config.paperclip.coordinator_agent_id + '&limit=1000', {}, fetchImpl);
      const insidePrior = matchingRuns(config, insideList, reason), insideStarted = observedStartedRun(insidePrior);
      if (insideStarted) {
        const completed = completedPreflightDetails(config, insideStarted, statuses, reason, nextTask, executorIssue, stagingAuthority);
        if (completed) {
          completed.staging_authority = await reconcileApprovedContinuation(config, stagingAuthority, insideList, resolvedState, fetchImpl, sleepImpl);
          completed.staging_authority.staging_success_receipt = stagingSuccessReceiptReadback(config);
          completed.continuity = await continuityReadback(config,executorIssue,completed.staging_authority,fetchImpl);
          return write('PREFLIGHT_BLOCKED_PHYSICAL_BINDING', completed);
        }
        return write('ALREADY_DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:insideStarted.id, heartbeat_run_status:insideStarted.status, heartbeat_started_at_utc:insideStarted.startedAt});
      }
      if (insidePrior.length) return write('ATTENTION_REQUIRED', {reason:'PRIOR_WAKE_NOT_PROVEN_STARTED', approval_statuses:statuses, dispatched:false, wake_reason:reason, heartbeat_run_id:insidePrior[0].id, heartbeat_run_status:insidePrior[0].status});
      const wake = await requestJson(config, '/agents/' + config.paperclip.coordinator_agent_id + '/wakeup?companyId=' + config.paperclip.company_id, {
        method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
          source:'automation', triggerDetail:'system', reason, idempotencyKey:reason,
          payload:{issueId:config.paperclip.issue_id, strategyId:config.strategy_id, namespace:config.namespace,
            contractId:config.sealed_authority.contract_id, contractHash:config.sealed_authority.contract_hash,
            documentHash:config.sealed_authority.document_hash, runId:config.sealed_authority.run_id,
            contextHash:config.sealed_authority.context_hash, approvalIds:config.sealed_authority.approvals.map(item => item.approval_id).sort(),
            action:'READ_ONLY_PREFLIGHT_ONLY', runtimeWriteScopeAuthorized:false, replayStartAuthorized:false,
            paperAuthorized:false, liveAuthorized:false, postPreflightGate:config.coordinator_gate.post_preflight_gate,
            postPreflightAction:config.coordinator_gate.post_preflight_action,
            instruction:'Perform only a read-only physical/data/STTL2 preflight. Do not write to Replay Two, CICD runtime/output, start Sierra/Replay, materialize a run/release, or touch Paper/Live. After preflight, request or derive only the exact TEST Replay Two/runtime/output write/start scope.'},
        }),
      }, fetchImpl);
      requireValue(UUID.test(String(wake?.id || '')), 'APPROVAL_DISPATCH_WAKE_RECEIPT_INVALID');
      const deadline = Date.now() + Number(config.wake_start_timeout_ms || 30000);
      let run = wake;
      while (Date.now() < deadline) {
        run = await requestJson(config, '/heartbeat-runs/' + wake.id, {}, fetchImpl);
        if (observedStartedRun([run])) break;
        await sleepImpl(Number(config.wake_poll_interval_ms || 500));
      }
      requireValue(observedStartedRun([run]), 'APPROVAL_DISPATCH_WAKE_NOT_PROVEN_STARTED');
      requireValue(run?.id === wake.id && run?.agentId === config.paperclip.coordinator_agent_id
        && run?.contextSnapshot?.issueId === config.paperclip.issue_id && run?.contextSnapshot?.wakeReason === reason, 'APPROVAL_DISPATCH_WAKE_READBACK_MISMATCH');
      return write('DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:run.id, heartbeat_run_status:run.status, heartbeat_started_at_utc:run.startedAt});
    } finally {
      try { fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } catch (error) {
    return write('ATTENTION_REQUIRED', {reason:String(error?.message || error), dispatched:false});
  }
}
