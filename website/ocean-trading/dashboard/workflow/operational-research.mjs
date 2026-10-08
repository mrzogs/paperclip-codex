import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROVENANCE_ACTION } from './operational-learning.mjs';
import { digest, objectHash, requireThat } from './common.mjs';
import { OperationalContinuation } from './operational-continuation.mjs';

// New physical/raw provenance gates apply only to new jobs, never relabel history.
export const RESEARCH_VERSION = 'ocean-cumulative-research/v4';
const unknown = value => !value || /^(unknown|none|null|n\/a)$/i.test(String(value).trim());
const round = value => Math.round(value * 100) / 100;
const authority = Object.freeze({ automatic_strategy_change:false, candidate_approved:false, paper_authorized:false, live_authorized:false });
const screeningPolicy = Object.freeze({ minimum_distinct_declared_periods:3, minimum_direction_trades_per_retained_run:10,
  positive_net_exclusion_required_in_every_retained_run:true,
  basis:'EXISTING_DIRECTION_DISCOVERY_SCREEN_NOT_STATISTICALLY_CALIBRATED' });

export function evidenceRemediation(sufficiency) {
  const fixed=sufficiency.sample_shortfalls || [],missing=sufficiency.missing_coverage_run_ids || [];
  const missingPeriods=Math.max(0,screeningPolicy.minimum_distinct_declared_periods-Number(sufficiency.distinct_declared_periods || 0));
  const noDirections=sufficiency.reasons?.includes('NO_RECORDED_DIRECTION_GROUPS')===true;
  const actions=[];
  if(missing.length)actions.push(`Verify original requested coverage and provenance for retained runs ${missing.join(', ')}; missing proof is not permission to relabel or discard history.`);
  if(missingPeriods)actions.push(`Obtain ${missingPeriods} additional genuinely distinct, qualified non-live discovery coverage(s) and a new Research evaluation. This can resolve the period shortfall, not fixed retained-run sample counts.`);
  if(fixed.length)actions.push(`Research design review required for ${fixed.map(item=>`${item.direction} in ${item.run_id} (${item.observed_trades}/${item.required_trades})`).join(', ')}. Adding later runs cannot increase those frozen counts. The Research owner must document a prospective sampling-unit/protocol review for Wayne, including why the existing every-retained-run rule is or is not suitable. Keep all recorded trades, contradictory history and current floors; do not change policy or create a candidate from this review without separate authorization.`);
  if(noDirections)actions.push('Review source entry-direction availability before designing another screen; do not invent direction or exit labels. No direction has been assessed.');
  return {status:fixed.length || noDirections?'RESEARCH_DESIGN_REVIEW_REQUIRED':actions.length?'QUALIFIED_EVIDENCE_REQUIRED':'NOT_REQUIRED',
    requires_design_review:fixed.length>0 || noDirections,
    additional_discovery_can_resolve_fixed_sample_shortfalls:false,
    missing_distinct_coverage_count:missingPeriods,missing_coverage_run_ids:missing,
    frozen_sample_shortfalls:fixed,policy_change_authorized:false,
    next_action:actions.join(' ') || 'The recorded direction screen has no evidence shortfall. This does not imply candidate testing.'};
}

function totals(rows) {
  const sum = field => round(rows.reduce((total,row) => total + Number(row[field]),0));
  return {
    trades:rows.length, gross_profit_loss:sum('gross_currency_value'), fees:sum('total_commission'),
    net_profit_loss:sum('net_profit_loss'), wins:rows.filter(row=>row.net_profit_loss>0).length,
    losses:rows.filter(row=>row.net_profit_loss<0).length, flat:rows.filter(row=>row.net_profit_loss===0).length,
    gross_wins:rows.filter(row=>row.gross_currency_value>0).length,
    fee_flipped_wins:rows.filter(row=>row.gross_currency_value>0 && row.net_profit_loss<=0).length,
  };
}

function historicalCoverage(ranges) {
  if(!Array.isArray(ranges) || !ranges.length)return null;
  const intervals=ranges.map(range=>({start:Date.parse(range.start_utc),end:Date.parse(range.end_utc)}));
  if(intervals.some(range=>!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start>=range.end))return null;
  intervals.sort((a,b)=>a.start-b.start || a.end-b.end);
  const merged=[];
  for(const range of intervals) {
    const previous=merged.at(-1);
    if(previous && range.start<=previous.end)previous.end=Math.max(previous.end,range.end);
    else merged.push({...range});
  }
  return merged.map(range=>({start_utc:new Date(range.start).toISOString(),end_utc:new Date(range.end).toISOString()}));
}

