import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WorkflowStore } from './store.mjs';
import { digest, objectHash, WorkflowError } from './common.mjs';
import { OperationalLearning } from './operational-learning.mjs';
import { LEGACY_RESEARCH_VERSION as RESEARCH_VERSION, OperationalResearch, evaluateResearchV4 as evaluateResearch, boundedResearchRecommendation } from './operational-research.mjs';

function sample() {
  const rows=['a','b','c'].flatMap((run_id,index)=>Array.from({length:20},(_,i)=>({
    run_id,trade_id:index*100+i,entry_datetime:45000+index+i/24,direction:i<10?'long':'short',
    session_name:'US',regime_label:'known',gross_currency_value:i<10?20:-10,total_commission:1,
    net_profit_loss:i<10?19:-11,exit_causality:i%2?'stop':'unknown',
  })));
  const bundle={cohort:{eligible_runs:['a','b','c'].map((run_id,index)=>({run_id,observed_sample_count:20,
    independent_session_count:1,as_of_utc:`2026-10-07T0${index+1}:00:00Z`,context_hash:digest(`config-${run_id}`)})),
    aggregate:{observed_sample_count:60,eligible_run_count:3,independent_session_count:3,
      minimum_sample_count:60,minimum_independent_session_count:3,confidence:100,uncertainty:0,evidence_status:'SUFFICIENT'}},
    excluded_evidence:[{run_id:'protected-holdout',exclusion_reason:'PROTECTED'}],
    research_coverage:Object.fromEntries(['a','b','c'].map((run_id,index)=>[run_id,
      [{start_utc:`2025-0${index+1}-01T00:00:00Z`,end_utc:`2025-0${index+2}-01T00:00:00Z`}]]))};
  return {rows,bundle};
}

test('v4 evaluator reconciles recorded simulation fees and screens only entry direction',()=>{
  const {rows,bundle}=sample();const result=evaluateResearch(bundle,rows);
  assert.deepEqual(result.aggregate,{trades:60,gross_profit_loss:300,fees:60,net_profit_loss:240,
    wins:30,losses:30,flat:0,gross_wins:30,fee_flipped_wins:0});
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');
  assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].dimension,'direction');
  assert.equal(result.proposals[0].value,'short');assert.equal(result.missing_exit_attribution,30);
  assert.equal(result.candidate_validation.status,'NOT_DUE');assert.equal(result.authority.live_authorized,false);
  assert.equal(result.schema_version,RESEARCH_VERSION);
  assert.deepEqual(result.screening_policy,{minimum_distinct_declared_periods:3,minimum_direction_trades_per_retained_run:10,
    positive_net_exclusion_required_in_every_retained_run:true,basis:'EXISTING_DIRECTION_DISCOVERY_SCREEN_NOT_STATISTICALLY_CALIBRATED'});
  assert.equal(result.evidence_sufficiency.status,'SUFFICIENT');
  assert.equal(result.evidence_sufficiency.assessment_complete,true);
  assert.deepEqual(result.evidence_sufficiency.evaluated_direction_values,['long','short']);
  assert.ok(result.experiments.every(value=>value.dimension==='direction' && value.proposal_eligible && value.lookahead_safe));
  assert.ok(result.observational_breakdowns.every(value=>!value.proposal_eligible && !value.lookahead_safe && !value.supported));
  assert.deepEqual(result.authority,{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false});
});

test('losing session and regime groups never become proposals, even when all directions also lose',()=>{
  const {rows,bundle}=sample();
  for(const row of rows) {row.gross_currency_value=-10;row.net_profit_loss=-11;}
  const result=evaluateResearch(bundle,rows);
  assert.deepEqual(result.proposals.map(item=>[item.dimension,item.value]),[['direction','long'],['direction','short']]);
  assert.ok(result.observational_breakdowns.every(item=>item.observed_exclusion_delta>0 && !item.supported && !item.proposal_eligible));
  assert.ok(result.observational_breakdowns.every(item=>item.reason==='OBSERVATIONAL_LABEL_ONLY_NOT_LOOKAHEAD_SAFE'));
});

test('signal session labels remain observational despite profitable-looking exclusions or claimed availability',()=>{
  const {rows,bundle}=sample();
  for(const [index,row] of rows.entries()) {
    const loss=index%20<5 || (index%20>=10 && index%20<15);
    row.session_name=loss?'Asia':'London';row.regime_label=loss?'high-vol':'low-vol';
    row.gross_currency_value=loss?-10:20;row.net_profit_loss=loss?-11:19;
    // Synthetic audit regression: signal label Asia, recorded execution London 08:00.
    row.execution_session='London';row.execution_time_label='08:00';row.session_available_before_entry=true;
    row.entry_datetime=Math.trunc(row.entry_datetime)+8/24;
  }
  rows[0].trade_id=905;
  const result=evaluateResearch(bundle,rows);
  const asia=result.observational_breakdowns.find(item=>item.dimension==='session_name' && item.value==='Asia');
  assert.ok(asia.runs.every(run=>run.trades===10 && run.observed_exclusion_delta>0));
  assert.equal(asia.label_basis,'RECORDED_SIGNAL_SESSION_LABEL_NOT_EXECUTION_SESSION');
  assert.equal(asia.availability_basis,'PRE_ENTRY_LABEL_AVAILABILITY_NOT_INDEPENDENTLY_PROVEN');
  assert.equal(asia.lookahead_safe,false);assert.equal(asia.supported,false);
  assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');assert.deepEqual(result.proposals,[]);
  assert.equal(result.evidence_sufficiency.assessment_complete,true);
  assert.equal(result.candidate_validation.candidate_hash,null);
  assert.match(result.next_action,/no supported direction filter.*No actual candidate exists/i);
  assert.ok(result.limitations.some(value=>/Asia signal label.*London 08:00/.test(value)));
});

test('period labels distinguish declared coverage and Sierra decimal dates from independent sessions',()=>{
  const {rows,bundle}=sample();
  for(const [index,row] of rows.entries())row.entry_datetime=45000+(index%20)/24;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.observed_sierra_date_count,1);
  assert.equal(result.observed_dates,undefined);assert.equal(result.independent_observed_dates,undefined);
  assert.match(result.date_count_basis,/Sierra decimal.*not sessions or independent periods/);
  assert.equal(result.historical_periods.basis,'DECLARED_REQUESTED_COVERAGE');
  assert.equal(result.historical_periods.distinct_coverage_count,3);
  assert.equal(result.historical_periods.statistical_independence_verified,false);
  assert.ok(result.limitations.some(value=>/upstream session counts.*do not prove sessions/.test(value)));
});

test('different configurations with repeated coverage retain all accounting but supply only one support period',()=>{
  const {rows,bundle}=sample();const before=objectHash({rows,bundle});
  bundle.research_coverage.b=[
    {start_utc:'2025-01-16T00:00:00Z',end_utc:'2025-02-01T00:00:00Z'},
    {start_utc:'2025-01-01T00:00:00Z',end_utc:'2025-01-16T00:00:00Z'},
  ];
  const inputHash=objectHash({rows,bundle});
  const result=evaluateResearch(bundle,rows);
  assert.notEqual(bundle.cohort.eligible_runs[0].context_hash,bundle.cohort.eligible_runs[1].context_hash);
  assert.deepEqual(result.eligible_run_ids,['a','b','c']);
  assert.equal(result.aggregate.trades,60);assert.equal(result.aggregate.net_profit_loss,240);
  assert.deepEqual(result.per_run.map(run=>run.trades),[20,20,20]);
  assert.equal(result.historical_periods.distinct_coverage_count,2);
  assert.equal(result.historical_periods.runs[0].historical_period_id,result.historical_periods.runs[1].historical_period_id);
  assert.equal(result.historical_periods.accounting_runs_retained,true);
  assert.deepEqual(result.excluded_evidence,bundle.excluded_evidence,'no invented wire exclusion codes');
  assert.equal(result.cohort_hash,objectHash(bundle.cohort));assert.equal(result.evidence_hash,objectHash(rows));
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.deepEqual(result.proposals,[]);
  assert.deepEqual(result.evidence_sufficiency.reasons,['INSUFFICIENT_DISTINCT_DECLARED_PERIODS']);
  assert.deepEqual(result.evidence_sufficiency.evaluated_direction_values,[]);
  assert.match(result.next_action,/insufficient evidence, not an evaluated no-change finding/);
  assert.equal(objectHash({rows,bundle}),inputHash,'evaluator does not rewrite source evidence');
  assert.notEqual(inputHash,before,'fixture actually supplied repeated historical coverage');
});

test('later completion does not replace a qualified distinct configuration with the same coverage',()=>{
  const {rows,bundle}=sample();
  bundle.research_coverage.b=bundle.research_coverage.a;
  bundle.cohort.eligible_runs[0].as_of_utc='2026-10-07T04:00:00Z';
  const result=evaluateResearch(bundle,rows);
  assert.deepEqual(result.eligible_run_ids,['a','b','c']);
  assert.equal(result.aggregate.trades,60);assert.equal(result.historical_periods.distinct_coverage_count,2);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
});

test('unproven historical coverage cannot supply a direction proposal period',()=>{
  const {rows,bundle}=sample();delete bundle.research_coverage.b;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.trades,60);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.historical_periods.missing_coverage_run_ids,['b']);
  assert.deepEqual(result.evidence_sufficiency.missing_coverage_run_ids,['b']);
  assert.ok(result.evidence_sufficiency.reasons.includes('HISTORICAL_COVERAGE_NOT_PROVEN'));
  assert.ok(result.experiments.every(item=>!item.supported && item.reason==='HISTORICAL_COVERAGE_NOT_PROVEN'));
});

