# Running the coordinator on PostgreSQL

The coordinator ships with two interchangeable storage backends:

| Backend | Selected when | Code |
| --- | --- | --- |
| SQLite (default) | no Postgres URL is set | `rs_coordinator/db.py` — `Database` |
| PostgreSQL | `RS_DATABASE_URL` or `DATABASE_URL` is set and non-empty | `rs_coordinator/pg.py` — `PostgresDatabase` |

Both classes expose exactly the same methods and return the same plain `dict`
rows, so nothing above the storage layer branches on which one is in use. The
choice happens in one place, `db.open_database()`, which `deps.py` calls at
import time.

## Why bother

SQLite is one file on one disk. Railway gives every deploy a fresh filesystem,
so on the hosted control plane the accounts vault, open challenges, and session
snapshots would vanish on each redeploy. A managed Postgres keeps them.

## Pointing it at Railway

Provision a Postgres service in the Railway project, then set **one** env var on
the coordinator:

```
RS_DATABASE_URL=<connection URL>
```

Which URL to use:

* **Coordinator runs outside Railway** (your Mac, the shop box, a VPS) — use
  `DATABASE_PUBLIC_URL` from the Railway dashboard's Postgres → *Variables* tab.
  It points at Railway's TCP proxy (`…proxy.rlwy.net:PORT`) and requires TLS.
* **Coordinator runs inside the same Railway project** — use the internal
  `DATABASE_URL` (`postgres.railway.internal`). It stays on Railway's private
  network and does not egress, which is both faster and cheaper.

`RS_DATABASE_URL` is checked first; plain `DATABASE_URL` is accepted as a
fallback because Railway injects it automatically into any service linked to
the database. Set `RS_DATABASE_URL` explicitly when you want to be sure which
database you are talking to.

An empty string counts as unset — Railway hands out `""` for variables that
were never given a value, and that must not be mistaken for "use Postgres".

### TLS

`normalize_url()` appends `sslmode=require` when the URL does not already name
an `sslmode`, because Railway's public proxy refuses plaintext. Two exceptions,
both because those hosts do not offer TLS by default and forcing it would turn
a working URL into a connection failure:

* loopback (`localhost`, `127.0.0.1`, `::1`) — local Docker Postgres for tests
* `*.railway.internal` — Railway's private network

An `sslmode` you set yourself is never overwritten, in either direction. If you
want TLS on the internal URL, or want it off on a remote one, put `?sslmode=…`
in the URL and it will be respected verbatim.

### Connection pool

Deliberately small — the coordinator makes a handful of queries a minute and
Railway's connection allowance is not generous.

| Setting | Value | Why |
| --- | --- | --- |
| `min_size` / `max_size` | 1 / 4 | enough for FastAPI's threadpool, cheap at idle |
| `max_idle` | 30 s | Railway's proxy hangs up on idle sockets; drop ours first |
| `max_lifetime` | 30 min | recycle before anything upstream decides to |

`RS_PG_CONNECT_TIMEOUT` (default `10`, seconds) bounds how long startup waits
for the first connection before failing loudly.

## Schema and migrations

Tables are created idempotently on connect (`CREATE TABLE IF NOT EXISTS`),
exactly like the SQLite path — there is no separate migrate step and no
`schema_migrations` table. The DDL is *derived* from the single `SCHEMA` string
in `db.py` (see `pg.postgres_schema()`), so the two backends cannot drift.

Only three things are translated:

* `BLOB` → `BYTEA` (`accounts.secret_blob`, `session_snapshots.state_blob`)
* `INTEGER PRIMARY KEY AUTOINCREMENT` → `INTEGER GENERATED ALWAYS AS IDENTITY
  PRIMARY KEY` (there is no `lastrowid`, so `insert_challenge` uses
  `INSERT … RETURNING id`)
* placeholders: `?` → `%s`, `:name` → `%(name)s`

Three things are deliberately **not** translated, and changing any of them will
break code above this layer:

* **Timestamps stay `TEXT`**, holding the ISO strings `db.utcnow()` writes.
  `query_listings(since=…)` filters with a string `>=`, and `health._parse_ts`
  parses them back. `TIMESTAMPTZ` would hand callers `datetime` objects.
* **`browser_ok`, `proxy_ok`, `allow_password_login` stay `INTEGER`** holding
  1/0. A native `BOOLEAN` would return Python `bool` where callers expect the
  int they wrote.
* **Table and column names are unchanged.** This is a dedicated database for
  the Facebook tracker; nothing else lives in it, so there is nothing to
  namespace around. Do not point it at the reddit tracker's database.

The additive `workers` health-column migration runs on every connect, reading
`information_schema.columns` (the Postgres equivalent of SQLite's
`PRAGMA table_info`) and adding only what is missing. A `workers` table created
before the control plane landed upgrades in place, rows intact.

Startup is guarded by a Postgres session advisory lock on key **914273**, so
several pods booting at once serialize instead of racing the catalog
(`CREATE TABLE IF NOT EXISTS` is not race-free in Postgres). The key is
deliberately different from the reddit tracker's `778431`. The lock is released
before `__init__` returns.

## Migrating existing SQLite data

**Rows do not carry over.** Pointing `RS_DATABASE_URL` at a fresh Postgres gives
you an empty control plane: no accounts, no workers, no challenges, no session
snapshots. The schema is created for you; the data is not copied.

For most of it that is fine — `listings`, `sightings`, `workers` and
`code_audit` refill themselves within a heartbeat cycle or two. The two that
matter are:

* **`accounts`** — re-add each account with `rsc vault set-account`. You need
  the same `RS_VAULT_KEY` in the environment, since the sealed blobs are
  encrypted with it; the key is what makes the secrets portable, not the file.
* **`session_snapshots`** — losing these just means the affected workers log in
  again and back up a fresh snapshot.

If you do want the rows moved, dump the SQLite tables to CSV and `\copy` them
in; the column names and types line up one-for-one. Mind that `secret_blob` and
`state_blob` are binary — export them hex-encoded and load into `BYTEA` with
`decode(…, 'hex')`. There is no one-off script for this and it is not required.

## Testing against a real Postgres

The Postgres half of `tests/test_postgres.py` skips unless
`RS_TEST_DATABASE_URL` is set, so the suite is green without a database. To run
it for real:

```bash
docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16
RS_TEST_DATABASE_URL=postgresql://postgres:x@localhost:55432/postgres \
    python -m pytest rs_coordinator/tests/test_postgres.py -q
```

The behavioural tests are parametrized over both backends and run the identical
assertions against each, which is the actual contract being tested. Note the
suite **drops and recreates every table** in the target database — point it at a
throwaway, never at anything real.
