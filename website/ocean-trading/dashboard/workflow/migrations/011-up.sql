CREATE TABLE ow_research_jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES ow_cases(id),
  artifact_id TEXT NOT NULL REFERENCES ow_artifacts(id),
  artifact_hash TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','RETRY','COMPLETED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL,
  lease_id TEXT,
  lease_until_ms INTEGER,
  last_error TEXT,
  input_json TEXT,
  input_hash TEXT,
  brain_request_json TEXT,
  brain_request_hash TEXT,
  result_artifact_id TEXT REFERENCES ow_artifacts(id),
  result_hash TEXT,
  created_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  UNIQUE(case_id,artifact_id,analysis_version)
);
CREATE INDEX ow_research_jobs_due ON ow_research_jobs(state,next_attempt_ms);
CREATE TRIGGER ow_research_input_no_rewrite BEFORE UPDATE OF input_json,input_hash ON ow_research_jobs
WHEN OLD.input_json IS NOT NULL AND (OLD.input_json IS NOT NEW.input_json OR OLD.input_hash IS NOT NEW.input_hash)
BEGIN SELECT RAISE(ABORT,'immutable Research input'); END;
CREATE TRIGGER ow_research_request_no_rewrite BEFORE UPDATE OF brain_request_json,brain_request_hash ON ow_research_jobs
WHEN OLD.brain_request_json IS NOT NULL AND (OLD.brain_request_json IS NOT NEW.brain_request_json OR OLD.brain_request_hash IS NOT NEW.brain_request_hash)
BEGIN SELECT RAISE(ABORT,'immutable Research request'); END;
INSERT INTO ow_schema_migrations VALUES(11,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
