"""SQLite storage for the coordinator, and the choice of backend.

Three tables: `listings` holds one row per globally-unique marketplace listing,
`sightings` records every worker report (so overlapping regions stay auditable),
and `workers` tracks fleet health.

SQLite is the default and the only backend the tests and the local dev loop
use. When a Postgres URL is configured, `open_database` hands back the
equivalent `pg.PostgresDatabase` instead — see POSTGRES.md. `SCHEMA` and
`WORKER_HEALTH_COLUMNS` below are the single definition of the schema; the
Postgres backend translates them rather than restating them.
"""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterator, List, Optional, Union

if TYPE_CHECKING:  # pragma: no cover - import only for the type alias
    from .pg import PostgresDatabase

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    dedupe_key      TEXT PRIMARY KEY,
    marketplace     TEXT NOT NULL,
    listing_id      TEXT NOT NULL,
    item_name       TEXT,
    title           TEXT,
    price           TEXT,
    location        TEXT,
    post_url        TEXT,
    condition       TEXT,
    seller          TEXT,
    description     TEXT,
    image           TEXT,
    listing_hash    TEXT,
    ai_score        INTEGER,
    ai_comment      TEXT,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    first_worker_id TEXT,
    notified_at     TEXT
);

CREATE TABLE IF NOT EXISTS sightings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key  TEXT NOT NULL,
    worker_id   TEXT NOT NULL,
    seen_at     TEXT NOT NULL,
    price       TEXT,
    ai_score    INTEGER
);

CREATE TABLE IF NOT EXISTS workers (
    worker_id         TEXT PRIMARY KEY,
    region            TEXT,
    status            TEXT,
    detail_json       TEXT,
    last_heartbeat_at TEXT,
    last_listing_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_score ON listings(ai_score);
CREATE INDEX IF NOT EXISTS idx_sightings_key ON sightings(dedupe_key);

-- Control plane ------------------------------------------------------------
-- One row per Facebook account. Every secret for that account lives encrypted
-- in secret_blob; nothing here is readable without the vault key.
CREATE TABLE IF NOT EXISTS accounts (
    account_id           TEXT PRIMARY KEY,
    worker_id            TEXT,
    fb_username          TEXT,
    region               TEXT,
    proxy                TEXT,
    vnc_url              TEXT,
    allow_password_login INTEGER DEFAULT 0,
    secret_blob          BLOB,
    created_at           TEXT,
    updated_at           TEXT
);

-- Challenges a worker could not clear on its own, awaiting a human.
CREATE TABLE IF NOT EXISTS challenges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id       TEXT NOT NULL,
    account_id      TEXT,
    kind            TEXT,
    status          TEXT DEFAULT 'open',
    screenshot_path TEXT,
    vnc_url         TEXT,
    detail_json     TEXT,
    created_at      TEXT NOT NULL,
    resolved_at     TEXT,
    resolved_by     TEXT
);

-- Encrypted storage_state backups, so a rebuilt VM has a recovery snapshot.
CREATE TABLE IF NOT EXISTS session_snapshots (
    worker_id      TEXT PRIMARY KEY,
    account_id     TEXT,
    state_blob     BLOB,
    user_agent     TEXT,
    session_expiry TEXT,
    backed_up_at   TEXT
);

-- Every credential / code release, so a compromised worker is visible.
CREATE TABLE IF NOT EXISTS code_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id   TEXT,
    account_id  TEXT,
    kind        TEXT,
    reason      TEXT,
    released_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_challenges_status ON challenges(status);