test('fee provenance is current logger observation, not verified historical broker fees',()=>{
  const {rows,bundle}=sample();const result=evaluateResearch(bundle,rows);
  assert.match(result.accounting_basis,/Recorded simulated execution gross P&L.*logger-recorded fees and net/);
  assert.deepEqual(result.fee_provenance,{basis:'OBSERVED_CURRENT_LOGGER_SCHEDULE',source_field:'total_commission',
    historical_broker_fee_schedule_independently_verified:false,
    note:'Fees are observed from the current simulation logger, not independently verified historical broker fees.'});
  assert.equal(result.aggregate.gross_profit_loss-result.aggregate.fees,result.aggregate.net_profit_loss);
  assert.ok(result.limitations.some(value=>/not verified historical broker execution/.test(value)));
});

test('mixed periods finish Research with no supported change rather than inventing a candidate',()=>{
  const {rows,bundle}=sample();for(const row of rows.filter(row=>row.run_id==='b' && row.direction==='short')) {
    row.gross_currency_value=10;row.net_profit_loss=9;
  }
  const result=evaluateResearch(bundle,rows);assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');
  assert.equal(result.evidence_sufficiency.status,'SUFFICIENT');
  assert.deepEqual(result.evidence_sufficiency.reasons,[]);
  assert.ok(result.experiments.every(item=>item.evidence_sufficient && !item.supported));
  assert.match(result.next_action,/recorded direction screen met its evidence floor/);
  assert.match(result.next_action,/does not evaluate all possible improvements/);
  assert.match(result.next_action,/No approval is pending/);
});

test('one fresh qualified period completes accounting but cannot claim an evaluated no-change finding',()=>{
  const fixture=sample();const rows=fixture.rows.filter(row=>row.run_id==='a');
  const bundle=fixture.bundle;bundle.cohort.eligible_runs=bundle.cohort.eligible_runs.slice(0,1);
  bundle.cohort.aggregate.observed_sample_count=rows.length;
  const before=objectHash({rows,bundle});const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(result.aggregate.trades,20);
  assert.equal(result.evidence_sufficiency.distinct_declared_periods,1);
  assert.deepEqual(result.evidence_sufficiency.reasons,['INSUFFICIENT_DISTINCT_DECLARED_PERIODS']);
  assert.equal(result.candidate_validation.status,'NOT_DUE');assert.deepEqual(result.proposals,[]);
  assert.equal(objectHash({rows,bundle}),before);
});

test('nine direction trades in one retained run is insufficient, not negative evidence',()=>{
  const {rows,bundle}=sample();
  rows.find(row=>row.run_id==='b' && row.direction==='short').direction='long';
  for(const row of rows){row.gross_currency_value=10;row.net_profit_loss=9;}
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');assert.deepEqual(result.proposals,[]);
  assert.deepEqual(result.evidence_sufficiency.sample_shortfalls,[{direction:'short',run_id:'b',observed_trades:9,required_trades:10}]);
  assert.deepEqual(result.evidence_sufficiency.evaluated_direction_values,['long']);
  assert.deepEqual(result.evidence_sufficiency.unevaluated_direction_values,['short']);
  assert.equal(result.experiments.find(item=>item.value==='short').reason,'INSUFFICIENT_DIRECTION_SAMPLE_IN_RETAINED_RUN');
  assert.equal(result.evidence_remediation.status,'RESEARCH_DESIGN_REVIEW_REQUIRED');
  assert.equal(result.evidence_remediation.additional_discovery_can_resolve_fixed_sample_shortfalls,false);
  assert.match(result.next_action,/Adding later runs cannot increase those frozen counts/);
  assert.match(result.next_action,/author and test a prospective sampling-unit\/protocol revision under the existing engineering authorization/);
});

test('adding a third qualified period resolves period count but never a frozen retained-segment sample shortfall',()=>{
  const {rows,bundle}=sample();
  rows.find(row=>row.run_id==='a' && row.direction==='short').direction='long';
  for(const row of rows){row.gross_currency_value=10;row.net_profit_loss=9;}
  const later=rows.filter(row=>row.run_id==='c'),original=rows.filter(row=>row.run_id!=='c');
  bundle.cohort.eligible_runs=bundle.cohort.eligible_runs.filter(run=>run.run_id!=='c');
  bundle.cohort.aggregate.observed_sample_count=original.length;
  const before=objectHash(original),two=evaluateResearch(bundle,original);
  assert.equal(two.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(two.evidence_remediation.missing_distinct_coverage_count,1);
  assert.equal(two.evidence_remediation.requires_design_review,true);
  bundle.cohort.eligible_runs.push({run_id:'c',observed_sample_count:later.length});
  bundle.cohort.aggregate.observed_sample_count=original.length+later.length;
  const three=evaluateResearch(bundle,[...original,...later]);
  assert.equal(three.outcome,'INSUFFICIENT_EVIDENCE');assert.equal(three.evidence_remediation.missing_distinct_coverage_count,0);
  assert.deepEqual(three.evidence_sufficiency.sample_shortfalls,two.evidence_sufficiency.sample_shortfalls);
  assert.equal(three.evidence_remediation.requires_design_review,true);assert.equal(three.evidence_remediation.policy_change_authorized,false);
  assert.deepEqual(three.eligible_run_ids,['a','b','c']);assert.equal(three.aggregate.trades,60);
  assert.equal(objectHash(original),before);assert.equal(three.screening_policy.minimum_direction_trades_per_retained_run,10);
  assert.match(three.next_action,/short in a \(9\/10\)/);assert.doesNotMatch(three.next_action,/collect.*until.*ten/);
});

test('period-only missing evidence is collectable while missing coverage proof requires exact source repair',()=>{
  const {rows,bundle}=sample();
  bundle.cohort.eligible_runs=bundle.cohort.eligible_runs.filter(run=>run.run_id!=='c');
  const retained=rows.filter(row=>row.run_id!=='c');bundle.cohort.aggregate.observed_sample_count=retained.length;
  const result=evaluateResearch(bundle,retained);
  assert.equal(result.evidence_remediation.status,'QUALIFIED_EVIDENCE_REQUIRED');
  assert.equal(result.evidence_remediation.requires_design_review,false);
  assert.equal(result.evidence_remediation.missing_distinct_coverage_count,1);
  assert.match(result.next_action,/additional genuinely distinct, qualified non-live discovery/);
  delete bundle.research_coverage.a;
  const missing=evaluateResearch(bundle,retained);
  assert.deepEqual(missing.evidence_remediation.missing_coverage_run_ids,['a']);
  assert.match(missing.next_action,/Verify original requested coverage and provenance for retained runs a/);
});

test('a supported direction survives an explicitly partial screen without declaring every group evaluated',()=>{
  const {rows,bundle}=sample();
  rows.find(row=>row.run_id==='b' && row.direction==='long').direction='short';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'EXPLORATORY_PROPOSAL');assert.equal(result.evidence_sufficiency.assessment_complete,false);
  assert.deepEqual(result.proposals.map(item=>item.value),['short']);
  assert.deepEqual(result.evidence_sufficiency.sample_shortfalls,[{direction:'long',run_id:'b',observed_trades:9,required_trades:10}]);
  assert.match(result.next_action,/Other recorded direction groups remain unassessed/);
  assert.equal(result.candidate_validation.candidate_hash,null);
});

test('zero direction samples in a retained run and unknown-only directions remain insufficient',()=>{
  const {rows,bundle}=sample();for(const row of rows.filter(row=>row.run_id==='b'))row.direction='long';
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.evidence_sufficiency.sample_shortfalls,[{direction:'short',run_id:'b',observed_trades:0,required_trades:10}]);
  for(const row of rows)row.direction='unknown';
  const unknownOnly=evaluateResearch(bundle,rows);
  assert.equal(unknownOnly.outcome,'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(unknownOnly.evidence_sufficiency.reasons,['NO_RECORDED_DIRECTION_GROUPS']);
  assert.deepEqual(unknownOnly.experiments,[]);assert.deepEqual(unknownOnly.proposals,[]);
});

test('empty qualified coverage cannot pass evidence sufficiency by vacuous checks',()=>{
  const {bundle}=sample();bundle.cohort.eligible_runs=[];bundle.cohort.aggregate.observed_sample_count=0;
  const result=evaluateResearch(bundle,[]);
  assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
  assert.equal(result.evidence_sufficiency.assessment_complete,false);assert.equal(result.aggregate.trades,0);
  assert.ok(result.evidence_sufficiency.reasons.includes('HISTORICAL_COVERAGE_NOT_PROVEN'));
});

test('ten samples meets the unchanged floor but zero net exclusion cannot pass a proposal',()=>{
  const {rows,bundle}=sample();
  for(const row of rows.filter(row=>row.direction==='short')){row.gross_currency_value=1;row.net_profit_loss=0;}
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.outcome,'NO_SUPPORTED_CHANGE');assert.equal(result.evidence_sufficiency.assessment_complete,true);
  assert.deepEqual(result.evidence_sufficiency.sample_shortfalls,[]);
  assert.ok(result.experiments.every(item=>item.reason==='DIRECTION_LOSS_NOT_REPEATED_IN_EVERY_RETAINED_RUN'));
});

test('flat gross trades losing after fees count as net losses',()=>{
  const {rows,bundle}=sample();rows[0].gross_currency_value=0;rows[0].net_profit_loss=-1;
  rows[1].gross_currency_value=0.5;rows[1].net_profit_loss=-0.5;
  const result=evaluateResearch(bundle,rows);
  assert.equal(result.aggregate.losses,32);assert.equal(result.aggregate.fee_flipped_wins,1);
});

