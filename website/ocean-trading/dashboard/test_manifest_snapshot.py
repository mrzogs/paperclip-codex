import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


query = load_module("query-sqlite")
persist = load_module("persist-sqlite")
compact = load_module("compact-manifest-sqlite")


def create_legacy_snapshot_table(conn):
    conn.execute(
        """
        CREATE TABLE manifest_snapshots (
          id TEXT PRIMARY KEY,
          generated_at_utc TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
        """
    )


class ManifestSnapshotTests(unittest.TestCase):
    def test_legacy_latest_without_sort_and_readonly_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "website.sqlite"
            with sqlite3.connect(db) as conn:
                persist.create_schema(conn)
                create_legacy_snapshot_table(conn)
                for index in range(500):
                    conn.execute("INSERT INTO manifest_snapshots(id, generated_at_utc, payload_json) VALUES (?,?,?)",
                                 (str(index), str(index), json.dumps({"sequence": index})))
            conn.close()
            conn = query.connect(db)
            try:
                self.assertEqual(query.latest_manifest(conn), {"sequence": 499})
                plan = str([tuple(row) for row in conn.execute("EXPLAIN QUERY PLAN SELECT * FROM manifest_snapshots ORDER BY rowid DESC LIMIT 1")])
                self.assertNotIn("TEMP B-TREE", plan)
                with self.assertRaises(sqlite3.OperationalError):
                    conn.execute("DELETE FROM manifest_snapshots")
            finally:
                conn.close()

    def test_publications_replace_single_snapshot_without_creating_history(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "website.sqlite"
            manifest = Path(directory) / "dashboard-data.json"
            conn = sqlite3.connect(db)
            persist.create_schema(conn)
            conn.commit()
            conn.close()
            for index in range(3):
                manifest.write_text(json.dumps({"generatedAtUtc": str(index)}), encoding="utf-8")
                persist.persist(manifest, db)
            conn = query.connect(db)
            try:
                self.assertEqual(query.latest_manifest(conn)["generatedAtUtc"], "2")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM current_manifest").fetchone()[0], 1)
                self.assertIsNone(conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest_snapshots'"
                ).fetchone())
            finally:
                conn.close()

    def test_compactor_preserves_legacy_database_and_all_operational_tables(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "website.sqlite"
            archive = Path(directory) / "website.legacy.sqlite"
            manifest = Path(directory) / "dashboard-data.json"
            manifest.write_text(json.dumps({"generatedAtUtc": "new"}), encoding="utf-8")
            persist.persist(manifest, db)
            with sqlite3.connect(db) as conn:
                create_legacy_snapshot_table(conn)
                conn.execute(
                    "INSERT INTO manifest_snapshots(id, generated_at_utc, payload_json) VALUES ('legacy', 'old', '{}')"
                )
                conn.execute("CREATE TABLE extra_operational_table(id TEXT PRIMARY KEY, value TEXT)")
                conn.execute("INSERT INTO extra_operational_table VALUES ('one', 'preserved')")
            conn.close()

            receipt = compact.compact_database(db, archive)

            self.assertEqual(receipt["status"], "PASS")
            self.assertTrue(archive.exists())
            conn = sqlite3.connect(archive)
            try:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM manifest_snapshots").fetchone()[0], 1)
            finally:
                conn.close()
            conn = query.connect(db)
            try:
                self.assertIsNone(conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest_snapshots'"
                ).fetchone())
                self.assertEqual(conn.execute("SELECT value FROM extra_operational_table").fetchone()[0], "preserved")
                self.assertEqual(query.latest_manifest(conn)["generatedAtUtc"], "new")
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
