import assert from 'node:assert/strict';
import test from 'node:test';
import {planVwapEngineeringContinuity,reconcileVwapEngineeringContinuity} from './vwap-engineering-continuity.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture() {
  const config={strategy_id:'cicd-vwap-pull-back-strategy',paperclip:{company_id:id(1)}};
  const executorIssue={id:id(28),identifier:'OCEA-28',status:'in_progress',updatedAt:'2026-10-20T20:30:00Z',
    assigneeAgentId:id(128),executionRunId:id(300),blockedBy:[]};
  const stagingAuthority={approval_id:id(200),approval_status:'APPROVED',updated_at_utc:'2026-10-20T20:00:00Z'};
  const continuity={next_automatic_job:{issue_id:executorIssue.id,worker:{state:'FINISHED_NOT_DELIVERABLE_PROOF',status:'failed',run_id:id(300)}}};
  const requests=[];
  const getJson=async route=>{requests.push({method:'GET',route});return {id:id(128),companyId:id(1),name:'Mara'};};
  const postJson=async(route,body)=>{requests.push({method:'POST',route,body});return {id:id(400),agentId:executorIssue.assigneeAgentId,
    status:'queued',startedAt:null,contextSnapshot:{issueId:body.payload.issueId,wakeReason:body.reason}};};
  return {config,executorIssue,stagingAuthority,continuity,requests,getJson,postJson};
}

test('a failed exact run wakes the current owner once without any trading authority',async()=>{
  const f=fixture();
  const first=await reconcileVwapEngineeringContinuity(f);
  assert.equal(first.state,'WAKE_QUEUED');
  assert.equal(first.wake_run_id,id(400));
  const post=f.requests.find(item=>item.method==='POST');
  assert.match(post.route,new RegExp('/agents/'+id(128)+'/wakeup'));
  assert.equal(post.body.payload.issueId,id(28));
  assert.equal(post.body.payload.tradePollingRequired,false);
  for(const key of ['runtimeExecutionAuthorized','replayPlaybackAuthorized','paperAuthorized','liveAuthorized','realOrdersAuthorized'])
    assert.equal(post.body.payload[key],false);
  const repeated=planVwapEngineeringContinuity({...f,previous:first});
  assert.equal(repeated.state,'WAKE_ALREADY_RECORDED');
  assert.equal(repeated.wake_required,false);
});

test('owner and approval transitions create new exact events and route only the new owner',async()=>{
  const f=fixture();
  const prior=await reconcileVwapEngineeringContinuity(f);
  f.executorIssue.assigneeAgentId=id(129);f.executorIssue.updatedAt='2026-10-20T20:31:00Z';
  f.getJson=async route=>({id:id(129),companyId:id(1),name:'New owner'});
  f.postJson=async(route,body)=>({id:id(401),agentId:id(129),status:'running',startedAt:'2026-10-20T20:31:01Z',
    contextSnapshot:{issueId:body.payload.issueId,wakeReason:body.reason}});
  const reassigned=await reconcileVwapEngineeringContinuity({...f,previous:prior});
  assert.equal(reassigned.state,'WAKE_STARTED');
  assert.equal(reassigned.owner_agent_id,id(129));
  f.stagingAuthority={...f.stagingAuthority,approval_status:'PENDING',updated_at_utc:'2026-10-20T20:32:00Z'};
  const waiting=planVwapEngineeringContinuity({...f,previous:reassigned});
  assert.equal(waiting.state,'OWNER_WAKE_REQUIRED');
  assert.equal(waiting.wake_required,true);
  assert.notEqual(waiting.event_key,reassigned.event_key);
});

test('a pending physical Stage decision does not stall failed source engineering work',async()=>{
  const f=fixture();
  f.executorIssue.status='in_progress';
  f.stagingAuthority.approval_status='PENDING';
  const result=await reconcileVwapEngineeringContinuity(f);
  assert.equal(result.state,'WAKE_QUEUED');
  assert.equal(result.approval_status,'PENDING');
  const wake=f.requests.find(item=>item.method==='POST');
  assert.equal(wake.body.payload.action,'CONTINUE_EXACT_ENGINEERING_ISSUE_OR_OPEN_TYPED_RECOVERY');
  assert.equal(wake.body.payload.runtimeExecutionAuthorized,false);
  assert.equal(wake.body.payload.replayPlaybackAuthorized,false);
  assert.equal(wake.body.payload.paperAuthorized,false);
  assert.equal(wake.body.payload.liveAuthorized,false);
});

test('active work, scheduled retry, recovery and unresolved blockers suppress duplicate wakes',()=>{
  for(const [patch,continuityPatch,expected] of [
    [{}, {next_automatic_job:{issue_id:id(28),worker:{state:'RUNNING_VERIFIED',status:'running'}}}, 'RUNNING_VERIFIED'],
    [{scheduledRetry:{runId:id(500),scheduledRetryAt:'2026-10-20T20:40:00Z'}}, null, 'SCHEDULED_RETRY'],
    [{activeRecoveryAction:{id:id(600),status:'active'}}, null, 'ACTIVE_RECOVERY'],
    [{blockedBy:[{id:id(77)}]}, {next_automatic_job:null,other_ready_jobs:[]}, 'BLOCKED_BY_PREREQUISITE'],
  ]) {
    const f=fixture();Object.assign(f.executorIssue,patch);if(continuityPatch)f.continuity=continuityPatch;
    const plan=planVwapEngineeringContinuity(f);
    assert.equal(plan.state,expected);assert.equal(plan.wake_required,false);
  }
});
