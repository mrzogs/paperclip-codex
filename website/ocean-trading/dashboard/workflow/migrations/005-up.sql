CREATE TABLE ow_integration_bindings (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TABLE ow_operational_pending (
  id TEXT PRIMARY KEY,
  strategy_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('SOURCE_FACTS','STRATEGY_FACTS','DATASET_MANIFEST')),
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TABLE ow_operational_receipts (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TRIGGER ow_operational_receipts_no_update BEFORE UPDATE ON ow_operational_receipts BEGIN SELECT RAISE(ABORT,'immutable operational receipt'); END;
CREATE TRIGGER ow_operational_receipts_no_delete BEFORE DELETE ON ow_operational_receipts BEGIN SELECT RAISE(ABORT,'immutable operational receipt'); END;
CREATE TRIGGER ow_integration_bindings_no_update BEFORE UPDATE ON ow_integration_bindings BEGIN SELECT RAISE(ABORT,'immutable integration binding'); END;
CREATE TRIGGER ow_integration_bindings_no_delete BEFORE DELETE ON ow_integration_bindings BEGIN SELECT RAISE(ABORT,'immutable integration binding'); END;
CREATE TRIGGER ow_operational_pending_no_update BEFORE UPDATE ON ow_operational_pending BEGIN SELECT RAISE(ABORT,'immutable pending evidence'); END;
CREATE TRIGGER ow_operational_pending_no_delete BEFORE DELETE ON ow_operational_pending BEGIN SELECT RAISE(ABORT,'immutable pending evidence'); END;
INSERT INTO ow_schema_migrations(version,applied_at_utc) VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
