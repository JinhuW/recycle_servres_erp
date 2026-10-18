"""PostgreSQL storage for the coordinator.

A drop-in replacement for :class:`rs_coordinator.db.Database`. Same tables, same
column names, same method signatures, same return types (plain ``dict`` rows) —
so nothing above this layer knows or cares which backend is in use.

Why it exists: SQLite is a single file on a single box. Railway gives every
deploy a fresh filesystem, so the control plane's accounts, challenges and
session snapshots evaporate on redeploy. Pointing ``RS_DATABASE_URL`` at a
managed Postgres makes them survive.

Deliberate non-translations — each of these would be "more correct" in
Postgres and would break the code above:

* Timestamps stay ``TEXT`` (ISO strings from ``db.utcnow``). ``query_listings``
  filters with ``>=`` on the string and ``health._parse_ts`` parses it back.
  A ``TIMESTAMPTZ`` column would hand callers ``datetime`` objects and quietly
  break both.
* ``browser_ok`` / ``proxy_ok`` / ``allow_password_login`` stay ``INTEGER``
  holding 1/0. Native ``BOOLEAN`` would return Python ``bool`` where callers
  (``vault.get_account``, ``routers/auth``) expect the int they wrote.

The only real translations are ``BLOB``→``BYTEA``, the autoincrement key, and
the placeholder style — see :func:`postgres_schema`.
"""

import json
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .db import (
    ACCOUNT_EXTRA_COLUMNS,
    ALERT_HIT_SQL,
    LISTING_EXTRA_COLUMNS,
    OUTBOUND_EXTRA_COLUMNS,
    REVIEW_STAT_COUNTERS,
    REVIEW_STATS_EXTRA_COLUMNS,
    REVIEW_STATS_SUMS,
    SCHEMA,
    SEARCH_CYCLE_DAYS,
    SNAPSHOT_EXTRA_COLUMNS,
    THREAD_EXTRA_COLUMNS,
    UNMATCHED_REACTIONS_SQL,
    WORKER_HEALTH_COLUMNS,
    review_stat_deltas,
    review_stats_row,
    stats_cutoff,
    utcnow,
)

# Guards concurrent schema creation. Deliberately different from the reddit
# tracker's 778431 so the two projects can never block each other if they ever
# do end up sharing a cluster.
ADVISORY_LOCK_KEY = 914273

# Small on purpose: this process makes a handful of queries per minute, and
# Railway's connection allowance is not generous.
POOL_MIN_SIZE = 1
POOL_MAX_SIZE = 4
# Railway's TCP proxy hangs up on idle connections. Recycle ours first so a
# request never picks up a socket the proxy has already dropped.
POOL_MAX_IDLE = 30.0
POOL_MAX_LIFETIME = 30 * 60.0

# Hosts that do not speak TLS, so `sslmode=require` must not be forced on them.
_PLAINTEXT_HOSTS = {"localhost", "127.0.0.1", "::1", ""}
_URL_SCHEMES = ("postgresql://", "postgres://", "postgresql+psycopg://")


def normalize_url(url: str) -> str:
    """Apply ``sslmode=require`` unless the URL already decided, or is local.

    Railway's public proxy (``DATABASE_PUBLIC_URL``) refuses plaintext, and its
    URLs do not carry an sslmode. An explicit setting is always left alone, and
    loopback / ``*.railway.internal`` hosts are skipped because neither offers
    TLS by default — forcing it there turns a working URL into a failure.
    """
    url = url.strip()
    if not url.startswith(_URL_SCHEMES):
        # A libpq keyword/value DSN ("host=... sslmode=..."). Not ours to edit.
        return url

    parsed = urlsplit(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "sslmode" in params:
        return url

    host = (parsed.hostname or "").lower()
    if host in _PLAINTEXT_HOSTS or host.endswith(".railway.internal"):
        return url

    params["sslmode"] = "require"
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(params), parsed.fragment)
    )


def postgres_schema() -> str:
    """The SQLite ``SCHEMA`` rendered as Postgres DDL.

    Derived from the one definition in ``db.py`` rather than copied, so the two
    backends cannot drift. Only two constructs actually need translating —
    everything else in SCHEMA (TEXT, INTEGER, DEFAULT, PRIMARY KEY,
    CREATE INDEX IF NOT EXISTS) is already valid Postgres.
    """
    ddl = re.sub(
        r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT",
        "INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        SCHEMA,
        flags=re.IGNORECASE,
    )
    ddl = re.sub(r"\bBLOB\b", "BYTEA", ddl, flags=re.IGNORECASE)
    return ddl


def _value(value: Any) -> Any:
    """Normalize a driver value to what the SQLite backend would have returned.

    Postgres BYTEA may arrive as ``memoryview`` depending on the result format.
    Callers compare blobs with ``==`` against ``bytes`` literals and hand them
    to ``vault.decrypt``, so collapse them to ``bytes`` on the way out.
    """
    if isinstance(value, (memoryview, bytearray)):
        return bytes(value)
    return value


