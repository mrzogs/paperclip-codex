import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadVwapPhysicalComparatorApprovalDispatchConfig,
  scanVwapPhysicalComparatorApprovalDispatch,
} from './vwap-physical-comparator-approval-dispatch.mjs';

const BASE_CONFIG = new URL('../config/cicd-vwap-v238-approval-dispatch.json', import.meta.url);
const CONTRACT = new URL('../config/cicd-vwap-v238-physical-comparator.json', import.meta.url);

function response(body, status = 200) {
  return {ok:status >= 200 && status < 300, status, text:async () => JSON.stringify(body)};
}
function fixture({statuses = ['approved','approved'], issuePatch = {}, agentPatch = {}, queuedOnly = false, configPatch = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-vwap-approval-dispatch-'));
  const config = JSON.parse(JSON.stringify(loadVwapPhysicalComparatorApprovalDispatchConfig(BASE_CONFIG)));
  Object.assign(config, {state_path:path.join(root, 'state.json'), contract_path:CONTRACT.pathname.replace(/^\/(.:)/, '$1'), wake_start_timeout_ms:20, wake_poll_interval_ms:1}, configPatch);
  const approvals = new Map(config.sealed_authority.approvals.map((item, index) => [item.approval_id, {
    id:item.approval_id, companyId:config.paperclip.company_id, type:'request_board_approval', status:statuses[index],
    payload:{strategy_id:config.strategy_id, namespace:config.namespace, contract_id:config.sealed_authority.contract_id,
      contract_hash:config.sealed_authority.contract_hash, context_hash:config.sealed_authority.context_hash,
      run_id:config.sealed_authority.run_id, decision_scope:item.decision_scope},
  }]));
  const issue = {id:config.paperclip.issue_id, identifier:config.paperclip.issue_identifier, companyId:config.paperclip.company_id,
    projectId:config.paperclip.project_id, projectWorkspaceId:config.paperclip.workspace_id,
    assigneeAgentId:config.paperclip.coordinator_agent_id, status:'blocked', ...issuePatch};
  const grants = config.coordinator_gate.required_read_only_paths.map(value => `"${value.replace(/\\/g, '/')}" = "read"`).join(', ');
  const agent = {id:config.paperclip.coordinator_agent_id, companyId:config.paperclip.company_id, name:config.paperclip.coordinator_name,
    adapterType:'codex_local', adapterConfig:{cwd:config.paperclip.coordinator_project_root, model:config.paperclip.coordinator_model,
      dangerouslyBypassApprovalsAndSandbox:false, extraArgs:['-c', `permissions.cicd-vwap.filesystem={ ${grants} }`]},
    metadata:{active_strategy_id:config.strategy_id, brain_project:config.strategy_id, brain_domain:'trading-strategy',
      paperclip_project_id:config.paperclip.project_id, paperclip_workspace_id:config.paperclip.workspace_id,
      environment:'TEST_ONLY', live_real_enabled:false}, permissions:{canUseLiveTrading:false}, ...agentPatch};
  let posts = 0;
  const runs = [];
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname + new URL(url).search;
    if (route.includes('/approvals/')) return response(approvals.get(route.split('/').at(-1)));
    if (route === '/api/issues/' + config.paperclip.issue_id) return response(issue);
    if (route === '/api/agents/' + config.paperclip.coordinator_agent_id) return response(agent);
    if (route.startsWith('/api/companies/') && route.includes('/heartbeat-runs')) return response(runs);
    if (route.startsWith('/api/agents/') && route.includes('/wakeup')) {
      posts += 1;
      const body = JSON.parse(options.body);
      const run = {id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentId:config.paperclip.coordinator_agent_id,
        status:'queued', startedAt:null, contextSnapshot:{issueId:body.payload.issueId, wakeReason:body.reason}};
      runs.push(run);
      return response(run);
    }
    if (route === '/api/heartbeat-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
      if (!queuedOnly) Object.assign(runs[0], {status:'running', startedAt:'2026-10-20T13:00:00.000Z'});
      return response(runs[0]);
    }
    return response({error:'not found', route}, 404);
  };
  return {root, config, approvals, issue, agent, runs, fetchImpl, posts:() => posts};
}