test('original accounting, exact counts, isolation and duplicate failures block Research',()=>{
  const {rows,bundle}=sample();
  assert.throws(()=>evaluateResearch(bundle,[...rows,rows[0]]),/RESEARCH_DUPLICATE_TRADE/);
  assert.throws(()=>evaluateResearch(bundle,rows.slice(1)),/RESEARCH_SAMPLE_COUNT_CONFLICT/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],run_id:'protected-holdout'},...rows.slice(1)]),/RESEARCH_FOREIGN_EVIDENCE/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],net_profit_loss:null},...rows.slice(1)]),/RESEARCH_FEE_RECONCILIATION_FAILED/);
  assert.throws(()=>evaluateResearch(bundle,[{...rows[0],total_commission:99},...rows.slice(1)]),/RESEARCH_FEE_RECONCILIATION_FAILED/);
});

function queueFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocean-research-'));
  const file=path.join(root,'workflow.sqlite');let store=new WorkflowStore(file);
  const db=store.db;const hash=digest('baseline');
  const mockContext=run_id=>({run_id,context_hash:digest(`context-${run_id}`),strategy_profile_id:'p',strategy_profile_version:'1',
    strategy_code_hash:hash,strategy_config_hash:digest('config'),dataset_manifest_id:'dataset',dataset_manifest_revision:1,
    dataset_manifest_hash:digest('dataset'),execution_instance_id:'i'});
  db.prepare('INSERT INTO ow_profiles VALUES(?,?,?,?,?)').run('p','s','1',hash,'{}');
  db.prepare('INSERT INTO ow_strategies VALUES(?,?,?,?,?)').run('s','p',1,hash,'{}');
  db.prepare('INSERT INTO ow_instances VALUES(?,?,?)').run('i','s','{}');
  db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('r','s','i','COMPLETED',JSON.stringify(mockContext('r')));
  db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,?)")
    .run('case','s','i','r',hash,JSON.stringify({origin:'OPERATIONAL_LEARNING',registry_revision:1,
      registry_reconciliation_id:'mock-registry',registry_record_sha256:digest('registry')}));
  const content=JSON.stringify({schema_version:'ocean-operational-learning-recommendation/v1',
    authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false}});
  db.prepare('INSERT INTO ow_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('a','s','r','case','brain','strategy','RECOMMENDATION',null,hash,'[]',JSON.stringify({content_hash:digest(content)}),Buffer.from(content));
  const identity={identity_id:'brain',role:'BRAIN',namespace:'OPERATIONAL',strategy_ids:['s'],instance_ids:['i'],
    scopes:['read','artifact.write','event.write'],expires_at_utc:new Date(Date.now()+3600000).toISOString()};
  store.registerIdentity(identity);
  const actor={id:'brain',role:'BRAIN',namespace:'OPERATIONAL'};
  const backend={db,store,config:{identities:[identity],browser:{subject_id:'wayne-ocean-ui'}},auth:{human:{state:'CONFIGURED'}},
    one:(table,id)=>backend.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
    baseline:row=>{assert.equal(row.baseline_hash,backend.one('ow_strategies','s').baseline_hash);},
    artifactFor:(_,id)=>backend.one('ow_artifacts',id),event(entity,action,actor,payload){
      backend.db.prepare('INSERT INTO ow_events(entity_id,action,actor_id,actor_role,created_at_utc,payload_json) VALUES(?,?,?,?,?,?)')
        .run(entity,action,actor.id,actor.role || 'BRAIN',new Date().toISOString(),JSON.stringify({payload}));
    },
    // Explicit mock-only qualification; these queue fixtures do not prove physical execution.
    operationalLearning:{enabled:true,brainActor:()=>actor,classification:()=>({eligible:true,reasons:[],telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'}}),cohort:run=>({cohort:{eligible_runs:[{run_id:run.id}]}})},
    writeArtifact(_actor,data) {
      backend.db.prepare('INSERT INTO ow_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(data.artifact_id,'s',data.run_id,
        data.case_id,'brain',data.recipient_id,data.kind,null,hash,JSON.stringify(data.dependency_ids),
        JSON.stringify({content_hash:data.content_hash}),Buffer.from(data.content));
    }};
  // These retained regressions deliberately exercise the frozen v4 policy.
  let worker=new OperationalResearch(backend);worker.version=RESEARCH_VERSION;
  return {backend,file,actor,get worker(){return worker;},captureForCompletion(job,{rows,bundle}) {
    for(const item of bundle.cohort.eligible_runs) {
      if(item.run_id==='a') {item.run_id='r';for(const row of rows)if(row.run_id==='a')row.run_id='r';
        bundle.research_coverage.r=bundle.research_coverage.a;delete bundle.research_coverage.a;}
      if(!backend.one('ow_runs',item.run_id))backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)')
        .run(item.run_id,'s','i','COMPLETED',JSON.stringify(mockContext(item.run_id)));
      item.context_hash=mockContext(item.run_id).context_hash;
    }
    worker.evidence=()=>({rows,bundle,row:backend.one('ow_cases','case'),context:mockContext('r'),completion_hash:digest('completion'),recipient:'strategy'});
    return worker.capture(job).result;
  },restart(){store.close();store=new WorkflowStore(file);backend.store=store;backend.db=store.db;worker=new OperationalResearch(backend);worker.version=RESEARCH_VERSION;},
    close(){store.close();fs.rmSync(root,{recursive:true,force:true});}};
}

function installComparableCohort(f) {
  // Use the REAL learner cohort/evidenceIdentity supersession algorithm. Only
  // classification/summary providers are isolated fixtures; no live telemetry/API.
  const learner=new OperationalLearning(f.backend,{enabled:true});
  const coverage=[{start_utc:'2025-01-01T00:00:00Z',end_utc:'2025-02-01T00:00:00Z'}];
  learner.classification=()=>({eligible:true,reasons:[],context:{strategy_version:'1',strategy_code_hash:digest('code'),
    strategy_config_hash:digest('config'),strategy_profile_id:'p',strategy_profile_version:'1',execution_instance_id:'i',
    source_installation_id:'replay',expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',
    dataset_partition:'DISCOVERY',learner_permission:'HISTORICAL_DISCOVERY'},summary:{completion:{requested_coverage:coverage}}});
  learner.evidencePolicy=()=>({minimum_sample_count:10,minimum_independent_session_count:1});
  learner.runSummary=run=>({summary:{run_id:run.id,observed_sample_count:20,independent_session_count:1,
    source_record_ids:[run.id]},metrics:{},telemetry:{}});
  f.backend.operationalLearning=learner;
  return learner;
}

function addNewerComparableCase(f) {
  f.backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('U25','s','i','COMPLETED','{}');
  f.backend.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,?)")
    .run('case-u25','s','i','U25',digest('baseline'),JSON.stringify({origin:'OPERATIONAL_LEARNING'}));
  const content=Buffer.from(f.backend.one('ow_artifacts','a').content).toString('utf8');
  f.backend.writeArtifact(null,{artifact_id:'a-u25',case_id:'case-u25',run_id:'U25',recipient_id:'strategy',kind:'RECOMMENDATION',
    content,content_hash:digest(content),dependency_ids:[]});
}

function historicalFixture(version='ocean-cumulative-research/v2') {
  const f=queueFixture();
  const id=`research-${digest(`case:a:${version}`).slice(-24)}`;
  const artifactId=`test-research-result-${id.slice('research-'.length)}`;
  const report=JSON.stringify({schema_version:version,outcome:'NO_SUPPORTED_CHANGE',next_action:'Original v2 report instruction.'});
  const input=JSON.stringify({result:JSON.parse(report),evidence:{historical:true}});
  const request=JSON.stringify({correlation:{job_id:id},historical:true});
  f.backend.writeArtifact(null,{artifact_id:artifactId,case_id:'case',run_id:'r',recipient_id:'strategy',kind:'OUTCOME',
    content:report,content_hash:digest(report),dependency_ids:['a']});
  f.backend.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,
    next_attempt_ms,created_at_utc,input_json,input_hash,brain_request_json,brain_request_hash,result_artifact_id,result_hash)
    VALUES(?,?,?,?,?,'COMPLETED',?,?,?,?,?,?,?,?)`).run(id,'case','a',JSON.parse(f.backend.one('ow_artifacts','a').manifest_json).content_hash,
      version,0,'2026-10-07T00:00:00Z',input,digest(input),request,digest(request),artifactId,digest(report));
  f.backend.db.prepare("UPDATE ow_cases SET work_status='COMPLETED' WHERE id='case'").run();
  const learner=installComparableCohort(f);
  const original=f.backend.one('ow_research_jobs',id);
  const originalArtifact=f.backend.one('ow_artifacts',artifactId);
  return {...f,legacyId:id,original,originalArtifact,
    get worker(){return f.worker;},
    restart(){f.restart();learner.db=f.backend.db;},
    supersede(){addNewerComparableCase(f);},
    assertPreserved() {
      assert.deepEqual(f.backend.one('ow_research_jobs',id),original);
      assert.deepEqual(f.backend.one('ow_artifacts',artifactId),originalArtifact);
      assert.equal(f.backend.one('ow_cases','case').work_status,'COMPLETED');
    }};
}

test('real SQLite queue commits before delivery and enqueues idempotently across restart',()=>{
  const f=queueFixture();try {
    const first=f.backend.store.transaction(()=>f.worker.enqueue('case','a'));
    f.restart();const again=f.worker.enqueue('case','a');assert.equal(first.id,again.id);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,1);
    assert.equal(again.state,'PENDING');
  }finally{f.close();}
});

test('v4 jobs and results append without claiming, relabelling or rewriting v2 history',()=>{
  for(const state of ['PENDING','COMPLETED']) {
    const f=queueFixture();try {
      const version='ocean-cumulative-research/v2';
      const legacyId=`research-${digest(`case:a:${version}`).slice(-24)}`;
      const legacyArtifact=`test-research-result-${legacyId.slice('research-'.length)}`;
      const legacyReport=JSON.stringify({schema_version:version,outcome:'EXPLORATORY_PROPOSAL',observed_dates:3});
      f.backend.writeArtifact(null,{artifact_id:legacyArtifact,case_id:'case',run_id:'r',recipient_id:'strategy',kind:'OUTCOME',
        content:legacyReport,content_hash:digest(legacyReport),dependency_ids:['a']});
      const sourceHash=JSON.parse(f.backend.one('ow_artifacts','a').manifest_json).content_hash;
      f.backend.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,
        next_attempt_ms,created_at_utc,input_json,input_hash,result_artifact_id,result_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(legacyId,'case','a',sourceHash,
          version,state,0,'2026-10-07T00:00:00Z',legacyReport,digest(legacyReport),
          state==='COMPLETED'?legacyArtifact:null,state==='COMPLETED'?digest(legacyReport):null);
      const original=f.backend.one('ow_research_jobs',legacyId);
      const originalArtifact=f.backend.one('ow_artifacts',legacyArtifact);
      const appended=f.worker.enqueue('case','a');
      assert.equal(appended.analysis_version,RESEARCH_VERSION);assert.notEqual(appended.id,legacyId);
      const job=f.worker.claim();assert.equal(job.id,appended.id);assert.equal(job.analysis_version,RESEARCH_VERSION);
      const result=f.captureForCompletion(job,sample());const status=f.worker.complete(job,result,f.actor,'strategy');
      assert.equal(status.report.schema_version,RESEARCH_VERSION);assert.notEqual(status.result_artifact_id,legacyArtifact);
      f.restart();
      assert.deepEqual(f.backend.one('ow_research_jobs',legacyId),original);
      assert.deepEqual(f.backend.one('ow_artifacts',legacyArtifact),originalArtifact);
      assert.equal(f.worker.enqueue('case','a').id,appended.id);
      assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,2);
      assert.equal(f.worker.claim(),null,'v4 worker never claims the remaining v2 job');
    }finally{f.close();}
  }
});

test('real cohort supersession skips completed U version backfill and re-ACK retains the historical v2 job',()=>{
  const f=historicalFixture();try {
    f.supersede();
    assert.throws(()=>f.backend.operationalLearning.cohort(f.backend.one('ow_runs','r')),
      error=>error.code==='TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
    for(let i=0;i<3;i++) {
      f.worker.reconcile();
      assert.equal(f.worker.enqueue('case','a').id,f.legacyId,'re-ACK uses the already completed historical job');
    }
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE case_id='case'").get().n,1);
    const status=f.worker.statusForCase('case');
    assert.equal(status.state,'COMPLETED');assert.equal(status.analysis_version,'ocean-cumulative-research/v2');
    assert.equal(status.historical,true);assert.equal(status.current_trigger_eligible,undefined);assert.equal(status.version_backfill_skipped,true);
    assert.match(status.next_action,/Historical Research.*Completed cases are not version backfilled.*No current version backfill/);
    const current=f.worker.claim();assert.equal(current.case_id,'case-u25');
    assert.equal(current.analysis_version,RESEARCH_VERSION);assert.equal(f.worker.claim(),null);
    f.restart();f.worker.reconcile();
    assert.equal(f.worker.statusForCase('case').job_id,f.legacyId);
    f.assertPreserved();
  }finally{f.close();}
});

test('completed cases are not version backfilled even when their trigger still qualifies',()=>{
  const f=historicalFixture();try {
    assert.equal(f.backend.operationalLearning.cohort(f.backend.one('ow_runs','r')).cohort.eligible_runs[0].run_id,'r');
    f.worker.reconcile();assert.equal(f.worker.enqueue('case','a').id,f.legacyId);
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE case_id='case'").get().n,1);
    assert.equal(f.worker.claim(),null);f.assertPreserved();
  }finally{f.close();}
});

test('old v1 RETRY Brain422 attempts6 stays immutable superseded history behind completed v2 after two restarts',()=>{
  const f=historicalFixture();try {
    const oldId='old-v1-retry';
    f.backend.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,attempts,
      next_attempt_ms,created_at_utc,last_error) VALUES(?,?,?,?,?,'RETRY',6,0,?,?)`).run(oldId,'case','a',f.original.artifact_hash,
      'ocean-cumulative-research/v1','2026-10-06T00:00:00Z','Brain422 recommendation.content >50000');
    const before=f.backend.one('ow_research_jobs',oldId);
    for(let i=0;i<2;i++) {
      f.restart();f.worker.reconcile();assert.equal(f.worker.claim(),null);
      const status=f.worker.statusForCase('case');
      assert.equal(status.job_id,f.legacyId);assert.equal(status.state,'COMPLETED');
      const old=status.skipped_version_backfill_jobs.find(job=>job.job_id===oldId);
      assert.ok(old);assert.equal(old.actionable,false);assert.equal(old.effective_state,'HISTORICAL_SUPERSEDED');
      assert.doesNotMatch(status.next_action,/retry Research automatically|Brain422/);
      assert.deepEqual(f.backend.one('ow_research_jobs',oldId),before);f.assertPreserved();
    }
  }finally{f.close();}
});

