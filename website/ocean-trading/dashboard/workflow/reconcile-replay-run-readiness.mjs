import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowBackend } from './backend.mjs';
import { digest, objectHash, sealedHash } from './common.mjs';

const state = JSON.parse(fs.readFileSync(0, 'utf8'));
const backend = new WorkflowBackend(state.config, state.environment);
const actor = { id:'wayne-ocean-ui', role:'HUMAN', namespace:'TEST', scopes:[], strategyIds:[], instanceIds:[] };
const historicalDbPath=process.env.OCEAN_HISTORICAL_DB || 'D:\\OceanTradingData\\market\\sierra-historical.sqlite';
const historicalReceiptPath=process.env.OCEAN_HISTORICAL_RECEIPT || 'D:\\OceanTradingData\\market\\manifests\\mnqm25-may2025-replay-history-qualified.json';
const requestedStrategy=process.env.OCEAN_RECONCILE_STRATEGY || 'cicd-vwap-pull-back-strategy';
const correctedProfilePath=process.env.OCEAN_CORRECTED_PROFILE || 'C:\\Users\\wayne\\OneDrive\\Documents\\Brady - Optimization\\onboarding\\strategy-profile.json';
const correctedRegistryPath=process.env.OCEAN_CORRECTED_REGISTRY || 'C:\\Users\\wayne\\OneDrive\\Documents\\Brady - Optimization\\onboarding\\strategy-registry.json';
const replayChartHash=process.env.OCEAN_REPLAY_CHART_SHA256;

const canonicalValue=(value) => value===null ? 'null' : `${value}`;
const readQualifiedReceipt=() => {
  if(!fs.existsSync(historicalReceiptPath)) throw new Error(`HISTORICAL_RECEIPT_REQUIRED:${historicalReceiptPath}`);
  const receipt=JSON.parse(fs.readFileSync(historicalReceiptPath,'utf8'));
  if(receipt.schema_version!=='ocean-qualified-replay-history/v1') throw new Error('HISTORICAL_RECEIPT_SCHEMA_REJECTED');
  if(receipt.cache_db!==historicalDbPath || receipt.timeframe_minutes!==5) throw new Error('HISTORICAL_RECEIPT_BINDING_REJECTED');
  if(!receipt.symbol || !receipt.partition_symbol || !receipt.contract_rollover_policy || !receipt.adjustment_policy) throw new Error('HISTORICAL_RECEIPT_POLICY_REQUIRED');
  if(!Array.isArray(receipt.segments) || !receipt.segments.length || !Number.isInteger(receipt.row_count) || receipt.row_count<1) throw new Error('HISTORICAL_RECEIPT_COVERAGE_REJECTED');
  return receipt;
};

function qualifyHistoricalCache() {
  const receipt=readQualifiedReceipt();
  if(!fs.existsSync(historicalDbPath)) throw new Error(`HISTORICAL_CACHE_REQUIRED:${historicalDbPath}`);
  const db=new DatabaseSync(historicalDbPath,{readOnly:true});
  const digest=createHash('sha256');
  const receipts=[];
  let totalRows=0;
  let previousBar=null;
  try {
    for(const segment of receipt.segments) {
      if(!fs.existsSync(segment.source_path)) throw new Error(`QUALIFIED_HISTORY_SOURCE_REQUIRED:${segment.source_path}`);
      const dataset=db.prepare("SELECT id,status FROM datasets WHERE id=? AND symbol=? AND timeframe_minutes=5 AND source_path=?").get(segment.dataset_id,receipt.symbol,segment.source_path);
      if(!dataset || dataset.status!=='ready') throw new Error(`QUALIFIED_HISTORY_IMPORT_REQUIRED:${segment.source_path}`);
      const bars=db.prepare("SELECT bar_start_utc,open,high,low,close,volume,bid_volume,ask_volume,num_trades FROM bars WHERE dataset_id=? AND bar_start_utc>=? AND bar_start_utc<? ORDER BY bar_start_utc").all(dataset.id,segment.start_utc,segment.end_utc);
      if(!bars.length || bars.length!==segment.row_count) throw new Error(`QUALIFIED_HISTORY_ROW_COUNT_MISMATCH:${segment.source_path}`);
      if(bars[0].bar_start_utc!==segment.first_bar_utc || bars.at(-1).bar_start_utc!==segment.last_bar_utc) throw new Error(`QUALIFIED_HISTORY_BOUNDARY_MISMATCH:${segment.source_path}`);
      for(const bar of bars) {
        if(previousBar && bar.bar_start_utc<=previousBar) throw new Error(`QUALIFIED_HISTORY_NOT_MONOTONIC:${bar.bar_start_utc}`);
        previousBar=bar.bar_start_utc;
        digest.update(`${[bar.bar_start_utc,bar.open,bar.high,bar.low,bar.close,bar.volume,bar.bid_volume,bar.ask_volume,bar.num_trades].map(canonicalValue).join('|')}\n`);
      }
      totalRows+=bars.length;
      receipts.push({...segment,dataset_id:dataset.id,row_count:bars.length});
    }
  } finally { db.close(); }
  if(totalRows!==receipt.row_count) throw new Error(`QUALIFIED_HISTORY_TOTAL_MISMATCH:${totalRows}`);
  const barsHash=`sha256:${digest.digest('hex')}`;
  if(barsHash!==receipt.bars_sha256) throw new Error('QUALIFIED_HISTORY_HASH_MISMATCH');
  const coverage={...receipt,row_count:totalRows,bars_sha256:barsHash,segments:receipts};
  const sourceRevision=objectHash(coverage);
  const compact=(value)=>value.slice(0,10).replaceAll('-','');
  return {...coverage,source_revision:sourceRevision,coverage_tag:`${compact(receipt.start_utc)}-${compact(receipt.end_utc)}-${sourceRevision.slice(7,15)}`};
}

