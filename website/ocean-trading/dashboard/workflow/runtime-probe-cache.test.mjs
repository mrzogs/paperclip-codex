import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {createRuntimeProbeCache} from './runtime-probe-cache.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const unavailable=(_input,state)=>({state});

test('slow subprocess observation is single-flight and leaves the event loop responsive',async()=>{
  let calls=0,completed=false;
  const probe=createRuntimeProbeCache({unavailable,observe:()=>new Promise((resolve,reject)=>{
    calls++;execFile(process.execPath,['-e','setTimeout(()=>console.log("observed"),100)'],{windowsHide:true},(error,stdout)=>{
      completed=true;if(error)reject(error);else resolve({state:'VERIFIED',value:stdout.trim()});
    });
  })});
  const input={executable:'fixture'};
  assert.equal(probe(input).state,'STATUS_CHECK_PENDING');
  for(let i=0;i<10;i++)assert.equal(probe(input).state,'STATUS_CHECK_PENDING');
  await settle();
  assert.equal(calls,1);assert.equal(completed,false);
  while(!completed)await new Promise(resolve=>setTimeout(resolve,10));
  await settle();assert.deepEqual(probe(input),{state:'VERIFIED',value:'observed'});
});

test('expired and failed observations withdraw verified state and retry without blocking',async()=>{
  let time=1000,calls=0,fail=false;
  const probe=createRuntimeProbeCache({now:()=>time,refreshMs:50,maxAgeMs:100,unavailable,observe:async()=>{
    calls++;if(fail)throw Error('unavailable');return {state:'VERIFIED'};
  }});
  probe({});await settle();assert.equal(probe({}).state,'VERIFIED');assert.equal(calls,1);
  time+=101;fail=true;assert.equal(probe({}).state,'STATUS_CHECK_PENDING');
  await settle();assert.equal(probe({}).state,'STATUS_UNAVAILABLE');assert.equal(calls,2);
  fail=false;time+=51;probe({});await settle();assert.equal(probe({}).state,'VERIFIED');assert.equal(calls,3);
});

test('a changed instance cannot inherit the prior instance observation',async()=>{
  const probe=createRuntimeProbeCache({unavailable,observe:async input=>({state:'VERIFIED',instance:input.instance})});
  probe({instance:'one'});await settle();assert.equal(probe({instance:'one'}).instance,'one');
  assert.equal(probe({instance:'two'}).state,'STATUS_CHECK_PENDING');
  await settle();assert.equal(probe({instance:'two'}).instance,'two');
});
