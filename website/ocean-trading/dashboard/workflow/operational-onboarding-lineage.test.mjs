import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {OperationalPreparation,onboardingLineageDecisionId} from './operational-preparation.mjs';
import {WorkflowBackend} from './backend.mjs';
import {objectHash} from './common.mjs';

// Real SQLite and production lineage/snapshot checks; all authority is isolated fixture data.
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE ow_setup_receipts(id TEXT PRIMARY KEY,payload_json TEXT);
    CREATE TABLE ow_decisions(id TEXT PRIMARY KEY,request_id TEXT,case_id TEXT,binding_json TEXT,payload_json TEXT);
    CREATE TABLE ow_decision_revocations(decision_id TEXT PRIMARY KEY);
    CREATE TABLE ow_operational_decisions(id TEXT PRIMARY KEY,strategy_id TEXT,review_hash TEXT,scope TEXT,payload_json TEXT);`);
  db.prepare('INSERT INTO ow_setup_receipts VALUES(?,?)').run('S40.3','{"status":"PASS"}');
  const baseline=objectHash('mock-baseline'),expires=new Date(Date.now()+3600000).toISOString();
  const row={id:'mock-case',strategy_id:'mock-strategy',instance_id:'mock-instance',baseline_hash:baseline,candidate_hash:objectHash('later-candidate')};
  const current={baseline_hash:baseline};
  const snapshot={request_id:'mock-request',case_id:row.id,gate:'ONBOARDING',artifact_id:'mock-artifact',baseline_hash:baseline,
    candidate_hash:null,recipient_id:'mock-brain',authorized_tests:[],expires_at_utc:expires};
  const request={...snapshot,id:snapshot.request_id,state:'APPROVED',snapshot_json:JSON.stringify(snapshot),snapshot_hash:objectHash(snapshot),tests_json:'[]'};
  const payload={decision_id:'mock-decision',request_id:request.id,snapshot_hash:request.snapshot_hash,decision:'APPROVED',
    decided_by:'Wayne',decided_via:'AUTHORISED_OCEAN_UI',decided_at_utc:new Date().toISOString(),expires_at_utc:expires};
  const binding={case_id:row.id,strategy_id:row.strategy_id,instance_id:row.instance_id,gate:'ONBOARDING',artifact_id:request.artifact_id,baseline_hash:baseline,candidate_hash:null};
  const review={review_hash:objectHash('review-one'),context:{strategy_id:row.strategy_id,strategy_version:'mock-v1',strategy_code_hash:baseline,strategy_config_hash:objectHash('config')},
    profile_hash:objectHash('profile'),observed_profile_hash:objectHash('observed'),factual_binding_hash:objectHash('facts')};
  const artifact=JSON.stringify(review);
  const b={db,one(table,id){const value=table==='ow_cases'?row:table==='ow_approval_requests'?request:current;assert.ok(value);return value;},
    verifySnapshot:WorkflowBackend.prototype.verifySnapshot,artifactFor(r,id){assert.equal(r,row);assert.equal(id,request.artifact_id);return {content:Buffer.from(artifact)};}};
  function save(){db.prepare('INSERT OR REPLACE INTO ow_decisions VALUES(?,?,?,?,?)').run(payload.decision_id,request.id,row.id,JSON.stringify(binding),JSON.stringify(payload));}
  save();return {db,b,row,current,request,payload,binding,review,save,preparation:new OperationalPreparation(b)};
}

test('lineage IDs bind the source decision and exact review',()=>{
  const a=onboardingLineageDecisionId('mock-decision',objectHash('one'));
  assert.match(a,/^lineage:[a-f0-9]{64}$/);
  assert.equal(a,onboardingLineageDecisionId('mock-decision',objectHash('one')));
  assert.notEqual(a,onboardingLineageDecisionId('mock-decision',objectHash('two')));
  assert.throws(()=>onboardingLineageDecisionId('mock-decision','unknown'),/OPERATIONAL_REVIEW_HASH_REQUIRED/);
});

test('unchanged onboarding baseline survives later candidate research and different governed reviews',t=>{
  const f=fixture(t),oldPayload=f.db.prepare('SELECT payload_json FROM ow_decisions').get().payload_json;
  const first=f.preparation.reconcileOnboarding(f.review,'mock-decision');
  assert.equal(first.dataset_release_preserved,false);
  assert.equal(f.preparation.reconcileOnboarding(f.review,'mock-decision').decision_id,first.decision_id);
  const firstBytes=f.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(first.decision_id).payload_json;
  const second=f.preparation.reconcileOnboarding({...f.review,review_hash:objectHash('review-two')},'mock-decision');
  assert.notEqual(first.decision_id,second.decision_id);
  assert.equal(f.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE id=?').get(first.decision_id).payload_json,firstBytes);
  assert.equal(f.db.prepare('SELECT payload_json FROM ow_decisions').get().payload_json,oldPayload);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_decisions').get().n,2);
});

const invalid={
  'revoked decision':f=>f.db.prepare('INSERT INTO ow_decision_revocations VALUES(?)').run('mock-decision'),
  'expired decision':f=>{f.payload.expires_at_utc='2000-01-01T00:00:00Z';},
  'changed baseline':f=>{f.current.baseline_hash=objectHash('different');},
  'unapproved request':f=>{f.request.state='PENDING';},
  'wrong request binding':f=>{f.payload.request_id='other';},
  'wrong payload snapshot':f=>{f.payload.snapshot_hash=objectHash('other');},
  'wrong case':f=>{f.binding.case_id='other';},
  'wrong instance':f=>{f.binding.instance_id='other';},
  'wrong strategy':f=>{f.binding.strategy_id='other';},
  'wrong gate':f=>{f.binding.gate='DEVELOPMENT';},
  'wrong artifact':f=>{f.binding.artifact_id='other';},
  'forged human provenance':f=>{f.payload.decided_via='FIXTURE_SUBSTITUTION';},
  'tampered request snapshot':f=>{f.request.snapshot_json='{}';},
  'missing identity in artifact':f=>{f.b.artifactFor=()=>({content:Buffer.from('unrelated')});}
};
for(const [name,mutate] of Object.entries(invalid))test(`lineage rejects ${name} without a receipt`,t=>{
  const f=fixture(t);mutate(f);f.save();
  assert.throws(()=>f.preparation.reconcileOnboarding(f.review,'mock-decision'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ow_operational_decisions').get().n,0);
});
