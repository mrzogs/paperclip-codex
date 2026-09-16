import fs from 'node:fs';
import path from 'node:path';
import { digest, objectHash, exactKeys, id, requireThat, noSecrets, future } from './common.mjs';

export const TEST_VERSION = 'ocean-test-communication/v1';
export const TEST_PREFIX = 'test-communication/v1';
export const DECLARATION_SHA256 = 'sha256:37e87d8271b9e17b1a1efe50971ba757afa66abd252ce2a1141cfa2150cdd267';
export const TEST_OPERATIONS = Object.freeze({
  'health.report': { roles: ['TELEMETRY'], scope: 'health.write' },
  'event.receipt': { roles: ['TELEMETRY'], scope: 'event.write' },
  'artifact.register': { roles: ['STRATEGY','BRAIN'], scope: 'artifact.write' },
  'handoff.ack': { roles: ['STRATEGY'], scope: 'delivery' },
  'handoff.progress': { roles: ['STRATEGY'], scope: 'delivery' },
  'handoff.result': { roles: ['STRATEGY'], scope: 'delivery' },
  'result.register': { roles: ['BRAIN'], scope: 'artifact.write' },
  'result.callback': { roles: ['BRAIN'], scope: 'event.write' },
});
const EXCLUSIONS = Object.freeze({namespace:'TEST', classification:'SYNTHETIC_COMMUNICATION_ONLY',
  operational_eligibility:false, learning_votes:false, market_coverage:false, strategy_approval:false,
  normal_ingestion:'OFF', brain_submission:'OFF', live_real:'DISABLED'});
const hash = value => requireThat(typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value),422,'TEST_HASH_REQUIRED');
const text = (value,max=512) => requireThat(typeof value==='string' && value.length>0 && Buffer.byteLength(value)<=max,422,'TEST_TEXT_BOUND');
function correlation(value) {
  exactKeys(value,['job_id','event_id','input_sha256']);
  id(value.job_id,true);id(value.event_id,true);hash(value.input_sha256);
}
function artifact(data) {
  text(data.content,32768);hash(data.content_sha256);
  requireThat(digest(Buffer.from(data.content,'utf8'))===data.content_sha256,422,'TEST_CONTENT_HASH_MISMATCH');
}

