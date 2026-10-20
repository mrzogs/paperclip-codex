import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVwapPhysicalComparatorContract, DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT } from './vwap-physical-comparator-contract.mjs';

export const APPROVAL_DISPATCH_SCHEMA = 'ocean-vwap-physical-comparator-approval-dispatch/v1';
export const APPROVAL_DISPATCH_STATE_SCHEMA = 'ocean-vwap-physical-comparator-approval-dispatch-state/v1';
export const DEFAULT_VWAP_APPROVAL_DISPATCH_CONFIG = process.env.OCEAN_VWAP_APPROVAL_DISPATCH_CONFIG
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'cicd-vwap-v238-approval-dispatch.json');
export const DEFAULT_VWAP_APPROVAL_DISPATCH_STATE = process.env.OCEAN_VWAP_APPROVAL_DISPATCH_STATE
  || 'D:\\OceanTradingData\\website\\ocean-runtime\\cicd-vwap-v238-approval-dispatch-state.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const APPROVAL_SCOPES = new Set(['DATASET_PHYSICAL_SELECTION', 'RUN_RELEASE']);
const WAITING_STATUSES = new Set(['pending', 'revision_requested']);
const DENIED_STATUSES = new Set(['rejected', 'cancelled']);
const STARTED_STATUSES = new Set(['running', 'succeeded', 'failed', 'timed_out']);
const nowUtc = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

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
    || gate.post_preflight_action !== 'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT') return {schema_version:APPROVAL_DISPATCH_STATE_SCHEMA, strategy_id:strategyId, enabled:true, status:'ATTENTION_REQUIRED', reason:'APPROVAL_DISPATCH_STATE_INVALID', checked_at_utc:nowUtc(),
      gate:{action:'READ_ONLY_PREFLIGHT_ONLY', current_permission_state:'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE', post_preflight_gate:'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED', post_preflight_action:'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT'},
      safety:{execution_authority:false,runtime_write_scope_authorized:false,replay_start_authorized:false,paper_authorized:false,live_authorized:false,automatic_approval_enabled:false}};
  return state;
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
}
function validateIssueAndAgent(config, issue, agent) {
  const expected = config.paperclip;
  requireValue(issue?.id === expected.issue_id && issue?.identifier === expected.issue_identifier
    && issue?.companyId === expected.company_id && issue?.projectId === expected.project_id
    && issue?.projectWorkspaceId === expected.workspace_id && issue?.assigneeAgentId === expected.coordinator_agent_id,
  'APPROVAL_DISPATCH_ISSUE_BINDING_INVALID');
  requireValue(!['done','cancelled'].includes(String(issue.status || '').toLowerCase()), 'APPROVAL_DISPATCH_ISSUE_CLOSED');
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
  const args = (agent?.adapterConfig?.extraArgs || []).join('\n').replace(/\\/g, '/').toLowerCase();
  requireValue(!/=\s*"write"/i.test(args), 'APPROVAL_DISPATCH_COORDINATOR_WRITE_GRANT_PRESENT');
  for (const requiredPath of config.coordinator_gate.required_read_only_paths) {
    const normalized = requiredPath.replace(/\\/g, '/').toLowerCase();
    requireValue(args.includes(`"${normalized}" = "read"`), 'APPROVAL_DISPATCH_REQUIRED_READ_GRANT_MISSING');
  }
}
function wakeReason(config) {
  return 'vwap_v238_dual_approval_read_only_preflight_' + digest([config.sealed_authority.contract_hash, config.sealed_authority.context_hash, ...config.sealed_authority.approvals.map(item => item.approval_id).sort()].join('|')).slice(0, 20);
}
function matchingRuns(config, runs, reason) {
  return (Array.isArray(runs) ? runs : runs?.items || []).filter(run => run?.agentId === config.paperclip.coordinator_agent_id
    && run?.contextSnapshot?.issueId === config.paperclip.issue_id && run?.contextSnapshot?.wakeReason === reason);
}
function observedStartedRun(runs) {
  return runs.find(run => STARTED_STATUSES.has(String(run.status || '').toLowerCase()) && Boolean(run.startedAt)) || null;
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

    const [issue, agent, runList] = await Promise.all([
      requestJson(config, '/issues/' + config.paperclip.issue_id, {}, fetchImpl),
      requestJson(config, '/agents/' + config.paperclip.coordinator_agent_id, {}, fetchImpl),
      requestJson(config, '/companies/' + config.paperclip.company_id + '/heartbeat-runs?agentId=' + config.paperclip.coordinator_agent_id + '&limit=1000', {}, fetchImpl),
    ]);
    validateIssueAndAgent(config, issue, agent);
    const reason = wakeReason(config), prior = matchingRuns(config, runList, reason);
    const priorStarted = observedStartedRun(prior);
    if (priorStarted) return write('ALREADY_DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:priorStarted.id, heartbeat_run_status:priorStarted.status, heartbeat_started_at_utc:priorStarted.startedAt});
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
      if (insideStarted) return write('ALREADY_DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:insideStarted.id, heartbeat_run_status:insideStarted.status, heartbeat_started_at_utc:insideStarted.startedAt});
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
        if (STARTED_STATUSES.has(String(run?.status || '').toLowerCase()) && run?.startedAt) break;
        await sleepImpl(Number(config.wake_poll_interval_ms || 500));
      }
      requireValue(STARTED_STATUSES.has(String(run?.status || '').toLowerCase()) && Boolean(run?.startedAt), 'APPROVAL_DISPATCH_WAKE_NOT_PROVEN_STARTED');
      requireValue(run?.contextSnapshot?.issueId === config.paperclip.issue_id && run?.contextSnapshot?.wakeReason === reason, 'APPROVAL_DISPATCH_WAKE_READBACK_MISMATCH');
      return write('DISPATCHED_READ_ONLY_PREFLIGHT', {approval_statuses:statuses, dispatched:true, wake_reason:reason, heartbeat_run_id:run.id, heartbeat_run_status:run.status, heartbeat_started_at_utc:run.startedAt});
    } finally {
      try { fs.closeSync(lock); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  } catch (error) {
    return write('ATTENTION_REQUIRED', {reason:String(error?.message || error), dispatched:false});
  }
}
