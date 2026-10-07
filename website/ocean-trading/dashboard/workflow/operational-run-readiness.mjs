import fs from 'node:fs';
import path from 'node:path';
import { digest, objectHash, requireThat } from './common.mjs';
import { readReplayBridgeConfig } from './replay-run-bridge-probe.mjs';

const human = { id:'wayne-ocean-ui', role:'HUMAN', namespace:'OPERATIONAL', scopes:[], strategyIds:[], instanceIds:[] };
const parse = row => JSON.parse(row.payload_json);

export function reconcileOperationalReplayRunSettings(backend, configFile) {
  requireThat(typeof configFile === 'string' && path.isAbsolute(configFile), 503, 'OPERATIONAL_REPLAY_CONFIG_REQUIRED');
  const config = readReplayBridgeConfig(configFile);
  requireThat(config.schema_version === 'ocean-replay-run-bridge/v4' && config.namespace === 'OPERATIONAL', 503, 'OPERATIONAL_REPLAY_CONFIG_REQUIRED');
  requireThat(path.resolve(config.workflow_db).toLowerCase() === path.resolve(backend.config.db_file).toLowerCase(), 503, 'WORKFLOW_DATABASE_BINDING_CONFLICT');
  const binding = backend.config.operational_factual_bindings?.find(value => value.binding_hash === config.factual_binding_hash);
  requireThat(binding && binding.strategy_id === config.strategy_id && binding.instance.execution_instance_id === config.instance_id, 503, 'OPERATIONAL_FACTUAL_BINDING_CHANGED');
  const storedInstance = backend.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(config.instance_id);
  requireThat(storedInstance && objectHash(parse(storedInstance)) === objectHash(binding.instance), 503, 'OPERATIONAL_INSTANCE_BINDING_CONFLICT');
  requireThat(fs.existsSync(config.expected_chartbook_path) && fs.statSync(config.expected_chartbook_path).isFile(), 503, 'OPERATIONAL_CHARTBOOK_REQUIRED');
  // Sierra persists mutable chart/runtime state into .Cht files. Keep the
  // original fingerprint as provenance, but pin executable behavior to the
  // verified strategy and telemetry modules plus live source preflight.
  const observedChartbookHash = digest(fs.readFileSync(config.expected_chartbook_path));
  requireThat(fs.existsSync(config.expected_strategy_module_path) && fs.statSync(config.expected_strategy_module_path).isFile(), 503, 'OPERATIONAL_STRATEGY_MODULE_REQUIRED');
  requireThat(digest(fs.readFileSync(config.expected_strategy_module_path)) === config.expected_strategy_module_sha256, 503, 'OPERATIONAL_STRATEGY_MODULE_HASH_CONFLICT');
  requireThat(fs.existsSync(config.expected_telemetry_module_path) && fs.statSync(config.expected_telemetry_module_path).isFile(), 503, 'OPERATIONAL_TELEMETRY_MODULE_REQUIRED');
  requireThat(digest(fs.readFileSync(config.expected_telemetry_module_path)) === config.expected_telemetry_module_sha256, 503, 'OPERATIONAL_TELEMETRY_MODULE_HASH_CONFLICT');
  const settings = {
    instance_id: config.instance_id,
    chart_settings_hash: config.expected_chartbook_sha256,
    time_basis: config.time_basis,
    session_calendar_revision: config.session_calendar_revision,
    fill_model_version: config.fill_model_version,
  };
  const existing = backend.db.prepare('SELECT payload_json FROM ow_run_settings WHERE id=?').get(config.instance_id);
  if (existing) {
    requireThat(objectHash(parse(existing)) === objectHash(settings), 503, 'OPERATIONAL_RUN_SETTINGS_CONFLICT');
    return { status:'READY', instance_id:config.instance_id, chart_settings_hash:settings.chart_settings_hash, observed_chartbook_sha256:observedChartbookHash, chartbook_matches_initial_fingerprint:observedChartbookHash===config.expected_chartbook_sha256, idempotent:true };
  }
  backend.runs.perform('settings', human, settings);
  return { status:'READY', instance_id:config.instance_id, chart_settings_hash:settings.chart_settings_hash, observed_chartbook_sha256:observedChartbookHash, chartbook_matches_initial_fingerprint:observedChartbookHash===config.expected_chartbook_sha256, idempotent:false };
}
