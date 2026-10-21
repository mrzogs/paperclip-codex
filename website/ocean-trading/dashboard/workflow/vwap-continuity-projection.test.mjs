import assert from 'node:assert/strict';
import test from 'node:test';
import {projectVwapContinuity,currentVwapContinuity} from './vwap-continuity-projection.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const config={paperclip:{company_id:id(1),project_id:id(2),workspace_id:id(3),coordinator_project_root:'C:\\fixture'}};
  const issue = (n,status,blockers=[])=>({id:id(n),identifier:'OCEA-'+n,title:'Task '+n,status,
    companyId:id(1),projectId:id(2),projectWorkspaceId:id(3),assigneeAgentId:id(100+n),blockedBy:blockers.map(n=>({id:id(n)}))});
  const issues=new Map([[24,issue(24,'blocked',[28])],[28,issue(28,'blocked',[29,30])],
    [29,issue(29,'done')],[30,issue(30,'blocked',[29])]]);
  const agents=new Map([...issues.keys()].map(n=>[id(100+n),{id:id(100+n),companyId:id(1),name:'Owner '+n}]));
  const runs=new Map(),interactions=new Map(),requests=[];
  const getJson=async route=>{
    requests.push(route);
    const [kind,key,child]=route.slice(1).split('/');
    if(kind==='issues'&&child==='interactions')return interactions.get(key) || [];
    if(kind==='issues')return [...issues.values()].find(i=>i.id===key);
    if(kind==='agents')return agents.get(key);
    if(kind==='heartbeat-runs')return runs.get(key);
    throw Error('Unexpected read '+route);
  };
  const stagingAuthority={approval_id:id(200),approval_status:'PENDING',approval_url:'http://127.0.0.1:3100/OCEA/approvals/'+id(200),
    approval_scope:'TEST_STAGING_WRITE_SINGLE_DIAGNOSTIC_START_ONLY'};
  return {config,issues,agents,runs,interactions,requests,stagingAuthority,getJson,
    project:()=>projectVwapContinuity({config,executorIssue:issues.get(24),stagingAuthority,getJson})};
}

