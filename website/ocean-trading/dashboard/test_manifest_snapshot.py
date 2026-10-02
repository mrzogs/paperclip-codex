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


class ManifestSnapshotTests(unittest.TestCase):
    def test_legacy_latest_without_sort_and_readonly_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "website.sqlite"
            with sqlite3.connect(db) as conn:
                persist.create_schema(conn)
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

    def test_publications_replace_single_snapshot_and_preserve_legacy_history(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "website.sqlite"
            manifest = Path(directory) / "dashboard-data.json"
            conn = sqlite3.connect(db)
            persist.create_schema(conn)
            conn.execute("INSERT INTO manifest_snapshots(id, generated_at_utc, payload_json) VALUES ('legacy', 'old', '{}')")
            conn.commit()
            conn.close()
            for index in range(3):
                manifest.write_text(json.dumps({"generatedAtUtc": str(index)}), encoding="utf-8")
                persist.persist(manifest, db)
            conn = query.connect(db)
            try:
                self.assertEqual(query.latest_manifest(conn)["generatedAtUtc"], "2")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM current_manifest").fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM manifest_snapshots").fetchone()[0], 1)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
