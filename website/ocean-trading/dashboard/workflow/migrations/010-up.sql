CREATE TABLE ow_onboarding_brain_outbox (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  milestone_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','DELIVERING','FAILED','ACKNOWLEDGED','DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL,
  lease_id TEXT,
  lease_until_ms INTEGER,
  brain_record_id TEXT,
  brain_relative_path TEXT,
  last_error TEXT,
  created_at_utc TEXT NOT NULL,
  acknowledged_at_utc TEXT
);

CREATE INDEX ow_onboarding_brain_due
ON ow_onboarding_brain_outbox(state,next_attempt_ms);

CREATE TABLE ow_onboarding_registrations (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL UNIQUE,
  source_fingerprint TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE ow_onboarding_activation_events (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('REPLAY','PAPER','LIVE')),
  action TEXT NOT NULL CHECK(action IN ('ACTIVATE','PAUSE','DEACTIVATE','EMERGENCY_STOP')),
  revision INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE(strategy_id,environment,revision)
);

CREATE TRIGGER ow_onboarding_registrations_no_update BEFORE UPDATE ON ow_onboarding_registrations BEGIN SELECT RAISE(ABORT,'immutable onboarding registration'); END;
CREATE TRIGGER ow_onboarding_registrations_no_delete BEFORE DELETE ON ow_onboarding_registrations BEGIN SELECT RAISE(ABORT,'immutable onboarding registration'); END;
CREATE TRIGGER ow_onboarding_activation_events_no_update BEFORE UPDATE ON ow_onboarding_activation_events BEGIN SELECT RAISE(ABORT,'immutable onboarding activation event'); END;
CREATE TRIGGER ow_onboarding_activation_events_no_delete BEFORE DELETE ON ow_onboarding_activation_events BEGIN SELECT RAISE(ABORT,'immutable onboarding activation event'); END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(10, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
