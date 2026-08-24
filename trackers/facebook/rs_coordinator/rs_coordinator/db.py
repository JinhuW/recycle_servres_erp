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
    ai_count        TEXT,
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

-- Alert outbox -------------------------------------------------------------
-- Every message the coordinator owes Telegram, written in the same request
-- that decided to alert and delivered by the background loop (background.py).
-- Telegram being down therefore delays an alert instead of losing it: the
-- listing used to be committed first and the send attempted once, inline, so
-- a failed send left the listing looking like a duplicate forever and the
-- alert was gone. A row is retried until delivered_at is set.
CREATE TABLE IF NOT EXISTS outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    dedupe_key      TEXT,
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    delivered_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at, next_attempt_at);

-- Messenger bridge ----------------------------------------------------------
-- Conversations scraped from each account's Marketplace inbox. The workers
-- (rs-messenger) report whole thread snapshots; `messages.fingerprint` is what
-- makes re-reporting idempotent, the same way listings.dedupe_key does for the
-- search fleet. `human_claimed` is the operator's kill switch for auto-reply
-- on one thread; `autoreplied_at` is the policy's own once-per-thread memory.
--
-- The router columns tie one FB conversation to its two other faces: the
-- mautrix-meta portal room it arrives from (`matrix_room_id`) and the Telegram
-- forum topic staff answer it in (`telegram_topic_id`). Both are filled in
-- lazily — a thread first seen by the legacy scraper has neither until the
-- router touches it or its first alert opens a topic.
CREATE TABLE IF NOT EXISTS threads (
    thread_id        TEXT PRIMARY KEY,
    worker_id        TEXT,
    counterpart      TEXT,
    listing_title    TEXT,
    last_message_at  TEXT,
    human_claimed    INTEGER NOT NULL DEFAULT 0,
    autoreplied_at   TEXT,
    matrix_room_id   TEXT,
    telegram_topic_id INTEGER,
    topic_state      TEXT DEFAULT 'open',
    created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    fingerprint TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    direction   TEXT NOT NULL,
    sender      TEXT,
    text        TEXT,
    sent_at     TEXT,
    created_at  TEXT NOT NULL
);

-- Replies waiting to be delivered to Facebook. Written by the auto-reply
-- policy or an operator; a worker fetches its queue, sends, and acks. Nothing
-- here sends anything itself.
--
-- `transport` decides WHICH worker owns a reply, which is what lets the
-- Playwright bridge and the mautrix-meta router coexist on one account without
-- double-sending: `rs-messenger` only ever drains 'playwright' rows,
-- `rs-router` only ever drains 'matrix' rows. Default 'playwright' keeps the
-- legacy bridge's behaviour unchanged.
CREATE TABLE IF NOT EXISTS outbound_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT NOT NULL,
    worker_id  TEXT,
    text       TEXT NOT NULL,
    origin     TEXT NOT NULL,
    transport  TEXT NOT NULL DEFAULT 'playwright',
    status     TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL,
    sent_at    TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

-- The Telegram getUpdates cursor: one row, so the reply consumer resumes from
-- the last update it processed across a coordinator restart instead of
-- replaying the whole backlog or skipping what arrived while it was down.
CREATE TABLE IF NOT EXISTS telegram_offset (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    update_offset INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_messages(status);
-- The threads(matrix_room_id) / threads(telegram_topic_id) indexes are created
-- after the column migration below, not here: on a database predating those
-- columns this schema runs before they exist, and indexing a missing column
-- fails.

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
    # The liveness the sweeper last alerted on ("dead", or NULL). Persisted so a
    # coordinator restart does not re-page ops about a worker it already
    # reported dead.
    ("alerted_liveness", "TEXT"),
)

# Columns added to `listings` after the first release, same mechanism.
LISTING_EXTRA_COLUMNS = (
    # The AI's unit count as a display phrase ("8 sticks").
    ("ai_count", "TEXT"),
)

# Columns added to `threads` for the mautrix-meta router, same mechanism. A
# field database created before the router picks them up on next start.
THREAD_EXTRA_COLUMNS = (
    ("matrix_room_id", "TEXT"),
    ("telegram_topic_id", "INTEGER"),
    ("topic_state", "TEXT DEFAULT 'open'"),
)

