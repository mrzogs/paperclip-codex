import argparse
import datetime as dt
import json
import os
import re
import sqlite3
from pathlib import Path


LEGACY_TABLE = "manifest_snapshots"


def quote_identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def quote_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def table_names(conn):
    return [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]


def legacy_summary(conn):
    if LEGACY_TABLE not in table_names(conn):
        return {"present": False, "maxRowId": None, "first": None, "last": None}
    max_rowid = conn.execute(f"SELECT MAX(rowid) FROM {LEGACY_TABLE}").fetchone()[0]
    first = conn.execute(
        f"SELECT id, generated_at_utc, length(payload_json) FROM {LEGACY_TABLE} ORDER BY rowid LIMIT 1"
    ).fetchone()
    last = conn.execute(
        f"SELECT id, generated_at_utc, length(payload_json) FROM {LEGACY_TABLE} ORDER BY rowid DESC LIMIT 1"
    ).fetchone()
    return {
        "present": True,
        "maxRowId": max_rowid,
        "first": list(first) if first else None,
        "last": list(last) if last else None,
    }


def create_tables(source, target, copied_tables):
    for name in copied_tables:
        row = source.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        if not row or not row[0]:
            raise RuntimeError(f"Missing schema for table {name}")
        target.execute(row[0])
    target.commit()


def copy_tables(source, target_path, copied_tables):
    source.execute("ATTACH DATABASE ? AS compact", (str(target_path),))
    try:
        for name in copied_tables:
            quoted = quote_identifier(name)
            source.execute(f"INSERT INTO compact.{quoted} SELECT * FROM main.{quoted}")
        source.commit()
    finally:
        source.execute("DETACH DATABASE compact")


def create_secondary_objects(source, target, copied_tables):
    copied = set(copied_tables)
    rows = source.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master "
        "WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type, name"
    ).fetchall()
    for object_type, name, table_name, sql in rows:
        if table_name == LEGACY_TABLE or re.search(r"\bmanifest_snapshots\b", sql, re.IGNORECASE):
            continue
        if object_type != "view" and table_name not in copied:
            continue
        target.execute(sql)
    target.commit()


def row_counts(conn, tables):
    return {
        name: conn.execute(f"SELECT COUNT(*) FROM {quote_identifier(name)}").fetchone()[0]
        for name in tables
    }


def compact_database(db_path, archive_path=None):
    db_path = Path(db_path).resolve()
    if not db_path.is_file():
        raise FileNotFoundError(db_path)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = Path(archive_path).resolve() if archive_path else db_path.with_name(
        f"{db_path.stem}.legacy-manifest-snapshots-{timestamp}{db_path.suffix}"
    )
    if archive_path.exists():
        raise FileExistsError(archive_path)
    compact_path = db_path.with_name(f"{db_path.name}.compacting-{timestamp}")
    if compact_path.exists():
        raise FileExistsError(compact_path)

    source_stat = db_path.stat()
    source_size = source_stat.st_size
    source_file_id = source_stat.st_ino
    source = sqlite3.connect(db_path, timeout=30)
    try:
        source.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        copied_tables = [name for name in table_names(source) if name != LEGACY_TABLE]
        for name in copied_tables:
            integrity = source.execute(f"PRAGMA integrity_check({quote_literal(name)})").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"Source table integrity check failed for {name}: {integrity}")
        legacy = legacy_summary(source)

        target = sqlite3.connect(compact_path)
        try:
            create_tables(source, target, copied_tables)
        finally:
            target.close()

        copy_tables(source, compact_path, copied_tables)

        target = sqlite3.connect(compact_path)
        try:
            create_secondary_objects(source, target, copied_tables)
            target.execute(
                "CREATE TABLE manifest_archive_metadata ("
                "archive_path TEXT NOT NULL, source_size_bytes INTEGER NOT NULL, "
                "legacy_max_rowid INTEGER, first_generated_at_utc TEXT, last_generated_at_utc TEXT, "
                "compacted_at_utc TEXT NOT NULL)"
            )
            target.execute(
                "INSERT INTO manifest_archive_metadata VALUES (?, ?, ?, ?, ?, ?)",
                (
                    str(archive_path),
                    source_size,
                    legacy.get("maxRowId"),
                    legacy.get("first", [None, None])[1] if legacy.get("first") else None,
                    legacy.get("last", [None, None])[1] if legacy.get("last") else None,
                    dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                ),
            )
            target.commit()
            source_counts = row_counts(source, copied_tables)
            target_counts = row_counts(target, copied_tables)
            if source_counts != target_counts:
                raise RuntimeError("Copied table counts do not match source database")
            target_integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
            if target_integrity != "ok":
                raise RuntimeError(f"Compacted database integrity check failed: {target_integrity}")
        finally:
            target.close()
    except Exception:
        if compact_path.exists():
            compact_path.unlink()
        raise
    finally:
        source.close()

    os.replace(db_path, archive_path)
    os.replace(compact_path, db_path)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        if sidecar.exists():
            os.replace(sidecar, Path(str(archive_path) + suffix))

    verified = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    try:
        final_integrity = verified.execute("PRAGMA integrity_check").fetchone()[0]
        final_tables = table_names(verified)
    finally:
        verified.close()
    if final_integrity != "ok" or LEGACY_TABLE in final_tables:
        raise RuntimeError("Compacted database post-swap verification failed")
    archive_stat = archive_path.stat()
    if archive_stat.st_size != source_size or archive_stat.st_ino != source_file_id:
        raise RuntimeError("Legacy database archive was not preserved by the atomic rename")

    return {
        "status": "PASS",
        "database": str(db_path),
        "archive": str(archive_path),
        "sourceSizeBytes": source_size,
        "sourceFileId": source_file_id,
        "archiveSizeBytes": archive_stat.st_size,
        "archiveFileId": archive_stat.st_ino,
        "compactedSizeBytes": db_path.stat().st_size,
        "legacy": legacy,
        "copiedTables": copied_tables,
        "integrityCheck": final_integrity,
    }


def main():
    parser = argparse.ArgumentParser(description="Archive legacy manifest snapshots and compact the live Ocean database.")
    parser.add_argument("database")
    parser.add_argument("--archive")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--receipt-file")
    args = parser.parse_args()
    database = Path(args.database).resolve()
    if not args.execute:
        payload = {
            "status": "PLAN",
            "database": str(database),
            "sizeBytes": database.stat().st_size if database.exists() else None,
            "archive": str(Path(args.archive).resolve()) if args.archive else None,
        }
    else:
        payload = compact_database(database, args.archive)
    rendered = json.dumps(payload, indent=2)
    if args.receipt_file:
        receipt = Path(args.receipt_file).resolve()
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