function seedVersionBackfill(f,state='PENDING',snapshot=null) {
  // Isolated fixture reproduces a pre-fix backfill record, not a runtime DB repair.
  const id=`research-${digest(`case:a:${RESEARCH_VERSION}`).slice(-24)}`;
  const input=snapshot?JSON.stringify(snapshot):null;
  f.backend.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,
    attempts,next_attempt_ms,created_at_utc,input_json,input_hash,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,'case','a',f.original.artifact_hash,RESEARCH_VERSION,state,state==='RETRY'?3:0,0,'2026-10-07T01:00:00Z',
      input,input?digest(input):null,state==='RETRY'?'TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT':null);
  return f.backend.one('ow_research_jobs',id);
}

test('uncaptured pending/retry backfills never retry or hide the completed historical report across restart',()=>{
  for(const state of ['PENDING','RETRY']) {
  const f=historicalFixture();try {
    const pending=seedVersionBackfill(f,state);
    assert.equal(pending.input_json,null);
    f.supersede();f.worker.reconcile();
    assert.equal(f.worker.claim().case_id,'case-u25','historical backfill does not starve the current U25 job');
    for(let i=0;i<3;i++) {assert.equal(f.worker.claim(),null);f.worker.reconcile();}
    f.restart();assert.equal(f.worker.claim(),null);
    assert.deepEqual(f.backend.one('ow_research_jobs',pending.id),pending,'no attempts, retries, state change or input rewrite');
    const status=f.worker.statusForCase('case');
    assert.equal(status.job_id,f.legacyId);assert.equal(status.state,'COMPLETED');assert.equal(status.last_error,null);
    assert.deepEqual(status.skipped_version_backfill_jobs,[{job_id:pending.id,analysis_version:RESEARCH_VERSION,state,input_hash:null,
      reason:'COMPLETED_HISTORICAL_CASE_VERSION_BACKFILL',effective_state:'HISTORICAL_SUPERSEDED',actionable:false}]);
    assert.equal(status.version_backfill_skipped,true);f.assertPreserved();
  }finally{f.close();}
  }
});

test('completed-case backfill with frozen input remains immutable history, unclaimed and never rebased',()=>{
  const f=historicalFixture();try {
    const {rows,bundle}=sample();
    const captured={result:evaluateResearch(bundle,rows),evidence:{bundle:{cohort:bundle.cohort,excluded_evidence:bundle.excluded_evidence},
      row:{...f.backend.one('ow_cases','case')},context:{},completion_hash:digest('completion'),recipient:'strategy'}};
    const original=seedVersionBackfill(f,'PENDING',captured);
    f.supersede();f.restart();
    assert.equal(f.worker.claim(),null,'captured input does not reopen a completed case');
    f.worker.evidence=()=>{throw Error('must not rebase captured history onto U25');};
    assert.deepEqual(f.worker.capture(original),captured);
    const status=f.worker.statusForCase('case');
    assert.equal(status.state,'COMPLETED');assert.equal(status.analysis_version,'ocean-cumulative-research/v2');
    assert.equal(status.skipped_version_backfill_jobs[0].input_hash,original.input_hash);
    assert.deepEqual(f.backend.one('ow_research_jobs',original.id),original);
    assert.equal(f.backend.one('ow_research_jobs',original.id).input_json,original.input_json);
    assert.equal(f.backend.one('ow_research_jobs',original.id).input_hash,original.input_hash);
    assert.equal(status.current_trigger_eligible,undefined);f.assertPreserved();
  }finally{f.close();}
});

test('completed historical status/re-ACK/reconciliation do not require live cohort revalidation',()=>{
  const f=historicalFixture();try {
    f.backend.operationalLearning.cohort=()=>{throw new WorkflowError(503,'TELEMETRY_UNAVAILABLE');};
    f.worker.reconcile();assert.equal(f.worker.enqueue('case','a').id,f.legacyId);
    assert.equal(f.worker.statusForCase('case').state,'COMPLETED');
    assert.equal(f.backend.db.prepare("SELECT COUNT(*) n FROM ow_research_jobs WHERE case_id='case'").get().n,1);
    f.assertPreserved();
  }finally{f.close();}
});

test('real queue survives a crash after claim and reclaims only the expired lease',()=>{
  const f=queueFixture();try {
    f.worker.enqueue('case','a');const first=f.worker.claim();f.restart();
    assert.equal(f.worker.claim(),null);
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(first.id);
    const second=f.worker.claim();assert.equal(second.id,first.id);assert.notEqual(second.lease_id,first.lease_id);
    assert.equal(second.attempts,2);
    assert.throws(()=>f.worker.complete(first,{},null,null),/RESEARCH_LEASE_EXPIRED/);
  }finally{f.close();}
});

