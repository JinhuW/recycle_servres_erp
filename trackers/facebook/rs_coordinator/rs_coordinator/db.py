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
from datetime import datetime, timedelta, timezone
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

-- Review stats --------------------------------------------------------------
-- Daily counts of each stage a listing passes on its way from a search to an
-- alert, one row per worker per UTC day (columns in REVIEW_STAT_COUNTERS; the
-- later ones are added by migration). Workers report per-page deltas and the
-- coordinator adds its own two stages; the upsert accumulates. Feeds the ERP
-- dashboard and nothing in the alert path reads it.
CREATE TABLE IF NOT EXISTS review_stats (
    day        TEXT NOT NULL,
    worker_id  TEXT NOT NULL,
    reviewed   INTEGER NOT NULL DEFAULT 0,
    alerted    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (day, worker_id)
);

-- Search cycles --------------------------------------------------------------
-- When each worker started searching an item: a heartbeat carrying a new
-- `last_search_at` (the monitor stamps one per item, then walks every city x
-- phrase, and its repeater re-sends the same stamp). review_stats counts what
-- a sweep did per UTC day but not when it began; this is the start of the
-- fleet table's day strip. Pruned to SEARCH_CYCLE_DAYS; nothing in the alert
-- path reads it.
CREATE TABLE IF NOT EXISTS search_cycles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id  TEXT NOT NULL,
    at         TEXT NOT NULL,
    item       TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_cycles_at ON search_cycles(at);

-- When each worker last searched each city: the funnel report that counts a
-- search names its city. One row per worker x city, so it needs no pruning;
-- the console keeps the ones inside the worker's local day.
CREATE TABLE IF NOT EXISTS search_cities (
    worker_id  TEXT NOT NULL,
    city       TEXT NOT NULL,
    last_at    TEXT NOT NULL,
    PRIMARY KEY (worker_id, city)
);

-- How often each city is searched (city_tiers.py): the tier settings as one
-- JSON row, and the cities a manager pinned to a searches-a-day count. The
-- rank itself is computed on read from alert_messages, never stored.
CREATE TABLE IF NOT EXISTS city_tier_settings (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    body        TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
);
CREATE TABLE IF NOT EXISTS city_tier_pins (
    city     TEXT PRIMARY KEY,
    per_day  INTEGER NOT NULL
);

-- Alert hit tracking ---------------------------------------------------------
-- The homelab monitor sends listing alerts straight to Telegram and reports
-- each delivered message here (fail-open, after the send). Partners mark an
-- alert they are acting on with an emoji reaction; the update consumer stores
-- those below. The two sides join on (chat_id, message_id) at query time only,
-- so a reaction on an alert sent before this feature existed is kept, not lost.
CREATE TABLE IF NOT EXISTS alert_messages (
    chat_id       TEXT NOT NULL,
    message_id    INTEGER NOT NULL,
    worker_id     TEXT,
    topic_id      INTEGER,
    priority      TEXT,
    part          INTEGER NOT NULL DEFAULT 1,
    parts         INTEGER NOT NULL DEFAULT 1,
    listing_id    TEXT,
    post_url      TEXT,
    item_name     TEXT,
    search_city   TEXT,
    search_phrase TEXT,
    ai_score      INTEGER,
    unit_count    INTEGER,
    prompt_hash   TEXT,
    sent_at       TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_alert_messages_sent ON alert_messages(sent_at);

-- Fleet-wide incident ledger (see incidents.py). One row per incident key
-- ("ai_unavailable"); `reporters` is a JSON map of worker id -> when it last
-- voted `down`. `last_alerted_at` outlives the incident so a relapse inside
-- the cooldown re-opens silently, and `alerted` says whether the current
-- opening was paged, which decides whether closing it speaks.
CREATE TABLE IF NOT EXISTS incidents (
    key              TEXT PRIMARY KEY,
    is_open          INTEGER NOT NULL DEFAULT 0,
    opened_at        TEXT,
    closed_at        TEXT,
    last_reported_at TEXT,
    last_alerted_at  TEXT,
    alerted          INTEGER NOT NULL DEFAULT 0,
    detail           TEXT,
    reporters        TEXT NOT NULL DEFAULT '{}'
);

-- Every reaction change Telegram delivers, verbatim. Append-only: this is the
-- long-term source data for prompt/region tuning, so nothing is interpreted
-- here — old_reaction/new_reaction hold Telegram's raw JSON.
CREATE TABLE IF NOT EXISTS alert_reaction_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT NOT NULL,
    message_id   INTEGER NOT NULL,
    user_id      TEXT NOT NULL,
    user_name    TEXT,
    old_reaction TEXT NOT NULL DEFAULT '[]',
    new_reaction TEXT NOT NULL DEFAULT '[]',
    reacted_at   TEXT,
    recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reaction_events_msg
    ON alert_reaction_events(chat_id, message_id);

-- Current reaction state per (message, user): `emoji` is a JSON array of what
-- the user's reaction is NOW ('[]' after removal — the row survives so the
-- history stays visible next to the event log). Hit-rate queries read this.
CREATE TABLE IF NOT EXISTS alert_reactions (
    chat_id          TEXT NOT NULL,
    message_id       INTEGER NOT NULL,
    user_id          TEXT NOT NULL,
    user_name        TEXT,
    emoji            TEXT NOT NULL DEFAULT '[]',
    first_reacted_at TEXT,
    last_updated_at  TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_id, user_id)
);

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

