import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
function byteResponse(body, status = 200) {
  const bytes = Buffer.from(body);
  return {ok:status >= 200 && status < 300, status, arrayBuffer:async () => bytes};
}
function fixture({statuses = ['approved','approved'], stagingStatus = 'pending', issuePatch = {}, agentPatch = {}, queuedOnly = false, configPatch = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-vwap-approval-dispatch-'));
  const config = JSON.parse(JSON.stringify(loadVwapPhysicalComparatorApprovalDispatchConfig(BASE_CONFIG)));
  Object.assign(config, {state_path:path.join(root, 'state.json'), contract_path:CONTRACT.pathname.replace(/^\/(.:)/, '$1'), wake_start_timeout_ms:20, wake_poll_interval_ms:1}, configPatch);
  const stagingPackage = Buffer.from(JSON.stringify({
    schema_version:config.staging_authority.package_schema_version,
    status:'PREPARED_NOT_AUTHORIZED_NOT_EXECUTED', issue:config.staging_authority.issue_identifier,
    target:{account:'Sim1',bar_seconds:300},
    approval_request:{decision:config.staging_authority.approval_scope,approval_granted:false},
  }));
  config.staging_authority.package_sha256 = crypto.createHash('sha256').update(stagingPackage).digest('hex');
  const approvals = new Map(config.sealed_authority.approvals.map((item, index) => [item.approval_id, {
    id:item.approval_id, companyId:config.paperclip.company_id, type:'request_board_approval', status:statuses[index],
    payload:{strategy_id:config.strategy_id, namespace:config.namespace, contract_id:config.sealed_authority.contract_id,
      contract_hash:config.sealed_authority.contract_hash, context_hash:config.sealed_authority.context_hash,
      run_id:config.sealed_authority.run_id, decision_scope:item.decision_scope,
      ...(item.decision_scope === 'RUN_RELEASE' ? {output_root:config.staging_authority.continuation.run_release_output_root} : {})},
  }]));
  approvals.set(config.staging_authority.approval_id, {
    id:config.staging_authority.approval_id, companyId:config.paperclip.company_id, type:'request_board_approval',
    requestedByAgentId:config.paperclip.coordinator_agent_id, status:stagingStatus, payload:{
      title:'CICD Sim1 TEST only: exact v238 / v0.5.53 staging and one gated diagnostic start',
      attachmentId:config.staging_authority.attachment_id, package_sha256:config.staging_authority.package_sha256,
      scope:config.staging_authority.approval_scope,
      target:{account:'Sim1',bar_seconds:300,chartbook:config.preflight_outcome.chartbook_path},
      selected_artifacts:[config.preflight_outcome.strategy_artifact,config.preflight_outcome.telemetry_artifact]
        .map(item => ({sha256:item.selected_hash.replace(/^sha256:/, '')})),
      allowed_future_write_paths:[...config.staging_authority.allowed_future_write_paths],
      database_rule:'No database edit authority.',
      excluded:'RUN_RELEASE materialization, playback, bridge activation, Paper/Live, real orders, historical role/row edits, threshold selection',
      risks:['Fresh stopped/flat/no-order proof remains unverified.'],
    },
    decidedAt:stagingStatus === 'approved' ? '2026-10-20T13:54:52.000Z' : null,
    updatedAt:'2026-10-20T13:54:52.000Z',
  });
  const issue = {id:config.paperclip.issue_id, identifier:config.paperclip.issue_identifier, companyId:config.paperclip.company_id,
    projectId:config.paperclip.project_id, projectWorkspaceId:config.paperclip.workspace_id,
    assigneeAgentId:config.paperclip.coordinator_agent_id, status:'blocked',
    blockedBy:[{id:config.preflight_outcome.next_task.issue_id,identifier:config.preflight_outcome.next_task.issue_identifier,status:'in_review'}], ...issuePatch};
  const nextTask = {id:config.preflight_outcome.next_task.issue_id, identifier:config.preflight_outcome.next_task.issue_identifier,
    companyId:config.paperclip.company_id, projectId:config.paperclip.project_id, projectWorkspaceId:config.paperclip.workspace_id,
    parentId:config.paperclip.issue_id, title:config.preflight_outcome.next_task.title,
    assigneeAgentId:config.paperclip.coordinator_agent_id, status:'blocked', executionRunId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    blockedBy:[{id:config.staging_authority.continuation.execution_route.engineering_issue_id,
      identifier:config.staging_authority.continuation.execution_route.engineering_issue_identifier,status:'todo'}]};
  const executorIssue={id:config.staging_authority.continuation.execution_route.engineering_issue_id,
    identifier:config.staging_authority.continuation.execution_route.engineering_issue_identifier,
    companyId:config.paperclip.company_id,projectId:config.paperclip.project_id,projectWorkspaceId:config.paperclip.workspace_id,
    parentId:config.staging_authority.issue_id,title:config.staging_authority.continuation.execution_route.engineering_issue_title,
    assigneeAgentId:config.paperclip.coordinator_agent_id,status:'todo'};
  const grants = config.coordinator_gate.required_read_only_paths.map(value => `"${value.replace(/\\/g, '/')}" = "read"`).join(', ');
  const agent = {id:config.paperclip.coordinator_agent_id, companyId:config.paperclip.company_id, name:config.paperclip.coordinator_name,
    adapterType:'codex_local', adapterConfig:{cwd:config.paperclip.coordinator_project_root, model:config.paperclip.coordinator_model,
      dangerouslyBypassApprovalsAndSandbox:false, extraArgs:['-c', `permissions.cicd-vwap.filesystem={ ${grants} }`]},
    metadata:{active_strategy_id:config.strategy_id, brain_project:config.strategy_id, brain_domain:'trading-strategy',
      paperclip_project_id:config.paperclip.project_id, paperclip_workspace_id:config.paperclip.workspace_id,
      environment:'TEST_ONLY', live_real_enabled:false}, permissions:{canUseLiveTrading:false}, ...agentPatch};
  let posts = 0;
  const requests = [];
  const runs = [];
  const fetchImpl = async (url, options = {}) => {
    const route = new URL(url).pathname + new URL(url).search;
    requests.push({route,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    if (route.includes('/approvals/')) return response(approvals.get(route.split('/').at(-1)));
    if (route === '/api/attachments/' + config.staging_authority.attachment_id + '/content') return byteResponse(stagingPackage);
    if (route === '/api/issues/' + config.paperclip.issue_id) return response(issue);
    if (route === '/api/issues/' + config.preflight_outcome.next_task.issue_id) return response(nextTask);
    if (route === '/api/issues/' + config.staging_authority.continuation.execution_route.engineering_issue_id) return response(executorIssue);
    if (route === '/api/agents/' + config.paperclip.coordinator_agent_id) return response(agent);
    if (route.startsWith('/api/companies/') && route.includes('/heartbeat-runs')) return response(runs);
    if (route.startsWith('/api/agents/') && route.includes('/wakeup')) {
      posts += 1;
      const body = JSON.parse(options.body);
      const continuation = body.payload.approvalId === config.staging_authority.approval_id;
      const run = {id:continuation?'dddddddd-dddd-4ddd-8ddd-dddddddddddd':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', agentId:config.paperclip.coordinator_agent_id,
        status:'queued', startedAt:null, contextSnapshot:{issueId:body.payload.issueId,wakeReason:body.reason}};
      runs.push(run);
      return response(run);
    }
    if (route === '/api/heartbeat-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
      if (!queuedOnly) Object.assign(runs[0], {status:'running', startedAt:'2026-10-20T13:00:00.000Z'});
      return response(runs[0]);
    }
    if (route === '/api/heartbeat-runs/dddddddd-dddd-4ddd-8ddd-dddddddddddd') {
      const run = runs.find(item => item.id === 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      if (!queuedOnly) Object.assign(run, {status:'running', startedAt:'2026-10-20T14:00:00.000Z'});
      return response(run);
    }
    return response({error:'not found', route}, 404);
  };
  return {root, config, approvals, issue, nextTask, executorIssue, agent, runs, stagingPackage, fetchImpl, posts:() => posts,requests};
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

test('completed exact preflight projects the physical mismatch and Paperclip task without another wake', async () => {
  const f = fixture();
  f.runs.push({
    id:f.config.preflight_outcome.heartbeat_run_id,
    agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded',
    startedAt:'2026-10-20T13:30:21.351Z',
    finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id, wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'},
  });
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'PREFLIGHT_BLOCKED_PHYSICAL_BINDING', result.reason);
  assert.equal(result.preflight_outcome.account_alias, 'Sim1');
  assert.equal(result.preflight_outcome.next_task.issue_identifier, 'OCEA-22');
  assert.equal(result.staging_authority.approval_status, 'PENDING');
  assert.equal(result.staging_authority.package_recovery, 'BYTE_IDENTICAL_SHA256_VERIFIED');
  assert.equal(result.staging_authority.timeframe.bar_seconds, 300);
  assert.equal(result.staging_authority.mutable_reference.classification, 'INFORMATIONAL_SNAPSHOT_NOT_PHYSICAL_PREFLIGHT_PIN');
  assert.equal(result.staging_authority.continuation.state, 'AWAITING_PAPERCLIP_HUMAN_DECISION');
  assert.equal(result.safety.runtime_write_scope_authorized, false);
  assert.equal(result.safety.replay_start_authorized, false);
  assert.equal(f.posts(), 0);
});

test('approved staging authority observes the Paperclip requester wake without authorizing playback', async () => {
  const f = fixture({stagingStatus:'approved'});
  f.runs.push({
    id:f.config.preflight_outcome.heartbeat_run_id, agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded', startedAt:'2026-10-20T13:30:21.351Z', finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id, wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'},
  });
  f.runs.push({id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',agentId:f.config.paperclip.coordinator_agent_id,
    status:'running',startedAt:'2026-10-20T23:59:59.000Z',contextSnapshot:{approvalId:f.config.staging_authority.approval_id,
      issueId:f.config.staging_authority.issue_id,wakeReason:'approval_approved'}});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'PREFLIGHT_BLOCKED_PHYSICAL_BINDING');
  assert.equal(result.staging_authority.approval_status, 'APPROVED');
  assert.equal(result.staging_authority.continuation.state, 'PAPERCLIP_REQUESTER_WAKE_STARTED');
  assert.equal(result.staging_authority.continuation.heartbeat_run_id, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  assert.equal(result.staging_authority.scope_authority.existing_run_release_approval_granted, true);
  assert.equal(result.staging_authority.scope_authority.combined_sequence_eligible, false);
  assert.equal(result.staging_authority.scope_authority.post_staging_consolidated_approval_required, true);
  assert.equal(result.staging_authority.scope_authority.playback_granted, false);
  assert.equal(result.safety.runtime_write_scope_authorized, false);
  assert.equal(result.safety.replay_start_authorized, false);
  assert.equal(f.posts(), 0);
});

test('approved staging authority repairs a missing requester wake once and proves it started', async () => {
  const f = fixture({stagingStatus:'approved'});
  f.config.staging_authority.continuation.paperclip_wakeup_grace_ms = 0;
  f.runs.push({id:f.config.preflight_outcome.heartbeat_run_id,agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded',startedAt:'2026-10-20T13:30:21.351Z',finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id,wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'}});
  const first = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(first.status,'PREFLIGHT_BLOCKED_PHYSICAL_BINDING',first.reason);
  assert.equal(first.staging_authority.continuation.state,'OCEAN_LIVENESS_REPAIR_STARTED');
  assert.equal(first.staging_authority.continuation.heartbeat_run_status,'running');
  assert.equal(first.staging_authority.execution_route.state,'BLOCKED_COORDINATOR_SOURCE_READ_SCOPE_MISSING');
  assert.equal(first.staging_authority.execution_route.mutation_attempted,false);
  assert.equal(first.staging_authority.execution_route.coordinator_can_execute,false);
  assert.equal(first.staging_authority.execution_route.missing_source_read_paths.length,2);
  assert.equal(f.requests.some(item=>item.method==='PATCH'&&item.route.includes('/agents/')),false);
  assert.equal(first.staging_authority.staging_success_receipt.status,'AWAITING_PACKAGE_BOUND_RECEIPT');
  assert.equal(first.workflow_lineage.relationship,'BLOCKED_BY');
  assert.equal(f.posts(),1);
  const second = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(second.staging_authority.continuation.heartbeat_run_id,first.staging_authority.continuation.heartbeat_run_id);
  assert.equal(f.posts(),1);
});

test('a queued Paperclip requester wake suppresses the Ocean fallback', async () => {
  const f = fixture({stagingStatus:'approved'});
  f.config.staging_authority.continuation.paperclip_wakeup_grace_ms = 0;
  f.runs.push({id:f.config.preflight_outcome.heartbeat_run_id,agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded',startedAt:'2026-10-20T13:30:21.351Z',finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id,wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'}});
  f.runs.push({id:'ffffffff-ffff-4fff-8fff-ffffffffffff',agentId:f.config.paperclip.coordinator_agent_id,
    status:'queued',startedAt:null,contextSnapshot:{approvalId:f.config.staging_authority.approval_id,
      issueId:f.config.staging_authority.issue_id,wakeReason:'approval_approved'}});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.status,'PREFLIGHT_BLOCKED_PHYSICAL_BINDING',result.reason);
  assert.equal(result.staging_authority.continuation.state,'PAPERCLIP_REQUESTER_WAKE_QUEUED');
  assert.equal(f.posts(),0);
});