const qualifiedHistory=qualifyHistoricalCache();

const allSpecs = [
  {
    strategyId:'cicd-vwap-pull-back-strategy',
    instanceId:'test-cicd-vwap-pull-back-replay-two-v013',
    priorInstanceId:'test-cicd-vwap-pull-back-replay-two-v012',
    producerId:'test-cicd-vwap-pull-back-replay-two-v013-telemetry',
    profileKey:'cicd-vwap-pull-back-strategy.profile-v0.1.0-source-bound:v0.1.2',
    versionId:'test-replay-baseline-cicd-vwap-v010-profile-v012',
    version:'v0.1.0',
    codeHash:'sha256:03b6d816227bbc39f9a70d5eb7ddd2ce5de3e8247141411b2fc862b47ae0f14b',
    configHash:'sha256:17154dc6de19e0088e2bc4457b0f160662aac2f1f40107f2b75689e166ea1d60',
    chartHash:replayChartHash,
    sourceId:'test-sierra-replay-two-cicd-vwap',
    historySourceId:'test-ocean-mnq-qualified-history-cache',
    manifestPrefix:'test-vwap-replay-v013-history',
    permissionPrefix:'test-vwap-replay-v013-diagnostic-permission',
    existingInstance:false,
  },
  {
    strategyId:'15-minute-pullback-strategy',
    instanceId:'test-15-minute-pullback-replay-primary',
    producerId:'test-15-minute-pullback-replay-primary-telemetry',
    profileKey:'15-minute-pullback-strategy.profile.v0.1.0:v0.1.0',
    versionId:'test-replay-baseline-15-minute-pullback-v010',
    version:'v0.1.0',
    codeHash:'sha256:c771d7f62a0b3f4949b7f97388143047f771d772dfc20e5afa108fda418eb31d',
    configHash:'sha256:857dcd8e5bbae8908c0cbc8b221e9fe2525429ea4345bcde1da5cc398d44b2c1',
    chartHash:'sha256:4af87e571cadde1b11ce50cb72a96278dfc847dcb50f592b67a0679069ecbc52',
    sourceId:'Replay_379ea165f8410b45',
    historySourceId:'test-ocean-mnq-qualified-history-cache',
    manifestPrefix:'test-15-minute-pullback-replay-history',
    permissionPrefix:'test-15-minute-pullback-replay-history-permission',
    existingInstance:false,
  },
];
const specs=allSpecs.filter((spec)=>spec.strategyId===requestedStrategy);
if(specs.length!==1) throw new Error(`STRATEGY_SCOPE_REJECTED:${requestedStrategy}`);
if(!/^sha256:[a-f0-9]{64}$/.test(specs[0].chartHash || '')) throw new Error('CURRENT_REPLAY_CHART_HASH_REQUIRED');

const exactIdentity = (spec) => state.config.identities.find((identity) =>
  identity.identity_id === spec.producerId
  && identity.role === 'TELEMETRY'
  && identity.namespace === 'TEST'
  && identity.revoked === false
  && Date.parse(identity.expires_at_utc) > Date.now()
  && identity.strategy_ids.includes(spec.strategyId)
  && identity.instance_ids.includes(spec.instanceId)
  && ['read','event.write','health.write'].every((scope) => identity.scopes.includes(scope))
);

