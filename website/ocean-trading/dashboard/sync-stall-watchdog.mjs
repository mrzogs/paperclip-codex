import { readStallSnapshot, stallViews, CONTROL } from './sync-stall-markers.mjs';

export const STALL_LIMITS = Object.freeze({ shared_bytes:8192,depth:16,recent:64,poll_ms:250,stale_ms:5000,
  max_window_ms:1800000,max_attempts:64,max_bytes:131072,max_record_bytes:4096,worker_old_mb:32 });

export function createStallWriteBudget(){
  let attempts=0,bytes=0;
  return {
    reserve(length){
      if(attempts>=STALL_LIMITS.max_attempts)return false;
      attempts++;
      if(!Number.isSafeInteger(length)||length<0||length>STALL_LIMITS.max_record_bytes||bytes+length>STALL_LIMITS.max_bytes)return false;
      bytes+=length;return true;
    },
    status(){return {attempts,attempted_bytes:bytes};},
  };
}

// Pure watchdog state machine. The fixed worker supplies a single exclusive file
// descriptor. All attempted bytes are reserved before one write, never retried.
export function createStallWatchdog({shared,header,write,close,nowNs=()=>process.hrtime.bigint(),nowUtc=Date.now,deadlineNs,onState=()=>{}}) {
  const v=stallViews(shared),start=nowNs(),maximum=start+BigInt(Math.min(header.window_ms,STALL_LIMITS.max_window_ms))*1000000n;
  const deadline=deadlineNs!==undefined&&deadlineNs<maximum?deadlineNs:maximum;
  const expiry=Date.parse(header.expires_at_utc);
  const ended=()=>nowNs()>=deadline || Number.isFinite(expiry)&&nowUtc()>=expiry;
  let pending=null,stopping=false,closing=false,closed=false,lastPoll=start,lastEmission=0n,writingDisabled=false;
  const budget=createStallWriteBudget();
  const state=value=>{try{onState(value);}catch{/* diagnostic observer only */}};
  const disarm=()=>{Atomics.store(v.control,CONTROL.ARMED,0);Atomics.store(v.control,CONTROL.STOP,1);};
  const finish=()=>{
    if(closed || closing || !stopping)return;
    if(pending){state('PENDING');return;}
    closing=true;
    try{pending=Promise.resolve(close()).then(()=>{pending=null;closed=true;state('CLOSED');},()=>{state('PENDING');});}
    catch{state('PENDING');}
  };
  const emit=(value,onSuccess)=>{
    if(pending||writingDisabled||stopping||ended())return false;
    const text=JSON.stringify(value)+'\n',buffer=Buffer.from(text);
    if(!budget.reserve(buffer.length)){writingDisabled=true;stopping=true;disarm();state('BUDGET_EXHAUSTED');finish();return false;}
    // A partial/error still owns and charges the ENTIRE attempted buffer.
    try{pending=Promise.resolve(write(buffer)).then(result=>{
      if(result.bytesWritten!==buffer.length){writingDisabled=true;stopping=true;disarm();state('OUTPUT_PARTIAL');}
      else if(ended()||Atomics.load(v.control,CONTROL.STOP)){stopping=true;disarm();}
      else if(!stopping)onSuccess?.();
    },()=>{writingDisabled=true;stopping=true;disarm();state('OUTPUT_FAILED');}).finally(()=>{pending=null;finish();});}
    catch{writingDisabled=true;stopping=true;disarm();state('OUTPUT_FAILED');finish();return false;}
    return true;
  };
  return {
    start(){
      emit({type:'HEADER',...header,limits:STALL_LIMITS,interpretation:'UNFINISHED_INSTRUMENTED_SCOPE_ONLY_NOT_CPU_OR_ROOT_CAUSE'},()=>{
        if(!stopping&&!ended()){Atomics.store(v.control,CONTROL.ARMED,1);state('ARMED');}
      });
    },
    poll(){
      const current=nowNs(),sampleGap=Number((current-lastPoll)/1000000n);lastPoll=current;
      if(stopping || ended() || Atomics.load(v.control,CONTROL.STOP)){stopping=true;disarm();finish();return false;}
      const snapshot=readStallSnapshot(shared,current);
      if(snapshot.main_age_ms===null)snapshot.main_age_ms=Number((current-start)/1000000n);
      if(sampleGap>=STALL_LIMITS.stale_ms || snapshot.main_age_ms!==null&&snapshot.main_age_ms>=STALL_LIMITS.stale_ms){
        if(!lastEmission || current-lastEmission>=BigInt(STALL_LIMITS.stale_ms)*1000000n){
          if(emit({type:'OBSERVATION',elapsed_ms:Number((current-start)/1000000n),watchdog_gap_ms:sampleGap,
            watchdog_sample_gap:sampleGap>=STALL_LIMITS.stale_ms,main_heartbeat_stale:snapshot.main_age_ms!==null&&snapshot.main_age_ms>=STALL_LIMITS.stale_ms,
            ...snapshot}))lastEmission=current;
        }
      }
      return !stopping;
    },
    stop(){stopping=true;disarm();finish();},
    status(){return {...budget.status(),pending:pending!==null,stopping,closed};},
  };
}
