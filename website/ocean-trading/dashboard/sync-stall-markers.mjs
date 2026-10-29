import { isKnownSyncId, TIMING_OPS } from './sync-stall-catalogue.mjs';

export const STALL_SHARED_BYTES = 8192, STALL_DEPTH = 16, STALL_RECENT = 64;
export const CONTROL = Object.freeze({ SEQ:0, ARMED:1, DEPTH:2, OVERFLOW:3, HEARTBEAT:4, STOP:5, CURSOR:6, EVENTS:7 });
export function stallViews(shared) {
  if (!(shared instanceof SharedArrayBuffer) || shared.byteLength !== STALL_SHARED_BYTES) throw new Error('STALL_SHARED_INVALID');
  return { control:new Int32Array(shared,0,32), heartbeat:new BigInt64Array(shared,128,1),
    frames:new Int32Array(shared,256,STALL_DEPTH), starts:new BigInt64Array(shared,320,STALL_DEPTH),
    recent:new Int32Array(shared,512,STALL_RECENT*4), recentTimes:new BigInt64Array(shared,1536,STALL_RECENT) };
}
export function createSyncMarkers(shared, now = () => process.hrtime.bigint(), {deadlineNs,expiresAtMs=Infinity,nowUtc=Date.now}={}) {
  const v=stallViews(shared), c=v.control;
  const stop=()=>{Atomics.store(c,CONTROL.STOP,1);Atomics.store(c,CONTROL.ARMED,0);};
  const expired=()=>{
    try{if(deadlineNs!==undefined&&now()>=deadlineNs || Number.isFinite(expiresAtMs)&&nowUtc()>=expiresAtMs){stop();return true;}}
    catch{stop();return true;}
    return false;
  };
  const admitted=()=>!expired()&&Atomics.load(c,CONTROL.ARMED)===1&&!Atomics.load(c,CONTROL.STOP);
  const event=(id,phase,depth,stamp)=>{
    const sequence=(Atomics.add(c,CONTROL.EVENTS,1)+1)>>>0, slot=(sequence?sequence-1:0)%STALL_RECENT;
    for(const [offset,value] of [sequence,id,phase,depth].entries())Atomics.store(v.recent,slot*4+offset,value);
    Atomics.store(v.recentTimes,slot,stamp);Atomics.store(c,CONTROL.CURSOR,sequence);
  };
  return {
    expired,
    heartbeat(){if(admitted())try{Atomics.store(v.heartbeat,0,now());Atomics.add(c,CONTROL.HEARTBEAT,1);}catch{stop();}},
    mark(id,work){
      if(!admitted())return work();
      let depth=-1;
      try {
        const stamp=now();if(typeof stamp!=='bigint')throw Error();
        depth=Atomics.load(c,CONTROL.DEPTH);id=isKnownSyncId(id)?id:0;Atomics.add(c,CONTROL.SEQ,1);
        if(depth<STALL_DEPTH){Atomics.store(v.frames,depth,id);Atomics.store(v.starts,depth,stamp);}
        else Atomics.store(c,CONTROL.OVERFLOW,1);
        Atomics.store(c,CONTROL.DEPTH,depth+1);event(id,1,Math.min(depth,STALL_DEPTH),stamp);Atomics.add(c,CONTROL.SEQ,1);
      }catch{depth=-1;Atomics.store(c,CONTROL.STOP,1);Atomics.store(c,CONTROL.ARMED,0);}
      try{return work();}finally{
        if(depth>=0)try{const ended=expired(),stamp=ended?0n:now();if(typeof stamp!=='bigint')throw Error();Atomics.add(c,CONTROL.SEQ,1);if(!ended)event(id,0,Math.min(depth,STALL_DEPTH),stamp);
          Atomics.store(c,CONTROL.DEPTH,depth);if(depth<STALL_DEPTH){Atomics.store(v.frames,depth,0);Atomics.store(v.starts,depth,0n);}Atomics.add(c,CONTROL.SEQ,1);
        }catch{Atomics.store(c,CONTROL.STOP,1);Atomics.store(c,CONTROL.ARMED,0);}
      }
    },
    stop,
  };
}
export function readStallSnapshot(shared, now = process.hrtime.bigint(), retries=3) {
  const v=stallViews(shared),c=v.control;
  for(let attempt=0;attempt<Math.min(3,retries);attempt++){
    const before=Atomics.load(c,CONTROL.SEQ);if(before&1)continue;
    const depth=Atomics.load(c,CONTROL.DEPTH),overflow=Atomics.load(c,CONTROL.OVERFLOW),cursor=Atomics.load(c,CONTROL.CURSOR)>>>0;
    const frames=Array.from({length:Math.min(Math.max(0,depth),STALL_DEPTH)},(_,i)=>[
      isKnownSyncId(Atomics.load(v.frames,i))?Atomics.load(v.frames,i):0,Number((now-Atomics.load(v.starts,i))/1000000n)]);
    const recent=[];for(let seq=Math.max(1,cursor-STALL_RECENT+1);seq<=cursor;seq++){
      const slot=(seq-1)%STALL_RECENT;recent.push(Array.from({length:4},(_,i)=>Atomics.load(v.recent,slot*4+i)));
    }
    const heartbeat=Atomics.load(v.heartbeat,0),after=Atomics.load(c,CONTROL.SEQ);
    if(before===after && !(after&1))return {state:overflow||depth>STALL_DEPTH?'OVERFLOW':depth?'UNFINISHED_INSTRUMENTED_SCOPE':'UNKNOWN',
      frames,recent,main_age_ms:heartbeat?Number((now-heartbeat)/1000000n):null};
  }
  const heartbeat=Atomics.load(v.heartbeat,0);
  return {state:'INCONSISTENT',frames:[],recent:[],main_age_ms:heartbeat?Number((now-heartbeat)/1000000n):null};
}
let installed=null;
export function installSyncMarkers(value){installed=value;}
export function markSync(id,work){return installed?installed.mark(id,work):work();}
export function markTimingSync(label,work){return installed?installed.mark(TIMING_OPS[label]??0,work):work();}