test('uncaptured unfinished superseded jobs remain derived history after two leases and restart',async()=>{
  for(const state of ['PENDING','RETRY','RUNNING']) {
    const f=queueFixture();try {
      const learner=installComparableCohort(f);
      const pending=f.worker.enqueue('case','a');
      if(state!=='PENDING') {
        const first=f.worker.claim();f.worker.fail(first,new Error('isolated transient failure'));
        f.restart();learner.db=f.backend.db;
        f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0 WHERE id=?').run(pending.id);
        const second=f.worker.claim();
        assert.equal(second.attempts,2);assert.notEqual(second.lease_id,first.lease_id);
        if(state==='RETRY')f.worker.fail(second,new Error('isolated transient failure'));
        f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0,lease_until_ms=0 WHERE id=?').run(pending.id);
      }
      const original=f.backend.one('ow_research_jobs',pending.id);
      const originalCase=f.backend.one('ow_cases','case');
      const originalArtifact=f.backend.one('ow_artifacts','a');
      assert.equal(original.state,state);assert.equal(original.input_json,null);
      addNewerComparableCase(f);f.worker.reconcile();
      assert.equal(learner.classification(f.backend.one('ow_runs','r')).eligible,true,'individual provenance remains clean');
      assert.throws(()=>learner.cohort(f.backend.one('ow_runs','r')),error=>error.code==='TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
      assert.equal(f.worker.claim().case_id,'case-u25','superseded first row cannot starve the current case');
      for(let i=0;i<3;i++)await f.worker.flushOnce();
      f.restart();learner.db=f.backend.db;
      assert.equal(f.worker.claim(),null);
      const status=f.worker.statusForCase('case');
      assert.equal(status.state,state);assert.equal(status.historical,true);assert.equal(status.superseded,true);
      assert.equal(status.effective_state,'HISTORICAL_SUPERSEDED');assert.equal(status.qualified_for_new_support,false);
      assert.equal(status.historical_reason,'UNCAPTURED_TRIGGER_SUPERSEDED_BY_LATEST_EXACT_COVERAGE');
      assert.equal(status.current_qualification.reason,'TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
      assert.match(status.next_action,/No completion is claimed and automatic retry is not due/);
      f.worker.evidence=()=>{throw Error('superseded uncaptured source must never be read');};
      assert.throws(()=>f.worker.capture(original),/RESEARCH_CURRENT_PROVENANCE_REQUIRED/);
      assert.deepEqual(f.backend.one('ow_research_jobs',pending.id),original,'no third lease, RETRY update or snapshot mutation');
      assert.deepEqual(f.backend.one('ow_cases','case'),originalCase,'historical status is derived, not a ledger-state mutation');
      assert.deepEqual(f.backend.one('ow_artifacts','a'),originalArtifact);
    }finally{f.close();}
  }
});

test('frozen unfinished input retains its captured cohort after supersession across two leases and restart',()=>{
  const f=queueFixture();try {
    const learner=installComparableCohort(f);
    const source=sample();
    const rows=source.rows.filter(row=>row.run_id==='a').map(row=>({...row,run_id:'r'}));
    const bundle={...source.bundle,cohort:{...source.bundle.cohort,eligible_runs:[{...source.bundle.cohort.eligible_runs[0],run_id:'r'}],
      aggregate:{...source.bundle.cohort.aggregate,observed_sample_count:20,eligible_run_count:1}},
      research_coverage:{r:source.bundle.research_coverage.a}};
    f.worker.evidence=()=>({rows,bundle,row:f.backend.one('ow_cases','case'),context:{run_id:'r'},completion_hash:digest('completion'),recipient:'strategy'});
    f.worker.enqueue('case','a');const first=f.worker.claim();const snapshot=f.worker.capture(first);
    f.worker.fail(first,new Error('isolated transient failure'));
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0 WHERE id=?').run(first.id);
    addNewerComparableCase(f);
    const frozen=f.backend.one('ow_research_jobs',first.id);
    assert.throws(()=>learner.cohort(f.backend.one('ow_runs','r')),error=>error.code==='TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
    f.restart();learner.db=f.backend.db;
    const second=f.worker.claim();assert.equal(second.id,first.id);assert.equal(second.attempts,2);
    assert.notEqual(second.lease_id,first.lease_id);
    f.worker.evidence=()=>{throw Error('frozen input must not be rebased');};
    assert.deepEqual(f.worker.capture(second),snapshot);
    const resumed=f.backend.one('ow_research_jobs',first.id);
    assert.equal(resumed.input_json,frozen.input_json);assert.equal(resumed.input_hash,frozen.input_hash);
    const status=f.worker.statusForCase('case');
    assert.equal(status.superseded,false);assert.equal(status.historical,false);assert.equal(status.qualified_for_new_support,true);
  }finally{f.close();}
});

test('a real persisted retry resumes automatically without a human decision',()=>{
  const f=queueFixture();try {
    f.worker.enqueue('case','a');const first=f.worker.claim();f.worker.fail(first,new Error('TELEMETRY_DATABASE_REQUIRED'));
    f.restart();assert.equal(f.worker.claim(),null);
    assert.equal(f.worker.statusForCase('case').state,'RETRY');
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0').run();
    assert.equal(f.worker.claim().attempts,2);
  }finally{f.close();}
});

test('provenance exclusions never consume retry attempts or starve qualified fresh cases across restart',async()=>{
  for(const state of ['PENDING','RETRY','RUNNING']) {
    const f=queueFixture();try {
      const blocked=f.worker.enqueue('case','a');
      f.backend.db.prepare('UPDATE ow_research_jobs SET state=?,next_attempt_ms=0,lease_until_ms=0 WHERE id=?').run(state,blocked.id);
      const original=f.backend.one('ow_research_jobs',blocked.id);
      const classify=run=>({eligible:run?.id==='fresh',reasons:run?.id==='fresh'?[]:['RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT'],telemetry:{proof_basis:'EXPLICIT_MOCK_ONLY'}});
      f.backend.operationalLearning.classification=classify;
      f.backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run('fresh','s','i','COMPLETED','{}');
      f.backend.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,'brain',NULL,?)")
        .run('fresh-case','s','i','fresh',digest('baseline'),JSON.stringify({origin:'OPERATIONAL_LEARNING'}));
      const content=Buffer.from(f.backend.one('ow_artifacts','a').content).toString('utf8');
      f.backend.writeArtifact(null,{artifact_id:'fresh-a',case_id:'fresh-case',run_id:'fresh',recipient_id:'strategy',kind:'RECOMMENDATION',
        content,content_hash:digest(content),dependency_ids:[]});
      f.worker.enqueue('fresh-case','fresh-a');
      assert.equal(f.worker.claim().case_id,'fresh-case','blocked first row cannot starve fresh proof');
      for(let i=0;i<3;i++)await f.worker.flushOnce();
      f.restart();
      assert.equal(f.worker.claim(),null);
      assert.deepEqual(f.backend.one('ow_research_jobs',blocked.id),original,'no RETRY loop, leases or state rewrites');
      const status=f.worker.statusForCase('case');
      assert.equal(status.state,state);assert.equal(status.effective_state,'BLOCKED_PROVENANCE');
      assert.equal(status.qualified_for_new_support,false);
      assert.match(status.next_action,/provenance owner.*fresh managed replay/);
    }finally{f.close();}
  }
});

test('frozen v4 support is blocked when any included run loses provenance, without mutating its snapshot',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();
    f.worker.evidence=()=>({rows,bundle,row:{strategy_id:'s'},context:{run_id:'r'},completion_hash:digest('completion'),recipient:'strategy'});
    f.worker.enqueue('case','a');const job=f.worker.claim();f.worker.capture(job);
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0 WHERE id=?').run(job.id);
    const original=f.backend.one('ow_research_jobs',job.id);
    f.backend.operationalLearning.classification=run=>({eligible:run?.id==='r',reasons:['RAW_STTL2_IDENTITY_CONFLICT']});
    f.restart();
    assert.equal(f.worker.claim(),null);
    assert.deepEqual(f.backend.one('ow_research_jobs',job.id),original);
    assert.equal(f.worker.statusForCase('case').effective_state,'BLOCKED_PROVENANCE');
    assert.throws(()=>f.worker.capture(original),/RESEARCH_CURRENT_PROVENANCE_REQUIRED/);
    assert.throws(()=>f.worker.complete(job,JSON.parse(original.input_json).result,{id:'brain'},'strategy'),/RESEARCH_CURRENT_PROVENANCE_REQUIRED/);
  }finally{f.close();}
});

test('completed v2/v3 reports retain bytes and show current provenance warnings rather than qualified support',()=>{
  for(const version of ['ocean-cumulative-research/v2','ocean-cumulative-research/v3']) {
    const f=historicalFixture(version);try {
      f.backend.operationalLearning.classification=()=>({eligible:false,reasons:['RECORDED_STRATEGY_DLL_PROVENANCE_CONFLICT','RAW_STTL2_IDENTITY_CONFLICT']});
      f.worker.reconcile();
      const status=f.worker.statusForCase('case');
      assert.equal(status.state,'COMPLETED');assert.equal(status.historical,true);
      assert.equal(status.qualified_for_new_support,false);assert.equal(status.current_qualification.verified,false);
      assert.match(status.qualification_warning,/Preserved historical report.*not current physical\/raw provenance proof/);
      assert.equal(f.worker.claim(),null);f.assertPreserved();
    }finally{f.close();}
  }
});

