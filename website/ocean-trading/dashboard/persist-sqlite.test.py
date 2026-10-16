import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("persist-sqlite.py")
SPEC = importlib.util.spec_from_file_location("persist_sqlite", MODULE_PATH)
PERSIST_SQLITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERSIST_SQLITE)


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


if __name__ == "__main__":
    unittest.main()