test('completed candidate no longer hides the review owner behind a stale blocker',async()=>{
  const f=fixture(),p=await f.project();
  assert.equal(p.next_automatic_job.identifier,'OCEA-30');
  assert.equal(p.next_automatic_job.owner_name,'Owner 30');
  assert.equal(p.next_automatic_job.recovery_required,true);
  assert.equal(p.next_automatic_job.worker.state,'NOT_OBSERVED');
  assert.equal(p.completed_blocker_edges.length,2);
  assert.equal(p.human_decision.required,true);
  assert.equal(p.human_decision.source,'PAPERCLIP_LIVE');
  assert.equal(p.authority.runtime_execution_authorized,false);
  assert.equal(p.authority.current_exclusive_booking,'NOT_PROVEN');
  assert.equal(p.authority.test_standing_policy,'NOT_GRANTED');
  assert(f.requests.every(route=>/^\/(issues|agents|heartbeat-runs)\//.test(route)));
});

test('a pending Paperclip question is projected as the exact human authority blocker, not automatic work',async()=>{
  const f=fixture(),issue=f.issues.get(30);
  f.interactions.set(issue.id,[{id:id(500),companyId:id(1),issueId:issue.id,kind:'ask_user_questions',status:'pending',
    continuationPolicy:'wake_assignee',title:'Identify exact Telemetry and host authority',summary:null,payload:{questions:[{
      id:'authority',prompt:'Name the authorized supervised host principal.',selectionMode:'single',options:[
        {id:'snapshot',label:'Owner supplies immutable snapshot',description:'Keep agents root-bound.'},
        {id:'authorized-owner',label:'Existing authorized owner patches source',description:'Name the exact owner and workspace.'},
      ],
    }]}}]);
  const p=await f.project();
  assert.equal(p.next_automatic_job,null);
  assert.equal(p.human_authority_blocker.identifier,'OCEA-30');
  assert.equal(p.human_authority_blocker.human_interaction.id,id(500));
  assert.equal(p.human_authority_blocker.human_interaction.continuation_policy,'wake_assignee');
  assert.equal(p.human_authority_blocker.human_interaction.questions[0].prompt,'Name the authorized supervised host principal.');
  assert.equal(p.issue_chain.find(item=>item.identifier==='OCEA-30').pending_interaction_id,id(500));
  assert.match(p.human_authority_blocker.recovery_action,/Answer the pending Paperclip question/);
});

test('resolved interaction disappears and exposes the owner wake for independent verification',async()=>{
  const f=fixture(),issue=f.issues.get(30);
  issue.status='in_progress';issue.executionRunId=id(300);
  f.interactions.set(issue.id,[{id:id(500),companyId:id(1),issueId:issue.id,kind:'ask_user_questions',status:'answered',
    continuationPolicy:'wake_assignee',title:'Identify authority',payload:{questions:[]}}]);
  f.runs.set(id(300),{id:id(300),agentId:issue.assigneeAgentId,companyId:id(1),status:'running',startedAt:'2026-10-20T16:00:00Z',
    contextSnapshot:{issueId:issue.id,paperclipWorkspace:{projectId:id(2),workspaceId:id(3),cwd:'C:\\fixture'}}});
  const p=await f.project();
  assert.equal(p.human_authority_blocker,null);
  assert.equal(p.next_automatic_job.identifier,'OCEA-30');
  assert.equal(p.next_automatic_job.worker.state,'RUNNING_VERIFIED');
  assert.equal(p.next_automatic_job.recovery_required,false);
});

test('current worker is read independently and must match issue, owner, company and run ID',async()=>{
  const f=fixture(),i=f.issues.get(30);
  i.status='in_progress';i.executionRunId=id(300);
  f.runs.set(id(300),{id:id(300),agentId:i.assigneeAgentId,companyId:id(1),status:'running',
    startedAt:'2026-10-20T16:00:00Z',contextSnapshot:{issueId:i.id,paperclipWorkspace:{projectId:id(2),workspaceId:id(3),cwd:'C:\\fixture'}}});
  const p=await f.project();
  assert.equal(p.next_automatic_job.worker.state,'RUNNING_VERIFIED');
  assert.equal(p.next_automatic_job.recovery_required,false);
  assert(f.requests.includes('/heartbeat-runs/'+id(300)));
  for(const patch of [{id:id(301)},{agentId:id(999)},{companyId:id(999)},{contextSnapshot:{issueId:id(999)}}]){
    const prior=f.runs.get(id(300));f.runs.set(id(300),{...prior,...patch});
    await assert.rejects(f.project(),/WORKER_BINDING_INVALID/);
    f.runs.set(id(300),prior);
  }
});

test('queued and finished heartbeats never masquerade as a running worker or completed deliverable',async()=>{
  const f=fixture(),i=f.issues.get(30);i.executionRunId=id(300);
  const run={id:id(300),agentId:i.assigneeAgentId,companyId:id(1),status:'queued',startedAt:null,
    contextSnapshot:{issueId:i.id,paperclipWorkspace:{projectId:id(2),workspaceId:id(3),cwd:'C:\\fixture'}}};
  f.runs.set(run.id,run);
  assert.equal((await f.project()).next_automatic_job.worker.state,'QUEUED_NOT_STARTED');
  Object.assign(run,{status:'running',startedAt:'invalid'});
  assert.equal((await f.project()).next_automatic_job.worker.state,'START_NOT_PROVEN');
  Object.assign(run,{status:'succeeded',startedAt:'2026-10-20T16:00:00Z'});
  assert.equal((await f.project()).next_automatic_job.worker.state,'FINISHED_NOT_DELIVERABLE_PROOF');
});

test('cycles, cross-project dependencies and unassigned leaves fail closed',async()=>{
  const f=fixture();f.issues.get(30).blockedBy=[{id:id(24)}];
  await assert.rejects(f.project(),/BLOCKER_CYCLE/);
  f.issues.get(30).blockedBy=[];f.issues.get(30).projectId=id(999);
  await assert.rejects(f.project(),/ISSUE_BINDING_INVALID/);
  f.issues.get(30).projectId=id(2);f.issues.get(30).assigneeAgentId=null;
  await assert.rejects(f.project(),/OWNER_MISSING/);
});

test('stale readback withdraws current action and human-decision claims',async()=>{
  const p=await fixture().project(),at=Date.parse(p.observed_at_utc);
  assert.equal(currentVwapContinuity(p,at+89999).freshness.state,'CURRENT');
  const stale=currentVwapContinuity(p,at+90001);
  assert.equal(stale.freshness.state,'STALE');
  assert.equal(stale.next_automatic_job,null);
  assert.equal(stale.human_decision.required,false);
  assert.equal(stale.authority.runtime_execution_authorized,false);
});

test('an active first-class recovery names its recovery owner rather than the failed assignee',async()=>{
  const f=fixture();f.issues.get(30).activeRecoveryAction={id:id(400),status:'active',companyId:id(1),sourceIssueId:id(30),
    ownerType:'agent',ownerAgentId:id(128),nextAction:'Fix the adapter and resume review.',evidence:{latestRunErrorCode:'adapter_failed'}};
  const p=await f.project();
  assert.equal(p.next_automatic_job.owner_name,'Owner 28');
  assert.equal(p.next_automatic_job.recovery_action_id,id(400));
  assert.equal(p.next_automatic_job.latest_failure_code,'adapter_failed');
  assert.equal(p.next_automatic_job.recovery_action,'Fix the adapter and resume review.');
  assert.equal(p.next_automatic_job.worker.state,'NOT_OBSERVED');
});