# Columns added to `outbound_messages` for transport routing, same mechanism.
OUTBOUND_EXTRA_COLUMNS = (
    ("transport", "TEXT NOT NULL DEFAULT 'playwright'"),
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


def default_db_path() -> str:
    """Where the SQLite database lives when nothing says otherwise.

    RS_COORDINATOR_DB always wins. Without it, the default is anchored to the
    tracker checkout this module sits in rather than to the current working
    directory: a bare `data/coordinator.db` meant `rsc` run from
    rs_coordinator/ and a server run from the repo root silently used two
    different databases, and both files exist in the field to prove it. The
    anchor is only trusted when it looks like a real checkout (it has
    `configs/`); a site-packages install falls back to the old CWD-relative
    form, and containers set RS_COORDINATOR_DB explicitly anyway.
    """
    env = os.environ.get("RS_COORDINATOR_DB")
    if env:
        return env
    root = Path(__file__).resolve().parents[2]
    if (root / "configs").is_dir():
        return str(root / DEFAULT_DB_PATH)
    return DEFAULT_DB_PATH


def open_database(path: str | Path | None = None) -> AnyDatabase:
    """Open the configured backend.

    Postgres when RS_DATABASE_URL (or DATABASE_URL) is set and non-empty,
    SQLite otherwise. Both objects expose exactly the same methods, so callers
    never branch on which one they got.

    `path` is only consulted for the SQLite case; it defaults to
    RS_COORDINATOR_DB and then to `data/coordinator.db` anchored to the
    checkout (see `default_db_path`).
    """
    url = postgres_url()
    if url:
        # Imported lazily: psycopg is an optional dependency and the SQLite
        # path — including the whole test suite — must not need it installed.
        from .pg import PostgresDatabase

        return PostgresDatabase(url)
    return Database(path or default_db_path())


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
            self._migrate_listings()
            self._migrate_columns("threads", THREAD_EXTRA_COLUMNS)
            self._migrate_columns("outbound_messages", OUTBOUND_EXTRA_COLUMNS)
            # Created after the migration adds the columns they index.
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_threads_room ON threads(matrix_room_id)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_threads_topic ON threads(telegram_topic_id)"
            )
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

    def _migrate_listings(self: "Database") -> None:
        """Add later columns to `listings`, same mechanism as `_migrate_workers`."""
        existing = {row["name"] for row in self._conn.execute("PRAGMA table_info(listings)")}
        for column, decl in LISTING_EXTRA_COLUMNS:
            if column not in existing:
                self._conn.execute(f"ALTER TABLE listings ADD COLUMN {column} {decl}")

    def _migrate_columns(self: "Database", table: str, columns: tuple) -> None:
        """Add missing columns to `table`, same additive mechanism as above.

        `table` is a fixed literal from this module, never user input, so the
        f-string interpolation is safe.
        """
        existing = {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})")}
        for column, decl in columns:
            if column not in existing:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")

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

    # -- alert outbox ------------------------------------------------------

    def enqueue_alert(
        self: "Database", kind: str, text: str, dedupe_key: str | None = None
    ) -> int:
        """Queue an alert for the background sender; returns its outbox id."""
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO outbox (kind, dedupe_key, text, created_at, next_attempt_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (kind, dedupe_key, text, now, now),
            )
            return int(cur.lastrowid)

    def due_alerts(self: "Database", now: str | None = None, limit: int = 20) -> List[Dict[str, Any]]:
        """Undelivered alerts whose next attempt is due, oldest first."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? "
                "ORDER BY id LIMIT ?",
                (now or utcnow(), limit),
            )
            return [dict(row) for row in cur.fetchall()]

    def mark_alert_delivered(self: "Database", alert_id: int) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbox SET delivered_at = ?, last_error = NULL WHERE id = ?",
                (utcnow(), alert_id),
            )

    def mark_alert_failed(
        self: "Database", alert_id: int, error: str, next_attempt_at: str
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ?, "
                "next_attempt_at = ? WHERE id = ?",
                (error, next_attempt_at, alert_id),
            )

    def outbox_backlog(self: "Database") -> int:
        """How many alerts are queued but not yet delivered."""
        with self.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL")
            return int(cur.fetchone()["n"])

    # -- telegram reply cursor ---------------------------------------------

    def get_telegram_offset(self: "Database") -> int:
        """The last getUpdates offset the reply consumer committed (0 if none)."""
        with self.cursor() as cur:
            cur.execute("SELECT update_offset FROM telegram_offset WHERE id = 1")
            row = cur.fetchone()
        return int(row["update_offset"]) if row else 0

    def set_telegram_offset(self: "Database", offset: int) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO telegram_offset (id, update_offset) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET update_offset = excluded.update_offset",
                (offset,),
            )

    # -- messenger threads / messages --------------------------------------

    def upsert_thread(self: "Database", thread_id: str, fields: Dict[str, Any]) -> None:
        """Create or refresh a thread row, never blanking what a fuller
        snapshot reported earlier (scrapes are best-effort and lossy)."""
        record = {"thread_id": thread_id, "created_at": utcnow(), **fields}
        columns = ", ".join(record)
        placeholders = ", ".join(["?"] * len(record))
        assignments = ", ".join(
            f"{name} = COALESCE(excluded.{name}, threads.{name})"
            for name in fields
        )
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO threads ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(thread_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_thread(self: "Database", thread_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE thread_id = ?", (thread_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def list_threads(self: "Database", limit: int = 100) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM threads ORDER BY last_message_at DESC LIMIT ?", (limit,)
            )
            return [dict(row) for row in cur.fetchall()]

    def set_thread_fields(self: "Database", thread_id: str, fields: Dict[str, Any]) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = :{name}" for name in fields)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE threads SET {assignments} WHERE thread_id = :thread_id",
                {**fields, "thread_id": thread_id},
            )

    def get_thread_by_topic(self: "Database", topic_id: int) -> Optional[Dict[str, Any]]:
        """The thread a Telegram forum topic belongs to, for routing a reply."""
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE telegram_topic_id = ?", (topic_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def get_thread_by_room(self: "Database", matrix_room_id: str) -> Optional[Dict[str, Any]]:
        """The thread a mautrix-meta portal room belongs to."""
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE matrix_room_id = ?", (matrix_room_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def claim_message(self: "Database", record: Dict[str, Any]) -> bool:
        """Insert a message if its fingerprint is new; True if we did.

        Workers re-report whole threads on every poll, so the same atomic
        insert-or-nothing that keeps border listings to one alert keeps
        re-scraped messages to one.
        """
        record = {"created_at": utcnow(), **record}
        columns = ", ".join(record)
        placeholders = ", ".join(f":{name}" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO messages ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT(fingerprint) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def list_messages(self: "Database", thread_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, fingerprint "
                "LIMIT ?",
                (thread_id, limit),
            )
            return [dict(row) for row in cur.fetchall()]

    def count_messages(self: "Database", thread_id: str, direction: str | None = None) -> int:
        sql = "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?"
        params: List[Any] = [thread_id]
        if direction:
            sql += " AND direction = ?"
            params.append(direction)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return int(cur.fetchone()["n"])

    # -- outbound replies --------------------------------------------------

    def enqueue_outbound(
        self: "Database",
        thread_id: str,
        worker_id: str | None,
        text: str,
        origin: str,
        transport: str = "playwright",
    ) -> int:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO outbound_messages (thread_id, worker_id, text, origin, "
                "transport, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
                (thread_id, worker_id, text, origin, transport, utcnow()),
            )
            return int(cur.lastrowid)

    def pending_outbound(
        self: "Database",
        worker_id: str | None = None,
        limit: int = 10,
        transport: str | None = None,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM outbound_messages WHERE status = 'queued'"
        params: List[Any] = []
        if transport:
            # The transport partition is what keeps the two bridges from both
            # sending the same reply — see the schema note on outbound_messages.
            sql += " AND transport = ?"
            params.append(transport)
        if worker_id:
            # NULL worker_id means "whichever worker owns the thread" — an
            # operator reply queued before the thread reported an owner.
            sql += " AND (worker_id = ? OR worker_id IS NULL)"
            params.append(worker_id)
        sql += " ORDER BY id LIMIT ?"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def get_outbound(self: "Database", outbound_id: int) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM outbound_messages WHERE id = ?", (outbound_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def mark_outbound(
        self: "Database", outbound_id: int, status: str, error: str | None = None
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbound_messages SET status = ?, last_error = ?, "
                "attempts = attempts + 1, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END "
                "WHERE id = ?",
                (status, error, status, utcnow(), outbound_id),
            )

    def count_autoreplies_since(self: "Database", since: str) -> int:
        """Auto-replies queued since `since` — the daily-cap denominator."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS n FROM outbound_messages "
                "WHERE origin = 'autoreply' AND created_at >= ?",
                (since,),
            )
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
