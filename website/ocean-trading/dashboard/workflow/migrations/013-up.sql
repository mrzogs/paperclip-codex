CREATE TABLE ow_candidate_evaluation_jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES ow_cases(id),
  completion_event_id INTEGER NOT NULL REFERENCES ow_events(id),
  completion_event_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','RETRY','COMPLETED','BLOCKED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL,
  lease_id TEXT,
  lease_until_ms INTEGER,
  last_error TEXT,
  input_json TEXT,
  input_hash TEXT,
  brain_request_json TEXT,
  brain_request_hash TEXT,
  brain_response_json TEXT,
  brain_response_hash TEXT,
  brain_readback_json TEXT,
  brain_readback_hash TEXT,
  brain_record_id TEXT,
  brain_relative_path TEXT,
  brain_content_hash TEXT,
  conclusion TEXT,
  result_artifact_id TEXT REFERENCES ow_artifacts(id),
  result_hash TEXT,
  created_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  UNIQUE(case_id, completion_event_id, evaluator_version)
);

CREATE INDEX ow_candidate_evaluation_jobs_due
ON ow_candidate_evaluation_jobs(state, next_attempt_ms, lease_until_ms);

CREATE TRIGGER ow_candidate_evaluation_jobs_identity_immutable
BEFORE UPDATE OF case_id,completion_event_id,completion_event_hash,plan_hash,candidate_hash,evaluator_version
ON ow_candidate_evaluation_jobs
BEGIN SELECT RAISE(ABORT,'immutable candidate evaluation identity'); END;

CREATE TRIGGER ow_candidate_evaluation_jobs_input_immutable
BEFORE UPDATE OF input_json,input_hash ON ow_candidate_evaluation_jobs
WHEN OLD.input_json IS NOT NULL OR OLD.input_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable candidate evaluation input'); END;

CREATE TRIGGER ow_candidate_evaluation_jobs_request_immutable
BEFORE UPDATE OF brain_request_json,brain_request_hash ON ow_candidate_evaluation_jobs
WHEN OLD.brain_request_json IS NOT NULL OR OLD.brain_request_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable candidate evaluation request'); END;

CREATE TRIGGER ow_candidate_evaluation_jobs_response_immutable
BEFORE UPDATE OF brain_response_json,brain_response_hash ON ow_candidate_evaluation_jobs
WHEN OLD.brain_response_json IS NOT NULL OR OLD.brain_response_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable candidate evaluation response'); END;

CREATE TRIGGER ow_candidate_evaluation_jobs_readback_immutable
BEFORE UPDATE OF brain_readback_json,brain_readback_hash ON ow_candidate_evaluation_jobs
WHEN OLD.brain_readback_json IS NOT NULL OR OLD.brain_readback_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable candidate evaluation readback'); END;

INSERT INTO ow_schema_migrations(version, applied_at_utc)
VALUES(13, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
