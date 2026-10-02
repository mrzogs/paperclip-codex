import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareOperation,commitOperation} from './operator.mjs';
import {WorkflowBackend} from './backend.mjs';
import {PaperForwardPreparation} from './paper-forward-preparation.mjs';
import {objectHash,sealedHash} from './common.mjs';
import {issueOceanIdentity} from './auth.mjs';

const human={role:'HUMAN',id:'wayne-ocean-ui'};

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-s493-'));
  const operation=prepareOperation({action:'bootstrap',operator_id:'S-1-5-21-1000',root});commitOperation(operation);
  const examples=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url)));
  const profile={...examples['strategy-profile'],instrument_scope:['MNQ']};profile.profile_hash=sealedHash(profile,'profile_hash');
  const instance={...examples['strategy-registry'].execution_instances[0],capabilities:['PAPER_FORWARD'],status:'DRAFT'};
  const binding={instance,strategy_id:profile.strategy_id,strategy_code_hash:profile.strategy_code_hash,profile_hash:profile.profile_hash,state:'VERIFIED_FACTS_ONLY',operational_enabled:false};binding.binding_hash=sealedHash(binding,'binding_hash');
  operation.next.config.operational_factual_bindings=[binding];
  const consumer=issueOceanIdentity({identity_id:'paper-consumer',role:'TELEMETRY',namespace:'OPERATIONAL',audience:'Ocean workflow operational v1',credential_ref:'OCEAN_S493_PAPER_TOKEN',factual_binding_hash:binding.binding_hash,instance_ids:[instance.execution_instance_id],strategy_ids:[profile.strategy_id],scopes:['read']},operation.next.environment,new Date(Date.now()+7200000).toISOString());consumer.owner_evidence_sha256='3'.repeat(64);operation.next.config.identities.push(consumer);
  const backend=new WorkflowBackend(operation.next.config,operation.next.environment);
  const registry={...examples['strategy-registry'],profile_hash:profile.profile_hash,baseline_version:profile.baseline_version,execution_instances:[]};
  backend.db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run(`${profile.profile_id}:${profile.profile_version}`,profile.strategy_id,profile.profile_version,objectHash(profile),JSON.stringify(profile));
  backend.db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run(profile.strategy_id,`${profile.profile_id}:${profile.profile_version}`,1,profile.strategy_code_hash,JSON.stringify(registry));
  const version={version_id:'baseline-paper',strategy_id:profile.strategy_id,kind:'BASELINE',version:profile.baseline_version,code_hash:profile.strategy_code_hash,profile_key:`${profile.profile_id}:${profile.profile_version}`,artifact_id:null,case_id:null,registry_revision:1};
  backend.db.prepare('INSERT INTO ow_run_versions VALUES(?,?,?)').run(version.version_id,profile.strategy_id,JSON.stringify(version));
  const historical={content:'# S48.3 Historical Bootstrap Report\nHISTORICAL_RECONCILIATION / NO_NEW_COVERAGE'};
  backend.db.prepare('INSERT INTO ow_operational_brain_results VALUES(?,?,?,?,?,?,?)').run('historical-result','brain','historical-run','sha256:'+'4'.repeat(64),objectHash(historical),JSON.stringify(historical),new Date().toISOString());
  backend.db.prepare('INSERT INTO ow_operational_brain_callbacks VALUES(?,?,?,?,?)').run('historical-result','brain',objectHash({status:'COMPLETED'}),JSON.stringify({status:'COMPLETED'}),new Date().toISOString());
  return {root,backend,binding,close(){backend.close();fs.rmSync(root,{recursive:true,force:true});}};
}

test('S49.3 reserves the exact paper baseline as READY with a pending source handshake',()=>{
  const f=fixture();try{
    const paper=new PaperForwardPreparation(f.backend),options=paper.options(human);
    assert.equal(options.environment,'PAPER_FORWARD');assert.equal(options.source_handshake,'PENDING');assert.equal(options.live_real,'DISABLED');
    const start=new Date(Math.ceil(Date.now()/60000)*60000).toISOString(),end=new Date(Date.parse(start)+3600000).toISOString();
    const selection={run_id:'paper-forward-s493-isolated',strategy_id:options.strategy.strategy_id,version_id:options.version.version_id,instance_id:options.instance.execution_instance_id,expected_environment:'PAPER_FORWARD',purpose:'LEARNING',dataset_role:'FORWARD',start_utc:start,end_utc:end};
    const preview=paper.preview(human,{selection});
    assert.equal(preview.manifest.quality_status,'PARTIAL');assert.deepEqual(preview.manifest.gaps,['future interval incomplete']);assert.equal(preview.actual_source_start,false);
    const ready=paper.prepare(human,{selection,review_hash:preview.review.review_hash,confirmed:true,reason:'Isolated authenticated S49.3 confirmation'});
    assert.equal(ready.state,'READY');assert.equal(ready.source_handshake,'PENDING');assert.equal(ready.actual_source_start,false);assert.equal(ready.operational_enabled,false);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_operational_releases').get().n,0);
    const decisions=f.backend.db.prepare('SELECT payload_json FROM ow_operational_decisions WHERE review_hash=?').all(ready.review_hash).map(row=>JSON.parse(row.payload_json));assert.equal(decisions.length,3);assert.ok(decisions.every(decision=>decision.decided_via==='AUTHORISED_OCEAN_UI' && decision.decided_by==='wayne-ocean-ui'));
    const readback=f.backend.runs.read(human,ready.run_id);assert.equal(readback.context_status,'CURRENT');assert.equal(readback.context.expected_environment,'PAPER_FORWARD');assert.equal(readback.context.learner_permission,'SCOPED_LEARNING');
    assert.throws(()=>paper.options(human),/INSTANCE_ALREADY_RESERVED/);
  }finally{f.close();}
});

test('S49.3 rejects missing fresh confirmation and intervals beyond the current binding',()=>{
  const f=fixture();try{
    const paper=new PaperForwardPreparation(f.backend),options=paper.options(human),start=new Date(Math.ceil(Date.now()/60000)*60000).toISOString();
    const selection={run_id:'paper-forward-s493-negative',strategy_id:options.strategy.strategy_id,version_id:options.version.version_id,instance_id:options.instance.execution_instance_id,expected_environment:'PAPER_FORWARD',purpose:'LEARNING',dataset_role:'FORWARD',start_utc:start,end_utc:new Date(Date.parse(options.maximum_end_utc)+1000).toISOString()};
    assert.throws(()=>paper.preview(human,{selection}),/PAPER_FORWARD_INTERVAL_REJECTED/);
    selection.end_utc=new Date(Date.parse(start)+3600000).toISOString();const preview=paper.preview(human,{selection});
    assert.throws(()=>paper.prepare(human,{selection,review_hash:preview.review.review_hash,confirmed:false,reason:'No'}),/FRESH_PAPER_CONFIRMATION_REQUIRED/);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_runs').get().n,0);
  }finally{f.close();}
});
