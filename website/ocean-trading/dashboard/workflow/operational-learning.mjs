import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { digest, objectHash, requireThat } from './common.mjs';

const REQUEST_VERSION = 'ocean-operational-learning-request/v1';
const RESPONSE_VERSION = 'ocean-operational-learning-result/v1';
const ELIGIBLE = new Map([
  ['HISTORICAL_DISCOVERY', 'DISCOVERY'],
]);

const INFORMATIONAL_CAUSAL_FLAGS = new Set([
  'pre_entry_features_missing',
  'pre_entry_continuation_exhaustion_missing',
]);

export function criticalCausalQualityFlags(value) {
  return String(value || '').split('|').map(flag => flag.trim()).filter(Boolean)
    .filter(flag => !INFORMATIONAL_CAUSAL_FLAGS.has(flag));
}
const LEARNER_PERMISSION = new Map([
  ['HISTORICAL_DISCOVERY', 'HYPOTHESIS_GENERATION'],
  ['SCOPED_LEARNING', 'ANALYSE_ONLY'],
]);
const DATASET_ROLES = new Set(['DISCOVERY', 'DIAGNOSTIC', 'VALIDATION', 'PROTECTED_HOLDOUT', 'FORWARD', 'REPLAY', 'PAPER', 'NOT_ELIGIBLE']);