const same = (left,right) => objectHash(left) === objectHash(right);
const rowPayload = (table,id) => {
  const row=backend.db.prepare(`SELECT payload_json FROM ${table} WHERE id=?`).get(id);
  return row ? JSON.parse(row.payload_json) : null;
};
const requireSameOrMissing = (table,id,expected) => {
  const current=rowPayload(table,id);
  if(current && !same(current,expected)) throw new Error(`IMMUTABLE_RECONCILIATION_CONFLICT:${table}:${id}`);
  return current;
};

try {
  if(requestedStrategy==='cicd-vwap-pull-back-strategy') {
    const profile=JSON.parse(fs.readFileSync(correctedProfilePath,'utf8'));
    const registry=JSON.parse(fs.readFileSync(correctedRegistryPath,'utf8'));
    if(`${profile.profile_id}:${profile.profile_version}`!==specs[0].profileKey || profile.strategy_config_hash!==specs[0].configHash) throw new Error('CORRECTED_PROFILE_BINDING_CONFLICT');
    backend.perform('profile.register',actor,{profile,file_sha256:digest(Buffer.from(JSON.stringify(profile)))});
    const current=backend.db.prepare('SELECT revision,payload_json FROM ow_strategies WHERE id=?').get(requestedStrategy);
    if(!current) throw new Error('CORRECTED_REGISTRY_BASE_REQUIRED');
    if(current.payload_json!==JSON.stringify(registry)) {
      if(registry.registry_revision!==current.revision+1) throw new Error('CORRECTED_REGISTRY_REVISION_CONFLICT');
      backend.perform('strategy.register',actor,{registry,baseline_hash:profile.strategy_code_hash,expected_revision:current.revision});
    }
  }
  for (const spec of specs) {
    if (!exactIdentity(spec)) throw new Error(`ACTIVE_TEST_TELEMETRY_IDENTITY_REQUIRED:${spec.producerId}`);
    const registry=backend.db.prepare('SELECT profile_id,revision,baseline_hash FROM ow_strategies WHERE id=?').get(spec.strategyId);
    if (!registry || registry.profile_id!==spec.profileKey || registry.baseline_hash!==spec.codeHash) throw new Error(`STRATEGY_BASELINE_CONFLICT:${spec.strategyId}`);
    spec.versionPayload={version_id:spec.versionId,strategy_id:spec.strategyId,kind:'BASELINE',version:spec.version,code_hash:spec.codeHash,profile_key:spec.profileKey,artifact_id:null,case_id:null,registry_revision:registry.revision};
    spec.settingsPayload={instance_id:spec.instanceId,chart_settings_hash:spec.chartHash,time_basis:'UTC source records; Sierra chart display time preserved',session_calendar_revision:'observed-mnq-maintenance-2100-2200z-20260928',fill_model_version:'Sierra Chart Replay native simulation'};
    spec.manifestId=`${spec.manifestPrefix}-${qualifiedHistory.coverage_tag}`;
    spec.permissionId=`${spec.permissionPrefix}-${qualifiedHistory.coverage_tag}`;
    spec.manifest={schema_version:'2.1.0',dataset_manifest_id:spec.manifestId,revision:1,manifest_hash:null,source_id:spec.historySourceId,source_revision:qualifiedHistory.source_revision,created_at_utc:qualifiedHistory.qualified_at_utc,timezone:'UTC',contract_rollover_policy:qualifiedHistory.contract_rollover_policy,adjustment_policy:qualifiedHistory.adjustment_policy,partitions:[{start_utc:qualifiedHistory.start_utc,end_utc:qualifiedHistory.end_utc,partition:'DISCOVERY',symbol:qualifiedHistory.partition_symbol,coverage_status:'COMPLETE'}],protected_intervals:[],content_hashes:[qualifiedHistory.bars_sha256,qualifiedHistory.source_revision],quality_status:'VERIFIED',gaps:[]};
    spec.manifest.manifest_hash=sealedHash(spec.manifest,'manifest_hash');
    spec.manifestKey=`${spec.manifestId}:1`;
    spec.permissionPayload={permission_id:spec.permissionId,strategy_id:spec.strategyId,manifest_key:spec.manifestKey,manifest_hash:spec.manifest.manifest_hash,purposes:['NOT_ELIGIBLE'],expires_at_utc:'2027-09-30T23:59:59.000Z',prior_exposure:'EXPOSED',test_only:true};
    requireSameOrMissing('ow_run_versions',spec.versionId,spec.versionPayload);
    const existingSettings=rowPayload('ow_run_settings',spec.instanceId);
    if(existingSettings && existingSettings.instance_id!==spec.instanceId) throw new Error(`RUN_SETTINGS_IDENTITY_CONFLICT:${spec.instanceId}`);
    requireSameOrMissing('ow_datasets',spec.manifestKey,spec.manifest);
    requireSameOrMissing('ow_dataset_permissions',spec.permissionId,spec.permissionPayload);
  }

  const vwap=specs[0];
  const vwapPrior=rowPayload('ow_instances',vwap.priorInstanceId);
  if (!vwapPrior || vwapPrior.strategy_id!==vwap.strategyId || ![vwap.sourceId,`${vwap.sourceId}-retired-v012`].includes(vwapPrior.source_installation_id) || vwapPrior.chart_id!=='1' || vwapPrior.source_study_instance_id!=='StudyID3') throw new Error('VWAP_PRIOR_PHYSICAL_INSTANCE_CONFLICT');
  const vwapRetired={...vwapPrior,source_installation_id:`${vwap.sourceId}-retired-v012`,capabilities:[],status:'RETIRED'};
  const vwapDraft={
    execution_instance_id:vwap.instanceId,
    strategy_id:vwap.strategyId,
    source_installation_id:vwap.sourceId,
    chartbook_id:'cicd-vwap-pull-back-strategy-chartbook-v013',
    chart_id:vwapPrior.chart_id,
    source_study_instance_id:'StudyID6',
    telemetry_producer_id:vwap.producerId,
    version_binding:vwap.version,
    config_hash:vwap.configHash,
    account_alias:vwapPrior.account_alias,
    capabilities:['REPLAY'],
    status:'DRAFT',
    lease_run_id:null,
  };

  backend.store.transaction(() => {
    let vwapCurrent=rowPayload('ow_instances',vwap.instanceId);
    if (!vwapCurrent) {
      backend.db.prepare('UPDATE ow_instances SET payload_json=? WHERE id=?').run(JSON.stringify(vwapRetired),vwap.priorInstanceId);
      backend.event(vwap.priorInstanceId,'instance.supersede-run-settings',actor,{strategy_id:vwap.strategyId,replacement_instance_id:vwap.instanceId,execution_authority:false});
      backend.perform('instance.register',actor,{strategy_id:vwap.strategyId,instance:vwapDraft});
      const registered={...vwapDraft,status:'READY'};
      backend.db.prepare('UPDATE ow_instances SET payload_json=? WHERE id=?').run(JSON.stringify(registered),vwap.instanceId);
      backend.event(vwap.instanceId,'instance.reconcile-run-readiness',actor,{strategy_id:vwap.strategyId,telemetry_producer_id:vwap.producerId,chartbook_sha256:vwap.chartHash,execution_authority:false});
      vwapCurrent=registered;
    }
    if (!same(vwapCurrent,{...vwapDraft,status:'READY'})) throw new Error('VWAP_VERSIONED_INSTANCE_CONFLICT');
    for (const spec of specs) {
      if (!rowPayload('ow_run_versions',spec.versionId)) backend.runs.perform('version',actor,{version_id:spec.versionId,strategy_id:spec.strategyId,kind:'BASELINE',version:spec.version,code_hash:spec.codeHash,profile_key:spec.profileKey,artifact_id:null,case_id:null});
      if (!rowPayload('ow_run_settings',spec.instanceId)) backend.runs.perform('settings',actor,spec.settingsPayload);
      if (!rowPayload('ow_datasets',spec.manifestKey)) backend.perform('dataset.register',actor,{strategy_id:spec.strategyId,manifest:spec.manifest});
      if (!rowPayload('ow_dataset_permissions',spec.permissionId)) backend.runs.perform('permission',actor,spec.permissionPayload);
    }
  });

  const options=backend.runs.options(actor);
  const readback=specs.map((spec) => {
    const strategy=options.strategies.find((item)=>item.strategy_id===spec.strategyId);
    return {strategy_id:spec.strategyId,strategy_name:strategy?.strategy_name,run_readiness:strategy?.run_readiness,version_id:spec.versionId,instance_id:spec.instanceId,manifest_key:spec.manifestKey,permission_id:spec.permissionId};
  });
  if (readback.some((entry)=>entry.run_readiness?.ready!==true)) throw new Error('RUN_READINESS_READBACK_FAILED');
  process.stdout.write(`${JSON.stringify({status:'PASS',actual_ingestion:'OFF',actual_source_started:false,qualified_history:qualifiedHistory,strategies:readback},null,2)}\n`);
} finally {
  backend.close();
}
