CREATE TABLE ow_test_declarations (
  id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL
);
CREATE TABLE ow_test_fixtures (
  id TEXT PRIMARY KEY, declaration_id TEXT NOT NULL REFERENCES ow_test_declarations(id),
  identity_id TEXT NOT NULL REFERENCES ow_identities(id), content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  state TEXT NOT NULL DEFAULT 'PREPARED', operator_id TEXT NOT NULL, created_at_utc TEXT NOT NULL
);
CREATE TABLE ow_test_receipts (
  id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES ow_identities(id),
  fixture_id TEXT NOT NULL REFERENCES ow_test_fixtures(id), message_id TEXT NOT NULL,
  operation TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL, byte_count INTEGER NOT NULL,
  UNIQUE(identity_id,message_id)
);
CREATE TABLE ow_test_conflicts (
  id INTEGER PRIMARY KEY, identity_id TEXT NOT NULL, fixture_id TEXT NOT NULL,
  message_id TEXT NOT NULL, payload_hash TEXT NOT NULL, occurred_at_utc TEXT NOT NULL
);
CREATE TRIGGER ow_test_declarations_no_update BEFORE UPDATE ON ow_test_declarations BEGIN SELECT RAISE(ABORT,'immutable test declaration'); END;
CREATE TRIGGER ow_test_declarations_no_delete BEFORE DELETE ON ow_test_declarations BEGIN SELECT RAISE(ABORT,'immutable test declaration'); END;
CREATE TRIGGER ow_test_receipts_no_update BEFORE UPDATE ON ow_test_receipts BEGIN SELECT RAISE(ABORT,'immutable test receipt'); END;
CREATE TRIGGER ow_test_receipts_no_delete BEFORE DELETE ON ow_test_receipts BEGIN SELECT RAISE(ABORT,'immutable test receipt'); END;
INSERT INTO ow_schema_migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