export class TestCommunication {
  constructor(backend) { this.backend=backend;this.db=backend.db; }
  fixture(key) {
    id(key,true);
    const row=this.db.prepare('SELECT * FROM ow_test_fixtures WHERE id=?').get(key);
    requireThat(row,404,'TEST_FIXTURE_NOT_FOUND');
    return {...row,payload:JSON.parse(row.payload_json)};
  }
  authorize(actor,fixture,scope) {
    requireThat(actor.role!=='HUMAN',403,'TEST_SERVICE_ONLY');
    requireThat(actor.scopes.includes(scope),403,'WRONG_ACTION_SCOPE');
    requireThat(fixture.identity_id===actor.id,403,'TEST_WRONG_CALLER');
    requireThat(fixture.active===1 && future(fixture.payload.expires_at_utc),409,'TEST_FIXTURE_INACTIVE');
    requireThat(actor.strategyIds.includes(fixture.payload.strategy_id),403,'WRONG_STRATEGY_SCOPE');
    requireThat(actor.instanceIds.includes(fixture.payload.instance_id),403,'WRONG_INSTANCE_SCOPE');
    const identity=this.backend.config.identities.find(row=>row.identity_id===actor.id);
    requireThat(identity?.audience==='Ocean workflow TEST' && identity.namespace==='TEST' && identity.role===actor.role,403,'TEST_AUDIENCE_ROLE_REQUIRED');
    requireThat(identity.owner_evidence_sha256===DECLARATION_SHA256.slice(7),403,'TEST_IDENTITY_DECLARATION_MISMATCH');
    const declaration=this.db.prepare('SELECT * FROM ow_test_declarations WHERE id=?').get(fixture.declaration_id);
    requireThat(declaration?.content_hash===DECLARATION_SHA256 && fixture.payload.declaration_sha256===DECLARATION_SHA256,409,'TEST_DECLARATION_MISMATCH');
    const declared=JSON.parse(declaration.payload_json);
    requireThat(declared.strategy_id===fixture.payload.strategy_id && declared.instance_id===fixture.payload.instance_id,409,'TEST_DECLARATION_SCOPE_MISMATCH');
  }
  readiness(actor) {
    const rows=this.db.prepare('SELECT * FROM ow_test_fixtures WHERE identity_id=? AND active=1').all(actor.id);
    const ready=rows.filter(row=>future(JSON.parse(row.payload_json).expires_at_utc));
    return {version:TEST_VERSION,facility:'INSTALLED',scope_readiness:ready.length?'FIXTURE_PREPARED':'OPERATOR_FIXTURE_REQUIRED',
      active_fixtures:ready.map(row=>row.id),persisted_receipts:this.db.prepare('SELECT COUNT(*) AS n FROM ow_test_receipts WHERE identity_id=?').get(actor.id).n,
      consumer_adoption:'NOT_ASSERTED',completed_analysis:'NOT_ASSERTED',...EXCLUSIONS};
  }
  readFixture(actor,key) {
    const fixture=this.fixture(key);this.authorize(actor,fixture,'read');
    return {schema_version:TEST_VERSION,...fixture.payload,fixture_sha256:fixture.content_hash,state:fixture.state,...EXCLUSIONS};
  }
  receipt(actor,key) {
    id(key,true);
    const row=this.db.prepare('SELECT * FROM ow_test_receipts WHERE id=?').get(key);
    requireThat(row,404,'TEST_RECEIPT_NOT_FOUND');
    this.authorize(actor,this.fixture(row.fixture_id),'read');
    requireThat(row.identity_id===actor.id,403,'TEST_WRONG_CALLER');
    return JSON.parse(row.receipt_json);
  }
  write(actor,input) {
    exactKeys(input,['schema_version','message_id','declaration_sha256','strategy_id','instance_id','fixture_id','operation','data']);
    requireThat(input.schema_version===TEST_VERSION,422,'TEST_SCHEMA_REQUIRED');
    id(input.message_id,true);
    requireThat(Object.hasOwn(TEST_OPERATIONS,input.operation),422,'TEST_OPERATION_UNKNOWN');
    const op=TEST_OPERATIONS[input.operation];
    const fixture=this.fixture(input.fixture_id);
    // Authorize before idempotency/conflict lookup: old receipts never bypass present trust.
    this.authorize(actor,fixture,op.scope);
    requireThat(op.roles.includes(actor.role),403,'TEST_WRONG_ROLE');
    requireThat(input.declaration_sha256===DECLARATION_SHA256,403,'TEST_DECLARATION_SUBSTITUTION');
    requireThat(input.strategy_id===fixture.payload.strategy_id,403,'WRONG_STRATEGY_SCOPE');
    requireThat(input.instance_id===fixture.payload.instance_id,403,'WRONG_INSTANCE_SCOPE');
    noSecrets(input,this.backend.environment);
    const data=input.data;exactKeys(data,Object.keys(data || {}));
    requireThat(Buffer.byteLength(JSON.stringify(input))<=49152,413,'TEST_PAYLOAD_TOO_LARGE');
    const payloadHash=objectHash(input);
    let conflict=false;
    const result=this.backend.store.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM ow_test_receipts WHERE identity_id=? AND message_id=?').get(actor.id,input.message_id);
      if(previous) {
        if(previous.payload_hash!==payloadHash) {
          if(this.db.prepare('SELECT COUNT(*) AS n FROM ow_test_conflicts').get().n<1000) this.db.prepare('INSERT INTO ow_test_conflicts(identity_id,fixture_id,message_id,payload_hash,occurred_at_utc) VALUES(?,?,?,?,?)').run(actor.id,fixture.id,input.message_id,payloadHash,new Date().toISOString());
          conflict=true;return null;
        }
        return JSON.parse(previous.receipt_json);
      }
      const count=this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(byte_count),0) AS bytes FROM ow_test_receipts').get();
      requireThat(count.n<10000 && count.bytes+3*Buffer.byteLength(JSON.stringify(input))<64*1024*1024,429,'TEST_STORAGE_CAPACITY');
      requireThat(this.db.prepare('SELECT COUNT(*) AS n FROM ow_test_receipts WHERE fixture_id=?').get(fixture.id).n<1000,429,'TEST_FIXTURE_CAPACITY');
      let nextState=fixture.state;
      switch(input.operation) {
        case 'health.report':
          exactKeys(data,['status','next_owner','next_action']);
          requireThat(['READY','DEGRADED','BLOCKED'].includes(data.status),422,'INVALID_HEALTH_STATUS');text(data.next_owner);text(data.next_action);break;
        case 'event.receipt':
          exactKeys(data,['event_id','input_sha256']);id(data.event_id,true);hash(data.input_sha256);
          requireThat(data.event_id===fixture.payload.correlation.event_id && data.input_sha256===fixture.payload.correlation.input_sha256,409,'TEST_CORRELATION_MISMATCH');break;
        case 'artifact.register':
          exactKeys(data,['content','content_sha256']);artifact(data);break;
        case 'result.register':
          exactKeys(data,['correlation','content','content_sha256']);correlation(data.correlation);artifact(data);
          requireThat(objectHash(data.correlation)===objectHash(fixture.payload.correlation),409,'TEST_CORRELATION_MISMATCH');break;
        case 'result.callback': {
          exactKeys(data,['correlation','result_receipt_id','result_sha256','status']);correlation(data.correlation);
          requireThat(objectHash(data.correlation)===objectHash(fixture.payload.correlation) && data.status==='COMPLETED',409,'TEST_CORRELATION_MISMATCH');
          this.resultReference(actor,fixture,data,'result.register');break;
        }
        default: {
          exactKeys(data,['handoff_id','handoff_revision','instruction_sha256','baseline_sha256',...(input.operation==='handoff.result'?['result_receipt_id','result_sha256']:[])]);
          const handoff=fixture.payload.handoff;
          requireThat(handoff && future(handoff.expires_at_utc),409,'TEST_HANDOFF_STALE_OR_ABSENT');
          requireThat(data.handoff_id===handoff.handoff_id && data.handoff_revision===handoff.revision && data.instruction_sha256===handoff.instruction_sha256 && data.baseline_sha256===handoff.baseline_sha256,409,'TEST_HANDOFF_BINDING_MISMATCH');
          const states={'handoff.ack':['PREPARED','ACKNOWLEDGED'],'handoff.progress':['ACKNOWLEDGED','RUNNING'],'handoff.result':['RUNNING','COMPLETED']};
          const [before,after]=states[input.operation];requireThat(fixture.state===before,409,'TEST_HANDOFF_STATE_CONFLICT');
          if(input.operation==='handoff.result')this.resultReference(actor,fixture,data,'artifact.register');
          nextState=after;
        }
      }
      const receipt={schema_version:TEST_VERSION,receipt_id:`test-receipt-${objectHash([actor.id,input.message_id]).slice(7)}`,
        caller_id:actor.id,audience:'Ocean workflow TEST',role:actor.role,scope:op.scope,fixture_id:fixture.id,message_id:input.message_id,
        declaration_sha256:DECLARATION_SHA256,strategy_id:input.strategy_id,instance_id:input.instance_id,operation:input.operation,
        payload_sha256:payloadHash,received_at_utc:new Date().toISOString(),persisted:true,state:nextState,data,...EXCLUSIONS};
      const body=JSON.stringify(receipt),payload=JSON.stringify(input);
      const storedBytes=Buffer.byteLength(body)+Buffer.byteLength(payload);
      requireThat(count.bytes+storedBytes<=64*1024*1024,429,'TEST_STORAGE_CAPACITY');
      this.db.prepare('INSERT INTO ow_test_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(receipt.receipt_id,actor.id,fixture.id,input.message_id,input.operation,payloadHash,payload,body,storedBytes);
      if(nextState!==fixture.state)this.db.prepare('UPDATE ow_test_fixtures SET state=? WHERE id=?').run(nextState,fixture.id);
      return receipt;
    });
    requireThat(!conflict,409,'TEST_DUPLICATE_CONFLICT');
    return result;
  }
  resultReference(actor,fixture,data,operation) {
    const row=this.receipt(actor,data.result_receipt_id);
    requireThat(row.fixture_id===fixture.id && row.operation===operation && row.data.content_sha256===data.result_sha256,409,'TEST_RESULT_REFERENCE_MISMATCH');
  }
}

