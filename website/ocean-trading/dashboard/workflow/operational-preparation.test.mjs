import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowBackend } from './backend.mjs';
import { WorkflowStore } from './store.mjs';
import { RunManager } from './run-manager.mjs';
import { OperationalPreparation, RELEASE_SCOPES } from './operational-preparation.mjs';
import { API_VERSION, digest, objectHash, sealedHash } from './common.mjs';

const examples=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url),'utf8'));
const actor={id:'wayne-ocean-ui',role:'HUMAN',namespace:'OPERATIONAL'};
const sourceId='mock-completed-z25',producerId='mock-z25-telemetry';
const observedAt='2026-10-07T13:23:48.5023453+00:00',recordedAt='2026-10-07T13:23:48.811Z';

// MOCK-only databases/authority. Legacy shape and timestamps mirror event 4702,
// but no live ledger, credentials, reservations or native controller are used.
function fixture(t,{legacy=()=>{},modern=null,completionPatch={},progressPatch={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-preparation-mock-'));
  const store=new WorkflowStore(path.join(root,'workflow.sqlite')),db=store.db;
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const b=Object.create(WorkflowBackend.prototype);
  Object.assign(b,{store,db,environment:{},config:{python_executable:process.env.OCEAN_TRADING_PYTHON || 'python'}});
  b.runs=new RunManager(b);
  db.prepare('INSERT INTO ow_identities(id,role,metadata_json) VALUES(?,?,?)').run(producerId,'TELEMETRY','{"mock_only":true}');
  const profile={...structuredClone(examples['strategy-profile']),strategy_id:'mock-vwap',profile_id:'mock-profile'};
  profile.profile_hash=sealedHash(profile,'profile_hash');
  const profileKey=`${profile.profile_id}:${profile.profile_version}`;
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(profileKey,profile.strategy_id,profile.profile_version,digest(JSON.stringify(profile)),JSON.stringify(profile));
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(profile.strategy_id,profileKey,1,profile.strategy_code_hash,JSON.stringify({strategy_id:profile.strategy_id}));
  const instance={execution_instance_id:'mock-replay-two',strategy_id:profile.strategy_id,source_installation_id:'mock-sierra-replay-two',
    chartbook_id:'mock-frozen-chartbook',chart_id:'1',source_study_instance_id:'mock-study2',telemetry_producer_id:producerId,
    version_binding:profile.baseline_version,config_hash:profile.strategy_config_hash,account_alias:'Sim1',capabilities:['REPLAY'],status:'DRAFT',lease_run_id:null};
  const binding={strategy_id:profile.strategy_id,strategy_code_hash:profile.strategy_code_hash,profile_hash:profile.profile_hash,
    state:'VERIFIED_FACTS_ONLY',instance};
  binding.binding_hash=sealedHash(binding,'binding_hash');b.config.operational_factual_bindings=[binding];
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run(instance.execution_instance_id,profile.strategy_id,JSON.stringify(instance));
  const requested={start_utc:'2025-09-12T23:00:00Z',end_utc:'2025-09-30T23:00:00Z'};
  const manifest={...structuredClone(examples['dataset-manifest']),dataset_manifest_id:'mock-discovery-manifest',quality_status:'VERIFIED',gaps:[],
    partitions:[{...requested,partition:'DISCOVERY',symbol:'MNQZ25_FUT_CME',coverage_status:'COMPLETE'}],protected_intervals:[]};
  manifest.manifest_hash=sealedHash(manifest,'manifest_hash');
  const manifestKey=`${manifest.dataset_manifest_id}:${manifest.revision}`;
  db.prepare('INSERT INTO ow_datasets VALUES(?,?,?,?,?,?)').run(manifestKey,profile.strategy_id,manifest.revision,manifest.manifest_hash,'OPERATIONAL_MANIFEST',JSON.stringify(manifest));
  db.prepare('INSERT INTO ow_operational_pending VALUES(?,?,?,?,?,?)').run(manifestKey,profile.strategy_id,'DATASET_MANIFEST',digest('mock-pending'),JSON.stringify({manifest_text:JSON.stringify(manifest)}),recordedAt);
  let context={...structuredClone(examples['run-context']),run_id:sourceId,revision:1,strategy_id:profile.strategy_id,
    strategy_version:instance.version_binding,strategy_code_hash:profile.strategy_code_hash,strategy_config_hash:instance.config_hash,
    strategy_profile_id:profile.profile_id,strategy_profile_version:profile.profile_version,execution_instance_id:instance.execution_instance_id,
    source_installation_id:instance.source_installation_id,expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',
    dataset_manifest_id:manifest.dataset_manifest_id,dataset_manifest_revision:manifest.revision,dataset_manifest_hash:manifest.manifest_hash,
    dataset_partition:'DISCOVERY',case_id:null,experiment_id:null,candidate_id:null,historical_build_mode:'ADD_MISSING_HISTORY',
    observed_source_state:{observed_at_utc:recordedAt,environment:'UNKNOWN',simulation:null,replay:null,account_alias:null,source_schema_version:null,quality:'UNKNOWN'},
    learner_permission:'HISTORICAL_DISCOVERY',permission_reason:'Explicit MOCK-only source authority'};
  context.context_hash=sealedHash(context,'context_hash');
  const preparation=new OperationalPreparation(b),expires=new Date(Date.now()+3600000).toISOString();
  const review=preparation.validateReview({context,manifest_key:manifestKey,factual_binding_hash:binding.binding_hash,
    interval:requested,prior_exposure:'UNTOUCHED',expires_at_utc:expires});
  context=review.context;
  const plan={selection:{strategy_id:context.strategy_id,instance_id:context.execution_instance_id,purpose:context.evidence_purpose,
    permission_id:sourceId,partition_index:review.partition_index,interval:review.interval},context_hash:context.context_hash,operational_review:review};
  plan.plan_hash=objectHash(plan);const coverageKey=digest('mock-exact-coverage');
  db.prepare('INSERT INTO ow_runs VALUES(?,?,?,4,?,?)').run(sourceId,context.strategy_id,context.execution_instance_id,'COMPLETED',JSON.stringify(context));
  db.prepare('INSERT INTO ow_run_plans VALUES(?,?,?)').run(sourceId,coverageKey,JSON.stringify(plan));
  const decisions={};
  for(const scope of RELEASE_SCOPES){
    const decisionId=`mock-authority-${scope}`;decisions[scope]=decisionId;
    db.prepare('INSERT INTO ow_operational_decisions VALUES(?,?,?,?,?)').run(decisionId,context.strategy_id,review.review_hash,scope,
      JSON.stringify({decision:'APPROVED',decided_via:'AUTHORISED_OCEAN_UI',decided_by:actor.id,expires_at_utc:expires}));
  }
  db.prepare('INSERT INTO ow_operational_releases VALUES(?,?,?)').run(sourceId,context.context_hash,JSON.stringify({decisions}));
  const progress={axes:Object.fromEntries(['source_market','strategy_execution','processing_review'].map(axis=>[axis,[requested]])),
    observed_at_utc:recordedAt,watermark:requested.end_utc,pending_events:0,gaps:[],failures:[],...progressPatch};
  db.prepare('INSERT INTO ow_run_progress(run_id,payload_json) VALUES(?,?)').run(sourceId,JSON.stringify(progress));
  const completion={status:'COMPLETED',requested_coverage:[requested],observed_coverage:[requested],gaps:[],failures:[],
    processing_event_count:0,unique_canonical_trade_count:0,no_trade_interval_count:1,completed_at_utc:'2026-10-07T14:00:00Z',...completionPatch};
  db.prepare('INSERT INTO ow_coverage_receipts(run_id,coverage_key,status,payload_json) VALUES(?,?,?,?)').run(sourceId,coverageKey,'COMPLETED',JSON.stringify(completion));
  const handshake={instance:structuredClone(instance),context_hash:context.context_hash,plan_hash:plan.plan_hash,
    source_state:{observed_at_utc:observedAt,environment:'REPLAY',simulation:true,replay:true,account_alias:'Sim1',source_schema_version:'sierra-telemetry-sqlite/13',quality:'VERIFIED'}};
  function insertEvent(action,payload,mutate){
    const envelope={schema_version:API_VERSION,namespace:'OPERATIONAL',operational_action_allowed:true,entity_id:sourceId,
      action,actor_id:producerId,actor_role:'TELEMETRY',created_at_utc:recordedAt,payload};
    const row={entity_id:sourceId,action,actor_id:producerId,actor_role:'TELEMETRY',created_at_utc:recordedAt};
    mutate(row,envelope);
    db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)')
      .run(row.entity_id,row.action,row.actor_id,row.actor_role,row.created_at_utc,JSON.stringify(envelope));
  }
  if(legacy)insertEvent('run-manager.activate',{observed_handshake:structuredClone(handshake)},legacy);
  if(modern)insertEvent('operational.source-observed',{context_hash:context.context_hash,source_handshake:structuredClone(handshake)},modern);
  const input={source_run_id:sourceId,run_id:'mock-z25-reprocess',processing_id:'mock-z25-processing',expected_revision:4,confirmed:true,reason:'MOCK-only governed reprocessing'};
  return {b,db,preparation,input,context,plan,handshake,insertEvent,decisions,binding};
}

function unchanged(f){
  return Object.fromEntries(['ow_runs','ow_run_plans','ow_events','ow_profiles','ow_coverage_receipts','ow_operational_decisions']
    .map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function rejects(f,code){
  const before=unchanged(f);assert.throws(()=>f.preparation.reprocess(actor,f.input),error=>error.code===code);
  assert.deepEqual(unchanged(f),before);
}

test('preserved legacy activation permits only a READY reprocess with fresh UNKNOWN source state',t=>{
  const f=fixture(t),before=unchanged(f),result=f.preparation.reprocess(actor,f.input);
  assert.equal(result.state,'READY');assert.equal(result.actual_source_start,false);assert.equal(result.original_run_unchanged,true);
  assert.equal(result.context.observed_source_state.quality,'UNKNOWN');assert.equal(result.context.observed_source_state.environment,'UNKNOWN');
  assert.equal(result.context.context_hash,sealedHash(result.context,'context_hash'));
  assert.equal(result.plan.reprocess_of_run_id,sourceId);assert.equal(result.plan.processing_id,f.input.processing_id);
  for(const [table,rows] of Object.entries(before))for(const row of rows){
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id),row);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ow_events WHERE action='operational.source-observed'").get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_run_leases').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_events WHERE entity_id=?').get(f.input.run_id).n,1);
  assert.equal(f.preparation.reprocess(actor,f.input).idempotent,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_runs').get().n,2);
});

test('modern source observation remains accepted without a legacy event',t=>{
  const f=fixture(t,{legacy:null,modern:()=>{}});
  assert.equal(f.preparation.reprocess(actor,f.input).state,'READY');
});
test('an existing conflicting modern producer cannot fall back to a valid legacy activation',t=>{
  const f=fixture(t,{modern:(row,event)=>{row.actor_id=event.actor_id='other-producer';}});
  rejects(f,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
});
test('a later conflicting legacy activation cannot fall back to an earlier valid activation',t=>{
  const f=fixture(t);f.insertEvent('run-manager.activate',{observed_handshake:{...f.handshake,plan_hash:digest('other-plan')}},()=>{});
  rejects(f,'SOURCE_HANDSHAKE_MISMATCH');
});
test('missing activation or modern observation cannot authorize reprocessing',t=>{
  rejects(fixture(t,{legacy:null}),'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
});
for(const at of ['2026-10-07T13:21:48.811Z','2026-10-07T13:23:53.811Z'])test(`legacy activation accepts original freshness boundary ${at}`,t=>{
  const f=fixture(t,{legacy:(_row,event)=>{event.payload.observed_handshake.source_state.observed_at_utc=at;}});
  assert.equal(f.preparation.reprocess(actor,f.input).state,'READY');
});

const envelopeConflicts={
  'foreign recorded producer':(row,event)=>{row.actor_id=event.actor_id='other-producer';},
  'non-telemetry role':(row,event)=>{row.actor_role=event.actor_role='BRAIN';},
  'TEST namespace':(_row,event)=>{event.namespace='TEST';},
  'denied operational action':(_row,event)=>{event.operational_action_allowed=false;},
  'wrong event schema':(_row,event)=>{event.schema_version='other/v1';},
  'wrong payload entity':(_row,event)=>{event.entity_id='other-run';},
  'wrong recorded entity':(row,event)=>{row.entity_id=event.entity_id='other-run';},
  'wrong payload action':(_row,event)=>{event.action='other-action';},
  'wrong payload producer':(_row,event)=>{event.actor_id='other-producer';},
  'wrong payload role':(_row,event)=>{event.actor_role='BRAIN';},
  'mismatched event timestamp':(_row,event)=>{event.created_at_utc='2026-10-07T13:23:47.811Z';},
};
for(const [name,legacy] of Object.entries(envelopeConflicts))test(`legacy activation rejects ${name}`,t=>{
  rejects(fixture(t,{legacy}),'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
});
const handshakeConflicts={
  'wrong context hash':h=>{h.context_hash=digest('other-context');},
  'wrong plan hash':h=>{h.plan_hash=digest('other-plan');},
  'wrong physical instance':h=>{h.instance.execution_instance_id='other-instance';},
  'wrong installation':h=>{h.instance.source_installation_id='other-installation';},
  'wrong strategy':h=>{h.instance.strategy_id='other-strategy';},
  'wrong config hash':h=>{h.instance.config_hash=digest('other-config');},
  'wrong version binding':h=>{h.instance.version_binding='other-version';},
  'extra instance authority':h=>{h.instance.extra_authority=true;},
  'wrong chartbook':h=>{h.instance.chartbook_id='other-chartbook';},
  'wrong chart':h=>{h.instance.chart_id='2';},
  'wrong study':h=>{h.instance.source_study_instance_id='other-study';},
  'wrong instance producer':h=>{h.instance.telemetry_producer_id='other-producer';},
  'wrong account':h=>{h.source_state.account_alias='Sim2';},
  'live environment':h=>{h.source_state.environment='LIVE_REAL';},
  'non-simulation':h=>{h.source_state.simulation=false;},
  'non-replay':h=>{h.source_state.replay=false;},
  'unverified source':h=>{h.source_state.quality='UNKNOWN';},
  'missing source schema':h=>{h.source_state.source_schema_version=null;},
  'stale observation at activation':h=>{h.source_state.observed_at_utc='2026-10-07T13:21:48.810Z';},
  'future observation at activation':h=>{h.source_state.observed_at_utc='2026-10-07T13:23:53.812Z';},
};
for(const [name,change] of Object.entries(handshakeConflicts))test(`legacy activation rejects ${name}`,t=>{
  rejects(fixture(t,{legacy:(_row,event)=>change(event.payload.observed_handshake)}),'SOURCE_HANDSHAKE_MISMATCH');
});
for(const [name,change,code] of [
  ['unknown handshake fields',h=>{h.extra_authority=true;},'UNKNOWN_OR_AUTHORITY_FIELD'],
  ['missing handshake',(_h,event)=>{delete event.payload.observed_handshake;},'OBJECT_REQUIRED'],
  ['malformed observation date',h=>{h.source_state.observed_at_utc='not-a-date';},'SOURCE_HANDSHAKE_MISMATCH'],
  ['invalid simulation type',h=>{h.source_state.simulation='true';},'SHARED_CONTRACT_REJECTED'],
])test(`legacy activation rejects ${name} through the existing contract`,t=>{
  rejects(fixture(t,{legacy:(_row,event)=>change(event.payload.observed_handshake,event)}),code);
});
test('legacy activation rejects a malformed historical event date',t=>{
  const f=fixture(t,{legacy:(row,event)=>{row.created_at_utc=event.created_at_utc='not-a-date';}});
  rejects(f,'SOURCE_HANDSHAKE_MISMATCH');
});
test('legacy activation rejects malformed stored JSON without a new reservation',t=>{
  const f=fixture(t,{legacy:null});
  f.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)')
    .run(sourceId,'run-manager.activate',producerId,'TELEMETRY',recordedAt,'{');
  rejects(f,'AUTHENTICATED_SOURCE_PRODUCER_REQUIRED');
});

test('legacy compatibility does not bypass changed factual binding',t=>{
  const f=fixture(t);f.binding.instance.chart_id='2';rejects(f,'OPERATIONAL_FACTUAL_BINDING_CHANGED');
});
test('legacy compatibility does not bypass revoked run authority',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO ow_operational_revocations VALUES(?,?)').run(f.decisions.RUN_RELEASE,'{}');
  rejects(f,'RUN_RELEASE_AUTHORITY_CHANGED');
});
test('legacy compatibility does not bypass incomplete source coverage',t=>{
  rejects(fixture(t,{completionPatch:{observed_coverage:[]}}),'SOURCE_COVERAGE_MISMATCH');
});
test('legacy compatibility does not bypass a missing coverage axis',t=>{
  const f=fixture(t,{progressPatch:{axes:{source_market:[],strategy_execution:[],processing_review:[]}}});
  rejects(f,'THREE_AXIS_SOURCE_COVERAGE_REQUIRED');
});
test('legacy compatibility does not bypass unresolved current completion',t=>{
  rejects(fixture(t,{completionPatch:{processing_event_count:1}}),'CURRENT_COMPLETE_SOURCE_RECEIPT_REQUIRED');
});
test('legacy compatibility does not bypass a retained source lease',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO ow_run_leases VALUES(?,?,?,?,?)').run(sourceId,'mock-old-lease',producerId,1,recordedAt);
  rejects(f,'SOURCE_RUN_LEASE_STILL_PRESENT');
});
test('legacy compatibility does not bypass another active instance reservation',t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('mock-active-other',f.context.strategy_id,f.context.execution_instance_id,'ACTIVE',JSON.stringify(f.context));
  rejects(f,'INSTANCE_ALREADY_RESERVED');
});
test('legacy compatibility does not bypass source revision or human confirmation',t=>{
  const f=fixture(t);f.input.expected_revision=3;rejects(f,'REVISION_CONFLICT');
  f.input.expected_revision=4;f.input.confirmed=false;rejects(f,'EXPLICIT_REPROCESS_CONFIRMATION_REQUIRED');
});
