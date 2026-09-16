CREATE TABLE ow_auth_state(id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL);
CREATE TABLE ow_auth_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  operator_id TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL
);
INSERT INTO ow_schema_migrations(version,applied_at_utc) VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
