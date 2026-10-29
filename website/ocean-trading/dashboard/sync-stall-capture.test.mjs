import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createSyncMarkers,stallViews,readStallSnapshot,CONTROL,markSync,markTimingSync,installSyncMarkers} from './sync-stall-markers.mjs';
import {SYNC_OP,SYNC_CATALOGUE_SHA256} from './sync-stall-catalogue.mjs';
import {createStallWatchdog,createStallWriteBudget,STALL_LIMITS} from './sync-stall-watchdog.mjs';
import {createStallCaptureStartup,validateStallCaptureConfig,readStallCaptureConfig,fixedStallWorkerOptions} from './sync-stall-capture.mjs';
import {openStallOutput} from './sync-stall-output.mjs';
import {runStallWorker} from './sync-stall-worker.mjs';
import {observeSync,setSyncObserver,QUANT_SYNC} from './quant-terminal/lib/sync-observer.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const now=Date.parse('2026-10-29T12:00:00.000Z');
const environment={OCEAN_WEBSITE_CONTROL_ROOT:path.resolve(os.tmpdir(),'SOFTWARE_CONTROL_ROOT'),
  OCEAN_DEPLOYMENT_SOURCE_COMMIT:'a'.repeat(40),OCEAN_DEPLOYMENT_MANIFEST_SHA256:'b'.repeat(64)};
const config=()=>({schema_version:'ocean-sync-stall-capture/v1',enabled:true,expected_source_commit:environment.OCEAN_DEPLOYMENT_SOURCE_COMMIT,
  expected_manifest_sha256:environment.OCEAN_DEPLOYMENT_MANIFEST_SHA256,expires_at_utc:new Date(now+1800000).toISOString(),duration_ms:1800000});
const bytes=value=>Buffer.from(JSON.stringify(value));
class SoftwareWorker extends EventEmitter{unref(){}postMessage(value){this.message=value;}}
function shared(){return new SharedArrayBuffer(8192);}

test('default/OFF/invalid configuration allocates no shared memory or worker and observes one fixed state',async()=>{
  for(const raw of [null,bytes({...config(),enabled:false}),bytes({...config(),expected_source_commit:'c'.repeat(40)}),bytes({...config(),duration_ms:1800001}),
    bytes({...config(),expires_at_utc:new Date(now-1).toISOString()}),Buffer.from('{bad')]){
    let reads=0,allocations=0,workers=0;const states=[];
    const startup=createStallCaptureStartup({now:()=>now,readConfig:async()=>{reads++;if(raw===null)throw Error('PRIVATE_PATH');return raw;},
      allocate:()=>{allocations++;return shared();},workerFactory:()=>{workers++;return new SoftwareWorker();},onState:value=>states.push(value)});
    await startup.start(environment);await startup.start(environment);assert.equal(reads,1);assert.equal(allocations,0);assert.equal(workers,0);assert.deepEqual(states,['DISABLED']);
  }
  let read=false;const startup=createStallCaptureStartup({readConfig:()=>{read=true;},onState:()=>{}});await startup.start({});assert.equal(read,false);
});

