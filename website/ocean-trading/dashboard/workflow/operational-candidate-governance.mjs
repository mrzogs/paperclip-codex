import { digest, exactKeys, id, objectHash, requireThat } from './common.mjs';

export const CANDIDATE_GOVERNANCE_VERSION='ocean-operational-candidate-governance/v6';
export const CANDIDATE_GOVERNANCE_ACTION='operational.candidate.governance.registered';
export const CANDIDATE_EXPOSURE_ACTION='operational.candidate.evidence.exposure_reserved';
export const CANDIDATE_PROSPECTIVE_PLAN_VERSION='ocean-operational-candidate-prospective-plan/v1';
export const CANDIDATE_PROSPECTIVE_PLAN_ACTION='operational.candidate.prospective_plan.declared';

const TESTS=Object.freeze(['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT']);
const USE_CLASSES=Object.freeze({BACKTEST:'DISCOVERY_DESIGN',ROBUSTNESS:'DISCOVERY_DESIGN',
  WALK_FORWARD:'CONFIRMATION_VERDICT_ONLY',OOS_HOLDOUT:'CONFIRMATION_VERDICT_ONLY'});
const validHash=value=>typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value);
const exactObjectKeys=(value,keys)=>value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const contractKey=value=>String(value).replace(/\[M\]$/,'');