CREATE INDEX IF NOT EXISTS idx_code_audit_time ON code_audit(released_at);
"""

# Columns added to `workers` after the first release. Applied with ADD COLUMN so
# that databases already deployed in the field pick them up on next start.
WORKER_HEALTH_COLUMNS = (
    ("state", "TEXT"),
    ("account_id", "TEXT"),
    ("session_expiry", "TEXT"),
    ("last_search_at", "TEXT"),
    ("error_count", "INTEGER DEFAULT 0"),
    ("browser_ok", "INTEGER"),
    ("proxy_ok", "INTEGER"),
    ("vnc_url", "TEXT"),
)


DEFAULT_DB_PATH = "data/coordinator.db"

# Checked in order. RS_DATABASE_URL is the one to set; DATABASE_URL is accepted
# because Railway injects it automatically into services linked to a database.
DATABASE_URL_VARS = ("RS_DATABASE_URL", "DATABASE_URL")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def postgres_url(env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """The configured Postgres URL, or None to mean "use SQLite"."""
    source = os.environ if env is None else env
    for name in DATABASE_URL_VARS:
        value = source.get(name)
        if value and value.strip():
            return value.strip()
    return None


AnyDatabase = Union["Database", "PostgresDatabase"]


def open_database(path: str | Path | None = None) -> AnyDatabase:
    """Open the configured backend.

    Postgres when RS_DATABASE_URL (or DATABASE_URL) is set and non-empty,
    SQLite otherwise. Both objects expose exactly the same methods, so callers
    never branch on which one they got.

    `path` is only consulted for the SQLite case; it defaults to
    RS_COORDINATOR_DB and then to `data/coordinator.db`.
    """
    url = postgres_url()
    if url:
        # Imported lazily: psycopg is an optional dependency and the SQLite
        # path — including the whole test suite — must not need it installed.
        from .pg import PostgresDatabase

        return PostgresDatabase(url)
    return Database(path or os.environ.get("RS_COORDINATOR_DB", DEFAULT_DB_PATH))


class Database:
    def __init__(self: "Database", path: str | Path) -> None:
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        # A single shared connection guarded by a lock: the write volume here is
        # a handful of rows per minute, and it keeps :memory: usable in tests.
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._migrate_workers()
            self._conn.commit()

    def _migrate_workers(self: "Database") -> None:
        """Add health columns to `workers` on databases created before them.

        Called with the lock held. SQLite has no ADD COLUMN IF NOT EXISTS, so
        read the existing columns and add only what is missing.
        """
        existing = {row["name"] for row in self._conn.execute("PRAGMA table_info(workers)")}
        for column, decl in WORKER_HEALTH_COLUMNS:
            if column not in existing:
                self._conn.execute(f"ALTER TABLE workers ADD COLUMN {column} {decl}")

    @contextmanager
    def cursor(self: "Database") -> Iterator[sqlite3.Cursor]:
        """Yield a cursor, then commit — or roll back if the body raised.

        The rollback is not optional bookkeeping. There is one shared
        connection, so a statement that fails (a UNIQUE violation, say) and is
        neither committed nor rolled back leaves an open transaction on it, and
        every later caller — including a `rsc status` on another thread — gets
        "database is locked" until the process restarts.
        """
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    def close(self: "Database") -> None:
        with self._lock:
            self._conn.close()

    # -- listings ----------------------------------------------------------

    def get_listing(self: "Database", dedupe_key: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM listings WHERE dedupe_key = ?", (dedupe_key,))
            row = cur.fetchone()
        return dict(row) if row else None

    def insert_listing(self: "Database", record: Dict[str, Any]) -> None:
        """Insert a listing, raising if the dedupe key is already taken.

        Callers racing other workers for the same key want `claim_listing`.
        """
        columns = ", ".join(record)
        placeholders = ", ".join(f":{name}" for name in record)
        with self.cursor() as cur:
            cur.execute(f"INSERT INTO listings ({columns}) VALUES ({placeholders})", record)

    def claim_listing(self: "Database", record: Dict[str, Any]) -> bool:
        """Insert a listing if nobody has that dedupe key yet; True if we won.

        Two workers whose regions overlap report a border listing at the same
        moment. Deciding newness by reading first and inserting second lets both
        of them read "absent" and both alert, and makes the loser's INSERT
        raise. One atomic statement decides it instead: exactly one caller gets
        True, which is what "exactly one alert per listing" rests on.
        """
        columns = ", ".join(record)
        placeholders = ", ".join(f":{name}" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO listings ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT(dedupe_key) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def update_listing(self: "Database", dedupe_key: str, fields: Dict[str, Any]) -> None:
        assignments = ", ".join(f"{name} = :{name}" for name in fields)
        params = {**fields, "dedupe_key": dedupe_key}
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE listings SET {assignments} WHERE dedupe_key = :dedupe_key", params
            )

    def record_sighting(
        self: "Database",
        dedupe_key: str,
        worker_id: str,
        price: str | None,
        ai_score: int | None,
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO sightings (dedupe_key, worker_id, seen_at, price, ai_score) "
                "VALUES (?, ?, ?, ?, ?)",
                (dedupe_key, worker_id, utcnow(), price, ai_score),
            )

    def query_listings(
        self: "Database",
        since: str | None = None,
        min_score: int | None = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM listings WHERE 1=1"
        params: List[Any] = []
        if since:
            sql += " AND last_seen_at >= ?"
            params.append(since)
        if min_score is not None:
            sql += " AND ai_score >= ?"
            params.append(min_score)
        sql += " ORDER BY last_seen_at DESC LIMIT ?"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def count_sightings(self: "Database", dedupe_key: str) -> int:
        with self.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM sightings WHERE dedupe_key = ?", (dedupe_key,))
            return int(cur.fetchone()["n"])

    # -- workers -----------------------------------------------------------

    def upsert_worker(
        self: "Database",
        worker_id: str,
        status: str | None = None,
        region: str | None = None,
        detail: Dict[str, Any] | None = None,
        heartbeat: bool = False,
        saw_listing: bool = False,
    ) -> None:
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO workers (worker_id, region, status, detail_json, "
                "last_heartbeat_at, last_listing_at) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(worker_id) DO UPDATE SET "
                "  region = COALESCE(excluded.region, workers.region),"
                "  status = COALESCE(excluded.status, workers.status),"
                "  detail_json = COALESCE(excluded.detail_json, workers.detail_json),"
                "  last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, workers.last_heartbeat_at),"
                "  last_listing_at = COALESCE(excluded.last_listing_at, workers.last_listing_at)",
                (
                    worker_id,
                    region,
                    status,
                    json.dumps(detail) if detail else None,
                    now if heartbeat else None,
                    now if saw_listing else None,
                ),
            )

    def list_workers(self: "Database") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM workers ORDER BY worker_id")
            return [dict(row) for row in cur.fetchall()]

    def get_worker(self: "Database", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM workers WHERE worker_id = ?", (worker_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def update_worker_health(self: "Database", worker_id: str, fields: Dict[str, Any]) -> None:
        """Upsert the health columns a heartbeat carries.

        Only the keys present in `fields` are written, so a partial heartbeat
        never blanks out what an earlier one reported.
        """
        allowed = {name for name, _ in WORKER_HEALTH_COLUMNS} | {
            "region",
            "status",
            "last_heartbeat_at",
            "last_listing_at",
            "detail_json",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return

        columns = ", ".join(["worker_id", *updates])
        placeholders = ", ".join(["?"] * (len(updates) + 1))
        assignments = ", ".join(f"{name} = excluded.{name}" for name in updates)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO workers ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(worker_id) DO UPDATE SET {assignments}",
                (worker_id, *updates.values()),
            )

    # -- accounts ----------------------------------------------------------

    def put_account(self: "Database", account_id: str, fields: Dict[str, Any]) -> None:
        now = utcnow()
        record = {"account_id": account_id, "updated_at": now, **fields}
        record.setdefault("created_at", now)
        columns = ", ".join(record)
        placeholders = ", ".join(["?"] * len(record))
        assignments = ", ".join(
            f"{name} = excluded.{name}" for name in record if name not in ("account_id", "created_at")
        )
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO accounts ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(account_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_account_row(self: "Database", account_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM accounts WHERE account_id = ?", (account_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def account_row_for_worker(self: "Database", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM accounts WHERE worker_id = ?", (worker_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def list_accounts(self: "Database") -> List[Dict[str, Any]]:
        """Non-secret account fields only — never returns secret_blob."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT account_id, worker_id, fb_username, region, proxy, vnc_url, "
                "allow_password_login, created_at, updated_at FROM accounts ORDER BY account_id"
            )
            return [dict(row) for row in cur.fetchall()]

    def delete_account(self: "Database", account_id: str) -> bool:
        with self.cursor() as cur:
            cur.execute("DELETE FROM accounts WHERE account_id = ?", (account_id,))
            return cur.rowcount > 0

    # -- challenges --------------------------------------------------------

    def insert_challenge(self: "Database", record: Dict[str, Any]) -> int:
        record = {"created_at": utcnow(), "status": "open", **record}
        columns = ", ".join(record)
        placeholders = ", ".join(["?"] * len(record))
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO challenges ({columns}) VALUES ({placeholders})",
                tuple(record.values()),
            )
            return int(cur.lastrowid)

    def update_challenge(self: "Database", challenge_id: int, fields: Dict[str, Any]) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = ?" for name in fields)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE challenges SET {assignments} WHERE id = ?",
                (*fields.values(), challenge_id),
            )

    def get_challenge(self: "Database", challenge_id: int) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM challenges WHERE id = ?", (challenge_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def list_challenges(
        self: "Database", status: str | None = "open", limit: int = 100
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM challenges"
        params: List[Any] = []
        if status and status != "all":
            sql += " WHERE status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def resolve_challenge(self: "Database", challenge_id: int, resolved_by: str | None) -> bool:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE challenges SET status = 'resolved', resolved_at = ?, resolved_by = ? "
                "WHERE id = ? AND status != 'resolved'",
                (utcnow(), resolved_by, challenge_id),
            )
            return cur.rowcount > 0

    # -- session snapshots -------------------------------------------------

    def upsert_snapshot(self: "Database", worker_id: str, fields: Dict[str, Any]) -> None:
        record = {"worker_id": worker_id, "backed_up_at": utcnow(), **fields}
        columns = ", ".join(record)
        placeholders = ", ".join(["?"] * len(record))
        assignments = ", ".join(f"{name} = excluded.{name}" for name in record if name != "worker_id")
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO session_snapshots ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(worker_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_snapshot(self: "Database", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM session_snapshots WHERE worker_id = ?", (worker_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    # -- audit -------------------------------------------------------------

    def insert_code_audit(
        self: "Database",
        worker_id: str | None,
        account_id: str | None,
        kind: str,
        reason: str | None = None,
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO code_audit (worker_id, account_id, kind, reason, released_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (worker_id, account_id, kind, reason, utcnow()),
            )

    def list_code_audit(self: "Database", limit: int = 100) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM code_audit ORDER BY released_at DESC LIMIT ?", (limit,))
            return [dict(row) for row in cur.fetchall()]
