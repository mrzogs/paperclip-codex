CREATE TABLE ow_operational_brain_results (
  id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE ow_operational_brain_callbacks (
  result_id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  FOREIGN KEY(result_id) REFERENCES ow_operational_brain_results(id)
);

CREATE TRIGGER ow_operational_brain_results_no_update BEFORE UPDATE ON ow_operational_brain_results BEGIN SELECT RAISE(ABORT,'immutable operational brain result'); END;
CREATE TRIGGER ow_operational_brain_results_no_delete BEFORE DELETE ON ow_operational_brain_results BEGIN SELECT RAISE(ABORT,'immutable operational brain result'); END;
CREATE TRIGGER ow_operational_brain_callbacks_no_update BEFORE UPDATE ON ow_operational_brain_callbacks BEGIN SELECT RAISE(ABORT,'immutable operational brain callback'); END;
CREATE TRIGGER ow_operational_brain_callbacks_no_delete BEFORE DELETE ON ow_operational_brain_callbacks BEGIN SELECT RAISE(ABORT,'immutable operational brain callback'); END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(8, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