test('strict source/manifest/window binding and exact raw configuration digest survive admission',()=>{
  const raw=Buffer.from(JSON.stringify(config(),null,2)),value=validateStallCaptureConfig(raw,environment,now);
  assert.equal(value.config_sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(value.catalogue_sha256,SYNC_CATALOGUE_SHA256);
  for(const changed of [{...config(),extra:'PRIVATE'},{...config(),expected_manifest_sha256:'c'.repeat(64)},
    {...config(),expires_at_utc:'2026-10-30T00:00:00Z'}, {...config(),duration_ms:null}])assert.throws(()=>validateStallCaptureConfig(bytes(changed),environment,now));
  assert.throws(()=>validateStallCaptureConfig(Buffer.from(JSON.stringify(config()).replace('"enabled":true','"enabled":false,"enabled":true')),environment,now));
  assert.throws(()=>validateStallCaptureConfig(Buffer.alloc(8193),environment,now));
});

test('startup timeout or delayed timer delivery latches OFF and never activates from late config completion',async()=>{
  let complete,allocations=0,workers=0;
  const startup=createStallCaptureStartup({now:()=>now,decisionMs:5,readConfig:()=>new Promise(resolve=>{complete=resolve;}),
    allocate:()=>{allocations++;return shared();},workerFactory:()=>{workers++;return new SoftwareWorker();},onState:()=>{}});
  await startup.start(environment);assert.equal(startup.status().config_pending,true);complete(bytes(config()));await settle();
  assert.equal(startup.status().state,'DISABLED');assert.equal(startup.status().config_pending,false);assert.equal(allocations,0);assert.equal(workers,0);
  let clock=1n;
  const delayed=createStallCaptureStartup({now:()=>now,nowNs:()=>clock,decisionMs:1000,readConfig:async()=>{clock+=1000000001n;return bytes(config());},
    allocate:()=>{allocations++;return shared();},workerFactory:()=>{workers++;return new SoftwareWorker();},onState:()=>{}});
  await delayed.start(environment);assert.equal(allocations,0);assert.equal(workers,0);
});

test('one fixed worker is bound to source/config/process/window; late ARMED/error/stop never rearm or replace it',async()=>{
  let data,count=0,clock=1n;const worker=new SoftwareWorker(),states=[];
  const startup=createStallCaptureStartup({now:()=>now,nowNs:()=>clock,readConfig:async()=>bytes(config()),workerFactory:value=>{data=value;count++;return worker;},onState:value=>states.push(value)});
  await startup.start(environment);assert.equal(data.shared.byteLength,8192);assert.equal(data.header.pid,process.pid);
  assert.equal(data.header.config_sha256,createHash('sha256').update(bytes(config())).digest('hex'));
  assert.equal(data.header.catalogue_sha256,SYNC_CATALOGUE_SHA256);assert.equal(data.header.window_ms,1800000);
  assert.deepEqual(fixedStallWorkerOptions(data).env,{});assert.deepEqual(fixedStallWorkerOptions(data).execArgv,[]);
  assert.equal(fixedStallWorkerOptions(data).resourceLimits.maxOldGenerationSizeMb,32);
  startup.stop();worker.emit('message',{state:'ARMED'});assert.notEqual(startup.status().state,'ARMED');assert.deepEqual(worker.message,{type:'STOP'});
  worker.emit('error',Error('PRIVATE_CREDENTIAL'));assert.equal(startup.status().pending,true);
  await startup.start(environment);assert.equal(count,1);worker.emit('exit',1);assert.equal(startup.status().state,'FAILED');assert.equal(startup.status().pending,false);
  assert.ok(!JSON.stringify(states).includes('PRIVATE'));installSyncMarkers(null);
});

test('stop during configuration and post-error stale messages cannot activate a new worker',async()=>{
  let resolve,allocated=0;const states=[];
  const startup=createStallCaptureStartup({now:()=>now,readConfig:()=>new Promise(done=>{resolve=done;}),
    allocate:()=>{allocated++;return shared();},onState:state=>states.push(state)});
  const pending=startup.start(environment);await settle();startup.stop();assert.equal(startup.status().config_pending,true);
  resolve(bytes(config()));await pending;assert.equal(allocated,0);assert.equal(startup.status().config_pending,false);
  const worker=new SoftwareWorker(),second=createStallCaptureStartup({now:()=>now,readConfig:async()=>bytes(config()),workerFactory:()=>worker,onState:()=>{}});
  await second.start(environment);worker.emit('error',Error('PRIVATE'));worker.emit('message',{state:'ARMED'});
  assert.notEqual(second.status().state,'ARMED');worker.emit('exit',1);worker.emit('message',{state:'ARMED'});
  assert.equal(second.status().state,'FAILED');second.stop();
});

test('config/output aliases are rejected and fixed wx artifact cannot be rearmed across replacement identities',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ocean-stall-software-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'sync-stall-capture.json'),bytes(config()));
  assert.deepEqual(await readStallCaptureConfig(root),bytes(config()));
  const alias=path.join(root,'alias');await fs.symlink(root,alias,'junction');await assert.rejects(readStallCaptureConfig(alias));
  const descriptor=await openStallOutput(root);await descriptor.close();await assert.rejects(openStallOutput(root),error=>error.code==='EEXIST');
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'ocean-stall-alias-software-'));t.after(()=>fs.rm(other,{recursive:true,force:true}));
  await fs.symlink(root,path.join(other,'diagnostics'),'junction');await assert.rejects(openStallOutput(other));
  let opened=false;await assert.rejects(openStallOutput(root,{ended:()=>true,io:{open:()=>{opened=true;}}}));assert.equal(opened,false);
});

