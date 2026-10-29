import { canonical, digest, objectHash, requireThat } from './common.mjs';
import { canonicalVwapProofJson } from './vwap-improvement-proof-verifier.mjs';

export const VWAP_TARGETED_BRAIN_ROUTE='/trading/learning/targeted-candidate-evaluation';
export const VWAP_TARGETED_BRAIN_REQUEST='ocean-targeted-candidate-evaluation-request/v1';
export const VWAP_TARGETED_BRAIN_RESULT='ocean-targeted-candidate-evaluation-result/v1';
export const VWAP_TARGETED_BRAIN_SCHEMA_SHA256='D1CC46A0C0578CBC2CF0C80BCA53A17B64C4CF2CAECD80B372289FC3D53CDBA3';
const PROJECT='cicd-vwap-pull-back-strategy';
const ROOT=String.raw`C:\Users\wayne\OneDrive\Documents\Brady - Optimization`;
const HASH=/^[a-f0-9]{64}$/i;
const bare=value=>String(value||'').replace(/^sha256:/,'').toUpperCase();
const sha=value=>digest(value).slice(7).toUpperCase();
const check=(condition,code)=>requireThat(condition,409,'VWAP_TARGETED_BRAIN_'+code);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const AUTHORITY=Object.freeze({strategy_changed:false,candidate_approved:false,candidate_promoted:false,paper_authorized:false,live_authorized:false,normal_ingestion_enabled:false,runtime_trade_decision_dependency:false});

