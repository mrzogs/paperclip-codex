import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exactKeys, objectHash, requireThat, sealedHash } from './common.mjs';

export const DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT = process.env.OCEAN_VWAP_PHYSICAL_COMPARATOR_CONTRACT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'cicd-vwap-v238-physical-comparator.json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OLD_RUN_IDS = new Set([
  'cicd-vwap-discovery-20250913-20251001-z25-v011-r1',
  'reprocess-cicd-vwap-discovery-20250913-20251001-z25-v011-r1-f92fa7f6-6c63-4481-88d1-d36979572086',
]);

export function physicalComparatorContractHash(value) {
  const { contract_hash, document_hash, required_human_approvals, ...authority } = value;
  return objectHash(authority);
}

function validateSha(value, code) {
  requireThat(SHA256.test(String(value || '').toLowerCase()), 422, code);
}

function validateContract(value) {
  exactKeys(value, [
    'schema_version', 'contract_id', 'strategy_id', 'created_at_utc', 'status', 'namespace',
    'logical_baseline', 'physical_comparator', 'preserved_candidate_v240', 'dataset_selection',
    'run_context', 'execution_plan', 'telemetry_lineage', 'replaced_authority',
    'required_human_approvals', 'safety', 'contract_hash', 'document_hash',
  ]);
  requireThat(value.schema_version === 'ocean-vwap-physical-comparator-run/v1', 422, 'PHYSICAL_COMPARATOR_SCHEMA_INVALID');
  requireThat(value.strategy_id === 'cicd-vwap-pull-back-strategy', 422, 'PHYSICAL_COMPARATOR_STRATEGY_INVALID');
  requireThat(value.namespace === 'TEST' && value.status === 'PENDING_HUMAN_APPROVAL', 422, 'PHYSICAL_COMPARATOR_STATE_INVALID');
  requireThat(Number.isFinite(Date.parse(value.created_at_utc)), 422, 'PHYSICAL_COMPARATOR_CREATED_AT_INVALID');

  const baseline = value.logical_baseline || {};
  requireThat(baseline.logical_version === 'v0.1.1', 422, 'PHYSICAL_COMPARATOR_LOGICAL_BASELINE_INVALID');
  requireThat(baseline.approved_physical_baseline_version === 'v0.6.234-absolute-risk-gate-candidate', 422, 'PHYSICAL_COMPARATOR_APPROVED_BASELINE_INVALID');
  requireThat(baseline.profile_id === 'cicd-vwap-pull-back-strategy.profile-v0.1.0-source-bound' && baseline.profile_version === 'v0.1.3', 422, 'PHYSICAL_COMPARATOR_LOGICAL_PROFILE_INVALID');
  for (const [key, code] of [
    ['strategy_code_hash', 'PHYSICAL_COMPARATOR_CODE_HASH_INVALID'],
    ['approved_baseline_dll_hash', 'PHYSICAL_COMPARATOR_BASELINE_DLL_HASH_INVALID'],
    ['profile_hash', 'PHYSICAL_COMPARATOR_PROFILE_HASH_INVALID'],
    ['strategy_config_hash', 'PHYSICAL_COMPARATOR_CONFIG_HASH_INVALID'],
  ]) validateSha(baseline[key], code);

  const physical = value.physical_comparator || {};
  requireThat(physical.version === 'v0.6.238' && physical.raw_version === 'v0.6.238-managed-entry-boundary-candidate', 422, 'PHYSICAL_COMPARATOR_V238_VERSION_INVALID');
  requireThat(physical.candidate_id === 'v0.6.238-managed-entry-boundary', 422, 'PHYSICAL_COMPARATOR_V238_CANDIDATE_INVALID');
  requireThat(physical.profile_id === 'nasdaq_v0608_us_trendup_weak_distance_qty1_replay_status_preserve_risk1100_qty5_candidate', 422, 'PHYSICAL_COMPARATOR_V238_PROFILE_INVALID');
  requireThat(physical.selection_state === 'PENDING_HUMAN_APPROVAL', 422, 'PHYSICAL_COMPARATOR_V238_SELECTION_STATE_INVALID');
  for (const [key, code] of [
    ['source_hash', 'PHYSICAL_COMPARATOR_V238_SOURCE_HASH_INVALID'],
    ['dll_hash', 'PHYSICAL_COMPARATOR_V238_DLL_HASH_INVALID'],
    ['build_receipt_hash', 'PHYSICAL_COMPARATOR_V238_BUILD_RECEIPT_HASH_INVALID'],
    ['provenance_report_hash', 'PHYSICAL_COMPARATOR_V238_PROVENANCE_HASH_INVALID'],
    ['mapping_handoff_hash', 'PHYSICAL_COMPARATOR_V238_MAPPING_HASH_INVALID'],
  ]) validateSha(physical[key], code);

  const preserved = value.preserved_candidate_v240 || {};
  requireThat(preserved.version === 'v0.6.240' && preserved.state === 'DISTINCT_UNSELECTED_UNCHANGED', 422, 'PHYSICAL_COMPARATOR_V240_STATE_INVALID');
  requireThat(preserved.selected === false && preserved.active_bridge_changed === false, 422, 'PHYSICAL_COMPARATOR_V240_BOUNDARY_INVALID');
  requireThat(preserved.dll_hash === 'sha256:9a6189a438cb49c8a16b71cebc05372cab5f6f6002f2daa8ea780c33b9aef05f', 422, 'PHYSICAL_COMPARATOR_V240_DLL_INVALID');

  const dataset = value.dataset_selection || {};
  requireThat(dataset.manifest_id === 'cicd-vwap-frozen-ladder-qualified-20261002' && dataset.revision === 3, 422, 'PHYSICAL_COMPARATOR_DATASET_INVALID');
  requireThat(dataset.role === 'DISCOVERY' && dataset.role_mutation_allowed === false, 422, 'PHYSICAL_COMPARATOR_DATASET_ROLE_INVALID');
  requireThat(dataset.symbol === 'MNQZ25_FUT_CME' && dataset.start_utc === '2025-09-12T23:00:00Z' && dataset.end_utc === '2025-09-30T23:00:00Z', 422, 'PHYSICAL_COMPARATOR_DATASET_INTERVAL_INVALID');
  requireThat(dataset.prior_exposure === 'EXPOSED' && dataset.use_classification === 'REUSED_DEVELOPMENT_DATA' && dataset.validation_independence === false, 422, 'PHYSICAL_COMPARATOR_DATASET_CLASSIFICATION_INVALID');
  requireThat(dataset.selection_action === 'REPROCESS_EXISTING_HISTORY', 422, 'PHYSICAL_COMPARATOR_DATASET_ACTION_INVALID');
  validateSha(dataset.manifest_hash, 'PHYSICAL_COMPARATOR_DATASET_HASH_INVALID');
  validateSha(dataset.source_scid_hash, 'PHYSICAL_COMPARATOR_SCID_HASH_INVALID');

  const context = value.run_context || {};
  requireThat(context.schema_version === '2.1.0' && context.revision === 1, 422, 'PHYSICAL_COMPARATOR_CONTEXT_SCHEMA_INVALID');
  requireThat(RUN_ID.test(String(context.run_id || '')) && !OLD_RUN_IDS.has(context.run_id), 422, 'PHYSICAL_COMPARATOR_RUN_ID_INVALID');
  requireThat(context.strategy_id === value.strategy_id && context.strategy_version === baseline.logical_version, 422, 'PHYSICAL_COMPARATOR_CONTEXT_LOGICAL_IDENTITY_INVALID');
  requireThat(context.strategy_code_hash === baseline.strategy_code_hash && context.strategy_config_hash === baseline.strategy_config_hash, 422, 'PHYSICAL_COMPARATOR_CONTEXT_LOGICAL_HASH_INVALID');
  requireThat(context.strategy_profile_id === baseline.profile_id && context.strategy_profile_version === baseline.profile_version, 422, 'PHYSICAL_COMPARATOR_CONTEXT_PROFILE_INVALID');
  requireThat(context.execution_instance_id === 'cicd-vwap-pull-back-strategy:replay-two:chart1' && context.source_installation_id === 'sierra-replay-two-494ca0a67d569d84', 422, 'PHYSICAL_COMPARATOR_CONTEXT_INSTANCE_INVALID');
  requireThat(context.expected_environment === 'REPLAY' && context.observed_source_state?.environment === 'UNKNOWN' && context.observed_source_state?.quality === 'UNKNOWN', 422, 'PHYSICAL_COMPARATOR_CONTEXT_SOURCE_INVALID');
  requireThat(context.evidence_purpose === 'HISTORICAL_BUILD' && context.dataset_partition === 'DISCOVERY' && context.historical_build_mode === 'REPROCESS_EXISTING_HISTORY', 422, 'PHYSICAL_COMPARATOR_CONTEXT_PURPOSE_INVALID');
  requireThat(context.dataset_manifest_id === dataset.manifest_id && context.dataset_manifest_revision === dataset.revision && context.dataset_manifest_hash === dataset.manifest_hash, 422, 'PHYSICAL_COMPARATOR_CONTEXT_DATASET_INVALID');
  requireThat(context.experiment_id === null && context.candidate_id === null && context.case_id === null, 422, 'PHYSICAL_COMPARATOR_CONTEXT_HISTORICAL_IDENTITY_INVALID');
  requireThat(context.learner_permission === 'HISTORICAL_DISCOVERY', 422, 'PHYSICAL_COMPARATOR_CONTEXT_PERMISSION_INVALID');
  requireThat(sealedHash(context, 'context_hash') === context.context_hash, 422, 'PHYSICAL_COMPARATOR_CONTEXT_HASH_INVALID');

  const execution = value.execution_plan || {};
  requireThat(execution.creation_mode === 'CREATE_NEW' && execution.state === 'SELECTED_NOT_MATERIALIZED', 422, 'PHYSICAL_COMPARATOR_EXECUTION_STATE_INVALID');
  requireThat(execution.run_record_inserted === false && execution.release_record_inserted === false && execution.replay_started === false, 422, 'PHYSICAL_COMPARATOR_EXECUTION_BOUNDARY_INVALID');
  requireThat(execution.run_id === context.run_id && execution.context_hash === context.context_hash, 422, 'PHYSICAL_COMPARATOR_EXECUTION_CONTEXT_INVALID');
  requireThat(!value.replaced_authority?.old_output_roots?.includes(execution.output_root), 422, 'PHYSICAL_COMPARATOR_OUTPUT_REUSED');
  requireThat(execution.simulation_required === true && execution.account_alias === 'Sim1', 422, 'PHYSICAL_COMPARATOR_SIMULATION_BOUNDARY_INVALID');

  const telemetry = value.telemetry_lineage || {};
  requireThat(telemetry.managed_strategy_version === physical.version && telemetry.managed_candidate_id === physical.candidate_id, 422, 'PHYSICAL_COMPARATOR_TELEMETRY_PHYSICAL_IDENTITY_INVALID');
  requireThat(telemetry.sttl2_inputs?.['113'] === context.run_id && telemetry.sttl2_inputs?.['114'] === baseline.strategy_code_hash && telemetry.sttl2_inputs?.['115'] === baseline.strategy_config_hash && telemetry.sttl2_inputs?.['116'] === context.context_hash, 422, 'PHYSICAL_COMPARATOR_TELEMETRY_CONTEXT_INVALID');
  requireThat(telemetry.sttl2_inputs?.['117'] === `${dataset.manifest_id}:${dataset.revision}` && telemetry.sttl2_inputs?.['118'] === dataset.role, 422, 'PHYSICAL_COMPARATOR_TELEMETRY_DATASET_INVALID');
  requireThat(telemetry.logger_successor?.state === 'SELECTED_NOT_DEPLOYED' && telemetry.logger_successor?.version === 'v0.5.53' && telemetry.logger_successor?.loaded === false, 422, 'PHYSICAL_COMPARATOR_LOGGER_BOUNDARY_INVALID');

  const approvals = value.required_human_approvals;
  requireThat(Array.isArray(approvals) && approvals.length === 2, 422, 'PHYSICAL_COMPARATOR_APPROVALS_INVALID');
  requireThat(new Set(approvals.map(item => item.approval_id.toLowerCase())).size === 2, 422, 'PHYSICAL_COMPARATOR_APPROVALS_REUSED');
  requireThat(approvals.every(item => UUID.test(String(item.approval_id || '')) && item.source === 'physical_comparator_contract'), 422, 'PHYSICAL_COMPARATOR_APPROVAL_REFERENCE_INVALID');
  requireThat(new Set(approvals.map(item => item.decision_scope)).size === 2
    && approvals.some(item => item.decision_scope === 'DATASET_PHYSICAL_SELECTION')
    && approvals.some(item => item.decision_scope === 'RUN_RELEASE'), 422, 'PHYSICAL_COMPARATOR_APPROVAL_SCOPE_INVALID');

  const safety = value.safety || {};
  requireThat(safety.execution_authority === false && safety.replay_start_authorized === false
    && safety.paper_deployment_authorized === false && safety.live_deployment_authorized === false
    && safety.historical_role_change_authorized === false && safety.active_bridge_change_authorized === false
    && safety.automatic_approval_enabled === false, 422, 'PHYSICAL_COMPARATOR_SAFETY_INVALID');
  requireThat(physicalComparatorContractHash(value) === value.contract_hash, 422, 'PHYSICAL_COMPARATOR_CONTRACT_HASH_INVALID');
  requireThat(sealedHash(value, 'document_hash') === value.document_hash, 422, 'PHYSICAL_COMPARATOR_DOCUMENT_HASH_INVALID');
}

