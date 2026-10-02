CREATE TABLE ow_operational_decisions (
 id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, review_hash TEXT NOT NULL,
 scope TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE ow_operational_revocations (
 id TEXT PRIMARY KEY REFERENCES ow_operational_decisions(id), payload_json TEXT NOT NULL
);
CREATE TABLE ow_operational_releases (
 run_id TEXT PRIMARY KEY REFERENCES ow_runs(id), context_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL
);
CREATE TRIGGER ow_operational_decisions_no_update BEFORE UPDATE ON ow_operational_decisions BEGIN SELECT RAISE(ABORT,'immutable operational decision'); END;
CREATE TRIGGER ow_operational_decisions_no_delete BEFORE DELETE ON ow_operational_decisions BEGIN SELECT RAISE(ABORT,'immutable operational decision'); END;
CREATE TRIGGER ow_operational_revocations_no_update BEFORE UPDATE ON ow_operational_revocations BEGIN SELECT RAISE(ABORT,'immutable operational revocation'); END;
CREATE TRIGGER ow_operational_revocations_no_delete BEFORE DELETE ON ow_operational_revocations BEGIN SELECT RAISE(ABORT,'immutable operational revocation'); END;
CREATE TRIGGER ow_operational_releases_no_update BEFORE UPDATE ON ow_operational_releases BEGIN SELECT RAISE(ABORT,'immutable operational release'); END;
CREATE TRIGGER ow_operational_releases_no_delete BEFORE DELETE ON ow_operational_releases BEGIN SELECT RAISE(ABORT,'immutable operational release'); END;
INSERT INTO ow_schema_migrations(version,applied_at_utc) VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