test('one pending approval remains fail-closed and never wakes', async () => {
  const f = fixture({statuses:['approved','pending']});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'WAITING_FOR_BOTH_APPROVALS');
  assert.equal(result.dispatched, false);
  assert.equal(f.posts(), 0);
});

test('a rejected approval blocks dispatch', async () => {
  const f = fixture({statuses:['rejected','approved']});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'BLOCKED_APPROVAL_NOT_GRANTED');
  assert.equal(f.posts(), 0);
});

test('changed sealed contract hash fails closed', async () => {
  const f = fixture();
  f.config.sealed_authority.contract_hash = 'sha256:' + '0'.repeat(64);
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /CONTRACT_CHANGED/);
  assert.equal(f.posts(), 0);
});

test('changed sealed context hash fails closed', async () => {
  const f = fixture();
  f.config.sealed_authority.context_hash = 'sha256:' + '1'.repeat(64);
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /CONTRACT_CHANGED/);
  assert.equal(f.posts(), 0);
});

test('both exact approvals dispatch once in either order and require running readback', async () => {
  const f = fixture();
  f.config.sealed_authority.approvals.reverse();
  const first = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(first.status, 'DISPATCHED_READ_ONLY_PREFLIGHT');
  assert.equal(first.heartbeat_run_status, 'running');
  assert.equal(f.posts(), 1);
  const second = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(second.status, 'ALREADY_DISPATCHED_READ_ONLY_PREFLIGHT');
  assert.equal(f.posts(), 1);
});

test('queued receipt alone is not accepted as dispatch success', async () => {
  const f = fixture({queuedOnly:true});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl, sleepImpl:async()=>{}});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /WAKE_NOT_PROVEN_STARTED/);
  assert.equal(f.posts(), 1);
});

test('changed OCEA-20 binding prevents wake', async () => {
  const f = fixture({issuePatch:{status:'todo'}});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /ISSUE_NOT_BLOCKED_BEFORE_WAKE/);
  assert.equal(f.posts(), 0);
});

test('coordinator external write grant prevents wake', async () => {
  const f = fixture();
  f.agent.adapterConfig.extraArgs.push('-c', 'permissions.cicd-vwap.filesystem={ "D:/Trading/SierraChart-Replay Two" = "write" }');
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /WRITE_GRANT_PRESENT/);
  assert.equal(f.posts(), 0);
});

test('HTTP integration reads a queued wake back as running before recording dispatch', async () => {
  const f = fixture();
  let posts = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.setHeader('content-type', 'application/json');
    if (url.pathname.startsWith('/api/approvals/')) return response.end(JSON.stringify(f.approvals.get(url.pathname.split('/').at(-1))));
    if (url.pathname === '/api/issues/' + f.config.paperclip.issue_id) return response.end(JSON.stringify(f.issue));
    if (url.pathname === '/api/agents/' + f.config.paperclip.coordinator_agent_id && request.method === 'GET') return response.end(JSON.stringify(f.agent));
    if (url.pathname.includes('/heartbeat-runs') && url.pathname.startsWith('/api/companies/')) return response.end(JSON.stringify(f.runs));
    if (url.pathname === '/api/agents/' + f.config.paperclip.coordinator_agent_id + '/wakeup') {
      posts += 1;
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const run = {id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', agentId:f.config.paperclip.coordinator_agent_id,
        status:'queued', startedAt:null, contextSnapshot:{issueId:body.payload.issueId, wakeReason:body.reason}};
      f.runs.push(run); return response.end(JSON.stringify(run));
    }
    if (url.pathname === '/api/heartbeat-runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') {
      Object.assign(f.runs[0], {status:'running', startedAt:'2026-10-20T13:10:00.000Z'});
      return response.end(JSON.stringify(f.runs[0]));
    }
    response.writeHead(404).end(JSON.stringify({error:'not found'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.config.paperclip.api_base_url = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path});
    assert.equal(result.status, 'DISPATCHED_READ_ONLY_PREFLIGHT');
    assert.equal(result.heartbeat_run_status, 'running');
    assert.equal(posts, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
