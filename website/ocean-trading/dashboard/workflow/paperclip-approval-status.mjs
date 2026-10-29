import { loadVwapPhysicalComparatorApprovalDispatchConfig } from './vwap-physical-comparator-approval-dispatch.mjs';
import { timedSync } from '../request-timing.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_STATUSES = new Set(['pending', 'revision_requested', 'approved', 'rejected', 'cancelled']);

function apiUrl(apiBase, approvalId) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api').replace(/\/?$/, '/'));
  return new URL(`approvals/${approvalId}`, base).toString();
}

function browserUrl(apiBase, approvalId, companyPrefix) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api'));
  base.pathname = base.pathname.replace(/\/api\/?$/, '/');
  base.search = '';
  base.hash = '';
  return new URL(`${companyPrefix ? `${encodeURIComponent(companyPrefix)}/` : ''}approvals/${approvalId}`, base).toString();
}

function titleOf(payload, type) {
  const value = payload && typeof payload === 'object' ? payload : {};
  return String(value.title || value.name || type || 'Required human approval');
}

export async function readPaperclipApprovalStatus(reference, options = {}) {
  const approvalId = String(reference?.approval_id || '');
  if (!UUID.test(approvalId)) throw new Error('PAPERCLIP_APPROVAL_REFERENCE_INVALID');
  const apiBase = options.apiBase || 'http://127.0.0.1:3100/api';
  const fetchImpl = options.fetchImpl || fetch;
  const configuredTimeoutMs = Number(options.timeoutMs || 2000);
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(250, Math.min(configuredTimeoutMs, 5000))
    : 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = null;
  let failure = 'UNAVAILABLE';
  try {
    const response = await fetchImpl(apiUrl(apiBase, approvalId), {
      method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    httpStatus = response.status;
    if ([401,403].includes(httpStatus)) {
      failure = 'SCOPED_ACCESS_DENIED';
      throw new Error(failure);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.id !== approvalId || !APPROVAL_STATUSES.has(String(payload.status || '').toLowerCase())) {
      throw new Error('PAPERCLIP_APPROVAL_READ_INVALID');
    }
    if (!reference.expected_company_id || payload.companyId !== reference.expected_company_id) {
      failure = 'COMPANY_MISMATCH';
      throw new Error(failure);
    }
    if (reference.expected_payload && (payload.type !== 'request_board_approval'
      || Object.entries(reference.expected_payload).some(([key,value]) => value === undefined || value === null || payload.payload?.[key] !== value))) {
      failure = 'CONTRACT_MISMATCH';
      throw new Error(failure);
    }
    const status = String(payload.status).toUpperCase();
    return {
      approval_id:approvalId,
      purpose:String(reference.purpose || 'Required human approval'),
      source:String(reference.source || 'program'),
      decision_scope:reference.decision_scope ? String(reference.decision_scope) : null,
      expected_company_id:reference.expected_company_id,
      expected_contract_hash:reference.expected_payload?.contract_hash || null,
      title:titleOf(payload.payload, payload.type),
      type:String(payload.type || 'request_board_approval').toUpperCase(),
      status,
      authoritative:true,
      action_required:['PENDING','REVISION_REQUESTED'].includes(status),
      decided_at_utc:payload.decidedAt || null,
      requested_at_utc:payload.createdAt || null,
      url:browserUrl(apiBase, approvalId, reference.company_prefix),
      checked_at_utc:new Date().toISOString(),
    };
  } catch (error) {
    return {
      approval_id:approvalId,
      purpose:String(reference.purpose || 'Required human approval'),
      source:String(reference.source || 'program'),
      decision_scope:reference.decision_scope ? String(reference.decision_scope) : null,
      expected_company_id:reference.expected_company_id || null,
      expected_contract_hash:reference.expected_payload?.contract_hash || null,
      title:String(reference.title || reference.purpose || 'Required human approval'),
      type:'UNKNOWN', status:failure, authoritative:false, action_required:false,
      decided_at_utc:null, requested_at_utc:null, url:browserUrl(apiBase, approvalId, reference.company_prefix),
      checked_at_utc:new Date().toISOString(),
      error_code:error?.name === 'AbortError' ? 'PAPERCLIP_APPROVAL_READ_TIMEOUT' : 'PAPERCLIP_APPROVAL_UNAVAILABLE',
      http_status:httpStatus,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichStrategyApprovalStatuses(view, options = {}) {
  const improvement = view?.onboarding?.continuous_delivery?.autonomous_improvement;
  const comparator = view?.onboarding?.continuous_delivery?.physical_comparator;
  const improvementReferences = Array.isArray(improvement?.required_human_approvals) ? improvement.required_human_approvals : [];
  const comparatorReferences = comparator?.state === 'AVAILABLE' && Array.isArray(comparator?.required_human_approvals) ? comparator.required_human_approvals : [];
  if (!improvementReferences.length && !comparatorReferences.length) return view;
  // This is a read-only projection. Never borrow the dispatcher's credentials or
  // use its cached decisions as authority for this request.
  let companyId = null;
  let dispatchConfig = null;
  try { dispatchConfig = timedSync('workflow.companion.approval-config',()=>loadVwapPhysicalComparatorApprovalDispatchConfig(options.dispatchConfigPath)); companyId = dispatchConfig.paperclip.company_id; } catch {}
  const scoped = reference => ({...reference, expected_company_id:companyId,
    company_prefix:dispatchConfig?.paperclip?.issue_identifier?.split('-')[0]});
  const comparatorScoped = reference => ({...scoped(reference), expected_payload:{
    strategy_id:comparator.strategy_id, namespace:comparator.namespace,
    contract_id:comparator.contract_id, contract_hash:comparator.contract_hash,
    context_hash:comparator.run_context?.context_hash, run_id:comparator.run_context?.run_id,
    decision_scope:reference.decision_scope,
    ...(reference.decision_scope === 'RUN_RELEASE' ? {output_root:dispatchConfig?.staging_authority?.continuation?.run_release_output_root} : {}),
  }});
  const [improvementStatuses, comparatorStatuses] = await Promise.all([
    Promise.all(improvementReferences.map(reference => readPaperclipApprovalStatus(scoped(reference), options))),
    Promise.all(comparatorReferences.map(reference => readPaperclipApprovalStatus(comparatorScoped(reference), options))),
  ]);
  return {
    ...view,
    onboarding:{
      ...view.onboarding,
      continuous_delivery:{
        ...view.onboarding.continuous_delivery,
        autonomous_improvement:{ ...improvement, required_human_approvals:improvementStatuses },
        physical_comparator:{ ...comparator, required_human_approvals:comparatorStatuses },
      },
    },
  };
}