test('Research UI preserves completed status while distinguishing historical support and current provenance blocks',()=>{
  const source=fs.readFileSync(new URL('../public/workflow/ui.js',import.meta.url),'utf8');
  const panelSource=source.slice(source.indexOf('function researchPanel('),source.indexOf('function casePage('));
  const panel=vm.runInNewContext(`${panelSource}; researchPanel`,{
    section:(title,body)=>`${title}\n${body}`,facts:rows=>rows.map(([name,value])=>`${name}: ${value}`).join('\n'),
    esc:String,badge:String,link:(_type,id)=>id,human:String,
  });
  const {rows,bundle}=sample();const report=evaluateResearch(bundle,rows);
  const historical=panel({job_id:'old',state:'COMPLETED',effective_state:'COMPLETED',historical:true,qualified_for_new_support:false,
    qualification_warning:'Historical physical provenance not verified',report,attempts:0});
  assert.match(historical,/Status: COMPLETED/);assert.match(historical,/Preserved report history \(not current qualified support\)/);
  assert.doesNotMatch(historical,/Currently qualified history/);
  const blocked=panel({job_id:'new',state:'RETRY',effective_state:'BLOCKED_PROVENANCE',qualified_for_new_support:false,qualification_warning:'Provenance owner action required'});
  assert.match(blocked,/Status: BLOCKED_PROVENANCE/);assert.match(blocked,/Provenance owner action required/);
  const superseded=panel({job_id:'old-pending',state:'RETRY',effective_state:'HISTORICAL_SUPERSEDED',historical:true,
    qualified_for_new_support:false,qualification_warning:'Uncaptured case is retained as superseded history; automatic retry is not due'});
  assert.match(superseded,/Status: HISTORICAL_SUPERSEDED/);assert.match(superseded,/automatic retry is not due/);
  assert.match(panel({job_id:'fresh',state:'COMPLETED',qualified_for_new_support:true,report}),/Currently qualified history/);
  const insufficient=sample();delete insufficient.bundle.research_coverage.b;
  const insufficientReport=evaluateResearch(insufficient.bundle,insufficient.rows);
  const insufficientPanel=panel({job_id:'insufficient',state:'COMPLETED',qualified_for_new_support:true,report:insufficientReport,
    next_action:insufficientReport.next_action});
  assert.match(insufficientPanel,/Status: COMPLETED/);assert.match(insufficientPanel,/Outcome: INSUFFICIENT_EVIDENCE/);
  assert.match(insufficientPanel,/Direction-screen evidence: INSUFFICIENT/);
  assert.match(insufficientPanel,/not an evaluated no-change finding/);assert.match(insufficientPanel,/Candidate validation: NOT_DUE/);
  const sealedReport=structuredClone(report);delete sealedReport.evidence_sufficiency;
  const sealedHash=objectHash(sealedReport);
  assert.match(panel({job_id:'sealed',state:'COMPLETED',report:sealedReport}),/Not recorded in preserved report/);
  assert.equal(objectHash(sealedReport),sealedHash);
});

test('READY Replay footer records Research not due and preflight action without inventing source readiness',()=>{
  const source=fs.readFileSync(new URL('../public/workflow/ui.js',import.meta.url),'utf8');
  const pageSource=source.slice(source.indexOf('function runPage('),source.indexOf('function caseProgress('));
  const page=vm.runInNewContext(`${pageSource}; runPage`,{
    section:(title,body)=>`${title}\n${body}`,facts:rows=>rows.map(([name,value])=>`${name}: ${value}`).join('\n'),
    esc:String,badge:String,link:(_type,id)=>id,human:String,heading:()=>'',button:()=>'',
    table:()=>'',hash:String,date:String,timeline:()=>'',empty:String,
  });
  const data={state:'READY',strategy_name:'fixture',events:[],context:{run_id:'fixture',strategy_id:'fixture',
    expected_environment:'REPLAY',evidence_purpose:'HISTORICAL_BUILD',observed_source_state:{environment:'UNKNOWN',quality:'UNKNOWN'}},
    manager:{namespace:'OPERATIONAL',completion_current:false,context_status:'CURRENT'},
    learning:{stage:'NOT_DUE',eligible:false,continuation_case_id:null,next_action:null}};
  const before=objectHash(data);
  const ready=page(data);
  assert.match(ready,/Research continuation: NOT_DUE/);
  assert.match(ready,/Next action: Verify source preflight and the exact run release before starting this managed replay/);
  assert.match(ready,/Replay execution is not yet verified/);
  assert.doesNotMatch(ready,/Not required|Await the learning result/);
  assert.equal(objectHash(data),before);
  const blocked=page({...data,learning:{...data.learning,next_action:'Confirm effective chart timezone before source preflight'}});
  assert.match(blocked,/Next action: Confirm effective chart timezone before source preflight/);
  assert.doesNotMatch(blocked,/Next action: Verify source preflight/);
  const linked=page({...data,learning:{...data.learning,continuation_case_id:'preserved-case',
    research:{state:'RETRY',effective_state:'BLOCKED_PROVENANCE',next_action:'Provenance owner action required'}}});
  assert.match(linked,/Research continuation: preserved-case/);
  assert.match(linked,/Next action: Provenance owner action required/);
  const historical=page({...data,state:'COMPLETED',learning:{...data.learning,continuation_case_id:'historical-case',
    next_action:'Historical report preserved; not current qualified support'}});
  assert.match(historical,/Research continuation: historical-case/);
  assert.match(historical,/Next action: Historical report preserved; not current qualified support/);
  const due=page({...data,state:'COMPLETED',learning:{...data.learning,eligible:true,conclusion_type:'RECOMMENDATION',
    next_action:'Persist Research continuation'}});
  assert.match(due,/Research continuation: PENDING/);
  const active=page({...data,state:'ACTIVE'});
  assert.match(active,/Next action: Await the learning result/);
  const testOnly=page({...data,manager:{...data.manager,namespace:'TEST'}});
  assert.match(testOnly,/Next action: Await the learning result/);
});

test('G08 run browser template labels prior outcomes as historical without claiming current completion and retains qualified positive completion',()=>{
  const source=fs.readFileSync(new URL('../public/workflow/ui.js',import.meta.url),'utf8');
  const pageSource=source.slice(source.indexOf('function runPage('),source.indexOf('function caseProgress('));
  const page=vm.runInNewContext(`${pageSource}; runPage`,{
    section:(title,body)=>`${title}\n${body}`,facts:rows=>rows.map(([name,value])=>`${name}: ${value}`).join('\n'),
    esc:String,badge:String,link:(_type,id)=>id,human:String,heading:()=>'',button:()=>'',
    table:(_columns,rows)=>rows.map(row=>row.join(': ')).join('\n'),hash:String,date:String,timeline:()=>'',empty:String,
  });
  const data={state:'COMPLETED',strategy_name:'isolated fixture',events:[],
    context:{run_id:'isolated-historical-run',strategy_id:'fixture',expected_environment:'REPLAY',
      evidence_purpose:'HISTORICAL_BUILD',observed_source_state:{environment:'REPLAY',quality:'VERIFIED'}},
    manager:{namespace:'OPERATIONAL',completion_current:true,completion:{status:'COMPLETED'},context_status:'CURRENT',
      unique_canonical_count:61,processing_count:61,open_pins:0},
    learning:{stage:'COMPLETE',loop_stage:'QUALIFICATION_REQUIRED',current_qualification_status:'QUALIFICATION_REQUIRED',
      current_provenance_qualified:false,eligible:false,conclusion_type:'NO_CHANGE',brain_record_id:'preserved-brain-record',
      reasons:['PHYSICAL_STRATEGY_BINDING_CONFLICT','RAW_STTL2_IDENTITY_CONFLICT'],
      historical_result:{research_outcome:'NO_SUPPORTED_CHANGE',conclusion_type:'NO_CHANGE'},
      next_action:'Resolve physical strategy binding and raw STTL2 identity conflict; preserve the prior report.',
      research:{state:'COMPLETED',historical:true,qualified_for_new_support:false,
        report:{outcome:'NO_SUPPORTED_CHANGE',next_action:'Keep current baseline.'}}}};
  const before=objectHash(data),historical=page(data);
  assert.match(historical,/Overall learning loop: QUALIFICATION_REQUIRED/);
  assert.match(historical,/Conclusion: Not currently qualified/);
  assert.match(historical,/Prior outcome \(historical\): NO_SUPPORTED_CHANGE/);
  assert.match(historical,/2\. Evidence qualified: QUALIFICATION_REQUIRED: PHYSICAL_STRATEGY_BINDING_CONFLICT; RAW_STTL2_IDENTITY_CONFLICT/);
  assert.doesNotMatch(historical,/2\. Evidence qualified: NOT_DUE/);
  assert.match(historical,/3\. Cumulative Brain analysis: HISTORICAL/);
  assert.match(historical,/4\. Result returned to Ocean: HISTORICAL/);
  assert.match(historical,/5\. Research evaluation: HISTORICAL/);
  assert.match(historical,/not current qualified support/);
  assert.match(historical,/Next action: Resolve physical strategy binding and raw STTL2 identity conflict/);
  assert.doesNotMatch(historical,/Overall learning loop: COMPLETE|Conclusion: NO_SUPPORTED_CHANGE|Keep current baseline\./);
  assert.match(historical,/6\. Candidate validation: NOT_DUE/);
  assert.equal(objectHash(data),before,'Rendering must not alter the retained report or run');
  for(const status of ['PASSED','FAILED','IN_PROGRESS']) {
    const prior={...data,learning:{...data.learning,research:{...data.learning.research,
      report:{...data.learning.research.report,candidate_validation:{status}}}}};
    const priorHash=objectHash(prior),rendered=page(prior);
    assert.match(rendered,/6\. Candidate validation: HISTORICAL/);
    assert.ok(rendered.includes(`Prior candidate validation ${status} retained; not current qualified validation support.`));
    assert.ok(!rendered.includes(`6. Candidate validation: ${status}`));
    assert.equal(objectHash(prior),priorHash);
  }
  const current=page({...data,learning:{...data.learning,eligible:true,current_provenance_qualified:true,
    loop_stage:'COMPLETE',current_qualification_status:'CURRENT',historical_result:null,
    next_action:'Keep current baseline. Qualified direction screen found no supported change.',
    research:{...data.learning.research,historical:false,qualified_for_new_support:true}}});
  assert.match(current,/Overall learning loop: COMPLETE/);
  assert.match(current,/Conclusion: NO_SUPPORTED_CHANGE/);
  assert.match(current,/2\. Evidence qualified: COMPLETE/);
  assert.match(current,/5\. Research evaluation: COMPLETED/);
  assert.match(current,/Qualified direction screen found no supported change/);
  assert.doesNotMatch(current,/Prior outcome \(historical\)|Not currently qualified|Research evaluation: HISTORICAL/);
  const currentValidation=page({...data,learning:{...data.learning,loop_stage:'COMPLETE',
    current_qualification_status:'CURRENT',historical_result:null,research:{...data.learning.research,
      historical:false,qualified_for_new_support:true,
      report:{...data.learning.research.report,candidate_validation:{status:'PASSED'}}}}});
  assert.match(currentValidation,/6\. Candidate validation: PASSED/);
  assert.doesNotMatch(currentValidation,/Prior candidate validation|Candidate validation: HISTORICAL/);
  const callbackOnly=page({...data,learning:{...data.learning,research:null,
    historical_result:{conclusion_type:'NO_CHANGE',research_outcome:null}}});
  assert.match(callbackOnly,/Prior outcome \(historical\): NO_CHANGE/);
  assert.doesNotMatch(callbackOnly,/Overall learning loop: COMPLETE|Conclusion: NO_CHANGE/);
  for(const [state,reason] of [['READY','RUN_NOT_COMPLETED'],['FAILED','RUN_NOT_COMPLETED'],
    ['COMPLETED','LEARNER_PERMISSION_DENIED']]) {
    const notDue={...data,state,learning:{...data.learning,stage:'NOT_DUE',loop_stage:'NOT_DUE',
      current_qualification_status:'NOT_VERIFIED',historical_result:null,research:null,reasons:[reason]}};
    const notDueHash=objectHash(notDue),rendered=page(notDue);
    assert.match(rendered,/2\. Evidence qualified: NOT_DUE/);
    assert.doesNotMatch(rendered,/2\. Evidence qualified: QUALIFICATION_REQUIRED|2\. Evidence qualified: COMPLETE/);
    assert.equal(objectHash(notDue),notDueHash);
  }
  const currentEvidence=page({...data,learning:{...data.learning,eligible:true,current_provenance_qualified:true}});
  assert.match(currentEvidence,/2\. Evidence qualified: COMPLETE/,'Current evidence can qualify while its prior result stays historical');
  assert.match(currentEvidence,/3\. Cumulative Brain analysis: HISTORICAL/);
});

