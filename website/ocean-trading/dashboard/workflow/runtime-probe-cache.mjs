// Display-only observations: do not block the HTTP thread or retain stale safety claims.
export function createRuntimeProbeCache({observe,unavailable,now=Date.now,refreshMs=5000,maxAgeMs=15000}) {
  let cache=null;
  return input=>{
    const key=JSON.stringify(input),time=now();
    if(cache?.key!==key)cache={key,pending:false,value:null,observedAt:0,nextAttempt:0};
    const current=cache;
    if(!current.pending&&time>=current.nextAttempt){
      current.pending=true;
      Promise.resolve().then(()=>observe(input)).then(value=>{
        current.value=value;current.observedAt=now();
      }).catch(()=>{current.value=null;current.observedAt=0;}).finally(()=>{
        current.pending=false;current.nextAttempt=now()+refreshMs;
      });
    }
    if(!current.value||time-current.observedAt>maxAgeMs)return unavailable(input,current.pending?'STATUS_CHECK_PENDING':'STATUS_UNAVAILABLE');
    return structuredClone(current.value);
  };
}
