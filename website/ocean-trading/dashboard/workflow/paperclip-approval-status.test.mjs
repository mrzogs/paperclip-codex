import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichStrategyApprovalStatuses, readPaperclipApprovalStatus } from './paperclip-approval-status.mjs';

const APPROVAL_ID = 'd6bb0adb-2704-4e44-8aa8-011ee2b9baee';

test('projects only the live read-only Paperclip approval fields and link', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      id:APPROVAL_ID, companyId:'company-1', type:'hire_agent', status:'approved',
      payload:{ name:'CICD VWAP Recovery Coordinator', adapterConfig:{ token:'must-not-leak' } },
      decidedAt:'2026-10-20T09:51:07.457Z', createdAt:'2026-10-19T15:46:53.575Z',
    }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const result = await readPaperclipApprovalStatus({
    approval_id:APPROVAL_ID, purpose:'Approve the dedicated coordinator', source:'program',
  }, { apiBase:'http://127.0.0.1:3100/api', fetchImpl });
  assert.equal(request.url, `http://127.0.0.1:3100/api/approvals/${APPROVAL_ID}`);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.cache, 'no-store');
  assert.deepEqual(result, {
    approval_id:APPROVAL_ID,
    purpose:'Approve the dedicated coordinator',
    source:'program',
    title:'CICD VWAP Recovery Coordinator',
    type:'HIRE_AGENT',
    status:'APPROVED',
    authoritative:true,
    action_required:false,
    decided_at_utc:'2026-10-20T09:51:07.457Z',
    requested_at_utc:'2026-10-19T15:46:53.575Z',
    url:`http://127.0.0.1:3100/approvals/${APPROVAL_ID}`,
    checked_at_utc:result.checked_at_utc,
  });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('unavailable Paperclip status remains visibly non-authoritative and fail-closed', async () => {
  const result = await readPaperclipApprovalStatus({ approval_id:APPROVAL_ID, purpose:'Human gate' }, {
    apiBase:'http://127.0.0.1:3100/api',
    fetchImpl:async () => new Response(JSON.stringify({ error:'offline' }), { status:503 }),
  });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.authoritative, false);
  assert.equal(result.action_required, false);
  assert.equal(result.error_code, 'PAPERCLIP_APPROVAL_UNAVAILABLE');
});

test('enriches only strategy approval references and preserves the remaining view', async () => {
  const view = { marker:'preserved', onboarding:{ continuous_delivery:{ autonomous_improvement:{
    state:'AVAILABLE', required_human_approvals:[{ approval_id:APPROVAL_ID, purpose:'Human gate', source:'next_action' }],
  } } } };
  const result = await enrichStrategyApprovalStatuses(view, {
    apiBase:'http://127.0.0.1:3100/api',
    fetchImpl:async () => new Response(JSON.stringify({
      id:APPROVAL_ID, type:'hire_agent', status:'pending', payload:{ title:'Approve coordinator' }, createdAt:'2026-10-20T09:00:00Z',
    }), { status:200 }),
  });
  assert.equal(result.marker, 'preserved');
  const approval = result.onboarding.continuous_delivery.autonomous_improvement.required_human_approvals[0];
  assert.equal(approval.status, 'PENDING');
  assert.equal(approval.action_required, true);
  assert.equal(approval.authoritative, true);
});