// Only recorded entry direction can enter the exploratory proposal screen.
// Signal labels have no independently proven pre-entry availability timestamp.
export function evaluateResearch(bundle, rows) {
  const sourceIds = bundle.cohort.eligible_runs.map(run=>run.run_id).sort();
  requireThat(new Set(sourceIds).size===sourceIds.length,409,'RESEARCH_DUPLICATE_RUN');
  requireThat(rows.every(row=>sourceIds.includes(row.run_id)),409,'RESEARCH_FOREIGN_EVIDENCE');
  const keys = rows.map(row=>`${row.run_id}:${row.trade_id}`);
  requireThat(new Set(keys).size===keys.length,409,'RESEARCH_DUPLICATE_TRADE');
  requireThat(rows.length===bundle.cohort.aggregate.observed_sample_count,409,'RESEARCH_SAMPLE_COUNT_CONFLICT');
  requireThat(rows.every(row=>row.entry_datetime!=null && Number.isFinite(Number(row.entry_datetime))),409,'RESEARCH_ENTRY_TIME_REQUIRED');
  requireThat(rows.every(row=>['gross_currency_value','total_commission','net_profit_loss'].every(field=>
    row[field]!=null && Number.isFinite(Number(row[field])))
    && Number(row.total_commission)>=0
    && Math.abs(Number(row.gross_currency_value)-Number(row.total_commission)-Number(row.net_profit_loss))<0.001),
  409,'RESEARCH_FEE_RECONCILIATION_FAILED');

  // Coverage only counts proposal-support periods. The verified upstream cohort
  // retains distinct code/config/profile evidence and all of its recorded trades.
  const eligibleIds=sourceIds;
  const coverageByRun=eligibleIds.map(run_id=>{
    const coverage=historicalCoverage(bundle.research_coverage?.[run_id]);
    return {run_id,coverage,period_id:coverage?objectHash(coverage):null};
  });
  const periodIds=new Set(coverageByRun.map(run=>run.period_id).filter(Boolean));
  const coverageProven=coverageByRun.length>0 && coverageByRun.every(run=>run.coverage!==null);
  const perRun = coverageByRun.map(run=>({run_id:run.run_id,historical_period_id:run.period_id,
    ...totals(rows.filter(row=>row.run_id===run.run_id))}));
  const experiments = [];
  const observations = [];
  for(const dimension of ['direction','session_name','regime_label']) {
    for(const value of new Set(rows.map(row=>row[dimension]).filter(value=>!unknown(value)))) {
      const selected=rows.filter(row=>row[dimension]===value);
      const runs=perRun.map(run=>{
        const group=selected.filter(row=>row.run_id===run.run_id);
        return {run_id:run.run_id,historical_period_id:run.historical_period_id,
          ...totals(group),observed_exclusion_delta:round(-totals(group).net_profit_loss)};
      });
      const proposalEligible=dimension==='direction';
      const evidenceSufficient=proposalEligible && coverageProven && periodIds.size>=screeningPolicy.minimum_distinct_declared_periods
        && runs.every(run=>run.trades>=screeningPolicy.minimum_direction_trades_per_retained_run);
      const supported=evidenceSufficient && runs.every(run=>run.observed_exclusion_delta>0);
      const breakdown={dimension,value,runs,observed_exclusion_delta:round(-totals(selected).net_profit_loss),
        proposal_eligible:proposalEligible,lookahead_safe:proposalEligible,
        availability_basis:proposalEligible?'RECORDED_ENTRY_DIRECTION':'PRE_ENTRY_LABEL_AVAILABILITY_NOT_INDEPENDENTLY_PROVEN',
        evidence_sufficient:evidenceSufficient,
        supported,reason:!proposalEligible?'OBSERVATIONAL_LABEL_ONLY_NOT_LOOKAHEAD_SAFE'
          :!coverageProven?'HISTORICAL_COVERAGE_NOT_PROVEN'
          :periodIds.size<screeningPolicy.minimum_distinct_declared_periods?'INSUFFICIENT_DISTINCT_DECLARED_PERIODS'
          :!evidenceSufficient?'INSUFFICIENT_DIRECTION_SAMPLE_IN_RETAINED_RUN'
          :supported?'REPEATED_EXPLORATORY_DIRECTION_LOSS':'DIRECTION_LOSS_NOT_REPEATED_IN_EVERY_RETAINED_RUN'};
      if(proposalEligible)experiments.push(breakdown);
      else observations.push({...breakdown,label_basis:dimension==='session_name'
        ?'RECORDED_SIGNAL_SESSION_LABEL_NOT_EXECUTION_SESSION':'RECORDED_REGIME_LABEL_NOT_PROVEN_AVAILABLE_AT_ENTRY'});
    }
  }
  const proposals=experiments.filter(item=>item.supported);
  const sampleShortfalls=experiments.flatMap(item=>item.runs
    .filter(run=>run.trades<screeningPolicy.minimum_direction_trades_per_retained_run)
    .map(run=>({direction:item.value,run_id:run.run_id,observed_trades:run.trades,
      required_trades:screeningPolicy.minimum_direction_trades_per_retained_run})));
  const insufficiencyReasons=[
    ...(!coverageProven?['HISTORICAL_COVERAGE_NOT_PROVEN']:[]),
    ...(periodIds.size<screeningPolicy.minimum_distinct_declared_periods?['INSUFFICIENT_DISTINCT_DECLARED_PERIODS']:[]),
    ...(!experiments.length?['NO_RECORDED_DIRECTION_GROUPS']:[]),
    ...(sampleShortfalls.length?['INSUFFICIENT_DIRECTION_SAMPLE_IN_RETAINED_RUN']:[]),
  ];
  const assessmentComplete=insufficiencyReasons.length===0;
  const sufficiency={status:assessmentComplete?'SUFFICIENT':'INSUFFICIENT',assessment_complete:assessmentComplete,
    scope:'RECORDED_ENTRY_DIRECTION_DISCOVERY_SCREEN_ONLY',reasons:insufficiencyReasons,
    evaluated_direction_values:experiments.filter(item=>item.evidence_sufficient).map(item=>item.value),
    unevaluated_direction_values:experiments.filter(item=>!item.evidence_sufficient).map(item=>item.value),
    missing_coverage_run_ids:coverageByRun.filter(run=>run.coverage===null).map(run=>run.run_id),
    distinct_declared_periods:periodIds.size,sample_shortfalls:sampleShortfalls};
  const remediation=evidenceRemediation(sufficiency);
  const result={
    schema_version:RESEARCH_VERSION,
    outcome:proposals.length?'EXPLORATORY_PROPOSAL':assessmentComplete?'NO_SUPPORTED_CHANGE':'INSUFFICIENT_EVIDENCE',
    screening_policy:screeningPolicy,
    evidence_sufficiency:sufficiency,evidence_remediation:remediation,
    eligible_run_ids:eligibleIds,
    evidence_hash:objectHash(rows), cohort_hash:objectHash(bundle.cohort),
    accounting_basis:'Recorded simulated execution gross P&L, logger-recorded fees and net (gross minus fees); wins use recorded net P&L > 0.',
    fee_provenance:{basis:'OBSERVED_CURRENT_LOGGER_SCHEDULE',source_field:'total_commission',
      historical_broker_fee_schedule_independently_verified:false,
      note:'Fees are observed from the current simulation logger, not independently verified historical broker fees.'},
    aggregate:totals(rows), per_run:perRun,
    missing_exit_attribution:rows.filter(row=>unknown(row.exit_causality)).length,
    observed_sierra_date_count:new Set(rows.map(row=>Math.trunc(Number(row.entry_datetime)))).size,
    date_count_basis:'Unique floored Sierra decimal entry dates; not sessions or independent periods.',
    historical_periods:{basis:'DECLARED_REQUESTED_COVERAGE',counting_policy:'UNIQUE_COVERAGE_FOR_PROPOSAL_SUPPORT_ONLY',
      accounting_runs_retained:true,distinct_coverage_count:periodIds.size,
      statistical_independence_verified:false,
      missing_coverage_run_ids:coverageByRun.filter(run=>run.coverage===null).map(run=>run.run_id),
      runs:coverageByRun.map(run=>({run_id:run.run_id,historical_period_id:run.period_id,requested_coverage:run.coverage}))},
    experiments, observational_breakdowns:observations, proposals,
    excluded_evidence:bundle.excluded_evidence,
    candidate_validation:{status:'NOT_DUE',candidate_hash:null,tests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'],
      reason:'Baseline discovery is not candidate validation; no frozen candidate or independent holdout was tested.'},
    limitations:[
      'Lifecycle model reports are not executed-trade accounting and are not blended into these totals.',
      'P&L is recorded simulated execution, not verified historical broker execution; current logger fees are not an independently verified historical broker schedule.',
      'Signal session_name and regime_label are observational, not lookahead-safe filters: their pre-entry availability is not independently proven.',
      'A signal session label is not the execution session; an Asia signal label can accompany a London 08:00 entry.',
      'Unknown exit labels are missing attribution, not a profitable entry condition.',
      'Volatility quantile labels have run-specific thresholds and cannot define a cross-period numeric rule.',
      'Sierra decimal date counts, upstream session counts and distinct declared coverage do not prove sessions, independent periods, statistical independence or a probability of success.',
      'Repeated exact coverage counts once for direction-proposal period support only; distinct upstream configurations and all qualified trades remain in accounting. Overlapping or distinct coverage is not proven independent.',
      'Exploratory exclusion deltas are in-sample and do not establish candidate performance.',
      'Evidence sufficiency applies only to the recorded entry-direction discovery screen, not all possible improvements or candidate validation. Its existing thresholds are not independently statistically calibrated.',
    ],
    next_action:proposals.length
      ?`Review the exploratory direction proposal before freezing a separate candidate; test it on independent evidence.${assessmentComplete?'':` Other recorded direction groups remain unassessed. ${remediation.next_action}`} No actual candidate exists and no trading change has been made.`
      :assessmentComplete
        ?'Keep the current baseline. The recorded direction screen met its evidence floor, but no supported direction filter was found across every qualified historical coverage. This does not evaluate all possible improvements. No actual candidate exists. No approval is pending.'
        :`Keep the current baseline. Research recorded insufficient evidence, not an evaluated no-change finding. ${remediation.next_action} No actual candidate exists. No approval is pending.`,
    authority,
  };
  return result;
}