def _row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    return {key: _value(val) for key, val in row.items()}


def _rows(rows: Any) -> List[Dict[str, Any]]:
    return [{key: _value(val) for key, val in row.items()} for row in rows]


class PostgresDatabase:
    """Mirror of :class:`rs_coordinator.db.Database`, backed by psycopg 3.

    Concurrency is handled by the connection pool rather than the single
    connection + ``threading.Lock`` the SQLite class uses, so requests no
    longer serialize on one mutex.
    """

    def __init__(
        self: "PostgresDatabase",
        url: str,
        *,
        min_size: int = POOL_MIN_SIZE,
        max_size: int = POOL_MAX_SIZE,
    ) -> None:
        # Imported here rather than at module scope so that SQLite-only
        # installs — including the whole test suite — never need psycopg.
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        self.url = normalize_url(url)
        # `path` so anything that logged the SQLite location keeps working; the
        # value is the DSN with its password left in place only if the caller
        # put one there, so never log it.
        self.path = self.url
        self._pool = ConnectionPool(
            self.url,
            min_size=min_size,
            max_size=max_size,
            max_idle=POOL_MAX_IDLE,
            max_lifetime=POOL_MAX_LIFETIME,
            kwargs={"row_factory": dict_row},
            open=True,
        )
        try:
            self._pool.wait(timeout=float(os.environ.get("RS_PG_CONNECT_TIMEOUT", "10")))
            self._create_schema()
        except BaseException:
            self._pool.close()
            raise

    # -- setup -------------------------------------------------------------

    def _create_schema(self: "PostgresDatabase") -> None:
        """Create tables idempotently, serialized against other starting pods.

        ``CREATE TABLE IF NOT EXISTS`` is not race-free in Postgres — two pods
        booting together can still collide on the catalog — so hold a session
        advisory lock across creation and the additive migration.
        """
        with self._pool.connection() as conn:
            conn.execute("SELECT pg_advisory_lock(%s)", (ADVISORY_LOCK_KEY,))
            try:
                conn.execute(postgres_schema())
                self._migrate_workers(conn)
                self._migrate_listings(conn)
                self._migrate_columns(conn, "threads", THREAD_EXTRA_COLUMNS)
                self._migrate_columns(conn, "outbound_messages", OUTBOUND_EXTRA_COLUMNS)
                self._migrate_columns(conn, "session_snapshots", SNAPSHOT_EXTRA_COLUMNS)
                self._migrate_columns(conn, "review_stats", REVIEW_STATS_EXTRA_COLUMNS)
                self._migrate_columns(conn, "accounts", ACCOUNT_EXTRA_COLUMNS)
                # Created after the migration adds the columns they index.
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_threads_room ON threads(matrix_room_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_threads_topic ON threads(telegram_topic_id)"
                )
                conn.commit()
            finally:
                conn.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_LOCK_KEY,))
                conn.commit()

    @staticmethod
    def _migrate_workers(conn: Any) -> None:
        """Add the health columns to a `workers` table created before them."""
        cur = conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'workers'"
        )
        existing = {row["column_name"] for row in cur.fetchall()}
        for column, decl in WORKER_HEALTH_COLUMNS:
            if column not in existing:
                conn.execute(f"ALTER TABLE workers ADD COLUMN IF NOT EXISTS {column} {decl}")

    @staticmethod
    def _migrate_listings(conn: Any) -> None:
        """Add later columns to a `listings` table created before them."""
        cur = conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'listings'"
        )
        existing = {row["column_name"] for row in cur.fetchall()}
        for column, decl in LISTING_EXTRA_COLUMNS:
            if column not in existing:
                conn.execute(f"ALTER TABLE listings ADD COLUMN IF NOT EXISTS {column} {decl}")

    @staticmethod
    def _migrate_columns(conn: Any, table: str, columns: tuple) -> None:
        """Add missing columns to `table`. `table` is a fixed module literal."""
        cur = conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = %s",
            (table,),
        )
        existing = {row["column_name"] for row in cur.fetchall()}
        for column, decl in columns:
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {decl}")

    @contextmanager
    def cursor(self: "PostgresDatabase") -> Iterator[Any]:
        """Same contract as the SQLite ``cursor()``: yield, commit, close."""
        with self._pool.connection() as conn:
            cur = conn.cursor()
            try:
                yield cur
                conn.commit()
            finally:
                cur.close()

    def close(self: "PostgresDatabase") -> None:
        self._pool.close()

    # -- listings ----------------------------------------------------------

    def get_listing(self: "PostgresDatabase", dedupe_key: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM listings WHERE dedupe_key = %s", (dedupe_key,))
            row = cur.fetchone()
        return _row(row)

    def insert_listing(self: "PostgresDatabase", record: Dict[str, Any]) -> None:
        columns = ", ".join(record)
        placeholders = ", ".join(f"%({name})s" for name in record)
        with self.cursor() as cur:
            cur.execute(f"INSERT INTO listings ({columns}) VALUES ({placeholders})", record)

    def claim_listing(self: "PostgresDatabase", record: Dict[str, Any]) -> bool:
        """See `Database.claim_listing`. True only for the caller that inserted."""
        columns = ", ".join(record)
        placeholders = ", ".join(f"%({name})s" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO listings ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT (dedupe_key) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def update_listing(
        self: "PostgresDatabase", dedupe_key: str, fields: Dict[str, Any]
    ) -> None:
        assignments = ", ".join(f"{name} = %({name})s" for name in fields)
        params = {**fields, "dedupe_key": dedupe_key}
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE listings SET {assignments} WHERE dedupe_key = %(dedupe_key)s", params
            )

    def record_sighting(
        self: "PostgresDatabase",
        dedupe_key: str,
        worker_id: str,
        price: str | None,
        ai_score: int | None,
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO sightings (dedupe_key, worker_id, seen_at, price, ai_score) "
                "VALUES (%s, %s, %s, %s, %s)",
                (dedupe_key, worker_id, utcnow(), price, ai_score),
            )

    def query_listings(
        self: "PostgresDatabase",
        since: str | None = None,
        min_score: int | None = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM listings WHERE 1=1"
        params: List[Any] = []
        if since:
            sql += " AND last_seen_at >= %s"
            params.append(since)
        if min_score is not None:
            sql += " AND ai_score >= %s"
            params.append(min_score)
        sql += " ORDER BY last_seen_at DESC LIMIT %s"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return _rows(cur.fetchall())

    def count_sightings(self: "PostgresDatabase", dedupe_key: str) -> int:
        with self.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS n FROM sightings WHERE dedupe_key = %s", (dedupe_key,)
            )
            return int(cur.fetchone()["n"])

    # -- alert outbox ------------------------------------------------------

    def enqueue_alert(
        self: "PostgresDatabase", kind: str, text: str, dedupe_key: str | None = None
    ) -> int:
        now = utcnow()
        with self.cursor() as cur:
            # No `lastrowid` in Postgres — ask for the generated key back.
            cur.execute(
                "INSERT INTO outbox (kind, dedupe_key, text, created_at, next_attempt_at) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (kind, dedupe_key, text, now, now),
            )
            return int(cur.fetchone()["id"])

    def due_alerts(
        self: "PostgresDatabase", now: str | None = None, limit: int = 20
    ) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= %s "
                "ORDER BY id LIMIT %s",
                (now or utcnow(), limit),
            )
            return _rows(cur.fetchall())

    def mark_alert_delivered(self: "PostgresDatabase", alert_id: int) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbox SET delivered_at = %s, last_error = NULL WHERE id = %s",
                (utcnow(), alert_id),
            )

    def mark_alert_failed(
        self: "PostgresDatabase", alert_id: int, error: str, next_attempt_at: str
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbox SET attempts = attempts + 1, last_error = %s, "
                "next_attempt_at = %s WHERE id = %s",
                (error, next_attempt_at, alert_id),
            )

    def outbox_backlog(self: "PostgresDatabase") -> int:
        with self.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL")
            return int(cur.fetchone()["n"])

    # -- telegram reply cursor ---------------------------------------------

    def get_telegram_offset(self: "PostgresDatabase") -> int:
        with self.cursor() as cur:
            cur.execute("SELECT update_offset FROM telegram_offset WHERE id = 1")
            row = cur.fetchone()
        return int(row["update_offset"]) if row else 0

    def set_telegram_offset(self: "PostgresDatabase", offset: int) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO telegram_offset (id, update_offset) VALUES (1, %s) "
                "ON CONFLICT(id) DO UPDATE SET update_offset = excluded.update_offset",
                (offset,),
            )

    # -- messenger threads / messages --------------------------------------

    def upsert_thread(self: "PostgresDatabase", thread_id: str, fields: Dict[str, Any]) -> None:
        record = {"thread_id": thread_id, "created_at": utcnow(), **fields}
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        assignments = ", ".join(
            f"{name} = COALESCE(excluded.{name}, threads.{name})" for name in fields
        )
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO threads ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(thread_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_thread(self: "PostgresDatabase", thread_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE thread_id = %s", (thread_id,))
            row = cur.fetchone()
        return _row(row)

    def list_threads(self: "PostgresDatabase", limit: int = 100) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads ORDER BY last_message_at DESC LIMIT %s", (limit,))
            return _rows(cur.fetchall())

    def set_thread_fields(
        self: "PostgresDatabase", thread_id: str, fields: Dict[str, Any]
    ) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = %({name})s" for name in fields)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE threads SET {assignments} WHERE thread_id = %(thread_id)s",
                {**fields, "thread_id": thread_id},
            )

    def get_thread_by_topic(
        self: "PostgresDatabase", topic_id: int
    ) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE telegram_topic_id = %s", (topic_id,))
            row = cur.fetchone()
        return _row(row)

    def get_thread_by_room(
        self: "PostgresDatabase", matrix_room_id: str
    ) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM threads WHERE matrix_room_id = %s", (matrix_room_id,))
            row = cur.fetchone()
        return _row(row)

    def claim_message(self: "PostgresDatabase", record: Dict[str, Any]) -> bool:
        """See `Database.claim_message`. True only for the caller that inserted."""
        record = {"created_at": utcnow(), **record}
        columns = ", ".join(record)
        placeholders = ", ".join(f"%({name})s" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO messages ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT (fingerprint) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def list_messages(
        self: "PostgresDatabase", thread_id: str, limit: int = 100
    ) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT * FROM messages WHERE thread_id = %s ORDER BY created_at, fingerprint "
                "LIMIT %s",
                (thread_id, limit),
            )
            return _rows(cur.fetchall())

    def count_messages(
        self: "PostgresDatabase", thread_id: str, direction: str | None = None
    ) -> int:
        sql = "SELECT COUNT(*) AS n FROM messages WHERE thread_id = %s"
        params: List[Any] = [thread_id]
        if direction:
            sql += " AND direction = %s"
            params.append(direction)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return int(cur.fetchone()["n"])

    # -- outbound replies --------------------------------------------------

    def enqueue_outbound(
        self: "PostgresDatabase",
        thread_id: str,
        worker_id: str | None,
        text: str,
        origin: str,
        transport: str = "playwright",
    ) -> int:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO outbound_messages (thread_id, worker_id, text, origin, "
                "transport, status, created_at) VALUES (%s, %s, %s, %s, %s, 'queued', %s) "
                "RETURNING id",
                (thread_id, worker_id, text, origin, transport, utcnow()),
            )
            return int(cur.fetchone()["id"])

    def pending_outbound(
        self: "PostgresDatabase",
        worker_id: str | None = None,
        limit: int = 10,
        transport: str | None = None,
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM outbound_messages WHERE status = 'queued'"
        params: List[Any] = []
        if transport:
            sql += " AND transport = %s"
            params.append(transport)
        if worker_id:
            sql += " AND (worker_id = %s OR worker_id IS NULL)"
            params.append(worker_id)
        sql += " ORDER BY id LIMIT %s"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return _rows(cur.fetchall())

    def get_outbound(self: "PostgresDatabase", outbound_id: int) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM outbound_messages WHERE id = %s", (outbound_id,))
            row = cur.fetchone()
        return _row(row)

    def mark_outbound(
        self: "PostgresDatabase", outbound_id: int, status: str, error: str | None = None
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE outbound_messages SET status = %s, last_error = %s, "
                "attempts = attempts + 1, "
                "sent_at = CASE WHEN %s = 'sent' THEN %s ELSE sent_at END "
                "WHERE id = %s",
                (status, error, status, utcnow(), outbound_id),
            )

    def count_autoreplies_since(self: "PostgresDatabase", since: str) -> int:
        with self.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS n FROM outbound_messages "
                "WHERE origin = 'autoreply' AND created_at >= %s",
                (since,),
            )
            return int(cur.fetchone()["n"])

    # -- workers -----------------------------------------------------------

    def upsert_worker(
        self: "PostgresDatabase",
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
                "last_heartbeat_at, last_listing_at) VALUES (%s, %s, %s, %s, %s, %s) "
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

    def list_workers(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM workers ORDER BY worker_id")
            return _rows(cur.fetchall())

    def get_worker(self: "PostgresDatabase", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM workers WHERE worker_id = %s", (worker_id,))
            row = cur.fetchone()
        return _row(row)

    def update_worker_health(
        self: "PostgresDatabase", worker_id: str, fields: Dict[str, Any]
    ) -> None:
        """Upsert only the health columns this heartbeat actually carried."""
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
        placeholders = ", ".join(["%s"] * (len(updates) + 1))
        assignments = ", ".join(f"{name} = excluded.{name}" for name in updates)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO workers ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(worker_id) DO UPDATE SET {assignments}",
                (worker_id, *updates.values()),
            )

    def request_relogin(self: "PostgresDatabase", worker_id: str) -> None:
        """Flag a worker to re-run its Facebook login on its next heartbeat."""
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO workers (worker_id, relogin_requested_at, relogin_last_requested_at) "
                "VALUES (%s, %s, %s) "
                "ON CONFLICT(worker_id) DO UPDATE "
                "SET relogin_requested_at = excluded.relogin_requested_at, "
                "relogin_last_requested_at = excluded.relogin_last_requested_at",
                (worker_id, now, now),
            )

    def take_relogin(self: "PostgresDatabase", worker_id: str) -> bool:
        """Consume a pending re-login request, returning whether one was set."""
        with self.cursor() as cur:
            cur.execute(
                "UPDATE workers SET relogin_requested_at = NULL "
                "WHERE worker_id = %s AND relogin_requested_at IS NOT NULL",
                (worker_id,),
            )
            return cur.rowcount > 0

    # -- review stats ------------------------------------------------------

    def add_review_stats(
        self: "PostgresDatabase", worker_id: str, day: str | None = None, **counts: int
    ) -> None:
        """See `Database.add_review_stats`."""
        columns, values = review_stat_deltas(counts)
        if not columns:
            return
        day = day or utcnow()[:10]
        names = ", ".join(columns)
        updates = ", ".join(f"{c} = review_stats.{c} + excluded.{c}" for c in columns)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO review_stats (day, worker_id, {names}, updated_at) "
                f"VALUES (%s, %s, {', '.join('%s' for _ in columns)}, %s) "
                f"ON CONFLICT(day, worker_id) DO UPDATE SET {updates}, "
                "  updated_at = excluded.updated_at",
                (day, worker_id, *values, utcnow()),
            )

    def review_stats_daily(
        self: "PostgresDatabase", days: int = 14
    ) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                f"SELECT day, {REVIEW_STATS_SUMS} FROM review_stats "
                "WHERE day >= %s GROUP BY day ORDER BY day",
                (stats_cutoff(days),),
            )
            return [review_stats_row(row) for row in _rows(cur.fetchall())]

    def review_stats_by_worker(
        self: "PostgresDatabase", days: int = 2
    ) -> List[Dict[str, Any]]:
        """See `Database.review_stats_by_worker`."""
        with self.cursor() as cur:
            cur.execute(
                f"SELECT day, worker_id, {', '.join(REVIEW_STAT_COUNTERS)}, updated_at "
                "FROM review_stats WHERE day >= %s ORDER BY day, worker_id",
                (stats_cutoff(days),),
            )
            return _rows(cur.fetchall())

    # -- search cycles -----------------------------------------------------

    def log_search_cycle(
        self: "PostgresDatabase", worker_id: str, at: str, item: str | None = None
    ) -> None:
        """See `Database.log_search_cycle`."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=SEARCH_CYCLE_DAYS)).isoformat(
            timespec="seconds"
        )
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO search_cycles (worker_id, at, item) VALUES (%s, %s, %s)",
                (worker_id, at, item),
            )
            cur.execute("DELETE FROM search_cycles WHERE at < %s", (cutoff,))

    def search_cycles_since(self: "PostgresDatabase", since: str) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT worker_id, at, item FROM search_cycles WHERE at >= %s ORDER BY at",
                (since,),
            )
            return _rows(cur.fetchall())

    def touch_search_city(self: "PostgresDatabase", worker_id: str, city: str) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO search_cities (worker_id, city, last_at) VALUES (%s, %s, %s) "
                "ON CONFLICT(worker_id, city) DO UPDATE SET last_at = excluded.last_at",
                (worker_id, city, utcnow()),
            )

    def search_cities(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT worker_id, city, last_at FROM search_cities ORDER BY worker_id, city"
            )
            return _rows(cur.fetchall())

    def city_tier_config(self: "PostgresDatabase") -> Dict[str, Any]:
        with self.cursor() as cur:
            cur.execute("SELECT body, updated_at, updated_by FROM city_tier_settings WHERE id = 1")
            row = _row(cur.fetchone())
            cur.execute("SELECT city, per_day FROM city_tier_pins ORDER BY city")
            pins = {r["city"]: int(r["per_day"]) for r in _rows(cur.fetchall())}
        return {
            "settings": json.loads(row["body"]) if row else {},
            "pins": pins,
            "updated_at": row["updated_at"] if row else None,
            "updated_by": row["updated_by"] if row else None,
        }

    def put_city_tier_config(
        self: "PostgresDatabase",
        settings: Optional[Dict[str, Any]],
        pins: Optional[Dict[str, int]],
        updated_by: Optional[str],
    ) -> None:
        with self.cursor() as cur:
            if settings is not None:
                cur.execute(
                    "INSERT INTO city_tier_settings (id, body, updated_at, updated_by) "
                    "VALUES (1, %s, %s, %s) ON CONFLICT(id) DO UPDATE SET body = excluded.body, "
                    "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                    (json.dumps(settings), utcnow(), updated_by),
                )
            if pins is not None:
                cur.execute("DELETE FROM city_tier_pins")
                cur.executemany(
                    "INSERT INTO city_tier_pins (city, per_day) VALUES (%s, %s)",
                    list(pins.items()),
                )

    # -- incidents ---------------------------------------------------------

    _INCIDENT_COLUMNS = (
        "key", "is_open", "opened_at", "closed_at", "last_reported_at",
        "last_alerted_at", "alerted", "detail", "reporters",
    )

    def get_incident(self: "PostgresDatabase", key: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM incidents WHERE key = %s", (key,))
            return _row(cur.fetchone())

    def save_incident(self: "PostgresDatabase", row: Dict[str, Any]) -> None:
        """See `Database.save_incident`."""
        record = {name: row.get(name) for name in self._INCIDENT_COLUMNS}
        columns = ", ".join(record)
        placeholders = ", ".join(f"%({name})s" for name in record)
        updates = ", ".join(f"{name} = EXCLUDED.{name}" for name in record if name != "key")
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO incidents ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT (key) DO UPDATE SET {updates}",
                record,
            )

    def list_incidents(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM incidents ORDER BY key")
            return [_row(r) for r in cur.fetchall()]

    # -- alert hit tracking ------------------------------------------------

    def add_alert_message(self: "PostgresDatabase", record: Dict[str, Any]) -> bool:
        """See `Database.add_alert_message`. True only for the first report."""
        record = {"sent_at": utcnow(), **record}
        columns = ", ".join(record)
        placeholders = ", ".join(f"%({name})s" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO alert_messages ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT (chat_id, message_id) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def record_alert_reaction(
        self: "PostgresDatabase",
        chat_id: str,
        message_id: int,
        user_id: str,
        user_name: str | None,
        old_reaction: str,
        new_reaction: str,
        emoji: str,
        reacted_at: str | None,
    ) -> None:
        """See `Database.record_alert_reaction`."""
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO alert_reaction_events (chat_id, message_id, user_id, "
                "user_name, old_reaction, new_reaction, reacted_at, recorded_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    chat_id,
                    message_id,
                    user_id,
                    user_name,
                    old_reaction,
                    new_reaction,
                    reacted_at,
                    now,
                ),
            )
            cur.execute(
                "INSERT INTO alert_reactions (chat_id, message_id, user_id, user_name, "
                "emoji, first_reacted_at, last_updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (chat_id, message_id, user_id) DO UPDATE SET "
                "  user_name = excluded.user_name,"
                "  emoji = excluded.emoji,"
                "  first_reacted_at = COALESCE(alert_reactions.first_reacted_at,"
                "                              excluded.first_reacted_at),"
                "  last_updated_at = excluded.last_updated_at",
                (
                    chat_id,
                    message_id,
                    user_id,
                    user_name,
                    emoji,
                    (reacted_at or now) if emoji != "[]" else None,
                    now,
                ),
            )

    def alert_hit_stats(self: "PostgresDatabase", days: int = 14) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(ALERT_HIT_SQL.format(p="%s"), (stats_cutoff(days),))
            rows = _rows(cur.fetchall())
        # COUNT/SUM come back as Decimal from psycopg; the API contract is int.
        return [
            {
                "day": row["day"],
                "priority": row["priority"],
                "item_name": row["item_name"],
                "search_city": row["search_city"],
                "sent": int(row["sent"]),
                "hit": int(row["hit"]),
            }
            for row in rows
        ]

    def unmatched_reaction_count(self: "PostgresDatabase", days: int = 14) -> int:
        with self.cursor() as cur:
            cur.execute(UNMATCHED_REACTIONS_SQL.format(p="%s"), (stats_cutoff(days),))
            return int(cur.fetchone()["n"])

    # -- accounts ----------------------------------------------------------

    def put_account(self: "PostgresDatabase", account_id: str, fields: Dict[str, Any]) -> None:
        now = utcnow()
        record = {"account_id": account_id, "updated_at": now, **fields}
        record.setdefault("created_at", now)
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        assignments = ", ".join(
            f"{name} = excluded.{name}"
            for name in record
            if name not in ("account_id", "created_at")
        )
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO accounts ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(account_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_account_row(self: "PostgresDatabase", account_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM accounts WHERE account_id = %s", (account_id,))
            row = cur.fetchone()
        return _row(row)

    def account_row_for_worker(
        self: "PostgresDatabase", worker_id: str
    ) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM accounts WHERE worker_id = %s", (worker_id,))
            row = cur.fetchone()
        return _row(row)

    def list_accounts(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        """Non-secret account fields only — never returns secret_blob."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT account_id, worker_id, fb_username, fb_uid, region, proxy, vnc_url, "
                "allow_password_login, fleet_enabled, pin_host, created_at, updated_at "
                "FROM accounts ORDER BY account_id"
            )
            return _rows(cur.fetchall())

    def delete_account(self: "PostgresDatabase", account_id: str) -> bool:
        with self.cursor() as cur:
            cur.execute("DELETE FROM accounts WHERE account_id = %s", (account_id,))
            return cur.rowcount > 0

    # -- challenges --------------------------------------------------------

    def insert_challenge(self: "PostgresDatabase", record: Dict[str, Any]) -> int:
        record = {"created_at": utcnow(), "status": "open", **record}
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        with self.cursor() as cur:
            # No `lastrowid` in Postgres — ask for the generated key back.
            cur.execute(
                f"INSERT INTO challenges ({columns}) VALUES ({placeholders}) RETURNING id",
                tuple(record.values()),
            )
            return int(cur.fetchone()["id"])

    def update_challenge(
        self: "PostgresDatabase", challenge_id: int, fields: Dict[str, Any]
    ) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = %s" for name in fields)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE challenges SET {assignments} WHERE id = %s",
                (*fields.values(), challenge_id),
            )

    def get_challenge(self: "PostgresDatabase", challenge_id: int) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM challenges WHERE id = %s", (challenge_id,))
            row = cur.fetchone()
        return _row(row)

    def list_challenges(
        self: "PostgresDatabase", status: str | None = "open", limit: int = 100
    ) -> List[Dict[str, Any]]:
        sql = "SELECT * FROM challenges"
        params: List[Any] = []
        if status and status != "all":
            sql += " WHERE status = %s"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT %s"
        params.append(limit)
        with self.cursor() as cur:
            cur.execute(sql, params)
            return _rows(cur.fetchall())

    def resolve_challenge(
        self: "PostgresDatabase", challenge_id: int, resolved_by: str | None
    ) -> bool:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE challenges SET status = 'resolved', resolved_at = %s, resolved_by = %s "
                "WHERE id = %s AND status != 'resolved'",
                (utcnow(), resolved_by, challenge_id),
            )
            return cur.rowcount > 0

    # -- session snapshots -------------------------------------------------

    def upsert_snapshot(self: "PostgresDatabase", worker_id: str, fields: Dict[str, Any]) -> None:
        record = {"worker_id": worker_id, "backed_up_at": utcnow(), **fields}
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        assignments = ", ".join(
            f"{name} = excluded.{name}" for name in record if name != "worker_id"
        )
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO session_snapshots ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(worker_id) DO UPDATE SET {assignments}",
                tuple(record.values()),
            )

    def get_snapshot(self: "PostgresDatabase", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM session_snapshots WHERE worker_id = %s", (worker_id,))
            row = cur.fetchone()
        return _row(row)

    # -- device profiles ---------------------------------------------------

    def get_device_profile(
        self: "PostgresDatabase", identity_key: str
    ) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM device_profiles WHERE identity_key = %s", (identity_key,))
            row = cur.fetchone()
        return _row(row)

    def device_profile_by_device(
        self: "PostgresDatabase", device_id: str
    ) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM device_profiles WHERE device_id = %s", (device_id,))
            row = cur.fetchone()
        return _row(row)

    def insert_device_profile(self: "PostgresDatabase", record: Dict[str, Any]) -> bool:
        now = utcnow()
        record = {"created_at": now, "updated_at": now, **record}
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO device_profiles ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT(identity_key) DO NOTHING",
                tuple(record.values()),
            )
            return cur.rowcount > 0

    def update_device_profile(
        self: "PostgresDatabase", identity_key: str, fields: Dict[str, Any]
    ) -> None:
        if not fields:
            return
        record = {**fields, "updated_at": utcnow()}
        assignments = ", ".join(f"{name} = %s" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE device_profiles SET {assignments} WHERE identity_key = %s",
                (*record.values(), identity_key),
            )

    def claim_device_cookies(self: "PostgresDatabase", identity_key: str, blob: bytes) -> bool:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE device_profiles SET device_cookies_blob = %s, updated_at = %s "
                "WHERE identity_key = %s AND device_cookies_blob IS NULL",
                (blob, utcnow(), identity_key),
            )
            return cur.rowcount > 0

    def rekey_device_profile(self: "PostgresDatabase", old_key: str, new_key: str) -> bool:
        with self.cursor() as cur:
            cur.execute(
                "UPDATE device_profiles SET identity_key = %s, updated_at = %s "
                "WHERE identity_key = %s AND NOT EXISTS "
                "(SELECT 1 FROM device_profiles WHERE identity_key = %s)",
                (new_key, utcnow(), old_key, new_key),
            )
            return cur.rowcount > 0

    def list_device_profiles(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT identity_key, device_id, fb_uid, user_agent, viewport_w, viewport_h, "
                "screen_w, screen_h, device_scale_factor, locale, timezone_id, source, "
                "CASE WHEN device_cookies_blob IS NULL THEN 0 ELSE 1 END AS has_device_cookies, "
                "created_at, updated_at "
                "FROM device_profiles ORDER BY identity_key"
            )
            return _rows(cur.fetchall())

    # -- fleet -------------------------------------------------------------

    def upsert_fleet_host(
        self: "PostgresDatabase", host_id: str, fields: Dict[str, Any]
    ) -> None:
        record = {"host_id": host_id, **fields}
        columns = ", ".join([*record, "created_at"])
        placeholders = ", ".join(["%s"] * (len(record) + 1))
        assignments = ", ".join(f"{name} = excluded.{name}" for name in fields)
        conflict = f"DO UPDATE SET {assignments}" if assignments else "DO NOTHING"
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO fleet_hosts ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(host_id) {conflict}",
                (*record.values(), utcnow()),
            )

    def get_fleet_host(self: "PostgresDatabase", host_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_hosts WHERE host_id = %s", (host_id,))
            row = cur.fetchone()
        return _row(row)

    def list_fleet_hosts(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_hosts ORDER BY host_id")
            return _rows(cur.fetchall())

    def put_assignment(
        self: "PostgresDatabase", worker_id: str, fields: Dict[str, Any]
    ) -> None:
        now = utcnow()
        record = {**fields, "updated_at": now}
        assignments = ", ".join(f"{name} = %s" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE fleet_assignments SET {assignments} WHERE worker_id = %s",
                (*record.values(), worker_id),
            )
            if cur.rowcount:
                return
            row = {"worker_id": worker_id, **record, "created_at": now}
            cur.execute(
                f"INSERT INTO fleet_assignments ({', '.join(row)}) "
                f"VALUES ({', '.join(['%s'] * len(row))})",
                tuple(row.values()),
            )

    def get_assignment(self: "PostgresDatabase", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_assignments WHERE worker_id = %s", (worker_id,))
            row = cur.fetchone()
        return _row(row)

    def list_assignments(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_assignments ORDER BY worker_id")
            return _rows(cur.fetchall())

    def insert_release(self: "PostgresDatabase", record: Dict[str, Any]) -> int:
        record = {"created_at": utcnow(), **record}
        columns = ", ".join(record)
        placeholders = ", ".join(["%s"] * len(record))
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO fleet_releases ({columns}) VALUES ({placeholders}) RETURNING id",
                tuple(record.values()),
            )
            return int(cur.fetchone()["id"])

    def update_release(
        self: "PostgresDatabase", release_id: int, fields: Dict[str, Any]
    ) -> None:
        if not fields:
            return
        assignments = ", ".join(f"{name} = %s" for name in fields)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE fleet_releases SET {assignments} WHERE id = %s",
                (*fields.values(), release_id),
            )

    def get_release(self: "PostgresDatabase", release_id: int) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_releases WHERE id = %s", (release_id,))
            row = cur.fetchone()
        return _row(row)

    def list_releases(self: "PostgresDatabase", limit: int = 20) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM fleet_releases ORDER BY id DESC LIMIT %s", (limit,))
            return _rows(cur.fetchall())

    def put_worker_config(
        self: "PostgresDatabase",
        worker_id: str,
        toml: str,
        sha256: str,
        updated_by: str | None,
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO worker_configs (worker_id, toml, sha256, updated_at, updated_by) "
                "VALUES (%s, %s, %s, %s, %s) ON CONFLICT(worker_id) DO UPDATE SET "
                "toml = excluded.toml, sha256 = excluded.sha256, "
                "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                (worker_id, toml, sha256, utcnow(), updated_by),
            )

    def get_worker_config(self: "PostgresDatabase", worker_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM worker_configs WHERE worker_id = %s", (worker_id,))
            row = cur.fetchone()
        return _row(row)

    def list_worker_configs(self: "PostgresDatabase") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT worker_id, sha256, updated_at, updated_by FROM worker_configs "
                "ORDER BY worker_id"
            )
            return _rows(cur.fetchall())

    def delete_worker_config(self: "PostgresDatabase", worker_id: str) -> bool:
        with self.cursor() as cur:
            cur.execute("DELETE FROM worker_configs WHERE worker_id = %s", (worker_id,))
            return cur.rowcount > 0

    # -- audit -------------------------------------------------------------

    def insert_code_audit(
        self: "PostgresDatabase",
        worker_id: str | None,
        account_id: str | None,
        kind: str,
        reason: str | None = None,
    ) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO code_audit (worker_id, account_id, kind, reason, released_at) "
                "VALUES (%s, %s, %s, %s, %s)",
                (worker_id, account_id, kind, reason, utcnow()),
            )

    def list_code_audit(self: "PostgresDatabase", limit: int = 100) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM code_audit ORDER BY released_at DESC LIMIT %s", (limit,))
            return _rows(cur.fetchall())
