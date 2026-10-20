import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { readProjectPaperTelemetry } from "./project-paper-telemetry.mjs";

test("reports an active isolated Paper telemetry database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-paper-telemetry-"));
  const file = path.join(dir, "paper.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sierra_instance (instance_name TEXT, instance_role TEXT);
    CREATE TABLE logger_health (health_id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE account_snapshot (
      account_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT, instance_role TEXT,
      trade_account TEXT, account_type_guess TEXT, is_simulated INTEGER,
      snapshot_utc TEXT, created_utc TEXT
    );
    CREATE TABLE instrument_snapshot (
      instrument_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT,
      trade_account TEXT, symbol TEXT, created_utc TEXT
    );
    CREATE TABLE orders (id INTEGER);
    CREATE TABLE fills (id INTEGER);
    CREATE TABLE trades (
      trade_id INTEGER, instance_name TEXT, trade_account TEXT, account_type_guess TEXT,
      is_simulated INTEGER, symbol TEXT, instrument TEXT, contract TEXT,
      strategy_id TEXT, strategy_name TEXT, strategy_version TEXT, attribution_confidence TEXT,
      direction TEXT, status TEXT, entry_datetime TEXT, exit_datetime TEXT,
      initial_quantity REAL, max_quantity REAL, final_quantity REAL,
      average_entry_price REAL, average_exit_price REAL,
      initial_stop_price REAL, final_stop_price REAL,
      initial_target_price REAL, final_target_price REAL, exit_classification TEXT,
      gross_points REAL, gross_ticks REAL, gross_currency_value REAL,
      total_commission REAL, net_profit_loss REAL, profit_loss REAL,
      opening_order_id INTEGER, closing_order_id INTEGER, text_tag TEXT,
      order_action_source TEXT, created_utc TEXT, updated_utc TEXT
    );
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.26');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-01 14:45:00', '2026-10-01 14:45:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-01 14:45:00');
    INSERT INTO trades VALUES (
      1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'simulation', 1,
      'MNQZ26_FUT_CME', 'MNQZ26_FUT_CME', 'Z26',
      'cicd-vwap-pull-back-strategy', 'VWAP Pullback', 'v0.6.235', 'definite',
      'long', 'closed', NULL, NULL, 2, 2, 0, 30000, 30001,
      29900, 30000.5, 30600, 30600, 'stop', 1, 8, 4, 2.28, 1.72, 1.72,
      100, 102, 'VWAP Pullback Long', 'Trade simulation fill',
      '2026-10-01 14:40:00', '2026-10-01 14:44:00'
    );
    INSERT INTO trades VALUES (
      2, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'simulation', 1,
      'MNQZ26_FUT_CME', 'MNQZ26_FUT_CME', 'Z26',
      'cicd-vwap-pull-back-strategy', 'VWAP Pullback', 'v0.6.235', 'definite',
      'short', 'open', NULL, NULL, 1, 1, 1, 30005, NULL,
      30100, 30100, 29400, 29400, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      103, NULL, 'VWAP Pullback Short', 'Trade simulation fill',
      '2026-10-01 14:44:30', '2026-10-01 14:45:00'
    );
  `);
  db.close();

  const status = readProjectPaperTelemetry(file, { nowMs: Date.parse("2026-10-01T14:45:30Z") });
  assert.equal(status.status, "active");
  assert.equal(status.healthy, true);
  assert.equal(status.account, "Sim1");
  assert.equal(status.symbol, "MNQZ26_FUT_CME");
  assert.equal(status.loggerVersion, "v0.5.26");
  assert.deepEqual(status.counts, {
    accountSnapshots: 1,
    orders: 0,
    fills: 0,
    trades: 2,
    authoritativeTrades: 2,
    excludedTrades: 0,
    foreignAccountTrades: 0,
    openTrades: 1,
    legacyOpenTrades: 0,
    unattributedOpenTrades: 0,
  });
  assert.equal(status.closedTrades.length, 1);
  assert.equal(status.closedTrades[0].tradeId, "cicd-vwap-paper-sqlite-1");
  assert.equal(status.closedTrades[0].realizedPnlDollars, 1.72);
  assert.equal(status.openPositions.length, 1);
  assert.equal(status.openPositions[0].account, "Sim1");
  assert.equal(status.openPositions[0].strategyId, "cicd-vwap-pull-back-strategy");
  assert.equal(status.closedNetProfitLossDollars, 1.72);
  assert.match(status.isolation, /separate observed CICD VWAP Paper feed/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keeps a historical foreign-account trade visible as excluded audit evidence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-paper-telemetry-foreign-history-"));
  const file = path.join(dir, "paper.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sierra_instance (instance_name TEXT, instance_role TEXT);
    CREATE TABLE logger_health (health_id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE account_snapshot (
      account_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT, instance_role TEXT,
      trade_account TEXT, account_type_guess TEXT, is_simulated INTEGER,
      snapshot_utc TEXT, created_utc TEXT
    );
    CREATE TABLE instrument_snapshot (
      instrument_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT,
      trade_account TEXT, symbol TEXT, created_utc TEXT
    );
    CREATE TABLE orders (id INTEGER);
    CREATE TABLE fills (id INTEGER);
    CREATE TABLE trades (
      trade_id INTEGER, trade_account TEXT, is_simulated INTEGER, status TEXT,
      strategy_id TEXT, strategy_name TEXT, strategy_version TEXT,
      net_profit_loss REAL, created_utc TEXT, updated_utc TEXT
    );
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.33');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-20 18:45:00', '2026-10-20 18:45:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-20 18:45:00');
    INSERT INTO trades VALUES (49, 'Sim1', 1, 'closed', 'cicd-vwap-pull-back-strategy', 'VWAP Pullback', 'v0.6.238', -58.64, '2026-10-20 18:40:00', '2026-10-20 18:44:10');
    INSERT INTO trades VALUES (3, 'Sim4', 1, 'closed', 'cicd-vwap-pull-back-strategy', 'VWAP Pullback', 'v0.6.233', -145.14, '2026-10-02 13:44:56', '2026-10-02 20:31:07');
  `);
  db.close();

  const status = readProjectPaperTelemetry(file, { nowMs: Date.parse("2026-10-20T18:45:30Z") });
  assert.equal(status.status, "active");
  assert.equal(status.healthy, true);
  assert.equal(status.counts.trades, 2);
  assert.equal(status.counts.authoritativeTrades, 1);
  assert.equal(status.counts.excludedTrades, 1);
  assert.equal(status.counts.foreignAccountTrades, 1);
  assert.deepEqual(status.foreignAccounts, [{ account: "Sim4", count: 1 }]);
  assert.equal(status.closedTrades.length, 1);
  assert.equal(status.closedTrades[0].account, "Sim1");
  assert.equal(status.closedNetProfitLossDollars, -58.64);
  assert.match(status.warning, /Sim4 \(1\).*excluded from Sim1 trades and P&L/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("requires reconciliation for an open trade from a non-authoritative account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-paper-telemetry-orphan-"));
  const file = path.join(dir, "paper.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sierra_instance (instance_name TEXT, instance_role TEXT);
    CREATE TABLE logger_health (health_id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE account_snapshot (
      account_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT, instance_role TEXT,
      trade_account TEXT, account_type_guess TEXT, is_simulated INTEGER,
      snapshot_utc TEXT, created_utc TEXT
    );
    CREATE TABLE instrument_snapshot (
      instrument_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT,
      trade_account TEXT, symbol TEXT, created_utc TEXT
    );
    CREATE TABLE orders (id INTEGER);
    CREATE TABLE fills (id INTEGER);
    CREATE TABLE trades (trade_id INTEGER, trade_account TEXT, status TEXT, strategy_id TEXT, strategy_name TEXT, strategy_version TEXT);
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.29');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-02 15:30:00', '2026-10-02 15:30:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-02 15:30:00');
    INSERT INTO trades VALUES (3, 'Sim4', 'open', 'cicd-vwap-pull-back-strategy', 'VWAP Pullback', 'v0.6.233');
  `);
  db.close();

  const status = readProjectPaperTelemetry(file, { nowMs: Date.parse("2026-10-02T15:30:30Z") });
  assert.equal(status.status, "reconciliation_required");
  assert.equal(status.healthy, false);
  assert.equal(status.account, "Sim1");
  assert.equal(status.counts.openTrades, 1);
  assert.equal(status.counts.legacyOpenTrades, 1);
  assert.match(status.warning, /non-authoritative Paper account/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("requires attribution for an open authoritative-account trade without strategy identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-paper-telemetry-attribution-"));
  const file = path.join(dir, "paper.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sierra_instance (instance_name TEXT, instance_role TEXT);
    CREATE TABLE logger_health (health_id INTEGER PRIMARY KEY, message TEXT);
    CREATE TABLE account_snapshot (
      account_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT, instance_role TEXT,
      trade_account TEXT, account_type_guess TEXT, is_simulated INTEGER,
      snapshot_utc TEXT, created_utc TEXT
    );
    CREATE TABLE instrument_snapshot (
      instrument_snapshot_id INTEGER PRIMARY KEY, instance_name TEXT,
      trade_account TEXT, symbol TEXT, created_utc TEXT
    );
    CREATE TABLE orders (id INTEGER);
    CREATE TABLE fills (id INTEGER);
    CREATE TABLE trades (trade_id INTEGER, trade_account TEXT, status TEXT, strategy_id TEXT, strategy_name TEXT, strategy_version TEXT);
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.30');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-02 16:00:00', '2026-10-02 16:00:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-02 16:00:00');
    INSERT INTO trades VALUES (4, 'Sim1', 'open', NULL, NULL, NULL);
  `);
  db.close();

  const status = readProjectPaperTelemetry(file, { nowMs: Date.parse("2026-10-02T16:00:30Z") });
  assert.equal(status.status, "attribution_required");
  assert.equal(status.healthy, false);
  assert.equal(status.counts.openTrades, 1);
  assert.equal(status.counts.legacyOpenTrades, 0);
  assert.equal(status.counts.unattributedOpenTrades, 1);
  assert.match(status.warning, /lack the required strategy identity/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reports a missing database without changing another ledger", () => {
  const status = readProjectPaperTelemetry(path.join(os.tmpdir(), "missing-ocean-paper.sqlite"));
  assert.equal(status.status, "missing");
  assert.equal(status.healthy, false);
});
