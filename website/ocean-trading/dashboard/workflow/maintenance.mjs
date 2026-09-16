import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OceanAuth } from './auth.mjs';
import { requireThat } from './common.mjs';

const command=fileURLToPath(new URL('../../../../scripts/ocean-workflow-operator.ps1',import.meta.url));
export function protectedOperation(action,root) {
  return new Promise((resolve,reject)=>{
    const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',command,'-Action',action,'-Root',root],
      {windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; let bytes=0;
    const timer=setTimeout(()=>{child.kill();reject(new Error('PROTECTED_OPERATION_TIMEOUT'));},15000);
    child.stdout.on('data',value=>{bytes+=value.length;if(bytes>262144)child.kill();else output+=value;});
    child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);reject(new Error('PROTECTED_OPERATION_UNAVAILABLE'));});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0 || bytes>262144)return reject(new Error('PROTECTED_OPERATION_FAILED'));
      try {resolve(JSON.parse(output.replace(/^\uFEFF/,'')));}catch{reject(new Error('PROTECTED_OPERATION_INVALID_RESULT'));}
    });
  });
}

// One bounded local worker, not an agent task or credential-bearing HTTP renewal API.
export function attachMaintenance(backend,filename) {
  const root=path.dirname(filename);
  let stamp=fs.statSync(filename).mtimeMs; let nextMaintenance=Date.now(); let nextAttempt=0; let busy=false; let closed=false; let failures=0;
  const health={runner:'ocean-website-maintenance',interval_seconds:30,reload_seconds:1,state:'STARTING',last_success_utc:null,failures:0};
  backend.maintenanceHealth=health;
  const tick=async()=>{
    if(busy || closed || Date.now()<nextAttempt)return;
    busy=true;
    try {
      let result;
      if(Date.now()>=nextMaintenance){
        result=await protectedOperation('Maintenance',root);
        nextMaintenance=Date.now()+30000;
      }
      if(closed)return;
      const current=fs.statSync(filename).mtimeMs;
      if(current!==stamp || result?.committed){
        const state=await protectedOperation('Runtime',root);
        if(closed)return;
        requireThat(state.config.db_file===backend.config.db_file && state.config.test_only===true && state.config.brain_submission==='OFF' && state.config.dispatch_worker==='OFF' && state.config.live_real==='DISABLED',503,'RUNTIME_BINDING_CHANGED');
        const environment={...backend.environment,...state.environment};
        const auth=new OceanAuth(state.config,backend.store,environment);
        auth.loginFailures=backend.auth.loginFailures;
        backend.config=state.config;backend.environment=environment;backend.auth=auth;stamp=current;
        if(result?.committed){
          // Confirm the provider accepts each maintained credential before reporting success.
          for(const identity of state.config.identities.filter(item=>item.renewal_policy && !item.revoked && Date.parse(item.expires_at_utc)>Date.now())){
            const origin=state.config.allowed_origins[0];
            const response=await fetch(`${origin}/api/workflow/status`,{headers:{Authorization:`Bearer ${environment[identity.credential_ref]}`},signal:AbortSignal.timeout(5000)});
            requireThat(response.ok && (await response.json()).identity.id===identity.identity_id,503,'MAINTENANCE_AUTH_PROBE_FAILED');
          }
        }
      }
      if(closed)return;
      failures=0;nextAttempt=0;health.failures=0;health.state='READY';health.last_success_utc=new Date().toISOString();delete health.error;
      health.expiry_alerts=backend.auth.readiness().bindings.filter(row=>['ERROR','EXPIRED'].includes(row.state)).map(row=>({identity_id:row.identity_id,state:row.state}));
    }catch(error){
      failures=Math.min(failures+1,6);health.failures=failures;health.state='ERROR';health.error=error.code || error.message;
      nextAttempt=Date.now()+Math.min(300000,5000*2**failures);
      nextMaintenance=nextAttempt;
    }finally{busy=false;}
  };
  const timer=setInterval(()=>{void tick();},1000);timer.unref();
  backend.stopMaintenance=()=>{closed=true;clearInterval(timer);};
}
