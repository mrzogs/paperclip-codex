import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import {markTimingSync} from './sync-stall-markers.mjs';

// Diagnostics only: bounded metadata, never query strings, headers, bodies,
// credentials, IDs, SQL, filesystem arguments or response content.
export function routeFamily(raw) {
  const path=String(raw||'').split('?')[0].split('#')[0];
  const parts=path.split('/');
  const collections=new Set(['dashboard','strategies','cases','runs','approvals','history','artifacts','onboarding-guide']);
  if(path.startsWith('/api/workflow/view/'))return collections.has(parts[4])?parts.slice(0,5).join('/'):'/api/workflow/view/other';
  if(path.startsWith('/api/workflow/'))return '/api/workflow/other';
  if(path.startsWith('/api/'))return new Set(['manifest','health','monitor','database','vwap-improvement-monitor']).has(parts[2])?parts.slice(0,3).join('/'):'/api/other';
  if(path.startsWith('/improvement/'))return collections.has(parts[2])?parts.slice(0,3).join('/'):'/improvement/other';
  if(path.startsWith('/quant-terminal/'))return '/quant-terminal/';
  return 'STATIC';
}

const top=(map)=>[...map].map(([label,v])=>({label,count:v.count,total_ms:Math.round(v.total),max_ms:Math.round(v.max)}))
  .sort((a,b)=>b.total_ms-a.total_ms).slice(0,8);
function add(map,label,ms){
  if(!map.has(label)&&map.size>=32)return;
  const value=map.get(label)||{count:0,total:0,max:0};
  value.count++;value.total+=ms;value.max=Math.max(value.max,ms);map.set(label,value);
}

export function createRequestTiming({clock=()=>performance.now(),utc=()=>new Date().toISOString(),
  log=value=>console.error(`[ocean-request-timing] ${JSON.stringify(value)}`),thresholdMs=1000,
  intervalMs=1000,maxEventsPerMinute=120}={}){
  const context=new AsyncLocalStorage(),active=new Map();
  let timer=null,sequence=0,previous=0,windowStart=0,emitted=0;
  let spans=new Map(),recent=[];
  const emit=(kind,data)=>{
    const now=clock();if(now-windowStart>=60000){windowStart=now;emitted=0;}
    if(emitted++>=maxEventsPerMinute)return;
    try{log({kind,at_utc:utc(),pid:process.pid,...data});}catch{/* diagnostics cannot alter requests */}
  };
  const sample=()=>{
    const now=clock(),lag=Math.max(0,now-previous-intervalMs);previous=now;
    if(lag>=thresholdMs)emit('event_loop_delay',{delay_ms:Math.round(lag),spans:top(spans),
      active:[...active.values()].slice(0,8).map(v=>({id:v.id,route:v.route,age_ms:Math.round(now-v.start)})),
      recent:recent.slice(-8)});
    spans=new Map();
  };
  const api={
    start(){if(timer)return;previous=clock();windowStart=previous;timer=setInterval(sample,intervalMs);timer.unref?.();},
    stop(){if(timer)clearInterval(timer);timer=null;active.clear();recent=[];spans.clear();},
    sample,
    request(req,res,work){
      if(!timer)return work();
      const value={id:++sequence,route:routeFamily(req.url),start:clock(),spans:new Map()};
      if(active.size<64)active.set(value.id,value);
      let finished=false;
      const finish=()=>{
        if(finished)return;finished=true;active.delete(value.id);
        const duration=clock()-value.start;
        const entry={id:value.id,route:value.route,duration_ms:Math.round(duration),status:res.statusCode};
        recent.push(entry);if(recent.length>32)recent.shift();
        if(duration>=thresholdMs)emit('request', {...entry,spans:top(value.spans)});
      };
      res.once('finish',finish);res.once('close',finish);
      return context.run(value,work);
    },
    sync(label,work){
      if(!timer)return markTimingSync(label,work);
      const start=clock();
      try{return markTimingSync(label,work);}finally{
        const elapsed=clock()-start,owner=context.getStore();
        add(spans,label,elapsed);if(owner)add(owner.spans,label,elapsed);
        if(elapsed>=thresholdMs)emit('sync',{label,duration_ms:Math.round(elapsed),request_id:owner?.id||null,route:owner?.route||null});
      }
    },
  };
  return api;
}
export const websiteTiming=createRequestTiming();
export const timedSync=(label,work)=>websiteTiming.sync(label,work);