test('nested markers preserve receiver/return/exact throw/Promise lifetime and bounded overflow/seqlock reads',async()=>{
  const buffer=shared(),view=stallViews(buffer);Atomics.store(view.control,CONTROL.ARMED,1);
  let clock=1n;const marker=createSyncMarkers(buffer,()=>clock),receiver={value:4};marker.heartbeat();
  const result=marker.mark(SYNC_OP.POLL_INPUT,()=>marker.mark(SYNC_OP.FILE_STAT,()=>{
    const snapshot=readStallSnapshot(buffer,clock);assert.deepEqual(snapshot.frames.map(frame=>frame[0]),[SYNC_OP.POLL_INPUT,SYNC_OP.FILE_STAT]);
    return(function(){return this.value;}).call(receiver);
  }));assert.equal(result,4);assert.equal(Atomics.load(view.control,CONTROL.DEPTH),0);
  const failure=Error('PRIVATE_BODY');assert.throws(()=>marker.mark(SYNC_OP.JSON_READ,()=>{throw failure;}),error=>error===failure);
  let resolve;const pending=new Promise(done=>{resolve=done;});assert.equal(marker.mark(SYNC_OP.JSON_READ,()=>pending),pending);assert.equal(Atomics.load(view.control,CONTROL.DEPTH),0);resolve();await pending;
  const nest=depth=>depth?marker.mark(SYNC_OP.JSON_READ,()=>nest(depth-1)):readStallSnapshot(buffer,clock);
  assert.equal(nest(20).state,'OVERFLOW');assert.equal(Atomics.load(view.control,CONTROL.DEPTH),0);
  Atomics.store(view.control,CONTROL.SEQ,1);assert.equal(readStallSnapshot(buffer,clock).state,'INCONSISTENT');Atomics.store(view.control,CONTROL.SEQ,2);
  installSyncMarkers(marker);assert.equal(markTimingSync('PRIVATE_PATH C:/secret body SQL',()=>7),7);assert.equal(markSync(123456789,()=>8),8);installSyncMarkers(null);
  assert.equal(readStallSnapshot(buffer,clock).recent.some(event=>event[1]===123456789),false);
  setSyncObserver(null);assert.equal(observeSync(QUANT_SYNC.WRITE,()=>9),9);
  setSyncObserver((id,work)=>marker.mark(id,work));assert.equal(observeSync(QUANT_SYNC.WRITE,()=>10),10);setSyncObserver(null);
});

function watchdogFixture(options={}){
  let time=1n;const buffer=shared(),marker=createSyncMarkers(buffer,()=>time),writes=[],states=[];
  const header={window_ms:1800000,source_commit:'a'.repeat(40),manifest_sha256:'b'.repeat(64),config_sha256:'c'.repeat(64),catalogue_sha256:SYNC_CATALOGUE_SHA256,pid:123};
  const watchdog=createStallWatchdog({shared:buffer,header,nowNs:()=>time,write:async data=>{writes.push(Buffer.from(data));return{bytesWritten:data.length};},close:async()=>{},onState:value=>states.push(value),...options});
  return{buffer,marker,writes,states,watchdog,advance:ms=>{time+=BigInt(ms)*1000000n;},now:()=>time};
}
test('watchdog distinguishes its sample gap, unknown main stalls, and unfinished selected scopes without dynamic stacks',async()=>{
  const f=watchdogFixture();f.watchdog.start();await settle();f.marker.heartbeat();f.advance(6000);f.marker.heartbeat();f.watchdog.poll();await settle();
  const first=JSON.parse(f.writes[1]);assert.equal(first.watchdog_sample_gap,true);assert.equal(first.main_heartbeat_stale,false);assert.equal(first.state,'UNKNOWN');
  f.marker.mark(SYNC_OP.CONTROL_RENAME,()=>{f.advance(6000);f.watchdog.poll();});await settle();
  const second=JSON.parse(f.writes[2]);assert.equal(second.main_heartbeat_stale,true);assert.equal(second.frames[0][0],SYNC_OP.CONTROL_RENAME);
  const all=Buffer.concat(f.writes).toString();for(const secret of ['PRIVATE','C:/','Bearer','SQL','function'])assert.ok(!all.includes(secret));
  f.watchdog.stop();await settle();assert.equal(f.watchdog.status().closed,true);
});