test('queue mutation rolls back with its caller transaction; unapproved authority is rejected',()=>{
  const f=queueFixture();try {
    assert.throws(()=>f.backend.store.transaction(()=>{f.worker.enqueue('case','a');throw Error('crash before ACK');}));
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_research_jobs').get().n,0);
    f.backend.db.prepare("UPDATE ow_cases SET payload_json='{}' WHERE id='case'").run();
    assert.throws(()=>f.worker.enqueue('case','a'),/RESEARCH_OPERATIONAL_CASE_REQUIRED/);
  }finally{f.close();}
});

test('captured Research input is immutable and reused after restart without rereading changed history',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();
    f.worker.evidence=()=>({rows,bundle,row:{strategy_id:'s'},context:{run_id:'r'},completion_hash:digest('completion'),recipient:'strategy'});
    f.worker.enqueue('case','a');const job=f.worker.claim();const first=f.worker.capture(job);
    f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0').run();
    const resumed=f.worker.claim();
    f.worker.evidence=()=>{throw Error('must not reread changed source');};
    assert.deepEqual(f.worker.capture(resumed),first);
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_research_jobs SET input_json='{}'").run(),/immutable Research input/);
  }finally{f.close();}
});

test('insufficient evidence is a completed finding, not endless RETRY or invented candidate/test work',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();delete bundle.research_coverage.b;
    f.worker.enqueue('case','a');const job=f.worker.claim();
    const result=f.captureForCompletion(job,{rows,bundle});
    const status=f.worker.complete(job,result,f.actor,'strategy');
    assert.equal(status.state,'COMPLETED');assert.equal(status.report.outcome,'INSUFFICIENT_EVIDENCE');
    assert.match(status.next_action,/Insufficient evidence is not an evaluated no-change finding/);
    assert.equal(status.report.candidate_validation.status,'NOT_DUE');
    assert.equal(f.backend.one('ow_cases','case').candidate_hash,null);
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_tasks').get().n,1,'owned evidence task is not a candidate test');
    assert.equal(status.continuations[0].kind,'EVIDENCE_FOLLOW_UP');
    assert.equal(f.backend.db.prepare('SELECT COUNT(*) n FROM ow_approval_requests').get().n,0);
    const artifact=f.backend.one('ow_artifacts',status.result_artifact_id);
    const completed=f.backend.one('ow_research_jobs',job.id);
    f.restart();f.worker.reconcile();
    assert.equal(f.worker.claim(),null);assert.equal(f.worker.enqueue('case','a').id,job.id);
    assert.deepEqual(f.backend.one('ow_research_jobs',job.id),completed);
    assert.deepEqual(f.backend.one('ow_artifacts',status.result_artifact_id),artifact);
  }finally{f.close();}
});

test('sealed pre-distinction v4 outcomes remain byte-identical and are never retroactively evaluated',()=>{
  const f=historicalFixture(RESEARCH_VERSION);try {
    for(let i=0;i<2;i++) {
      f.worker.reconcile();const status=f.worker.statusForCase('case');
      assert.equal(status.report.outcome,'NO_SUPPORTED_CHANGE');
      assert.equal(status.report.evidence_sufficiency,undefined);
      assert.equal(status.report.next_action,'Original v2 report instruction.');
      assert.equal(f.worker.enqueue('case','a').id,f.legacyId);assert.equal(f.worker.claim(),null);
      f.assertPreserved();f.restart();
    }
  }finally{f.close();}
});

test('frozen pre-distinction v4 input is resumed unchanged instead of being reclassified',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();bundle.research_coverage.b=bundle.research_coverage.a;
    const result=evaluateResearch(bundle,rows);
    assert.equal(result.outcome,'INSUFFICIENT_EVIDENCE');
    // Explicit legacy fixture: a sealed v4 capture made before outcome distinction.
    result.outcome='NO_SUPPORTED_CHANGE';delete result.evidence_sufficiency;delete result.screening_policy;
    result.next_action='Preserved pre-distinction instruction.';
    const snapshot={result,evidence:{historical:true}};const content=JSON.stringify(snapshot);
    f.worker.enqueue('case','a');const job=f.worker.claim();
    f.backend.db.prepare('UPDATE ow_research_jobs SET input_json=?,input_hash=? WHERE id=?')
      .run(content,digest(content),job.id);
    f.restart();f.backend.db.prepare('UPDATE ow_research_jobs SET lease_until_ms=0').run();
    const resumed=f.worker.claim();f.worker.evidence=()=>{throw Error('frozen input must not be re-evaluated');};
    assert.deepEqual(f.worker.capture(resumed),snapshot);
    assert.equal(f.backend.one('ow_research_jobs',job.id).input_json,content);
    assert.equal(f.backend.one('ow_research_jobs',job.id).input_hash,digest(content));
  }finally{f.close();}
});

test('v4 snapshot preserves upstream cohort/exclusions/aggregates while period support stays internal',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();
    bundle.research_coverage.b=bundle.research_coverage.a;
    f.worker.evidence=()=>({rows,bundle,row:{strategy_id:'s'},context:{run_id:'r'},completion_hash:digest('completion'),recipient:'strategy'});
    f.worker.enqueue('case','a');const captured=f.worker.capture(f.worker.claim());
    assert.deepEqual(captured.evidence.bundle.cohort.eligible_runs.map(run=>run.run_id),captured.result.eligible_run_ids);
    assert.equal(captured.evidence.bundle.cohort.aggregate.observed_sample_count,captured.result.aggregate.trades);
    assert.deepEqual(captured.evidence.bundle.cohort,bundle.cohort,'no upstream retally or invented fields');
    assert.equal(captured.evidence.bundle.cohort.aggregate.eligible_run_count,3);
    assert.equal(captured.evidence.bundle.cohort.aggregate.confidence,100);
    assert.equal(captured.evidence.bundle.cohort.aggregate.uncertainty,0);
    assert.equal(captured.evidence.bundle.cohort.aggregate.evidence_status,'SUFFICIENT');
    assert.ok(captured.evidence.bundle.cohort.eligible_runs.every(run=>run.requested_coverage===undefined),'no extra upstream wire fields');
    assert.equal(objectHash(captured.evidence.bundle.cohort),captured.result.cohort_hash);
    assert.deepEqual(captured.evidence.bundle.excluded_evidence,captured.result.excluded_evidence);
    assert.deepEqual(captured.result.excluded_evidence,bundle.excluded_evidence);
    assert.equal(captured.evidence.bundle.research_coverage,undefined,'coverage is report-only provenance');
    assert.equal(captured.result.aggregate.trades,60);assert.equal(captured.result.historical_periods.distinct_coverage_count,2);
    assert.equal(captured.result.outcome,'INSUFFICIENT_EVIDENCE');
  }finally{f.close();}
});

