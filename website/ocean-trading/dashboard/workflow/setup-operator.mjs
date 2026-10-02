import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { requireThat, objectHash, noSecrets } from './common.mjs';

const bindings=JSON.parse(fs.readFileSync(new URL('./setup-task-map.json',import.meta.url))).tasks;
const postSealTasks=new Set(['S52.3','S53.3','S53.4']);
export const setupTaskCapacity=bindings.length;
export const knownSetupTask = taskId => bindings.some(row=>row.task_id===taskId);
export function orderedSetup(rows) {
  const order=new Map(bindings.map((row,index)=>[row.task_id,index]));
  return rows.toSorted((a,b)=>(order.get(a.id || JSON.parse(a.payload_json).registered_task_id || JSON.parse(a.payload_json).task_id) ?? Infinity)-(order.get(b.id || JSON.parse(b.payload_json).registered_task_id || JSON.parse(b.payload_json).task_id) ?? Infinity));
}

export function setupOperation({state,operator_id,action,request}) {
  requireThat(/^S-1-/.test(operator_id || ''),403,'WINDOWS_OPERATOR_SID_REQUIRED');
  const store=new WorkflowStore(state.config.db_file);
  try {
    if(['setup-import','setup-acknowledge'].includes(action)){
      const result=spawnSync(state.config.python_executable,[fileURLToPath(new URL('./verify-setup-bundle.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
      requireThat(result.status===0,422,'SETUP_BUNDLE_REJECTED');
      const payload=JSON.parse(result.stdout);noSecrets(payload,state.environment);
      if(action==='setup-acknowledge'){
        requireThat(postSealTasks.has(payload.receipt.task_id),422,'POST_SEAL_TASK_REQUIRED');
        requireThat(['PASS','VERIFIED_REUSE'].includes(payload.receipt.status ?? payload.receipt.final_status),422,'PASSING_POST_SEAL_RECEIPT_REQUIRED');
      }
      const key=payload.canonical_task_id || payload.receipt.task_id;const hash=objectHash(payload);
      return store.transaction(()=>{
        const prior=store.db.prepare('SELECT content_hash,payload_json FROM ow_setup_receipts WHERE id=?').get(key);
        if(prior){
          const existing=JSON.parse(prior.payload_json);
          const {verified_bundle_sha256,verified_members,operator_id:previousOperator,setup_recorded_at_utc,registration_action,registered_task_id,...original}=existing;
          // New verification metadata must not invalidate an unchanged sealed receipt.
          requireThat(verified_bundle_sha256===payload.bundle_sha256 && objectHash(original)===objectHash(payload.receipt),409,'SETUP_RECEIPT_CONFLICT');
          if(action==='setup-acknowledge')return {schema_version:'ocean-post-seal-receipt-acknowledgement/v1',task_id:key,receipt_id:key,bundle_sha256:payload.bundle_sha256,recorded_at_utc:setup_recorded_at_utc || null,operator_id:previousOperator || operator_id,classification:'HISTORICAL_SETUP_NOT_APPROVAL',non_recursive:true,idempotent:true};
          return {receipt_id:key,idempotent:true};
        }
        const recordedAt=new Date().toISOString();
        store.db.prepare("INSERT INTO ow_setup_receipts VALUES(?,?,?,'HISTORICAL_SETUP_NOT_APPROVAL')").run(key,hash,JSON.stringify({...payload.receipt,registered_task_id:key,verified_bundle_sha256:payload.bundle_sha256,verified_members:payload.verified_members,operator_id,setup_recorded_at_utc:recordedAt,registration_action:action}));
        store.db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run(action,key,null,hash,operator_id,recordedAt);
        if(action==='setup-acknowledge')return {schema_version:'ocean-post-seal-receipt-acknowledgement/v1',task_id:key,receipt_id:key,bundle_sha256:payload.bundle_sha256,recorded_at_utc:recordedAt,operator_id,classification:'HISTORICAL_SETUP_NOT_APPROVAL',non_recursive:true,idempotent:false};
        return {receipt_id:key,idempotent:false,operator_id,classification:'HISTORICAL_SETUP_NOT_APPROVAL'};
      });
    }
    requireThat(['setup-read','setup-export'].includes(action),422,'UNKNOWN_SETUP_OPERATION');
    return {schema_version:'ocean-setup-history/v1',classification:'HISTORICAL_SETUP_NOT_APPROVAL',operator_id,items:orderedSetup(store.db.prepare('SELECT * FROM ow_setup_receipts').all())};
  }finally{store.close();}
}
