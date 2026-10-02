import fs from 'node:fs';
import assert from 'node:assert/strict';
import { digest, sealedHash } from './common.mjs';

export const UI_STRATEGIES = ['vwap_wave_pullback_balanced_nasdaq_v0434','test-price-action'];
export const UI_INSTANCES = ['test-ui-vwap-instance','test-ui-pa-instance'];
export const UI_TESTS = ['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'];

export async function createUiFixture(base, environment, {instanceOverrides={},authorizedTests=UI_TESTS}={}) {
  const examples = JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url),'utf8'));
  let sequence = 0;
  const id = prefix => `test-fixture-${prefix}-${++sequence}`;
  const response = await fetch(`${base}/api/workflow/session`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({credential:environment.OCEAN_WAYNE_BROWSER_SECRET})});
  assert.equal(response.status,200); const session = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  async function call(route,{data,role='HUMAN',expected=200,method=data ? 'POST' : 'GET',headers={}}={}) {
    const auth = role === 'HUMAN' ? {Cookie:cookie,Origin:base,'X-CSRF-Token':session.csrf_token} : role ? {Authorization:`Bearer ${environment[`OCEAN_${role}_TOKEN`]}`} : {};
    const r = await fetch(`${base}/api/workflow/${route}`,{method,headers:{...auth,...(data ? {'Content-Type':'application/json'}:{}),...headers},body:data ? JSON.stringify({message_id:id('message'),data}) : undefined,signal:AbortSignal.timeout(15000)});
    const value = await r.json();
    for (const key of ['OCEAN_BRAIN_TOKEN','OCEAN_TELEMETRY_TOKEN','OCEAN_STRATEGY_TOKEN']) assert.ok(!JSON.stringify(value).includes(environment[key]),'service credential leak');
    if(Array.isArray(expected)){assert.ok(expected.includes(r.status),`${route}: ${JSON.stringify(value)}`);return {status:r.status,value};}
    assert.equal(r.status,expected,`${route}: ${JSON.stringify(value)}`); return value;
  }
  const change = async (caseId,fields,role='HUMAN') => call('transitions',{data:{case_id:caseId,expected_revision:(await call(`cases/${caseId}`)).revision,...fields},role});
  const artifact = async (caseId,kind,fields={},role='BRAIN') => {
    const row = await call(`cases/${caseId}`); const payload = fields.payload || {kind,status:'PASS',candidate_hash:row.candidate_hash};
    const content = fields.content || JSON.stringify(payload);
    const data = {artifact_id:id('artifact'),case_id:caseId,run_id:row.run_id,recipient_id:'ocean-ui-strategy',kind,media_type:'application/json',content,content_hash:digest(content),candidate_hash:row.candidate_hash,dependency_ids:[],...fields};
    delete data.payload; return call('artifacts',{data,role});
  };
  const registered=[];
  for (let index=0;index<2;index++) {
    const strategy=UI_STRATEGIES[index];
    const profile={...structuredClone(examples['strategy-profile']),strategy_id:strategy,profile_id:`test-ui-profile-${index}`}; profile.profile_hash=sealedHash(profile,'profile_hash');
    const registry={...structuredClone(examples['strategy-registry']),strategy_id:strategy,strategy_name:index ? 'Price Action / S21 test' : 'VWAP Wave Pullback / S21 test',profile_id:profile.profile_id,profile_version:profile.profile_version,profile_hash:profile.profile_hash,activation_status:'PENDING_ONBOARDING',activation_decision_id:null,production_version:null,execution_instances:[]};
    const instance={execution_instance_id:UI_INSTANCES[index],strategy_id:strategy,source_installation_id:`test-ui-installation-${index}`,chartbook_id:`test-ui-chartbook-${index}`,chart_id:`test-ui-chart-${index}`,source_study_instance_id:`test-ui-study-${index}`,telemetry_producer_id:'ocean-ui-telemetry',version_binding:profile.baseline_version,config_hash:profile.strategy_config_hash,account_alias:`Sim${index+1}`,capabilities:['REPLAY'],status:'DRAFT',lease_run_id:null,...instanceOverrides[index]};
    const dataset={...structuredClone(examples['dataset-manifest']),dataset_manifest_id:`test-ui-dataset-${index}`}; dataset.manifest_hash=sealedHash(dataset,'manifest_hash');
    await call('profiles',{data:{profile,file_sha256:digest(JSON.stringify(profile))}});
    await call('strategies',{data:{registry,baseline_hash:profile.strategy_code_hash}});
    await call('instances',{data:{strategy_id:strategy,instance}});
    await call('datasets',{data:{strategy_id:strategy,manifest:dataset}});
    const context={...structuredClone(examples['run-context']),strategy_id:strategy,run_id:`test-ui-run-${index}`,execution_instance_id:instance.execution_instance_id,source_installation_id:instance.source_installation_id,strategy_version:instance.version_binding,strategy_code_hash:profile.strategy_code_hash,strategy_config_hash:instance.config_hash,strategy_profile_id:profile.profile_id,strategy_profile_version:profile.profile_version,dataset_manifest_id:dataset.dataset_manifest_id,dataset_manifest_revision:dataset.revision,dataset_manifest_hash:dataset.manifest_hash,expected_environment:'REPLAY',evidence_purpose:'NOT_ELIGIBLE',historical_build_mode:null};
    delete context.learner_permission; delete context.permission_reason; delete context.context_hash;
    const run=await call('runs',{data:{context}}); registered.push({profile,registry,instance,dataset,run});
  }
  async function review(caseId,index=0) {
    const row=await call('cases',{data:{case_id:caseId,run_id:registered[index].run.context.run_id}});
    await change(row.case_id,{action:'advance',to_stage:'EVIDENCE'});
    const evidence=await artifact(row.case_id,'EVIDENCE',{payload:{eligible_unique_trades:18,eligible_sessions:3,materiality:'Small synthetic sample',uncertainty:'High',positive_findings:['Observed test improvement'],negative_findings:['Unproven outside fixture'],provenance:'S21 synthetic fixture; library-reference:test-evidence-1'}});
    await change(row.case_id,{action:'advance',to_stage:'RESEARCH',artifact_id:evidence.manifest.artifact_id});
    const recommendation=await artifact(row.case_id,'RECOMMENDATION',{media_type:'text/markdown',content:'# Synthetic recommendation\n\nReview the existing candidate test plan.\n\nPositive: observed fixture behaviour.\nNegative: small sample, no operational evidence.\nRisk: all cases are TEST only.\n'});
    await change(row.case_id,{action:'advance',to_stage:'DEVELOPMENT_REVIEW',artifact_id:recommendation.manifest.artifact_id});
    const approval=await call('approvals',{role:'BRAIN',data:{request_id:id('request'),case_id:caseId,expected_revision:(await call(`cases/${caseId}`)).revision,gate:'DEVELOPMENT',artifact_id:recommendation.manifest.artifact_id,recipient_id:'ocean-ui-strategy',authorized_tests:authorizedTests,expires_at_utc:new Date(Date.now()+3600000).toISOString()}});
    return {caseId,approval,evidence,recommendation};
  }
  const primary=await review('test-ui-review-vwap');
  const secondary=await review('test-ui-pa-historical',1);
  const decision=await call('decisions',{data:{decision_id:id('decision'),case_id:secondary.caseId,request_id:secondary.approval.request_id,expected_revision:(await call(`cases/${secondary.caseId}`)).revision,snapshot_hash:secondary.approval.snapshot_hash,decision:'APPROVED',reason:'S21 synthetic seed; no strategy authority'}});
  await change(secondary.caseId,{action:'advance',to_stage:'DEVELOPMENT_HANDOFF',decision_id:decision.decision_id});
  const handoff=await call('handoffs',{data:{handoff_id:id('handoff'),case_id:secondary.caseId,decision_id:decision.decision_id,gate:'DEVELOPMENT',recipient_id:'ocean-ui-strategy',authorized_test:'BACKTEST'}});
  let revision=1;
  for(const state of ['READY','DISPATCHED','ACKNOWLEDGED']) await call('handoff-events',{role:state === 'ACKNOWLEDGED'?'STRATEGY':'HUMAN',data:{handoff_id:handoff.handoff_id,expected_revision:revision++,state}});
  await change(secondary.caseId,{action:'advance',to_stage:'CANDIDATE_DEVELOPMENT'},'STRATEGY');
  const candidate=await artifact(secondary.caseId,'CANDIDATE',{candidate_hash:digest('S21 synthetic candidate'),dependency_ids:[secondary.recommendation.manifest.artifact_id]},'STRATEGY');
  await change(secondary.caseId,{action:'advance',to_stage:'HISTORICAL_VALIDATION',artifact_id:candidate.manifest.artifact_id},'STRATEGY');
  const historicalCase=await call(`cases/${secondary.caseId}`);
  for (const [kind,status] of [['BACKTEST','PASS'],['ROBUSTNESS','FAIL'],['WALK_FORWARD','BLOCKED']]) {
    const report=await artifact(secondary.caseId,kind,{payload:{status,candidate_hash:historicalCase.candidate_hash}},'STRATEGY');
    await call('tasks',{role:'STRATEGY',data:{case_id:secondary.caseId,expected_revision:(await call(`cases/${secondary.caseId}`)).revision,kind,status,artifact_id:report.manifest.artifact_id}});
  }
  await change(secondary.caseId,{action:'block',owner_id:'ocean-ui-strategy',next_action:'Review failed robustness result'},'STRATEGY');
  await call('health',{role:'TELEMETRY',data:{strategy_id:UI_STRATEGIES[0],instance_id:UI_INSTANCES[0],status:'READY',next_owner:'ocean-ui-telemetry',next_action:'Await provider binding S23'}});
  return {call,change,artifact,review,registered,primary,secondary,id,examples};
}
