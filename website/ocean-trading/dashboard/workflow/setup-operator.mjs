import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { requireThat, objectHash, noSecrets } from './common.mjs';

const bindings=JSON.parse(fs.readFileSync(new URL('./setup-task-map.json',import.meta.url))).tasks;
export function orderedSetup(rows) {
  const order=new Map(bindings.map((row,index)=>[row.task_id,index]));
  return rows.toSorted((a,b)=>(order.get(JSON.parse(a.payload_json).task_id) ?? Infinity)-(order.get(JSON.parse(b.payload_json).task_id) ?? Infinity));
}

export function setupOperation({state,operator_id,action,request}) {
  requireThat(/^S-1-/.test(operator_id || ''),403,'WINDOWS_OPERATOR_SID_REQUIRED');
  const store=new WorkflowStore(state.config.db_file);
  try {
    if(action==='setup-import'){
      const result=spawnSync(state.config.python_executable,[fileURLToPath(new URL('./verify-setup-bundle.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
      requireThat(result.status===0,422,'SETUP_BUNDLE_REJECTED');
      const payload=JSON.parse(result.stdout);noSecrets(payload,state.environment);
      const key=payload.receipt.task_id;const hash=objectHash(payload);
      return store.transaction(()=>{
        const prior=store.db.prepare('SELECT content_hash FROM ow_setup_receipts WHERE id=?').get(key);
        if(prior){requireThat(prior.content_hash===hash,409,'SETUP_RECEIPT_CONFLICT');return {receipt_id:key,idempotent:true};}
        store.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run(key,hash,JSON.stringify({...payload.receipt,verified_bundle_sha256:payload.bundle_sha256,operator_id}));
        store.db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run('setup-import',key,null,hash,operator_id,new Date().toISOString());
        return {receipt_id:key,idempotent:false,operator_id,classification:'HISTORICAL_SETUP_NOT_APPROVAL'};
      });
    }
    requireThat(['setup-read','setup-export'].includes(action),422,'UNKNOWN_SETUP_OPERATION');
    return {schema_version:'ocean-setup-history/v1',classification:'HISTORICAL_SETUP_NOT_APPROVAL',operator_id,items:orderedSetup(store.db.prepare('SELECT * FROM ow_setup_receipts').all())};
  }finally{store.close();}
}