test('changed staging package bytes fail closed', async () => {
  const f = fixture();
  f.stagingPackage[0] = 0x20;
  f.runs.push({
    id:f.config.preflight_outcome.heartbeat_run_id, agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded', startedAt:'2026-10-20T13:30:21.351Z', finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id, wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'},
  });
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /STAGING_PACKAGE_HASH_MISMATCH/);
  assert.equal(f.posts(), 0);
});

test('queued receipt alone is not accepted as dispatch success', async () => {
  const f = fixture({queuedOnly:true});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl, sleepImpl:async()=>{}});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /WAKE_NOT_PROVEN_STARTED/);
  assert.equal(f.posts(), 1);
});

test('worker readback cannot substitute another run or a malformed start timestamp', async () => {
  for (const patch of [{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{startedAt:'not-a-date'}]) {
    const f=fixture();
    const fetchImpl=async(url,options)=>{
      const value=await f.fetchImpl(url,options);
      if(new URL(url).pathname==='/api/heartbeat-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        return response({...JSON.parse(await value.text()),...patch});
      return value;
    };
    const result=await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl,sleepImpl:async()=>{}});
    assert.equal(result.status,'ATTENTION_REQUIRED');
    assert.match(result.reason,/WAKE_(READBACK_MISMATCH|NOT_PROVEN_STARTED)/);
    assert.equal(result.dispatched,false);
  }
});

