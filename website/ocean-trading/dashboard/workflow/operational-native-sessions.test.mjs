import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest } from './common.mjs';
import { mockNativeProof } from './operational-native-sessions.test-fixtures.mjs';
import { readObservedSessionProofs, sessionEvidence, NATIVE_LOGGER_BUILD } from './operational-native-sessions.mjs';
import { OperationalLearning } from './operational-learning.mjs';
import { OperationalResearch } from './operational-research.mjs';

const telemetrySource='D:/Trading/CICD/worktrees/telemetry-s30-2';
const oldSource='88ba8c2214de6326b495037ca477e11a022dd9e7';
// Git blob is LF; the owner's f19afe... receipt hashes the CRLF checkout.
const schemaHash='sha256:ab361ff06b8634a4ce838acaf16cb81326cfba5d423fd4b81a7e66249ce2cfdf';
function fixture({producerPin=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-native-session-readonly-'));
  const filename=path.join(root,'telemetry.sqlite'),db=new DatabaseSync(filename);
  const source=producerPin?NATIVE_LOGGER_BUILD.source_commit:oldSource;
  const schema=execFileSync('git',['show',`${source}:src/sierra_trade_telemetry/schema.sql`],{cwd:telemetrySource,windowsHide:true});
  assert.equal(digest(schema),producerPin?'sha256:ca4bee67d0e3ba6237e70891ed0cb3475f89d4744438fdf5bf3ab87baec428ef':schemaHash,
    'immutable reviewed schema14 producer-contract fixture pin');
  db.exec(schema.toString());
  const context={run_id:'r',context_hash:digest('EXPLICIT_MOCK_CONTEXT')};
  const rows=Array.from({length:3},(_,i)=>({run_id:'r',trade_id:i+1}));
  const proof=mockNativeProof(context,rows,{month:9,firstDay:4});
  if(producerPin) {
    proof.run.study_name=`Sierra Trade Telemetry Logger ${NATIVE_LOGGER_BUILD.version}`;
    for(const observation of proof.observations)observation.logger_module_sha256=NATIVE_LOGGER_BUILD.module_sha256;
  }
  const insert=(table,values)=>{
    const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
    const object=Object.fromEntries(Object.entries(values).filter(([key])=>columns.has(key)));
    const keys=Object.keys(object);
    db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(object));
  };
  insert('replay_runs',{...proof.run,instance_name:'EXPLICIT_MOCK_ONLY'});
  insert('replay_run_context',proof.managed_context);insert('replay_run_attempts',proof.attempt);
  for(const receipt of proof.receipts)insert('telemetry_run_receipts',{...receipt,instance_name:'EXPLICIT_MOCK_ONLY',trade_account:'Sim1',
    observation_started_utc:proof.run.run_started_utc,observation_ended_utc:proof.run.run_ended_utc,fill_count:6,receipt_kind:'trades_observed'});
  for(const observation of proof.observations)insert('exchange_session_observations',{...observation,instance_name:'EXPLICIT_MOCK_ONLY'});
  for(const trade of proof.trades)insert('trades',{...trade,instance_name:'EXPLICIT_MOCK_ONLY',environment:'REPLAY',direction:'long'});
  for(const link of proof.links)insert('trade_exchange_session_links',link);
  for(const [index,fill] of proof.fills.entries()) {
    const common={instance_name:'EXPLICIT_MOCK_ONLY',run_id:fill.run_id,instance_id:fill.instance_id,trade_account:fill.trade_account,
      symbol:fill.symbol,internal_order_id:index+1,fill_datetime:fill.fill_datetime,quantity:5,fill_price:20000+index};
    insert('fills',{...common,fill_id:fill.fill_id+1,account_type_guess:'simulation',is_simulated:1,side:'buy'});
    insert('trade_legs',{...common,trade_id:fill.trade_id,leg_type:fill.leg_type,direction:'long'});
  }
  db.close();
  const binding={schema_version:'ocean-replay-run-bridge/v4',namespace:'OPERATIONAL',strategy_id:'s',instance_id:'i',
    factual_binding_hash:digest('EXPLICIT_MOCK_FACTUAL_BINDING'),expected_telemetry_version:NATIVE_LOGGER_BUILD.version,
    expected_telemetry_module_sha256:`sha256:${NATIVE_LOGGER_BUILD.module_sha256}`,
    expected_telemetry_module_path:path.join(telemetrySource,'build/releases/v0.5.45/SierraTradeTelemetryLogger_v0.5.45_64.dll')};
  const bindingFile=path.join(root,'binding.json');fs.writeFileSync(bindingFile,JSON.stringify(binding));
  const factualBindingHash=binding.factual_binding_hash;
  const backend={one:()=>({id:'r',strategy_id:'s',instance_id:'i',context_json:JSON.stringify(context)}),operationalLearning:{telemetryDb:filename,
    physicalBindingFile:bindingFile,classification:()=>({eligible:true,telemetry:{verified:true,
      physical_strategy_binding:{verified:true,factual_binding_hash:factualBindingHash,recorded_sierra_instance_id:proof.run.instance_id}}})}};
  return {filename,backend,rows,context,root,binding,bindingFile,edit(sql){const writer=new DatabaseSync(filename);try{writer.exec(sql);}finally{writer.close();}},
    close(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('actual schema14 reader joins native entry/finalexit/acceptedattempt/settings/rawfills read-only; absent logger build proof stays explicit',()=>{
  const f=fixture();try {
    const before=digest(fs.readFileSync(f.filename));
    f.backend.verifyNativeSessionReceipt=()=>({verified:true});
    const proofs=readObservedSessionProofs(f.backend,['r'],f.rows),proof=proofs.r;
    assert.equal(proof.proof_error,undefined);assert.equal(proof.observations[0].trading_day_date,45904);
    assert.equal(proof.managed_context.session_observation_mode,'sierra_trading_day_v1');
    assert.equal(proof.links.length,6);assert.equal(proof.fills.length,6);assert.equal(proof.attempt.start_command_id,'EXPLICIT_MOCK_START');
    const result=sessionEvidence({cohort:{eligible_runs:[{run_id:'r'}]},execution_sessions:proofs},f.rows);
    assert.equal(result.mapping_verified,true);assert.equal(result.mapped_entry_day_count,3);assert.equal(result.verified,false);
    assert.equal(result.conflicts[0].reason,'NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED');
    assert.equal(result.full_market_session_coverage_verified,false);assert.equal(result.statistical_independence_verified,false);
    assert.equal(digest(fs.readFileSync(f.filename)),before,'reader wrote no schema, rows or ledger bytes');
  }finally{f.close();}
});

test('real SQLite missing/conflicting links, fillidentity, attempts, mode or settings fail closed with exact reasons',()=>{
  for(const [sql,reason] of [
    ["DELETE FROM trade_exchange_session_links WHERE trade_id=1 AND link_role='entry'",'NATIVE_SESSION_EXACT_ENTRY_LINK_REQUIRED'],
    ["UPDATE fills SET trade_account='Sim2' WHERE fill_id=1",'NATIVE_SESSION_ACTUAL_FILL_JOIN_REQUIRED'],
    ["INSERT INTO replay_run_attempts(run_id,attempt_id,attempt_number,attempt_started_utc) VALUES('r',2,0,'2026-10-08T11:00:00Z'); UPDATE exchange_session_observations SET attempt_id=2",'NATIVE_SESSION_LINK_SCOPE_OR_TIME_CONFLICT'],
    ["UPDATE replay_run_context SET session_observation_mode=NULL",'NATIVE_SESSION_CONTEXT_CONFLICT'],
    ['UPDATE exchange_session_observations SET end_time1=80000','NATIVE_SESSION_CONFIGURATION_HASH_CONFLICT'],
    ['UPDATE exchange_session_observations SET trading_day_date=20250904 WHERE trading_day_date=45904','NATIVE_SESSION_DATE_VALUE_ENCODING_REQUIRED'],
    ['UPDATE telemetry_run_receipts SET closed_trade_count=2','NATIVE_SESSION_COMPLETION_RECEIPT_CONFLICT'],
    ["UPDATE exchange_session_observations SET data_quality_flags='unexpected_flag'",'NATIVE_SESSION_LINK_SCOPE_OR_TIME_CONFLICT'],
    ["UPDATE exchange_session_observations SET data_quality_flags='replay_rewind_observed'",'NATIVE_SESSION_LINK_SCOPE_OR_TIME_CONFLICT']]) {
    const f=fixture();try {f.edit(sql);assert.equal(readObservedSessionProofs(f.backend,['r'],f.rows).r.proof_error,reason);}
    finally{f.close();}
  }
});

test('source adapter cannot bypass physical/raw qualifications and schema13 cannot be retro-upgraded',()=>{
  const f=fixture();try {
    f.backend.operationalLearning.classification=()=>({eligible:true,telemetry:{verified:true,bypassed:true}});
    assert.equal(readObservedSessionProofs(f.backend,['r'],f.rows).r.proof_error,'NATIVE_SESSION_EXISTING_PHYSICAL_RAW_QUALIFICATION_REQUIRED');
    f.edit('DELETE FROM schema_version WHERE version=14');
    assert.equal(readObservedSessionProofs(f.backend,['r'],f.rows).r.proof_error,'NATIVE_SESSION_SCHEMA_14_REQUIRED');
  }finally{f.close();}
});

test('actual v545 recorded own-logger hash plus reviewed source/current config pin passes without granting IID/fullcoverage',()=>{
  const f=fixture({producerPin:true});try {
    const before=digest(fs.readFileSync(f.filename)),proofs=readObservedSessionProofs(f.backend,['r'],f.rows);
    assert.equal(proofs.r.producer_verification.verified,true);
    assert.equal(proofs.r.producer_verification.reviewed_build.source_commit,NATIVE_LOGGER_BUILD.source_commit);
    assert.deepEqual(proofs.r.producer_verification.recorded_hashes,[NATIVE_LOGGER_BUILD.module_sha256]);
    const evidence=sessionEvidence({cohort:{eligible_runs:[{run_id:'r'}]},execution_sessions:proofs},f.rows);
    assert.equal(evidence.verified,true);assert.equal(evidence.observed_session_count,3);
    assert.equal(evidence.statistical_independence_verified,false);assert.equal(evidence.full_market_session_coverage_verified,false);
    assert.equal(evidence.zero_trade_coverage_verified,false);assert.equal(digest(fs.readFileSync(f.filename)),before);
  }finally{f.close();}
});

test('syntactic recorded is not approved: rejected544/wrong/strategy/missing/mixed logger hashes fail closed',()=>{
  for(const [hash,reason] of [
    ['9b145fe3c9cd6661f860d97086308377bce4dd7af87184802afc736f4239274e','NATIVE_LOGGER_REVIEWED_PRODUCER_BUILD_CONFLICT'],
    ['99a76540e0c847e58f8f810e665f7d5c02247f56f0461842d5ff0bfc168852fa','NATIVE_LOGGER_REVIEWED_PRODUCER_BUILD_CONFLICT'],
    ['712b5fb5fc4c44d5090548218acae882522e2908eb2dacfdd22b6dd36f4d4099','NATIVE_LOGGER_REVIEWED_PRODUCER_BUILD_CONFLICT'],
    ['9a79'+'0'.repeat(60),'NATIVE_LOGGER_REVIEWED_PRODUCER_BUILD_CONFLICT'],
    [null,'NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED'],['invalid','NATIVE_LOGGER_RECORDED_BUILD_PROOF_REQUIRED']]) {
    const f=fixture({producerPin:true});try {
      f.edit(`UPDATE exchange_session_observations SET logger_module_sha256=${hash===null?'NULL':`'${hash}'`} WHERE trading_day_date=45904`);
      const proofs=readObservedSessionProofs(f.backend,['r'],f.rows);
      assert.equal(proofs.r.proof_error,undefined,'native mapping retained descriptively');
      assert.equal(proofs.r.producer_verification.verified,false);assert.equal(proofs.r.producer_verification.reason,reason);
      const evidence=sessionEvidence({cohort:{eligible_runs:[{run_id:'r'}]},execution_sessions:proofs},f.rows);
      assert.equal(evidence.mapping_verified,true);assert.equal(evidence.verified,false);assert.equal(evidence.observed_session_count,0);
    }finally{f.close();}
  }
});

test('recorded correct producer cannot override wrong current approved config/source pin or physical scope',()=>{
  for(const change of [binding=>{binding.expected_telemetry_module_sha256=digest('wrong');},
    binding=>{binding.expected_telemetry_version='v0.5.44';},binding=>{binding.instance_id='other';},
    binding=>{binding.factual_binding_hash=digest('other');}]) {
    const f=fixture({producerPin:true});try {
      change(f.binding);fs.writeFileSync(f.bindingFile,JSON.stringify(f.binding));
      const proof=readObservedSessionProofs(f.backend,['r'],f.rows).r;
      assert.equal(proof.producer_verification.verified,false);
      assert.equal(proof.producer_verification.reason,'NATIVE_LOGGER_APPROVED_PHYSICAL_BINDING_CONFLICT');
    }finally{f.close();}
  }
});

test('upstream Learning and downstream Research use the same real SQL producer proof; pin loss cannot claim sufficiency',()=>{
  const f=fixture({producerPin:true});try {
    const learner={backend:f.backend,telemetryDb:f.filename,db:{prepare:()=>({all:()=>[]})},
      legacyTelemetrySummary:OperationalLearning.prototype.legacyTelemetrySummary,
      nativeSessionEvidence:OperationalLearning.prototype.nativeSessionEvidence};
    const classification={context:f.context,reasons:[],telemetry:{causal_summary:{trades:3}}};
    const summary=()=>OperationalLearning.prototype.runSummary.call(learner,{id:'r'},classification,
      {minimum_sample_count:3,minimum_independent_session_count:3}).summary;
    assert.equal(summary().evidence_status,'SUFFICIENT');
    const bundle={cohort:{eligible_runs:[{run_id:'r'}]}};
    const read=()=>OperationalResearch.prototype.observedSessions.call({backend:f.backend},bundle,f.rows);
    const before=read().r.source_receipt_hash;
    assert.equal(sessionEvidence({...bundle,execution_sessions:read()},f.rows).observed_session_count,3);
    f.edit('UPDATE exchange_session_observations SET logger_module_sha256=NULL WHERE trading_day_date=45904');
    assert.equal(summary().evidence_status,'INSUFFICIENT');assert.equal(summary().independent_session_count,0);
    assert.equal(sessionEvidence({...bundle,execution_sessions:read()},f.rows).verified,false);
    assert.notEqual(read().r.source_receipt_hash,before,'immutable producer proof changes the continuation fingerprint');
    fs.writeFileSync(f.bindingFile,JSON.stringify({...f.binding,expected_telemetry_module_path:path.join(f.root,'absent.dll')}));
    assert.equal(read().r.producer_verification.verified,false);
  }finally{f.close();}
});

test('descriptive excluded history retains executed accounting/exact reasons and never opens holdout or TEST rows',()=>{
  const f=fixture();try {
    f.edit('UPDATE trades SET gross_currency_value=100,total_commission=10,net_profit_loss=90');
    const contexts={r:{dataset_partition:'DISCOVERY',learner_permission:'HISTORICAL_DISCOVERY'},
      holdout:{dataset_partition:'HOLDOUT',learner_permission:'HISTORICAL_DISCOVERY'},
      'test-run':{dataset_partition:'DISCOVERY',learner_permission:'HISTORICAL_DISCOVERY'}};
    const backend={one:(_table,id)=>({id,state:'COMPLETED',context_json:JSON.stringify({...f.context,...contexts[id]})})};
    const database=new DatabaseSync(f.filename,{readOnly:true}),opened=[];
    try {
      const reader={prepare:sql=>({all:id=>{opened.push(id);return database.prepare(sql).all(id);}})};
      const bundle={excluded_evidence:Object.keys(contexts).map(run_id=>({run_id,
        exclusion_reason_code:'RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT',exclusion_reason:'wrong strategy DLL; conflicting raw context'}))};
      const history=OperationalResearch.prototype.descriptiveHistory.call({backend},bundle,reader);
      assert.deepEqual(opened,['r']);assert.equal(history.recorded_trade_count,3);
      assert.equal(history.runs[0].accounting_reconciled,true);assert.equal(history.runs[0].accounting.net_profit_loss,270);
      assert.equal(history.runs[0].current_causal_support,false);
      assert.equal(history.runs[0].exclusion_reason,bundle.excluded_evidence[0].exclusion_reason);
      assert.equal(history.runs[0].recorded_physical_strata[0].recorded_instance_id,'EXPLICIT_MOCK_INSTANCE');
      assert.match(history.cannot_teach,/native session sufficiency/);
    }finally{database.close();}
  }finally{f.close();}
});
