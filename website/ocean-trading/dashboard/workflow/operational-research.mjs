import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash, requireThat } from './common.mjs';

export const RESEARCH_VERSION = 'ocean-cumulative-research/v2';
const unknown = value => !value || /^(unknown|none|null|n\/a)$/i.test(String(value).trim());
const round = value => Math.round(value * 100) / 100;
const authority = Object.freeze({ automatic_strategy_change:false, candidate_approved:false, paper_authorized:false, live_authorized:false });

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

// Exploratory exclusion tests use only entry-time fields, never an observed exit.
// Cross-period agreement is a proposal screen, not out-of-sample validation.
export function evaluateResearch(bundle, rows) {
  const eligibleIds = bundle.cohort.eligible_runs.map(run=>run.run_id).sort();
  requireThat(rows.every(row=>eligibleIds.includes(row.run_id)),409,'RESEARCH_FOREIGN_EVIDENCE');
  const keys = rows.map(row=>`${row.run_id}:${row.trade_id}`);
  requireThat(new Set(keys).size===keys.length,409,'RESEARCH_DUPLICATE_TRADE');
  requireThat(rows.length===bundle.cohort.aggregate.observed_sample_count,409,'RESEARCH_SAMPLE_COUNT_CONFLICT');
  requireThat(rows.every(row=>row.entry_datetime!=null && Number.isFinite(Number(row.entry_datetime))),409,'RESEARCH_ENTRY_TIME_REQUIRED');
  requireThat(rows.every(row=>['gross_currency_value','total_commission','net_profit_loss'].every(field=>
    row[field]!=null && Number.isFinite(Number(row[field])))
    && Number(row.total_commission)>=0
    && Math.abs(Number(row.gross_currency_value)-Number(row.total_commission)-Number(row.net_profit_loss))<0.001),
  409,'RESEARCH_FEE_RECONCILIATION_FAILED');
  const perRun = eligibleIds.map(run_id=>({run_id,...totals(rows.filter(row=>row.run_id===run_id))}));
  const experiments = [];
  const dimensions = ['direction','session_name','regime_label'];
  for(const dimension of dimensions) {
    for(const value of new Set(rows.map(row=>row[dimension]).filter(value=>!unknown(value)))) {
      const selected=rows.filter(row=>row[dimension]===value);
      const periods=perRun.map(run=>{
        const group=selected.filter(row=>row.run_id===run.run_id);
        return {run_id:run.run_id,...totals(group),observed_exclusion_delta:round(-totals(group).net_profit_loss)};
      });
      const supported=periods.length>=3 && periods.every(period=>period.trades>=10 && period.observed_exclusion_delta>0);
      experiments.push({dimension,value,periods,observed_exclusion_delta:round(-totals(selected).net_profit_loss),
        supported,reason:supported?'REPEATED_EXPLORATORY_LOSS_REGION':'INSUFFICIENT_OR_INCONSISTENT_CROSS_PERIOD_EVIDENCE'});
    }
  }
  const proposals=experiments.filter(item=>item.supported);
  const result={
    schema_version:RESEARCH_VERSION,
    outcome:proposals.length?'EXPLORATORY_PROPOSAL':'NO_SUPPORTED_CHANGE',
    eligible_run_ids:eligibleIds,
    evidence_hash:objectHash(rows), cohort_hash:objectHash(bundle.cohort),
    accounting_basis:'Executed closed-trade gross currency minus recorded commissions; wins use net P/L > 0.',
    aggregate:totals(rows), per_run:perRun,
    missing_exit_attribution:rows.filter(row=>unknown(row.exit_causality)).length,
    observed_dates:new Set(rows.map(row=>Math.trunc(Number(row.entry_datetime)))).size,
    experiments, proposals,
    excluded_evidence:bundle.excluded_evidence,
    candidate_validation:{status:'NOT_DUE',candidate_hash:null,tests:['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'],
      reason:'Baseline discovery is not candidate validation; no frozen candidate or independent holdout was tested.'},
    limitations:[
      'Lifecycle model reports are not executed-trade accounting and are not blended into these totals.',
      'Unknown exit labels are missing attribution, not a profitable entry condition.',
      'Volatility quantile labels have run-specific thresholds and cannot define a cross-period numeric rule.',
      'Observed dates and threshold sufficiency do not establish statistical independence or a probability of success.',
      'Exploratory exclusion deltas are in-sample and do not establish candidate performance.',
    ],
    next_action:proposals.length
      ?'Review the exploratory proposal before freezing a separate candidate; test it on independent evidence. No trading change has been made.'
      :'Keep the current baseline. No repeatable entry-time change is supported across every qualified period; collect new non-live evidence. No approval is pending.',
    authority,
  };
  return result;
}

export class OperationalResearch {
  constructor(backend) { this.backend=backend;this.db=backend.db;this.running=false;this.stopped=false; }
  stop() {this.stopped=true;}
  enqueue(caseId,artifactId) {
    const row=this.backend.one('ow_cases',caseId);
    requireThat(JSON.parse(row.payload_json).origin==='OPERATIONAL_LEARNING',409,'RESEARCH_OPERATIONAL_CASE_REQUIRED');
    const artifact=this.backend.artifactFor(row,artifactId,'RECOMMENDATION');
    const content=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
    requireThat(content.schema_version==='ocean-operational-learning-recommendation/v1'
      && Object.keys(authority).every(key=>content.authority?.[key]===false),409,'RESEARCH_AUTHORITY_BOUNDARY');
    const hash=JSON.parse(artifact.manifest_json).content_hash;
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
      AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED')`).all()) {
      this.backend.store.transaction(()=>this.enqueue(row.id,row.artifact_id));
    }
  }
  statusForCase(caseId) {
    const job=this.db.prepare('SELECT * FROM ow_research_jobs WHERE case_id=? ORDER BY rowid DESC LIMIT 1').get(caseId);
    if(!job)return null;
    const artifact=job.result_artifact_id?this.backend.one('ow_artifacts',job.result_artifact_id):null;
    if(artifact)requireThat(digest(Buffer.from(artifact.content))===job.result_hash
      && JSON.parse(artifact.manifest_json).content_hash===job.result_hash,409,'RESEARCH_RESULT_HASH_CONFLICT');
    const report=artifact?JSON.parse(Buffer.from(artifact.content).toString('utf8')):null;
    return {job_id:job.id,state:job.state,attempts:job.attempts,analysis_version:job.analysis_version,
      result_artifact_id:job.result_artifact_id,result_hash:job.result_hash,last_error:job.last_error,
      input_hash:job.input_hash,
      completed_at_utc:job.completed_at_utc,report,
      next_action:report?.next_action || (job.state==='RETRY'?'Ocean will retry Research automatically; no human approval is pending.':'Ocean Research is queued and will resume after a website restart.')};
  }
  claim() {
    return this.backend.store.transaction(()=>{
      const job=this.db.prepare(`SELECT j.* FROM ow_research_jobs j JOIN ow_cases c ON c.id=j.case_id
        WHERE j.analysis_version=? AND ((j.state IN ('PENDING','RETRY') AND j.next_attempt_ms<=?)
        OR (j.state='RUNNING' AND j.lease_until_ms<=?)) AND c.stage='RESEARCH' AND c.work_status NOT IN ('PAUSED','CANCELLED')
        ORDER BY j.rowid LIMIT 1`).get(RESEARCH_VERSION,Date.now(),Date.now());
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
    const bundle=this.backend.operationalLearning.cohort(run);
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
    const current=this.db.prepare('SELECT input_json,input_hash FROM ow_research_jobs WHERE id=?').get(job.id);
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