test('exact emission/byte bounds charge header and partial/failed write attempts with no retry/backlog',async()=>{
  const f=watchdogFixture();f.watchdog.start();await settle();for(let i=0;i<80;i++){f.advance(5000);f.watchdog.poll();await settle();}
  assert.equal(f.watchdog.status().attempts,64);assert.ok(f.watchdog.status().attempted_bytes<=131072);
  assert.equal(f.watchdog.status().attempted_bytes,f.writes.reduce((sum,value)=>sum+value.length,0));
  const byteBudget=createStallWriteBudget();
  for(let i=0;i<32;i++)assert.equal(byteBudget.reserve(4096),true);
  assert.equal(byteBudget.status().attempted_bytes,131072);assert.equal(byteBudget.reserve(1),false);
  assert.equal(byteBudget.status().attempted_bytes,131072);
  const recordBudget=createStallWriteBudget();assert.equal(recordBudget.reserve(4097),false);assert.equal(recordBudget.status().attempted_bytes,0);
  for(const mode of ['partial','reject','throw']){
    let attempts=0,reserved=0;
    const fault=watchdogFixture({write:buffer=>{attempts++;reserved=buffer.length;if(mode==='throw')throw Error('PRIVATE');if(mode==='reject')return Promise.reject(Error('PRIVATE'));return Promise.resolve({bytesWritten:1});}});
    fault.watchdog.start();await settle();fault.advance(6000);fault.watchdog.poll();await settle();
    assert.equal(attempts,1);assert.equal(fault.watchdog.status().attempted_bytes,reserved);assert.ok(reserved>1);assert.equal(Atomics.load(stallViews(fault.buffer).control,CONTROL.ARMED),0);
  }
});

test('independent deadline stops new work while pending header/close retain ownership and never late-arm',async()=>{
  let writeDone,closeDone,writeSize;
  const f=watchdogFixture({write:buffer=>{writeSize=buffer.length;return new Promise(resolve=>{writeDone=resolve;});},close:()=>new Promise(resolve=>{closeDone=resolve;})});
  f.watchdog.start();assert.equal(f.watchdog.status().pending,true);f.advance(1800001);assert.equal(f.watchdog.poll(),false);
  assert.equal(f.watchdog.status().attempts,1);assert.equal(f.watchdog.status().closed,false);assert.ok(f.states.includes('PENDING'));
  writeDone({bytesWritten:writeSize});await settle();assert.equal(f.watchdog.status().pending,true);assert.equal(f.watchdog.status().closed,false);
  assert.equal(f.states.includes('ARMED'),false);closeDone();await settle();assert.equal(f.watchdog.status().closed,true);
  f.watchdog.poll();assert.equal(f.watchdog.status().attempts,1);
});

test('absolute configuration expiry also rejects late header arming without extending the monotonic window',async()=>{
  let utc=now,complete,size;const states=[],buffer=shared();
  const watchdog=createStallWatchdog({shared:buffer,header:{window_ms:1800000,expires_at_utc:new Date(now+1000).toISOString()},
    nowNs:()=>1n,nowUtc:()=>utc,write:data=>{size=data.length;return new Promise(resolve=>{complete=resolve;});},close:async()=>{},onState:state=>states.push(state)});
  watchdog.start();utc+=1001;complete({bytesWritten:size});await settle();
  assert.equal(states.includes('ARMED'),false);assert.equal(watchdog.poll(),false);assert.equal(watchdog.status().attempts,1);
});

