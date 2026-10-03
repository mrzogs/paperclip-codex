import crypto from 'node:crypto';

export const VWAP_STRATEGY_ID = 'cicd-vwap-pull-back-strategy';
export const DEFAULT_VWAP_LEARNING_POLICY = Object.freeze({
  policy_version:'v1',
  minimum_comparable_trades:50,
  minimum_sessions:20,
  minimum_pattern_trades:8,
  adverse_loss_rate:0.60,
  adverse_net_pnl:0,
  threshold_source:'PREASSIGNED_POLICY_DISCOVERY_ONLY',
});

const DISCOVERY_ROLES = new Set(['DISCOVERY']);
const PAPER_ROLES = new Set(['PAPER', 'PAPER_ELIGIBLE']);
const FORBIDDEN_LEARNING_ROLES = new Set(['VALIDATION', 'PROTECTED_HOLDOUT', 'HOLDOUT', 'FORWARD', 'LIVE', 'LIVE_REAL']);
const keyFields = ['setup_id', 'session_name', 'side', 'regime_label', 'volatility_label', 'vwap_reclaim_state'];
const stable = value => value === null || value === undefined || value === '' ? 'UNKNOWN' : String(value);
const digest = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function numeric(value) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError('TRADE_NUMERIC_FIELD_INVALID');
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifyVwapLearningRows(rows, { strategyId = VWAP_STRATEGY_ID } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('TRADE_ROWS_REQUIRED');
  const accepted = [];
  const excluded = [];
  const blockers = [];
  for (const row of rows) {
    const tradeId = stable(row?.trade_id);
    const role = stable(row?.dataset_role).toUpperCase();
    const environment = stable(row?.environment).toUpperCase();
    if (row?.strategy_id !== strategyId) {
      blockers.push({ code:'STRATEGY_ID_MISMATCH', trade_id:tradeId });
      excluded.push({ trade_id:tradeId, reason:'STRATEGY_ID_MISMATCH' });
      continue;
    }
    if (environment === 'LIVE' || environment === 'LIVE_REAL' || FORBIDDEN_LEARNING_ROLES.has(role)) {
      excluded.push({ trade_id:tradeId, reason:`INELIGIBLE_${environment === 'LIVE' || environment === 'LIVE_REAL' ? environment : role}` });
      continue;
    }
    if (!DISCOVERY_ROLES.has(role) && !PAPER_ROLES.has(role)) {
      excluded.push({ trade_id:tradeId, reason:'DATASET_ROLE_NOT_ELIGIBLE' });
      continue;
    }
    accepted.push({ ...row, trade_id:tradeId, dataset_role:role, environment });
  }
  return { accepted, excluded, blockers };
}

export function evaluateVwapEvidenceSufficiency(rows, { policy = DEFAULT_VWAP_LEARNING_POLICY, strategyId = VWAP_STRATEGY_ID } = {}) {
  const classified = classifyVwapLearningRows(rows, { strategyId });
  const discovery = classified.accepted.filter(row => DISCOVERY_ROLES.has(row.dataset_role));
  const sessions = new Set(discovery.map(row => stable(row.session_id || row.trading_day || row.entry_date)).filter(value => value !== 'UNKNOWN'));
  const missingQuality = discovery.filter(row => row.telemetry_complete !== true || row.identity_verified !== true);
  const blockers = [...classified.blockers];
  if (discovery.length < policy.minimum_comparable_trades) blockers.push({ code:'INSUFFICIENT_DISCOVERY_TRADES', observed:discovery.length, required:policy.minimum_comparable_trades });
  if (sessions.size < policy.minimum_sessions) blockers.push({ code:'INSUFFICIENT_DISCOVERY_SESSIONS', observed:sessions.size, required:policy.minimum_sessions });
  if (missingQuality.length) blockers.push({ code:'TELEMETRY_OR_IDENTITY_GAPS', count:missingQuality.length, trade_ids:missingQuality.map(row => row.trade_id).sort() });
  return {
    sufficient:blockers.length === 0,
    policy_version:policy.policy_version,
    threshold_source:policy.threshold_source,
    discovery_trade_count:discovery.length,
    eligible_paper_trade_count:classified.accepted.length - discovery.length,
    discovery_session_count:sessions.size,
    excluded_count:classified.excluded.length,
    excluded:classified.excluded,
    blockers,
    discovery_rows:discovery,
  };
}

export function detectRecurringVwapFailures(rows, options = {}) {
  const policy = options.policy || DEFAULT_VWAP_LEARNING_POLICY;
  const sufficiency = evaluateVwapEvidenceSufficiency(rows, { ...options, policy });
  if (!sufficiency.sufficient) {
    return { disposition:'INSUFFICIENT_EVIDENCE', sufficiency, investigation_queue:[], source_trade_ids:[], analysis_hash:digest({ policy, blockers:sufficiency.blockers }) };
  }

  const groups = new Map();
  for (const row of sufficiency.discovery_rows) {
    const context = Object.fromEntries(keyFields.map(field => [field, stable(row[field])]));
    const contextKey = keyFields.map(field => context[field]).join('|');
    const current = groups.get(contextKey) || { context, trade_ids:[], pnls:[], mfe:[], mae:[] };
    current.trade_ids.push(row.trade_id);
    current.pnls.push(numeric(row.net_pnl));
    if (row.mfe !== undefined && row.mfe !== null) current.mfe.push(numeric(row.mfe));
    if (row.mae !== undefined && row.mae !== null) current.mae.push(numeric(row.mae));
    groups.set(contextKey, current);
  }

  const investigationQueue = [...groups.entries()].map(([contextKey, group]) => {
    const count = group.pnls.length;
    const lossCount = group.pnls.filter(value => value < 0).length;
    const netPnl = group.pnls.reduce((sum, value) => sum + value, 0);
    return {
      pattern_id:`vwap-pattern-${digest(contextKey).slice(7, 19)}`,
      context:group.context,
      trade_count:count,
      loss_count:lossCount,
      loss_rate:lossCount / count,
      net_pnl:netPnl,
      median_pnl:median(group.pnls),
      median_mfe:group.mfe.length ? median(group.mfe) : null,
      median_mae:group.mae.length ? median(group.mae) : null,
      source_trade_ids:group.trade_ids.sort(),
    };
  }).filter(pattern => pattern.trade_count >= policy.minimum_pattern_trades && pattern.loss_rate >= policy.adverse_loss_rate && pattern.net_pnl < policy.adverse_net_pnl)
    .sort((a, b) => a.net_pnl - b.net_pnl || b.trade_count - a.trade_count || a.pattern_id.localeCompare(b.pattern_id));

  const sourceTradeIds = [...new Set(investigationQueue.flatMap(item => item.source_trade_ids))].sort();
  const disposition = investigationQueue.length ? 'INVESTIGATE' : 'NO_CHANGE';
  return {
    disposition,
    sufficiency:{ ...sufficiency, discovery_rows:undefined },
    investigation_queue:investigationQueue,
    source_trade_ids:sourceTradeIds,
    candidate_created:false,
    next_action:disposition === 'INVESTIGATE'
      ? 'Perform causal review and competing-explanation checks before proposing any isolated candidate.'
      : 'Record NO_CHANGE and continue collecting eligible evidence.',
    analysis_hash:digest({ policy, disposition, investigationQueue }),
  };
}