test('changed OCEA-20 binding prevents wake', async () => {
  const f = fixture({issuePatch:{status:'todo'}});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /ISSUE_NOT_BLOCKED_BEFORE_WAKE/);
  assert.equal(f.posts(), 0);
});

test('a missing OCEA-20 to OCEA-22 blocker edge fails closed', async () => {
  const f = fixture({issuePatch:{blockedBy:[]}});
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.status,'ATTENTION_REQUIRED');
  assert.match(result.reason,/ACTIVE_BLOCKER_LINK_MISSING/);
  assert.equal(f.posts(),0);
});

test('a missing OCEA-22 to OCEA-24 executor blocker edge fails closed', async () => {
  const f = fixture();
  f.nextTask.blockedBy=[];
  const result=await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.status,'ATTENTION_REQUIRED');
  assert.match(result.reason,/PREFLIGHT_TASK_BINDING_INVALID/);
  assert.equal(f.posts(),0);
});

test('coordinator external write grant prevents wake', async () => {
  const f = fixture();
  f.agent.adapterConfig.extraArgs.push('-c', 'permissions.cicd-vwap.filesystem={ "D:/Trading/SierraChart-Replay Two" = "write" }');
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config, stateFile:f.config.state_path, fetchImpl:f.fetchImpl});
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.match(result.reason, /WRITE_GRANT_PRESENT/);
  assert.equal(f.posts(), 0);
});

