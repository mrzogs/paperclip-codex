CREATE INDEX ow_run_progress_run_latest
ON ow_run_progress(run_id, id DESC);

CREATE INDEX ow_coverage_receipts_run_latest
ON ow_coverage_receipts(run_id, id DESC);

CREATE INDEX ow_events_entity_action_latest
ON ow_events(entity_id, action, id DESC);

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(12, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
