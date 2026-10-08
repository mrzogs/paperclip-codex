import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROVENANCE_ACTION, parseSttl2Identity } from './operational-learning.mjs';
import { digest, objectHash, requireThat } from './common.mjs';
import { OperationalContinuation } from './operational-continuation.mjs';
import { researchReportContent, readResearchReport } from './operational-research-report.mjs';
import { RESEARCH_V5, RESEARCH_V6, REASSESSMENT_ORIGIN, evaluateV6, readObservedSessionProofs, remediationV6 } from './operational-research-protocol.mjs';

// New physical/raw provenance gates apply only to new jobs, never relabel history.
export const LEGACY_RESEARCH_VERSION = 'ocean-cumulative-research/v4';
export const RESEARCH_VERSION = RESEARCH_V6;
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
  if(fixed.length)actions.push(`Research design review required for ${fixed.map(item=>`${item.direction} in ${item.run_id} (${item.observed_trades}/${item.required_trades})`).join(', ')}. Adding later runs cannot increase those frozen counts. The Research engineering owner must author and test a prospective sampling-unit/protocol revision under the existing engineering authorization. Preserve this v4 snapshot, every contradiction and the approved aggregate evidence policy; no candidate or holdout tuning is authorized by this review.`);
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
export function evaluateResearchV4(bundle, rows) {
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
    schema_version:LEGACY_RESEARCH_VERSION,
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

export function evaluateResearch(bundle,rows) {
  return evaluateV6(bundle,rows,evaluateResearchV4(bundle,rows));
}

export function boundedResearchRecommendation(job,result) {
  const {excluded_evidence,...evaluation}=result;
  const full={schema_version:'ocean-evidence-bound-learning-proposal/v2',research_evaluation:evaluation,
    research_input_hash:job.input_hash,excluded_evidence_hash:objectHash(excluded_evidence),authority};
  const content=JSON.stringify(full);
  if(content.length<=50000)return content;
  // The complete report and evidence already live in the immutable job snapshot.
  // The wire summary references them rather than clipping returns/contradictions.
  const summary={schema_version:full.schema_version,representation:'BOUNDED_SUMMARY_WITH_FULL_FROZEN_SOURCE_REFERENCES',
    source:{table:'ow_research_jobs',job_id:job.id,input_hash:job.input_hash,
      result_hash:objectHash(result),result_content_bytes:Buffer.byteLength(JSON.stringify(result),'utf8')},
    outcome:result.outcome,aggregate:result.aggregate,cohort_hash:result.cohort_hash,evidence_hash:result.evidence_hash,
    protocol:result.protocol || null,approved_policy_hash:result.approved_evidence_eligibility?.policy_hash || null,
    evidence_status:result.evidence_sufficiency?.status || null,
    experiment_count:result.experiments.length,experiments_hash:objectHash(result.experiments),
    proposal_count:result.proposals.length,proposals_hash:objectHash(result.proposals),
    hypotheses_hash:objectHash(result.hypotheses || []),excluded_evidence_hash:full.excluded_evidence_hash,
    authority,note:'Full executed accounting, all retained strata/contradictions, native proof and report are preserved in the immutable snapshot. This bounded content is not the full report or candidate validation.'};
  const bounded=JSON.stringify(summary);
  requireThat(bounded.length<=50000,422,'RESEARCH_BRAIN_BOUNDED_SUMMARY_SIZE_LIMIT');
  return bounded;
}

export class OperationalResearch {
  constructor(backend) { this.backend=backend;this.db=backend.db;this.running=false;this.stopped=false;
    this.version=RESEARCH_VERSION;this.continuations=new OperationalContinuation(this); }
  stop() {this.stopped=true;}
  remediation(sufficiency){return sufficiency.scope==='RECORDED_ENTRY_DIRECTION_DISCOVERY_SCREEN_ONLY'
    && 'missing_distinct_block_count' in sufficiency?remediationV6(sufficiency):evidenceRemediation(sufficiency);}
  historicalCompletion(caseId,artifactId=null) {
    return this.db.prepare(`SELECT * FROM ow_research_jobs WHERE case_id=? AND state='COMPLETED'
      AND result_artifact_id IS NOT NULL AND (? IS NULL OR artifact_id=?) ORDER BY rowid DESC LIMIT 1`)
      .get(caseId,artifactId,artifactId);
  }
  enqueue(caseId,artifactId) {
    const row=this.backend.one('ow_cases',caseId);
    const reassessment=JSON.parse(row.payload_json).origin===REASSESSMENT_ORIGIN;
    requireThat(reassessment || JSON.parse(row.payload_json).origin==='OPERATIONAL_LEARNING',409,'RESEARCH_OPERATIONAL_CASE_REQUIRED');
    const artifact=this.backend.artifactFor(row,artifactId,reassessment?'EVIDENCE':'RECOMMENDATION');
    const content=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    requireThat(content.schema_version===(reassessment?'ocean-operational-research-reassessment/v1':'ocean-operational-learning-recommendation/v1')
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
    // A previously frozen job resumes its exact version/input; never recapture it as v6.
    const frozen=this.db.prepare("SELECT * FROM ow_research_jobs WHERE case_id=? AND artifact_id=? AND analysis_version IN (?,?) AND input_json IS NOT NULL AND state<>'COMPLETED' ORDER BY rowid DESC LIMIT 1").get(caseId,artifactId,LEGACY_RESEARCH_VERSION,RESEARCH_V5);
    if(frozen){requireThat(frozen.artifact_hash===hash,409,'RESEARCH_INPUT_HASH_CONFLICT');return frozen;}
    const id=`research-${digest(`${caseId}:${artifactId}:${this.version}`).slice(-24)}`;
    const existing=this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(id);
    if(existing) { requireThat(existing.artifact_hash===hash,409,'RESEARCH_INPUT_HASH_CONFLICT');return existing; }
    const created=new Date().toISOString();
    this.db.prepare(`INSERT INTO ow_research_jobs(id,case_id,artifact_id,artifact_hash,analysis_version,state,next_attempt_ms,created_at_utc)
      VALUES(?,?,?,?,?,'PENDING',?,?)`).run(id,caseId,artifactId,hash,this.version,Date.now(),created);
    this.backend.event(caseId,'operational.research.queued',{id:'ocean-research',role:'BRAIN'},{job_id:id,artifact_id:artifactId,analysis_version:this.version});
    return this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(id);
  }
  reconcile() {
    for(const row of this.db.prepare(`SELECT c.id,a.id artifact_id FROM ow_cases c JOIN ow_artifacts a ON a.case_id=c.id
      WHERE json_extract(c.payload_json,'$.origin')='OPERATIONAL_LEARNING' AND a.kind='RECOMMENDATION'
      AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED')`).all()) {
      this.backend.store.transaction(()=>this.enqueue(row.id,row.artifact_id));
    }
    this.continuations.reconcile();
    if(this.version===RESEARCH_VERSION)this.reconcileFollowUps();
  }
  queueEvidenceReview(run,actor,result,details,bundle) {
    requireThat(actor.role==='BRAIN' && actor.namespace==='OPERATIONAL'
      && this.continuations.ownerCurrent(actor.id,run),403,'RESEARCH_CURRENT_OWNER_REQUIRED');
    this.backend.authorize(actor,'artifact.write',run.strategy_id,run.instance_id);
    this.backend.authorize(actor,'event.write',run.strategy_id,run.instance_id);
    requireThat(this.backend.operationalLearning.classification(run).eligible && ['NO_CHANGE','BLOCKED'].includes(details?.conclusion_type)
      && result.context_hash===JSON.parse(run.context_json).context_hash,409,'RESEARCH_SCOPED_LEARNING_RESULT_REQUIRED');
    const stored=this.db.prepare('SELECT payload_json FROM ow_operational_brain_results WHERE id=? AND run_id=?').get(result.result_id,run.id);
    const recorded=stored?JSON.parse(stored.payload_json):null;
    requireThat(recorded?.content_sha256===result.content_sha256 && recorded.producer_id===actor.id
      && recorded.context_hash===result.context_hash && digest(recorded.content)===result.content_sha256
      && objectHash(JSON.parse(recorded.content))===objectHash(details),409,'RESEARCH_RECORDED_LEARNING_RESULT_REQUIRED');
    const recipient=this.backend.config.identities.find(identity=>identity.namespace==='OPERATIONAL' && identity.role==='STRATEGY'
      && !identity.revoked && Date.parse(identity.expires_at_utc)>Date.now() && identity.strategy_ids.includes(run.strategy_id)
      && identity.instance_ids.includes(run.instance_id) && identity.scopes.includes('read') && this.backend.store.identityCurrent(identity)
      && !this.backend.auth?.bindingErrors?.has(identity.identity_id));
    requireThat(recipient,409,'RESEARCH_SCOPED_RECIPIENT_REQUIRED');
    return this.backend.store.transaction(()=>{
      const fingerprint=objectHash({run_id:run.id,result_id:result.result_id,result_hash:result.content_sha256,cohort_hash:objectHash(bundle.cohort),version:this.version});
      const caseId=`research-evidence-${fingerprint.slice(7)}`,artifactId=`test-research-evidence-${fingerprint.slice(7)}`;
      if(!this.db.prepare('SELECT id FROM ow_cases WHERE id=?').get(caseId)) {
        const registry=this.backend.one('ow_strategies',run.strategy_id);
        const content=JSON.stringify({schema_version:'ocean-operational-research-reassessment/v1',
          learning_result_id:result.result_id,learning_result_hash:result.content_sha256,learning_conclusion:details.conclusion_type,
          basis:'DETERMINISTIC_RESEARCH_REQUIRED_NOT_A_FABRICATED_RECOMMENDATION',cohort_hash:objectHash(bundle.cohort),authority});
        this.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,?,?,?)").run(caseId,run.strategy_id,run.instance_id,
          run.id,registry.baseline_hash,actor.id,'Evaluate recorded executions and evidence sufficiency; a Brain no-change conclusion is not proof of an assessed direction screen.',
          JSON.stringify({origin:REASSESSMENT_ORIGIN,registry_revision:registry.revision,registry_reconciliation_id:details.registry_reconciliation_id,
            registry_record_sha256:details.registry_record_sha256,evidence_revision_hash:fingerprint}));
        this.backend.writeArtifact(actor,{artifact_id:artifactId,case_id:caseId,run_id:run.id,recipient_id:recipient.identity_id,kind:'EVIDENCE',
          media_type:'application/json',content,content_hash:digest(content),candidate_hash:null,dependency_ids:[]});
      }
      const job=this.enqueue(caseId,artifactId);
      return {case_id:caseId,artifact_id:artifactId,job_id:job.id,recipient_id:recipient.identity_id,stage:'RESEARCH',work_status:'READY'};
    });
  }
  reconcileFollowUps() {
    for(const child of this.db.prepare("SELECT * FROM ow_cases WHERE json_extract(payload_json,'$.origin')='OPERATIONAL_RESEARCH_CONTINUATION' AND json_extract(payload_json,'$.kind')='EVIDENCE_FOLLOW_UP' AND work_status NOT IN ('COMPLETED','CANCELLED','PAUSED','FAILED')").all()) {
      const view=this.continuations.forCase(child);
      if(!view.qualified_for_planning)continue;
      try {
        const payload=JSON.parse(child.payload_json),lineage=JSON.parse(Buffer.from(this.backend.artifactFor(child,payload.lineage_artifact_id).content).toString());
        const original=this.backend.one('ow_research_jobs',lineage.source.job_id),frozen=JSON.parse(original.input_json);
        const candidates=this.db.prepare("SELECT * FROM ow_runs WHERE strategy_id=? AND state='COMPLETED' ORDER BY rowid DESC").all(child.strategy_id);
        let source=null,trigger=null;
        for(const run of candidates) {
          if(!this.backend.operationalLearning.classification(run).eligible)continue;
          try{source=this.backend.operationalLearning.cohort(run);trigger=run;break;}
          catch(error){if(error.code!=='TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT')throw error;}
        }
        if(!source)continue;
        const rows=source.cohort.eligible_runs.flatMap(run=>this.sessionRows(run.run_id));
        const profile=JSON.parse(this.backend.one('ow_profiles',this.backend.one('ow_strategies',child.strategy_id).profile_id).payload_json);
        const sessions=this.observedSessions(source,rows);
        const fingerprint=(cohort,policy,proofs)=>objectHash({cohort_hash:objectHash(cohort),policy_hash:policy?objectHash(policy):null,
          session_receipts:Object.entries(proofs || {}).map(([run_id,proof])=>({run_id,hash:proof.source_receipt_hash || proof.proof_error || null})).sort((a,b)=>a.run_id.localeCompare(b.run_id))});
        const current=fingerprint(source.cohort,profile.evidence_policy,sessions);
        if(current===fingerprint(frozen.evidence.bundle.cohort,frozen.evidence.bundle.approved_evidence_policy,frozen.evidence.bundle.execution_sessions))continue;
        const actor=this.backend.operationalLearning.brainActor(child.strategy_id,child.instance_id);
        requireThat(actor.id===child.owner_id && this.continuations.ownerCurrent(actor.id,child),403,'REASSESSMENT_CURRENT_OWNER_REQUIRED');
        this.backend.store.transaction(()=>{
          const caseId=`research-reassessment-${digest(`${child.id}:${current}:${this.version}`).slice(7)}`;
          if(this.db.prepare('SELECT id FROM ow_cases WHERE id=?').get(caseId))return;
          const content=JSON.stringify({schema_version:'ocean-operational-research-reassessment/v1',
            source_continuation_case_id:child.id,source:lineage.source,evidence_revision_hash:current,
            basis:'NEW_QUALIFIED_COHORT_OR_OBSERVED_POLICY_SESSION_PROOF',authority});
          const artifactId=`test-research-reassessment-${digest(content).slice(7)}`;
          const casePayload={...JSON.parse(frozen.evidence.row.payload_json),origin:REASSESSMENT_ORIGIN,
            source_continuation_case_id:child.id,evidence_revision_hash:current};
          this.db.prepare("INSERT INTO ow_cases VALUES(?,?,?,?,1,'RESEARCH','READY',?,NULL,?,?,?)").run(caseId,child.strategy_id,
            child.instance_id,trigger.id,child.baseline_hash,actor.id,'Evaluate the new qualified evidence revision; this is not a new Brain recommendation or candidate approval.',JSON.stringify(casePayload));
          this.backend.writeArtifact(actor,{artifact_id:artifactId,case_id:caseId,run_id:trigger.id,recipient_id:frozen.evidence.recipient,
            kind:'EVIDENCE',media_type:'application/json',content,content_hash:digest(content),candidate_hash:null,dependency_ids:[]});
          const job=this.enqueue(caseId,artifactId);
          this.backend.event(child.id,'operational.research.evidence.reassessment-queued',actor,{case_id:caseId,job_id:job.id,evidence_revision_hash:current});
        });
      }catch(error){
        const reason=String(error.code || 'REASSESSMENT_PROOF_REQUIRED').slice(0,200);
        if(!this.db.prepare("SELECT 1 FROM ow_events WHERE entity_id=? AND action='operational.research.evidence.reassessment-blocked' AND json_extract(payload_json,'$.payload.reason')=?").get(child.id,reason))
          this.backend.event(child.id,'operational.research.evidence.reassessment-blocked',{id:child.owner_id,role:'BRAIN',namespace:'OPERATIONAL'},
            {reason,next_action:'The existing Research owner must resolve this exact evidence/producer proof gap. No old report or input is rewritten.'});
      }
    }
  }
  qualification(job) {
    try {
      const row=this.backend.one('ow_cases',job.case_id);
      const ids=[row.run_id];
      if(job.input_json && [this.version,LEGACY_RESEARCH_VERSION,RESEARCH_V5].includes(job.analysis_version)) {
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
        && row.work_status!=='COMPLETED' && job.analysis_version===this.version) {
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
    let backfillSkipped=false;
    const skipped=this.db.prepare(`SELECT id,analysis_version,state,input_hash,attempts FROM ow_research_jobs
      WHERE case_id=? AND id<>? AND analysis_version<>? AND state<>'COMPLETED' ORDER BY rowid`).all(caseId,job.id,this.version)
      .map(old=>({job_id:old.id,analysis_version:old.analysis_version,state:old.state,input_hash:old.input_hash,attempts:old.attempts,
        effective_state:'HISTORICAL_SUPERSEDED',actionable:false,
        reason:'PRESERVED_SUPERSEDED_ANALYSIS_VERSION_NOT_CURRENT_WORK'}));
    if(completedCase && job.state!=='COMPLETED') {
      backfillSkipped=true;
      skipped.push({job_id:job.id,analysis_version:job.analysis_version,state:job.state,input_hash:job.input_hash,
        reason:'COMPLETED_HISTORICAL_CASE_VERSION_BACKFILL',effective_state:'HISTORICAL_SUPERSEDED',actionable:false});
      const historical=this.historicalCompletion(caseId);
      if(historical)job=historical;
    }
    const artifact=job.result_artifact_id?this.backend.one('ow_artifacts',job.result_artifact_id):null;
    const report=artifact?readResearchReport(job,artifact):null;
    const currentQualification=this.qualification(job);
    const superseded=currentQualification.superseded===true;
    const historical=superseded || (job.state==='COMPLETED' && (job.analysis_version!==this.version || backfillSkipped));
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
      version_backfill_skipped:completedCase && (job.analysis_version!==this.version || backfillSkipped),
      skipped_version_backfill_jobs:skipped,
      continuations,
      loop_stage:openContinuations.length?openContinuations.some(item=>item.blocked_reason || item.work_status==='BLOCKED')?'BLOCKED_CONTINUATION'
        :openContinuations.some(item=>item.kind==='PROPOSAL_PLANNING')?'PROPOSAL_PLANNING'
        :openContinuations.some(item=>item.evidence_remediation?.requires_design_review)?'RESEARCH_DESIGN_REVIEW_REQUIRED':'EVIDENCE_REQUIRED'
        :evidenceReassessed.length?evidenceReassessed.some(item=>item.progress.outcome==='EXPLORATORY_PROPOSAL')?'PROPOSAL_PLANNING':'DIRECTION_SCREEN_NO_SUPPORTED_CHANGE'
        :continuationWarning?'BLOCKED_CONTINUATION':null,
      next_action:superseded?supersededAction:completedCase && job.state==='COMPLETED' && (job.analysis_version!==this.version || backfillSkipped)
        ?`Historical Research is completed and preserved. Completed cases are not version backfilled; new evidence cases use ${this.version}. No current version backfill is queued for this case and no candidate or approval is created. ${PROVENANCE_ACTION}`
        :completedCase && job.state!=='COMPLETED'
          ?'This completed case has a retained historical queue entry but no completed Research report. Version backfill will not run; the entry is not current pending work and no completion is claimed.'
        :!currentQualification.verified?PROVENANCE_ACTION
        :continuationAction || evidenceReassessed.map(item=>item.next_action).join(' ') || continuationWarning || report?.next_action || (job.state==='RETRY'?'Ocean will retry Research automatically; no human approval is pending.':'Ocean Research is queued and will resume after a website restart.')};
  }
  claim() {
    return this.backend.store.transaction(()=>{
      const jobs=this.db.prepare(`SELECT j.* FROM ow_research_jobs j JOIN ow_cases c ON c.id=j.case_id
        WHERE (j.analysis_version=? OR (j.analysis_version IN (?,?) AND j.input_json IS NOT NULL)) AND ((j.state IN ('PENDING','RETRY') AND j.next_attempt_ms<=?)
        OR (j.state='RUNNING' AND j.lease_until_ms<=?)) AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED','COMPLETED')
        ORDER BY j.rowid`).all(this.version,LEGACY_RESEARCH_VERSION,RESEARCH_V5,Date.now(),Date.now());
      // Schema 11 has no SKIPPED state. Completed-case backfills and any frozen
      // inputs keep their version across restarts; fresh cases use v6.
      // Ineligible evidence is owner-action work, not a repeatedly leased RETRY.
      const job=jobs.find(value=>this.qualification(value).verified);
      if(!job)return null;
      const lease=randomUUID();
      this.db.prepare("UPDATE ow_research_jobs SET state='RUNNING',attempts=attempts+1,lease_id=?,lease_until_ms=? WHERE id=?")
        .run(lease,Date.now()+300000,job.id);
      return {...job,lease_id:lease,attempts:job.attempts+1};
    });
  }
  sessionRows(runId) {
    const database=new DatabaseSync(this.backend.operationalLearning.telemetryDb,{readOnly:true,timeout:2000});
    try{return database.prepare("SELECT trade_id,run_id,entry_datetime,trade_account,symbol FROM ocean_trade_causal_v2 WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id").all(runId);}
    finally{database.close();}
  }
  observedSessions(bundle,rows) {
    return readObservedSessionProofs(this.backend,bundle.cohort.eligible_runs.map(run=>run.run_id),rows);
  }
  descriptiveHistory(bundle,database) {
    const runs=[];
    for(const excluded of bundle.excluded_evidence) {
      const run=this.backend.one('ow_runs',excluded.run_id),context=JSON.parse(run.context_json);
      // No holdout/validation/TEST evidence is opened for descriptive history.
      if(run.id.startsWith('test-') || run.state!=='COMPLETED' || context.dataset_partition!=='DISCOVERY'
        || context.learner_permission!=='HISTORICAL_DISCOVERY')continue;
      const rows=database.prepare(`SELECT trade_id,instance_id,trade_account,symbol,strategy_version,dll_hash,text_tag,entry_datetime,
        direction,gross_currency_value,total_commission,net_profit_loss FROM trades
        WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id`).all(run.id);
      const accountingVerified=rows.every(row=>['gross_currency_value','total_commission','net_profit_loss'].every(key=>
        row[key]!=null && Number.isFinite(Number(row[key]))) && Number(row.total_commission)>=0
        && Math.abs(row.gross_currency_value-row.total_commission-row.net_profit_loss)<0.001);
      const strata=new Map();
      for(const row of rows) {
        const raw=parseSttl2Identity(row.text_tag),stratum={recorded_instance_id:row.instance_id,trade_account:row.trade_account,
          symbol:row.symbol,recorded_strategy_version:row.strategy_version,recorded_strategy_dll_hash:row.dll_hash,
          recorded_raw_profile:raw?.profile || null,recorded_raw_config_hash:raw?.config_hash || null,
          recorded_raw_code_hash:raw?.code_hash || null,recorded_raw_context_hash:raw?.context_hash || null};
        strata.set(objectHash(stratum),stratum);
      }
      const recordedPhysicalStrata=[...strata].map(([recorded_stratum_hash,stratum])=>({...stratum,recorded_stratum_hash}));
      runs.push({run_id:run.id,exclusion_reason_code:excluded.exclusion_reason_code,exclusion_reason:excluded.exclusion_reason,
        current_causal_support:false,recorded_trade_count:rows.length,accounting_reconciled:accountingVerified,
        accounting:accountingVerified?totals(rows):null,recorded_physical_strata:recordedPhysicalStrata,
        frozen_logical_scope:{context_hash:context.context_hash,strategy_profile_id:context.strategy_profile_id,
          strategy_profile_version:context.strategy_profile_version,strategy_code_hash:context.strategy_code_hash,
          strategy_config_hash:context.strategy_config_hash},source_rows_hash:objectHash(rows)});
    }
    return {status:'DESCRIPTIVE_EXCLUDED_HISTORY_NOT_CURRENT_CAUSAL_SUPPORT',runs,
      recorded_trade_count:runs.reduce((n,run)=>n+run.recorded_trade_count,0),source_hash:objectHash(runs),
      can_teach:'Recorded simulated execution/fee accounting, retained direction context and exact provenance/configuration differences.',
      cannot_teach:'New qualified causal proposal support, native session sufficiency, candidate acceptance or verified broker execution. Recorded DLL labels are not proven loaded-module identity.'};
  }
  evidence(job) {
    const row=this.backend.one('ow_cases',job.case_id);
    this.backend.baseline(row);
    const artifact=this.backend.artifactFor(row,job.artifact_id,JSON.parse(row.payload_json).origin===REASSESSMENT_ORIGIN?'EVIDENCE':'RECOMMENDATION');
    requireThat(digest(Buffer.from(artifact.content))===job.artifact_hash,409,'RESEARCH_INPUT_HASH_CONFLICT');
    const run=this.backend.one('ow_runs',row.run_id);
    const source=this.backend.operationalLearning.cohort(run);
    const bundle={...source,research_coverage:Object.fromEntries(source.cohort.eligible_runs.map(item=>[item.run_id,
      this.backend.operationalLearning.classification(this.backend.one('ow_runs',item.run_id))
        .summary?.completion?.requested_coverage || []]))};
    const database=new DatabaseSync(this.backend.operationalLearning.telemetryDb,{readOnly:true,timeout:2000});
    try {
      const identityColumns=job.analysis_version===LEGACY_RESEARCH_VERSION?'':'trade_account,symbol,';
      const rows=bundle.cohort.eligible_runs.flatMap(run=>database.prepare(`SELECT trade_id,run_id,entry_datetime,${identityColumns}direction,
        gross_currency_value,total_commission,net_profit_loss,exit_causality,session_name,regime_label
        FROM ocean_trade_causal_v2 WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id`).all(run.run_id));
      const context=JSON.parse(run.context_json);
      if(job.analysis_version!==LEGACY_RESEARCH_VERSION) {
        const profile=JSON.parse(this.backend.one('ow_profiles',this.backend.one('ow_strategies',row.strategy_id).profile_id).payload_json);
        bundle.approved_evidence_policy=profile.evidence_policy || null;
        bundle.execution_sessions=this.observedSessions(bundle,rows);
        bundle.descriptive_excluded_history=this.descriptiveHistory(bundle,database);
      }
      return {bundle,rows,row,context,completion_hash:objectHash(this.backend.operationalLearning.classification(run).summary.completion),recipient:artifact.recipient_id};
    } finally {database.close();}
  }
  capture(job) {
    const current=this.db.prepare('SELECT * FROM ow_research_jobs WHERE id=?').get(job.id);
    if([this.version,LEGACY_RESEARCH_VERSION,RESEARCH_V5].includes(current.analysis_version))requireThat(this.qualification(current).verified,409,'RESEARCH_CURRENT_PROVENANCE_REQUIRED');
    if(current.input_json) {
      requireThat(digest(current.input_json)===current.input_hash,409,'RESEARCH_SNAPSHOT_HASH_CONFLICT');
      return JSON.parse(current.input_json);
    }
    const evidence=this.evidence(job);
    const result=current.analysis_version===LEGACY_RESEARCH_VERSION?evaluateResearchV4(evidence.bundle,evidence.rows):evaluateResearch(evidence.bundle,evidence.rows);
    const snapshot={result,evidence:{bundle:{cohort:evidence.bundle.cohort,excluded_evidence:evidence.bundle.excluded_evidence,
      policy:evidence.bundle.policy,approved_evidence_policy:evidence.bundle.approved_evidence_policy,
      descriptive_excluded_history:evidence.bundle.descriptive_excluded_history,
      execution_sessions:evidence.bundle.execution_sessions},row:evidence.row,context:evidence.context,completion_hash:evidence.completion_hash,recipient:evidence.recipient}};
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
      const proposalContent=boundedResearchRecommendation({...job,input_hash:job.input_hash
        || this.db.prepare('SELECT input_hash FROM ow_research_jobs WHERE id=?').get(job.id).input_hash},result);
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
      const content=researchReportContent(current,report);
      const artifactId=`test-research-result-${job.id.slice('research-'.length)}`;
      const row=this.backend.one('ow_cases',job.case_id);
      this.backend.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:recipient,
        kind:'OUTCOME',media_type:'application/json',content,content_encoding:'utf8',content_hash:digest(content),
        candidate_hash:null,dependency_ids:[job.artifact_id]});
      this.db.prepare(`UPDATE ow_research_jobs SET state='COMPLETED',lease_id=NULL,lease_until_ms=NULL,last_error=NULL,
        result_artifact_id=?,result_hash=?,completed_at_utc=? WHERE id=?`).run(artifactId,digest(content),report.completed_at_utc,job.id);
      const completedJob=this.backend.one('ow_research_jobs',job.id);
      if(completedJob.analysis_version===this.version) {
        this.continuations.ensure(completedJob,actor);
        const continuationSource=this.continuations.source(completedJob);
        if(continuationSource)this.continuations.reconcileEvidence(continuationSource,actor);
      }
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