test('approved staging rejects any write grant outside the exact staging scope', async () => {
  const f = fixture({stagingStatus:'approved'});
  f.agent.adapterConfig.extraArgs.push('-c','permissions.cicd-vwap.filesystem={ "D:/Trading/SierraChart-Replay Two" = "write" }');
  const result = await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.status,'ATTENTION_REQUIRED');
  assert.match(result.reason,/UNAPPROVED_WRITE_GRANT_PRESENT/);
  assert.equal(f.posts(),0);
});

test('approved staging reports exact scope gaps without mutating coordinator permissions', async () => {
  const f=fixture({stagingStatus:'approved'});
  f.runs.push({id:f.config.preflight_outcome.heartbeat_run_id,agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded',startedAt:'2026-10-20T13:30:21.351Z',finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id,wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'}});
  f.runs.push({id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',agentId:f.config.paperclip.coordinator_agent_id,
    status:'running',startedAt:'2026-10-20T23:59:59.000Z',contextSnapshot:{approvalId:f.config.staging_authority.approval_id,
      issueId:f.config.staging_authority.issue_id,wakeReason:'approval_approved'}});
  const result=await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.staging_authority.execution_route.state,'BLOCKED_COORDINATOR_SOURCE_READ_SCOPE_MISSING');
  assert.deepEqual(result.staging_authority.execution_route.missing_write_paths,f.config.staging_authority.allowed_future_write_paths);
  assert.equal(result.staging_authority.execution_route.mutation_attempted,false);
  assert.equal(f.requests.some(item=>item.method==='PATCH'&&item.route.includes('/agents/')),false);
});