export class VwapTargetedBrainClient {
  constructor({verifyCompatibility,evidenceBundleProvider,verifyEvidenceBundle,transport,receiverSourceSha256,trustPolicySha256,now=()=>Date.now()}={}){
    this.verifyCompatibility=verifyCompatibility;this.evidenceBundleProvider=evidenceBundleProvider;
    this.verifyEvidenceBundle=verifyEvidenceBundle;this.transport=transport;this.now=now;
    this.receiverSourceSha256=bare(receiverSourceSha256);this.trustPolicySha256=bare(trustPolicySha256);
  }
  async compatibility(){
    check(typeof this.verifyCompatibility==='function'&&typeof this.evidenceBundleProvider==='function'
      &&typeof this.verifyEvidenceBundle==='function'&&typeof this.transport==='function'&&HASH.test(this.receiverSourceSha256)&&HASH.test(this.trustPolicySha256),'COMPATIBILITY_REQUIRED');
    const proof=await this.verifyCompatibility({route:VWAP_TARGETED_BRAIN_ROUTE,schema_version:VWAP_TARGETED_BRAIN_REQUEST,schema_sha256:VWAP_TARGETED_BRAIN_SCHEMA_SHA256,
      deployed_source_sha256:this.receiverSourceSha256,trust_policy_sha256:this.trustPolicySha256});
    check(proof?.verified===true&&proof.route===VWAP_TARGETED_BRAIN_ROUTE&&proof.schema_version===VWAP_TARGETED_BRAIN_REQUEST
      &&bare(proof.schema_sha256)===VWAP_TARGETED_BRAIN_SCHEMA_SHA256&&bare(proof.deployed_source_sha256)===this.receiverSourceSha256
      &&bare(proof.trust_policy_sha256)===this.trustPolicySha256&&proof.project===PROJECT&&proof.domain==='trading-strategy'&&proof.project_root===ROOT
      &&proof.authentication?.scope==='TRADING'&&proof.authentication?.credential_source==='OCEAN_OPERATIONAL_LEARNING_BRAIN_TOKEN_FILE'
      &&typeof proof.authentication?.principal_id==='string'&&proof.authentication.principal_id
      &&Array.isArray(proof.authentication.strategy_ids)&&proof.authentication.strategy_ids.length===1&&proof.authentication.strategy_ids[0]===PROJECT
      &&Number.isFinite(Date.parse(proof.verified_at_utc))&&Date.parse(proof.verified_at_utc)<=this.now()
      &&this.now()-Date.parse(proof.verified_at_utc)<=15*60*1000&&Date.parse(proof.expires_at_utc)>this.now(),'COMPATIBILITY_UNPROVEN');
    return proof;
  }
  validateRequest(request,context){
    check(exact(request,['schema_version','project','domain','strategy_id','case_id','job_id','candidate_sha256','baseline_sha256','config_sha256','protocol_sha256','plan_sha256','assessment_sha256','artifacts','receipts']), 'REQUEST_SCHEMA_INVALID');
    check(request.schema_version===VWAP_TARGETED_BRAIN_REQUEST&&request.project===PROJECT&&request.strategy_id===PROJECT&&request.domain==='trading-strategy'
      &&request.job_id===context.job.id&&request.case_id===context.snapshot.case.case_id
      &&request.candidate_sha256===bare(context.snapshot.case.candidate_hash)&&request.baseline_sha256===bare(context.snapshot.case.baseline_hash),'REQUEST_SCOPE_CONFLICT');
    const hashKeys=['candidate_sha256','baseline_sha256','config_sha256','protocol_sha256','plan_sha256','assessment_sha256'];
    check(hashKeys.every(key=>HASH.test(request[key]))&&request.candidate_sha256!==request.baseline_sha256,'REQUEST_HASH_INVALID');
    check(typeof request.job_id==='string'&&request.job_id.length>0&&request.job_id.length<=200&&typeof request.case_id==='string'&&request.case_id.length>0&&request.case_id.length<=200,'REQUEST_ID_INVALID');
    check(Array.isArray(request.artifacts)&&request.artifacts.length>=5&&request.artifacts.length<=256&&Array.isArray(request.receipts)&&request.receipts.length>=8&&request.receipts.length<=1024,'BUNDLE_REQUIRED');
    check(Buffer.byteLength(canonicalVwapProofJson(request))<=8000000,'REQUEST_BYTE_LIMIT');
    const ids=new Set(),hashes=new Set(),originals=new Map();let total=0;
    for(const item of [...request.artifacts,...request.receipts]){
      check(exact(item,['artifact_id','content_json','sha256'])&&typeof item.artifact_id==='string'&&item.artifact_id.length>0&&item.artifact_id.length<=200
        &&typeof item.content_json==='string'&&item.content_json.length>=2&&item.content_json.length<=1000000&&HASH.test(item.sha256),'ARTIFACT_SCHEMA_INVALID');
      const bytes=Buffer.byteLength(item.content_json);total+=bytes;
      check(bytes<=1000000&&total<=8000000&&!ids.has(item.artifact_id)&&!hashes.has(item.sha256.toUpperCase())&&sha(item.content_json)===item.sha256.toUpperCase(),'ARTIFACT_INTEGRITY_CONFLICT');
      ids.add(item.artifact_id);hashes.add(item.sha256.toUpperCase());
      let value;try{value=JSON.parse(item.content_json);}catch{check(false,'ARTIFACT_JSON_INVALID');}
      check(value&&typeof value==='object'&&!Array.isArray(value),'ARTIFACT_JSON_INVALID');
      if(request.artifacts.includes(item))originals.set(item.sha256.toUpperCase(),value);
      else check(value.schema_version==='cicd-vwap-signed-proof/v1'&&value.payload&&value.signature,'SIGNED_RECEIPT_REQUIRED');
    }
    const plan=JSON.parse(context.snapshot.validation_plan.content_json).targeted_replay.plan;
    check(objectHash(originals.get(request.plan_sha256))===objectHash(plan),'PLAN_ORIGINAL_CONFLICT');
    const assessment=originals.get(request.assessment_sha256),protocol=originals.get(request.protocol_sha256);
    check(protocol&&assessment?.schema_version==='vwap-targeted-evaluation-assessment/v1'&&assessment.verdict==='PASS'
      &&objectHash(assessment.ocean_assessment)===objectHash(context.effective.targeted_assessment),'ASSESSMENT_MATH_CONFLICT');
    check(hashKeys.slice(0,5).every(key=>assessment[key]===request[key]&&assessment.bindings?.[key]===request[key]),'ASSESSMENT_BINDING_CONFLICT');
    check(objectHash(assessment.window_ids)===objectHash([...plan.cases,...plan.independent_windows].map(window=>window.case_id||window.window_id)),'WINDOW_COVERAGE_CONFLICT');
    check(objectHash(assessment.evidence_artifact_sha256)===objectHash([...originals.keys()].filter(hash=>hash!==request.assessment_sha256).sort()),'ASSESSMENT_SOURCE_COVERAGE_CONFLICT');
    const adapterBindings=context.effective.targeted_physical_evidence?.adapter_bindings;
    check(Array.isArray(adapterBindings)&&adapterBindings.length===4&&adapterBindings.every(binding=>bare(binding.cost_model_sha256)&&bare(binding.protocol_sha256)===request.protocol_sha256),'CURRENT_PHYSICAL_EVIDENCE_REQUIRED');
    const configs=new Set(plan.cases.concat(plan.independent_windows).map(window=>bare(window.config_sha256)));
    check(configs.size===1&&configs.has(request.config_sha256),'CURRENT_CONFIG_CONFLICT');
    const terminals=adapterBindings.flatMap(binding=>binding.physical_runs.map(run=>bare(run.terminal_receipt_sha256))).sort();
    check(objectHash(assessment.terminal_receipt_sha256)===objectHash(terminals),'CURRENT_TERMINAL_COVERAGE_CONFLICT');
    return request;
  }
  async prepare(context){
    const compatibility=await this.compatibility();
    check(context.effective?.conclusion==='BENEFIT_SUPPORTED'&&context.effective.targeted_physical_evidence?.verified===true,'CURRENT_PHYSICAL_EVIDENCE_REQUIRED');
    const supplied=await this.evidenceBundleProvider(structuredClone(context));
    const request=this.validateRequest(structuredClone(supplied),context);
    const admitted=await this.verifyEvidenceBundle({request:structuredClone(request),context:structuredClone(context)});
    check(admitted?.verified===true&&bare(admitted.trust_policy_sha256)===bare(compatibility.trust_policy_sha256)
      &&admitted.assessment_sha256===request.assessment_sha256&&admitted.input_sha256===sha(canonicalVwapProofJson(request)),'LOCAL_BUNDLE_AUTHENTICATION_REQUIRED');
    return request;
  }
  verifyResponse(response,request,policySha256){
    check(exact(response,['schema_version','record_id','input_sha256','content_sha256','content_json','relative_path','conclusion_type','admission','trust_policy_sha256','authority','readback_verified']),'RESPONSE_SCHEMA_INVALID');
    const input=sha(canonicalVwapProofJson(request));let content;try{content=JSON.parse(response.content_json);}catch{check(false,'RESPONSE_JSON_INVALID');}
    check(response.schema_version===VWAP_TARGETED_BRAIN_RESULT&&response.input_sha256===input&&response.record_id===`TARGETED-EVALUATION-${input}`
      &&response.relative_path===`evidence/targeted-evaluations/${PROJECT}/records/${input.slice(0,24)}.md`
      &&typeof response.content_json==='string'&&Buffer.byteLength(response.content_json)<=9000000&&sha(response.content_json)===response.content_sha256
      &&response.conclusion_type==='BENEFIT_SUPPORTED'&&response.readback_verified===true&&bare(response.trust_policy_sha256)===bare(policySha256)
      &&objectHash(response.authority)===objectHash(AUTHORITY)&&exact(content,['schema_version','request','admission','trust_policy_sha256','authority'])&&content.schema_version==='brain-targeted-evaluation-content/v1'
      &&objectHash(content.request)===objectHash(request)&&objectHash(content.admission)===objectHash(response.admission)
      &&bare(content.trust_policy_sha256)===bare(policySha256)&&objectHash(content.authority)===objectHash(AUTHORITY)
      &&response.admission?.verdict==='PASS'&&response.admission.window_count===JSON.parse(request.artifacts.find(item=>item.sha256===request.plan_sha256).content_json).cases.length
        +JSON.parse(request.artifacts.find(item=>item.sha256===request.plan_sha256).content_json).independent_windows.length
      &&response.admission.physical_run_count===response.admission.window_count*2
      &&objectHash(response.admission.artifact_sha256)===objectHash(request.artifacts.map(item=>item.sha256.toUpperCase()).sort())
      &&objectHash(response.admission.receipt_sha256)===objectHash(request.receipts.map(item=>item.sha256.toUpperCase()).sort()),'RESPONSE_BINDING_CONFLICT');
    return response;
  }
  async exchange(request,context){
    const compatibility=await this.compatibility();this.validateRequest(request,context);
    const admitted=await this.verifyEvidenceBundle({request:structuredClone(request),context:structuredClone(context)});
    check(admitted?.verified===true&&bare(admitted.trust_policy_sha256)===bare(compatibility.trust_policy_sha256)
      &&admitted.assessment_sha256===request.assessment_sha256&&admitted.input_sha256===sha(canonicalVwapProofJson(request)),'LOCAL_BUNDLE_AUTHENTICATION_REQUIRED');
    const response=await this.transport({route:VWAP_TARGETED_BRAIN_ROUTE,request:structuredClone(request),principal_id:compatibility.authentication.principal_id});
    return this.verifyResponse(response,request,compatibility.trust_policy_sha256);
  }
}
