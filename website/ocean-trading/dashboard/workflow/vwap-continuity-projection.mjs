import path from 'node:path';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['backlog','todo','in_progress','in_review','done','blocked','cancelled']);

// This is a read model. Issue completion and heartbeat transport never grant runtime authority.
export async function projectVwapContinuity({config, executorIssue, stagingAuthority, getJson, observedAt = new Date().toISOString()}) {
  const issues = new Map(), agents = new Map(), edges = [], humanAuthorityBlockers = [];
  const check = (condition, code) => { if (!condition) throw new Error(code); };
  async function visit(issue, ancestors = []) {
    check(UUID.test(String(issue?.id || '')) && /^OCEA-\d+$/.test(String(issue?.identifier || ''))
      && issue.companyId === config.paperclip.company_id && issue.projectId === config.paperclip.project_id
      && issue.projectWorkspaceId === config.paperclip.workspace_id && STATUSES.has(issue.status), 'VWAP_CONTINUITY_ISSUE_BINDING_INVALID');
    check(!ancestors.includes(issue.id), 'VWAP_CONTINUITY_BLOCKER_CYCLE');
    if (issues.has(issue.id)) return;
    check(issues.size < 16 && ancestors.length < 8, 'VWAP_CONTINUITY_GRAPH_LIMIT');
    issues.set(issue.id, issue);
    if (issue.status === 'done') return;
    for (const blocker of issue.blockedBy || []) {
      check(UUID.test(String(blocker?.id || '')), 'VWAP_CONTINUITY_BLOCKER_ID_INVALID');
      const child = issues.get(blocker.id) || await getJson('/issues/' + blocker.id);
      edges.push({issue_id:issue.id, blocker_id:child?.id});
      await visit(child, [...ancestors, issue.id]);
    }
  }
  await visit(executorIssue);
  const jobs = [];
  for (const issue of issues.values()) {
    if (issue.status === 'done') continue;
    const unresolved = edges.filter(edge => edge.issue_id === issue.id && issues.get(edge.blocker_id)?.status !== 'done');
    if (unresolved.length) continue;
    const recovery = issue.activeRecoveryAction?.status === 'active' ? issue.activeRecoveryAction : null;
    if (recovery) check(recovery.companyId === config.paperclip.company_id && recovery.sourceIssueId === issue.id
      && recovery.ownerType === 'agent' && UUID.test(String(recovery.ownerAgentId || '')), 'VWAP_CONTINUITY_RECOVERY_BINDING_INVALID');
    const ownerId = recovery?.ownerAgentId || issue.assigneeAgentId;
    check(UUID.test(String(ownerId || '')), 'VWAP_CONTINUITY_OWNER_MISSING');
    let agent = agents.get(ownerId);
    if (!agent) {
      agent = await getJson('/agents/' + ownerId);
      check(agent?.id === ownerId && agent.companyId === config.paperclip.company_id && typeof agent.name === 'string', 'VWAP_CONTINUITY_OWNER_BINDING_INVALID');
      agents.set(agent.id, agent);
    }
    const interactionReadback = await getJson('/issues/' + issue.id + '/interactions');
    const interactions = Array.isArray(interactionReadback) ? interactionReadback : interactionReadback ? [interactionReadback] : [];
    for (const interaction of interactions) check(UUID.test(String(interaction?.id || ''))
      && interaction.issueId === issue.id && interaction.companyId === config.paperclip.company_id
      && typeof interaction.kind === 'string' && typeof interaction.status === 'string',
    'VWAP_CONTINUITY_INTERACTION_BINDING_INVALID');
    const pendingInteractions = interactions.filter(interaction => interaction.status === 'pending');
    check(pendingInteractions.length <= 1, 'VWAP_CONTINUITY_MULTIPLE_PENDING_INTERACTIONS');
    const pendingInteraction = pendingInteractions[0] || null;
    const questions = pendingInteraction?.kind === 'ask_user_questions' && Array.isArray(pendingInteraction.payload?.questions)
      ? pendingInteraction.payload.questions.map(question => ({
        id:String(question?.id || ''),prompt:String(question?.prompt || ''),selection_mode:String(question?.selectionMode || ''),
        options:Array.isArray(question?.options) ? question.options.map(option => ({
          id:String(option?.id || ''),label:String(option?.label || ''),description:String(option?.description || ''),
        })) : [],
      })) : [];
    const humanInteraction = pendingInteraction ? {
      id:pendingInteraction.id,kind:pendingInteraction.kind,status:'PENDING',
      title:pendingInteraction.title || 'Paperclip input required',summary:pendingInteraction.summary || null,
      continuation_policy:pendingInteraction.continuationPolicy || 'none',questions,
      issue_id:issue.id,issue_identifier:issue.identifier,
      url:'http://127.0.0.1:3100/OCEA/issues/' + issue.identifier,
      owner:'Wayne / Paperclip board',
      action:pendingInteraction.kind === 'ask_user_questions'
        ? 'Answer the pending Paperclip question. Paperclip must then wake the assigned issue owner; Ocean only verifies that continuation and grants no runtime authority.'
        : 'Resolve the pending Paperclip interaction. Paperclip must then continue the assigned issue owner; Ocean grants no runtime authority.',
    } : null;
    let worker = {state:'NOT_OBSERVED',run_id:null,started_at_utc:null};
    const executionRunId = recovery ? recovery.evidence?.correctiveRunId : issue.executionRunId;
    if (executionRunId) {
      check(UUID.test(executionRunId), 'VWAP_CONTINUITY_WORKER_ID_INVALID');
      const run = await getJson('/heartbeat-runs/' + executionRunId);
      const workspace = run?.contextSnapshot?.paperclipWorkspace;
      check(run?.id === executionRunId && run.agentId === ownerId
        && run.companyId === config.paperclip.company_id && run.contextSnapshot?.issueId === issue.id,
      'VWAP_CONTINUITY_WORKER_BINDING_INVALID');
      check(workspace?.projectId === config.paperclip.project_id && workspace?.workspaceId === config.paperclip.workspace_id
        && typeof workspace?.cwd === 'string' && typeof config.paperclip.coordinator_project_root === 'string'
        && path.win32.normalize(workspace.cwd).toLowerCase() === path.win32.normalize(config.paperclip.coordinator_project_root).toLowerCase(),
      'VWAP_CONTINUITY_WORKER_WORKSPACE_INVALID');
      const startTime = Date.parse(run.startedAt || '');
      const started = Number.isFinite(startTime) && startTime <= Date.parse(observedAt);
      worker = {state:run.status === 'running' && started ? 'RUNNING_VERIFIED'
        : run.status === 'queued' ? 'QUEUED_NOT_STARTED'
          : ['succeeded','failed','timed_out','cancelled'].includes(run.status) && started ? 'FINISHED_NOT_DELIVERABLE_PROOF' : 'START_NOT_PROVEN',
      run_id:run.id,status:run.status,started_at_utc:started ? run.startedAt : null};
    }
    const job = {issue_id:issue.id,identifier:issue.identifier,title:recovery ? 'Restore execution: ' + issue.title : issue.title,status:issue.status.toUpperCase(),
      owner_agent_id:agent.id,owner_name:agent.name,url:'http://127.0.0.1:3100/OCEA/issues/' + issue.identifier,
      worker,human_interaction:humanInteraction,recovery_action_id:recovery?.id || null,latest_failure_code:recovery?.evidence?.latestRunErrorCode || null,
      recovery_required:Boolean(humanInteraction) || Boolean(recovery) || issue.status === 'blocked' || issue.status === 'cancelled'
        || !['RUNNING_VERIFIED','QUEUED_NOT_STARTED'].includes(worker.state),
      recovery_action:humanInteraction ? humanInteraction.action : recovery ? recovery.nextAction
        : issue.status === 'blocked' ? 'Owner must reconcile the remaining blocker or resume this issue after completed prerequisites.'
          : 'Paperclip owner must continue or recover this exact issue; a completed heartbeat alone is not task completion.'};
    if (humanInteraction) humanAuthorityBlockers.push(job);
    else jobs.push(job);
  }
  jobs.sort((a,b) => Number(b.worker.state === 'RUNNING_VERIFIED') - Number(a.worker.state === 'RUNNING_VERIFIED')
    || a.identifier.localeCompare(b.identifier, undefined, {numeric:true}));
  const approval = {source:'PAPERCLIP_LIVE',id:stagingAuthority.approval_id,status:stagingAuthority.approval_status,
    required:['PENDING','REVISION_REQUESTED'].includes(stagingAuthority.approval_status),owner:'Wayne / Paperclip board',
    title:'Review the exact Sim1 TEST staging package in Paperclip',url:stagingAuthority.approval_url,
    scope:stagingAuthority.approval_scope};
  return {schema_version:'ocean-vwap-continuity-projection/v1',source:'PAPERCLIP_LIVE',observed_at_utc:observedAt,
    freshness:{state:'CURRENT',max_age_ms:90000},human_decision:approval,
    human_authority_blocker:humanAuthorityBlockers[0] || null,next_automatic_job:jobs[0] || null,
    other_ready_jobs:jobs.slice(1),issue_chain:[...issues.values()].map(issue=>({id:issue.id,identifier:issue.identifier,
      title:issue.title,status:issue.status.toUpperCase(),owner_agent_id:issue.assigneeAgentId,
      pending_interaction_id:humanAuthorityBlockers.find(job=>job.issue_id===issue.id)?.human_interaction?.id || null,
      pending_interaction_kind:humanAuthorityBlockers.find(job=>job.issue_id===issue.id)?.human_interaction?.kind || null,
      unresolved_blocker_ids:edges.filter(edge=>edge.issue_id===issue.id&&issues.get(edge.blocker_id)?.status!=='done').map(edge=>edge.blocker_id)})),
    completed_blocker_edges:edges.filter(edge=>issues.get(edge.blocker_id)?.status==='done'),
    authority:{instance_admission:'NOT_PROVEN',current_exclusive_booking:'NOT_PROVEN',
      booking_requirement:'Atomic current owner/generation, expiry and revocation readback is required; a historical matching comment is insufficient.',
      per_run_manifest:'POST_STAGING_BINDING_NOT_AUTHORIZED',test_standing_policy:'NOT_GRANTED',
      future_gate:'One consolidated post-staging run/measurement decision after physical and controller proof.',
      paper_promotion:'SEPARATE_HUMAN_GATE',live_promotion:'SEPARATE_HUMAN_GATE',runtime_execution_authorized:false}};
}

export function currentVwapContinuity(projection, now = Date.now()) {
  if (!projection) return null;
  const age = now - Date.parse(projection.observed_at_utc || '');
  if (projection.freshness?.state !== 'CURRENT' || !Number.isFinite(age) || age < 0 || age > 90000) return {...projection,
    freshness:{state:'STALE',max_age_ms:90000},human_authority_blocker:null,next_automatic_job:null,other_ready_jobs:[],
    human_decision:{...projection.human_decision,source:'STALE_READBACK',required:false}};
  return projection;
}
