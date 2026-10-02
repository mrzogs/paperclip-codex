import json
import sqlite3
import sys
import time
from pathlib import Path


def connect(db_path):
    conn = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True, timeout=0.25)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    deadline = time.monotonic() + 3
    conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    return conn


def latest_snapshot(conn):
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_manifest'").fetchone():
        row = conn.execute("SELECT * FROM current_manifest WHERE id=1").fetchone()
        if row is not None:
            return row
    # Legacy publication order is the rowid, not an unindexed sort of every JSON blob.
    return conn.execute("SELECT * FROM manifest_snapshots ORDER BY rowid DESC LIMIT 1").fetchone()


def latest_manifest(conn):
    row = latest_snapshot(conn)
    if row is None:
        return None
    return json.loads(row["payload_json"])


def table_counts(conn):
    tables = [
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    return {
        table: conn.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
        for table in tables
    }


def database_summary(conn, db_path):
    path = Path(db_path)
    snapshot = latest_snapshot(conn)
    return {
        "sqliteFile": str(path),
        "exists": path.exists(),
        "sizeBytes": path.stat().st_size if path.exists() else 0,
        "updatedAtUtc": (
            __import__("datetime").datetime.fromtimestamp(path.stat().st_mtime, __import__("datetime").timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
            if path.exists()
            else None
        ),
        "latestManifestGeneratedAtUtc": snapshot["generated_at_utc"] if snapshot else None,
        "latestSnapshotCreatedAtUtc": snapshot["created_at_utc"] if snapshot else None,
        "tableCounts": table_counts(conn),
    }


def main(argv):
    if len(argv) != 3:
        print("usage: query-sqlite.py <db-path> <latest-manifest|database-summary>", file=sys.stderr)
        return 2
    db_path, command = argv[1], argv[2]
    if not Path(db_path).exists():
        print(json.dumps({"ok": False, "error": f"SQLite database not found: {db_path}"}))
        return 1
    conn = connect(db_path)
    try:
        if command == "latest-manifest":
            payload = latest_manifest(conn)
            if payload is None:
                print(json.dumps({"ok": False, "error": "No manifest snapshot found."}))
                return 1
            print(json.dumps(payload, ensure_ascii=False))
            return 0
        if command == "database-summary":
            print(json.dumps(database_summary(conn, db_path), ensure_ascii=False))
            return 0
        print(f"unknown command: {command}", file=sys.stderr)
        return 2
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
