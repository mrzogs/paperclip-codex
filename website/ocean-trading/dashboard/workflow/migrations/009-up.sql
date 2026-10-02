CREATE TABLE ow_operational_trade_events (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TRIGGER ow_operational_trade_events_no_update BEFORE UPDATE ON ow_operational_trade_events BEGIN SELECT RAISE(ABORT,'immutable operational trade event'); END;
CREATE TRIGGER ow_operational_trade_events_no_delete BEFORE DELETE ON ow_operational_trade_events BEGIN SELECT RAISE(ABORT,'immutable operational trade event'); END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(9, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
