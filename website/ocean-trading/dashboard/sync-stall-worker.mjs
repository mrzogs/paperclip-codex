import {parentPort,workerData} from 'node:worker_threads';
import {createStallWatchdog,STALL_LIMITS} from './sync-stall-watchdog.mjs';
import {stallViews,CONTROL} from './sync-stall-markers.mjs';
import {openStallOutput} from './sync-stall-output.mjs';

// The fixed entry point supplies real dependencies; software tests inject only
// clocks/IO/port into this same lifecycle. No caller-selected worker code exists.
export async function runStallWorker({data,port,openOutput=openStallOutput,nowNs=()=>process.hrtime.bigint(),nowUtc=Date.now,
  schedule=setInterval,unschedule=clearInterval}){
  let watchdog=null,descriptor=null,timer=null,lastState=null,stopping=false,closeAttempted=false;
  const closeDescriptor=async()=>{if(closeAttempted)throw Error('CLOSE_PENDING');closeAttempted=true;await descriptor.close();descriptor=null;};
  const state=value=>{if(value!==lastState){lastState=value;port.postMessage({state:value});if(value==='CLOSED')port.close();}};
  const disarm=()=>{const v=stallViews(data.shared);Atomics.store(v.control,CONTROL.STOP,1);Atomics.store(v.control,CONTROL.ARMED,0);};
  const ended=()=>stopping||nowUtc()>=data.expires_at_ms||nowNs()>=data.deadline_ns;
  const clear=()=>{if(timer!==null)unschedule(timer);timer=null;};
  const stop=()=>{stopping=true;disarm();clear();watchdog?.stop();if(!watchdog)state('PENDING');};
  port.on('message',message=>{if(message?.type==='STOP')stop();});
  // This independent deadline owner exists BEFORE any potentially pending open.
  // A logical stop never releases actual open/write/close ownership.
  timer=schedule(()=>{
    if(ended()){stop();return;}
    if(watchdog&&!watchdog.poll())clear();
  },STALL_LIMITS.poll_ms);
  try {
    // Root is validated by the parent. Verify its diagnostics child independently
    // before opening the ONE fixed output, exclusively and without replacement.
    descriptor=await openOutput(data.root,{ended});
    if(ended()){disarm();clear();state('PENDING');await closeDescriptor();state('CLOSED');}
    else {
      watchdog=createStallWatchdog({shared:data.shared,header:data.header,deadlineNs:data.deadline_ns,nowNs,nowUtc,
        write:buffer=>descriptor.write(buffer,0,buffer.length,null),close:closeDescriptor,onState:state});
      watchdog.start();
    }
  }catch(error){
    disarm();clear();
    if(descriptor&&!closeAttempted){state('PENDING');try{await closeDescriptor();}catch{state('PENDING');}}
    if(descriptor)state('PENDING');
    else if(stopping){state('CLOSED');}
    else{state(error.code==='EEXIST'?'OUTPUT_EXISTS':'DISABLED_OUTPUT');port.close();}
  }
}
if(parentPort)await runStallWorker({data:workerData,port:parentPort});
