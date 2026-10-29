import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {canonical,digest,requireThat} from './common.mjs';
import {createVwapBoundedArtifactReader} from './vwap-bounded-artifacts.mjs';

export const VWAP_SEMANTIC_DESCRIPTOR='ocean-vwap-discovery-semantic-config/v1';
export const VWAP_SEMANTIC_BOOTSTRAP=fileURLToPath(new URL('./vwap-discovery-semantic-bootstrap.py',import.meta.url));
export const VWAP_SEMANTIC_ROOT=String.raw`C:\Users\wayne\OneDrive\Documents\Brady - Optimization`;
export const VWAP_SEMANTIC_PYTHON=String.raw`D:\Codex\artifacts\cicd-vwap-pull-back-strategy\implementation-20261029\venv\Scripts\python.exe`;
const PROJECT='cicd-vwap-pull-back-strategy',DOMAIN='trading-strategy',HASH=/^[a-f0-9]{64}$/i;
const INDEX=String.raw`onboarding\contracts\vwap-improvement-v1\contract-index.json`;
const check=(condition,code)=>requireThat(condition,409,'VWAP_SEMANTIC_'+code);
const sha=bytes=>digest(bytes).slice(7).toUpperCase();
const prefixed=value=>'sha256:'+value.toLowerCase();
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
function json(bytes){const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));check(value&&typeof value==='object'&&!Array.isArray(value),'JSON_OBJECT_REQUIRED');return value;}
function read(reader,ref){check(exact(ref,['id','path','sha256','byte_length'])&&typeof ref.id==='string'&&ref.id&&HASH.test(ref.sha256||'')&&Number.isSafeInteger(ref.byte_length)&&ref.byte_length>0,'REFERENCE_INVALID');return reader.read({...ref,sha256:prefixed(ref.sha256)}).bytes;}
function pins(descriptorPath,expectedHash){
  check(HASH.test(expectedHash||'')&&typeof descriptorPath==='string'&&path.isAbsolute(descriptorPath),'DESCRIPTOR_PIN_REQUIRED');
  const reader=createVwapBoundedArtifactReader({maxArtifactBytes:32*1024*1024,maxTotalArtifactBytes:64*1024*1024,codePrefix:'VWAP_SEMANTIC_'});
  const descriptorBytes=reader.read({path:descriptorPath,sha256:prefixed(expectedHash)}).bytes;
  check(descriptorBytes.length<=262144,'DESCRIPTOR_SIZE_LIMIT');
  const d=json(descriptorBytes);
  check(exact(d,['schema_version','project','domain','project_root','execution_class','fixture_clock_utc','python','bootstrap_sha256','modules','contract_index','w0_package','hmm_decoder','policy','evidence_root','output_root','baseline_sha256','config_sha256','limits'])
    &&d.schema_version===VWAP_SEMANTIC_DESCRIPTOR&&d.project===PROJECT&&d.domain===DOMAIN&&d.project_root===VWAP_SEMANTIC_ROOT,'DESCRIPTOR_SCOPE_INVALID');
  check(['AUTHENTICATED_SYSTEM','SOFTWARE_CONTRACT_TEST'].includes(d.execution_class),'EXECUTION_CLASS_INVALID');
  check(d.execution_class==='SOFTWARE_CONTRACT_TEST'||!Object.hasOwn(d,'fixture_clock_utc'),'PRODUCTION_CLOCK_OVERRIDE_REJECTED');
  check(exact(d.python,['path','sha256'])&&d.python.path===VWAP_SEMANTIC_PYTHON&&HASH.test(d.python.sha256||''),'PYTHON_IDENTITY_INVALID');
  reader.read({path:d.python.path,sha256:prefixed(d.python.sha256)});
  check(HASH.test(d.bootstrap_sha256||''),'BOOTSTRAP_PIN_REQUIRED');reader.read({path:VWAP_SEMANTIC_BOOTSTRAP,sha256:prefixed(d.bootstrap_sha256)});
  check(typeof d.evidence_root==='string'&&path.isAbsolute(d.evidence_root)&&typeof d.output_root==='string'&&path.isAbsolute(d.output_root)
    &&inside(d.evidence_root,d.output_root)&&!inside(d.evidence_root,descriptorPath),'OPERATOR_PATH_BOUNDARY_INVALID');
  check(HASH.test(d.baseline_sha256||'')&&HASH.test(d.config_sha256||''),'ACTIVE_BINDINGS_REQUIRED');
  check(exact(d.limits,['timeout_ms','stdout_bytes','stderr_bytes','evidence_bytes'])&&Number.isSafeInteger(d.limits.timeout_ms)&&d.limits.timeout_ms>0&&d.limits.timeout_ms<=120000
    &&Number.isSafeInteger(d.limits.stdout_bytes)&&d.limits.stdout_bytes>=1024&&d.limits.stdout_bytes<=65536
    &&Number.isSafeInteger(d.limits.stderr_bytes)&&d.limits.stderr_bytes>0&&d.limits.stderr_bytes<=65536
    &&Number.isSafeInteger(d.limits.evidence_bytes)&&d.limits.evidence_bytes>0&&d.limits.evidence_bytes<=128*1024*1024,'LIMITS_INVALID');
  check(Array.isArray(d.modules)&&d.modules.length>=4&&d.modules.length<=32,'MODULE_PINS_REQUIRED');
  const names=new Set();
  for(const module of d.modules){check(exact(module,['module','relative_path','sha256','byte_length'])&&/^scripts\.[a-z][a-z0-9_]*$/.test(module.module||'')
      &&module.relative_path==='scripts\\'+module.module.slice(8)+'.py'&&!names.has(module.module),'MODULE_PATH_INVALID');
    names.add(module.module);read(reader,{id:module.module,path:path.join(VWAP_SEMANTIC_ROOT,module.relative_path),sha256:module.sha256,byte_length:module.byte_length});}
  check(['scripts.vwap_discovery_intake','scripts.vwap_improvement_contracts','scripts.vwap_improvement_proofs','scripts.vwap_discovery_pack_builder'].every(name=>names.has(name)),'MODULE_CLOSURE_INCOMPLETE');
  check(d.contract_index?.path===path.join(VWAP_SEMANTIC_ROOT,INDEX),'CONTRACT_INDEX_PATH_INVALID');
  const index=json(read(reader,d.contract_index));
  check(index.schema_version==='cicd-vwap-contract-index/v1'&&index.project_id===PROJECT&&index.domain===DOMAIN&&Array.isArray(index.schemas)&&index.schemas.length===21,'CONTRACT_INDEX_INVALID');
  const contracts=new Set();
  for(const ref of index.schemas){check(typeof ref.path==='string'&&/^[a-z0-9-]+\.schema\.json$/.test(ref.path)&&!contracts.has(ref.path),'CONTRACT_REFERENCE_INVALID');contracts.add(ref.path);
    read(reader,{id:ref.id,path:path.join(path.dirname(d.contract_index.path),ref.path),sha256:ref.sha256,byte_length:ref.byte_length});}
  check(inside(VWAP_SEMANTIC_ROOT,d.w0_package?.path||''),'W0_PACKAGE_PATH_INVALID');read(reader,d.w0_package);
  check(!inside(d.evidence_root,d.policy?.path||'')&&d.policy?.path!==d.evidence_root,'POLICY_MUST_BE_INDEPENDENT');
  const policy=json(read(reader,d.policy));
  check(policy.strategy_id===PROJECT&&policy.domain===DOMAIN&&policy.project_root===VWAP_SEMANTIC_ROOT&&policy.evidence_class===(d.execution_class==='AUTHENTICATED_SYSTEM'?'AUTHENTICATED_SYSTEM':'SYNTHETIC'),'POLICY_SCOPE_INVALID');
  check(d.hmm_decoder?.path===String.raw`D:\Codex\artifacts\cicd-vwap-pull-back-strategy\implementation-20261029\toolchain\hmm-sidecar-v2\oql_hmm_sidecar_inspect.exe`,'DECODER_PATH_INVALID');
  read(reader,d.hmm_decoder);
  const packageSha=sha(Buffer.from(canonical({python:d.python,bootstrap_sha256:d.bootstrap_sha256,modules:d.modules,contract_index:d.contract_index,w0_package:d.w0_package,hmm_decoder:d.hmm_decoder})));
  return {descriptor:freeze(d),descriptorBytes,packageSha};
}