-- One browser identity per Facebook account, wherever that account runs. The
-- key is the account ('uid:<facebook uid>'), not the worker: a worker is a slot
-- that can be handed another login, and two logins on one device are linked.
-- device_id is written once and never regenerated. A NULL user_agent means
-- "the browser's own", which stays consistent with its client hints.
CREATE TABLE IF NOT EXISTS device_profiles (
    identity_key        TEXT PRIMARY KEY,
    device_id           TEXT NOT NULL UNIQUE,
    fb_uid              TEXT,
    user_agent          TEXT,
    viewport_w          INTEGER NOT NULL,
    viewport_h          INTEGER NOT NULL,
    screen_w            INTEGER NOT NULL,
    screen_h            INTEGER NOT NULL,
    device_scale_factor REAL NOT NULL DEFAULT 1,
    locale              TEXT NOT NULL,
    timezone_id         TEXT NOT NULL,
    device_cookies_blob BLOB,
    source              TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
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
    # The build the worker reported ("0.5.6 (d3e9a30)").
    ("version", "TEXT"),
    # The liveness the sweeper last alerted on ("dead", or NULL). Persisted so a
    # coordinator restart does not re-page ops about a worker it already
    # reported dead.
    ("alerted_liveness", "TEXT"),
    # Set to a UTC timestamp when an operator presses "Re-login" in the console;
    # cleared the moment the worker's next heartbeat picks up the directive. A
    # pending request survives a coordinator restart so the worker still gets it.
    ("relogin_requested_at", "TEXT"),
    # The same stamp, kept after the worker picks the request up: the ERP
    # compares it with `login_step_at` to tell "queued" from "under way".
    ("relogin_last_requested_at", "TEXT"),
    # Where the worker's latest login has got to (picked_up, typing, submitted,
    # challenge, waiting_for_human, logged_in, failed) and when it got there.
    ("login_step", "TEXT"),
    ("login_step_at", "TEXT"),
)

# Columns added to `listings` after the first release, same mechanism.
LISTING_EXTRA_COLUMNS = (
    # The AI's unit count as a display phrase ("8 sticks").
    ("ai_count", "TEXT"),
)

# Columns added to `threads` for the mautrix-meta router, same mechanism. A
# field database created before the router picks them up on next start.
# The Facebook numeric user id (the `c_user` cookie) of the session a worker
# backed up. Public profile identity, not a credential — it is what the
# dashboards show as "which account is this", and what an operator matches
# against Facebook's own "account 1000…" wording in a checkpoint notice.
SNAPSHOT_EXTRA_COLUMNS = (
    ("fb_user_id", "TEXT"),
    # The device profile the backed-up session belongs to. A snapshot is only
    # restored onto the identity it was taken from.
    ("identity_key", "TEXT"),
)

# Columns added to `accounts`, same mechanism. `fb_uid` is the Facebook uid of
# the login in `fb_username`, the key of its device profile.
ACCOUNT_EXTRA_COLUMNS = (
    ("fb_uid", "TEXT"),
)

# Funnel stages, in pipeline order. The first six and `reviewed` / `alerted`
# are worker-reported; `coordinated` and `sent` are counted here, at ingest and
# at delivery. Fixed literals, so they are safe to interpolate into SQL.
REVIEW_STAT_COUNTERS = (
    "searches", "cards", "title_pass", "opened", "keyword_pass", "fresh",
    "reviewed", "alerted", "coordinated", "sent",
)

