import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {digest} from './common.mjs';
import {createVwapDiscoverySemanticAdapter,VWAP_SEMANTIC_BOOTSTRAP,VWAP_SEMANTIC_PYTHON} from './vwap-discovery-semantic-adapter.mjs';

const sha=bytes=>digest(bytes).slice(7).toUpperCase();
const available=process.platform==='win32'&&fs.existsSync(VWAP_SEMANTIC_PYTHON);
function fixture(t,invalid=false){
  const base=path.join(os.tmpdir(),'ocean-semantic-fixture-'+randomUUID());
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const script=fileURLToPath(new URL('./fixtures/vwap-semantic-fixture.py',import.meta.url));
  const child=cp.spawnSync(VWAP_SEMANTIC_PYTHON,['-I','-B','-S',script,base,VWAP_SEMANTIC_BOOTSTRAP,...(invalid?['--invalid-semantic']:[])],
    {encoding:'utf8',timeout:60000,maxBuffer:65536,windowsHide:true,shell:false});
  assert.equal(child.status,0,child.stderr||child.stdout);
  const meta=JSON.parse(fs.readFileSync(path.join(base,'fixture-metadata.json'),'utf8'));
  assert.equal(meta.custody_signature_count_verified,6);assert.equal(meta.private_keys_exported,false);
  const descriptor=JSON.parse(fs.readFileSync(meta.descriptor.path));
  let serial=0;
  const configured=mutate=>{
    const next=structuredClone(descriptor);mutate?.(next);
    const file=path.join(base,'operator',`variant-${serial++}.json`),bytes=JSON.stringify(next);fs.writeFileSync(file,bytes);
    return createVwapDiscoverySemanticAdapter({descriptorPath:file,expectedDescriptorSha256:sha(bytes)});
  };
  return {base,meta,descriptor,configured};
}

test('bootstrap aggregate clamp reaches the original reader before allocation and preserves stricter caps',{skip:!available},()=>{
  const script=fileURLToPath(new URL('./fixtures/vwap-semantic-fixture.py',import.meta.url));
  const child=cp.spawnSync(VWAP_SEMANTIC_PYTHON,['-I','-B','-S',script,'--budget-contract',VWAP_SEMANTIC_BOOTSTRAP],
    {encoding:'utf8',timeout:10000,maxBuffer:1024,windowsHide:true,shell:false});
  assert.equal(child.status,0,child.stderr||child.stdout);
  assert.deepEqual(JSON.parse(child.stdout),{classification:'SOFTWARE_CONTRACT_TEST',read_limits:[3,7],calls_after_exhaustion:2});
});

test('actual retained Python intake and all six test RSA receipts validate software only and yield the event loop',{skip:!available},async t=>{
  const f=fixture(t),adapter=f.configured();let yielded=false;setTimeout(()=>{yielded=true;},0);
  const result=await adapter(f.meta.request);
  assert.equal(yielded,true);assert.equal(result.verified,false);assert.equal(result.qualified,false);assert.equal(result.status,'SOFTWARE_FIXTURE_VALIDATED');
  assert.equal(result.pack_sha256,f.meta.request.pack_ref.sha256);assert.equal(result.manifest_sha256,f.meta.request.expected.manifest_sha256);
  assert.ok(Object.isFrozen(adapter.admissionBinding));assert.equal(adapter.admissionBinding.baseline_sha256,f.descriptor.baseline_sha256);
  for(const ref of [result.report_ref,result.learning_rows_ref]){const bytes=fs.readFileSync(ref.path);assert.equal(sha(bytes),ref.sha256);assert.equal(bytes.length,ref.byte_length);}
  const report=JSON.parse(fs.readFileSync(result.report_ref.path));assert.equal(report.verified_originals.length,8);
  assert.equal(report.eligible_for_candidate_selection,false);assert.equal(report.learning_rows_sha256,result.learning_rows_sha256);
});

test('valid six-purpose custody cannot hide invalid economics semantics',{skip:!available},async t=>{
  const f=fixture(t,true);
  await assert.rejects(f.configured()(f.meta.request),{code:'VWAP_SEMANTIC_BOOTSTRAP_REJECTED'});
});

