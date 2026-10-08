import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PLAN_VERSION } from '../website/ocean-trading/dashboard/workflow/operational-proposal-plan.mjs';
import { noSecrets, requireThat } from '../website/ocean-trading/dashboard/workflow/common.mjs';

// One bounded owner-queue pass. Scheduling is an explicit owner service-lifecycle operation.
export async function consumePlanningOnce({api,tokenFile,stateFile,fetch:fetcher=globalThis.fetch}){
  const url=new URL(api);
  requireThat(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && url.pathname==='/',422,'LOOPBACK_OCEAN_API_REQUIRED');
  requireThat(path.isAbsolute(tokenFile) && path.isAbsolute(stateFile) && tokenFile!==stateFile,422,'ABSOLUTE_PRIVATE_WORKER_PATHS_REQUIRED');
  const token=fs.readFileSync(tokenFile,'utf8').trim();
  requireThat(token.startsWith('ocean_service_v1.'),422,'OCEAN_OWNER_CREDENTIAL_REQUIRED');
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8'))
    :{schema_version:PLAN_VERSION,api:url.origin,owner_id:null,work:{}};
  requireThat(state.schema_version===PLAN_VERSION && state.api===url.origin && state.work
    && typeof state.work==='object' && !Array.isArray(state.work),409,'PLANNING_WORKER_STATE_CONFLICT');
  const save=()=>{
    noSecrets(state,{OWNER_TOKEN:token});
    fs.mkdirSync(path.dirname(stateFile),{recursive:true});
    const temporary=`${stateFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(state,null,2),{flag:'wx'});
    fs.renameSync(temporary,stateFile);
  };
  const call=async(route,input)=>{
    const response=await fetcher(`${url.origin}/api/workflow/operational/v1/${route}`,{
      method:input?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:`Bearer ${token}`,...(input?{'Content-Type':'application/json'}:{})},
      ...(input?{body:JSON.stringify(input)}:{})});
    const value=await response.json();
    requireThat(response.ok,response.status,value.error || value.code || 'PLANNING_WORKER_HTTP_REJECTED');
    return value;
  };
  const identity=await call('identity');
  const principal=identity.identity || identity;
  requireThat(principal.namespace==='OPERATIONAL' && principal.role==='BRAIN'
    && ['read','artifact.write','event.write'].every(scope=>principal.scopes?.includes(scope)),403,'PLANNING_WORKER_OWNER_SCOPE_REQUIRED');
  const owner=principal.id || principal.identity_id;
  requireThat(typeof owner==='string' && (!state.owner_id || state.owner_id===owner),409,'PLANNING_WORKER_OWNER_CONFLICT');
  state.owner_id=owner;save();
  const returned=[];
  const resume=async(caseId,work)=>{
    if(work.phase==='CLAIM_PENDING'){
      const claim=await call('proposals/claim',work.input);
      if(claim.lease_until_ms<=Date.now()){work.phase='LEASE_EXPIRED';save();return;}
      work.phase='PLAN_PENDING';
      work.input={message_id:`planning-return-${randomUUID()}`,data:{case_id:caseId,
        expected_revision:claim.revision,support_hash:claim.support_hash,lease_id:claim.lease_id,
        plan:{...claim.template,planning_notes:'Owned worker returned the exact source-bound direction-exclusion planning brief. Execution contracts and acceptance thresholds remain unresolved; no approval, candidate code change or test execution is claimed.'}}};
      save();
    }
    if(work.phase==='PLAN_PENDING'){
      const result=await call('proposals/plans',work.input);
      requireThat(result.planning_complete===true && result.candidate_testing==='NOT_DUE'
        && result.approval_due===false && result.disposition==='DRAFT_FOR_TECHNICAL_REVIEW',409,'PLANNING_WORKER_AUTHORITY_CONFLICT');
      work.phase='RETURNED';work.receipt=result;delete work.input;delete work.error;save();returned.push(result);
    }
  };
  const blocked=[];
  const tryResume=async(caseId,work)=>{
    try{await resume(caseId,work);}catch(error){
      if(['PROPOSAL_LEASE_EXPIRED','PROPOSAL_CAPABILITIES_CHANGED'].includes(error.code))work.phase='LEASE_EXPIRED';
      work.error=String(error.code || 'PLANNING_WORKER_TRANSPORT_INTERRUPTED').slice(0,200);save();
      blocked.push({case_id:caseId,reason:work.error});
    }
  };
  // Replay pending requests before polling: a lost successful response removes work from the queue.
  for(const [caseId,work] of Object.entries(state.work))if(['CLAIM_PENDING','PLAN_PENDING'].includes(work.phase))await tryResume(caseId,work);
  const queue=await call('proposals/work');
  requireThat(queue.schema_version===PLAN_VERSION && queue.owner_id===owner && Array.isArray(queue.items),409,'PLANNING_WORKER_QUEUE_CONFLICT');
  for(const item of queue.items.slice(0,20)){
    if(item.status==='BLOCKED'){blocked.push({case_id:item.case_id,reason:item.blocked_reason});continue;}
    if(!['READY','REVISION_DUE'].includes(item.status)
      || (state.work[item.case_id] && state.work[item.case_id].phase!=='LEASE_EXPIRED' && item.status!=='REVISION_DUE'))continue;
    const work={phase:'CLAIM_PENDING',input:{message_id:`planning-claim-${randomUUID()}`,data:{
      case_id:item.case_id,expected_revision:item.revision,support_hash:item.support_hash}}};
    state.work[item.case_id]=work;save();await tryResume(item.case_id,work);
  }
  return {schema_version:PLAN_VERSION,owner_id:owner,returned,blocked,candidate_testing:'NOT_DUE',approval_due:false};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const values={};
  for(let index=2;index<process.argv.length;index+=2){
    const key=process.argv[index];requireThat(['--api','--token-file','--state-file'].includes(key)
      && !Object.hasOwn(values,key) && process.argv[index+1],422,'PLANNING_WORKER_ARGUMENT_REQUIRED');
    values[key]=process.argv[index+1];
  }
  try{process.stdout.write(`${JSON.stringify(await consumePlanningOnce({api:values['--api'],tokenFile:values['--token-file'],stateFile:values['--state-file']}))}\n`);}
  catch(error){process.stderr.write(`${error.code || 'PLANNING_WORKER_FAILED'}\n`);process.exitCode=1;}
}