REVIEW_STATS_EXTRA_COLUMNS = tuple(
    (name, "INTEGER NOT NULL DEFAULT 0")
    for name in REVIEW_STAT_COUNTERS
    if name not in ("reviewed", "alerted")
)

THREAD_EXTRA_COLUMNS = (
    ("matrix_room_id", "TEXT"),
    ("telegram_topic_id", "INTEGER"),
    ("topic_state", "TEXT DEFAULT 'open'"),
)

# Columns added to `outbound_messages` for transport routing, same mechanism.
OUTBOUND_EXTRA_COLUMNS = (
    ("transport", "TEXT NOT NULL DEFAULT 'playwright'"),
)


# The hit-rate queries, shared verbatim by both backends ({p} is the
# placeholder style, `?` or `%s`). An alert can span several Telegram messages
# (rare long-text splits) and a listing can legitimately be alerted more than
# once; grouping by listing_id (falling back to the message id for rows
# without one) counts each alerted listing once and credits a reaction on any
# of its messages.
ALERT_HIT_SQL = """
    SELECT substr(m.sent_at, 1, 10) AS day,
           m.priority, m.item_name, m.search_city,
           COUNT(*) AS sent,
           SUM(CASE WHEN r.n > 0 THEN 1 ELSE 0 END) AS hit
    FROM alert_messages m
    LEFT JOIN (
        SELECT am.chat_id,
               COALESCE(am.listing_id, CAST(am.message_id AS TEXT)) AS gid,
               COUNT(*) AS n
        FROM alert_reactions ar
        JOIN alert_messages am
          ON am.chat_id = ar.chat_id AND am.message_id = ar.message_id
        WHERE ar.emoji != '[]'
        GROUP BY am.chat_id, COALESCE(am.listing_id, CAST(am.message_id AS TEXT))
    ) r ON r.chat_id = m.chat_id
       AND r.gid = COALESCE(m.listing_id, CAST(m.message_id AS TEXT))
    WHERE m.part = 1 AND m.sent_at >= {p}
    GROUP BY substr(m.sent_at, 1, 10), m.priority, m.item_name, m.search_city
    ORDER BY day
"""

# Reactions partners left on messages we never recorded an alert for: alerts
# sent before the ledger existed, or delivered on a timed-out send the monitor
# could not capture a message_id from. Kept raw, surfaced as a count so the
# hit-rate denominator's blind spot stays visible.
UNMATCHED_REACTIONS_SQL = """
    SELECT COUNT(*) AS n FROM alert_reactions ar
    WHERE ar.emoji != '[]' AND ar.last_updated_at >= {p}
      AND NOT EXISTS (
          SELECT 1 FROM alert_messages am
          WHERE am.chat_id = ar.chat_id AND am.message_id = ar.message_id)
"""


def stats_cutoff(days: int) -> str:
    """The first UTC day inside a `days`-long window ending today."""
    return (
        datetime.now(timezone.utc) - timedelta(days=max(1, days) - 1)
    ).strftime("%Y-%m-%d")


REVIEW_STATS_SUMS = ", ".join(f"SUM({c}) AS {c}" for c in REVIEW_STAT_COUNTERS)


def review_stat_deltas(counts: Dict[str, int]) -> tuple:
    """The positive known counters in `counts`, as (columns, values)."""
    unknown = set(counts) - set(REVIEW_STAT_COUNTERS)
    if unknown:
        raise ValueError(f"unknown review-stat counters: {sorted(unknown)}")
    kept = [(c, int(counts[c])) for c in REVIEW_STAT_COUNTERS if counts.get(c, 0) > 0]
    return tuple(c for c, _ in kept), tuple(v for _, v in kept)


def review_stats_row(row: Any) -> Dict[str, Any]:
    # psycopg returns SUM as Decimal; the API contract is int.
    return {"day": row["day"], **{c: int(row[c]) for c in REVIEW_STAT_COUNTERS}}


DEFAULT_DB_PATH = "data/coordinator.db"

# Checked in order. RS_DATABASE_URL is the one to set; DATABASE_URL is accepted
# because Railway injects it automatically into services linked to a database.
DATABASE_URL_VARS = ("RS_DATABASE_URL", "DATABASE_URL")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# How long search cycles are kept. The fleet table reads today's; a week
# beyond that is room to answer "did it search on Tuesday".
SEARCH_CYCLE_DAYS = 14