export class OperationalResearch {
  constructor(backend) { this.backend=backend;this.db=backend.db;this.running=false;this.stopped=false;
    this.version=RESEARCH_VERSION;this.continuations=new OperationalContinuation(this); }
  stop() {this.stopped=true;}
  remediation(sufficiency){return evidenceRemediation(sufficiency);}
  historicalCompletion(caseId,artifactId=null) {
    return this.db.prepare(`SELECT * FROM ow_research_jobs WHERE case_id=? AND state='COMPLETED'
      AND result_artifact_id IS NOT NULL AND (? IS NULL OR artifact_id=?) ORDER BY rowid DESC LIMIT 1`)
      .get(caseId,artifactId,artifactId);
  }
  enqueue(caseId,artifactId) {
    const row=this.backend.one('ow_cases',caseId);
    requireThat(JSON.parse(row.payload_json).origin==='OPERATIONAL_LEARNING',409,'RESEARCH_OPERATIONAL_CASE_REQUIRED');
    const artifact=this.backend.artifactFor(row,artifactId,'RECOMMENDATION');
    const content=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    requireThat(content.schema_version==='ocean-operational-learning-recommendation/v1'
      && Object.keys(authority).every(key=>content.authority?.[key]===false),409,'RESEARCH_AUTHORITY_BOUNDARY');
    const hash=JSON.parse(artifact.manifest_json).content_hash;
    // Completed cases are historical snapshots, never automatic version backfill.
    // Re-ACK keeps its completed job ID even if a newer trigger has superseded it.
    if(row.work_status==='COMPLETED') {
      const historical=this.historicalCompletion(caseId,artifactId);
      requireThat(historical,409,'RESEARCH_COMPLETED_CASE_NO_BACKFILL');
      requireThat(historical.artifact_hash===hash,409,'RESEARCH_INPUT_HASH_CONFLICT');
      return historical;
    }
    const id=`research-${digest(`${caseId}:${artifactId}:${RESEARCH_VERSION}`).slice(-24)}`;
    const existing=this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(id);
    if(existing) { requireThat(existing.artifact_hash===hash,409,'RESEARCH_INPUT_HASH_CONFLICT');return existing; }
    const created=new Date().toISOString();
    this.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,next_attempt_ms,created_at_utc)
      VALUES(?,?,?,?,?,'PENDING',?,?)`).run(id,caseId,artifactId,hash,RESEARCH_VERSION,Date.now(),created);
    this.backend.event(caseId,'operational.research.queued',{id:'ocean-research',role:'BRAIN'},{job_id:id,artifact_id:artifactId,analysis_version:RESEARCH_VERSION});
    return this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(id);
  }
  reconcile() {
    for(const row of this.db.prepare(`SELECT c.id,a.id artifact_id FROM ow_cases c JOIN ow_artifacts a ON a.case_id=c.id
      WHERE json_extract(c.payload_json,'$.origin')='OPERATIONAL_LEARNING' AND a.kind='RECOMMENDATION'
      AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED')`).all()) {
      this.backend.store.transaction(()=>this.enqueue(row.id,row.artifact_id));
    }
    this.continuations.reconcile();
  }
  qualification(job) {
    try {
      const row=this.backend.one('ow_cases',job.case_id);
      const ids=[row.run_id];
      if(job.input_json && job.analysis_version===RESEARCH_VERSION) {
        requireThat(digest(job.input_json)===job.input_hash,409,'RESEARCH_SNAPSHOT_HASH_CONFLICT');
        const snapshot=JSON.parse(job.input_json);
        ids.push(...snapshot.result.eligible_run_ids);
      }
      const excluded=[...new Set(ids)].flatMap(id=>{
        const value=this.backend.operationalLearning.classification(this.backend.one('ow_runs',id));
        return value.eligible?[]:[{run_id:id,reasons:value.reasons}];
      });
      // Uncaptured work must still belong to the cohort it would capture. Frozen
      // input and completed history keep their original membership semantics.
      if(!excluded.length && !job.input_json && job.state!=='COMPLETED'
        && row.work_status!=='COMPLETED' && job.analysis_version===RESEARCH_VERSION) {
        try {
          const source=this.backend.operationalLearning.cohort(this.backend.one('ow_runs',row.run_id));
          requireThat(source.cohort.eligible_runs.some(run=>run.run_id===row.run_id),409,'TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
        }catch(error) {
          if(error.code!=='TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT')throw error;
          return {verified:false,superseded:true,reason:error.code,
            excluded_runs:[{run_id:row.run_id,reasons:[error.code]}]};
        }
      }
      return {verified:excluded.length===0,excluded_runs:excluded};
    }catch(error) {
      return {verified:false,excluded_runs:[],reason:String(error.code || error.message || 'RESEARCH_PROVENANCE_PROOF_REQUIRED').slice(0,300)};
    }
  }
  statusForCase(caseId) {
    let job=this.db.prepare('SELECT * FROM ow_research_jobs WHERE case_id=? ORDER BY rowid DESC LIMIT 1').get(caseId);
    if(!job)return null;
    const completedCase=this.backend.one('ow_cases',caseId).work_status==='COMPLETED';
    const skipped=[];
    if(completedCase && job.state!=='COMPLETED') {
      skipped.push({job_id:job.id,analysis_version:job.analysis_version,state:job.state,input_hash:job.input_hash,
        reason:'COMPLETED_HISTORICAL_CASE_VERSION_BACKFILL'});
      const historical=this.historicalCompletion(caseId);
      if(historical)job=historical;
    }
    const artifact=job.result_artifact_id?this.backend.one('ow_artifacts',job.result_artifact_id):null;
    if(artifact)requireThat(digest(Buffer.from(artifact.content))===job.result_hash
      && JSON.parse(artifact.manifest_json).content_hash===job.result_hash,409,'RESEARCH_RESULT_HASH_CONFLICT');
    const report=artifact?JSON.parse(Buffer.from(artifact.content).toString('utf8')):null;
    const currentQualification=this.qualification(job);
    const superseded=currentQualification.superseded===true;
    const historical=superseded || (job.state==='COMPLETED' && (job.analysis_version!==RESEARCH_VERSION || skipped.length>0));
    const supersededAction='This uncaptured Research case is retained as superseded history: its trigger is outside the current exact-coverage cohort. No completion is claimed and automatic retry is not due. Continue Research on the current eligible case; recorded job state and historical artifacts remain unchanged.';
    const continuations=this.continuations.links(caseId);
    const openContinuations=continuations.filter(item=>item && (item.blocked_reason || !['COMPLETED','CANCELLED'].includes(item.work_status)));
    const continuationAction=openContinuations.map(item=>`${item.case_id}: ${item.next_action}`).join(' ');
    const evidenceReassessed=continuations.filter(item=>!item?.blocked_reason && item?.progress?.status==='REASSESSED');
    const continuationFailure=this.db.prepare("SELECT payload_json FROM ow_events WHERE entity_id=? AND action='operational.research.continuation.blocked' ORDER BY id DESC LIMIT 1").get(caseId);
    const continuationWarning=job.state==='COMPLETED' && !historical && currentQualification.verified
      && !continuations.length && continuationFailure ? JSON.parse(continuationFailure.payload_json).payload.next_action : null;
    return {job_id:job.id,state:job.state,attempts:job.attempts,analysis_version:job.analysis_version,
      result_artifact_id:job.result_artifact_id,result_hash:job.result_hash,last_error:job.last_error,
      input_hash:job.input_hash,
      completed_at_utc:job.completed_at_utc,report,
      historical,
      superseded,
      historical_reason:superseded?'UNCAPTURED_TRIGGER_SUPERSEDED_BY_LATEST_EXACT_COVERAGE':historical?'PRESERVED_COMPLETED_RESEARCH':null,
      current_qualification:currentQualification,
      qualified_for_new_support:!historical && currentQualification.verified,
      effective_state:superseded?'HISTORICAL_SUPERSEDED':!currentQualification.verified && job.state!=='COMPLETED'?'BLOCKED_PROVENANCE':job.state,
      qualification_warning:superseded?supersededAction:historical
        ?'Preserved historical report: its original qualified-history label is not current physical/raw provenance proof. It cannot support new proposals without current qualification.'
        :!currentQualification.verified?PROVENANCE_ACTION:null,
      version_backfill_skipped:completedCase && (job.analysis_version!==RESEARCH_VERSION || skipped.length>0),
      skipped_version_backfill_jobs:skipped,
      continuations,
      loop_stage:openContinuations.length?openContinuations.some(item=>item.blocked_reason || item.work_status==='BLOCKED')?'BLOCKED_CONTINUATION'
        :openContinuations.some(item=>item.kind==='PROPOSAL_PLANNING')?'PROPOSAL_PLANNING'
        :openContinuations.some(item=>item.evidence_remediation?.requires_design_review)?'RESEARCH_DESIGN_REVIEW_REQUIRED':'EVIDENCE_REQUIRED'
        :evidenceReassessed.length?evidenceReassessed.some(item=>item.progress.outcome==='EXPLORATORY_PROPOSAL')?'PROPOSAL_PLANNING':'DIRECTION_SCREEN_NO_SUPPORTED_CHANGE'
        :continuationWarning?'BLOCKED_CONTINUATION':null,
      next_action:superseded?supersededAction:completedCase && job.state==='COMPLETED' && (job.analysis_version!==RESEARCH_VERSION || skipped.length>0)
        ?`Historical Research is completed and preserved. Completed cases are not version backfilled; new evidence cases use v4. No current version backfill is queued for this case and no candidate or approval is created. ${PROVENANCE_ACTION}`
        :completedCase && job.state!=='COMPLETED'
          ?'This completed case has a retained historical queue entry but no completed Research report. Version backfill will not run; the entry is not current pending work and no completion is claimed.'
        :!currentQualification.verified?PROVENANCE_ACTION
        :continuationAction || evidenceReassessed.map(item=>item.next_action).join(' ') || continuationWarning || report?.next_action || (job.state==='RETRY'?'Ocean will retry Research automatically; no human approval is pending.':'Ocean Research is queued and will resume after a website restart.')};
  }
  claim() {
    return this.backend.store.transaction(()=>{
      const jobs=this.db.prepare(`SELECT j.* FROM ow_research_jobs j JOIN ow_cases c ON c.id=j.case_id
        WHERE j.analysis_version=? AND ((j.state IN ('PENDING','RETRY') AND j.next_attempt_ms<=?)
        OR (j.state='RUNNING' AND j.lease_until_ms<=?)) AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED')
        ORDER BY j.rowid`).all(RESEARCH_VERSION,Date.now(),Date.now());
      // Schema 11 has no SKIPPED state. Completed-case backfills and any frozen
      // inputs stay untouched and unclaimed across restarts; fresh cases use v4.
      // Ineligible evidence is owner-action work, not a repeatedly leased RETRY.
      const job=jobs.find(value=>this.qualification(value).verified);
      if(!job)return null;
      const lease=randomUUID();
      this.db.prepare("UPDATE ow_research_jobs SET state='RUNNING',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?")
        .run(lease,Date.now()+300000,job.id);
      return {...job,lease_id:lease,attempts:job.attempts+1};
    });
  }
  evidence(job) {
    const row=this.backend.one('ow_cases',job.case_id);
    this.backend.baseline(row);
    const artifact=this.backend.artifactFor(row,job.artifact_id,'RECOMMENDATION');
    requireThat(digest(Buffer.from(artifact.content))===job.artifact_hash,409,'RESEARCH_INPUT_HASH_CONFLICT');
    const run=this.backend.one('ow_runs',row.run_id);
    const source=this.backend.operationalLearning.cohort(run);
    const bundle={...source,research_coverage:Object.fromEntries(source.cohort.eligible_runs.map(item=>[item.run_id,
      this.backend.operationalLearning.classification(this.backend.one('ow_runs',item.run_id))
        .summary?.completion?.requested_coverage || []]))};
    const database=new DatabaseSync(this.backend.operationalLearning.telemetryDb,{readOnly:true,timeout:2000});
    try {
      const rows=bundle.cohort.eligible_runs.flatMap(run=>database.prepare(`SELECT trade_id,run_id,entry_datetime,direction,
        gross_currency_value,total_commission,net_profit_loss,exit_causality,session_name,regime_label
        FROM ocean_trade_causal_v2 WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id`).all(run.run_id));
      const context=JSON.parse(run.context_json);
      return {bundle,rows,row,context,completion_hash:objectHash(this.backend.operationalLearning.classification(run).summary.completion),recipient:artifact.recipient_id};
    } finally {database.close();}
  }
  capture(job) {
    const current=this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(job.id);
    if(current.analysis_version===RESEARCH_VERSION)requireThat(this.qualification(current).verified,409,'RESEARCH_CURRENT_PROVENANCE_REQUIRED');
    if(current.input_json) {
      requireThat(digest(current.input_json)===current.input_hash,409,'RESEARCH_SNAPSHOT_HASH_CONFLICT');
      return JSON.parse(current.input_json);
    }
    const evidence=this.evidence(job);
    const result=evaluateResearch(evidence.bundle,evidence.rows);
    const snapshot={result,evidence:{bundle:{cohort:evidence.bundle.cohort,excluded_evidence:evidence.bundle.excluded_evidence,
      policy:evidence.bundle.policy},row:evidence.row,context:evidence.context,completion_hash:evidence.completion_hash,recipient:evidence.recipient}};
    const content=JSON.stringify(snapshot);
    const updated=this.db.prepare(`UPDATE ow_research_jobs SET input_json=?,input_hash=?
      WHERE id=? AND state='RUNNING' AND lease_id=? AND input_json IS NULL`).run(content,digest(content),job.id,job.lease_id);
    requireThat(updated.changes===1,409,'RESEARCH_SNAPSHOT_LEASE_CONFLICT');
    return JSON.parse(content);
  }
  async recordInBrain(job,evidence,result) {
    const learner=this.backend.operationalLearning;
    const token=learner.token();
    await learner.verifyIdentity(token);
    const current=this.db.prepare('SELECT brain_request_json,brain_request_hash FROM ow_research_jobs WHERE id=?').get(job.id);
    let input;
    if(current.brain_request_json) {
      requireThat(digest(current.brain_request_json)===current.brain_request_hash,409,'RESEARCH_REQUEST_HASH_CONFLICT');
      input=JSON.parse(current.brain_request_json);
    } else {
      const registry=await learner.registry(token);
      if(this.stopped)return null;
      const context=evidence.context;
      // Exclusions are supplied in the API's evidence field; do not duplicate
      // the entire evidence catalog inside its bounded recommendation field.
      const {excluded_evidence,...evaluation}=result;
      const proposal={schema_version:'ocean-evidence-bound-learning-proposal/v1',
      strategy_id:evidence.row.strategy_id,eligible_run_ids:result.eligible_run_ids,
      research_evaluation:evaluation,research_input_hash:job.input_hash || this.db.prepare('SELECT input_hash FROM ow_research_jobs WHERE id=?').get(job.id).input_hash,
      excluded_evidence_hash:objectHash(excluded_evidence),authority};
      const proposalContent=JSON.stringify(proposal);
      requireThat(proposalContent.length<=50000,422,'RESEARCH_BRAIN_RECOMMENDATION_SIZE_LIMIT');
      input={schema_version:'ocean-operational-learning-request/v1',project:evidence.bundle.policy.project,
      case_id:job.case_id,strategy_id:evidence.row.strategy_id,strategy_name:evidence.bundle.policy.strategy_name,
      strategy_profile_id:context.strategy_profile_id,strategy_version:context.strategy_version,
      execution_instance_id:context.execution_instance_id,registry_reconciliation_id:registry.reconciliation_id,
      registry_record_sha256:registry.record_sha256,dataset_manifest_hash:context.dataset_manifest_hash,
      trigger:{run_id:evidence.row.run_id,context_hash:context.context_hash,
        completion_hash:evidence.completion_hash},
      cohort:evidence.bundle.cohort,excluded_evidence:evidence.bundle.excluded_evidence,
      proposed_recommendation:{title:`Completed exploratory Research: ${result.outcome}`,content:proposalContent},
      correlation:{event_id:`research-event:${job.id}`,job_id:job.id}};
      input=JSON.parse(JSON.stringify(input));
      input.correlation.input_sha256=objectHash(input);
      const content=JSON.stringify(input);
      const updated=this.db.prepare(`UPDATE ow_research_jobs SET brain_request_json=?,brain_request_hash=?
        WHERE id=? AND state='RUNNING' AND lease_id=? AND brain_request_json IS NULL`).run(content,digest(content),job.id,job.lease_id);
      requireThat(updated.changes===1,409,'RESEARCH_REQUEST_LEASE_CONFLICT');
    }
    requireThat(this.qualification(this.backend.one('ow_research_jobs',job.id)).verified,409,'RESEARCH_CURRENT_PROVENANCE_REQUIRED');
    const response=await learner.call(learner.path,token,input);
    const ids=[...result.eligible_run_ids,...evidence.bundle.excluded_evidence.map(run=>run.run_id)];
    let stored=null;
    try {stored=JSON.parse(response?.content || '{}');}catch{}
    requireThat(response?.schema_version==='ocean-operational-learning-result/v1' && response.record_id
      && response.relative_path && typeof response.content==='string' && digest(response.content)===response.content_sha256
      && objectHash(response.correlation)===objectHash(input.correlation)
      && ids.every(id=>response.source_record_ids?.includes(id))
      && stored?.registry_record_sha256===input.registry_record_sha256
      && stored?.registry_reconciliation_id===input.registry_reconciliation_id,503,'RESEARCH_BRAIN_RESPONSE_INVALID');
    return {record_id:response.record_id,relative_path:response.relative_path,content_hash:response.content_sha256,
      correlation:response.correlation,method:'Deterministic Research recorded through the protected operational learning API; not an LLM trading decision.'};
  }
  complete(job,result,actor,recipient) {
    return this.backend.store.transaction(()=>{
      const current=this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(job.id);
      requireThat(this.qualification(current).verified,409,'RESEARCH_CURRENT_PROVENANCE_REQUIRED');
      requireThat(current.state==='RUNNING' && current.lease_id===job.lease_id && current.lease_until_ms>Date.now(),409,'RESEARCH_LEASE_EXPIRED');
      const report={...result,job_id:job.id,case_id:job.case_id,source_recommendation_id:job.artifact_id,
        source_recommendation_hash:job.artifact_hash,completed_at_utc:new Date().toISOString()};
      const content=JSON.stringify(report,null,2);
      const artifactId=`test-research-result-${job.id.slice('research-'.length)}`;
      const row=this.backend.one('ow_cases',job.case_id);
      this.backend.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:recipient,
        kind:'OUTCOME',media_type:'application/json',content,content_encoding:'utf8',content_hash:digest(content),
        candidate_hash:null,dependency_ids:[job.artifact_id]});
      this.db.prepare(`UPDATE ow_research_jobs SET state='COMPLETED',lease_id=NULL,lease_until_ms=NULL,last_error=NULL,
        result_artifact_id=?,result_hash=?,completed_at_utc=? WHERE id=?`).run(artifactId,digest(content),report.completed_at_utc,job.id);
      const completedJob=this.backend.one('ow_research_jobs',job.id);
      this.continuations.ensure(completedJob,actor);
      const continuationSource=this.continuations.source(completedJob);
      if(continuationSource)this.continuations.reconcileEvidence(continuationSource,actor);
      this.db.prepare("UPDATE ow_cases SET work_status='COMPLETED',revision=revision+1,waiting_on=NULL WHERE id=?").run(row.id);
      this.backend.event(row.id,'operational.research.complete',actor,{job_id:job.id,result_artifact_id:artifactId,
        result_hash:digest(content),outcome:result.outcome,next_action:result.next_action,automatic_strategy_change:false});
      return this.statusForCase(row.id);
    });
  }
  fail(job,error) {
    const message=String(error.code || error.message || 'RESEARCH_FAILED').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300);
    this.db.prepare("UPDATE ow_research_jobs SET state='RETRY',lease_id=NULL,lease_until_ms=NULL,last_error=?,next_attempt_ms=? WHERE id=? AND lease_id=?")
      .run(message,Date.now()+Math.min(300000,1000*2**Math.min(job.attempts,8)),job.id,job.lease_id);
  }
  async flushOnce() {
    if(this.running || this.stopped || !this.backend.operationalLearning.enabled)return;
    this.running=true;
    try {
      this.reconcile();
      let job;
      while(!this.stopped && (job=this.claim())) {
        try {
          const {evidence,result}=this.capture(job);
          result.brain_record=await this.recordInBrain(job,evidence,result);
          if(this.stopped)return;
          const actor=this.backend.operationalLearning.brainActor(evidence.row.strategy_id,evidence.row.instance_id);
          this.complete(job,result,actor,evidence.recipient);
        }catch(error){if(!this.stopped)this.fail(job,error);}
      }
    }finally{this.running=false;}
  }
}