// Only the existing ACL/DPAPI operator calls this; no service or browser endpoint exists.
export function testFixtureOperation({state,operator_id,action,request},store) {
  requireThat(/^S-1-/.test(operator_id || ''),403,'WINDOWS_OPERATOR_SID_REQUIRED');
  requireThat(state.config.test_only===true && state.config.brain_submission==='OFF' && state.config.dispatch_worker==='OFF' && state.config.live_real==='DISABLED',403,'TEST_ONLY_CONFIGURATION_REQUIRED');
  const db=store.db;
  if(action==='test-prepare') {
    exactKeys(request,['fixture_id','identity_id','declaration_path','declaration_sha256','expires_at_utc','correlation','handoff']);
    id(request.fixture_id,true);correlation(request.correlation);
    requireThat(request.declaration_sha256===DECLARATION_SHA256,409,'TEST_DECLARATION_HASH_REJECTED');
    requireThat(typeof request.declaration_path==='string' && path.isAbsolute(request.declaration_path),422,'ABSOLUTE_TEST_DECLARATION_PATH_REQUIRED');
    const bytes=fs.readFileSync(request.declaration_path);requireThat(digest(bytes)===DECLARATION_SHA256,409,'TEST_DECLARATION_BYTES_MISMATCH');
    const declaration=JSON.parse(bytes);
    requireThat(declaration.namespace==='TEST' && declaration.classification==='SYNTHETIC_COMMUNICATION_ONLY' && declaration.operational_eligibility===false && declaration.physical_sierra_instance===null && declaration.register_in_factual_execution_registry===false,403,'NONPHYSICAL_DECLARATION_REQUIRED');
    const identity=state.config.identities.find(row=>row.identity_id===request.identity_id);
    requireThat(identity && !identity.revoked && future(identity.expires_at_utc) && identity.namespace==='TEST' && identity.audience==='Ocean workflow TEST' && identity.owner_evidence_sha256===DECLARATION_SHA256.slice(7) && identity.strategy_ids.includes(declaration.strategy_id) && identity.instance_ids.includes(declaration.instance_id),403,'EXACT_TEST_CONSUMER_REQUIRED');
    requireThat(future(request.expires_at_utc) && Date.parse(request.expires_at_utc)<=Date.now()+30*86400000,422,'FINITE_TEST_FIXTURE_REQUIRED');
    if(request.handoff!==null) {
      const handoff=request.handoff;exactKeys(handoff,['handoff_id','revision','expires_at_utc','instruction_md','instruction_sha256','baseline_sha256']);
      requireThat(identity.role==='STRATEGY',403,'STRATEGY_HANDOFF_FIXTURE_ONLY');id(handoff.handoff_id,true);
      requireThat(Number.isSafeInteger(handoff.revision) && handoff.revision>0 && future(handoff.expires_at_utc) && Date.parse(handoff.expires_at_utc)<=Date.parse(request.expires_at_utc),422,'FINITE_TEST_HANDOFF_REQUIRED');
      artifact({content:handoff.instruction_md,content_sha256:handoff.instruction_sha256});hash(handoff.baseline_sha256);
    }
    const {declaration_path,...payload}=request;
    Object.assign(payload,{strategy_id:declaration.strategy_id,instance_id:declaration.instance_id,...EXCLUSIONS});noSecrets(payload,state.environment);
    const fixtureHash=objectHash(payload);
    return store.transaction(()=>{
      const old=db.prepare('SELECT * FROM ow_test_fixtures WHERE id=?').get(request.fixture_id);
      if(old) {requireThat(old.content_hash===fixtureHash && old.active===1,409,'IMMUTABLE_TEST_FIXTURE_CONFLICT');return {fixture_id:old.id,fixture_sha256:old.content_hash,idempotent:true};}
      requireThat(db.prepare('SELECT COUNT(*) AS n FROM ow_test_fixtures').get().n<256,429,'TEST_FIXTURE_REGISTRY_CAPACITY');
      const registered=db.prepare('SELECT * FROM ow_test_declarations WHERE id=?').get(declaration.declaration_id);
      if(registered)requireThat(registered.content_hash===DECLARATION_SHA256,409,'IMMUTABLE_TEST_DECLARATION_CONFLICT');
      else db.prepare('INSERT INTO ow_test_declarations VALUES(?,?,?)').run(declaration.declaration_id,DECLARATION_SHA256,JSON.stringify(declaration));
      db.prepare("INSERT INTO ow_test_fixtures(id,declaration_id,identity_id,content_hash,payload_json,operator_id,created_at_utc) VALUES(?,?,?,?,?,?,?)").run(request.fixture_id,declaration.declaration_id,identity.identity_id,fixtureHash,JSON.stringify(payload),operator_id,new Date().toISOString());
      db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run(action,request.fixture_id,null,fixtureHash,operator_id,new Date().toISOString());
      return {fixture_id:request.fixture_id,fixture_sha256:fixtureHash,idempotent:false,...EXCLUSIONS};
    });
  }
  requireThat(['test-export','test-cleanup'].includes(action),422,'UNKNOWN_TEST_OPERATOR_ACTION');
  exactKeys(request,['fixture_id']);id(request.fixture_id,true);
  const fixture=db.prepare('SELECT * FROM ow_test_fixtures WHERE id=?').get(request.fixture_id);requireThat(fixture,404,'TEST_FIXTURE_NOT_FOUND');
  if(action==='test-cleanup')return store.transaction(()=>{
    if(fixture.active){
      db.prepare('UPDATE ow_test_fixtures SET active=0 WHERE id=?').run(fixture.id);
      db.prepare('INSERT INTO ow_auth_audit(action,identity_id,before_hash,after_hash,operator_id,occurred_at_utc) VALUES(?,?,?,?,?,?)').run(action,fixture.id,fixture.content_hash,fixture.content_hash,operator_id,new Date().toISOString());
    }
    return {fixture_id:fixture.id,active:false,immutable_receipts_retained:true,reactivation_allowed:false};
  });
  return {schema_version:TEST_VERSION,fixture:JSON.parse(fixture.payload_json),fixture_sha256:fixture.content_hash,active:Boolean(fixture.active),state:fixture.state,
    receipts:db.prepare('SELECT receipt_json FROM ow_test_receipts WHERE fixture_id=? ORDER BY rowid').all(fixture.id).map(row=>JSON.parse(row.receipt_json)),...EXCLUSIONS};
}
