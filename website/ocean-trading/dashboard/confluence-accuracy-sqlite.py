import json
import sqlite3
import sys
from pathlib import Path


def as_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def create_schema(conn):
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS confluence_accuracy_runs (
          id TEXT PRIMARY KEY,
          generated_at_utc TEXT NOT NULL,
          mode TEXT NOT NULL,
          from_date_key TEXT,
          to_date_key TEXT,
          excluded_date_keys_json TEXT,
          no_lookahead_passed INTEGER NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_predictions (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session TEXT NOT NULL,
          forecast_source_date_key TEXT NOT NULL,
          actual_date_key TEXT NOT NULL,
          forecast_captured_at_utc TEXT,
          forecast_dominant TEXT,
          forecast_percentages_json TEXT,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_actuals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session TEXT NOT NULL,
          actual_date_key TEXT NOT NULL,
          actual_captured_at_utc TEXT,
          actual_dominant TEXT,
          actual_percentages_json TEXT,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_scores (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session TEXT NOT NULL,
          forecast_source_date_key TEXT NOT NULL,
          actual_date_key TEXT NOT NULL,
          result TEXT NOT NULL,
          hit INTEGER NOT NULL,
          near_miss INTEGER NOT NULL,
          error_pct REAL,
          no_lookahead_passed INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_method_session_rollups (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session TEXT NOT NULL,
          samples INTEGER NOT NULL,
          hits INTEGER NOT NULL,
          near_misses INTEGER NOT NULL,
          hit_rate REAL NOT NULL,
          avg_error_pct REAL,
          status TEXT NOT NULL,
          latest_result TEXT,
          weakest_primary_session INTEGER NOT NULL DEFAULT 0,
          masked_weakness_flag INTEGER NOT NULL DEFAULT 0,
          secondary_rollup INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_alignment_matrices (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          session TEXT NOT NULL,
          forecast_bucket TEXT NOT NULL,
          actual_bucket TEXT NOT NULL,
          count INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_daily_summaries (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          actual_date_key TEXT NOT NULL,
          samples INTEGER NOT NULL,
          hits INTEGER NOT NULL,
          near_misses INTEGER NOT NULL,
          hit_rate REAL NOT NULL,
          weakest_primary_session TEXT,
          masked_weakness_flag INTEGER NOT NULL,
          secondary_rollup INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_alerts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          alert_type TEXT NOT NULL,
          message TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_hermes_recommendations (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS confluence_accuracy_routine_runs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          routine_id TEXT NOT NULL,
          status TEXT NOT NULL,
          checks_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES confluence_accuracy_runs(id) ON DELETE CASCADE
        );
        """
    )


def replace_run(conn, payload):
    run = payload["run"]
    run_id = run["id"]
    conn.execute("DELETE FROM confluence_accuracy_runs WHERE id = ?", (run_id,))
    conn.execute(
        """
        INSERT INTO confluence_accuracy_runs
        (id, generated_at_utc, mode, from_date_key, to_date_key, excluded_date_keys_json,
         no_lookahead_passed, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            run["generatedAtUtc"],
            run["mode"],
            run.get("fromDateKey"),
            run.get("toDateKey"),
            as_json(run.get("excludedDateKeys", [])),
            1 if run.get("noLookaheadPassed") else 0,
            as_json(run),
        ),
    )
    for row in payload.get("predictions", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_predictions
            (id, run_id, session, forecast_source_date_key, actual_date_key,
             forecast_captured_at_utc, forecast_dominant, forecast_percentages_json, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                run_id,
                row["session"],
                row["forecastSourceDateKey"],
                row["actualDateKey"],
                row.get("forecastCapturedAtUtc"),
                row.get("forecastDominant"),
                as_json(row.get("forecastPercentages")),
                as_json(row),
            ),
        )
    for row in payload.get("actuals", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_actuals
            (id, run_id, session, actual_date_key, actual_captured_at_utc,
             actual_dominant, actual_percentages_json, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                run_id,
                row["session"],
                row["actualDateKey"],
                row.get("actualCapturedAtUtc"),
                row.get("actualDominant"),
                as_json(row.get("actualPercentages")),
                as_json(row),
            ),
        )
    for row in payload.get("scores", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_scores
            (id, run_id, session, forecast_source_date_key, actual_date_key, result,
             hit, near_miss, error_pct, no_lookahead_passed, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                run_id,
                row["session"],
                row["forecastSourceDateKey"],
                row["actualDateKey"],
                row["result"],
                1 if row.get("hit") else 0,
                1 if row.get("nearMiss") else 0,
                row.get("errorPct"),
                1 if row.get("noLookaheadPassed") else 0,
                as_json(row),
            ),
        )
    for row in payload.get("rollups", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_method_session_rollups
            (id, run_id, session, samples, hits, near_misses, hit_rate, avg_error_pct,
             status, latest_result, weakest_primary_session, masked_weakness_flag,
             secondary_rollup, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                run_id,
                row["session"],
                row["samples"],
                row["hits"],
                row["nearMisses"],
                row["hitRate"],
                row.get("avgErrorPct"),
                row["status"],
                row.get("latestResult"),
                1 if row.get("weakestPrimarySession") else 0,
                1 if row.get("maskedWeaknessFlag") else 0,
                1 if row.get("secondaryRollup") else 0,
                as_json(row),
            ),
        )
    for row in payload.get("alignmentMatrices", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_alignment_matrices
            (id, run_id, session, forecast_bucket, actual_bucket, count, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (row["id"], run_id, row["session"], row["forecastBucket"], row["actualBucket"], row["count"], as_json(row)),
        )
    for row in payload.get("dailySummaries", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_daily_summaries
            (id, run_id, actual_date_key, samples, hits, near_misses, hit_rate,
             weakest_primary_session, masked_weakness_flag, secondary_rollup, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                run_id,
                row["actualDateKey"],
                row["samples"],
                row["hits"],
                row["nearMisses"],
                row["hitRate"],
                row.get("weakestPrimarySession"),
                1 if row.get("maskedWeaknessFlag") else 0,
                1 if row.get("secondaryRollup") else 0,
                as_json(row),
            ),
        )
    for row in payload.get("alerts", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_alerts
            (id, run_id, severity, alert_type, message, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (row["id"], run_id, row["severity"], row["alertType"], row["message"], as_json(row)),
        )
    for row in payload.get("hermesRecommendations", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_hermes_recommendations
            (id, run_id, recommendation, action, payload_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (row["id"], run_id, row["recommendation"], row["action"], as_json(row)),
        )
    for row in payload.get("routineRuns", []):
        conn.execute(
            """
            INSERT INTO confluence_accuracy_routine_runs
            (id, run_id, routine_id, status, checks_json, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (row["id"], run_id, row["routineId"], row["status"], as_json(row.get("checks", [])), as_json(row)),
        )


def main(argv):
    if len(argv) != 3:
        print("usage: confluence-accuracy-sqlite.py <db-path> <payload-json>", file=sys.stderr)
        return 2
    db_path = Path(argv[1])
    payload_path = Path(argv[2])
    db_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    conn = sqlite3.connect(db_path)
    try:
        create_schema(conn)
        with conn:
            replace_run(conn, payload)
    finally:
        conn.close()
    print(json.dumps({"ok": True, "runId": payload["run"]["id"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