export class OperationalCandidateGovernance {
  constructor(backend){this.b=backend;this.db=backend.db;}
  latest(caseId,action=CANDIDATE_GOVERNANCE_ACTION){
    const row=this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id DESC LIMIT 1').get(caseId,action);
    return row?JSON.parse(row.payload_json).payload:null;
  }
  governance(caseId){return this.latest(caseId);}
  prospectivePlan(caseId){return this.latest(caseId,CANDIDATE_PROSPECTIVE_PLAN_ACTION);}
  exposures(caseId){
    return this.db.prepare('SELECT payload_json FROM ow_events WHERE entity_id=? AND action=? ORDER BY id').all(caseId,CANDIDATE_EXPOSURE_ACTION)
      .map(row=>JSON.parse(row.payload_json).payload);
  }
  statusForCase(row,dispatch=this.b.operationalCandidateDispatch){
    const registered=dispatch?.registration(row.id);
    if(!registered)return {schema_version:CANDIDATE_GOVERNANCE_VERSION,status:'NOT_DUE',governance_hash:null,
      artifact_id:null,reason:null,next_action:null,exposures:[]};
    const governance=this.governance(row.id),prospective=this.prospectivePlan(row.id),plan=dispatch?.validationPlan(row.id),exposures=this.exposures(row.id);
    if(!governance){
      const legacy=Boolean(plan);
      return {schema_version:CANDIDATE_GOVERNANCE_VERSION,status:legacy?'LEGACY_INCOMPLETE':prospective?'PROSPECTIVE_RESERVED':'REQUIRED',governance_hash:null,
        prospective_plan_hash:prospective?.prospective_plan_hash || null,
        artifact_id:prospective?.artifact_id || null,policy_id:prospective?.policy?.policy_id || null,
        reason:legacy
          ?'This candidate already consumed or planned evidence without a pre-exposure governance record. Missing bindings remain unknown and cannot be reconstructed retrospectively.'
          :prospective?'A future holdout and forward interval are frozen as planning only. No dataset completeness, execution, evidence access or favorable conclusion is claimed.'
          :'Record the immutable candidate policy, attempt, physical bindings, complete eligible universe and evaluation policy before creating a validation plan.',
        next_action:legacy
          ?'Keep protected holdout evidence sealed. Start a fresh candidate attempt with complete pre-exposure governance; legacy evidence cannot establish benefit.'
          :prospective?'Wait for the source owner to seal complete qualified coverage, then obtain the required release and register candidate governance against this exact reservation before any evidence access.'
          :'Register candidate governance before planning or running any Replay validation.',exposures};
    }
    const ready=governance.access.status==='FRESH_UNEXPOSED';
    return {schema_version:CANDIDATE_GOVERNANCE_VERSION,status:ready?'READY':'POSSIBLY_SPENT',
      governance_hash:governance.governance_hash,artifact_id:governance.artifact_id,
      policy_id:governance.policy.policy_id,change_family:governance.policy.change_family,
      attempt_number:governance.policy.attempt_number,evaluation_policy:governance.evaluation_policy,
      reason:ready?null:'External evidence access could not be proved absent before registration, so the attempt is ineligible for a favorable benefit conclusion.',
      next_action:ready?'Reserve each test exposure before accessing its evidence.':'Start a fresh candidate attempt and register it before protected evidence access.',exposures};
  }
  validateBinding(name,value,{row,completed,registered}){
    const componentKeys=['version','source_hash','binary_hash','build_receipt_hash'];
    const validComponent=component=>exactObjectKeys(component,componentKeys)
      && typeof component.version==='string' && component.version.length>0
      && componentKeys.filter(key=>key.endsWith('_hash')).every(key=>validHash(component[key]));
    if(name==='candidate'){
      requireThat(exactObjectKeys(value,['registered','behavior','execution','configuration_hash','diff_hash'])
        && validComponent(value.registered) && validComponent(value.behavior) && validComponent(value.execution)
        && validHash(value.configuration_hash) && validHash(value.diff_hash),
      422,'CANDIDATE_GOVERNANCE_BINDING_REQUIRED');
      requireThat(value.registered.version===completed.candidate.candidate_version
        && value.registered.binary_hash===registered.candidate_hash
        && value.registered.source_hash===completed.candidate.source_hash
        && value.registered.build_receipt_hash===completed.candidate.build_receipt_hash
        && objectHash(value.behavior)===objectHash(value.registered),
      409,'CANDIDATE_GOVERNANCE_CANDIDATE_BINDING_CONFLICT');
    }else{
      requireThat(exactObjectKeys(value,['logical_provider','behavior','execution','configuration_hash','lineage_hash'])
        && exactObjectKeys(value.logical_provider,['version','code_hash','provider_version_id','provider_record_hash'])
        && validComponent(value.behavior) && validComponent(value.execution)
        && validHash(value.logical_provider.code_hash) && validHash(value.logical_provider.provider_record_hash)
        && validHash(value.configuration_hash) && validHash(value.lineage_hash)
        && typeof value.logical_provider.version==='string'
        && value.logical_provider.version.length>0 && typeof value.logical_provider.provider_version_id==='string'
        && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.logical_provider.provider_version_id),
      422,'CANDIDATE_GOVERNANCE_BINDING_REQUIRED');
      requireThat(value.logical_provider.code_hash===row.baseline_hash,
        409,'CANDIDATE_GOVERNANCE_BASELINE_BINDING_CONFLICT');
      const artifact=this.b.artifactFor(row,completed.plan_artifact_id,'RECOMMENDATION');
      const plan=JSON.parse(Buffer.from(artifact.content).toString('utf8'));
      const registeredVersions=plan.execution?.capabilities?.find(item=>item.contract==='SCOPED_CANDIDATE_TEST_DISPATCH')
        ?.evidence?.registered_versions || [];
      const provider=value.logical_provider;
      const sealed=registeredVersions.find(item=>item.id===provider.provider_version_id && item.kind==='BASELINE');
      const current=this.b.one('ow_run_versions',provider.provider_version_id),currentPayload=JSON.parse(current.payload_json);
      requireThat(sealed?.content_hash===provider.provider_record_hash && current.strategy_id===row.strategy_id
        && currentPayload.kind==='BASELINE' && currentPayload.version===provider.version
        && currentPayload.code_hash===provider.code_hash && objectHash(currentPayload)===provider.provider_record_hash,
      409,'CANDIDATE_GOVERNANCE_BASELINE_PROVIDER_CONFLICT');
    }
    return structuredClone(value);
  }
  validateUniverse(row,universe){
    requireThat(exactObjectKeys(universe,['universe_id','segments']),422,'CANDIDATE_GOVERNANCE_UNIVERSE_REQUIRED');
    id(universe.universe_id,true);
    requireThat(Array.isArray(universe.segments) && universe.segments.length>=TESTS.length,422,'CANDIDATE_GOVERNANCE_UNIVERSE_REQUIRED');
    const ids=new Set();
    const segments=universe.segments.map(segment=>{
      exactKeys(segment,['segment_id','test_kind','use_class','dataset_id','dataset_revision','dataset_role','dataset_manifest_hash',
        'contract','warmup_start_utc','scored_start_utc','scored_end_utc','eligible','exclusion_reason']);
      id(segment.segment_id);id(segment.dataset_id);
      requireThat(TESTS.includes(segment.test_kind) && segment.use_class===USE_CLASSES[segment.test_kind],422,'CANDIDATE_GOVERNANCE_USE_CLASS_CONFLICT');
      requireThat(!ids.has(segment.segment_id),409,'CANDIDATE_GOVERNANCE_SEGMENT_DUPLICATE');ids.add(segment.segment_id);
      requireThat(Number.isInteger(segment.dataset_revision) && segment.dataset_revision>0 && validHash(segment.dataset_manifest_hash),422,'CANDIDATE_GOVERNANCE_DATASET_REQUIRED');
      requireThat(typeof segment.contract==='string' && /^[A-Za-z0-9_.\[\]-]{1,80}$/.test(segment.contract),422,'CANDIDATE_GOVERNANCE_CONTRACT_REQUIRED');
      const warmup=Date.parse(segment.warmup_start_utc),start=Date.parse(segment.scored_start_utc),end=Date.parse(segment.scored_end_utc);
      requireThat(Number.isFinite(warmup) && Number.isFinite(start) && Number.isFinite(end) && warmup<start && start<end,422,'CANDIDATE_GOVERNANCE_INTERVAL_REQUIRED');
      requireThat(typeof segment.eligible==='boolean'
        && (segment.eligible?segment.exclusion_reason===null:typeof segment.exclusion_reason==='string' && segment.exclusion_reason.length>0),
      422,'CANDIDATE_GOVERNANCE_ELIGIBILITY_REQUIRED');
      const dataset=this.b.one('ow_datasets',`${segment.dataset_id}:${segment.dataset_revision}`),manifest=JSON.parse(dataset.payload_json);
      requireThat(dataset.strategy_id===row.strategy_id && dataset.content_hash===segment.dataset_manifest_hash
        && manifest.dataset_manifest_id===segment.dataset_id && manifest.revision===segment.dataset_revision
        && manifest.manifest_hash===segment.dataset_manifest_hash && manifest.quality_status==='VERIFIED'
        && Array.isArray(manifest.gaps) && manifest.gaps.length===0,409,'CANDIDATE_GOVERNANCE_DATASET_CONFLICT');
      const coverage=manifest.partitions.filter(partition=>partition.partition===segment.dataset_role
        && partition.coverage_status==='COMPLETE' && contractKey(partition.symbol)===contractKey(segment.contract)
        && Date.parse(partition.start_utc)<=start && end<=Date.parse(partition.end_utc));
      requireThat(coverage.length===1,409,'CANDIDATE_GOVERNANCE_PARTITION_CONFLICT');
      return structuredClone(segment);
    });
    requireThat(TESTS.every(kind=>segments.some(segment=>segment.test_kind===kind && segment.eligible)),422,'CANDIDATE_GOVERNANCE_ELIGIBLE_TEST_MATRIX_REQUIRED');
    return {universe_id:universe.universe_id,segments};
  }
  validateEvaluationPolicy(value){
    exactKeys(value,['policy_id','favorable_performance_required','minimum_positive_tests','maximum_negative_tests',
      'minimum_cumulative_net_pnl_delta','minimum_candidate_trade_count','no_benefit_when_thresholds_fail','metric_contract']);
    requireThat(typeof value.policy_id==='string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value.policy_id)
      && value.favorable_performance_required===true && Number.isInteger(value.minimum_positive_tests) && value.minimum_positive_tests>0
      && value.minimum_positive_tests<=TESTS.length && Number.isInteger(value.maximum_negative_tests) && value.maximum_negative_tests>=0
      && Number.isFinite(value.minimum_cumulative_net_pnl_delta) && Number.isInteger(value.minimum_candidate_trade_count)
      && value.minimum_candidate_trade_count>=0 && value.no_benefit_when_thresholds_fail===true,
    422,'CANDIDATE_GOVERNANCE_EVALUATION_POLICY_REQUIRED');
    requireThat(objectHash(value.metric_contract)===objectHash(candidateMetricContract()),422,'CANDIDATE_GOVERNANCE_METRIC_CONTRACT_REQUIRED');
    return structuredClone(value);
  }
  declareProspectivePlan(actor,row,completed,registered,data){
    exactKeys(data,['case_id','expected_revision','completion_hash','candidate_hash','baseline_hash','policy','bindings','schedule','evaluation_policy','access']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_PROSPECTIVE_PLAN_STAGE_REQUIRED');
    requireThat(!this.prospectivePlan(row.id) && !this.governance(row.id)
      && !this.b.operationalCandidateDispatch.validationPlan(row.id) && this.exposures(row.id).length===0,
    409,'CANDIDATE_PROSPECTIVE_PLAN_PREEXPOSURE_REQUIRED');
    requireThat(data.completion_hash===completed.completion_hash && data.candidate_hash===registered.candidate_hash
      && data.baseline_hash===row.baseline_hash,409,'CANDIDATE_PROSPECTIVE_PLAN_REGISTRATION_CONFLICT');
    exactKeys(data.policy,['policy_id','card_id','card_hash','change_family','attempt_number','change_class']);
    for(const key of ['policy_id','card_id','change_family','change_class'])requireThat(typeof data.policy[key]==='string'
      && /^[A-Za-z0-9_.:-]{1,120}$/.test(data.policy[key]),422,'CANDIDATE_GOVERNANCE_POLICY_REQUIRED');
    requireThat(validHash(data.policy.card_hash) && Number.isInteger(data.policy.attempt_number)
      && data.policy.attempt_number>0,422,'CANDIDATE_GOVERNANCE_ATTEMPT_REQUIRED');
    const continuationAttempt=JSON.parse(row.payload_json).attempt;
    if(continuationAttempt)requireThat(data.policy.attempt_number===continuationAttempt.attempt_number,
      409,'CANDIDATE_GOVERNANCE_ATTEMPT_CONFLICT');
    const duplicate=this.db.prepare(`SELECT e.entity_id,e.payload_json FROM ow_events e JOIN ow_cases c ON c.id=e.entity_id
      WHERE e.action IN (?,?) AND c.strategy_id=?`).all(CANDIDATE_GOVERNANCE_ACTION,CANDIDATE_PROSPECTIVE_PLAN_ACTION,row.strategy_id)
      .map(item=>({entity_id:item.entity_id,payload:JSON.parse(item.payload_json).payload}))
      .find(item=>item.payload?.policy?.change_family===data.policy.change_family
        && item.payload?.policy?.attempt_number===data.policy.attempt_number);
    requireThat(!duplicate,409,'CANDIDATE_GOVERNANCE_ATTEMPT_DUPLICATE');
    exactKeys(data.bindings,['baseline','candidate']);
    const bindings={baseline:this.validateBinding('baseline',data.bindings.baseline,{row,completed,registered}),
      candidate:this.validateBinding('candidate',data.bindings.candidate,{row,completed,registered})};
    requireThat(bindings.baseline.behavior.binary_hash!==bindings.candidate.behavior.binary_hash
      && bindings.baseline.execution.binary_hash!==bindings.candidate.execution.binary_hash,
    409,'CANDIDATE_GOVERNANCE_DISTINCT_CANDIDATE_REQUIRED');
    exactKeys(data.schedule,['plan_id','source_owner_id','source_plan_hash','contract_policy_hash','session_policy_hash',
      'warmup_policy_hash','embargo_policy_hash','holdout_start_utc','holdout_end_utc','forward_start_utc','forward_end_utc',
      'timezone','interval_policy','exposure_attestation_method']);
    id(data.schedule.plan_id,true);id(data.schedule.source_owner_id);
    for(const key of ['source_plan_hash','contract_policy_hash','session_policy_hash','warmup_policy_hash','embargo_policy_hash'])
      requireThat(validHash(data.schedule[key]),422,'CANDIDATE_PROSPECTIVE_PLAN_POLICY_HASH_REQUIRED');
    const holdoutStart=Date.parse(data.schedule.holdout_start_utc),holdoutEnd=Date.parse(data.schedule.holdout_end_utc),
      forwardStart=Date.parse(data.schedule.forward_start_utc),forwardEnd=Date.parse(data.schedule.forward_end_utc);
    requireThat([holdoutStart,holdoutEnd,forwardStart,forwardEnd].every(Number.isFinite)
      && Date.now()<holdoutStart && holdoutStart<holdoutEnd && holdoutEnd===forwardStart && forwardStart<forwardEnd,
    422,'CANDIDATE_PROSPECTIVE_PLAN_INTERVAL_REQUIRED');
    requireThat(typeof data.schedule.timezone==='string' && /^[A-Za-z0-9_./+-]{1,100}$/.test(data.schedule.timezone)
      && data.schedule.interval_policy==='TWO_COMPLETE_CALENDAR_MONTHS_HALF_OPEN'
      && typeof data.schedule.exposure_attestation_method==='string'
      && data.schedule.exposure_attestation_method.length>0 && data.schedule.exposure_attestation_method.length<=500,
    422,'CANDIDATE_PROSPECTIVE_PLAN_POLICY_REQUIRED');
    const evaluationPolicy=this.validateEvaluationPolicy(data.evaluation_policy);
    exactKeys(data.access,['status','evidence_access_state','attestation_hash','brain_record_id','brain_record_hash']);
    requireThat(data.access.status==='PLANNING_ONLY' && data.access.evidence_access_state==='UNEXPOSED_AT_DECLARATION'
      && validHash(data.access.attestation_hash) && validHash(data.access.brain_record_hash)
      && typeof data.access.brain_record_id==='string' && /^reasoning\/[A-Za-z0-9_.-]+\.md$/.test(data.access.brain_record_id),
    422,'CANDIDATE_PROSPECTIVE_PLAN_ACCESS_REQUIRED');
    const frozen={schema_version:CANDIDATE_PROSPECTIVE_PLAN_VERSION,case_id:row.id,completion_hash:completed.completion_hash,
      candidate_hash:registered.candidate_hash,baseline_hash:row.baseline_hash,policy:structuredClone(data.policy),bindings,
      schedule:structuredClone(data.schedule),evaluation_policy:{status:'PREDECLARED',...evaluationPolicy,policy_hash:objectHash(evaluationPolicy)},
      access:structuredClone(data.access),declared_by:actor.id,declared_at_utc:new Date().toISOString(),
      state:'FUTURE_DATA_INCOMPLETE',executable_dataset:false,
      authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false,automatic_promotion:false}};
    const prospectivePlanHash=objectHash(frozen),content=JSON.stringify({...frozen,prospective_plan_hash:prospectivePlanHash}),contentHash=digest(content);
    const artifactId=`test-candidate-prospective-${prospectivePlanHash.slice(7,31)}`;
    const brain=this.b.config.identities.find(entry=>entry.role==='BRAIN' && entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id));
    requireThat(brain,409,'CANDIDATE_REVIEW_RECIPIENT_REQUIRED');
    this.b.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:brain.identity_id,
      kind:'VALIDATION_REPORT',media_type:'application/json',content,content_encoding:'utf8',content_hash:contentHash,
      candidate_hash:row.candidate_hash,dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id]});
    const recorded={...frozen,prospective_plan_hash:prospectivePlanHash,artifact_id:artifactId,content_hash:contentHash};
    this.b.event(row.id,CANDIDATE_PROSPECTIVE_PLAN_ACTION,actor,recorded);
    const nextAction='Keep the future holdout sealed. The source owner must later prove complete qualified coverage and obtain release before executable candidate governance can be registered.';
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,row.id);
    return {case_id:row.id,revision:row.revision+1,status:'PROSPECTIVE_RESERVED',prospective_plan_hash:prospectivePlanHash,
      artifact_id:artifactId,executable_dataset:false,next_action:nextAction};
  }
  register(actor,row,completed,registered,data){
    const prospective=this.prospectivePlan(row.id);
    exactKeys(data,['case_id','expected_revision','completion_hash','candidate_hash','baseline_hash','policy','bindings','universe','evaluation_policy','access',
      ...(prospective?['prospective_plan_hash']:[])]);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    requireThat(row.stage==='HISTORICAL_VALIDATION',409,'CANDIDATE_GOVERNANCE_STAGE_REQUIRED');
    requireThat(!this.governance(row.id),409,'CANDIDATE_GOVERNANCE_ALREADY_REGISTERED');
    requireThat(!this.b.operationalCandidateDispatch.validationPlan(row.id)
      && !this.db.prepare("SELECT id FROM ow_events WHERE entity_id=? AND action IN ('operational.candidate.validation.result','operational.candidate.validation.completed','operational.candidate.validation.holdout_released') LIMIT 1").get(row.id),
    409,'CANDIDATE_GOVERNANCE_PREEXPOSURE_REQUIRED');
    requireThat(data.completion_hash===completed.completion_hash && data.candidate_hash===registered.candidate_hash
      && data.baseline_hash===row.baseline_hash,409,'CANDIDATE_GOVERNANCE_REGISTRATION_CONFLICT');
    exactKeys(data.policy,['policy_id','card_id','card_hash','change_family','attempt_number','change_class']);
    for(const key of ['policy_id','card_id','change_family','change_class'])requireThat(typeof data.policy[key]==='string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(data.policy[key]),422,'CANDIDATE_GOVERNANCE_POLICY_REQUIRED');
    requireThat(validHash(data.policy.card_hash),422,'CANDIDATE_GOVERNANCE_POLICY_REQUIRED');
    requireThat(Number.isInteger(data.policy.attempt_number) && data.policy.attempt_number>0,422,'CANDIDATE_GOVERNANCE_ATTEMPT_REQUIRED');
    const continuationAttempt=JSON.parse(row.payload_json).attempt;
    if(continuationAttempt)requireThat(data.policy.attempt_number===continuationAttempt.attempt_number,
      409,'CANDIDATE_GOVERNANCE_ATTEMPT_CONFLICT');
    const duplicate=this.db.prepare(`SELECT e.entity_id,e.payload_json FROM ow_events e JOIN ow_cases c ON c.id=e.entity_id
      WHERE e.action=? AND c.strategy_id=?`).all(CANDIDATE_GOVERNANCE_ACTION,row.strategy_id).map(item=>({entity_id:item.entity_id,payload:JSON.parse(item.payload_json).payload}))
      .find(item=>item.payload?.policy?.change_family===data.policy.change_family
        && item.payload?.policy?.attempt_number===data.policy.attempt_number);
    requireThat(!duplicate,409,'CANDIDATE_GOVERNANCE_ATTEMPT_DUPLICATE');
    exactKeys(data.bindings,['baseline','candidate']);
    const bindings={baseline:this.validateBinding('baseline',data.bindings.baseline,{row,completed,registered}),
      candidate:this.validateBinding('candidate',data.bindings.candidate,{row,completed,registered})};
    requireThat(bindings.baseline.behavior.binary_hash!==bindings.candidate.behavior.binary_hash
      && bindings.baseline.execution.binary_hash!==bindings.candidate.execution.binary_hash,
    409,'CANDIDATE_GOVERNANCE_DISTINCT_CANDIDATE_REQUIRED');
    const universe=this.validateUniverse(row,data.universe);
    const ep=this.validateEvaluationPolicy(data.evaluation_policy);
    exactKeys(data.access,['status','attestation_hash']);
    requireThat(['FRESH_UNEXPOSED','POSSIBLY_SPENT'].includes(data.access.status) && validHash(data.access.attestation_hash),422,'CANDIDATE_GOVERNANCE_ACCESS_ATTESTATION_REQUIRED');
    if(prospective){
      requireThat(data.prospective_plan_hash===prospective.prospective_plan_hash
        && objectHash(data.policy)===objectHash(prospective.policy)
        && objectHash(bindings)===objectHash(prospective.bindings)
        && objectHash(ep)===objectHash((({status,policy_hash,...value})=>value)(prospective.evaluation_policy))
        && Date.parse(prospective.declared_at_utc)<Date.parse(prospective.schedule.holdout_start_utc)
        && Date.now()>=Date.parse(prospective.schedule.holdout_end_utc),409,'CANDIDATE_GOVERNANCE_PROSPECTIVE_PLAN_CONFLICT');
      const holdout=universe.segments.filter(segment=>segment.test_kind==='OOS_HOLDOUT' && segment.eligible);
      requireThat(holdout.length>0
        && Math.min(...holdout.map(segment=>Date.parse(segment.scored_start_utc)))===Date.parse(prospective.schedule.holdout_start_utc)
        && Math.max(...holdout.map(segment=>Date.parse(segment.scored_end_utc)))===Date.parse(prospective.schedule.holdout_end_utc),
      409,'CANDIDATE_GOVERNANCE_PROSPECTIVE_INTERVAL_CONFLICT');
    }
    const frozen={schema_version:CANDIDATE_GOVERNANCE_VERSION,case_id:row.id,completion_hash:completed.completion_hash,
      candidate_hash:registered.candidate_hash,baseline_hash:row.baseline_hash,policy:structuredClone(data.policy),bindings,universe,
      universe_hash:objectHash(universe),evaluation_policy:{status:'PREDECLARED',...structuredClone(ep),policy_hash:objectHash(ep)},
      access:structuredClone(data.access),prospective_plan_hash:prospective?.prospective_plan_hash || null,
      registered_by:actor.id,registered_at_utc:new Date().toISOString(),
      authority:{automatic_strategy_change:false,candidate_approved:false,paper_authorized:false,live_authorized:false,automatic_promotion:false}};
    const governanceHash=objectHash(frozen),content=JSON.stringify({...frozen,governance_hash:governanceHash}),contentHash=digest(content);
    const artifactId=`test-candidate-governance-${governanceHash.slice(7,31)}`;
    const brain=this.b.config.identities.find(entry=>entry.role==='BRAIN' && entry.strategy_ids.includes(row.strategy_id) && entry.instance_ids.includes(row.instance_id));
    requireThat(brain,409,'CANDIDATE_REVIEW_RECIPIENT_REQUIRED');
    this.b.writeArtifact(actor,{artifact_id:artifactId,case_id:row.id,run_id:row.run_id,recipient_id:brain.identity_id,
      kind:'VALIDATION_REPORT',media_type:'application/json',content,content_encoding:'utf8',content_hash:contentHash,
      candidate_hash:row.candidate_hash,dependency_ids:[completed.plan_artifact_id,registered.candidate_artifact_id]});
    const recorded={...frozen,governance_hash:governanceHash,artifact_id:artifactId,content_hash:contentHash};
    this.b.event(row.id,CANDIDATE_GOVERNANCE_ACTION,actor,recorded);
    const nextAction=data.access.status==='FRESH_UNEXPOSED'
      ?`Create the immutable validation plan bound to governance ${governanceHash}; reserve each exposure before reading evidence.`
      :'This attempt is possibly spent and cannot support a favorable conclusion. Start a fresh candidate attempt before protected evidence access.';
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,row.id);
    return {case_id:row.id,revision:row.revision+1,status:data.access.status==='FRESH_UNEXPOSED'?'READY':'POSSIBLY_SPENT',
      governance_hash:governanceHash,artifact_id:artifactId,next_action:nextAction};
  }
  requirePlanReady(row,tests,{existing=false}={}){
    const governance=this.governance(row.id);
    requireThat(governance,409,'CANDIDATE_GOVERNANCE_REQUIRED');
    requireThat(governance.access.status==='FRESH_UNEXPOSED',409,'CANDIDATE_GOVERNANCE_EVIDENCE_POSSIBLY_SPENT');
    if(!existing)requireThat(this.exposures(row.id).length===0,409,'CANDIDATE_GOVERNANCE_PLAN_AFTER_EXPOSURE');
    for(const test of tests){
      const expected=governance.universe.segments.filter(segment=>segment.test_kind===test.kind && segment.eligible)
        .map(segment=>({segment_id:segment.segment_id,dataset_id:segment.dataset_id,dataset_revision:segment.dataset_revision,
          dataset_role:segment.dataset_role,dataset_manifest_hash:segment.dataset_manifest_hash,contract:segment.contract,
          warmup_start_utc:segment.warmup_start_utc,scored_start_utc:segment.scored_start_utc,scored_end_utc:segment.scored_end_utc}));
      const actual=test.segments.map(segment=>({segment_id:segment.segment_id,dataset_id:segment.dataset_id,dataset_revision:segment.dataset_revision,
        dataset_role:segment.dataset_role,dataset_manifest_hash:segment.dataset_manifest_hash,contract:segment.contract,
        warmup_start_utc:segment.warmup_start_utc,scored_start_utc:segment.scored_start_utc,scored_end_utc:segment.scored_end_utc}));
      requireThat(objectHash(actual)===objectHash(expected),409,'CANDIDATE_GOVERNANCE_UNIVERSE_BINDING_CONFLICT');
      requireThat(test.baseline_version===governance.bindings.baseline.execution.version
        && test.baseline_strategy_hash===governance.bindings.baseline.execution.binary_hash
        && test.baseline_execution_source_hash===governance.bindings.baseline.execution.source_hash
        && test.candidate_execution_version===governance.bindings.candidate.execution.version
        && test.candidate_execution_hash===governance.bindings.candidate.execution.binary_hash
        && test.candidate_execution_source_hash===governance.bindings.candidate.execution.source_hash,
      409,'CANDIDATE_GOVERNANCE_EXECUTION_BINDING_CONFLICT');
    }
    return governance;
  }
  reserveExposure(actor,row,data){
    exactKeys(data,['case_id','expected_revision','plan_hash','governance_hash','kind','exposure_id','segment_ids','retry_of_exposure_id']);
    this.b.expect(row,data.expected_revision);this.b.active(row);this.b.baseline(row);
    const governance=this.governance(row.id),plan=this.b.operationalCandidateDispatch.validationPlan(row.id);
    requireThat(governance && governance.governance_hash===data.governance_hash && governance.access.status==='FRESH_UNEXPOSED',409,'CANDIDATE_GOVERNANCE_REQUIRED');
    requireThat(plan && plan.plan_hash===data.plan_hash && plan.governance_hash===governance.governance_hash,409,'CANDIDATE_GOVERNANCE_PLAN_REQUIRED');
    requireThat(TESTS.includes(data.kind),422,'CANDIDATE_GOVERNANCE_EXPOSURE_KIND_REQUIRED');id(data.exposure_id,true);
    const task=this.db.prepare('SELECT status FROM ow_tasks WHERE case_id=? AND kind=?').get(row.id,data.kind);
    requireThat(task?.status==='NOT_RUN',409,'CANDIDATE_GOVERNANCE_EXPOSURE_RESULT_EXISTS');
    const expected=plan.tests.find(test=>test.kind===data.kind).segments.map(segment=>segment.segment_id);
    requireThat(Array.isArray(data.segment_ids) && objectHash(data.segment_ids)===objectHash(expected),409,'CANDIDATE_GOVERNANCE_EXPOSURE_SEGMENT_CONFLICT');
    const prior=this.exposures(row.id),same=prior.find(item=>item.exposure_id===data.exposure_id);
    requireThat(!same,409,'CANDIDATE_GOVERNANCE_EXPOSURE_DUPLICATE');
    if(data.retry_of_exposure_id!==null)requireThat(prior.some(item=>item.exposure_id===data.retry_of_exposure_id
      && item.kind===data.kind && item.plan_hash===data.plan_hash),409,'CANDIDATE_GOVERNANCE_RETRY_EXPOSURE_REQUIRED');
    else requireThat(!prior.some(item=>item.kind===data.kind && item.plan_hash===data.plan_hash),409,'CANDIDATE_GOVERNANCE_TECHNICAL_RETRY_REQUIRED');
    const exposure={schema_version:CANDIDATE_GOVERNANCE_VERSION,case_id:row.id,governance_hash:governance.governance_hash,
      plan_hash:plan.plan_hash,kind:data.kind,use_class:USE_CLASSES[data.kind],exposure_id:data.exposure_id,
      segment_ids:structuredClone(data.segment_ids),retry_of_exposure_id:data.retry_of_exposure_id,
      reserved_by:actor.id,reserved_at_utc:new Date().toISOString(),state:'RESERVED_BEFORE_ACCESS'};
    this.b.event(row.id,CANDIDATE_EXPOSURE_ACTION,actor,exposure);
    const nextAction=`Run ${data.kind} only for exposure ${data.exposure_id}; submit the immutable result without changing the frozen policy or universe.`;
    this.db.prepare('UPDATE ow_cases SET revision=revision+1,waiting_on=? WHERE id=?').run(nextAction,row.id);
    return {case_id:row.id,revision:row.revision+1,status:'EXPOSURE_RESERVED',...exposure,next_action:nextAction};
  }
  requireExposure(row,plan,kind){
    const governance=this.governance(row.id);
    requireThat(governance && plan.governance_hash===governance.governance_hash,409,'CANDIDATE_GOVERNANCE_REQUIRED');
    const matching=this.exposures(row.id).filter(item=>item.plan_hash===plan.plan_hash && item.kind===kind);
    requireThat(matching.length>0,409,'CANDIDATE_GOVERNANCE_EXPOSURE_REQUIRED');
    return matching.at(-1);
  }
  evaluationPolicy(row){
    const governance=this.governance(row.id);
    return governance?.access.status==='FRESH_UNEXPOSED'?governance.evaluation_policy:{status:'LEGACY_INCOMPLETE',policy_id:null,
      policy_hash:null,favorable_performance_required:null,minimum_positive_tests:null,maximum_negative_tests:null,
      minimum_cumulative_net_pnl_delta:null,minimum_candidate_trade_count:null,no_benefit_when_thresholds_fail:null,
      metric_contract:null};
  }
}

export const candidateMetricContract=()=>({schema_version:'ocean-candidate-metric-contract/v1',
  dimensions:['CONTRACT','WINDOW','DIRECTION'],directions:['ALL','LONG','SHORT'],
  metrics:['trade_count','win_count','loss_count','gross_profit','gross_loss','fees','net_pnl','profit_factor','max_drawdown','zero_trade_periods','risk_breach_count']});

export const candidateUseClass=kind=>USE_CLASSES[kind] || null;
