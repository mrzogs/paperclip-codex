import { digest, exactKeys, id, noSecrets, objectHash, requireThat, sealedHash } from './common.mjs';

const VERSION='ocean-operational-brain-result/v1';
const CALLBACK_VERSION='ocean-operational-brain-callback/v1';
const correlation=value=>{
  exactKeys(value,['event_id','input_sha256','job_id']);
  id(value.event_id);id(value.job_id);
  requireThat(/^sha256:[a-f0-9]{64}$/.test(value.input_sha256),422,'INPUT_HASH_REQUIRED');
  return value;
};

export class OperationalResults {
  constructor(backend){this.b=backend;this.db=backend.db;}
  run(actor,runId,contextHash,scope){
    requireThat(actor.role==='HUMAN' || (actor.role==='BRAIN' && actor.namespace==='OPERATIONAL' && actor.audience==='Ocean workflow operational v1' && actor.scopes.includes(scope)),403,'OPERATIONAL_BRAIN_SCOPE_REQUIRED');
    const run=this.b.one('ow_runs',id(runId));
    this.b.authorize(actor,scope,run.strategy_id,run.instance_id);
    const context=JSON.parse(run.context_json);
    requireThat(!run.id.startsWith('test-') && context.context_hash===contextHash && sealedHash(context,'context_hash')===context.context_hash,409,'PINNED_CONTEXT_CONFLICT');
    requireThat(this.db.prepare('SELECT context_hash FROM ow_operational_releases WHERE run_id=?').get(run.id)?.context_hash===context.context_hash,409,'OPERATIONAL_RELEASE_DISABLED');
    return {run,context};
  }
  register(actor,input){
    exactKeys(input,['run_id','context_hash','content','content_sha256','correlation']);
    noSecrets(input,this.b.environment);
    requireThat(typeof input.content==='string' && input.content.length>0,422,'RESULT_CONTENT_REQUIRED');
    requireThat(input.content.length<=200000,422,'RESULT_CONTENT_TOO_LARGE');
    requireThat(digest(input.content)===input.content_sha256,422,'RESULT_HASH_CONFLICT');
    correlation(input.correlation);
    const {run,context}=this.run(actor,input.run_id,input.context_hash,'artifact.write');
    const resultId=objectHash({run_id:run.id,context_hash:context.context_hash,producer_id:actor.id,content_sha256:input.content_sha256,correlation:input.correlation});
    const contentHash=objectHash({run_id:run.id,context_hash:context.context_hash,producer_id:actor.id,content:input.content,content_sha256:input.content_sha256,correlation:input.correlation,status:'REGISTERED'});
    const result={schema_version:VERSION,result_id:resultId,run_id:run.id,context_hash:context.context_hash,strategy_id:run.strategy_id,execution_instance_id:run.instance_id,producer_id:actor.id,content:input.content,content_sha256:input.content_sha256,correlation:input.correlation,status:'REGISTERED',registered_at_utc:new Date().toISOString()};
    return this.b.store.transaction(()=>{
      const old=this.db.prepare('SELECT content_hash,payload_json FROM ow_operational_brain_results WHERE id=?').get(resultId);
      if(old){requireThat(old.content_hash===contentHash,409,'OPERATIONAL_RESULT_CONFLICT');return JSON.parse(old.payload_json);}
      this.db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?,?,?,?,?)').run(resultId,actor.id,run.id,context.context_hash,contentHash,JSON.stringify(result),result.registered_at_utc);
      return result;
    });
  }
  callback(actor,input){
    exactKeys(input,['run_id','context_hash','result_id','result_sha256','status','correlation']);
    noSecrets(input,this.b.environment);id(input.result_id);correlation(input.correlation);
    requireThat(['COMPLETED','FAILED'].includes(input.status) && /^sha256:[a-f0-9]{64}$/.test(input.result_sha256),422,'INVALID_RESULT_CALLBACK');
    this.run(actor,input.run_id,input.context_hash,'event.write');
    return this.b.store.transaction(()=>{
      const row=this.db.prepare('SELECT producer_id,run_id,context_hash,payload_json FROM ow_operational_brain_results WHERE id=?').get(input.result_id);
      requireThat(row,404,'UNKNOWN_OPERATIONAL_RESULT');const result=JSON.parse(row.payload_json);
      requireThat(row.producer_id===actor.id && row.run_id===input.run_id && row.context_hash===input.context_hash && result.content_sha256===input.result_sha256 && objectHash(result.correlation)===objectHash(input.correlation),409,'OPERATIONAL_RESULT_CALLBACK_CONFLICT');
      const contentHash=objectHash({...input,producer_id:actor.id});
      const callback={schema_version:CALLBACK_VERSION,...input,producer_id:actor.id,callback_at_utc:new Date().toISOString()};
      const old=this.db.prepare('SELECT content_hash,payload_json FROM ow_operational_brain_callbacks WHERE result_id=?').get(input.result_id);
      if(old){requireThat(old.content_hash===contentHash,409,'OPERATIONAL_RESULT_CALLBACK_CONFLICT');return JSON.parse(old.payload_json);}
      this.db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?,?,?,?)').run(input.result_id,actor.id,contentHash,JSON.stringify(callback),callback.callback_at_utc);
      return callback;
    });
  }
  read(actor,resultId){
    id(resultId);const row=this.db.prepare('SELECT * FROM ow_operational_brain_results WHERE id=?').get(resultId);requireThat(row,404,'UNKNOWN_OPERATIONAL_RESULT');
    const result=JSON.parse(row.payload_json);this.run(actor,row.run_id,row.context_hash,'read');
    requireThat(actor.role==='HUMAN' || row.producer_id===actor.id,403,'OPERATIONAL_RESULT_SCOPE_CONFLICT');
    const callback=this.db.prepare('SELECT payload_json FROM ow_operational_brain_callbacks WHERE result_id=?').get(resultId);
    return {result,callback:callback?JSON.parse(callback.payload_json):null,immutable:true};
  }
}
