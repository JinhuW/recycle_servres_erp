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
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .db import SCHEMA, WORKER_HEALTH_COLUMNS, utcnow

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
                "SELECT account_id, worker_id, fb_username, region, proxy, vnc_url, "
                "allow_password_login, created_at, updated_at FROM accounts ORDER BY account_id"
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
