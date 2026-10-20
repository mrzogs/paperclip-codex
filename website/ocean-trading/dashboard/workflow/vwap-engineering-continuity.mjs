import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_ISSUE_STATUSES = new Set(['done', 'cancelled']);
const ACTIVE_WORKER_STATES = new Set(['RUNNING_VERIFIED', 'QUEUED_NOT_STARTED']);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scheduledRetry(issue) {
  const retry = issue?.scheduledRetry;
  if (!retry || !UUID.test(String(retry.runId || ''))) return null;
  return retry;
}

function selectedJob(continuity, issueId) {
  return [continuity?.next_automatic_job, ...(continuity?.other_ready_jobs || [])]
    .find(job => job?.issue_id === issueId) || null;
}

export function planVwapEngineeringContinuity({executorIssue, stagingAuthority, continuity, previous = null}) {
  const issueStatus = String(executorIssue?.status || '').toLowerCase();
  const ownerAgentId = String(executorIssue?.assigneeAgentId || '');
  if (!UUID.test(String(executorIssue?.id || '')) || !UUID.test(ownerAgentId)) {
    throw new Error('VWAP_ENGINEERING_CONTINUITY_BINDING_INVALID');
  }
  const job = selectedJob(continuity, executorIssue.id);
  const retry = scheduledRetry(executorIssue);
  const recovery = executorIssue.activeRecoveryAction?.status === 'active' ? executorIssue.activeRecoveryAction : null;
  const approvalStatus = String(stagingAuthority?.approval_status || '').toUpperCase();
  const event = {
    issue_id: executorIssue.id,
    issue_status: issueStatus,
    issue_updated_at_utc: executorIssue.updatedAt || null,
    owner_agent_id: ownerAgentId,
    execution_run_id: executorIssue.executionRunId || null,
    worker_state: job?.worker?.state || null,
    worker_status: job?.worker?.status || null,
    worker_finished_at_utc: job?.worker?.finished_at_utc || null,
    approval_id: stagingAuthority?.approval_id || null,
    approval_status: approvalStatus,
    approval_updated_at_utc: stagingAuthority?.updated_at_utc || null,
    recovery_action_id: recovery?.id || null,
    scheduled_retry_run_id: retry?.runId || null,
  };
  const eventKey = digest(event);
  const base = {
    schema_version: 'ocean-vwap-engineering-continuity/v1',
    event_key: eventKey,
    issue_id: executorIssue.id,
    issue_identifier: executorIssue.identifier,
    owner_agent_id: ownerAgentId,
    worker: job?.worker || null,
    approval_status: approvalStatus,
    authority: {
      runtime_execution_authorized: false,
      replay_playback_authorized: false,
      paper_authorized: false,
      live_authorized: false,
      real_orders_authorized: false,
      trade_polling_required: false,
    },
  };
  if (TERMINAL_ISSUE_STATUSES.has(issueStatus)) return {...base, state:'TERMINAL_NO_ACTION', wake_required:false};
  if (recovery) return {...base, state:'ACTIVE_RECOVERY', wake_required:false, recovery_action_id:recovery.id};
  if (retry) return {...base, state:'SCHEDULED_RETRY', wake_required:false,
    scheduled_retry_run_id:retry.runId, scheduled_retry_at_utc:retry.scheduledRetryAt || retry.dueAt || null};
  if (!job) return {...base, state:'BLOCKED_BY_PREREQUISITE', wake_required:false};
  if (ACTIVE_WORKER_STATES.has(job.worker?.state)) return {...base, state:job.worker.state, wake_required:false};
  if (previous?.event_key === eventKey && UUID.test(String(previous?.wake_run_id || ''))) {
    return {...base, state:'WAKE_ALREADY_RECORDED', wake_required:false,
      wake_run_id:previous.wake_run_id, wake_run_status:previous.wake_run_status || null};
  }
  return {...base, state:'OWNER_WAKE_REQUIRED', wake_required:true,
    reason:'The exact engineering issue is executable but has no active run, queued wake, scheduled retry, or active recovery action.'};
}

export async function reconcileVwapEngineeringContinuity({
  config,
  executorIssue,
  stagingAuthority,
  continuity,
  previous,
  getJson,
  postJson,
}) {
  const plan = planVwapEngineeringContinuity({executorIssue, stagingAuthority, continuity, previous});
  if (!plan.wake_required) return plan;
  const owner = await getJson('/agents/' + plan.owner_agent_id);
  if (owner?.id !== plan.owner_agent_id || owner?.companyId !== config.paperclip.company_id) {
    throw new Error('VWAP_ENGINEERING_CONTINUITY_OWNER_BINDING_INVALID');
  }
  const wakeReason = 'vwap_engineering_continuity_' + plan.event_key.slice(0, 24);
  const wake = await postJson('/agents/' + plan.owner_agent_id + '/wakeup?companyId=' + config.paperclip.company_id, {
    source:'automation',
    triggerDetail:'system',
    reason:wakeReason,
    idempotencyKey:wakeReason,
    payload:{
      issueId:executorIssue.id,
      issueIdentifier:executorIssue.identifier,
      approvalId:stagingAuthority?.approval_id || null,
      approvalStatus:stagingAuthority?.approval_status || null,
      strategyId:config.strategy_id,
      action:'CONTINUE_EXACT_ENGINEERING_ISSUE_OR_OPEN_TYPED_RECOVERY',
      runtimeExecutionAuthorized:false,
      replayPlaybackAuthorized:false,
      paperAuthorized:false,
      liveAuthorized:false,
      realOrdersAuthorized:false,
      tradePollingRequired:false,
      instruction:'Continue only the exact assigned engineering issue. Re-read its current blockers, approval state, owner and execution run. If work cannot safely continue, create or preserve a typed source-scoped recovery action or scheduled retry with an explicit owner and next action. A comment alone is not liveness. Do not poll trades, start Replay, touch Paper or Live, place orders, or infer runtime authority from this wake.',
    },
  });
  if (!UUID.test(String(wake?.id || '')) || wake?.agentId !== plan.owner_agent_id
    || wake?.contextSnapshot?.issueId !== executorIssue.id || wake?.contextSnapshot?.wakeReason !== wakeReason) {
    throw new Error('VWAP_ENGINEERING_CONTINUITY_WAKE_READBACK_INVALID');
  }
  const status = String(wake.status || '').toLowerCase();
  if (!['queued', 'running'].includes(status)) throw new Error('VWAP_ENGINEERING_CONTINUITY_WAKE_NOT_LIVE');
  return {...plan, state:status === 'running' ? 'WAKE_STARTED' : 'WAKE_QUEUED', wake_required:false,
    wake_reason:wakeReason, wake_run_id:wake.id, wake_run_status:status, wake_started_at_utc:wake.startedAt || null};
}
