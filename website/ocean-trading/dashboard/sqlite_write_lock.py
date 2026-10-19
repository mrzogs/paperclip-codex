import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


if os.name == "nt":
    import msvcrt
else:
    import fcntl


def configured_write_lock_timeout_ms():
    raw = os.environ.get("OCEAN_SQLITE_WRITE_LOCK_TIMEOUT_MS", "30000")
    try:
        timeout_ms = int(raw)
    except ValueError:
        timeout_ms = 30000
    return max(1000, min(timeout_ms, 150000))


def _utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SqliteWriteLock:
    """Cross-process advisory lock for Ocean writers targeting one SQLite file."""

    def __init__(self, db_path, owner=None, timeout_ms=None):
        self.db_path = Path(db_path)
        self.lock_path = Path(f"{self.db_path}.write.lock")
        self.timeout_ms = configured_write_lock_timeout_ms() if timeout_ms is None else timeout_ms
        self.owner = {
            "pid": os.getpid(),
            "parent_pid": os.getppid(),
            "acquired_at_utc": None,
            **(owner or {}),
        }
        self.handle = None
        self.waited_ms = None

    def _try_lock(self):
        self.handle.seek(0)
        if os.name == "nt":
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(self):
        self.handle.seek(0)
        if os.name == "nt":
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)

    def _read_owner(self):
        try:
            self.handle.seek(1)
            raw = self.handle.read().decode("utf-8", errors="replace").strip()
            return json.loads(raw) if raw else None
        except (OSError, ValueError):
            return None

    def acquire(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT)
        self.handle = os.fdopen(descriptor, "r+b", buffering=0)
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"\0")
            self.handle.flush()

        started = time.monotonic()
        deadline = started + (self.timeout_ms / 1000)
        incumbent = None
        while True:
            try:
                self._try_lock()
                break
            except OSError:
                incumbent = self._read_owner()
                if time.monotonic() >= deadline:
                    self.handle.close()
                    self.handle = None
                    owner_text = json.dumps(incumbent, sort_keys=True) if incumbent else "unknown"
                    raise TimeoutError(
                        f"Ocean SQLite writer lock timed out after {self.timeout_ms}ms; "
                        f"database={self.db_path}; incumbent={owner_text}"
                    )
                time.sleep(0.1)

        self.waited_ms = round((time.monotonic() - started) * 1000, 3)
        self.owner["acquired_at_utc"] = _utc_now()
        self.owner["waited_ms"] = self.waited_ms
        encoded = json.dumps(self.owner, ensure_ascii=False, sort_keys=True).encode("utf-8")
        self.handle.seek(1)
        self.handle.write(encoded)
        self.handle.truncate()
        self.handle.flush()
        return dict(self.owner)

    def release(self):
        if self.handle is None:
            return
        try:
            self._unlock()
        finally:
            self.handle.close()
            self.handle = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()
