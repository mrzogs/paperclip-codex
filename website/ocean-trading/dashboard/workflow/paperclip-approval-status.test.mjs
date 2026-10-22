import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichStrategyApprovalStatuses, readPaperclipApprovalStatus } from './paperclip-approval-status.mjs';
import { loadVwapPhysicalComparatorApprovalDispatchConfig } from './vwap-physical-comparator-approval-dispatch.mjs';
import { readVwapPhysicalComparatorContract } from './vwap-physical-comparator-contract.mjs';
const config=loadVwapPhysicalComparatorApprovalDispatchConfig(), comparator=readVwapPhysicalComparatorContract();
const company=config.paperclip.company_id, id=comparator.required_human_approvals[0].approval_id;
const binding={strategy_id:comparator.strategy_id,namespace:comparator.namespace,contract_id:comparator.contract_id,
  contract_hash:comparator.contract_hash,context_hash:comparator.run_context.context_hash,run_id:comparator.run_context.run_id,decision_scope:'DATASET_PHYSICAL_SELECTION'};
const reference={approval_id:id,expected_company_id:company,expected_payload:binding};
const reply=(status='approved',changes={})=>new Response(JSON.stringify({id,companyId:company,type:'request_board_approval',status,
  payload:{...binding,title:'Exact comparator',secret:'must-not-leak'},...changes}),{status:200});
for(const status of ['approved','pending','revision_requested','rejected','cancelled']) {
  test(`verified ${status} requires matching company and binding`,async()=>{
    const result=await readPaperclipApprovalStatus(reference,{fetchImpl:async(url,options)=>{
      assert.ok(url.endsWith(`/api/approvals/${id}`)); assert.equal(options.method,'GET'); assert.equal(options.cache,'no-store');
      assert.equal(options.headers.Authorization,undefined,'do not borrow privileged credentials'); return reply(status);
    }});
    assert.equal(result.status,status.toUpperCase()); assert.equal(result.authoritative,true);
    assert.equal(result.action_required,['pending','revision_requested'].includes(status));
    assert.equal(result.expected_contract_hash,binding.contract_hash); assert.equal(JSON.stringify(result).includes('must-not-leak'),false);
  });
}
for(const [httpStatus,expected] of [[401,'SCOPED_ACCESS_DENIED'],[403,'SCOPED_ACCESS_DENIED'],[404,'UNAVAILABLE'],[503,'UNAVAILABLE']]) {
  test(`HTTP ${httpStatus} never grants approval authority`,async()=>{
    const result=await readPaperclipApprovalStatus(reference,{fetchImpl:async()=>new Response('{}',{status:httpStatus})});
    assert.equal(result.status,expected); assert.equal(result.http_status,httpStatus); assert.equal(result.authoritative,false); assert.equal(result.action_required,false);
  });
}
test('company, contract, context, scope and output changes fail closed',async()=>{
  for(const changes of [{companyId:'another-company'},...Object.keys(binding).map(key=>({payload:{...binding,[key]:'changed'}}))]) {
    const result=await readPaperclipApprovalStatus(reference,{fetchImpl:async()=>reply('approved',changes)});
    assert.equal(result.status,changes.companyId?'COMPANY_MISMATCH':'CONTRACT_MISMATCH'); assert.equal(result.authoritative,false);
  }
  const result=await readPaperclipApprovalStatus({...reference,expected_payload:{...binding,output_root:'expected'}},{fetchImpl:async()=>reply()});
  assert.equal(result.status,'CONTRACT_MISMATCH');
});
test('missing expected company cannot authenticate an approval',async()=>{
  const result=await readPaperclipApprovalStatus({approval_id:id},{fetchImpl:async()=>reply()}); assert.equal(result.authoritative,false);
});
test('refresh reads live statuses and preserves program and runtime boundaries',async()=>{
  const view={marker:'preserved',onboarding:{continuous_delivery:{autonomous_improvement:{state:'AVAILABLE',next_action:'Source PASS; physical gates pending',required_human_approvals:[]},physical_comparator:comparator}}};
  let status='pending',calls=0;
  const fetchImpl=async url=>{
    calls++; const approvalId=url.split('/').at(-1),ref=comparator.required_human_approvals.find(item=>item.approval_id===approvalId);
    return reply(status,{id:approvalId,payload:{...binding,decision_scope:ref.decision_scope,
      ...(ref.decision_scope==='RUN_RELEASE'?{output_root:config.staging_authority.continuation.run_release_output_root}:{})}});
  };
  const first=await enrichStrategyApprovalStatuses(view,{fetchImpl}); status='approved'; const second=await enrichStrategyApprovalStatuses(view,{fetchImpl});
  assert.equal(calls,4);
  assert.deepEqual(first.onboarding.continuous_delivery.physical_comparator.required_human_approvals.map(x=>x.status),['PENDING','PENDING']);
  assert.deepEqual(second.onboarding.continuous_delivery.physical_comparator.required_human_approvals.map(x=>x.status),['APPROVED','APPROVED']);
  assert.equal(second.marker,'preserved'); assert.equal(second.onboarding.continuous_delivery.autonomous_improvement.next_action,view.onboarding.continuous_delivery.autonomous_improvement.next_action);
  assert.equal(second.onboarding.continuous_delivery.physical_comparator.safety.replay_start_authorized,false);
});
