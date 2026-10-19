import importlib.util
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("persist-sqlite.py")
SPEC = importlib.util.spec_from_file_location("persist_sqlite", MODULE_PATH)
PERSIST_SQLITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERSIST_SQLITE)
from sqlite_write_lock import SqliteWriteLock, configured_write_lock_timeout_ms


class PersistSqliteConfigurationTests(unittest.TestCase):
    def test_busy_timeout_uses_bounded_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(PERSIST_SQLITE.configured_busy_timeout_ms(), 120000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_BUSY_TIMEOUT_MS": "invalid"}, clear=True):
            self.assertEqual(PERSIST_SQLITE.configured_busy_timeout_ms(), 120000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_BUSY_TIMEOUT_MS": "10"}, clear=True):
            self.assertEqual(PERSIST_SQLITE.configured_busy_timeout_ms(), 1000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_BUSY_TIMEOUT_MS": "9999999"}, clear=True):
            self.assertEqual(PERSIST_SQLITE.configured_busy_timeout_ms(), 600000)

    def test_schema_keeps_an_existing_wal_database_in_wal_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "ocean.sqlite"
            connection = sqlite3.connect(database)
            try:
                connection.execute("PRAGMA journal_mode=WAL")
                PERSIST_SQLITE.create_schema(connection)
                mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
                self.assertEqual(mode.lower(), "wal")
            finally:
                connection.close()

    def test_writer_lock_timeout_is_bounded(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(configured_write_lock_timeout_ms(), 30000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_WRITE_LOCK_TIMEOUT_MS": "invalid"}, clear=True):
            self.assertEqual(configured_write_lock_timeout_ms(), 30000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_WRITE_LOCK_TIMEOUT_MS": "10"}, clear=True):
            self.assertEqual(configured_write_lock_timeout_ms(), 1000)
        with patch.dict(os.environ, {"OCEAN_SQLITE_WRITE_LOCK_TIMEOUT_MS": "9999999"}, clear=True):
            self.assertEqual(configured_write_lock_timeout_ms(), 150000)

    def test_writer_lock_identifies_incumbent_and_releases_for_next_process(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "ocean.sqlite"
            holder = SqliteWriteLock(database, owner={"writer": "test-holder"}, timeout_ms=5000)
            holder.acquire()
            child = """
from pathlib import Path
from sqlite_write_lock import SqliteWriteLock
lock = SqliteWriteLock(Path(r'%s'), owner={'writer': 'test-child'})
lock.acquire()
lock.release()
""" % database
            environment = dict(os.environ)
            environment["OCEAN_SQLITE_WRITE_LOCK_TIMEOUT_MS"] = "1000"
            try:
                blocked = subprocess.run(
                    [sys.executable, "-c", child],
                    cwd=MODULE_PATH.parent,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertNotEqual(blocked.returncode, 0)
                self.assertIn("test-holder", blocked.stderr)
            finally:
                holder.release()
            succeeded = subprocess.run(
                [sys.executable, "-c", child],
                cwd=MODULE_PATH.parent,
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(succeeded.returncode, 0, succeeded.stderr)


if __name__ == "__main__":
    unittest.main()