test('marker and heartbeat admissions reject expired work even before a delayed watchdog poll',()=>{
  for(const clockType of ['monotonic','utc']){
    const buffer=shared(),view=stallViews(buffer);let clock=1n,utc=now;
    const marker=createSyncMarkers(buffer,()=>clock,{deadlineNs:1000000001n,expiresAtMs:now+1000,nowUtc:()=>utc});
    Atomics.store(view.control,CONTROL.ARMED,1);marker.heartbeat();
    marker.mark(SYNC_OP.JSON_READ,()=>{
      const entered=Atomics.load(view.control,CONTROL.EVENTS),heartbeats=Atomics.load(view.control,CONTROL.HEARTBEAT);
      if(clockType==='monotonic')clock=1000000001n;else utc+=1000;
      // No watchdog timer has run. Admissions themselves must latch STOP.
      const expected={value:3};assert.equal(marker.mark(SYNC_OP.FILE_STAT,()=>expected),expected);marker.heartbeat();
      assert.equal(Atomics.load(view.control,CONTROL.EVENTS),entered);
      assert.equal(Atomics.load(view.control,CONTROL.HEARTBEAT),heartbeats);
      const error=Error('PRIVATE');assert.throws(()=>marker.mark(SYNC_OP.FILE_STAT,()=>{throw error;}),value=>value===error);
    });
    assert.equal(Atomics.load(view.control,CONTROL.ARMED),0);assert.equal(Atomics.load(view.control,CONTROL.STOP),1);
    assert.equal(Atomics.load(view.control,CONTROL.DEPTH),0);assert.equal(Atomics.load(view.control,CONTROL.EVENTS),1);
    assert.equal(Atomics.load(view.control,CONTROL.SEQ)%2,0);
  }
});

test('independent worker deadline runs during pending open and retains open/close ownership without late output',async()=>{
  for(const clockType of ['monotonic','utc']){
    let clock=1n,utc=now,tick,openDone,closeDone,writes=0,closed=0,scheduled=0,cleared=0;
    const port=new EventEmitter(),states=[],buffer=shared(),view=stallViews(buffer);
    port.postMessage=value=>states.push(value.state);port.close=()=>closed++;
    const pending=runStallWorker({data:{shared:buffer,root:'SOFTWARE_ONLY',header:{window_ms:1000,expires_at_utc:new Date(now+1000).toISOString()},
      deadline_ns:1000000001n,expires_at_ms:now+1000},port,nowNs:()=>clock,nowUtc:()=>utc,
      schedule:callback=>{scheduled++;tick=callback;return 1;},unschedule:()=>cleared++,openOutput:()=>new Promise(resolve=>{openDone=resolve;})});
    assert.equal(scheduled,1);assert.equal(typeof openDone,'function');
    if(clockType==='monotonic')clock=1000000001n;else utc+=1000;
    tick();assert.deepEqual(states,['PENDING']);assert.equal(closed,0);assert.equal(cleared,1);
    assert.equal(Atomics.load(view.control,CONTROL.STOP),1);assert.equal(Atomics.load(view.control,CONTROL.ARMED),0);
    openDone({write:()=>{writes++;},close:()=>new Promise(resolve=>{closeDone=resolve;})});await settle();
    assert.equal(writes,0);assert.equal(typeof closeDone,'function');assert.equal(closed,0);assert.deepEqual(states,['PENDING']);
    closeDone();await pending;assert.deepEqual(states,['PENDING','CLOSED']);assert.equal(closed,1);
  }
});

