CREATE TABLE ow_replay_two_bookings (
  booking_id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1 AND generation <= 9007199254740991),
  receipt_hash TEXT NOT NULL UNIQUE,
  owner_project TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL REFERENCES ow_identities(id),
  expires_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(resource_key, generation)
);

CREATE INDEX ow_replay_two_bookings_current
ON ow_replay_two_bookings(resource_key, generation DESC);

CREATE TABLE ow_replay_two_booking_events (
  event_id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES ow_replay_two_bookings(booking_id),
  resource_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RELEASED','REVOKED','EXPIRED')),
  event_hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  UNIQUE(resource_key, generation)
);

CREATE TRIGGER ow_replay_two_bookings_no_update
BEFORE UPDATE ON ow_replay_two_bookings
BEGIN SELECT RAISE(ABORT,'immutable replay two booking receipt'); END;

CREATE TRIGGER ow_replay_two_bookings_no_delete
BEFORE DELETE ON ow_replay_two_bookings
BEGIN SELECT RAISE(ABORT,'immutable replay two booking receipt'); END;

CREATE TRIGGER ow_replay_two_booking_events_no_update
BEFORE UPDATE ON ow_replay_two_booking_events
BEGIN SELECT RAISE(ABORT,'immutable replay two booking event'); END;

CREATE TRIGGER ow_replay_two_booking_events_no_delete
BEFORE DELETE ON ow_replay_two_booking_events
BEGIN SELECT RAISE(ABORT,'immutable replay two booking event'); END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(14, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