test('operator pins reject arbitrary executable/code/policy/output, source/index drift and production test clocks',{skip:!available},t=>{
  const f=fixture(t);
  for(const mutate of [
    d=>{d.python.path=process.execPath;},d=>{d.python.sha256='0'.repeat(64);},d=>{d.bootstrap_path='C:\\arbitrary.py';},
    d=>{d.modules[0].relative_path='scripts\\test_arbitrary.py';},d=>{d.modules[0].sha256='0'.repeat(64);},
    d=>{d.contract_index.sha256='0'.repeat(64);},d=>{d.w0_package.sha256='0'.repeat(64);},
    d=>{d.output_root=path.dirname(d.evidence_root);},d=>{d.hmm_decoder.path=process.execPath;},
    d=>{d.execution_class='AUTHENTICATED_SYSTEM';},d=>{d.execution_class='AUTHENTICATED_SYSTEM';delete d.fixture_clock_utc;},
  ])assert.throws(()=>f.configured(mutate));
  assert.throws(()=>createVwapDiscoverySemanticAdapter({descriptorPath:f.meta.descriptor.path,expectedDescriptorSha256:'0'.repeat(64)}));
  const policyPath=path.join(f.base,'operator','wrong-project-policy.json'),policy=JSON.parse(fs.readFileSync(f.descriptor.policy.path));policy.strategy_id='other';
  const raw=JSON.stringify(policy);fs.writeFileSync(policyPath,raw);
  assert.throws(()=>f.configured(d=>{d.policy={id:'other-policy',path:policyPath,sha256:sha(raw),byte_length:Buffer.byteLength(raw)};}));
});

test('report input cannot select operator paths/clock/code, mismatched identity or tampered originals',{skip:!available},async t=>{
  const f=fixture(t),adapter=f.configured();
  await assert.rejects(adapter({...f.meta.request,output_root:'C:\\arbitrary'}),/REQUEST_INVALID/);
  await assert.rejects(adapter({...f.meta.request,expected:{...f.meta.request.expected,config_sha256:'F'.repeat(64)}}),/ACTIVE_BINDING_CONFLICT/);
  await assert.rejects(adapter({...f.meta.request,pack_ref:{...f.meta.request.pack_ref,sha256:'F'.repeat(64)}}));
  const pack=JSON.parse(fs.readFileSync(f.meta.request.pack_ref.path)),economic=pack.originals.find(ref=>ref.role==='economics');
  fs.appendFileSync(path.resolve(f.descriptor.evidence_root,economic.path),' ');
  await assert.rejects(adapter(f.meta.request),{code:'VWAP_SEMANTIC_BOOTSTRAP_REJECTED'});
});

test('software mode verifies actual RSA signatures and cannot accept recomputed invalid signature bytes',{skip:!available},async t=>{
  const f=fixture(t),pack=JSON.parse(fs.readFileSync(f.meta.request.pack_ref.path)),ref=pack.custody_receipts[0],file=path.resolve(f.descriptor.evidence_root,ref.path);
  const envelope=JSON.parse(fs.readFileSync(file));envelope.signature.value='AAAA';const raw=JSON.stringify(envelope);fs.writeFileSync(file,raw);
  ref.sha256=sha(raw);ref.byte_length=Buffer.byteLength(raw);
  const packRaw=JSON.stringify(pack);fs.writeFileSync(f.meta.request.pack_ref.path,packRaw);
  const request=structuredClone(f.meta.request);request.pack_ref.sha256=sha(packRaw);request.pack_ref.byte_length=Buffer.byteLength(packRaw);
  await assert.rejects(f.configured()(request),{code:'VWAP_SEMANTIC_BOOTSTRAP_REJECTED'});
});

test('actual child timeout and stdout budget are bounded',{skip:!available},async t=>{
  const f=fixture(t);
  await assert.rejects(f.configured(d=>{d.limits.timeout_ms=1;})(f.meta.request),{code:'VWAP_SEMANTIC_TIMEOUT'});
  await assert.rejects(f.configured(d=>{d.limits.stdout_bytes=1024;})(f.meta.request),{code:'VWAP_SEMANTIC_STDOUT_LIMIT'});
  await assert.rejects(f.configured(d=>{d.limits.evidence_bytes=4000;})(f.meta.request));
});

test('synthetic pipe-budget double proves fixed argv/environment and caps stderr without arbitrary execution',{skip:!available},async t=>{
  const f=fixture(t),adapter=f.configured(),original=cp.spawn;let killed=false;
  cp.spawn=(exe,argv,options)=>{
    assert.equal(exe,VWAP_SEMANTIC_PYTHON);assert.deepEqual(argv.slice(0,4),['-I','-B','-S',VWAP_SEMANTIC_BOOTSTRAP]);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.ok(Object.keys(options.env).every(key=>['SystemRoot','WINDIR','TEMP','TMP'].includes(key)));
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{killed=true;return true;};queueMicrotask(()=>child.stderr.write(Buffer.alloc(8193,120)));return child;
  };
  syncBuiltinESMExports();
  try{await assert.rejects(adapter(f.meta.request),{code:'VWAP_SEMANTIC_STDERR_LIMIT'});assert.equal(killed,true);}
  finally{cp.spawn=original;syncBuiltinESMExports();}
});