test('real read-only extraction binds internal completion coverage without changing the qualified wire cohort',()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();
    bundle.cohort.eligible_runs[0].run_id='r';
    for(const row of rows)if(row.run_id==='a')row.run_id='r';
    bundle.research_coverage.r=bundle.research_coverage.a;delete bundle.research_coverage.a;
    bundle.research_coverage.b=bundle.research_coverage.r;
    for(const run_id of ['b','c'])f.backend.db.prepare('INSERT INTO ow_runs VALUES(?,?,?,1,?,?)').run(run_id,'s','i','COMPLETED','{}');
    f.backend.db.exec(`CREATE TABLE ocean_trade_causal_v2(trade_id INTEGER,run_id TEXT,entry_datetime REAL,direction TEXT,
      gross_currency_value REAL,total_commission REAL,net_profit_loss REAL,exit_causality TEXT,session_name TEXT,regime_label TEXT,status TEXT)`);
    const insert=f.backend.db.prepare('INSERT INTO ocean_trade_causal_v2 VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    f.backend.store.transaction(()=>{
      for(const row of rows)insert.run(row.trade_id,row.run_id,row.entry_datetime,row.direction,row.gross_currency_value,
        row.total_commission,row.net_profit_loss,row.exit_causality,row.session_name,row.regime_label,'closed');
    });
    const classifications=[];
    f.backend.baseline=()=>{}; // Isolated backend fixture, not a deployed policy probe.
    f.backend.operationalLearning={enabled:true,telemetryDb:f.file,cohort:()=>bundle,
      classification(run) {
        classifications.push(run.id);
        return {eligible:true,reasons:[],telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'},summary:{completion:{requested_coverage:bundle.research_coverage[run.id]}}};
      }};
    f.worker.enqueue('case','a');const captured=f.worker.capture(f.worker.claim());
    assert.deepEqual(classifications,['r','r','r','b','c','r']);
    assert.deepEqual(captured.result.eligible_run_ids,['b','c','r'],'all qualified configurations retained');
    assert.equal(captured.result.aggregate.trades,60);assert.equal(captured.result.outcome,'INSUFFICIENT_EVIDENCE');
    assert.equal(captured.result.historical_periods.distinct_coverage_count,2);
    assert.deepEqual(captured.evidence.bundle.cohort,bundle.cohort);
    assert.deepEqual(captured.evidence.bundle.excluded_evidence,bundle.excluded_evidence);
    assert.equal(captured.evidence.row.run_id,'r');
    assert.ok(captured.evidence.bundle.cohort.eligible_runs.some(run=>run.run_id===captured.evidence.row.run_id));
    assert.equal(objectHash(captured.evidence.bundle.cohort),captured.result.cohort_hash);
    assert.ok(captured.result.historical_periods.runs.every(run=>run.requested_coverage.length===1));
  }finally{f.close();}
});

test('mock Brain crash-after-write resumes the exact persisted request and rejects invalid responses',async()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();bundle.policy={project:'project',strategy_name:'Strategy'};
    bundle.excluded_evidence[0].diagnostic='e'.repeat(60000);
    const evidence={bundle,row:{strategy_id:'s',run_id:'r'},context:{strategy_version:'1'},completion_hash:digest('completion')};
    const result=evaluateResearch(bundle,rows);const calls=[];
    const registry={record_sha256:digest('registry'),reconciliation_id:'registry-1'};
    f.backend.operationalLearning={enabled:true,cohort:run=>({cohort:{eligible_runs:[{run_id:run.id}]}}),classification:()=>({eligible:true,reasons:[],telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'}}),path:'/protected-learning',token:()=> 'isolated-test-token',verifyIdentity:async()=>{},
      registry:async()=>registry,call:async(_path,_token,input)=>{calls.push(input);throw Error('connection lost after remote write');}};
    f.worker.enqueue('case','a');const job=f.worker.claim();
    await assert.rejects(f.worker.recordInBrain(job,evidence,result),/connection lost/);
    f.worker.fail(job,Error('outage'));f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0').run();
    const resumed=f.worker.claim();
    f.backend.operationalLearning.registry=async()=>{throw Error('request must not be rebuilt');};
    f.backend.operationalLearning.call=async(_path,_token,input)=>{
      calls.push(input);
      const content=JSON.stringify({registry_record_sha256:input.registry_record_sha256,registry_reconciliation_id:input.registry_reconciliation_id});
      return {schema_version:'ocean-operational-learning-result/v1',record_id:'mock-record',relative_path:'mock/record.json',
        content,content_sha256:digest(content),correlation:input.correlation,
        source_record_ids:['a','b','c','protected-holdout']};
    };
    assert.equal((await f.worker.recordInBrain(resumed,evidence,result)).record_id,'mock-record');
    assert.equal(objectHash(calls[0]),objectHash(calls[1]));
    assert.match(calls[0].case_id,/^CASE-OPERATIONAL-[A-F0-9]{24}-0001$/);
    const correlation={...calls[0].correlation};delete correlation.input_sha256;
    assert.equal(calls[0].correlation.input_sha256,objectHash({...calls[0],correlation}));
    assert.ok(calls[0].proposed_recommendation.content.length<=50000);
    assert.equal(calls[0].excluded_evidence[0].diagnostic.length,60000);
    assert.deepEqual(calls[0].cohort,bundle.cohort,'protected wire cohort is unchanged');
    assert.deepEqual(calls[0].excluded_evidence,bundle.excluded_evidence,'only upstream exclusions enter the wire request');
    assert.throws(()=>f.backend.db.prepare("UPDATE ow_research_jobs SET brain_request_json='{}'").run(),/immutable Research request/);
    f.backend.operationalLearning.call=async()=>({content:'{}'});
    await assert.rejects(f.worker.recordInBrain(resumed,evidence,result),/RESEARCH_BRAIN_RESPONSE_INVALID/);
  }finally{f.close();}
});

test('legacy frozen Research request retries with a valid Brain case ID without rewriting the sealed snapshot',async()=>{
  const f=queueFixture();try {
    const {rows,bundle}=sample();bundle.policy={project:'project',strategy_name:'Strategy'};
    const evidence={bundle,row:{strategy_id:'s',run_id:'r'},context:{strategy_version:'1'},completion_hash:digest('completion')};
    const result=evaluateResearch(bundle,rows);
    const registry={record_sha256:digest('registry'),reconciliation_id:'registry-1'};
    f.backend.operationalLearning={enabled:true,cohort:run=>({cohort:{eligible_runs:[{run_id:run.id}]}}),classification:()=>({eligible:true,reasons:[],telemetry:{bypassed:true,proof_basis:'EXPLICIT_MOCK_ONLY'}}),path:'/protected-learning',token:()=> 'isolated-test-token',verifyIdentity:async()=>{},registry:async()=>registry};
    f.worker.enqueue('case','a');const job=f.worker.claim();
    f.backend.operationalLearning.call=async()=>{throw Error('capture sealed request');};
    await assert.rejects(f.worker.recordInBrain(job,evidence,result),/capture sealed request/);
    const row=f.backend.one('ow_research_jobs',job.id),original=row.brain_request_json;
    const legacy=JSON.parse(original);legacy.case_id='research-evidence-legacy';
    delete legacy.correlation.input_sha256;legacy.correlation.input_sha256=objectHash(legacy);
    const legacyJson=JSON.stringify(legacy);
    f.backend.db.exec('DROP TRIGGER ow_research_request_no_rewrite');
    f.backend.db.prepare('UPDATE ow_research_jobs SET brain_request_json=?,brain_request_hash=? WHERE id=?').run(legacyJson,digest(legacyJson),job.id);
    let firstSent=null;f.backend.operationalLearning.call=async(_path,_token,input)=>{firstSent=input;throw Error('fetch failed');};
    await assert.rejects(f.worker.recordInBrain(job,evidence,result),/fetch failed/);
    assert.match(firstSent.case_id,/^CASE-OPERATIONAL-[A-F0-9]{24}-0001$/);
    f.worker.fail(job,Error('fetch failed'));f.restart();
    f.backend.db.prepare('UPDATE ow_research_jobs SET next_attempt_ms=0').run();
    const resumed=f.worker.claim();let sent=null;
    f.backend.operationalLearning.call=async(_path,_token,input)=>{
      sent=input;const content=JSON.stringify({registry_record_sha256:input.registry_record_sha256,registry_reconciliation_id:input.registry_reconciliation_id});
      return {schema_version:'ocean-operational-learning-result/v1',record_id:'mock-record',relative_path:'mock/record.json',content,
        content_sha256:digest(content),correlation:input.correlation,source_record_ids:['a','b','c','protected-holdout']};
    };
    assert.equal((await f.worker.recordInBrain(resumed,evidence,result)).record_id,'mock-record');
    assert.match(sent.case_id,/^CASE-OPERATIONAL-[A-F0-9]{24}-0001$/);
    assert.equal(objectHash(sent),objectHash(firstSent));
    assert.equal(f.backend.one('ow_research_jobs',job.id).brain_request_json,legacyJson);
  }finally{f.close();}
});

test('large cumulative evaluation uses bounded recommendation and exact immutable full-source hash references',()=>{
  const {rows,bundle}=sample(),result=evaluateResearch(bundle,rows);
  result.per_run=Array.from({length:2500},(_,i)=>({...result.per_run[i%3],run_id:`r-${i}`,diagnostic:'retained contradiction '.repeat(10)}));
  result.native_session_evidence={exit_audit:Array.from({length:3000},(_,i)=>({trade_id:i,status:'MISSING_FINAL_EXIT_MAPPING'}))};
  const before=JSON.stringify(result),job={id:'research-large-fixture',input_hash:digest('EXPLICIT_MOCK_FROZEN_INPUT')};
  const content=boundedResearchRecommendation(job,result),parsed=JSON.parse(content);
  assert.ok(before.length>50000);assert.ok(content.length<=50000);
  assert.equal(parsed.representation,'BOUNDED_SUMMARY_WITH_FULL_FROZEN_SOURCE_REFERENCES');
  assert.equal(parsed.source.job_id,job.id);assert.equal(parsed.source.input_hash,job.input_hash);
  assert.equal(parsed.source.result_hash,objectHash(result));assert.equal(parsed.experiments_hash,objectHash(result.experiments));
  assert.equal(JSON.stringify(result),before,'no full-source evidence was removed or clipped');
  assert.equal(boundedResearchRecommendation(job,result),content,'restart rebuild is deterministic when no saved request exists');
});
