import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from './common.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function normalizeSymbol(value) {
  return String(value || '').replace(/\[M\]$/, '');
}

function sierraDateTimeToUtc(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('SIERRA_DATETIME_REQUIRED');
  const result = new Date((number - 25569) * 86400000);
  if (!Number.isFinite(result.getTime())) fail('SIERRA_DATETIME_INVALID');
  return result.toISOString();
}

function inside(intervals, value) {
  return intervals.some(interval => interval.start_utc <= value && value < interval.end_utc);
}

function evidenceImage(workflowDb, runId) {
  const filename = path.join(path.dirname(workflowDb), 'evidence', `${runId}-sierra.png`);
  if (!fs.existsSync(filename)) return { ready: false, path: filename };
  const bytes = fs.readFileSync(filename);
  if (bytes.length < 64 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail('SIERRA_EVIDENCE_IMAGE_INVALID');
  return { ready: true, path: filename, hash: sha256(bytes), bytes: bytes.length };
}

function loadWorkflow(config, runId) {
  const db = new DatabaseSync(config.workflow_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    const run = db.prepare('SELECT * FROM ow_runs WHERE id=?').get(runId);
    const planRow = db.prepare('SELECT payload_json FROM ow_run_plans WHERE id=?').get(runId);
    if (!run || !planRow) fail('RUN_PLAN_REQUIRED');
    if (run.strategy_id !== config.strategy_id || run.instance_id !== config.instance_id) fail('RUN_SCOPE_MISMATCH');
    const context = JSON.parse(run.context_json);
    const plan = JSON.parse(planRow.payload_json);
    const pins = new Map(db.prepare('SELECT id,state FROM ow_trade_pins WHERE run_id=?').all(runId).map(row => [row.id, row.state]));
    const events = new Set(db.prepare('SELECT event_id FROM ow_evidence_revisions WHERE run_id=?').all(runId).map(row => row.event_id));
    return { run, context, plan, pins, events };
  } finally {
    db.close();
  }
}

function loadTelemetry(config, runId, workflow, screenshotHash) {
  const db = new DatabaseSync(config.telemetry_db, { readOnly: true, timeout: 2000 });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000;');
    const replay = db.prepare('SELECT * FROM replay_runs WHERE run_id=?').get(runId);
    if (!replay || replay.strategy_id !== config.strategy_id || replay.strategy_version !== config.expected_strategy_version || replay.instance_role !== 'replay') fail('REPLAY_BINDING_MISMATCH');
    const rows = db.prepare('SELECT * FROM trades WHERE run_id=? ORDER BY trade_id').all(runId);
    const actions = [];
    const canonicalKeys = new Set();
    let gross = 0;
    let net = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const trade of rows) {
      if (trade.instance_id !== replay.instance_id || trade.trade_account !== config.account_alias || Number(trade.is_simulated) !== 1 || normalizeSymbol(trade.symbol) !== config.expected_symbol) fail('TRADE_SCOPE_MISMATCH');
      if (String(trade.status).toLowerCase() !== 'closed' || Number(trade.final_quantity || 0) !== 0) fail('OPEN_TRADE_REJECTED');
      if (!trade.opening_order_id || !trade.closing_order_id) fail('ORDER_PROVENANCE_REQUIRED');
      const entryTime = sierraDateTimeToUtc(trade.entry_datetime);
      const exitTime = sierraDateTimeToUtc(trade.exit_datetime);
      if (entryTime > exitTime || !inside(workflow.plan.scored_intervals, exitTime)) fail('TRADE_OUTSIDE_SCORED_INTERVAL');
      const legs = db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY leg_id').all(trade.trade_id);
      if (legs.length < 2) fail('TRADE_LEGS_REQUIRED');
      const marketEventKeys = legs.map(leg => `sierra-leg:${leg.leg_id}:${leg.internal_order_id}:${leg.fill_datetime}:${leg.quantity}:${leg.fill_price}`);
      const idPrefix = config.schema_version === 'ocean-replay-run-bridge/v4' ? 'sierra' : 'test-sierra';
      const pinId = `${idPrefix}-trade-${trade.trade_id}`;
      const eventId = `${idPrefix}-event-${trade.trade_id}`;
      const legacyId = `${idPrefix}-legacy-${trade.trade_id}`;
      const direction = String(trade.direction || '').toUpperCase();
      if (!['LONG', 'SHORT'].includes(direction)) fail('TRADE_DIRECTION_REQUIRED');
      const sourceBundle = { trade, legs };
      const evidence = {
        run_id: runId,
        trade_id: pinId,
        event_id: eventId,
        legacy_trade_id: legacyId,
        symbol: config.expected_symbol,
        entry_time_utc: entryTime,
        exit_time_utc: exitTime,
        side: direction,
        entry_order_key: `sierra-order:${trade.opening_order_id}`,
        exit_order_key: `sierra-order:${trade.closing_order_id}`,
        market_event_keys: marketEventKeys,
        facts: {
          entry_price: Number(trade.average_entry_price),
          exit_price: Number(trade.average_exit_price),
          quantity: Number(trade.max_quantity || trade.initial_quantity),
          pnl: Number(trade.net_profit_loss),
          screenshot_hash: screenshotHash,
          analysis_hash: sha256(canonical(sourceBundle)),
        },
      };
      if (Object.values(evidence.facts).slice(0, 4).some(value => !Number.isFinite(value))) fail('TRADE_FACTS_REQUIRED');
      const key = canonical({ entry: evidence.entry_time_utc, exit: evidence.exit_time_utc, side: evidence.side, entry_order_key: evidence.entry_order_key, exit_order_key: evidence.exit_order_key });
      if (canonicalKeys.has(key)) fail('DUPLICATE_TRADE_PROVENANCE');
      canonicalKeys.add(key);
      const pinState = workflow.pins.get(pinId) || null;
      const eventExists = workflow.events.has(eventId);
      if (pinState === 'CLOSED' && !eventExists) fail('CLOSED_PIN_WITHOUT_EVIDENCE');
      if (!pinState) actions.push({ type: 'pin-open', data: { run_id: runId, trade_id: pinId, state: 'OPEN', context_hash: workflow.context.context_hash } });
      if (!eventExists) actions.push({ type: 'evidence', data: evidence });
      if (pinState !== 'CLOSED') actions.push({ type: 'pin-close', data: { run_id: runId, trade_id: pinId, state: 'CLOSED', context_hash: workflow.context.context_hash } });
      const pnl = Number(trade.net_profit_loss);
      gross += Number(trade.gross_currency_value || 0);
      net += pnl;
      if (pnl > 0) { wins += 1; grossProfit += pnl; }
      else if (pnl < 0) { losses += 1; grossLoss += Math.abs(pnl); }
      else breakeven += 1;
    }
    return {
      actions,
      metrics: {
        closed_trades: rows.length,
        gross_profit_loss: gross,
        net_profit_loss: net,
        wins,
        losses,
        breakeven,
        win_rate: rows.length ? wins / rows.length : 0,
        profit_factor: grossLoss ? grossProfit / grossLoss : (grossProfit ? null : 0),
      },
    };
  } finally {
    db.close();
  }
}

