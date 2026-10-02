CREATE TABLE ow_operational_release_requests (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE ow_operational_release_receipts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TRIGGER ow_operational_release_requests_no_update
BEFORE UPDATE ON ow_operational_release_requests BEGIN
  SELECT RAISE(ABORT,'immutable operational release request');
END;

CREATE TRIGGER ow_operational_release_requests_no_delete
BEFORE DELETE ON ow_operational_release_requests BEGIN
  SELECT RAISE(ABORT,'immutable operational release request');
END;

CREATE TRIGGER ow_operational_release_receipts_no_update
BEFORE UPDATE ON ow_operational_release_receipts BEGIN
  SELECT RAISE(ABORT,'immutable operational release receipt');
END;

CREATE TRIGGER ow_operational_release_receipts_no_delete
BEFORE DELETE ON ow_operational_release_receipts BEGIN
  SELECT RAISE(ABORT,'immutable operational release receipt');
END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(7, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