export function readVwapPhysicalComparatorContract(contractPath = DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT, strategyId = 'cicd-vwap-pull-back-strategy') {
  try {
    const content = fs.readFileSync(contractPath);
    const value = JSON.parse(content.toString('utf8'));
    validateContract(value);
    requireThat(value.strategy_id === strategyId, 422, 'PHYSICAL_COMPARATOR_STRATEGY_MISMATCH');
    return {
      ...value,
      state:'AVAILABLE',
      path:contractPath,
      file_hash:`sha256:${createHash('sha256').update(content).digest('hex')}`,
      observed_at_utc:fs.statSync(contractPath).mtime.toISOString(),
    };
  } catch (error) {
    return {
      schema_version:'ocean-vwap-physical-comparator-run/v1', strategy_id:strategyId,
      state:error?.code === 'ENOENT' ? 'NOT_CONFIGURED' : 'ATTENTION_REQUIRED', status:'BLOCKED_FAIL_CLOSED',
      required_human_approvals:[], path:contractPath,
      reason:error?.code || error?.message || 'PHYSICAL_COMPARATOR_CONTRACT_INVALID',
      safety:{ execution_authority:false, replay_start_authorized:false, paper_deployment_authorized:false, live_deployment_authorized:false,
        historical_role_change_authorized:false, active_bridge_change_authorized:false, automatic_approval_enabled:false },
    };
  }
}