const parse = row => JSON.parse(row.payload_json);
const fileHash = filename => `sha256:${createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
const safeError = error => String(error?.code || error?.message || 'OPERATIONAL_LEARNING_FAILED')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);

function brainHttpDetail(value) {
  const detail = value?.detail;
  const messages = Array.isArray(detail)
    ? detail.map(item => {
      const location = Array.isArray(item?.loc) ? item.loc.join('.') : '';
      const message = typeof item?.msg === 'string' ? item.msg : '';
      return [location, message].filter(Boolean).join(': ');
    }).filter(Boolean)
    : typeof detail === 'string' ? [detail] : [];
  return messages.join('; ').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 400);
}

function actorFrom(identity) {
  return {
    id: identity.identity_id,
    role: identity.role,
    scopes: identity.scopes,
    strategyIds: identity.strategy_ids,
    instanceIds: identity.instance_ids,
    namespace: identity.namespace,
    audience: identity.audience,
    factualBindingHash: identity.factual_binding_hash,
  };
}

function evidenceSummary(rows) {
  const canonical = new Map();
  for (const row of rows) {
    const value = parse(row);
    if (!row.canonical_id || value.conflicting_fields?.length) continue;
    if (!canonical.has(row.canonical_id)) canonical.set(row.canonical_id, value);
  }
  const values = [...canonical.values()];
  const pnl = values.map(value => Number(value.facts?.pnl)).filter(Number.isFinite);
  const bySide = Object.fromEntries(['LONG', 'SHORT'].map(side => {
    const selected = values.filter(value => value.provenance?.side === side);
    return [side, {
      trades: selected.length,
      pnl: selected.reduce((sum, value) => sum + (Number(value.facts?.pnl) || 0), 0),
      wins: selected.filter(value => Number(value.facts?.pnl) > 0).length,
      losses: selected.filter(value => Number(value.facts?.pnl) < 0).length,
    }];
  }));
  return {
    trades: values.length,
    pnl: pnl.reduce((sum, value) => sum + value, 0),
    wins: pnl.filter(value => value > 0).length,
    losses: pnl.filter(value => value < 0).length,
    flat: pnl.filter(value => value === 0).length,
    by_side: bySide,
    canonical_trade_ids: [...canonical.keys()].sort(),
  };
}

function causalSummary(rows) {
  const groups = new Map();
  const numericFields = [
    'net_profit_loss', 'mfe_points', 'mae_points', 'vwap_distance_points',
    'initial_risk_points', 'exhaustion_score', 'quality_scaler_distance_atr',
    'price_change_60m', 'price_change_120m', 'vwap_slope_60m', 'atr_change_60m_pct',
  ];
  for (const row of rows) {
    const dimensions = {
      setup_family: row.setup_family,
      direction: row.direction,
      session_name: row.session_name,
      regime_label: row.regime_label,
      volatility_label: row.volatility_label,
      continuation_state: row.continuation_state,
      exhaustion_state: row.exhaustion_state,
      exit_causality: row.exit_causality,
    };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) || { dimensions, trades: 0, wins: 0, losses: 0, flat: 0, totals: {}, samples: {} };
    group.trades += 1;
    const pnl = Number(row.net_profit_loss);
    if (Number.isFinite(pnl)) pnl > 0 ? group.wins += 1 : pnl < 0 ? group.losses += 1 : group.flat += 1;
    for (const field of numericFields) {
      const value = Number(row[field]);
      if (!Number.isFinite(value)) continue;
      group.totals[field] = (group.totals[field] || 0) + value;
      group.samples[field] = (group.samples[field] || 0) + 1;
    }
    groups.set(key, group);
  }
  return {
    trades: rows.length,
    independent_sessions: new Set(rows.map(row => Math.trunc(Number(row.entry_datetime))).filter(Number.isFinite)).size,
    trade_ids: rows.map(row => String(row.trade_id)),
    groups: [...groups.values()].map(group => ({
      ...group.dimensions,
      trades: group.trades,
      wins: group.wins,
      losses: group.losses,
      flat: group.flat,
      averages: Object.fromEntries(numericFields.map(field => [field,
        group.samples[field] ? group.totals[field] / group.samples[field] : null])),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function cumulativeLearningProposal(bundle) {
  if (bundle.cohort.aggregate.evidence_status !== 'SUFFICIENT') return null;
  const eligible = bundle.diagnostics.filter(value => value.eligible);
  const segmentDimensions = [
    'setup_family', 'direction', 'session_name', 'regime_label',
    'volatility_label', 'continuation_state', 'exhaustion_state', 'exit_causality',
  ];
  const segments = new Map();
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let netProfitLoss = 0;
  for (const item of eligible) {
    const causal = item.telemetry?.causal_summary;
    if (!causal) continue;
    for (const group of causal.groups || []) {
      const groupTrades = Number(group.trades) || 0;
      const groupNet = (Number(group.averages?.net_profit_loss) || 0) * groupTrades;
      trades += groupTrades;
      wins += Number(group.wins) || 0;
      losses += Number(group.losses) || 0;
      flat += Number(group.flat) || 0;
      netProfitLoss += groupNet;
      for (const dimension of segmentDimensions) {
        const value = String(group[dimension] ?? '').trim();
        if (!value) continue;
        const key = `${dimension}:${value}`;
        const current = segments.get(key) || {
          dimension, value, trades: 0, wins: 0, losses: 0, flat: 0, net_profit_loss: 0,
        };
        current.trades += groupTrades;
        current.wins += Number(group.wins) || 0;
        current.losses += Number(group.losses) || 0;
        current.flat += Number(group.flat) || 0;
        current.net_profit_loss += groupNet;
        segments.set(key, current);
      }
    }
  }
  if (!trades) return null;
  const minimumSegmentTrades = Math.max(5, Math.ceil(trades * 0.05));
  const comparable = [...segments.values()]
    .filter(value => value.trades >= minimumSegmentTrades)
    .map(value => ({
      ...value,
      net_profit_loss: rounded(value.net_profit_loss),
      net_per_trade: rounded(value.net_profit_loss / value.trades),
      win_rate_percent: rounded(100 * value.wins / value.trades, 1),
    }));
  const byPerformance = [...comparable].sort((left, right) => (
    left.net_per_trade - right.net_per_trade
      || right.trades - left.trades
      || `${left.dimension}:${left.value}`.localeCompare(`${right.dimension}:${right.value}`)
  ));
  const contextOnly = bundle.diagnostics.filter(value => !value.eligible).map(value => {
    const causal = value.telemetry?.causal_summary;
    const causalNet = (causal?.groups || []).reduce((sum, group) => (
      sum + (Number(group.averages?.net_profit_loss) || 0) * (Number(group.trades) || 0)
    ), 0);
    return {
      run_id: value.run_id,
      exclusion_reasons: value.reasons,
      observed_trades: causal?.trades ?? value.metrics?.trades ?? 0,
      observed_net_profit_loss: rounded(causalNet || Number(value.metrics?.pnl) || 0),
      use: 'CONTEXT_ONLY_NOT_ELIGIBLE_FOR_AGGREGATE',
    };
  });
  const content = {
    schema_version: 'ocean-evidence-bound-learning-proposal/v1',
    strategy_id: bundle.policy.project,
    eligible_run_ids: eligible.map(value => value.run_id).sort(),
    cumulative_evidence: {
      trades,
      wins,
      losses,
      flat,
      win_rate_percent: rounded(100 * wins / trades, 1),
      net_profit_loss: rounded(netProfitLoss),
      independent_sessions: bundle.cohort.aggregate.independent_session_count,
      minimum_segment_trades: minimumSegmentTrades,
    },
    strongest_repeatable_segments: byPerformance.slice(-3).reverse(),
    weakest_repeatable_segments: byPerformance.slice(0, 3),
    excluded_context: contextOnly,
    interpretation: [
      'Segment statistics are descriptive evidence for investigation, not production rules.',
      'Excluded evidence is retained as context but does not contribute to eligible aggregate confidence.',
      'Any strategy or configuration change requires a separate candidate and governed evaluation.',
    ],
    authority: {
      automatic_strategy_change: false,
      candidate_approved: false,
      paper_authorized: false,
      live_authorized: false,
      live_real: 'DISABLED',
    },
  };
  return {
    title: `Review cumulative causal evidence for ${bundle.policy.strategy_name}`,
    content: JSON.stringify(content, null, 2),
  };
}

function asOfUtc(value, fallback = '1970-01-01T00:00:00Z') {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed)
    ? new Date(Math.floor(parsed / 1000) * 1000).toISOString().replace('.000Z', 'Z')
    : fallback;
}

function continuationSuffix(runId, registryRecordSha256) {
  return createHash('sha256').update(`${runId}:${registryRecordSha256}`).digest('hex').slice(0, 16);
}

function caseIdFor(runId, registryRecordSha256 = 'unbound') {
  const suffix = continuationSuffix(runId, registryRecordSha256).toUpperCase();
  return `CASE-OPERATIONAL-${suffix}-0001`;
}

function artifactIdFor(runId, registryRecordSha256) {
  return `test-operational-learning-recommendation-${continuationSuffix(runId, registryRecordSha256)}`;
}

export class OperationalLearning {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.db = backend.db;
    this.enabled = options.enabled === true;
    this.strategyId = options.strategy_id || null;
    this.api = String(options.api || 'http://127.0.0.1:4001').replace(/\/$/, '');
    this.path = options.path || '/trading/learning/operational';
    this.tokenFile = options.token_file || null;
    this.telemetryRequired = options.telemetry_required !== false;
    this.telemetryDb = options.telemetry_db || null;
    this.completionRoot = options.completion_root || null;
    this.physicalBindingFile = options.physical_binding_file || null;
    this.fetch = options.fetch || globalThis.fetch;
    this.intervalMs = Math.max(1000, Number(options.interval_ms || 5000));
    this.timer = null;
    this.running = false;
    this.identityVerified = false;
    this.registryContext = null;
    this.lastSuccessUtc = null;
    this.lastError = null;
    this.retry = new Map();
  }

  start() {
    if (!this.enabled || this.timer) return;
    const run = () => void this.flushOnce().catch(error => { this.lastError = safeError(error); });
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
    run();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  token() {
    requireThat(this.tokenFile && fs.existsSync(this.tokenFile), 503, 'OPERATIONAL_LEARNING_BRAIN_CREDENTIAL_MISSING');
    const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    requireThat(token.length >= 20, 503, 'OPERATIONAL_LEARNING_BRAIN_CREDENTIAL_INVALID');
    return token;
  }

  async call(path, token, body = undefined) {
    const response = await this.fetch(`${this.api}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(200000),
    });
    const value = await response.json().catch(() => ({}));
    const detail = brainHttpDetail(value);
    requireThat(response.ok, 503, `OPERATIONAL_LEARNING_BRAIN_HTTP_${response.status}${detail ? `: ${detail}` : ''}`);
    return value;
  }

  async verifyIdentity(token) {
    const identity = await this.call('/auth/me', token);
    requireThat(identity?.client?.scope === 'TRADING' && identity.client.strategy_ids?.includes(this.strategyId), 503, 'OPERATIONAL_LEARNING_BRAIN_IDENTITY_MISMATCH');
    this.identityVerified = true;
  }

  async registry(token) {
    const response = await this.call(`/strategy-registry/${encodeURIComponent(this.strategyId)}`, token);
    const strategy = response?.strategy;
    const reconciliation = strategy?.reconciliation;
    requireThat(response?.status === 'ok'
      && reconciliation?.reconciliation_id
      && /^sha256:[a-f0-9]{64}$/.test(reconciliation?.record_sha256 || '')
      && strategy?.governance, 503, 'OPERATIONAL_LEARNING_REGISTRY_CONTEXT_INVALID');
    this.registryContext = {
      reconciliation_id: reconciliation.reconciliation_id,
      record_sha256: reconciliation.record_sha256,
      lifecycle_status: reconciliation.lifecycle_status,
      normal_brain_ingestion_eligible: strategy.governance.normal_brain_ingestion_eligible === true,
      development_recommendations_allowed: strategy.governance.development_recommendations_allowed === true,
    };
    return this.registryContext;
  }

  brainActor(strategyId, instanceId) {
    const identity = this.backend.config.identities.find(value => value.role === 'BRAIN'
      && value.namespace === 'OPERATIONAL'
      && value.strategy_ids?.includes(strategyId)
      && value.instance_ids?.includes(instanceId)
      && ['read', 'artifact.write', 'event.write'].every(scope => value.scopes?.includes(scope)));
    requireThat(identity, 503, 'OPERATIONAL_LEARNING_OCEAN_IDENTITY_MISSING');
    return actorFrom(identity);
  }

  physicalStrategyBinding(run, context, plan, lineage) {
    if (lineage.strategy_version === context.strategy_version) {
      return { verified: true, kind: 'LOGICAL_VERSION_EXACT', strategy_version: lineage.strategy_version };
    }
    if (!this.physicalBindingFile || !fs.existsSync(this.physicalBindingFile)) {
      return { verified: false, reason: 'PHYSICAL_STRATEGY_BINDING_REQUIRED' };
    }
    let binding;
    try { binding = JSON.parse(fs.readFileSync(this.physicalBindingFile, 'utf8')); }
    catch { return { verified: false, reason: 'PHYSICAL_STRATEGY_BINDING_INVALID' }; }
    const factualBindingHash = plan?.operational_review?.factual_binding_hash;
    const verified = binding.schema_version === 'ocean-replay-run-bridge/v4'
      && binding.strategy_id === run.strategy_id
      && binding.instance_id === run.instance_id
      && binding.expected_strategy_version === lineage.strategy_version
      && typeof factualBindingHash === 'string'
      && binding.factual_binding_hash === factualBindingHash;
    return verified
      ? {
          verified: true,
          kind: 'APPROVED_LOGICAL_TO_PHYSICAL',
          logical_strategy_version: context.strategy_version,
          physical_strategy_version: lineage.strategy_version,
          factual_binding_hash: factualBindingHash,
        }
      : { verified: false, reason: 'PHYSICAL_STRATEGY_BINDING_CONFLICT' };
  }

  attemptReceiptQualification(database, runId, lineage) {
    if (Number(lineage.partial_receipt_count) === 0) {
      return { verified: true, superseded_zero_event_attempts: [] };
    }
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('replay_run_attempts','telemetry_run_receipts')").all().map(row => row.name));
    if (!tables.has('replay_run_attempts') || !tables.has('telemetry_run_receipts')) {
      return { verified: false, reason: 'TELEMETRY_RUN_RECEIPT_PARTIAL' };
    }
    const attempts = database.prepare(`SELECT a.attempt_id,a.attempt_number,a.attempt_started_utc,a.attempt_ended_utc,
      a.starting_trade_id,a.starting_fill_id,r.trade_count,r.closed_trade_count,r.fill_count,r.receipt_kind,r.data_quality_flags
      FROM replay_run_attempts a LEFT JOIN telemetry_run_receipts r
      ON r.run_id=a.run_id AND r.attempt_id=a.attempt_id
      WHERE a.run_id=? ORDER BY a.attempt_number`).all(runId);
    if (attempts.length !== Number(lineage.attempt_count)
      || attempts.some(attempt => attempt.receipt_kind == null)
      || attempts.length !== Number(lineage.attempt_receipt_count)) {
      return { verified: false, reason: 'TELEMETRY_RUN_RECEIPT_MISSING' };
    }
    const latest = attempts.at(-1);
    const latestClean = latest.attempt_ended_utc
      && Number(latest.trade_count) === Number(lineage.closed_trade_count)
      && Number(latest.closed_trade_count) === Number(lineage.closed_trade_count)
      && (lineage.fill_count == null || Number(latest.fill_count) === Number(lineage.fill_count))
      && ['trades_observed', 'no_events'].includes(String(latest.receipt_kind))
      && !String(latest.data_quality_flags || '').trim();
    const earlier = attempts.slice(0, -1);
    const superseded = earlier.every(attempt => attempt.attempt_ended_utc
      && Date.parse(attempt.attempt_ended_utc) <= Date.parse(latest.attempt_started_utc)
      && Number(attempt.trade_count) === 0
      && Number(attempt.closed_trade_count) === 0
      && Number(attempt.fill_count) === 0
      && attempt.receipt_kind === 'no_events'
      && Number(attempt.starting_trade_id) === Number(latest.starting_trade_id)
      && Number(attempt.starting_fill_id) === Number(latest.starting_fill_id));
    return latestClean && superseded
      ? { verified: true, superseded_zero_event_attempts: earlier.map(attempt => attempt.attempt_number) }
      : { verified: false, reason: 'TELEMETRY_RUN_RECEIPT_PARTIAL' };
  }

  telemetryQualification(run, context, plan, summary) {
    if (!this.telemetryRequired) return { verified: true, bypassed: true };
    if (!this.telemetryDb || !this.completionRoot) return { verified: false, reasons: ['TELEMETRY_QUALIFICATION_CONFIG_REQUIRED'] };
    if (!fs.existsSync(this.telemetryDb)) return { verified: false, reasons: ['TELEMETRY_DATABASE_REQUIRED'] };
    const receiptFile = path.join(this.completionRoot, `${run.id}-completion.json`);
    if (!fs.existsSync(receiptFile)) return { verified: false, reasons: ['PHYSICAL_COMPLETION_RECEIPT_REQUIRED'] };
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
    catch { return { verified: false, reasons: ['PHYSICAL_COMPLETION_RECEIPT_INVALID'] }; }
    const requested = summary?.completion?.requested_coverage || [];
    const first = requested[0];
    const last = requested.at(-1);
    const instanceRow = this.db.prepare('SELECT payload_json FROM ow_instances WHERE id=?').get(run.instance_id);
    const registeredInstance = instanceRow ? parse(instanceRow) : null;
    const expectedSimulationAccount = plan?.instance?.account_alias
      || registeredInstance?.account_alias
      || context.observed_source_state?.account_alias;
    if (receipt.schema_version !== 'ocean-replay-completion/v1'
      || receipt.run_id !== run.id
      || receipt.status !== 'COMPLETED'
      || !first || !last
      || Date.parse(receipt.scored_start_utc) !== Date.parse(first.start_utc)
      || Date.parse(receipt.end_exclusive_utc) !== Date.parse(last.end_utc)
      || !expectedSimulationAccount
      || receipt.simulation_account !== expectedSimulationAccount
      || receipt.live_real !== 'DISABLED') {
      return { verified: false, reasons: ['PHYSICAL_COMPLETION_RECEIPT_SCOPE_CONFLICT'] };
    }
    let database;
    try {
      database = new DatabaseSync(this.telemetryDb, { readOnly: true, timeout: 2000 });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
      const schema = Number(database.prepare('SELECT COALESCE(MAX(version),0) version FROM schema_version').get().version);
      if (schema < 13) return { verified: false, reasons: ['TELEMETRY_SCHEMA_13_REQUIRED'], schema_version: schema };
      const rows = database.prepare('SELECT * FROM ocean_run_lineage_v1 WHERE run_id=?').all(run.id);
      if (rows.length !== 1) return { verified: false, reasons: ['EXACT_TELEMETRY_RUN_LINEAGE_REQUIRED'], schema_version: schema };
      const lineage = rows[0];
      const reasons = [];
      const physicalBinding = this.physicalStrategyBinding(run, context, plan, lineage);
      const expectedDatasetId = `${context.dataset_manifest_id}:${context.dataset_manifest_revision}`;
      if (lineage.strategy_id !== run.strategy_id
        || !lineage.strategy_version
        || lineage.context_hash !== context.context_hash
        || lineage.dataset_id !== expectedDatasetId
        || lineage.dataset_role !== context.dataset_partition
        || lineage.strategy_profile_id !== context.strategy_profile_id
        || lineage.strategy_profile_version !== context.strategy_profile_version
        || lineage.strategy_code_hash !== context.strategy_code_hash
        || lineage.strategy_config_hash !== context.strategy_config_hash) reasons.push('TELEMETRY_RUN_CONTEXT_SCOPE_CONFLICT');
      if (!physicalBinding.verified) reasons.push(physicalBinding.reason);
      if (lineage.run_lifecycle_status !== 'closed') reasons.push('TELEMETRY_RUN_NOT_CLOSED');
      if (lineage.run_context_status !== 'complete') reasons.push('TELEMETRY_RUN_CONTEXT_INCOMPLETE');
      if (Number(lineage.open_trade_count) !== 0) reasons.push('TELEMETRY_OPEN_TRADES');
      if (Number(lineage.attempt_count) <= 0) reasons.push('TELEMETRY_RUN_ATTEMPT_MISSING');
      if (Number(lineage.attempt_receipt_count) !== Number(lineage.attempt_count)) reasons.push('TELEMETRY_RUN_RECEIPT_MISSING');
      const attemptQualification = this.attemptReceiptQualification(database, run.id, lineage);
      if (!attemptQualification.verified) reasons.push(attemptQualification.reason);
      if (Number(lineage.causal_row_count) !== Number(lineage.closed_trade_count)
        || Number(lineage.complete_causal_row_count) !== Number(lineage.closed_trade_count)) reasons.push('TELEMETRY_CAUSAL_COVERAGE_INCOMPLETE');
      const acceptedQualification = lineage.telemetry_qualification_status === 'TELEMETRY_COMPLETE_COVERAGE_UNVERIFIED'
        || (lineage.telemetry_qualification_status === 'RUN_RECEIPT_PARTIAL' && attemptQualification.verified);
      if (!acceptedQualification) reasons.push(lineage.telemetry_qualification_status || 'TELEMETRY_QUALIFICATION_FAILED');
      const causalRows = database.prepare(`SELECT trade_id,entry_datetime,direction,net_profit_loss,exit_causality,context_status,quality_flags,
        setup_family,session_name,regime_label,volatility_label,vwap_distance_points,initial_risk_points,
        continuation_state,exhaustion_state,exhaustion_score,quality_scaler_distance_atr,price_change_60m,
        price_change_120m,vwap_slope_60m,atr_change_60m_pct,mfe_points,mae_points
        FROM ocean_trade_causal_v2 WHERE run_id=? AND lower(status)='closed' ORDER BY trade_id`).all(run.id);
      if (causalRows.some(row => row.context_status !== 'complete'
        || criticalCausalQualityFlags(row.quality_flags).length > 0)) reasons.push('TELEMETRY_CAUSAL_ROWS_NOT_CLEAN');
      return {
        verified: reasons.length === 0,
        reasons,
        schema_version: schema,
        contract: 'telemetry-causal-export/v3',
        telemetry_qualification_status: lineage.telemetry_qualification_status,
        attempt_qualification: attemptQualification,
        physical_strategy_binding: physicalBinding,
        completion_binding: {
          run_id: run.id,
          receipt_sha256: fileHash(receiptFile),
          completed_at_utc: asOfUtc(receipt.completed_at_utc, asOfUtc(receipt.end_exclusive_utc)),
          declared_coverage_bound: true,
          ocean_market_coverage_verified: summary.completion_current === true && summary.completion.status === 'COMPLETED',
        },
        lineage: Object.fromEntries(Object.entries(lineage).filter(([key]) => !['created_utc', 'updated_utc'].includes(key))),
        causal_summary: causalSummary(causalRows),
      };
    } catch (error) {
      return { verified: false, reasons: [safeError(error)] };
    } finally { database?.close(); }
  }

  classification(run) {
    const context = JSON.parse(run.context_json);
    const reasons = [];
    if (run.id.startsWith('test-')) reasons.push('TEST_RUN');
    if (run.state !== 'COMPLETED') reasons.push('RUN_NOT_COMPLETED');
    if (this.strategyId && run.strategy_id !== this.strategyId) reasons.push('OUTSIDE_CONFIGURED_STRATEGY');
    const expectedPartition = ELIGIBLE.get(context.learner_permission);
    if (!expectedPartition) reasons.push('LEARNER_PERMISSION_DENIED');
    else if (context.dataset_partition !== expectedPartition) reasons.push('PARTITION_PERMISSION_MISMATCH');
    const planRow = this.db.prepare('SELECT payload_json FROM ow_run_plans WHERE id=?').get(run.id);
    const plan = planRow ? parse(planRow) : null;
    if (!plan?.operational_review) reasons.push('OPERATIONAL_REVIEW_REQUIRED');
    if (!this.db.prepare('SELECT run_id FROM ow_operational_releases WHERE run_id=? AND context_hash=?').get(run.id, context.context_hash)) reasons.push('OPERATIONAL_RELEASE_REQUIRED');
    const summary = plan ? this.backend.runs.summary(run, plan) : null;
    if (!summary?.completion_current || summary.completion?.status !== 'COMPLETED') reasons.push('CURRENT_COMPLETION_RECEIPT_REQUIRED');
    if (summary && (summary.open_pins || summary.unresolved_records || summary.progress?.pending_events
      || summary.progress?.gaps?.length || summary.progress?.failures?.length)) reasons.push('UNRESOLVED_OR_INCOMPLETE_EVIDENCE');
    const telemetry = this.telemetryQualification(run, context, plan, summary);
    if (!telemetry.verified) reasons.push(...telemetry.reasons);
    return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], context, plan, summary, telemetry };
  }

  evidencePolicy(strategyId) {
    const strategyRow = this.db.prepare('SELECT profile_id,payload_json FROM ow_strategies WHERE id=?').get(strategyId);
    requireThat(strategyRow?.profile_id, 409, 'STRATEGY_EVIDENCE_PROFILE_REQUIRED');
    const strategy = parse(strategyRow);
    const profileRow = this.db.prepare('SELECT payload_json FROM ow_profiles WHERE id=?').get(strategyRow.profile_id);
    requireThat(profileRow, 409, 'STRATEGY_EVIDENCE_PROFILE_REQUIRED');
    const profile = parse(profileRow);
    const policy = profile.evidence_policy || {};
    requireThat(policy.status === 'APPROVED'
      && Number.isInteger(policy.minimum_comparable_trades) && policy.minimum_comparable_trades > 0
      && Number.isInteger(policy.minimum_independent_sessions) && policy.minimum_independent_sessions > 0
      && Number(policy.maximum_data_quality_issues) === 0, 409, 'APPROVED_EVIDENCE_POLICY_REQUIRED');
    return {
      project: profile.owner_project || strategyId,
      strategy_name: strategy.strategy_name,
      minimum_sample_count: policy.minimum_comparable_trades,
      minimum_independent_session_count: policy.minimum_independent_sessions,
    };
  }

  legacyTelemetrySummary(runId) {
    if (!this.telemetryDb || !fs.existsSync(this.telemetryDb)) return { trades: 0, independent_sessions: 0 };
    let database;
    try {
      database = new DatabaseSync(this.telemetryDb, { readOnly: true, timeout: 2000 });
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
      const rows = database.prepare("SELECT entry_datetime FROM trades WHERE run_id=? AND lower(status)='closed'").all(runId);
      return {
        trades: rows.length,
        independent_sessions: new Set(rows.map(row => Math.trunc(Number(row.entry_datetime))).filter(Number.isFinite)).size,
      };
    } catch { return { trades: 0, independent_sessions: 0 }; }
    finally { database?.close(); }
  }

  runSummary(run, classification, policy) {
    const rows = this.db.prepare('SELECT event_id,canonical_id,payload_json FROM ow_evidence_revisions WHERE run_id=? ORDER BY id').all(run.id);
    const metrics = evidenceSummary(rows);
    const legacy = this.legacyTelemetrySummary(run.id);
    const causal = classification.telemetry?.causal_summary;
    const observedSampleCount = causal?.trades ?? Math.max(metrics.trades, legacy.trades);
    const independentSessionCount = causal?.independent_sessions ?? legacy.independent_sessions;
    const completion = classification.summary?.completion;
    const endUtc = completion?.requested_coverage?.at(-1)?.end_utc;
    const sourceRecordIds = [...new Set([
      `ocean-run:${run.id}`,
      ...rows.map(row => `${run.id}:${row.event_id}`),
      ...(classification.telemetry?.completion_binding?.receipt_sha256
        ? [`completion-receipt:${classification.telemetry.completion_binding.receipt_sha256}`] : []),
    ])].sort();
    const enough = observedSampleCount >= policy.minimum_sample_count
      && independentSessionCount >= policy.minimum_independent_session_count;
    const conflicting = classification.reasons.some(reason => reason.includes('CONFLICT'));
    return {
      summary: {
        run_id: run.id,
        context_hash: classification.context.context_hash,
        completion_hash: completion ? objectHash(completion) : objectHash({ run_id: run.id, state: run.state, revision: run.revision }),
        source_record_ids: sourceRecordIds,
        dataset_role: DATASET_ROLES.has(classification.context.dataset_partition) ? classification.context.dataset_partition : 'NOT_ELIGIBLE',
        learner_permission: LEARNER_PERMISSION.get(classification.context.learner_permission) || 'NONE',
        evidence_status: conflicting ? 'CONFLICTING' : enough ? 'SUFFICIENT' : 'INSUFFICIENT',
        observed_sample_count: observedSampleCount,
        independent_session_count: independentSessionCount,
        as_of_utc: classification.telemetry?.completion_binding?.completed_at_utc || asOfUtc(endUtc),
      },
      metrics,
      telemetry: classification.telemetry,
    };
  }

  evidenceIdentity(run, classification) {
    const context = classification.context;
    const requestedCoverage = classification.summary?.completion?.requested_coverage || [];
    return objectHash({
      strategy_id: run.strategy_id,
      strategy_version: context.strategy_version,
      strategy_code_hash: context.strategy_code_hash,
      strategy_config_hash: context.strategy_config_hash,
      strategy_profile_id: context.strategy_profile_id,
      strategy_profile_version: context.strategy_profile_version,
      execution_instance_id: context.execution_instance_id,
      source_installation_id: context.source_installation_id,
      expected_environment: context.expected_environment,
      evidence_purpose: context.evidence_purpose,
      dataset_manifest_id: context.dataset_manifest_id,
      dataset_manifest_revision: context.dataset_manifest_revision,
      dataset_manifest_hash: context.dataset_manifest_hash,
      dataset_partition: context.dataset_partition,
      learner_permission: context.learner_permission,
      requested_coverage: requestedCoverage,
    });
  }

  cohort(triggerRun) {
    const trigger = this.classification(triggerRun);
    requireThat(trigger.eligible, 409, trigger.reasons[0] || 'OPERATIONAL_LEARNING_NOT_ELIGIBLE');
    const policy = this.evidencePolicy(triggerRun.strategy_id);
    const eligibleByEvidence = new Map();
    const excludedEvidence = [];
    const diagnostics = [];
    for (const run of this.db.prepare('SELECT * FROM ow_runs WHERE strategy_id=? ORDER BY rowid').all(triggerRun.strategy_id)) {
      const value = this.classification(run);
      if (run.state !== 'COMPLETED') continue;
      const item = this.runSummary(run, value, policy);
      if (!value.eligible) {
        excludedEvidence.push({
          ...item.summary,
          exclusion_reason_code: value.reasons[0] || 'NOT_ELIGIBLE',
          exclusion_reason: (value.reasons.length ? value.reasons : ['NOT_ELIGIBLE']).join('; ').slice(0, 1000),
        });
        diagnostics.push({ run_id: run.id, eligible: false, reasons: value.reasons, metrics: item.metrics, telemetry: item.telemetry });
        continue;
      }
      const evidenceIdentity = this.evidenceIdentity(run, value);
      const previous = eligibleByEvidence.get(evidenceIdentity);
      if (previous) {
        excludedEvidence.push({
          ...previous.item.summary,
          exclusion_reason_code: 'SUPERSEDED_BY_LATEST_EXACT_COVERAGE',
          exclusion_reason: `SUPERSEDED_BY_LATEST_EXACT_COVERAGE:${run.id}`,
        });
        const previousDiagnostic = diagnostics.find(entry => entry.run_id === previous.run.id);
        if (previousDiagnostic) {
          previousDiagnostic.eligible = false;
          previousDiagnostic.reasons = ['SUPERSEDED_BY_LATEST_EXACT_COVERAGE'];
          previousDiagnostic.superseded_by_run_id = run.id;
        }
      }
      eligibleByEvidence.set(evidenceIdentity, { run, item });
      diagnostics.push({
        run_id: run.id,
        eligible: true,
        reasons: [],
        evidence_identity: evidenceIdentity,
        metrics: item.metrics,
        telemetry: item.telemetry,
      });
    }
    const eligibleRuns = [...eligibleByEvidence.values()].map(value => value.item.summary);
    requireThat(eligibleRuns.some(value => value.run_id === triggerRun.id), 409, 'TRIGGER_RUN_NOT_IN_ELIGIBLE_COHORT');
    eligibleRuns.sort((left, right) => left.run_id.localeCompare(right.run_id));
    excludedEvidence.sort((left, right) => left.run_id.localeCompare(right.run_id));
    const observedSampleCount = eligibleRuns.reduce((sum, value) => sum + value.observed_sample_count, 0);
    const independentSessionCount = eligibleRuns.reduce((sum, value) => sum + value.independent_session_count, 0);
    const confidence = Math.max(0, Math.min(100, Math.round(100 * Math.min(
      observedSampleCount / policy.minimum_sample_count,
      independentSessionCount / policy.minimum_independent_session_count,
    ))));
    const evidenceStatus = observedSampleCount >= policy.minimum_sample_count
      && independentSessionCount >= policy.minimum_independent_session_count ? 'SUFFICIENT' : 'INSUFFICIENT';
    const sourceRecordIds = [...new Set(eligibleRuns.flatMap(value => value.source_record_ids))].sort();
    return {
      cohort: {
        eligible_runs: eligibleRuns,
        aggregate: {
          eligible_run_count: eligibleRuns.length,
          observed_sample_count: observedSampleCount,
          independent_session_count: independentSessionCount,
          minimum_sample_count: policy.minimum_sample_count,
          minimum_independent_session_count: policy.minimum_independent_session_count,
          confidence,
          uncertainty: 100 - confidence,
          evidence_status: evidenceStatus,
          source_record_ids: sourceRecordIds,
          aggregate_sha256: objectHash(eligibleRuns),
        },
      },
      excluded_evidence: excludedEvidence,
      diagnostics,
      policy,
    };
  }

  resultFor(runId, registryRecordSha256 = null) {
    const rows = this.db.prepare('SELECT * FROM ow_operational_brain_results WHERE run_id=? ORDER BY rowid DESC').all(runId);
    for (const row of rows) {
      const result = parse(row);
      let details = null;
      try { details = result?.content ? JSON.parse(result.content) : null; } catch {}
      if (registryRecordSha256 && details?.registry_record_sha256 !== registryRecordSha256) continue;
      const callbackRow = this.db.prepare('SELECT payload_json FROM ow_operational_brain_callbacks WHERE result_id=?').get(result.result_id);
      return { result, details, callback: callbackRow ? parse(callbackRow) : null };
    }
    return null;
  }

  statusForRun(runId) {
    const run = this.db.prepare('SELECT * FROM ow_runs WHERE id=?').get(runId);
    if (!run) return null;
    const classification = this.classification(run);
    const currentFingerprint = this.registryContext?.record_sha256 || null;
    const stored = this.resultFor(runId, currentFingerprint);
    const latest = stored || this.resultFor(runId);
    const details = stored?.details || latest?.details || null;
    const stage = stored?.callback?.status === 'COMPLETED' ? 'COMPLETE'
      : stored?.callback?.status === 'FAILED' ? 'FAILED'
        : stored?.result ? 'BRAIN_RECORDED'
          : classification.eligible && latest?.result && currentFingerprint ? 'PENDING_REANALYSIS'
            : classification.eligible ? 'PENDING' : 'NOT_DUE';
    return {
      stage,
      eligible: classification.eligible,
      reasons: classification.reasons,
      result_id: stored?.result?.result_id || latest?.result?.result_id || null,
      brain_record_id: details?.record_id || null,
      conclusion_type: details?.conclusion_type || null,
      callback_status: stored?.callback?.status || null,
      registry_reconciliation_id: this.registryContext?.reconciliation_id || details?.registry_reconciliation_id || null,
      registry_record_sha256: currentFingerprint || details?.registry_record_sha256 || null,
      continuation_case_id: details?.continuation?.case_id || null,
      continuation_artifact_id: details?.continuation?.artifact_id || null,
      next_action: details?.continuation?.next_action || details?.next_action || null,
      last_error: this.retry.get(`${runId}:${currentFingerprint || 'unbound'}`)?.error || null,
    };
  }

  status() {
    const rows = this.db.prepare("SELECT * FROM ow_runs WHERE id NOT LIKE 'test-%' ORDER BY rowid DESC").all()
      .filter(row => !this.strategyId || row.strategy_id === this.strategyId);
    const items = rows.map(row => ({ run_id: row.id, ...this.statusForRun(row.id) }));
    return {
      enabled: this.enabled,
      state: !this.enabled ? 'DISABLED' : this.lastError ? 'DEGRADED' : this.identityVerified ? 'READY' : 'STARTING',
      strategy_id: this.strategyId,
      pending: items.filter(item => ['PENDING', 'PENDING_REANALYSIS'].includes(item.stage)).length,
      complete: items.filter(item => item.stage === 'COMPLETE').length,
      failed: items.filter(item => item.stage === 'FAILED').length,
      last_success_utc: this.lastSuccessUtc,
      last_error: this.lastError,
      registry: this.registryContext,
      items,
    };
  }

  pendingRun(registry) {
    const now = Date.now();
    return this.db.prepare("SELECT * FROM ow_runs WHERE state='COMPLETED' AND id NOT LIKE 'test-%' ORDER BY rowid").all()
      .find(run => (!this.strategyId || run.strategy_id === this.strategyId)
        && this.classification(run).eligible
        && this.resultFor(run.id, registry.record_sha256)?.callback?.status !== 'COMPLETED'
        && (this.retry.get(`${run.id}:${registry.record_sha256}`)?.nextAttemptMs || 0) <= now) || null;
  }

  ensureContinuation(run, actor, result, details) {
    if (details?.conclusion_type !== 'RECOMMENDATION') return null;
    requireThat(details.recommendation && details.continuation, 503, 'OPERATIONAL_LEARNING_RECOMMENDATION_METADATA_MISSING');
    return this.backend.createOperationalLearningContinuation(actor, {
      case_id: details.continuation.case_id,
      artifact_id: details.continuation.artifact_id,
      run_id: run.id,
      context_hash: result.context_hash,
      result_id: result.result_id,
      brain_record_id: details.record_id,
      registry_reconciliation_id: details.registry_reconciliation_id,
      registry_record_sha256: details.registry_record_sha256,
      recommendation: details.recommendation,
    });
  }

  async process(run, token, registry) {
    const classification = this.classification(run);
    const cohortBundle = this.cohort(run);
    const triggerSummary = cohortBundle.cohort.eligible_runs.find(value => value.run_id === run.id);
    const fingerprint = continuationSuffix(run.id, registry.record_sha256);
    const eventId = `learning-event:${run.id}:${fingerprint}`;
    const jobId = `learning-job:${run.id}:${fingerprint}`;
    const input = {
      schema_version: REQUEST_VERSION,
      project: cohortBundle.policy.project,
      case_id: caseIdFor(run.id, registry.record_sha256),
      strategy_id: run.strategy_id,
      strategy_name: cohortBundle.policy.strategy_name,
      strategy_profile_id: classification.context.strategy_profile_id,
      strategy_version: classification.context.strategy_version,
      execution_instance_id: classification.context.execution_instance_id,
      registry_reconciliation_id: registry.reconciliation_id,
      registry_record_sha256: registry.record_sha256,
      dataset_manifest_hash: classification.context.dataset_manifest_hash,
      trigger: {
        run_id: run.id,
        context_hash: classification.context.context_hash,
        completion_hash: objectHash(classification.summary.completion),
      },
      cohort: cohortBundle.cohort,
      excluded_evidence: cohortBundle.excluded_evidence,
      correlation: { event_id: eventId, job_id: jobId },
      proposed_recommendation: cumulativeLearningProposal(cohortBundle),
    };
    const inputHash = objectHash(input);
    input.correlation.input_sha256 = inputHash;
    const actor = this.brainActor(run.strategy_id, run.instance_id);
    const existing = this.resultFor(run.id, registry.record_sha256);
    let result = existing?.result || null;
    let storedDetails = existing?.details || null;
    if (!result) {
      const response = await this.call(this.path, token, input);
      const requiredRunIds = [
        ...cohortBundle.cohort.eligible_runs.map(value => value.run_id),
        ...cohortBundle.excluded_evidence.map(value => value.run_id),
      ];
      let brainContent = null;
      try { brainContent = JSON.parse(response?.content || ''); } catch {}
      requireThat(response?.schema_version === RESPONSE_VERSION
        && response.record_id && response.relative_path
        && typeof response.content === 'string'
        && digest(response.content) === response.content_sha256
        && ['RECOMMENDATION', 'NO_CHANGE', 'BLOCKED'].includes(response.conclusion_type)
        && Array.isArray(response.source_record_ids)
        && requiredRunIds.every(runId => response.source_record_ids.includes(runId))
        && objectHash(response.correlation) === objectHash(input.correlation)
        && brainContent?.registry_reconciliation_id === registry.reconciliation_id
        && brainContent?.registry_record_sha256 === registry.record_sha256, 503, 'OPERATIONAL_LEARNING_BRAIN_RESPONSE_INVALID');
      const recommendation = response.conclusion_type === 'RECOMMENDATION'
        ? brainContent?.conclusion?.recommendation : null;
      requireThat(response.conclusion_type !== 'RECOMMENDATION'
        || (typeof recommendation?.title === 'string' && typeof recommendation?.content === 'string'), 503, 'OPERATIONAL_LEARNING_RECOMMENDATION_INVALID');
      const reasons = Array.isArray(brainContent?.conclusion?.reasons)
        ? brainContent.conclusion.reasons.map(value => String(value).slice(0, 1000)) : [];
      const continuation = recommendation ? {
        case_id: caseIdFor(run.id, registry.record_sha256),
        artifact_id: artifactIdFor(run.id, registry.record_sha256),
        next_action: 'Strategy Research evaluation queued; no candidate or trading permission was created.',
      } : null;
      storedDetails = {
        schema_version: RESPONSE_VERSION,
        record_id: response.record_id,
        relative_path: response.relative_path,
        conclusion_type: response.conclusion_type,
        reasons,
        recommendation,
        continuation,
        next_action: continuation?.next_action || reasons.join('; ') || 'Continue collecting eligible evidence.',
        registry_reconciliation_id: registry.reconciliation_id,
        registry_record_sha256: registry.record_sha256,
        storage_mode: 'BRAIN_IMMUTABLE_REFERENCE',
        verified_run_ids: requiredRunIds,
        source_record_count: response.source_record_ids.length,
        source_record_ids_sha256: objectHash(response.source_record_ids),
        brain_content_sha256: response.content_sha256,
        brain_content_bytes: Buffer.byteLength(response.content, 'utf8'),
      };
      const storedContent = JSON.stringify(storedDetails);
      result = this.backend.operationalResults.register(actor, {
        run_id: run.id,
        context_hash: classification.context.context_hash,
        content: storedContent,
        content_sha256: digest(storedContent),
        correlation: input.correlation,
      });
    }
    const callback = this.backend.operationalResults.callback(actor, {
      run_id: run.id,
      context_hash: classification.context.context_hash,
      result_id: result.result_id,
      result_sha256: result.content_sha256,
      status: 'COMPLETED',
      correlation: result.correlation,
    });
    const continuation = this.ensureContinuation(run, actor, result, storedDetails);
    this.backend.event(run.id, 'operational.learning.complete', actor, {
      result_id: result.result_id,
      callback_status: callback.status,
      cohort_run_ids: cohortBundle.cohort.eligible_runs.map(value => value.run_id),
      excluded_run_ids: cohortBundle.excluded_evidence.map(value => value.run_id),
      cohort_hash: objectHash(cohortBundle.cohort),
      trigger_evidence_status: triggerSummary.evidence_status,
      registry_reconciliation_id: registry.reconciliation_id,
      registry_record_sha256: registry.record_sha256,
      continuation_case_id: continuation?.case_id || null,
      continuation_artifact_id: continuation?.artifact_id || null,
      automatic_strategy_change: false,
    });
    this.retry.delete(`${run.id}:${registry.record_sha256}`);
    this.lastSuccessUtc = new Date().toISOString();
    this.lastError = null;
    return this.statusForRun(run.id);
  }

  fail(run, error) {
    const key = `${run.id}:${this.registryContext?.record_sha256 || 'unbound'}`;
    const previous = this.retry.get(key) || { attempts: 0, error: null };
    const attempts = previous.attempts + 1;
    const message = safeError(error);
    this.retry.set(key, { attempts, error: message, nextAttemptMs: Date.now() + Math.min(300000, 1000 * 2 ** attempts) });
    if (previous.error !== message) this.backend.event(run.id, 'operational.learning.retry', { id: 'ocean-operational-learning', role: 'BRAIN' }, { attempts, error: message });
    this.lastError = message;
  }

  async flushOnce() {
    if (!this.enabled || this.running) return this.status();
    this.running = true;
    try {
      const token = this.token();
      await this.verifyIdentity(token);
      const registry = await this.registry(token);
      let run;
      while ((run = this.pendingRun(registry))) {
        try { await this.process(run, token, registry); }
        catch (error) { this.fail(run, error); break; }
      }
      return this.status();
    } finally { this.running = false; }
  }
}
