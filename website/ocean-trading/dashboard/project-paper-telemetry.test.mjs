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
    CREATE TABLE trades (trade_id INTEGER, trade_account TEXT, status TEXT);
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.26');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-01 14:45:00', '2026-10-01 14:45:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-01 14:45:00');
  `);
  db.close();

  const status = readProjectPaperTelemetry(file, { nowMs: Date.parse("2026-10-01T14:45:30Z") });
  assert.equal(status.status, "active");
  assert.equal(status.healthy, true);
  assert.equal(status.account, "Sim1");
  assert.equal(status.symbol, "MNQZ26_FUT_CME");
  assert.equal(status.loggerVersion, "v0.5.26");
  assert.deepEqual(status.counts, { accountSnapshots: 1, orders: 0, fills: 0, trades: 0, openTrades: 0, legacyOpenTrades: 0 });
  assert.match(status.isolation, /not merged/i);
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
    CREATE TABLE trades (trade_id INTEGER, trade_account TEXT, status TEXT);
    INSERT INTO sierra_instance VALUES ('PaperTrading_CICD_VWAP_Pullback', 'paper');
    INSERT INTO logger_health VALUES (1, 'logger_started version=v0.5.29');
    INSERT INTO account_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'paper', 'Sim1', 'simulation', 1, '2026-10-02 15:30:00', '2026-10-02 15:30:00');
    INSERT INTO instrument_snapshot VALUES (1, 'PaperTrading_CICD_VWAP_Pullback', 'Sim1', 'MNQZ26_FUT_CME', '2026-10-02 15:30:00');
    INSERT INTO trades VALUES (3, 'Sim4', 'open');
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

test("reports a missing database without changing another ledger", () => {
  const status = readProjectPaperTelemetry(path.join(os.tmpdir(), "missing-ocean-paper.sqlite"));
  assert.equal(status.status, "missing");
  assert.equal(status.healthy, false);
});