def as_utc_stamp(value: Optional[str]) -> str:
    """A worker-sent ISO time in `utcnow()`'s form, or now if it does not parse.

    Workers write `...Z`; `utcnow()` writes `+00:00`. Search cycles are
    filtered by string comparison, so both must land in one form.
    """
    if value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
    return utcnow()


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
            self._migrate_columns("session_snapshots", SNAPSHOT_EXTRA_COLUMNS)
            self._migrate_columns("review_stats", REVIEW_STATS_EXTRA_COLUMNS)
            self._migrate_columns("accounts", ACCOUNT_EXTRA_COLUMNS)
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

    def request_relogin(self: "Database", worker_id: str) -> None:
        """Flag a worker to re-run its Facebook login on its next heartbeat.

        Upserts the row so a request can be queued for a worker the
        coordinator has not heard from yet (e.g. one still starting up).
        """
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO workers (worker_id, relogin_requested_at, relogin_last_requested_at) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(worker_id) DO UPDATE SET relogin_requested_at = excluded.relogin_requested_at, "
                "relogin_last_requested_at = excluded.relogin_last_requested_at",
                (worker_id, now, now),
            )

    def take_relogin(self: "Database", worker_id: str) -> bool:
        """Consume a pending re-login request, returning whether one was set.

        Clearing and testing in a single UPDATE makes the directive fire
        exactly once even if two heartbeats race.
        """
        with self.cursor() as cur:
            cur.execute(
                "UPDATE workers SET relogin_requested_at = NULL "
                "WHERE worker_id = ? AND relogin_requested_at IS NOT NULL",
                (worker_id,),
            )
            return cur.rowcount > 0

    # -- review stats ------------------------------------------------------

    def add_review_stats(
        self: "Database", worker_id: str, day: str | None = None, **counts: int
    ) -> None:
        """Accumulate stage deltas (REVIEW_STAT_COUNTERS) into `day` (UTC)."""
        columns, values = review_stat_deltas(counts)
        if not columns:
            return
        day = day or utcnow()[:10]
        names = ", ".join(columns)
        updates = ", ".join(f"{c} = review_stats.{c} + excluded.{c}" for c in columns)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO review_stats (day, worker_id, {names}, updated_at) "
                f"VALUES (?, ?, {', '.join('?' for _ in columns)}, ?) "
                f"ON CONFLICT(day, worker_id) DO UPDATE SET {updates}, "
                "  updated_at = excluded.updated_at",
                (day, worker_id, *values, utcnow()),
            )

    def review_stats_daily(self: "Database", days: int = 14) -> List[Dict[str, Any]]:
        """Fleet-wide daily totals for the last `days` UTC days, oldest first.

        Days with no reports are simply absent; the consumer fills gaps.
        """
        with self.cursor() as cur:
            cur.execute(
                f"SELECT day, {REVIEW_STATS_SUMS} FROM review_stats "
                "WHERE day >= ? GROUP BY day ORDER BY day",
                (stats_cutoff(days),),
            )
            return [review_stats_row(row) for row in cur.fetchall()]

    def review_stats_by_worker(self: "Database", days: int = 2) -> List[Dict[str, Any]]:
        """Per-worker rows for the last `days` UTC days, oldest first, with
        when each was last added to — the latest search page it counted."""
        with self.cursor() as cur:
            cur.execute(
                f"SELECT day, worker_id, {', '.join(REVIEW_STAT_COUNTERS)}, updated_at "
                "FROM review_stats WHERE day >= ? ORDER BY day, worker_id",
                (stats_cutoff(days),),
            )
            return [dict(row) for row in cur.fetchall()]

    # -- search cycles -----------------------------------------------------

    def log_search_cycle(
        self: "Database", worker_id: str, at: str, item: str | None = None
    ) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=SEARCH_CYCLE_DAYS)).isoformat(
            timespec="seconds"
        )
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO search_cycles (worker_id, at, item) VALUES (?, ?, ?)",
                (worker_id, at, item),
            )
            # A few rows a day per worker: a cheap place to keep the table
            # bounded without a timer of its own.
            cur.execute("DELETE FROM search_cycles WHERE at < ?", (cutoff,))

    def search_cycles_since(self: "Database", since: str) -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT worker_id, at, item FROM search_cycles WHERE at >= ? ORDER BY at",
                (since,),
            )
            return [dict(row) for row in cur.fetchall()]

    def touch_search_city(self: "Database", worker_id: str, city: str) -> None:
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO search_cities (worker_id, city, last_at) VALUES (?, ?, ?) "
                "ON CONFLICT(worker_id, city) DO UPDATE SET last_at = excluded.last_at",
                (worker_id, city, utcnow()),
            )

    def search_cities(self: "Database") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute(
                "SELECT worker_id, city, last_at FROM search_cities ORDER BY worker_id, city"
            )
            return [dict(row) for row in cur.fetchall()]

    def city_tier_config(self: "Database") -> Dict[str, Any]:
        """{settings (stored keys only), pins, updated_at, updated_by}."""
        with self.cursor() as cur:
            cur.execute("SELECT body, updated_at, updated_by FROM city_tier_settings WHERE id = 1")
            row = cur.fetchone()
            cur.execute("SELECT city, per_day FROM city_tier_pins ORDER BY city")
            pins = {r["city"]: int(r["per_day"]) for r in cur.fetchall()}
        return {
            "settings": json.loads(row["body"]) if row else {},
            "pins": pins,
            "updated_at": row["updated_at"] if row else None,
            "updated_by": row["updated_by"] if row else None,
        }

    def put_city_tier_config(
        self: "Database",
        settings: Optional[Dict[str, Any]],
        pins: Optional[Dict[str, int]],
        updated_by: Optional[str],
    ) -> None:
        """Replace the settings and/or the whole pin map, whichever is given."""
        with self.cursor() as cur:
            if settings is not None:
                cur.execute(
                    "INSERT INTO city_tier_settings (id, body, updated_at, updated_by) "
                    "VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, "
                    "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                    (json.dumps(settings), utcnow(), updated_by),
                )
            if pins is not None:
                cur.execute("DELETE FROM city_tier_pins")
                cur.executemany(
                    "INSERT INTO city_tier_pins (city, per_day) VALUES (?, ?)", list(pins.items())
                )

    # -- incidents ---------------------------------------------------------

    _INCIDENT_COLUMNS = (
        "key", "is_open", "opened_at", "closed_at", "last_reported_at",
        "last_alerted_at", "alerted", "detail", "reporters",
    )

    def get_incident(self: "Database", key: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM incidents WHERE key = ?", (key,))
            row = cur.fetchone()
            return dict(row) if row else None

    def save_incident(self: "Database", row: Dict[str, Any]) -> None:
        """Upsert the whole row; `incidents.apply` computed every column."""
        record = {name: row.get(name) for name in self._INCIDENT_COLUMNS}
        columns = ", ".join(record)
        placeholders = ", ".join(f":{name}" for name in record)
        updates = ", ".join(f"{name} = excluded.{name}" for name in record if name != "key")
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO incidents ({columns}) VALUES ({placeholders}) "
                f"ON CONFLICT(key) DO UPDATE SET {updates}",
                record,
            )

    def list_incidents(self: "Database") -> List[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM incidents ORDER BY key")
            return [dict(row) for row in cur.fetchall()]

    # -- alert hit tracking ------------------------------------------------

    def add_alert_message(self: "Database", record: Dict[str, Any]) -> bool:
        """Record one delivered Telegram alert message; False if already known.

        The monitor may report the same message twice (a retried POST), so the
        insert is claim-style: the first report wins, duplicates are no-ops.
        """
        record = {"sent_at": utcnow(), **record}
        columns = ", ".join(record)
        placeholders = ", ".join(f":{name}" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO alert_messages ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT(chat_id, message_id) DO NOTHING",
                record,
            )
            return cur.rowcount > 0

    def record_alert_reaction(
        self: "Database",
        chat_id: str,
        message_id: int,
        user_id: str,
        user_name: str | None,
        old_reaction: str,
        new_reaction: str,
        emoji: str,
        reacted_at: str | None,
    ) -> None:
        """Append one reaction event and upsert the user's current state.

        `emoji` is the extracted current-state JSON array ('[]' when the user
        removed their reaction); old_reaction/new_reaction are Telegram's raw
        JSON. first_reacted_at is only ever set once, and only by an event
        that actually carries a reaction.
        """
        now = utcnow()
        with self.cursor() as cur:
            cur.execute(
                "INSERT INTO alert_reaction_events (chat_id, message_id, user_id, "
                "user_name, old_reaction, new_reaction, reacted_at, recorded_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
                "emoji, first_reacted_at, last_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(chat_id, message_id, user_id) DO UPDATE SET "
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

    def alert_hit_stats(self: "Database", days: int = 14) -> List[Dict[str, Any]]:
        """Sent vs reacted alert counts per day/priority/item/city, oldest first."""
        with self.cursor() as cur:
            cur.execute(ALERT_HIT_SQL.format(p="?"), (stats_cutoff(days),))
            return [
                {
                    "day": row["day"],
                    "priority": row["priority"],
                    "item_name": row["item_name"],
                    "search_city": row["search_city"],
                    "sent": int(row["sent"]),
                    "hit": int(row["hit"]),
                }
                for row in cur.fetchall()
            ]

    def unmatched_reaction_count(self: "Database", days: int = 14) -> int:
        """Live reactions on messages with no recorded alert (pre-feature sends)."""
        with self.cursor() as cur:
            cur.execute(UNMATCHED_REACTIONS_SQL.format(p="?"), (stats_cutoff(days),))
            return int(cur.fetchone()["n"])

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
                "SELECT account_id, worker_id, fb_username, fb_uid, region, proxy, vnc_url, "
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

    # -- device profiles ---------------------------------------------------

    def get_device_profile(self: "Database", identity_key: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM device_profiles WHERE identity_key = ?", (identity_key,))
            row = cur.fetchone()
        return dict(row) if row else None

    def device_profile_by_device(self: "Database", device_id: str) -> Optional[Dict[str, Any]]:
        with self.cursor() as cur:
            cur.execute("SELECT * FROM device_profiles WHERE device_id = ?", (device_id,))
            row = cur.fetchone()
        return dict(row) if row else None

    def insert_device_profile(self: "Database", record: Dict[str, Any]) -> bool:
        """Create a profile unless the identity already has one; True if created.

        Two workers can ask for a new identity's profile at once. The loser of
        that race must read the winner's row, never write a second device.
        """
        now = utcnow()
        record = {"created_at": now, "updated_at": now, **record}
        columns = ", ".join(record)
        placeholders = ", ".join(["?"] * len(record))
        with self.cursor() as cur:
            cur.execute(
                f"INSERT INTO device_profiles ({columns}) VALUES ({placeholders}) "
                "ON CONFLICT(identity_key) DO NOTHING",
                tuple(record.values()),
            )
            return cur.rowcount > 0

    def update_device_profile(
        self: "Database", identity_key: str, fields: Dict[str, Any]
    ) -> None:
        if not fields:
            return
        record = {**fields, "updated_at": utcnow()}
        assignments = ", ".join(f"{name} = ?" for name in record)
        with self.cursor() as cur:
            cur.execute(
                f"UPDATE device_profiles SET {assignments} WHERE identity_key = ?",
                (*record.values(), identity_key),
            )

    def claim_device_cookies(self: "Database", identity_key: str, blob: bytes) -> bool:
        """Store a profile's first device cookies; False if it already has some."""
        with self.cursor() as cur:
            cur.execute(
                "UPDATE device_profiles SET device_cookies_blob = ?, updated_at = ? "
                "WHERE identity_key = ? AND device_cookies_blob IS NULL",
                (blob, utcnow(), identity_key),
            )
            return cur.rowcount > 0

    def rekey_device_profile(self: "Database", old_key: str, new_key: str) -> bool:
        """Move a profile to a new identity key, unless that key is taken."""
        with self.cursor() as cur:
            cur.execute(
                "UPDATE device_profiles SET identity_key = ?, updated_at = ? "
                "WHERE identity_key = ? AND NOT EXISTS "
                "(SELECT 1 FROM device_profiles WHERE identity_key = ?)",
                (new_key, utcnow(), old_key, new_key),
            )
            return cur.rowcount > 0

    def list_device_profiles(self: "Database") -> List[Dict[str, Any]]:
        """Every profile without its sealed cookies."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT identity_key, device_id, fb_uid, user_agent, viewport_w, viewport_h, "
                "screen_w, screen_h, device_scale_factor, locale, timezone_id, source, "
                "CASE WHEN device_cookies_blob IS NULL THEN 0 ELSE 1 END AS has_device_cookies, "
                "created_at, updated_at "
                "FROM device_profiles ORDER BY identity_key"
            )
            return [dict(row) for row in cur.fetchall()]

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