test('late output opening uses the original absolute window rather than restarting a worker window',async()=>{
  let clock=1n,tick,openDone,writes=0,closes=0;const states=[],buffer=shared(),port=new EventEmitter();
  port.postMessage=value=>states.push(value.state);port.close=()=>{};
  const pending=runStallWorker({data:{shared:buffer,root:'SOFTWARE_ONLY',header:{window_ms:1000,expires_at_utc:new Date(now+1000).toISOString()},
    deadline_ns:1000000001n,expires_at_ms:now+1000},port,nowNs:()=>clock,nowUtc:()=>now,
    schedule:callback=>{tick=callback;return 1;},unschedule:()=>{},openOutput:()=>new Promise(resolve=>{openDone=resolve;})});
  clock=900000001n;openDone({write:async buffer=>{writes++;return{bytesWritten:buffer.length};},close:async()=>{closes++;}});
  await pending;await settle();assert.equal(states.includes('ARMED'),true);assert.equal(writes,1);
  clock=1000000001n;tick();await settle();assert.equal(closes,1);assert.equal(states.at(-1),'CLOSED');assert.equal(writes,1);
});

test('production state observers emit no stderr outside the owned file budget, including failure and close',async t=>{
  const stderr=[];t.mock.method(console,'error',(...values)=>stderr.push(values));
  const off=createStallCaptureStartup();await off.start({});
  const invalid=createStallCaptureStartup({readConfig:async()=>{throw Error('PRIVATE');}});await invalid.start(environment);
  let workers=0;const worker=new SoftwareWorker(),startup=createStallCaptureStartup({now:()=>now,readConfig:async()=>bytes(config()),
    workerFactory:()=>{workers++;return worker;}});
  await startup.start(environment);
  for(const state of ['PENDING','BUDGET_EXHAUSTED','OUTPUT_FAILED','CLOSED'])worker.emit('message',{state});
  worker.emit('error',Error('PRIVATE'));worker.emit('exit',1);startup.stop();
  assert.equal(workers,1);assert.deepEqual(stderr,[]);
  // Existing output is discovered by that one worker after valid admission.
  // It prevents ARM/overwrite/rearm; it does not promise zero allocations.
  const existingWorker=new SoftwareWorker();let allocations=0;
  const existing=createStallCaptureStartup({now:()=>now,readConfig:async()=>bytes(config()),allocate:()=>{allocations++;return shared();},workerFactory:()=>existingWorker});
  await existing.start(environment);existingWorker.emit('message',{state:'OUTPUT_EXISTS'});existingWorker.emit('exit',0);
  await existing.start(environment);assert.equal(allocations,1);assert.notEqual(existing.status().state,'ARMED');assert.deepEqual(stderr,[]);
});

test('standalone Quant observer has no outside imports or allocated host diagnostics by default',()=>{
  const text=fsSync.readFileSync(new URL('./quant-terminal/lib/sync-observer.js',import.meta.url),'utf8');
  assert.ok(!text.includes('import '));assert.ok(!text.includes('SharedArrayBuffer'));assert.ok(!text.includes('Worker'));
  setSyncObserver(null);const expected={value:1};assert.equal(observeSync(QUANT_SYNC.READ,()=>expected),expected);
});

test('actual standalone Quant store keeps exact saved bytes/return behavior under the optional observer',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ocean-quant-stall-software-')),previous=process.env.QT_DATA_DIR;
  process.env.QT_DATA_DIR=root;const store=await import('./quant-terminal/lib/store.js?software-diagnostic-fixture');
  if(previous===undefined)delete process.env.QT_DATA_DIR;else process.env.QT_DATA_DIR=previous;
  t.after(()=>fs.rm(root,{recursive:true,force:true}));t.after(()=>setSyncObserver(null));
  const data={private_value:'PRIVATE_PATH C:/do-not-capture',nested:{unknown:null}};
  assert.equal(store.write('fixture',data),undefined);const before=await fs.readFile(path.join(root,'fixture.json'));
  const buffer=shared(),view=stallViews(buffer);Atomics.store(view.control,CONTROL.ARMED,1);const marker=createSyncMarkers(buffer);
  setSyncObserver((id,work)=>marker.mark(id,work));assert.equal(store.write('fixture',data),undefined);
  assert.deepEqual(await fs.readFile(path.join(root,'fixture.json')),before);assert.deepEqual(store.read('fixture',null),data);
  assert.ok(!JSON.stringify(readStallSnapshot(buffer)).includes('PRIVATE_PATH'));
});