test('exact read and write grants remain blocked until diagnostics-only command policy is enforced', async () => {
  const f=fixture({stagingStatus:'approved'});
  const route=f.config.staging_authority.continuation.execution_route;
  const extra=[...route.required_source_read_paths.map(value=>`"${value.replace(/\\/g,'/')}" = "read"`),
    ...f.config.staging_authority.allowed_future_write_paths.map(value=>`"${value.replace(/\\/g,'/')}" = "write"`)];
  f.agent.adapterConfig.extraArgs.push('-c',`permissions.cicd-vwap.filesystem={ ${extra.join(', ')} }`);
  f.runs.push({id:f.config.preflight_outcome.heartbeat_run_id,agentId:f.config.paperclip.coordinator_agent_id,
    status:'succeeded',startedAt:'2026-10-20T13:30:21.351Z',finishedAt:'2026-10-20T13:32:41.930Z',
    contextSnapshot:{issueId:f.config.paperclip.issue_id,wakeReason:'vwap_v238_dual_approval_read_only_preflight_e9a1f3be3c90bb88bc2e'}});
  f.runs.push({id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',agentId:f.config.paperclip.coordinator_agent_id,
    status:'running',startedAt:'2026-10-20T23:59:59.000Z',contextSnapshot:{approvalId:f.config.staging_authority.approval_id,
      issueId:f.config.staging_authority.issue_id,wakeReason:'approval_approved'}});
  const result=await scanVwapPhysicalComparatorApprovalDispatch({config:f.config,stateFile:f.config.state_path,fetchImpl:f.fetchImpl});
  assert.equal(result.staging_authority.execution_route.state,'BLOCKED_DIAGNOSTIC_COMMAND_POLICY_NOT_ENFORCED');
  assert.equal(result.staging_authority.execution_route.coordinator_can_execute,false);
  assert.equal(result.staging_authority.execution_route.missing_source_read_paths.length,0);
  assert.equal(result.staging_authority.execution_route.missing_write_paths.length,0);
});

test('HTTP integration reads a queued wake back as running before recording dispatch', async () => {
  const f = fixture();
  let posts = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/attachments/' + f.config.staging_authority.attachment_id + '/content') return response.end(f.stagingPackage);
    if (url.pathname.startsWith('/api/approvals/')) return response.end(JSON.stringify(f.approvals.get(url.pathname.split('/').at(-1))));
    if (url.pathname === '/api/issues/' + f.config.paperclip.issue_id) return response.end(JSON.stringify(f.issue));
    if (url.pathname === '/api/issues/' + f.config.preflight_outcome.next_task.issue_id) return response.end(JSON.stringify(f.nextTask));
    if (url.pathname === '/api/issues/' + f.config.staging_authority.continuation.execution_route.engineering_issue_id) return response.end(JSON.stringify(f.executorIssue));
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