/** Owner-pinned operator configuration only. No report/API input may select
 * interpreter, source, policy, code, output directory or arbitrary arguments. */
export function createVwapDiscoverySemanticAdapter({descriptorPath,expectedDescriptorSha256}={}){
  const initial=pins(descriptorPath,expectedDescriptorSha256),d=initial.descriptor;
  const admissionBinding=freeze({evidence_root:d.evidence_root,trust_policy_file:d.policy.path,trust_policy_sha256:d.policy.sha256.toUpperCase(),
    baseline_sha256:d.baseline_sha256.toUpperCase(),config_sha256:d.config_sha256.toUpperCase()});
  const verify=async request=>{
    check(exact(request,['pack_ref','expected'])&&exact(request.expected,['manifest_sha256','run_id','source_sha256','config_sha256','learning_rows_sha256'])
      &&typeof request.expected.run_id==='string'&&request.expected.run_id&&request.expected.run_id.length<=256
      &&['manifest_sha256','source_sha256','config_sha256','learning_rows_sha256'].every(key=>HASH.test(request.expected[key]||'')),'REQUEST_INVALID');
    check(request.expected.source_sha256.toUpperCase()===admissionBinding.baseline_sha256&&request.expected.config_sha256.toUpperCase()===admissionBinding.config_sha256,'ACTIVE_BINDING_CONFLICT');
    const current=pins(descriptorPath,expectedDescriptorSha256);check(current.packageSha===initial.packageSha,'SOURCE_PACKAGE_CHANGED');
    const inputReader=createVwapBoundedArtifactReader({root:d.evidence_root,maxArtifactBytes:32*1024*1024,maxTotalArtifactBytes:d.limits.evidence_bytes,codePrefix:'VWAP_SEMANTIC_'});
    read(inputReader,request.pack_ref);
    const stdin=JSON.stringify(request);check(Buffer.byteLength(stdin)<=16384,'REQUEST_BYTE_LIMIT');
    const env={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(d.python.path,['-I','-B','-S',VWAP_SEMANTIC_BOOTSTRAP,'--descriptor',descriptorPath,'--descriptor-sha256',expectedDescriptorSha256.toUpperCase()],
        {shell:false,windowsHide:true,cwd:VWAP_SEMANTIC_ROOT,env,stdio:['pipe','pipe','pipe']});
      let stdout=[],stderr=[],outBytes=0,errBytes=0,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
      const fail=code=>{child.kill();finish(Object.assign(new Error('VWAP_SEMANTIC_'+code),{code:'VWAP_SEMANTIC_'+code}));};
      const timer=setTimeout(()=>fail('TIMEOUT'),d.limits.timeout_ms);timer.unref?.();
      child.stdout.on('data',bytes=>{outBytes+=bytes.length;if(outBytes>d.limits.stdout_bytes)fail('STDOUT_LIMIT');else stdout.push(bytes);});
      child.stderr.on('data',bytes=>{errBytes+=bytes.length;if(errBytes>d.limits.stderr_bytes)fail('STDERR_LIMIT');else stderr.push(bytes);});
      child.on('error',()=>fail('SPAWN_FAILED'));child.stdin.on('error',()=>{});
      child.on('close',code=>{if(code!==0)return finish(Object.assign(new Error('VWAP_SEMANTIC_BOOTSTRAP_REJECTED'),{code:'VWAP_SEMANTIC_BOOTSTRAP_REJECTED'}));
        try{finish(null,json(Buffer.concat(stdout)));}catch{fail('BOOTSTRAP_RESPONSE_INVALID');}});
      child.stdin.end(stdin);
    });
    check(result.schema_version==='ocean-vwap-discovery-semantic-result/v1'&&result.intake_package_sha256===initial.packageSha,'RESPONSE_PACKAGE_CONFLICT');
    check(pins(descriptorPath,expectedDescriptorSha256).packageSha===initial.packageSha,'SOURCE_PACKAGE_CHANGED');
    const outputReader=createVwapBoundedArtifactReader({root:d.output_root,maxArtifactBytes:32*1024*1024,maxTotalArtifactBytes:d.limits.evidence_bytes,codePrefix:'VWAP_SEMANTIC_'});
    const report=json(read(outputReader,result.report_ref));
    check(report.strategy_id===PROJECT&&report.domain===DOMAIN&&report.project_root===VWAP_SEMANTIC_ROOT&&report.run_id===request.expected.run_id
      &&report.manifest_sha256?.toUpperCase()===request.expected.manifest_sha256.toUpperCase()
      &&report.pack_artifact?.sha256?.toUpperCase()===request.pack_ref.sha256.toUpperCase()
      &&report.source_binding?.source_sha256?.toUpperCase()===admissionBinding.baseline_sha256&&report.source_binding?.config_sha256?.toUpperCase()===admissionBinding.config_sha256,'REPORT_BINDING_CONFLICT');
    if(result.learning_rows_ref){const learning=json(read(outputReader,result.learning_rows_ref));
      check(report.learning_rows_artifact?.sha256?.toUpperCase()===result.learning_rows_ref.sha256&&learning.strategy_id===PROJECT&&learning.run_id===request.expected.run_id
        &&report.learning_rows_sha256?.toUpperCase()===request.expected.learning_rows_sha256.toUpperCase(),'LEARNING_BINDING_CONFLICT');}
    check(result.pack_sha256===request.pack_ref.sha256.toUpperCase()&&result.manifest_sha256===request.expected.manifest_sha256.toUpperCase()
      &&result.learning_rows_sha256===report.learning_rows_sha256?.toUpperCase(),'RESPONSE_IDENTITY_CONFLICT');
    if(d.execution_class==='AUTHENTICATED_SYSTEM')check(result.verified===true&&result.qualified===true&&result.status==='QUALIFIED_DISCOVERY'&&report.status===result.status&&report.eligible_for_candidate_selection===true,'ADMISSION_DENIED');
    else check(result.verified===false&&result.qualified===false&&result.status==='SOFTWARE_FIXTURE_VALIDATED'&&report.status===result.status,'SOFTWARE_CANNOT_QUALIFY');
    return freeze(result);
  };
  Object.defineProperties(verify,{admissionBinding:{value:admissionBinding,enumerable:true},intakePackageSha256:{value:initial.packageSha,enumerable:true}});
  return Object.freeze(verify);
}
