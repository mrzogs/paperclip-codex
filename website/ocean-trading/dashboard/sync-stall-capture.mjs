import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {STALL_LIMITS} from './sync-stall-watchdog.mjs';
import {SYNC_CATALOGUE_SHA256} from './sync-stall-catalogue.mjs';
import {createSyncMarkers,installSyncMarkers,STALL_SHARED_BYTES,stallViews,CONTROL} from './sync-stall-markers.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const keys=['schema_version','enabled','expected_source_commit','expected_manifest_sha256','expires_at_utc','duration_ms'];
export function validateStallCaptureConfig(raw,environment,now=Date.now()){
  if(!Buffer.isBuffer(raw)||raw.length>8192||!raw.length)throw Error('CONFIG_INVALID');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(raw),config=JSON.parse(text);
  const names=[...text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match=>JSON.parse(match[1]));
  if(!config||Array.isArray(config)||names.length!==keys.length||new Set(names).size!==keys.length
    ||Object.keys(config).sort().join('|')!==[...keys].sort().join('|')||config.schema_version!=='ocean-sync-stall-capture/v1'
    ||config.enabled!==true||!/^[a-f0-9]{40}$/i.test(config.expected_source_commit||'')
    ||!validHash(config.expected_manifest_sha256)||config.expected_source_commit!==environment.OCEAN_DEPLOYMENT_SOURCE_COMMIT
    ||config.expected_manifest_sha256!==environment.OCEAN_DEPLOYMENT_MANIFEST_SHA256
    ||!Number.isSafeInteger(config.duration_ms)||config.duration_ms<=0||config.duration_ms>STALL_LIMITS.max_window_ms
    ||typeof config.expires_at_utc!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(config.expires_at_utc))throw Error('CONFIG_INVALID');
  const expiry=Date.parse(config.expires_at_utc);
  if(!Number.isFinite(expiry)||new Date(expiry).toISOString().slice(0,19)!==config.expires_at_utc.slice(0,19)
    ||expiry<=now||expiry>now+STALL_LIMITS.max_window_ms)throw Error('CONFIG_INVALID');
  return Object.freeze({...config,config_sha256:hash(raw),catalogue_sha256:SYNC_CATALOGUE_SHA256,
    window_ms:Math.min(config.duration_ms,expiry-now),expires_at_ms:expiry});
}
export async function readStallCaptureConfig(root,{signal}={}){
  const check=()=>{if(signal?.aborted)throw Error('CONFIG_CANCELLED');};
  if(typeof root!=='string'||root.length>1024||!path.isAbsolute(root)||root.startsWith('\\\\'))throw Error('CONFIG_INVALID');
  root=path.resolve(root);
  let depth=0;
  for(let current=root;;current=path.dirname(current)){
    check();if(++depth>32||(await fs.lstat(current)).isSymbolicLink())throw Error('CONFIG_INVALID');if(path.dirname(current)===current)break;
  }
  check();
  if(await fs.realpath(root)!==root)throw Error('CONFIG_INVALID');
  check();
  const file=path.join(root,'sync-stall-capture.json'),named=await fs.lstat(file);
  if(!named.isFile()||named.isSymbolicLink()||named.size<=0||named.size>8192)throw Error('CONFIG_INVALID');
  check();
  const fd=await fs.open(file,'r');
  try{
    check();
    const before=await fd.stat();if(!before.isFile()||before.ino!==named.ino||before.size!==named.size)throw Error('CONFIG_INVALID');
    const raw=Buffer.alloc(before.size);let offset=0;
    while(offset<raw.length){check();const result=await fd.read(raw,offset,raw.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
    check();
    const after=await fd.stat();check();const last=await fs.lstat(file);check();
    if(offset!==raw.length||after.size!==before.size||after.mtimeMs!==before.mtimeMs||last.ino!==before.ino
      ||last.mtimeMs!==before.mtimeMs||last.isSymbolicLink())throw Error('CONFIG_INVALID');
    return raw;
  }finally{await fd.close();}
}
export const fixedStallWorkerOptions=data=>({
  workerData:data,env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2},
});
const makeWorker=data=>new Worker(new URL('./sync-stall-worker.mjs',import.meta.url),fixedStallWorkerOptions(data));
const states=new Set(['ARMED','PENDING','CLOSED','OUTPUT_PARTIAL','OUTPUT_FAILED','OUTPUT_EXISTS','DISABLED_OUTPUT','BUDGET_EXHAUSTED']);

export function createStallCaptureStartup({readConfig=readStallCaptureConfig,workerFactory=makeWorker,
  allocate=()=>new SharedArrayBuffer(STALL_SHARED_BYTES),now=Date.now,nowNs=()=>process.hrtime.bigint(),
  onState=()=>{},setQuantObserver=()=>{},decisionMs=1000}={}){
  let initialization=null,worker=null,markers=null,heartbeat=null,current='DISABLED',stopping=false,workerClosed=false,workerFailed=false,configPending=false,captureDeadline=null,captureExpiry=0,startupAbort=null;
  const state=value=>{if(current===value&&value!=='DISABLED')return;current=value;try{onState(value);}catch{}};
  const disable=()=>{markers?.stop();installSyncMarkers(null);try{setQuantObserver(null);}catch{}if(heartbeat)clearInterval(heartbeat);heartbeat=null;};
  const api={
    start(environment){
      if(initialization)return initialization;
      initialization=(async()=>{
        if(stopping||!environment.OCEAN_WEBSITE_CONTROL_ROOT){state('DISABLED');return api;}
        let raw,timer;const configAbort=startupAbort=new AbortController(),decisionDeadline=nowNs()+BigInt(Math.max(1,Math.min(1000,decisionMs)))*1000000n;
        // Underlying config I/O remains owned by this one startup promise. A
        // logical timeout latches OFF; a late successful read cannot activate.
        configPending=true;
        const pending=Promise.resolve().then(()=>readConfig(environment.OCEAN_WEBSITE_CONTROL_ROOT,{signal:configAbort.signal}));
        void pending.then(()=>{configPending=false;},()=>{configPending=false;});
        try{raw=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONFIG_DECISION_TIMEOUT')),Math.min(1000,decisionMs));})]);}
        catch{configAbort.abort();state('DISABLED');return api;}finally{clearTimeout(timer);}
        let config;
        try{if(nowNs()>=decisionDeadline)throw Error();config=validateStallCaptureConfig(raw,environment,now());if(stopping||nowNs()>=decisionDeadline)throw Error();}
        catch{state('DISABLED');return api;}
        try{
          if(nowNs()>=decisionDeadline)throw Error();
          const shared=allocate();
          const start=now(),startNs=nowNs();
          const windowMs=Math.min(config.duration_ms,config.expires_at_ms-start,STALL_LIMITS.max_window_ms);
          if(windowMs<=0)throw Error();
          const header={version:'ocean-sync-stall-capture/v1',source_commit:config.expected_source_commit,
            manifest_sha256:config.expected_manifest_sha256,config_sha256:config.config_sha256,catalogue_sha256:config.catalogue_sha256,
            pid:process.pid,process_started_at_utc:new Date(start-process.uptime()*1000).toISOString(),
            capture_started_at_utc:new Date(start).toISOString(),expires_at_utc:config.expires_at_utc,window_ms:windowMs};
          captureDeadline=startNs+BigInt(windowMs)*1000000n;captureExpiry=config.expires_at_ms;
          markers=createSyncMarkers(shared,nowNs,{deadlineNs:captureDeadline,expiresAtMs:captureExpiry,nowUtc:now});installSyncMarkers(markers);
          if(nowNs()>=decisionDeadline)throw Error();
          worker=workerFactory({root:path.resolve(environment.OCEAN_WEBSITE_CONTROL_ROOT),shared,header,
            deadline_ns:captureDeadline,expires_at_ms:captureExpiry});
          const ownedWorker=worker;
          worker.on('message',message=>{
            if(worker!==ownedWorker)return;
            if(!states.has(message?.state))return;
            if(message.state==='ARMED'&&(stopping||workerClosed||workerFailed||nowNs()>=captureDeadline||now()>=captureExpiry)){
              disable();state('PENDING');try{worker.postMessage({type:'STOP'});}catch{}return;
            }
            if(message.state==='CLOSED')workerClosed=true;
            if(message.state!=='ARMED')disable();state(message.state);
          });
          worker.on('error',()=>{workerFailed=true;disable();state('PENDING');});
          worker.on('exit',()=>{workerFailed=true;disable();state(workerClosed?'CLOSED':'FAILED');worker=null;});
          worker.unref();
          setQuantObserver((code,work)=>markers.mark(code,work));
          heartbeat=setInterval(()=>{
            if(markers.expired()){
              disable();state('PENDING');try{ownedWorker.postMessage({type:'STOP'});}catch{}
            }else if(Atomics.load(stallViews(shared).control,CONTROL.STOP))disable();else markers.heartbeat();
          },STALL_LIMITS.poll_ms);
          heartbeat.unref?.();
        }catch{disable();if(worker)try{worker.postMessage({type:'STOP'});}catch{}state(worker?'PENDING':'DISABLED');}
        return api;
      })();return initialization;
    },
    stop(){stopping=true;startupAbort?.abort();disable();if(worker||configPending){state('PENDING');try{worker?.postMessage({type:'STOP'});}catch{/* retained; no replacement */}}},
    status(){return {state:current,pending:worker!==null,config_pending:configPending,stopping};},
  };return api;
}
let singleton=null;
export function initializeSyncStallCapture(environment,options){singleton ||= createStallCaptureStartup(options);return singleton.start(environment);}
export function stopSyncStallCapture(){singleton?.stop();}
