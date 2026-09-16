import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkflowStore } from './store.mjs';
import { exactKeys, future, noSecrets, objectHash, requireThat } from './common.mjs';
import { setupOperation } from './setup-operator.mjs';

export const INTEGRATION_VERSION = 'ocean-integration/v1';
const ownBinding = (task, documents) => {
  if(task==='S24.1')return {role:'BRAIN',...documents['brain-ocean-binding.json'].consumer_config};
  if(task==='S26.2')return {role:'TELEMETRY',...documents['gateway-provider-binding.json'].ocean};
  if(task==='S27.2') {
    const d=documents['strategy-provider-binding.json'];
    return {role:'STRATEGY',identity_id:d.tooling_identity,credential_ref:d.credential_reference,strategy_ids:[d.canonical_strategy_id],instance_ids:[d.test_communication_instance_id],scopes:d.scope};
  }
  return null;
};

export function integrationOperation(input) {
  const {state,operator_id,action,request}=input;
  requireThat(/^S-1-/.test(operator_id || ''),403,'WINDOWS_OPERATOR_SID_REQUIRED');
  if(action==='integration-import') {
    exactKeys(request,['bundle_path','bundle_sha256','task_id']);
    const checked=spawnSync(state.config.python_executable,[fileURLToPath(new URL('./read-integration-bundle.py',import.meta.url))],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
    requireThat(checked.status===0,422,'INTEGRATION_BUNDLE_REJECTED');
    const payload=JSON.parse(checked.stdout);noSecrets(payload,state.environment);
    const documents=Object.fromEntries(payload.artifacts.map(row=>[row.logical_output,row.document]));
    const binding=ownBinding(request.task_id,documents);
    if(binding) {
      const identity=state.config.identities.find(row=>row.identity_id===binding.identity_id);
      requireThat(identity && identity.role===binding.role && identity.credential_ref===binding.credential_ref && identity.audience==='Ocean workflow TEST',409,'CONSUMER_BINDING_CONFLICT');
      for(const key of ['strategy_ids','instance_ids','scopes'])requireThat(objectHash(identity[key])===objectHash(binding[key]),409,'CONSUMER_SCOPE_CONFLICT');
      requireThat(!identity.revoked && future(identity.expires_at_utc),409,'ACTIVE_CONSUMER_REQUIRED');
    }
    // Receipt registration is bookkeeping, never enrollment or approval.
    setupOperation({...input,action:'setup-import'});
    const store=new WorkflowStore(state.config.db_file);
    try{return store.transaction(()=>{
      const hash=objectHash(payload), previous=store.db.prepare('SELECT content_hash FROM ow_integration_bindings WHERE id=?').get(request.task_id);
      if(previous){requireThat(previous.content_hash===hash,409,'IMMUTABLE_INTEGRATION_CONFLICT');return {task_id:request.task_id,idempotent:true};}
      requireThat(store.db.prepare('SELECT COUNT(*) n FROM ow_integration_bindings').get().n<64,429,'INTEGRATION_CAPACITY');
      const now=new Date().toISOString();
      store.db.prepare('INSERT INTO ow_integration_bindings VALUES(?,?,?,?)').run(request.task_id,hash,JSON.stringify(payload),now);
      for(const [name,kind] of [['telemetry-factual-instance-inventory.json','SOURCE_FACTS'],['strategy-factual-binding-attestation.json','STRATEGY_FACTS']]) {
        const document=documents[name];if(!document)continue;
        const record={document,source_task:request.task_id,bundle_sha256:request.bundle_sha256,artifact_sha256:payload.artifacts.find(row=>row.logical_output===name).sha256,state:'PENDING_FACTUAL_VALIDATION',operational_enabled:false};
        store.db.prepare('INSERT INTO ow_operational_pending VALUES(?,?,?,?,?,?)').run(request.task_id,document.strategy_id || null,kind,objectHash(record),JSON.stringify(record),now);
      }
      store.db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run(action,request.task_id,null,hash,operator_id,now);
      return {task_id:request.task_id,idempotent:false,classification:'SETUP_ONLY_NOT_APPROVAL',operational_enabled:false};
    });}finally{store.close();}
  }
  requireThat(action==='integration-export',422,'UNKNOWN_INTEGRATION_OPERATION');
  const store=new WorkflowStore(state.config.db_file);
  try{return {schema_version:INTEGRATION_VERSION,bindings:store.db.prepare('SELECT * FROM ow_integration_bindings ORDER BY id').all(),pending:store.db.prepare('SELECT * FROM ow_operational_pending ORDER BY id').all(),operational_enabled:false};}finally{store.close();}
}

export function integrationStatus(backend,actor) {
  requireThat(actor.role==='HUMAN' || actor.scopes.includes('read'),403,'WRONG_ACTION_SCOPE');
  const items=[];
  for(const row of backend.db.prepare('SELECT * FROM ow_integration_bindings').all()) {
    const payload=JSON.parse(row.payload_json);
    const binding=ownBinding(row.id,Object.fromEntries(payload.artifacts.map(a=>[a.logical_output,a.document])));
    if(!binding)continue;
    if(actor.role!=='HUMAN' && actor.id!==binding.identity_id)continue;
    const identity=backend.config.identities.find(i=>i.identity_id===binding.identity_id);
    const valid=identity && !identity.revoked && future(identity.expires_at_utc) && backend.store.identityCurrent(identity) && !backend.auth.bindingErrors.has(identity.identity_id);
    const receipts=backend.db.prepare('SELECT operation,COUNT(*) n FROM ow_test_receipts WHERE identity_id=? GROUP BY operation').all(binding.identity_id);
    items.push({task_id:row.id,role:binding.role,identity_id:binding.identity_id,credential_state:valid?'READY':'UNAVAILABLE',persisted_test_receipts:receipts,analysis_completion_claimed:false,source_bundle_sha256:payload.bundle_sha256});
  }
  return {schema_version:INTEGRATION_VERSION,namespace:'TEST',items,normal_ingestion:'OFF',operational_enabled:false,live_real:'DISABLED',gateway_brain_consumer_due:'S30.2',human_acceptance_due:'S33.2'};
}