try {
  const configFile = process.argv[2];
  const runId = process.argv[3];
  if (!path.isAbsolute(configFile || '') || !RUN_ID.test(runId || '')) fail('CONFIG_AND_RUN_REQUIRED');
  const config = readJson(configFile);
  const workflow = loadWorkflow(config, runId);
  const image = evidenceImage(config.workflow_db, runId);
  if (!image.ready) {
    console.log(JSON.stringify({ schema_version: 'ocean-replay-evidence-plan/v1', status: 'AWAITING_SIERRA_EVIDENCE_IMAGE', run_id: runId, evidence_image: image.path }));
  } else {
    const telemetry = loadTelemetry(config, runId, workflow, image.hash);
    console.log(JSON.stringify({
      schema_version: 'ocean-replay-evidence-plan/v1',
      status: 'READY',
      run_id: runId,
      run_state: workflow.run.state,
      evidence_image: { path: image.path, sha256: image.hash, bytes: image.bytes },
      scored_intervals: workflow.plan.scored_intervals,
      watermark: workflow.plan.scored_intervals.at(-1).end_utc,
      ...telemetry,
    }));
  }
} catch (error) {
  if (process.env.OCEAN_REPLAY_EVIDENCE_DEBUG === '1') console.error(error.stack);
  console.error(JSON.stringify({ status: 'BLOCKED', error: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REPLAY_EVIDENCE_RECONCILIATION_FAILED' }));
  process.exitCode = 2;
}
