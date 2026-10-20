const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPROVAL_STATUSES = new Set(['pending', 'revision_requested', 'approved', 'rejected', 'cancelled']);

function apiUrl(apiBase, approvalId) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api').replace(/\/?$/, '/'));
  return new URL(`approvals/${approvalId}`, base).toString();
}

function browserUrl(apiBase, approvalId) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api'));
  base.pathname = base.pathname.replace(/\/api\/?$/, '/');
  base.search = '';
  base.hash = '';
  return new URL(`approvals/${approvalId}`, base).toString();
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
  try {
    const response = await fetchImpl(apiUrl(apiBase, approvalId), {
      method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.id !== approvalId || !APPROVAL_STATUSES.has(String(payload.status || '').toLowerCase())) {
      throw new Error('PAPERCLIP_APPROVAL_READ_INVALID');
    }
    const status = String(payload.status).toUpperCase();
    return {
      approval_id:approvalId,
      purpose:String(reference.purpose || 'Required human approval'),
      source:String(reference.source || 'program'),
      title:titleOf(payload.payload, payload.type),
      type:String(payload.type || 'request_board_approval').toUpperCase(),
      status,
      authoritative:true,
      action_required:['PENDING','REVISION_REQUESTED'].includes(status),
      decided_at_utc:payload.decidedAt || null,
      requested_at_utc:payload.createdAt || null,
      url:browserUrl(apiBase, approvalId),
      checked_at_utc:new Date().toISOString(),
    };
  } catch (error) {
    return {
      approval_id:approvalId,
      purpose:String(reference.purpose || 'Required human approval'),
      source:String(reference.source || 'program'),
      title:String(reference.title || reference.purpose || 'Required human approval'),
      type:'UNKNOWN', status:'UNAVAILABLE', authoritative:false, action_required:false,
      decided_at_utc:null, requested_at_utc:null, url:browserUrl(apiBase, approvalId),
      checked_at_utc:new Date().toISOString(),
      error_code:error?.name === 'AbortError' ? 'PAPERCLIP_APPROVAL_READ_TIMEOUT' : 'PAPERCLIP_APPROVAL_UNAVAILABLE',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichStrategyApprovalStatuses(view, options = {}) {
  const improvement = view?.onboarding?.continuous_delivery?.autonomous_improvement;
  const references = Array.isArray(improvement?.required_human_approvals) ? improvement.required_human_approvals : [];
  if (!references.length) return view;
  const statuses = await Promise.all(references.map(reference => readPaperclipApprovalStatus(reference, options)));
  return {
    ...view,
    onboarding:{
      ...view.onboarding,
      continuous_delivery:{
        ...view.onboarding.continuous_delivery,
        autonomous_improvement:{ ...improvement, required_human_approvals:statuses },
      },
    },
  };
}
