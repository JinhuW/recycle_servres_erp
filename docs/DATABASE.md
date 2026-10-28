# Databases

This file describes every database in the system, table by table. The
structure (columns, types, defaults, keys, indexes and triggers) was read back
from databases built from scratch by each project's own migration runner. The
meanings come from the migrations' comments and from the code that reads and
writes each column. Self-explanatory columns (ids, timestamps) are left blank
on purpose. Any other blank meaning is one that neither the SQL nor the code
made clear enough to state.

**As of 2026-10-27:** ERP migration `0215`, Reddit tracker migration `0007`,
Facebook tracker `0.13.18`. *Keeping this file current* at the end says how to
refresh a section.

- [Overview](#overview)
- [ERP database](#erp-database)
  - [Running it](#running-it)
  - [Conventions](#conventions)
  - [People, sign-in and connectors](#people-sign-in-and-connectors)
  - [Purchase orders](#purchase-orders)
  - [Suppliers and the public sell-to-us form](#suppliers-and-the-public-sell-to-us-form)
  - [Catalog, warehouses and inventory](#catalog-warehouses-and-inventory)
  - [Customers and sell orders](#customers-and-sell-orders)
  - [After-sales and shipping](#after-sales-and-shipping)
  - [Accounting, banking and FX](#accounting-banking-and-fx)
  - [Market values](#market-values)
  - [Facebook account pool](#facebook-account-pool)
  - [Fleet](#fleet)
  - [System](#system)
  - [SQL functions](#sql-functions)
- [Reddit tracker database](#reddit-tracker-database)
- [Facebook coordinator database](#facebook-coordinator-database)
- [Other stored state](#other-stored-state)
- [Keeping this file current](#keeping-this-file-current)

## Overview

| Database | Owner | Engine | Where it runs | Connection | Schema source | Tables |
| --- | --- | --- | --- | --- | --- | --- |
| **ERP** | `apps/backend` | Postgres 18 | Railway project `recycle-erp-experiment`, with one Postgres per environment (production, dev) | `DATABASE_URL` | `apps/backend/migrations/*.sql`, applied by `scripts/migrate.mjs` | 69 |
| **Reddit tracker** | `trackers/reddit` (`api`, `worker` and the OCI worker VMs) | Postgres | Railway project `reddits-tracker`, with public networking on so the OCI VMs can reach it | `DATABASE_URL` | `trackers/reddit/migrations/*.sql`, applied by `scripts/migrate.ts` | 18 + 1 view |
| **Facebook coordinator** | `trackers/facebook/rs_coordinator` | Postgres 16 in prod; SQLite locally and in tests | Railway project `facebook-tracker` (Terraform in `trackers/facebook/infra/`), reached by the coordinator on the homelab VM through Railway's TCP proxy | `RS_DATABASE_URL`, else `DATABASE_URL`; with neither set, SQLite at `RS_COORDINATOR_DB` | `SCHEMA` plus the `*_EXTRA_COLUMNS` lists in `rs_coordinator/db.py`, applied at boot | 32 |

**The three share no database and no rows.** The ERP reaches each tracker only
over HTTP:

- `/api/tracker/*` proxies to the Reddit tracker's API.
- `/api/coordinator/*` proxies to rs_console, which fronts the coordinator.

The contracts are listed in the root [AGENTS.md](../AGENTS.md). No query ever
joins across databases. The separation is deliberate. The ERP and Reddit
runners both key a `schema_migrations` ledger by filename, and both start at
`0001_init.sql`. Reddit's `migrate.ts --reset` drops every table in `public`.
And the Facebook database holds the account vault, which earns its own
isolation boundary (`trackers/facebook/infra/README.md`).

## ERP database

### Running it

- **Production.** Postgres 18 in Railway `recycle-erp-experiment`. The backend
  reaches it over Railway's private network. Each backend process holds one
  postgres.js pool (`src/db.ts`) with these settings:
  - at most 10 connections (`DB_POOL_MAX` overrides this in tests);
  - prepared statements off;
  - `statement_timeout` and `idle_in_transaction_session_timeout` both 60 s.

  A job that legitimately runs longer has to `SET LOCAL statement_timeout`
  inside its transaction.
- **Dev.** The dev environment has its own Postgres, overwritten from prod
  every night at 04:00 UTC by the cron service in `deploy/railway-sync/`.
  1. `sync.sh` refuses any target that resolves to the prod host or carries a
     marker other than `dev`.
  2. It sets dev's Facebook fleet aside in a `sync_keep` schema
     (`keep-fleet.sql`): every `fleet_*` table, and for each pool account
     with a `fleet_slots` row its `*_enc` columns, `cookie_uid`, `cookie_at`,
     `status` and `note`. Then it resets dev's schema wholesale and restores
     prod's dump.
  3. It runs `scrub.sql` in the same transaction. That truncates the live
     credentials (`refresh_tokens`, `oauth_refresh_tokens`,
     `oauth_authorization_codes`, `oauth_pending_consent`, `login_attempts`),
     nulls `oauth_clients.secret_hash`, and blanks every `*_enc` column in
     every table, since those values are sealed under prod's keys. It also
     creates `env_marker`, which exists only on dev.
  4. It redeploys the dev backend, so migrations not yet on prod apply again on
     top of the restored copy.
  5. Once every migration dev had is applied again, `restore-fleet.sql` puts
     the fleet back in one transaction (onto the same pool accounts, matched
     by `uid`) and drops `sync_keep`. A run that times out leaves `sync_keep`,
     and the next run refuses until it is restored or dropped.
- **Local.** The ERP's `docker-compose.yml` runs Postgres 16 (`recycle_pg`),
  and its data directory still needs a dump and restore before it can move to
  18. Backend tests run against a real Postgres (`recycle-erp-testdb` on
  `127.0.0.1:55432`). Each test worker migrates and seeds a template database
  once, then clones it per test (`apps/backend/AGENTS.md` → *Tests*).
  `seed.mjs` and `migrate.mjs --reset` refuse a non-local `DATABASE_URL`
  (`src/lib/dbTarget.ts`).
- **Migrations.** `scripts/migrate.mjs` runs on every backend boot and applies
  each file in `migrations/` once, in filename order. It records each one in
  `schema_migrations` with a sha256 checksum. A file edited after it was
  applied logs a warning and is not re-run, so always add the next number and
  never edit a deployed file. Each file runs under `lock_timeout = '10s'` and
  is retried on `55P03`. A transient connect failure is retried up to six
  times before the boot fails. The numbering has gaps: 203 numbers, 201
  files.
- **Backups.** The cron service in `backup/` runs daily at 03:30 UTC. It does
  a `pg_dump --format=custom`, gzips it, and checks it with `pg_restore
  --list`, including that `orders`, `order_lines`, `sell_orders` and `users`
  carry data. It then uploads it to R2 at
  `recycle-db-backup/railway-erp/recycle_erp_railway_<UTC>.dump.gz` and keeps
  the newest 30. Its image must be `postgres:<N>` with N at least the server's
  major version. Restore steps are in `backup/README.md`.

### Conventions

- **Keys.**
  - 36 tables use `uuid` keys (`gen_random_uuid()`).
  - Business records people quote use `text` keys allocated by `lib/id-seq.ts`
    from `id_counters`, never by counting rows. These are `orders`,
    `sell_orders`, `transfer_orders`, `after_sales_cases`,
    `accounting_entries` and `web_submissions`.
  - 12 more tables use other `text` keys:
    - slugs, for the lookups `categories`, `warehouses`, `price_sources`,
      `sell_order_statuses`, `workspace_settings` and `id_counters`;
    - OAuth identifiers, for `oauth_clients`, `oauth_authorization_codes`
      (the code's hash) and `oauth_pending_consent`;
    - an app-made uuid string, for `ref_prices`;
    - the canonical part number, for `part_number_lookups`;
    - the file name, for `schema_migrations`.
  - Number keys:
    - `fb_pool_accounts.no` and `fb_worker_accounts.id` are identity columns;
    - `fb_proxies` is keyed by the proxy's `url`;
    - `fx_rates`, `login_attempts`, `oauth_refresh_tokens` and
      `public_form_reservations` use `bigserial`;
    - `wechat_market_days` is keyed by `report_date`.
  - The rest use composite keys: status meta, sign-offs, packs, suggestion
    dismissals, `mail_sync_state` and the other WeChat tables.
- **Foreign keys.** There are 122. Each table's *References* line gives the
  delete rule.
  - **Delete rules.** `0041_fk_on_delete.sql` set most rules on purpose.
    15 FKs still have no `ON DELETE` clause, which means `NO ACTION`, so
    deleting the referenced row fails while anything points at it. These are
    mostly actor and warehouse references, plus `order_lines.transfer_order_id`.
    New child tables state their rule explicitly (`apps/backend/AGENTS.md`).
  - **Indexes.** `0035_fk_indexes.sql` and `0040_perf_indexes.sql` index most
    FKs, and a new FK gets its index in the same migration. 14 older FKs have
    no index that leads with their columns. Examples are `orders.warehouse_id`
    and the `actor_id` of `order_events`, `sell_order_events` and
    `inventory_events`.
  - **Diagrams.** 65 FKs point at `users`, and the diagrams below leave those
    out so they stay readable.
- **Archive rather than delete.**
  - `orders` and `sell_orders` carry `archived_at`, and their live-row indexes
    are partial on `archived_at IS NULL`.
  - `accounting_entries` is soft-deleted with `deleted_at`.
- **Append-only history.** `order_events`, `sell_order_events`,
  `inventory_events`, `accounting_entry_events` and `fb_pool_events` each have
  a pair of `*_no_update` / `*_no_delete` triggers that raise on any `UPDATE`
  or `DELETE`. Three of them (order, inventory and accounting-entry events)
  still let a cascaded delete through (`pg_trigger_depth() > 1`), so deleting
  the parent row removes its history with it. `sell_order_events` refuses
  even a cascade, so a sell order that has any history can only be archived,
  never deleted. `fb_pool_events` has no foreign key to `fb_pool_accounts`,
  so an account's history outlives the account; neither has
  `fb_worker_accounts`, which a trigger keeps rather than a ledger lock.
- **Money.** Amounts are `numeric`. The one float that holds money is
  `ref_prices.trend`, a `real` delta. Each amount's *Meaning* names its
  currency: USD, or CNY (RMB) in the RMB Flow book and on CNY sell orders.
- **Secrets.**
  - Tokens and passwords are stored only as hashes (`*_hash`).
  - Third-party credentials the app must hand back in clear are in `*_enc`
    columns, sealed with AES-256-GCM under `FB_POOL_KEY` (`lib/sealed.ts`).
    These are the Facebook pool's passwords, 2FA keys and cookies.
  - The `pgcrypto` extension is installed (`0001_init.sql`), but the app
    hashes and seals in Node.
- **Files** never live in the database. Rows hold an R2 storage key (see
  [Other stored state](#other-stored-state)).

### People, sign-in and connectors

Staff accounts and everything that proves who is calling. users holds the managers and purchasers, login_attempts throttles password guesses, and refresh_tokens backs the browser's session cookie; oauth_clients, oauth_pending_consent, oauth_authorization_codes and oauth_refresh_tokens are the OAuth 2.1 server behind the MCP connectors and the service clients (the market scraper, memtrade). notifications is each user's in-app inbox.

Tables: [`users`](#erp-users), [`login_attempts`](#erp-login-attempts), [`refresh_tokens`](#erp-refresh-tokens), [`oauth_clients`](#erp-oauth-clients), [`oauth_authorization_codes`](#erp-oauth-authorization-codes), [`oauth_refresh_tokens`](#erp-oauth-refresh-tokens), [`oauth_pending_consent`](#erp-oauth-pending-consent), [`notifications`](#erp-notifications)

```mermaid
erDiagram
  warehouses |o--o{ users : "default_warehouse_id"
  oauth_clients ||--o{ oauth_authorization_codes : "client_id"
  oauth_clients ||--o{ oauth_refresh_tokens : "client_id"
  oauth_refresh_tokens |o--o{ oauth_refresh_tokens : "parent_id"
  oauth_clients ||--o{ oauth_pending_consent : "client_id"
```

<a id="erp-users"></a>

#### `users`

One row per staff member who can sign in, a manager or a purchaser. Managers create and edit members on Settings → Members; nobody is deleted, a member is deactivated instead.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `email` | `text` | ✓ |  | Login name, stored lower-cased; unique. |
| `name` | `text` | ✓ |  |  |
| `initials` | `text` | ✓ |  | Avatar letters: first letters of up to two words of the name. Set at creation; a rename does not recompute it. |
| `role` | `text` | ✓ |  | manager (sees and does everything) or purchaser (the buying side and their own POs). |
| `team` | `text` |  |  | Free-text team label, edited on Members. |
| `password_hash` | `text` | ✓ |  | bcrypt hash (cost 10) of the password. |
| `language` | `text` | ✓ | `'en'` | UI language, en or zh. Legacy mirror of preferences.language, kept in sync by the preferences endpoint and still returned at sign-in. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `phone` | `text` |  |  | Free-text contact phone, edited on Members. |
| `title` | `text` |  |  | Free-text job title, edited on Members. |
| `active` | `boolean` | ✓ | `true` | FALSE means deactivated: sign-in, refresh and every token are refused. |
| `preferences` | `jsonb` | ✓ | `'{}'::jsonb` | Per-user UI settings as a flat JSON map; keys are allowlisted in src/preferences.ts (language, tweaks.density, column picks, sidebar.folded, onboarding.done and others). |
| `last_seen_at` | `timestamptz` |  |  | Stamped on each successful password sign-in, not on refresh; NULL marks a pending invite who never signed in. |
| `default_warehouse_id` | `text` |  |  | → warehouses. The member's home warehouse; new POs filed for them default to it. |
| `tokens_valid_after` | `timestamptz` |  |  | The second of the last password change or reset; cookie and OAuth tokens issued earlier are refused. NULL = never changed. |
| `credential_version` | `integer` | ✓ | `1` | Bumped by every password change, reset or deactivation; a token carries the version it was minted under and is refused once this moves. |

- **Primary key:** `id`
- **References:** `default_warehouse_id` → `warehouses.id` (on delete set null)
- **Unique:** `(email)`
- **Checks:** `role IN ('manager', 'purchaser')`
- **Indexes:** `users_default_warehouse_idx` (default_warehouse_id)

Soft delete via `active`. A password change or reset stamps tokens_valid_after and bumps credential_version, and a deactivation bumps credential_version, so every cookie and OAuth token issued before stops working on its next request.

<a id="erp-login-attempts"></a>

#### `login_attempts`

One row per password check, at sign-in or at a signed-in password change, which the brute-force throttle counts. The row is reserved before bcrypt runs and settled once it answers.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | serial |  |
| `email` | `text` | ✓ |  | The email tried, lower-cased; need not belong to any user. |
| `ip` | `text` |  |  | Full client address, kept for the record. |
| `success` | `boolean` |  |  | TRUE or FALSE once the password was checked; NULL is a reservation still in flight and counts as a failure. A refused or failed request deletes its reservation. |
| `attempted_at` | `timestamptz` | ✓ | `now()` |  |
| `ip_key` | `text` |  |  | Limiter key the per-address budget counts by: the IPv4 address, or the /64 an IPv6 address sits in. |

- **Primary key:** `id`
- **Indexes:** `login_attempts_email_time_idx` (email, attempted_at DESC); `login_attempts_ip_key_time_idx` (ip_key, attempted_at DESC)

An email locks after 5 failures in 15 minutes since its last success, an address after 30 (only when the Worker named the caller's IP). Nothing purges old rows; the nightly prod→dev copy truncates the table.

<a id="erp-refresh-tokens"></a>

#### `refresh_tokens`

Rotating refresh tokens for the browser session (the httpOnly `rt` cookie). A sign-in starts a family; each refresh revokes the presented token and issues its successor in the same family.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `user_id` | `uuid` | ✓ |  |  |
| `token_hash` | `text` | ✓ |  | SHA-256 hex of the opaque 32-byte token; the raw value is never stored. |
| `family_id` | `uuid` | ✓ |  | One sign-in's rotation chain; logout and reuse revoke by family. |
| `expires_at` | `timestamptz` | ✓ |  | Issue time plus 14 days. |
| `revoked_at` | `timestamptz` |  |  | Set when the token is rotated, on logout or reuse (whole family), and when the user's password is reset or they are deactivated. A user's own password change keeps the caller's family. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `user_id` → `users.id` (on delete cascade)
- **Unique:** `(token_hash)`
- **Indexes:** `refresh_tokens_family_idx` (family_id); `refresh_tokens_hash_idx` (token_hash); `refresh_tokens_user_idx` (user_id)

Presenting an already-rotated token revokes its whole family (theft response). The access JWT carries the family id, so a revoked family also ends its access token at once.

<a id="erp-oauth-clients"></a>

#### `oauth_clients`

One row per OAuth client: a connector that registered itself through Dynamic Client Registration (Claude, ChatGPT, Claude Code), or a service client a manager minted under Settings → Connectors (the market scraper, memtrade). Revoked clients stay as rows.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | The public client_id, 32 random hex characters. |
| `secret_hash` | `text` |  |  | bcrypt hash (cost 10) of the client secret; NULL for a public client (PKCE only, token_endpoint_auth_method none). |
| `name` | `text` | ✓ |  | Display name. A self-registered client picks its own, so the consent page marks it Unverified. |
| `redirect_uris` | `text[]` | ✓ |  | Allowed callbacks: https, or http on a loopback host, where /authorize ignores the port. |
| `grant_types` | `text[]` | ✓ |  | Subset of authorization_code, refresh_token, client_credentials; self-registered clients get only the first two. |
| `scopes` | `text[]` | ✓ |  | Ceiling on what the client may be granted: market:read, market:write, sellorder:read, sellorder:write, wechat:write. Self-registration never grants wechat:write. |
| `created_by` | `uuid` |  |  | → users. The manager who minted it; NULL for a self-registered client. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `revoked_at` | `timestamptz` |  |  | Set by a manager's revoke or by the Clean up unused sweep (no live refresh token an hour after registering; client_credentials clients exempt). |
| `created_ip` | `text` |  |  | Registrant's address; recorded for self-registered clients only. |
| `created_ip_key` | `text` |  |  | Limiter key (IPv4 address or IPv6 /64) the per-address registration throttle counts by; older rows fall back to created_ip. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Indexes:** `oauth_clients_dcr_recent_idx` (created_at DESC) where `created_by IS NULL`

created_by IS NULL marks a self-registered client, which the registration throttle counts (10 per address an hour, 60 overall an hour, 200 never-used a day). Revoking a client revokes all its refresh tokens; the prod→dev copy nulls every secret_hash and revokes every client.

<a id="erp-oauth-authorization-codes"></a>

#### `oauth_authorization_codes`

One-time authorization codes minted when a user consents, redeemed at /oauth/token for an access token and, if the client may refresh, a refresh token. Valid 10 minutes.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `code_hash` | `text` | ✓ |  | SHA-256 hex of the code; the raw code only travels in the redirect. |
| `client_id` | `text` | ✓ |  | → oauth_clients. Only this client may redeem it. |
| `user_id` | `uuid` | ✓ |  | → users. The consenting user. |
| `redirect_uri` | `text` | ✓ |  | The callback used at /authorize; the token request must repeat it exactly, port included. |
| `scopes` | `text[]` | ✓ |  | Scopes the user consented to; narrowed again to the user's live role at redemption. |
| `code_challenge` | `text` | ✓ |  | PKCE S256 challenge the token request's code_verifier must match. |
| `expires_at` | `timestamptz` | ✓ |  |  |
| `consumed_at` | `timestamptz` |  |  | When the code was redeemed; a second redemption is refused. |

- **Primary key:** `code_hash`
- **References:** `client_id` → `oauth_clients.id` (on delete cascade); `user_id` → `users.id` (on delete cascade)
- **Indexes:** `oauth_authorization_codes_client_idx` (client_id); `oauth_authorization_codes_expires_idx` (expires_at); `oauth_authorization_codes_user_idx` (user_id)

Single use: redemption stamps consumed_at under a row lock. A password reset or deactivation deletes the user's unredeemed codes; expired ones are never purged.

<a id="erp-oauth-refresh-tokens"></a>

#### `oauth_refresh_tokens`

Rotating refresh tokens for OAuth grants made through the code flow. Each use revokes the token and issues a successor in the same family (default lifetime 30 days, OAUTH_REFRESH_TOKEN_TTL_SEC); access tokens are EdDSA-signed JWTs and are not stored.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | serial |  |
| `token_hash` | `text` | ✓ |  | SHA-256 hex of the opaque 32-byte token. |
| `client_id` | `text` | ✓ |  | → oauth_clients. Only this client may rotate the token. |
| `user_id` | `uuid` |  |  | → users. The user who consented. Nullable, but only the code flow issues refresh tokens, so rows written today all carry one. |
| `scopes` | `text[]` | ✓ |  | Granted scopes; narrowed to the user's live role at every rotation, so a demotion takes effect within one access-token lifetime. |
| `family_id` | `uuid` | ✓ |  | One grant's rotation chain; revocation works by family. |
| `parent_id` | `bigint` |  |  | → oauth_refresh_tokens. The token this one replaced; written on rotation, read by no code. |
| `expires_at` | `timestamptz` | ✓ |  |  |
| `revoked_at` | `timestamptz` |  |  | Set on rotation, on family revocation (reuse, client revoked, user deactivated) and on a password reset. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `client_id` → `oauth_clients.id` (on delete cascade); `parent_id` → `oauth_refresh_tokens.id` (on delete set null); `user_id` → `users.id` (on delete cascade)
- **Unique:** `(token_hash)`
- **Indexes:** `oauth_refresh_tokens_client_idx` (client_id); `oauth_refresh_tokens_family_idx` (family_id); `oauth_refresh_tokens_user_idx` (user_id)

Replaying a rotated token revokes the whole family. The Connectors list reads a client's last use as MAX(created_at) over its rows, revoked ones included.

<a id="erp-oauth-pending-consent"></a>

#### `oauth_pending_consent`

An /oauth/authorize request parked while the signed-in user reads the consent screen, so the long PKCE challenge stays out of the URL; the SPA only gets the opaque `req` handle. Deleted when the user consents or denies, otherwise it expires after 10 minutes.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `req` | `text` | ✓ |  | Opaque handle (16 random bytes, hex) the consent page opens with. |
| `client_id` | `text` | ✓ |  | → oauth_clients. |
| `redirect_uri` | `text` | ✓ |  | The callback the client asked for, already checked against its registration. |
| `scopes` | `text[]` | ✓ |  | What the consent screen offers: the requested scopes narrowed to the client's and to the user's role (non-managers keep market:read only). The user may tick a subset. |
| `code_challenge` | `text` | ✓ |  | PKCE S256 challenge, carried onto the authorization code. |
| `state` | `text` |  |  | The client's OAuth state, echoed back on the redirect. |
| `expires_at` | `timestamptz` | ✓ |  |  |
| `user_id_from_cookie` | `uuid` |  |  | User whose `at` cookie started the request. The migration calls it informational, but consent or denial by any other user is refused. |

- **Primary key:** `req`
- **References:** `client_id` → `oauth_clients.id` (on delete cascade)
- **Indexes:** `oauth_pending_consent_client_idx` (client_id); `oauth_pending_consent_expires_idx` (expires_at)

Expired rows are not purged by any job; the prod→dev copy truncates the table.

<a id="erp-notifications"></a>

#### `notifications`

One row per entry in a user's in-app inbox (the bell). Written inside the transaction of the event it reports, to one user or to every active manager; the inbox shows the newest 50.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `user_id` | `uuid` | ✓ |  |  |
| `kind` | `text` | ✓ |  | What happened: order_submitted, order_reverted, order_ready_to_pay, ai_review, box_check, low_margin, payment_received, sell_order_signoff, package_delivered, web_submission, accounting_query, accounting_answered. |
| `tone` | `text` | ✓ | `'info'` | info, warn or pos (good news); colours the entry. |
| `icon` | `text` | ✓ | `'bell'` | Icon name the UI draws: bell (default), mail, package, alert, cash, flag, check, inventory. |
| `title` | `text` | ✓ |  |  |
| `body` | `text` | ✓ |  | Detail line; empty string when the event has none. |
| `unread` | `boolean` | ✓ | `true` | Cleared for all of the user's rows at once by POST /api/notifications/mark-read. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `user_id` → `users.id` (on delete cascade)
- **Indexes:** `notifications_user_idx` (user_id, created_at DESC); `notifications_user_unread_idx` (user_id, unread, created_at DESC)

Rows are only deleted with their user (cascade).

### Purchase orders

Purchase orders (POs): what a purchaser bought, from whom, and how it was paid. `orders` is the PO header and `order_lines` its products; every PO change is logged append-only in `order_events`, proof files hang off `order_status_meta` / `order_status_attachments` / `order_line_photos`, and a manager's count of the arrived box lives in `order_line_checks` / `order_check_extras`. The AI side is `label_scans` (every label OCR), `po_ai_reviews` / `po_ai_findings` (the background review of a PO in Reviewing) and `part_number_lookups` (a cache of what the web says a part number is).

Tables: [`orders`](#erp-orders), [`order_lines`](#erp-order-lines), [`order_events`](#erp-order-events), [`order_status_meta`](#erp-order-status-meta), [`order_status_attachments`](#erp-order-status-attachments), [`order_line_photos`](#erp-order-line-photos), [`order_line_checks`](#erp-order-line-checks), [`order_check_extras`](#erp-order-check-extras), [`po_ai_reviews`](#erp-po-ai-reviews), [`po_ai_findings`](#erp-po-ai-findings), [`label_scans`](#erp-label-scans), [`part_number_lookups`](#erp-part-number-lookups)

```mermaid
erDiagram
  suppliers |o--o{ orders : "supplier_id"
  warehouses |o--o{ orders : "warehouse_id"
  orders ||--o{ order_lines : "order_id"
  transfer_orders |o--o{ order_lines : "transfer_order_id"
  warehouses |o--o{ order_lines : "warehouse_id"
  orders ||--o{ order_events : "order_id"
  orders ||--o{ order_status_meta : "order_id"
  orders ||--o{ order_status_attachments : "order_id"
  orders ||--o{ order_line_photos : "order_id"
  order_lines ||--o{ order_line_photos : "order_line_id"
  order_lines ||--o{ order_line_checks : "line_id"
  orders ||--o{ order_check_extras : "order_id"
  orders ||--o{ po_ai_reviews : "order_id"
  order_lines |o--o{ po_ai_findings : "line_id"
  orders ||--o{ po_ai_findings : "order_id"
  po_ai_reviews ||--o{ po_ai_findings : "review_id"
```

<a id="erp-orders"></a>

#### `orders`

One purchase order (PO): a purchase from one seller, built product by product, moving draft → in_transit → reviewing → ready_to_pay → done. Created by a purchaser (or a manager on their behalf), from the phone capture flow, from a delivered package, or by converting a web sell lot. Hard-deleted only while a never-submitted Draft; otherwise archived.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'PO-<n>' from `id_counters` row 'PO' (was 'SO-' until migration 0044). |
| `user_id` | `uuid` | ✓ |  | → users. The purchaser who owns the PO and earns its commission; a manager can reassign it. |
| `category` | `text` | ✓ |  | Derived from the lines: their single category id, or 'Mixed' when they differ. No FK to `categories`. |
| `warehouse_id` | `text` |  |  | → warehouses. Receiving warehouse; lines inherit it unless `order_lines.warehouse_id` overrides. |
| `payment` | `text` | ✓ | `'company'` | Whose money paid the seller: 'company' (the Business Account, the Mercury/PayPal accounts Payments reconciles) or 'self' (a person's own money). |
| `notes` | `text` |  |  | Free-text notes on the PO; also serves as the note for Submission evidence. |
| `total_cost` | `numeric(12,2)` |  |  | Goods total in USD, excluding `other_fees`. Normally mirrors SUM(COALESCE(qty_purchased, qty) * unit_cost); a value that differs is an older negotiated lot price and is never recomputed. |
| `lifecycle` | `text` | ✓ | `'draft'` | Stage: 'draft', 'in_transit', 'reviewing', 'ready_to_pay' (review done, book closed, commission owed), 'done' (commission paid). No CHECK; legacy 'sold' is rewritten to 'done' by trigger, and Sold is derived from the lines. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `commission_rate` | `numeric(5,4)` |  | `0.5` | Fraction 0–1 of the PO's projected profit paid to the purchaser (0.5 = 50%). NULL means no rate, read as 0. |
| `archived_at` | `timestamptz` |  |  | Soft hide. Archiving moves every non-Sold line to status 'Archived'; unarchive (setting NULL) restores each line from its inventory_events. |
| `other_fees` | `numeric(12,2)` | ✓ | `0` | USD paid on top of the goods (PayPal fee, freight, customs). Spread over lines pro rata by cost (lib/po-cost.ts), so it lowers profit and commission. |
| `other_fees_note` | `text` |  |  | What `other_fees` was for. |
| `paypal_txn_id` | `text` |  |  | PayPal transaction id of the company payment. Required to leave Draft when payment='company' and payment_method isn't 'cash', and must match a synced PayPal bank row. |
| `supplier_id` | `uuid` |  |  | → suppliers. The client this PO was bought from; SET NULL so deleting a client never deletes POs. |
| `source` | `text` |  |  | Buying channel: 'facebook', 'local', 'reddit', 'other'. Same vocabulary as `packages.source`; NULL on orders before the hand-off existed. |
| `handoff_method` | `text` |  |  | How the goods reach the warehouse, set at the Draft → In Transit hand-off: 'pickup' (someone collects locally) or 'label' (shipped with a tracked package). |
| `handoff_by` | `uuid` |  |  | → users. Who collected a local pickup. |
| `payment_method` | `text` |  |  | For company-paid orders: 'paypal' or 'cash'. NULL on self-paid orders, and on older company-paid ones never asked, which the PayPal-id rule treats like 'paypal'. |
| `manager_id` | `uuid` |  |  | → users. The manager who took the PO into review (or a later stage). Sticky across a send-back to Draft, and changed only when another moving manager takes it over. |
| `commission_paid_by` | `uuid` |  |  | → users. The manager who paid the purchaser their commission. NULL = not recorded. |
| `next_product_no` | `integer` | ✓ | `1` | Next product # the order_lines insert trigger hands out. Only goes up, so a removed product leaves a gap. |
| `commission_paid_by_company` | `boolean` | ✓ | `false` | True when the commission was paid from the company's account. A CHECK forbids it together with `commission_paid_by`; a linked bank row also reads as company-paid without setting this. |
| `paid_by` | `uuid` |  |  | → users. The person who paid the seller when payment='self'; kept NULL on Business Account orders. |

- **Primary key:** `id`
- **References:** `commission_paid_by` → `users.id` (on delete set null); `handoff_by` → `users.id` (on delete set null); `manager_id` → `users.id` (on delete set null); `paid_by` → `users.id` (on delete set null); `supplier_id` → `suppliers.id` (on delete set null); `user_id` → `users.id` (on delete cascade); `warehouse_id` → `warehouses.id` (on delete no action)
- **Checks:** `(NOT commission_paid_by_company) OR (commission_paid_by IS NULL)`; `handoff_method IN ('pickup', 'label')`; `other_fees >= 0`; `payment IN ('company', 'self')`; `payment_method IN ('paypal', 'cash')`; `source IN ('facebook', 'local', 'reddit', 'other')`; `(total_cost IS NULL) OR (total_cost >= 0)`
- **Indexes:** `idx_orders_active_created` (created_at DESC) where `archived_at IS NULL`; `orders_charged_total_created_at_idx` (((total_cost + other_fees)), created_at) where `archived_at IS NULL`; `orders_commission_paid_by_idx` (commission_paid_by); `orders_created_at_idx` (created_at DESC); `orders_handoff_by_idx` (handoff_by); `orders_manager_id_idx` (manager_id); `orders_paid_by_idx` (paid_by); `orders_paypal_txn_upper_idx` (upper(paypal_txn_id)) where `(paypal_txn_id IS NOT NULL) AND (archived_at IS NULL)`; `orders_supplier_id_idx` (supplier_id); `orders_total_cost_created_at_idx` (total_cost, created_at) where `archived_at IS NULL`; `orders_user_id_idx` (user_id)
- **Triggers:** `orders_sold_lands_as_done` (before insert or update of lifecycle → `orders_sold_lands_as_done()`); `orders_sync_accounting_payer` (after update of commission_paid_by, commission_paid_by_company, payment, paid_by → `orders_sync_accounting_payer()`)

`category` and `total_cost` are derived from the lines at the end of every transaction that writes lines (services/orderCategory.ts, services/orderGoodsTotal.ts), and `total_cost` stops following them only when it already held a negotiated lot price. Triggers: a write of lifecycle 'sold' lands as 'done', and a change to `payment`, `paid_by` or the commission payer is pushed into the RMB Flow accounting entries (`accounting_sync_payer`).

<a id="erp-order-lines"></a>

#### `order_lines`

One product on a PO, and at the same time one inventory lot: there is no separate stock table. Rows are written by PO create/edit and web-submission convert; afterwards the inventory page, transfers and sell orders keep editing the same row (status, qty, warehouse, sell price).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  | → orders, cascade. |
| `category` | `text` | ✓ |  | Category id ('RAM', 'SSD', 'HDD', 'Other'; 'CPU'/'GPU' are seeded disabled). Checked against `categories` by the app, not by FK. |
| `brand` | `text` |  |  | Maker (RAM, SSD, HDD). |
| `capacity` | `text` |  |  | Size as text, canonical form like '32GB' or '1.92TB' (RAM, SSD, HDD). |
| `generation` | `text` |  |  | RAM DDR generation: 'DDR3', 'DDR4', 'DDR5'. DDR5 lines require serial numbers. |
| `classification` | `text` |  |  | RAM module class: 'RDIMM', 'LRDIMM', 'UDIMM', 'SODIMM', 'CAMM'. |
| `rank` | `text` |  |  | RAM rank/organisation, e.g. '2Rx4'. |
| `speed` | `text` |  |  | RAM speed in MT/s as text, e.g. '3200'. |
| `interface` | `text` |  |  | Drive interface: SATA, SAS, NVMe, U.2 (SSD, HDD). |
| `form_factor` | `text` |  |  | Drive form factor, e.g. '2.5"', 'M.2 2280', 'U.2' (SSD, HDD). |
| `description` | `text` |  |  | Free-text description; the Other category's only spec besides `item_type`. |
| `part_number` | `text` |  |  | Manufacturer part number as entered; matching elsewhere uses a canonicalised form. |
| `condition` | `text` | ✓ | `'Pulled — Tested'` | From catalog group CONDITION: 'New', 'Pulled — Tested', 'Pulled — Untested', 'Used'. |
| `qty` | `integer` | ✓ |  | Units still on the shelf in this lot. A partial sale decrements it; a sell-out keeps it and sets status 'Sold'; 0 means none of it arrived. |
| `unit_cost` | `numeric(12,2)` | ✓ |  | USD paid per unit, before the PO's `other_fees` share. |
| `sell_price` | `numeric(12,2)` |  |  | Projected USD sell price per unit; feeds the commission projection and seeds sell-order lines. NULL = unpriced (never 0, by CHECK). |
| `status` | `text` | ✓ | `'In Transit'` | Lot status, both PO stage and stock state: 'Draft', 'In Transit', 'Reviewing', 'Done' follow the PO (ready_to_pay and done both map to 'Done'), 'In Transit' also while on a transfer, 'Sold' when a sell order consumed the lot, 'Archived' while its PO is archived. 'Reviewing' and 'Done' are sellable. |
| `scan_image_id` | `text` |  |  | R2 key of the AI label scan this line was filled from; joins `label_scans.cf_image_id` (no FK). |
| `scan_confidence` | `real` |  |  | That scan's confidence, 0–1. |
| `position` | `integer` | ✓ | `0` | Display order on the PO; product # is `product_no`. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `health` | `numeric(4,1)` |  |  | Drive health percent, 0–100 (SSD, HDD). |
| `rpm` | `smallint` |  |  | HDD spindle speed. |
| `warehouse_id` | `text` |  |  | → warehouses. Where this lot is when it differs from the PO's warehouse; NULL inherits `orders.warehouse_id`. Set by transfers. |
| `type` | `text` |  |  | RAM device class: 'Desktop', 'Server', 'Laptop' (implied by classification). Before migration 0027 this column held the DDR generation. |
| `transfer_order_id` | `text` |  |  | → transfer_orders. The transfer this lot is moving, or last moved, under; kept after receive so a reopen can find it, cleared when the transfer is discarded. |
| `serial_number` | `text` |  |  | Free-text list of unit serials, one per line (commas/semicolons tolerated). When present its count must equal qty. |
| `chip_number` | `text` |  |  | RAM DRAM chip (die) marking, stored upper-case; a Micron value keeps only the three-letter FBGA die code. |
| `item_type` | `text` |  |  | Other category's type, the `item_types.name` text (no FK). A rename rewrites it in the same transaction. |
| `qty_purchased` | `integer` |  |  | Units originally bought, written only once a partial sale or transfer splits that from `qty`. NULL = same as qty; cost and goods-total maths use COALESCE(qty_purchased, qty). |
| `product_no` | `integer` | ✓ |  | The product's # on its PO, given once at insert and never renumbered or reused. |

- **Primary key:** `id`
- **References:** `order_id` → `orders.id` (on delete cascade); `transfer_order_id` → `transfer_orders.id` (on delete no action); `warehouse_id` → `warehouses.id` (on delete no action)
- **Checks:** `(health IS NULL) OR ((health >= 0) AND (health <= 100))`; `product_no > 0`; `qty >= 0`; `qty_purchased > 0`; `(rpm IS NULL) OR (rpm > 0)`; `(sell_price IS NULL) OR (sell_price > 0)`; `unit_cost >= 0`
- **Indexes:** `order_lines_category_order_idx` (category, order_id); `order_lines_created_at_idx` (created_at DESC); `order_lines_item_type_idx` (item_type); `order_lines_order_id_idx` (order_id); `order_lines_order_product_no_idx` (order_id, product_no); `order_lines_part_number_status_idx` (part_number, status); `order_lines_scan_image_idx` (scan_image_id); `order_lines_status_created_idx` (status, created_at DESC); `order_lines_transfer_order_idx` (transfer_order_id); `order_lines_warehouse_idx` (warehouse_id)
- **Triggers:** `order_lines_number_product` (before insert → `order_lines_number_product()`)

`product_no` comes from the BEFORE INSERT trigger 0169 when an insert names none; a partial transfer clones the row into a second lot carrying the same `product_no`, so (order_id, product_no) is not unique. Which spec columns apply depends on `category` (packages/shared lineSpecFields.ts), and changing the category clears the others.

<a id="erp-order-events"></a>

#### `order_events`

Append-only audit log of one PO: creation, stage moves, line adds/edits/removes, header field changes, evidence and photo changes, archive, box-check flags and AI review results. Written in the same transaction as the change it records.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  |  |
| `actor_id` | `uuid` |  |  | → users. Who made the change; NULL for system writes (AI review, migration backfills). |
| `kind` | `text` | ✓ |  | One of: created, submitted, advanced, reverted, revert_ack, line_added, line_removed, line_edited, meta_changed, handoff, owner_changed, manager_changed, status_meta_changed, line_photo_added, line_photo_removed, archived, unarchived, box_check_flagged, ai_review_done. |
| `detail` | `jsonb` | ✓ | `'{}'::jsonb` | Kind-specific JSON, e.g. {from, to} for advanced, a line snapshot for line_added/line_removed, the full change set for reverted. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete no action); `order_id` → `orders.id` (on delete cascade)
- **Indexes:** `order_events_feed_idx` (created_at DESC, id DESC); `order_events_order_idx` (order_id, created_at DESC)
- **Triggers:** `order_events_no_delete` (before delete → `order_events_lock()`); `order_events_no_update` (before update → `order_events_lock()`)

BEFORE UPDATE/DELETE triggers raise; a DELETE passes only when cascaded from a parent delete (pg_trigger_depth() > 1). Old 'advanced' done → sold rows remain as history and the activity feed skips them.

<a id="erp-order-status-meta"></a>

#### `order_status_meta`

The optional text note for one evidence bucket of a PO, one row per (order, bucket). Upserted from the PO page's evidence endpoints (routes/orders/evidence.ts).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `order_id` | `text` | ✓ |  |  |
| `status` | `text` | ✓ |  | Evidence bucket, not a stage: 'Submission' (purchaser's receipts and seller chat), 'Payment' (cash or PayPal proof), 'Done' (manager's Done note), 'Commission' (proof the purchaser was paid). |
| `note` | `text` |  |  | The bucket's note; NULL when cleared. |
| `set_at` | `timestamptz` | ✓ | `now()` | When the note was last written. |
| `set_by` | `uuid` |  |  | → users. Who last wrote it. |

- **Primary key:** `order_id, status`
- **References:** `order_id` → `orders.id` (on delete cascade); `set_by` → `users.id` (on delete set null)
- **Checks:** `status IN ('Submission', 'Done', 'Payment', 'Commission')`
- **Indexes:** `order_status_meta_set_by_idx` (set_by)

<a id="erp-order-status-attachments"></a>

#### `order_status_attachments`

A file attached to a PO evidence bucket, stored in R2. Submission and Payment files are the purchaser's to manage until Ready to Pay; Done and Commission files are manager-only.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  |  |
| `status` | `text` | ✓ |  | Evidence bucket: 'Submission', 'Payment', 'Done', 'Commission' (see order_status_meta.status). |
| `filename` | `text` | ✓ |  | Original file name as shown. |
| `size_bytes` | `integer` | ✓ |  |  |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key ('stub-<uuid>' in dev/tests without R2). |
| `delivery_url` | `text` | ✓ |  | Public URL the client renders. |
| `uploaded_at` | `timestamptz` | ✓ | `now()` |  |
| `uploaded_by` | `uuid` |  |  | → users. Uploader. |

- **Primary key:** `id`
- **References:** `order_id` → `orders.id` (on delete cascade); `uploaded_by` → `users.id` (on delete set null)
- **Checks:** `status IN ('Submission', 'Done', 'Payment', 'Commission')`
- **Indexes:** `order_status_attachments_order_status_idx` (order_id, status); `order_status_attachments_uploaded_by_idx` (uploaded_by)

Some leave-Draft rules count these rows: a self-paid order needs a Submission file and a company cash order a Payment file (services/orderTxnRule.ts), each only for orders created after its cutoff date.

<a id="erp-order-line-photos"></a>

#### `order_line_photos`

A photo attached by hand to one PO line, stored in R2. The line's AI label-scan image is separate (via `scan_image_id` → label_scans); the API merges both into one photos list.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_line_id` | `uuid` | ✓ |  | → order_lines, cascade. |
| `order_id` | `text` | ✓ |  | → orders. Denormalised so ownership checks and the R2 sweep on order delete need no join. |
| `filename` | `text` | ✓ |  |  |
| `size_bytes` | `integer` | ✓ |  |  |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key ('stub-<uuid>' in dev/tests). |
| `delivery_url` | `text` | ✓ |  | Public URL the client renders. |
| `position` | `integer` | ✓ | `0` | Order within the line's photo strip. |
| `uploaded_at` | `timestamptz` | ✓ | `now()` |  |
| `uploaded_by` | `uuid` |  |  | → users. Uploader. |

- **Primary key:** `id`
- **References:** `order_id` → `orders.id` (on delete cascade); `order_line_id` → `order_lines.id` (on delete cascade); `uploaded_by` → `users.id` (on delete set null)
- **Indexes:** `order_line_photos_line_idx` (order_line_id, "position", uploaded_at); `order_line_photos_order_idx` (order_id); `order_line_photos_uploaded_by_idx` (uploaded_by)

When a transfer clone is discarded its photos move to the line that absorbs it, since the cascade would otherwise orphan their R2 objects.

<a id="erp-order-line-checks"></a>

#### `order_line_checks`

A manager's box check of one PO line: how many units were found and any problem flagged. One row per line that has been touched; written from Review mode (routes/orders/checks.ts).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `line_id` | `uuid` | ✓ |  | → order_lines, cascade; also the primary key. |
| `counted` | `integer` | ✓ | `0` | Units found in the box. The column default is unused. |
| `flag_reason` | `text` |  |  | Problem flagged: 'missing', 'short', 'wrong_part', 'damaged', 'not_as_described'. NULL = no flag. |
| `flag_note` | `text` |  |  | Manager's note on the flag. |
| `checked_at` | `timestamptz` |  |  | When the manager ticked the line as checked; not derived from counted. |
| `updated_by` | `uuid` |  |  | → users. Last manager to touch the check. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `flag_sent_at` | `timestamptz` |  |  | When the flag was sent to the purchaser; editing the reason or note clears it so the new version is sent. |

- **Primary key:** `line_id`
- **References:** `line_id` → `order_lines.id` (on delete cascade); `updated_by` → `users.id` (on delete set null)
- **Checks:** `counted >= 0`; `flag_reason IN ('missing', 'short', 'wrong_part', 'damaged', 'not_as_described')`
- **Indexes:** `order_line_checks_updated_by_idx` (updated_by)

A line with no row reads as fully counted. A short count is only a flag; the line's qty changes only when someone edits the PO.

<a id="erp-order-check-extras"></a>

#### `order_check_extras`

Something found in a PO's box that no line names, recorded during the box check.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  |  |
| `part_number` | `text` | ✓ |  | Part number of the extra item, as scanned or typed. |
| `note` | `text` |  |  | Manager's note. |
| `created_by` | `uuid` |  |  | → users. Manager who recorded it. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `sent_at` | `timestamptz` |  |  | When it was sent to the purchaser with the flags; NULL = not sent yet. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null); `order_id` → `orders.id` (on delete cascade)
- **Indexes:** `order_check_extras_created_by_idx` (created_by); `order_check_extras_order_idx` (order_id)

<a id="erp-po-ai-reviews"></a>

#### `po_ai_reviews`

One AI review run of a PO, and the queue for the background worker. Queued in the same transaction as a move into Reviewing (when the `po_ai_review` setting is on) or by a manager's re-run, then claimed with SKIP LOCKED and run by services/poAiReview.ts.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  |  |
| `trigger` | `text` | ✓ |  | 'stage' (queued by the move into Reviewing) or 'manual' (a manager pressed re-run). |
| `status` | `text` | ✓ | `'queued'` | 'queued', 'running', 'done', 'failed', 'superseded' (the order left review before it finished). |
| `requested_by` | `uuid` |  |  | → users. The mover or the manager who re-ran it. |
| `model` | `text` |  |  | OpenRouter model id used, or 'stub' without an API key. |
| `lines_hash` | `text` |  |  | SHA-256 of the lines the review read. Written on completion; the mid-run edit check compares in memory, and nothing reads this column back. |
| `attempts` | `integer` | ✓ | `0` | Times claimed; a run stale for 10 minutes is retaken, and it is failed after 3 attempts. |
| `prompt_tokens` | `integer` | ✓ | `0` | Model input tokens spent on this review. |
| `completion_tokens` | `integer` | ✓ | `0` | Model output tokens spent on this review. |
| `cost_usd` | `numeric(10,4)` | ✓ | `0` | OpenRouter spend in USD, capped per PO by the setting's maxCostPerPoUsd. |
| `error` | `text` |  |  | Failure reason when status='failed'. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `started_at` | `timestamptz` |  |  |  |
| `finished_at` | `timestamptz` |  |  |  |

- **Primary key:** `id`
- **References:** `order_id` → `orders.id` (on delete cascade); `requested_by` → `users.id` (on delete set null)
- **Checks:** `status IN ('queued', 'running', 'done', 'failed', 'superseded')`; `trigger IN ('stage', 'manual')`
- **Indexes:** `po_ai_reviews_order_idx` (order_id, created_at DESC); unique `po_ai_reviews_pending_uidx` (order_id) where `status = ANY (ARRAY['queued', 'running'])`; `po_ai_reviews_queue_idx` (created_at) where `status = ANY (ARRAY['queued', 'running'])`; `po_ai_reviews_requested_by_idx` (requested_by)

A partial unique index allows one queued-or-running review per order. A move back out of review marks pending ones 'superseded'.

<a id="erp-po-ai-findings"></a>

#### `po_ai_findings`

One issue the AI review found on a PO, usually on one line. The review never edits a line; a manager applies or dismisses each finding in Review mode.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `review_id` | `uuid` | ✓ |  | → po_ai_reviews, cascade. |
| `order_id` | `text` | ✓ |  |  |
| `line_id` | `uuid` |  |  | → order_lines, cascade. NULL for an order-level finding (e.g. budget_exhausted). |
| `severity` | `text` | ✓ |  | 'error', 'warn' or 'info'. |
| `field` | `text` |  |  | Line field (camelCase LineFields key) an Apply would write; NULL when nothing can be applied. |
| `code` | `text` | ✓ |  | Kind: spec_mismatch, spec_blank, pn_label_differs, pn_misread, pn_missing, cost_missing, above_market, budget_exhausted. |
| `current_value` | `text` |  |  | The line's value when reviewed. |
| `suggested_value` | `text` |  |  | Value an Apply writes into `field`. |
| `message` | `text` | ✓ |  | English description, used in the log and notification. |
| `confidence` | `real` |  |  | 0–1 heuristic confidence the check assigns; NULL when not applicable. |
| `sources` | `jsonb` | ✓ | `'[]'::jsonb` | JSON array of evidence: {kind:'decoder'\|'label'\|'web'\|'market', …} with the value each source gave. |
| `resolution` | `text` |  |  | 'applied' or 'dismissed'; NULL = open. |
| `resolved_by` | `uuid` |  |  | → users. Manager who resolved it. |
| `resolved_at` | `timestamptz` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `line_id` → `order_lines.id` (on delete cascade); `order_id` → `orders.id` (on delete cascade); `resolved_by` → `users.id` (on delete set null); `review_id` → `po_ai_reviews.id` (on delete cascade)
- **Checks:** `resolution IN ('applied', 'dismissed')`; `severity IN ('error', 'warn', 'info')`
- **Indexes:** `po_ai_findings_line_idx` (line_id); `po_ai_findings_order_idx` (order_id); `po_ai_findings_resolved_by_idx` (resolved_by); `po_ai_findings_review_idx` (review_id)

On a re-run, a new finding identical to one already dismissed (same line, code, field and values) is written as dismissed.

<a id="erp-label-scans"></a>

#### `label_scans`

Audit trail of every AI label OCR: one row per label photo sent to /api/scan/label, with what the model read. The line it fills joins back by `order_lines.scan_image_id`; the AI review re-reads `extracted` as evidence.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `user_id` | `uuid` | ✓ |  | → users. Who scanned. |
| `cf_image_id` | `text` | ✓ |  | R2 storage key of the label image. The name is left over from Cloudflare Images, which is no longer used. |
| `delivery_url` | `text` |  |  | Public image URL, or 'data:image/placeholder;name=<key>' when stored as a dev stub. |
| `category` | `text` | ✓ |  | Category the label was scanned as (e.g. RAM, SSD). |
| `extracted` | `jsonb` | ✓ | `'{}'::jsonb` | Normalised fields the model read, limited to the category's expected keys. |
| `confidence` | `real` | ✓ | `0` | 0–1: the model's self-rating, floored by how many fields it filled. |
| `provider` | `text` | ✓ | `'stub'` | 'openrouter' or 'stub' (no API key; canned data). |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `user_id` → `users.id` (on delete cascade)
- **Indexes:** `label_scans_cf_image_idx` (cf_image_id, created_at); `label_scans_user_idx` (user_id, created_at DESC)

<a id="erp-part-number-lookups"></a>

#### `part_number_lookups`

Cache of what a web lookup said a part number is, written by the AI review the first time it needs one so each part is paid for once. Never expires.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `canon_pn` | `text` | ✓ |  | Canonical part number (separators and label prefixes stripped); the cache key. |
| `category` | `text` | ✓ |  | Category the lookup was made for. |
| `specs` | `jsonb` | ✓ |  | Field → value spec map the lookup returned. |
| `source_urls` | `jsonb` | ✓ | `'[]'::jsonb` | JSON array of URLs the specs came from. |
| `model` | `text` |  |  | Model id that did the lookup. |
| `fetched_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `canon_pn`

### Suppliers and the public sell-to-us form

The buy-side counterparties. `suppliers` ("Clients" in the UI; `customers` is the sell side) is a CRM book owned per purchaser, with `supplier_notes` as its contact log and `supplier_suggestion_dismissals` remembering waved-off sellers; `orders.supplier_id` attributes a PO to one. The public website forms land in `web_submissions` (with `web_submission_photos` and the email thread in `web_submission_messages`), are rate-budgeted through `public_form_reservations`, and a sell lot becomes a Draft PO plus a house-account supplier only when a manager converts it. `mail_sync_state` is the IMAP read position for customers' email replies to their submissions.

Tables: [`suppliers`](#erp-suppliers), [`supplier_notes`](#erp-supplier-notes), [`supplier_suggestion_dismissals`](#erp-supplier-suggestion-dismissals), [`web_submissions`](#erp-web-submissions), [`web_submission_messages`](#erp-web-submission-messages), [`web_submission_photos`](#erp-web-submission-photos), [`public_form_reservations`](#erp-public-form-reservations), [`mail_sync_state`](#erp-mail-sync-state)

```mermaid
erDiagram
  suppliers ||--o{ supplier_notes : "supplier_id"
  orders |o--o{ web_submissions : "order_id"
  web_submissions ||--o{ web_submission_messages : "submission_id"
  web_submissions ||--o{ web_submission_photos : "submission_id"
```

<a id="erp-suppliers"></a>

#### `suppliers`

A client: someone we buy from ("Clients" in the UI, 供货商 in Chinese). Created by hand, adopted from package/shipping history, or filed as a house account when a web sell lot is converted; owned by one purchaser.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `name` | `text` | ✓ |  | Display name of the person or business. |
| `company` | `text` |  |  | Company name, when different from `name`. |
| `phone` | `text` |  |  |  |
| `email` | `text` |  |  |  |
| `street1` | `text` |  |  |  |
| `street2` | `text` |  |  |  |
| `city` | `text` |  |  |  |
| `state` | `text` |  |  |  |
| `zip` | `text` |  |  |  |
| `country` | `text` | ✓ | `'US'` | ISO country code; defaults to 'US'. |
| `owner_id` | `uuid` |  |  | → users. Purchaser accountable for the relationship; NULL = house account. Changed only through the reassign endpoint, which logs an owner_changed note. |
| `source` | `text` | ✓ | `'manual'` | How the record came to exist: 'manual', 'shipping' / 'package' (adopted from shipment or package history), 'referral', 'facebook', 'reddit', 'walk_in', 'web'. A converted web lot uses its channel (web/facebook/reddit). |
| `status` | `text` | ✓ | `'active'` | Standing a person decides: 'prospect' (new lead), 'active', 'archived'. |
| `supplies` | `text[]` | ✓ | `'{}'[]` | Tags for what they say they can get; what they actually sold is derived from order_lines. |
| `pref_payment` | `text` |  |  | How deals with them are paid; picked from PayPal, Zelle, Check, Cash, Wire. |
| `pref_logistics` | `text` |  |  | Shipping arrangement (they ship / we send a label / we pick up / they drop off), stored as the label in the editor's UI language. |
| `pref_contact` | `text` |  |  | Preferred channel (Call, Text, Email, WhatsApp, WeChat), stored as the label in the editor's UI language. |
| `pref_best_time` | `text` |  |  | Free text: when to reach them. |
| `pref_price` | `text` |  |  | Free text: how they approach price. |
| `notes` | `text` |  |  | Free-text notes. |
| `cadence_days` | `integer` |  |  | Follow-up interval in days (1–365) for this client; NULL = the tier's default from settings. |
| `tier_override` | `char(1)` |  |  | Manager-pinned tier 'A', 'B' or 'C'. Otherwise tier comes from spend rank (top 20% A, next 30% B, rest C). |
| `next_follow_up_at` | `date` |  |  | Date the next call is due. Logging a contact moves it forward by the cadence unless a date is given. |
| `last_contacted_at` | `timestamptz` |  |  | Last logged contact, or the last PO date when seeded from history. |
| `created_by` | `uuid` |  |  | → users. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `match_key` | `text` |  | generated: `((supplier_name_key(name) \|\| '\|') \|\| COALESCE(zip, ''))` | Generated dedupe key: supplier_name_key(name) \|\| '\|' \|\| zip. Never compute it in TypeScript. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null); `owner_id` → `users.id` (on delete set null)
- **Checks:** `(cadence_days IS NULL) OR ((cadence_days >= 1) AND (cadence_days <= 365))`; `source IN ('manual', 'shipping', 'package', 'referral', 'facebook', 'reddit', 'walk_in', 'web')`; `status IN ('prospect', 'active', 'archived')`; `(tier_override IS NULL) OR tier_override IN ('A', 'B', 'C')`
- **Indexes:** `suppliers_follow_up_idx` (next_follow_up_at) where `(next_follow_up_at IS NOT NULL) AND (status <> 'archived')`; `suppliers_match_key_idx` (match_key); `suppliers_owner_idx` (owner_id); `CREATE UNIQUE INDEX suppliers_owner_match_idx ON public.suppliers USING btree (owner_id, match_key) NULLS NOT DISTINCT`

`match_key` is generated from the SQL function `supplier_name_key(name)` plus zip, and the unique index on (owner_id, match_key) NULLS NOT DISTINCT stops duplicates within one book, house account included. Tier and health are derived per read from order history, not stored.

<a id="erp-supplier-notes"></a>

#### `supplier_notes`

The contact log of a client: calls, texts, visits, offers and notes, plus owner handovers. Written by purchasers and by the reassign and adopt endpoints.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `supplier_id` | `uuid` | ✓ |  | → suppliers, cascade. |
| `author_id` | `uuid` |  |  | → users. Who logged it. |
| `kind` | `text` | ✓ | `'note'` | 'note', 'call', 'text', 'visit', 'offer', or 'owner_changed' (written by a reassign). |
| `body` | `text` | ✓ |  | The note text; a default sentence when a contact is logged without typing. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `author_id` → `users.id` (on delete set null); `supplier_id` → `suppliers.id` (on delete cascade)
- **Checks:** `kind IN ('note', 'call', 'text', 'visit', 'offer', 'owner_changed')`
- **Indexes:** `supplier_notes_author_idx` (author_id); `supplier_notes_supplier_idx` (supplier_id, created_at DESC)

Not append-only on purpose: the author can delete a mistaken note.

<a id="erp-supplier-suggestion-dismissals"></a>

#### `supplier_suggestion_dismissals`

A purchaser's "not interested" on a seller suggested from package history, so it stops reappearing in their suggestions rail. Deleted by restore.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `user_id` | `uuid` | ✓ |  | → users, cascade. Who dismissed it. |
| `match_key` | `text` | ✓ |  | supplier_name_key() of the package seller name, without the '\|zip' suffix `suppliers.match_key` carries. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `user_id, match_key`
- **References:** `user_id` → `users.id` (on delete cascade)

<a id="erp-web-submissions"></a>

#### `web_submissions`

One submission from a public website form: a ram4cash.com sell lot or a recycleservers.com quote request. Inserted anonymously by routes/publicForms.ts, triaged on the manager-only Web submissions page; a sell lot becomes a Draft PO only when a manager converts it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'WS-<n>' from `id_counters`; the reference shown to the sender. |
| `site` | `text` | ✓ |  | 'ram4cash' (sell form) or 'recycleservers' (quote form). |
| `kind` | `text` | ✓ |  | 'sell_lot' (lines of RAM/SSD/CPU with label photos) or 'quote'. |
| `status` | `text` | ✓ | `'new'` | 'new', 'contacted' (set by hand, or automatically when a reply is sent to a new one), 'converted' (set only by convert), 'archived', 'spam'. |
| `name` | `text` |  |  | Sender name; quote form only. |
| `company` | `text` |  |  | Sender company; quote form only. |
| `email` | `text` | ✓ |  | Sender email; replies go here. |
| `phone` | `text` |  |  | Sender phone; quote form only. |
| `notes` | `text` |  |  | Sender's free-text notes. |
| `source` | `text` |  |  | Sell lot's ?src= channel: 'web', 'facebook', 'reddit'. NULL on quotes. |
| `payload` | `jsonb` | ✓ |  | The validated form body as JSON; its shape depends on `kind`. |
| `ip` | `text` |  |  | Sender address as received. |
| `user_agent` | `text` |  |  | Sender user agent, truncated to 300 chars. |
| `order_id` | `text` |  |  | → orders. Draft PO the lot was converted into. |
| `staff_note` | `text` |  |  | Manager's triage note. |
| `handled_by` | `uuid` |  |  | → users. Last manager to triage, reply to or convert it. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `ip_key` | `text` |  |  | Rate-limit key for the sender (IPv6 /64 prefix, or the IPv4 address); the per-address daily share counts COALESCE(ip_key, ip). |
| `purge_claimed_at` | `timestamptz` |  |  | Set by the purge before it deletes; triage and convert refuse a claimed row. A claim older than an hour is retaken. |

- **Primary key:** `id`
- **References:** `handled_by` → `users.id` (on delete set null); `order_id` → `orders.id` (on delete set null)
- **Checks:** `kind IN ('sell_lot', 'quote')`; `site IN ('ram4cash', 'recycleservers')`; `status IN ('new', 'contacted', 'converted', 'archived', 'spam')`
- **Indexes:** `web_submissions_created_idx` (created_at DESC, id DESC); `web_submissions_handled_by_idx` (handled_by); `web_submissions_order_idx` (order_id); `web_submissions_status_idx` (status)

Spam or archived rows that were never converted are purged 30 days after `updated_at`, photos first (lib/webSubmissionPurge.ts). A converted row is kept, as the PO's record of who sold it.

<a id="erp-web-submission-messages"></a>

#### `web_submission_messages`

The email thread on a web submission. Replies go out over SMTP from one shared company mailbox; the sender's answers are pulled back from its INBOX over IMAP and matched to the thread by Message-ID.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `submission_id` | `text` | ✓ |  | → web_submissions, cascade. |
| `direction` | `text` | ✓ |  | 'out' (staff reply) or 'in' (sender's mail). |
| `author_id` | `uuid` |  |  | → users. Staff member who sent an outbound reply. |
| `from_addr` | `text` | ✓ |  | From address. |
| `to_addr` | `text` | ✓ |  | To address. |
| `subject` | `text` | ✓ |  |  |
| `body_text` | `text` | ✓ | `''` | Plain-text body. |
| `message_id` | `text` | ✓ |  | RFC 5322 Message-ID and the dedupe key; inbound mail without one gets 'imap:<uidvalidity>:<uid>', which is never used for threading. |
| `in_reply_to` | `text` |  |  | Message-ID this one answers. |
| `status` | `text` | ✓ |  | 'sending' (row written before SMTP), 'sent', 'failed' (see `error`), or 'received' (inbound). |
| `error` | `text` |  |  | SMTP failure text, up to 300 chars. |
| `dmarc` | `text` |  |  | Inbound only: the receiving server's DMARC verdict; 'fail' anywhere wins. NULL when none was reported. |
| `attachment_names` | `text[]` | ✓ | `'{}'[]` | File names attached to inbound mail; the files stay in the mailbox. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `author_id` → `users.id` (on delete set null); `submission_id` → `web_submissions.id` (on delete cascade)
- **Unique:** `(message_id)`
- **Checks:** `direction IN ('out', 'in')`; `status IN ('sending', 'sent', 'failed', 'received')`
- **Indexes:** `web_submission_messages_author_idx` (author_id); `web_submission_messages_submission_idx` (submission_id, created_at)

<a id="erp-web-submission-photos"></a>

#### `web_submission_photos`

A label photo sent with a sell lot, stored in R2. Converting the lot copies each object for `order_line_photos` instead of sharing the key, so deleting a PO photo never breaks the submission.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `submission_id` | `text` | ✓ |  | → web_submissions, cascade. |
| `line_index` | `integer` | ✓ |  | Index of the lot line in `payload.lines` the photo belongs to. |
| `filename` | `text` | ✓ |  | Sender's file name, stored as given (up to 200 chars). |
| `size_bytes` | `integer` | ✓ |  |  |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key. |
| `delivery_url` | `text` | ✓ |  | Public URL. |
| `position` | `integer` | ✓ | `0` | Order within the line's photos. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `submission_id` → `web_submissions.id` (on delete cascade)
- **Indexes:** `web_submission_photos_submission_idx` (submission_id, line_index, "position")

<a id="erp-public-form-reservations"></a>

#### `public_form_reservations`

A place held in the public forms' daily budget by a request still in flight. Inserted under an advisory lock before any upload work and deleted once the submission is stored or fails, so a burst at the last slot can't all get in.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | serial |  |
| `sender` | `text` |  |  | Sender's rate-limit key, or NULL when the Worker didn't name the caller. |
| `bytes` | `bigint` | ✓ | `0` | Photo bytes the request expects to store, counted against the daily byte budget. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **Indexes:** `public_form_reservations_created_idx` (created_at)

The budget counts reservations younger than ten minutes beside the stored rows. Nothing deletes a row a crash left behind; it is just ignored after that.

<a id="erp-mail-sync-state"></a>

#### `mail_sync_state`

How far the IMAP poll has read each mailbox of the shared mail account. The poll pulls customer replies to web submissions (src/mail/inbox.ts) every two minutes. One row per (account, mailbox); today only INBOX.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `account` | `text` | ✓ |  | The mail login (MAIL_USER, lowercased), so pointing the app at another mailbox can't inherit this one's watermark. |
| `mailbox` | `text` | ✓ |  | IMAP folder name. Always 'INBOX' today. |
| `uid_validity` | `bigint` | ✓ |  | The folder's UIDVALIDITY. When it changes, the server has renumbered the folder and the watermark is reset. |
| `last_uid` | `bigint` | ✓ |  | Highest message UID already scanned. It only moves forward. |
| `synced_at` | `timestamptz` | ✓ | `now()` | When the watermark last moved. |

- **Primary key:** `account, mailbox`

### Catalog, warehouses and inventory

There is no inventory table: each `order_lines` row is also an inventory lot, so stock is read off PO lines by their `status`, `qty` and effective warehouse (`order_lines.warehouse_id`, else `orders.warehouse_id`). `inventory_events` is the append-only per-lot history that unarchive, transfer receive and discard read prior statuses back from, and `transfer_orders` groups lots moved between `warehouses`. `categories`, `item_types` and `catalog_options` are the vocabularies the line specs are typed from; lines store the values as text, with no foreign key to them.

Tables: [`categories`](#erp-categories), [`item_types`](#erp-item-types), [`catalog_options`](#erp-catalog-options), [`warehouses`](#erp-warehouses), [`inventory_events`](#erp-inventory-events), [`transfer_orders`](#erp-transfer-orders)

```mermaid
erDiagram
  order_lines ||--o{ inventory_events : "order_line_id"
  warehouses |o--o{ transfer_orders : "from_warehouse_id"
  warehouses ||--o{ transfer_orders : "to_warehouse_id"
```

<a id="erp-categories"></a>

#### `categories`

The product categories a PO line can take, with per-category capture settings; edited by managers in Settings. `order_lines.category` and `orders.category` store the id as text with no FK.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Category id stored on lines: 'RAM', 'SSD', 'HDD', 'Other', 'CPU', 'GPU'. |
| `label` | `text` | ✓ |  | Display name. |
| `icon` | `text` | ✓ | `'box'` | Icon name, e.g. 'chip', 'drive', 'box'. |
| `enabled` | `boolean` | ✓ | `true` | Whether new or edited lines may use it (CPU and GPU are seeded off). |
| `ai_capture` | `boolean` | ✓ | `false` | Shows the AI label-scan capture for this category in the submit forms. |
| `requires_pn` | `boolean` | ✓ | `false` | Settings toggle; stored and editable, but nothing reads it to require a part number. |
| `default_margin` | `numeric(5,2)` | ✓ | `30.0` | Margin percent (e.g. 38.0). Stored, editable and sent to the client in /api/lookups, but no calculation reads it. |
| `position` | `integer` | ✓ | `0` | Sort order in pickers. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`

A disabled category can't be put on a line being written, but existing lines keep it.

<a id="erp-item-types"></a>

#### `item_types`

Vocabulary for what an 'Other' line is (CPU, GPU, PSU, NIC, Server…). Anyone may add one inline from the line form; managers rename and retire.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `name` | `text` | ✓ |  | The type name stored on `order_lines.item_type`. |
| `active` | `boolean` | ✓ | `true` | False = retired: hidden from the picker, kept on existing lines. |
| `created_by` | `uuid` |  |  | → users. Who added it. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Indexes:** `item_types_created_by_idx` (created_by); unique `item_types_name_key` (lower(name))

Names are unique case-insensitively, and re-adding a retired name reactivates it. Lines hold the name as text, so a rename updates `order_lines.item_type` in the same transaction.

<a id="erp-catalog-options"></a>

#### `catalog_options`

Dropdown values for line specs and conditions, one row per (group, value), served to the client at boot by /api/lookups. Maintained only by migrations; no API writes it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `group` | `text` | ✓ |  | List name, after the old frontend constant: RAM_BRAND, RAM_CAP, RAM_TYPE (holds DDR generations), RAM_CLASS, RAM_RANK, RAM_SPEED, SSD_*, HDD_*, CONDITION. |
| `value` | `text` | ✓ |  | The option text, stored verbatim on order_lines. |
| `position` | `integer` | ✓ | `0` | Sort order within the group. |
| `active` | `boolean` | ✓ | `true` | False hides the value from dropdowns. |

- **Primary key:** `id`
- **Unique:** `("group", value)`
- **Indexes:** `catalog_options_group_idx` ("group", "position")

<a id="erp-warehouses"></a>

#### `warehouses`

A place stock is received and held. POs name a receiving warehouse, lots can override it, and transfer orders move lots between them. Managed in Settings.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Text id, by default 'WH-<short>' (e.g. 'WH-DEN'). |
| `name` | `text` | ✓ |  | Display name. |
| `short` | `text` | ✓ |  | Upper-case short code shown in pills (e.g. 'DEN'). |
| `region` | `text` | ✓ |  | Region label used to group warehouses, e.g. 'US-West'. |
| `address` | `text` |  |  | One-line display address; derived from the ship_* fields when they exist, legacy free text otherwise. |
| `timezone` | `text` |  |  | IANA zone name, e.g. 'America/Los_Angeles'. |
| `active` | `boolean` | ✓ | `true` | False hides it from every picker and filter while keeping references intact. |
| `manager_user_id` | `uuid` |  |  | → users. Manager of the warehouse; the contact details come from that user. |
| `ship_contact_name` | `text` |  |  | Ship-to contact, from the structured ship-to added for prepaid labels. That label flow is gone, so the ship_* fields are only edited in Settings and feed `address`. |
| `ship_phone` | `text` |  |  |  |
| `ship_street1` | `text` |  |  | Ship-to street; when set, `address` is derived from the ship_* fields. |
| `ship_street2` | `text` |  |  |  |
| `ship_city` | `text` |  |  |  |
| `ship_state` | `text` |  |  |  |
| `ship_zip` | `text` |  |  |  |
| `ship_country` | `text` |  |  | Ship-to country code; the derived address shows it only when not US (NULL counts as US). |

- **Primary key:** `id`
- **References:** `manager_user_id` → `users.id` (on delete no action)

Soft-archived via `active`; there is no in-app un-archive. `address` is recomputed from the ship_* fields whenever ship_street1 is set (syncDerivedAddress in routes/warehouses.ts).

<a id="erp-inventory-events"></a>

#### `inventory_events`

Append-only history of one inventory lot (`order_lines` row): status moves from PO stage changes and archive, inventory-page edits, sales and sale reversals, and transfers. Unarchive, transfer receive and discard read prior statuses back from it, so it carries state as well as history.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_line_id` | `uuid` | ✓ |  | → order_lines, cascade. |
| `actor_id` | `uuid` |  |  | → users. NULL for migration backfills. |
| `kind` | `text` | ✓ |  | 'status', 'edited', 'priced' (sell price), 'sold', 'unsold' (sell order reopened), 'transferred', 'received', 'reopened' (transfer reopened), 'transfer_discarded'. |
| `detail` | `jsonb` | ✓ | `'{}'::jsonb` | Kind-specific JSON: {field, from, to} for status/edited/priced; {soldQty, remainingQty, sellOrder, priorStatus, priorQty} for sold; {from, to, qty, transfer_order_id, prior_status, peer_line_id?} for transferred. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete no action); `order_line_id` → `order_lines.id` (on delete cascade)
- **Indexes:** `inventory_events_feed_idx` (created_at DESC, id DESC); `inventory_events_line_idx` (order_line_id, created_at DESC)
- **Triggers:** `inventory_events_no_delete` (before delete → `inventory_events_lock()`); `inventory_events_no_update` (before update → `inventory_events_lock()`)

BEFORE UPDATE/DELETE triggers raise; a DELETE passes only when cascaded from the line's deletion.

<a id="erp-transfer-orders"></a>

#### `transfer_orders`

A move of inventory lots from one warehouse to another, created by a manager from the inventory page. Its lots sit at 'In Transit' until it is received ('Pending' → 'Received'); a received transfer can be reopened to 'Pending', and a pending one discarded, which returns the lots and deletes the row.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'TO-<n>' from `id_counters`. |
| `from_warehouse_id` | `text` |  |  | → warehouses. The common source; NULL when the lots came from more than one warehouse. |
| `to_warehouse_id` | `text` | ✓ |  | → warehouses. Destination. |
| `note` | `text` |  |  | Manager's note, up to 200 chars. |
| `created_by` | `uuid` |  |  | → users. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `status` | `text` | ✓ | `'Pending'` | 'Pending' or 'Received' (no CHECK). |
| `received_at` | `timestamptz` |  |  | When it was received; cleared on reopen. |
| `received_by` | `uuid` |  |  | → users. Who received it; cleared on reopen. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete no action); `from_warehouse_id` → `warehouses.id` (on delete no action); `received_by` → `users.id` (on delete no action); `to_warehouse_id` → `warehouses.id` (on delete no action)
- **Indexes:** `transfer_orders_created_by_idx` (created_by); `transfer_orders_received_by_idx` (received_by); `transfer_orders_status_idx` (status, created_at DESC)

Lots point at it through `order_lines.transfer_order_id`. A partial move clones the source lot, and discarding folds the clone back into it.

### Customers and sell orders

The sell side: customers, and the sell orders (SO-n) that sell inventory lots to them. A sell order holds snapshot lines that each → the PO line (lot) they draw from, plus an append-only event log, a note and files for each status step, files for the order as a whole, Pack-mode progress and managers' sign-offs. `sell_order_statuses` is the presentation lookup for its six statuses.

Tables: [`customers`](#erp-customers), [`sell_orders`](#erp-sell-orders), [`sell_order_lines`](#erp-sell-order-lines), [`sell_order_events`](#erp-sell-order-events), [`sell_order_statuses`](#erp-sell-order-statuses), [`sell_order_status_meta`](#erp-sell-order-status-meta), [`sell_order_status_attachments`](#erp-sell-order-status-attachments), [`sell_order_attachments`](#erp-sell-order-attachments), [`sell_order_packs`](#erp-sell-order-packs), [`sell_order_signoffs`](#erp-sell-order-signoffs)

```mermaid
erDiagram
  customers ||--o{ sell_orders : "customer_id"
  order_lines |o--o{ sell_order_lines : "inventory_id"
  sell_orders ||--o{ sell_order_lines : "sell_order_id"
  warehouses |o--o{ sell_order_lines : "warehouse_id"
  sell_orders ||--o{ sell_order_events : "sell_order_id"
  sell_orders ||--o{ sell_order_status_meta : "sell_order_id"
  sell_orders ||--o{ sell_order_status_attachments : "sell_order_id"
  sell_orders ||--o{ sell_order_attachments : "sell_order_id"
  sell_orders ||--o{ sell_order_packs : "sell_order_id"
  sell_orders ||--o{ sell_order_signoffs : "sell_order_id"
```

<a id="erp-customers"></a>

#### `customers`

A buyer we sell to, the counterparty of a sell order. Managers create them in the Customers panel or inline from the sell-order draft form. Archiving sets `active` to false; it does not delete the row.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `name` | `text` | ✓ |  |  |
| `short_name` | `text` |  |  | Optional abbreviation. The customer search matches it too. |
| `region` | `text` |  |  | Free-text region, shown as a chip in the Customers panel. |
| `tags` | `text[]` | ✓ | `'{}'[]` | Free-form labels. 'VIP', 'At risk' and 'New' render as status chips in the Customers panel. |
| `notes` | `text` |  |  |  |
| `active` | `boolean` | ✓ | `true` | false = archived (the Customers panel's Archive / Restore). |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `contact_name` | `text` |  |  |  |
| `contact_email` | `text` |  |  | Validated as an email address by the API. |
| `contact_phone` | `text` |  |  |  |
| `address` | `text` |  |  |  |
| `country` | `text` |  |  |  |

- **Primary key:** `id`
- **Indexes:** `customers_name_idx` (name)

Contact details are structured columns since migration 0018, which dropped the old single `contact` string along with `terms` and `credit_limit`.

<a id="erp-sell-orders"></a>

#### `sell_orders`

One sale of inventory to a customer, managers only. It moves Draft → Packing → Shipped → Awaiting payment → Done, or leaves for Closed. Sell orders are archived, never deleted: no route deletes one.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'SO-n' from id_counters row 'SO'. Sell orders were 'SL-n' until migration 0055. |
| `customer_id` | `uuid` | ✓ |  | → customers. ON DELETE RESTRICT, so a customer with orders can't be deleted. |
| `status` | `text` | ✓ | `'Draft'` | Draft (a proposal that reserves nothing); Packing (being boxed in Pack mode, reserves nothing); Shipped and Awaiting payment (reserve the lines' qty); Done (stock consumed, needs every active manager's sign-off); Closed (the deal fell through and stock is released; reopens to Draft). |
| `notes` | `text` |  |  | Internal notes shown on the order page. |
| `created_by` | `uuid` |  |  | → users. NULL when an MCP client using client credentials created the draft. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `archived_at` | `timestamptz` |  |  | Soft hide: when set, the order drops out of the default list. Reversible, and the row stays intact. |
| `close_reason_id` | `text` |  |  | Why the order was Closed: customer_cancelled, lost_deal, returned, duplicate or other. Reopening clears it. The labels live in frontend i18n. |
| `currency_code` | `char(3)` | ✓ | `'USD'` | Currency the order is priced in: USD or CNY. |
| `fx_rate_to_usd` | `numeric(18,8)` | ✓ | `1` | Multiplier from currency_code to USD (USD per one unit; 1 for USD). Taken from fx_rates at creation and frozen again whenever the lines are rewritten. |
| `fx_source` | `text` | ✓ | `'manual'` | Where that rate came from: 'frankfurter', 'manual' (an override in fx_rates) or 'fixed' (USD). Rows from before migration 0065 carry the 'manual' default. |
| `payment_received_by` | `uuid` |  |  | → users: the manager who physically received the customer's payment. Optional. It pre-fills Paid by on the order's RMB Flow Sale entry. |
| `pre_adjust_native_total` | `numeric(12,2)` |  |  | Order total in its own currency before the first negotiated price adjustment, kept for the 'was X' display. Cleared when the lines are rewritten. |
| `adjusted_at` | `timestamptz` |  |  | When the latest negotiated price adjustment (which prorates line prices) was made. Cleared with pre_adjust_native_total. |
| `adjusted_by` | `uuid` |  |  | → users: who made the latest price adjustment. |
| `done_at` | `timestamptz` |  |  | When the order became Done, which dates the sale for the dashboard and contribution reports. Set once and never cleared. Migration 0150 backfilled it. |
| `next_product_no` | `integer` | ✓ | `1` | Counter for sell_order_lines.product_no. It only goes up, so a removed product's # is never reused. |

- **Primary key:** `id`
- **References:** `adjusted_by` → `users.id` (on delete set null); `created_by` → `users.id` (on delete no action); `customer_id` → `customers.id` (on delete restrict); `payment_received_by` → `users.id` (on delete set null)
- **Checks:** `(close_reason_id IS NULL) OR close_reason_id IN ('customer_cancelled', 'lost_deal', 'returned', 'duplicate', 'other')`; `currency_code IN ('USD', 'CNY')`; `status IN ('Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed')`
- **Indexes:** `idx_sell_orders_active_created` (created_at DESC) where `archived_at IS NULL`; `sell_orders_adjusted_by_idx` (adjusted_by); `sell_orders_close_reason_idx` (close_reason_id) where `close_reason_id IS NOT NULL`; `sell_orders_created_at_idx` (created_at DESC); `sell_orders_created_by_idx` (created_by); `sell_orders_customer_idx` (customer_id); `sell_orders_payment_received_by_idx` (payment_received_by); `sell_orders_status_done_at_idx` (status, done_at); `sell_orders_status_idx` (status); `sell_orders_status_updated_idx` (status, updated_at DESC)

No total is stored: the order total is the sum of its lines' qty × unit_price (USD), and the native total uses source_unit_price. Stock is reserved only in Shipped and Awaiting payment and is consumed at Done (lib/sellCommitment.ts).

<a id="erp-sell-order-lines"></a>

#### `sell_order_lines`

One line of a sell order: a quantity of an inventory lot, or of a hand-typed item, at a unit price. The item fields (category, label, sub_label, part_number, condition) are a snapshot taken when the line is written. Saving an order's lines deletes and re-inserts every row, so line ids are not stable.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `sell_order_id` | `text` | ✓ |  |  |
| `inventory_id` | `uuid` |  |  | → order_lines: the PO line (lot) the goods come from. NULL for a hand-typed line, or after that PO line is deleted (SET NULL). |
| `category` | `text` | ✓ |  |  |
| `label` | `text` | ✓ |  |  |
| `sub_label` | `text` |  |  |  |
| `part_number` | `text` |  |  |  |
| `qty` | `integer` | ✓ |  | Units sold, ≥ 0. 0 means a line kept at zero instead of removed. |
| `unit_price` | `numeric(12,2)` | ✓ |  | USD per unit, always. On a CNY order it is the native price × the order's fx_rate_to_usd. |
| `warehouse_id` | `text` |  |  | → warehouses: where the lot was when the line was saved. Packing lists use the lot's current warehouse instead, because a transfer moves the lot. |
| `condition` | `text` |  |  |  |
| `position` | `integer` | ✓ | `0` | Display order. A save rewrites it in packing-list order. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `source_currency` | `char(3)` |  |  | The order's currency (CNY) on a non-USD order. NULL on USD orders. |
| `source_unit_price` | `numeric(12,2)` |  |  | Native-currency unit price on a non-USD order. NULL on USD orders, where unit_price is already native. |
| `source_fx_rate_to_usd` | `numeric(18,8)` |  |  | The USD-per-native-unit rate that produced unit_price. NULL on USD orders. |
| `append_batch` | `integer` |  |  | Legacy product-numbering tier: n means the n-th save that added lines after the order left Draft. Still written so a rollback to before migration 0170 renumbers nothing; read only by the one-time freeze of old numbers. |
| `product_no` | `integer` |  |  | The product # the packer labels items with. Given once and never recomputed; lots of one product share it, so it is not unique per order. NULL until the backend numbers the line. |

- **Primary key:** `id`
- **References:** `inventory_id` → `order_lines.id` (on delete set null); `sell_order_id` → `sell_orders.id` (on delete cascade); `warehouse_id` → `warehouses.id` (on delete no action)
- **Checks:** `append_batch > 0`; `product_no > 0`; `qty >= 0`
- **Indexes:** `sell_order_lines_inventory_idx` (inventory_id); `sell_order_lines_order_product_no_idx` (sell_order_id, product_no); `sell_order_lines_so_idx` (sell_order_id)

unit_price is always USD. On a CNY order the native price is in source_unit_price. qty may be 0, because a line that can't ship is zeroed rather than removed, which keeps the other lines' #; the app still requires at least 1 per line when an order is created.

<a id="erp-sell-order-events"></a>

#### `sell_order_events`

Append-only audit timeline of a sell order. services/sellOrderAudit.ts writes it in the same transaction as the change it describes. It is independent of the PO's order_events.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `sell_order_id` | `text` | ✓ |  |  |
| `actor_id` | `uuid` |  |  | → users. NULL when no user is behind the write, such as an MCP client. |
| `kind` | `text` | ✓ |  | created, status_changed, closed, reopened, line_added, line_removed, line_edited, meta_changed, price_adjusted, status_meta_changed, attachment_added, attachment_removed, archived, unarchived, signed_off or signoff_withdrawn. No CHECK constraint; the list is the SellOrderEventKind type. |
| `detail` | `jsonb` | ✓ | `'{}'::jsonb` | Kind-specific JSON. For example, status_changed carries {from, to}, and line_edited carries the field changes plus a snapshot of the line. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete no action); `sell_order_id` → `sell_orders.id` (on delete cascade)
- **Indexes:** `sell_order_events_feed_idx` (created_at DESC, id DESC); `sell_order_events_order_idx` (sell_order_id, created_at DESC)
- **Triggers:** `sell_order_events_no_delete` (before delete → `sell_order_events_lock()`); `sell_order_events_no_update` (before update → `sell_order_events_lock()`)

BEFORE UPDATE and BEFORE DELETE triggers raise on any change, with no exemption for cascades, so deleting a sell order that has events fails.

<a id="erp-sell-order-statuses"></a>

#### `sell_order_statuses`

Lookup of the six sell-order statuses with presentation data. /api/lookups serves it, and it drives the order page's status stepper. Migrations 0066 and 0166 seed it, and its ids must match the sell_orders.status CHECK.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Status name, equal to a sell_orders.status value. |
| `label` | `text` | ✓ |  | Display label (the same as id). |
| `short_label` | `text` | ✓ |  | Compact label for pipeline chips, e.g. 'Awaiting pay'. |
| `tone` | `text` | ✓ | `'muted'` | Chip colour token: muted, cool, info, warn or pos. |
| `needs_meta` | `boolean` | ✓ | `false` | true = entering the status asks for evidence (a note and attachments). True for Shipped, Awaiting payment, Done and Closed. |
| `position` | `integer` | ✓ | `0` | Stepper order, from Draft at 0 to Closed at 5. |

- **Primary key:** `id`

<a id="erp-sell-order-status-meta"></a>

#### `sell_order_status_meta`

The evidence note recorded when a sell order enters Shipped, Awaiting payment, Done or Closed. There is one row per (order, status), and the status-meta endpoint and the close handler upsert it. The files for the same step are in sell_order_status_attachments.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `sell_order_id` | `text` | ✓ |  |  |
| `status` | `text` | ✓ |  | The step the evidence belongs to: Shipped, Awaiting payment, Done or Closed. |
| `note` | `text` |  |  | Free-text evidence note. |
| `set_at` | `timestamptz` | ✓ | `now()` | When the evidence was recorded. |
| `set_by` | `uuid` |  |  |  |

- **Primary key:** `sell_order_id, status`
- **References:** `sell_order_id` → `sell_orders.id` (on delete cascade); `set_by` → `users.id` (on delete no action)
- **Checks:** `status IN ('Shipped', 'Awaiting payment', 'Done', 'Closed')`

Draft is deliberately excluded. Reopen notes (Closed → Draft) go to sell_order_events, because under this key successive reopens would overwrite each other.

<a id="erp-sell-order-status-attachments"></a>

#### `sell_order_status_attachments`

A file attached as evidence to one status step of a sell order, such as a payment receipt on Awaiting payment or Done. The file lives in R2; the row holds its key and public URL.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `sell_order_id` | `text` | ✓ |  |  |
| `status` | `text` | ✓ |  | The step the file belongs to: Shipped, Awaiting payment, Done or Closed. |
| `filename` | `text` | ✓ |  |  |
| `size_bytes` | `integer` | ✓ |  |  |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key, or 'stub:<uuid>' in dev. |
| `delivery_url` | `text` | ✓ |  | Public URL the frontend renders. |
| `uploaded_at` | `timestamptz` | ✓ | `now()` |  |
| `uploaded_by` | `uuid` |  |  |  |

- **Primary key:** `id`
- **References:** `sell_order_id` → `sell_orders.id` (on delete cascade); `uploaded_by` → `users.id` (on delete no action)
- **Checks:** `status IN ('Shipped', 'Awaiting payment', 'Done', 'Closed')`
- **Indexes:** `sell_order_status_attachments_so_status_idx` (sell_order_id, status)

<a id="erp-sell-order-attachments"></a>

#### `sell_order_attachments`

A file that belongs to a sell order as a whole, such as the marketplace sale record, the invoice sent or a packing list, as opposed to per-status evidence. It has the same storage shape as sell_order_status_attachments.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `sell_order_id` | `text` | ✓ |  |  |
| `filename` | `text` | ✓ |  |  |
| `size_bytes` | `integer` | ✓ |  |  |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key, or 'stub:<uuid>' in dev. |
| `delivery_url` | `text` | ✓ |  | Public URL the frontend renders. |
| `uploaded_at` | `timestamptz` | ✓ | `now()` |  |
| `uploaded_by` | `uuid` |  |  |  |

- **Primary key:** `id`
- **References:** `sell_order_id` → `sell_orders.id` (on delete cascade); `uploaded_by` → `users.id` (on delete set null)
- **Indexes:** `sell_order_attachments_so_idx` (sell_order_id, uploaded_at); `sell_order_attachments_uploaded_by_idx` (uploaded_by)

<a id="erp-sell-order-packs"></a>

#### `sell_order_packs`

Pack-mode progress: one row per sell-order line a manager has touched while ticking goods into the box. A line with no row reads as its full qty, unpacked.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `sell_order_id` | `text` | ✓ |  |  |
| `line_key` | `text` | ✓ |  | The lot id, or 'typed:' plus an md5 of a hand-typed line's category, label, part number and condition, followed by '#n' to tell apart two lines with the same identity. routes/sellOrderPack.ts builds it. |
| `line_qty` | `integer` | ✓ |  | The line's qty when the row was written. If it no longer matches, the qty was edited and the count is not trusted. |
| `counted` | `integer` | ✓ |  | Units counted into the box, from 0 to line_qty. On a Draft or Packing order, a short count also lowers the line's qty. |
| `packed_at` | `timestamptz` |  |  | When the line was ticked as packed; it orders the Packed group. NULL = not ticked. Never derived from counted. |
| `updated_by` | `uuid` |  |  |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `sell_order_id, line_key`
- **References:** `sell_order_id` → `sell_orders.id` (on delete cascade); `updated_by` → `users.id` (on delete set null)
- **Checks:** `(counted >= 0) AND (counted <= line_qty)`; `line_qty > 0`
- **Indexes:** `sell_order_packs_updated_by_idx` (updated_by)

Rows are keyed by the line's identity rather than sell_order_lines.id, because saving the lines re-inserts every row. Rows that no line on the order answers to any more are pruned when lines are taken off.

<a id="erp-sell-order-signoffs"></a>

#### `sell_order_signoffs`

A manager's sign-off on a sell order, one row per (order, manager). An order can move to Done only when every active manager has a sign-off that still matches it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `sell_order_id` | `text` | ✓ |  |  |
| `user_id` | `uuid` | ✓ |  |  |
| `fingerprint` | `text` | ✓ |  | Hash (services/sellOrderSignoff.ts) of the customer, the currency, and each line's item, qty, native price and lot at the time of signing. |
| `signed_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `sell_order_id, user_id`
- **References:** `sell_order_id` → `sell_orders.id` (on delete cascade); `user_id` → `users.id` (on delete cascade)
- **Indexes:** `sell_order_signoffs_user_id_idx` (user_id)

A row counts only while its fingerprint matches the order's current one, so an edit invalidates sign-offs without any code having to delete them.

### After-sales and shipping

After-sales cases (AS-n) record a customer coming back about goods on a sell order. Each has a snapshot of the affected lines and a timeline. The group also holds inbound shipping: `packages` tracks boxes sellers ship to us through Shippo until each becomes a PO. `shipments` is the unread remainder of the removed prepaid-label flow.

Tables: [`after_sales_cases`](#erp-after-sales-cases), [`after_sales_case_lines`](#erp-after-sales-case-lines), [`after_sales_case_events`](#erp-after-sales-case-events), [`shipments`](#erp-shipments), [`packages`](#erp-packages)

```mermaid
erDiagram
  sell_orders ||--o{ after_sales_cases : "sell_order_id"
  after_sales_cases ||--o{ after_sales_case_lines : "case_id"
  sell_order_lines |o--o{ after_sales_case_lines : "sell_order_line_id"
  after_sales_cases ||--o{ after_sales_case_events : "case_id"
  orders ||--o{ shipments : "order_id"
  orders |o--o{ packages : "order_id"
```

<a id="erp-after-sales-cases"></a>

#### `after_sales_cases`

A customer coming back about goods on a sell order that is Shipped, Awaiting payment or Done. Numbered AS-n and visible to managers only. A case is a record only: it moves no stock and changes no revenue.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'AS-n' from id_counters row 'AS'; the first case is AS-1001. |
| `sell_order_id` | `text` | ✓ |  |  |
| `status` | `text` | ✓ | `'Open'` | Open, In progress, Awaiting return (waiting for the goods to come back), Resolved or Cancelled. Resolved and Cancelled are closed and can be reopened to Open. |
| `resolution` | `text` |  |  | return (the goods come back) or discount (the customer keeps them at a lower price). NULL until decided. |
| `issue` | `text` | ✓ |  | What the customer reported. |
| `amount` | `numeric(12,2)` |  |  | USD refund (return) or price reduction (discount), ≥ 0. Needed to resolve the case; 0 is allowed. |
| `assignee_id` | `uuid` |  |  | → users: the manager handling the case. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `closed_at` | `timestamptz` |  |  | Stamped when the case becomes Resolved or Cancelled; cleared on reopen. |

- **Primary key:** `id`
- **References:** `assignee_id` → `users.id` (on delete set null); `created_by` → `users.id` (on delete set null); `sell_order_id` → `sell_orders.id` (on delete cascade)
- **Checks:** `amount >= 0`; `resolution IN ('return', 'discount')`; `status IN ('Open', 'In progress', 'Awaiting return', 'Resolved', 'Cancelled')`
- **Indexes:** `after_sales_cases_assignee_id_idx` (assignee_id); `after_sales_cases_created_by_idx` (created_by); `after_sales_cases_sell_order_id_idx` (sell_order_id); `after_sales_cases_status_created_idx` (status, created_at DESC)

routes/afterSales.ts enforces the transitions. Awaiting return requires resolution = return, and Resolved requires both a resolution and an amount. Money actually refunded is booked separately, as after_sales entries in accounting_entries.

<a id="erp-after-sales-case-lines"></a>

#### `after_sales_case_lines`

Snapshot of the sell-order lines a case is about, with the quantity affected. Copied when the case is opened, because a sell-order save rewrites its line rows.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `case_id` | `text` | ✓ |  |  |
| `sell_order_line_id` | `uuid` |  |  | → sell_order_lines. Kept only while that row exists; the next line save sets it NULL. |
| `label` | `text` | ✓ |  | Copied from the sell-order line. |
| `part_number` | `text` |  |  |  |
| `qty` | `integer` | ✓ |  | Units affected. The form caps it at the line's qty. |
| `unit_price` | `numeric(12,2)` | ✓ |  | USD unit price, copied from the sell-order line. |

- **Primary key:** `id`
- **References:** `case_id` → `after_sales_cases.id` (on delete cascade); `sell_order_line_id` → `sell_order_lines.id` (on delete set null)
- **Checks:** `qty > 0`
- **Indexes:** `after_sales_case_lines_case_id_idx` (case_id); `after_sales_case_lines_sell_order_line_id_idx` (sell_order_line_id)

<a id="erp-after-sales-case-events"></a>

#### `after_sales_case_events`

Timeline of a case: opened, moved, edited and noted, each with who and when. routes/afterSales.ts writes it in the same transaction as the change.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `case_id` | `text` | ✓ |  |  |
| `kind` | `text` | ✓ |  | created (the case was opened, with to_status 'Open'), status (a move between stages), edited (fields changed) or note (a timeline note). |
| `from_status` | `text` |  |  | The stage a status event moved from. |
| `to_status` | `text` |  |  | The stage a status event moved to. 'Open' on created. |
| `note` | `text` |  |  | The optional note given with a move, or the text of a note event. |
| `detail` | `jsonb` | ✓ | `'{}'::jsonb` | On created: sellOrderId, resolution, amount and line count. On edited: {changes}. |
| `actor_id` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete set null); `case_id` → `after_sales_cases.id` (on delete cascade)
- **Checks:** `kind IN ('created', 'status', 'edited', 'note')`
- **Indexes:** `after_sales_case_events_actor_id_idx` (actor_id); `after_sales_case_events_case_idx` (case_id, created_at)

Unlike the other event tables it has no append-only trigger, but no code updates or deletes its rows.

<a id="erp-shipments"></a>

#### `shipments`

A prepaid shipping label bought for a seller on a PO, one row per box, from the ShipSaving label flow. That flow was removed, and nothing in apps/ reads or writes this table any more. It stays in Postgres as history.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `order_id` | `text` | ✓ |  | → orders: the PO the label was bought for (ON DELETE CASCADE). |
| `status` | `text` | ✓ | `'draft'` | draft, quoted (rates fetched), purchased, in_transit, delivered, voided or exception. |
| `from_name` | `text` |  |  | Seller's name in the ship-from address. The from_* columns hold that address, typed by the purchaser or by the seller through the /s/<token> link. |
| `from_phone` | `text` |  |  |  |
| `from_street1` | `text` |  |  |  |
| `from_street2` | `text` |  |  |  |
| `from_city` | `text` |  |  |  |
| `from_state` | `text` |  |  |  |
| `from_zip` | `text` |  |  |  |
| `from_country` | `text` |  | `'US'` |  |
| `to_name` | `text` |  |  | Start of the ship-to snapshot: the PO's warehouse address at the time of purchase, with no FK. |
| `to_phone` | `text` |  |  |  |
| `to_street1` | `text` |  |  |  |
| `to_street2` | `text` |  |  |  |
| `to_city` | `text` |  |  |  |
| `to_state` | `text` |  |  |  |
| `to_zip` | `text` |  |  |  |
| `to_country` | `text` |  |  |  |
| `weight_oz` | `numeric(8,2)` |  |  | Package weight in ounces. |
| `length_in` | `numeric(6,2)` |  |  | Box length in inches. width_in and height_in are the other dimensions. |
| `width_in` | `numeric(6,2)` |  |  |  |
| `height_in` | `numeric(6,2)` |  |  |  |
| `carrier` | `text` |  |  | Carrier returned by the provider at the time of purchase. |
| `service` | `text` |  |  |  |
| `rate_amount` | `numeric(10,2)` |  |  | Price of the bought rate, in rate_currency (USD). |
| `rate_currency` | `text` | ✓ | `'USD'` |  |
| `delivery_days` | `integer` |  |  | Provider's transit estimate, in days. |
| `provider` | `text` | ✓ |  | shipsaving or stub. Production only ever ran the stub. |
| `provider_rate_id` | `text` |  |  | Provider's id for the rate that was picked. |
| `provider_shipment_id` | `text` |  |  | Provider's id for the bought shipment. |
| `tracking_number` | `text` |  |  |  |
| `tracking_url` | `text` |  |  |  |
| `label_storage_key` | `text` |  |  | R2 key of the label file. label_delivery_url is its public URL. |
| `label_delivery_url` | `text` |  |  |  |
| `label_cost` | `numeric(10,2)` |  |  | USD added to the PO's other_fees when the label was bought. |
| `fees_applied` | `boolean` | ✓ | `false` | Idempotency latch: true while label_cost is folded into the PO's other_fees, so a retried void can't subtract it twice. |
| `tracking_status` | `text` |  |  |  |
| `tracking_eta` | `timestamptz` |  |  |  |
| `last_tracked_at` | `timestamptz` |  |  |  |
| `seller_token` | `text` |  |  | Token for the seller's self-fill link /s/<token>. Unique when set. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `quotes` | `jsonb` |  |  | The last RateQuote[] JSON the provider returned. The buy step resolved the picked rate_id against it. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null); `order_id` → `orders.id` (on delete cascade)
- **Checks:** `height_in > 0`; `length_in > 0`; `provider IN ('shipsaving', 'stub')`; `status IN ('draft', 'quoted', 'purchased', 'in_transit', 'delivered', 'voided', 'exception')`; `weight_oz > 0`; `width_in > 0`
- **Indexes:** `shipments_active_track_idx` (status) where `status = ANY (ARRAY['purchased', 'in_transit', 'exception'])`; `shipments_created_at_id_idx` (created_at DESC, id DESC); `shipments_created_by_idx` (created_by); `shipments_order_id_idx` (order_id); unique `shipments_seller_token_idx` (seller_token) where `seller_token IS NOT NULL`

Apart from tests, only migration 0114's supplier backfill touched it (reading from_name). While the flow was live, buying a label added label_cost to the PO's other_fees and voiding it subtracted the cost again.

<a id="erp-packages"></a>

#### `packages`

An inbound box a seller shipped to us on a label bought outside the system. Shippo tracks it until it is delivered and becomes a PO. Rows come from the unlisted Shipping page, or from pasting a tracking number into a PO's In Transit dialog, which creates the package already linked.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `tracking_number` | `text` | ✓ |  | Carrier tracking number, unique across all packages. |
| `carrier` | `text` | ✓ |  | UPS, FedEx or USPS. |
| `status` | `text` | ✓ | `'purchased'` | purchased (the label exists but the carrier has no movement yet), in_transit, delivered (terminal), or exception (a carrier problem that can recover to in_transit or delivered). |
| `tracking_status` | `text` |  |  | The carrier's latest status text, stored verbatim for display. |
| `tracking_eta` | `timestamptz` |  |  | The carrier's delivery estimate. |
| `last_tracked_at` | `timestamptz` |  |  | When a webhook push or a poll last applied to the row. |
| `seller_name` | `text` |  |  | Who shipped the box: free text, or the PO's supplier name when the PO created the package. Supplier matching and bank match suggestions read it. |
| `note` | `text` |  |  | Free-text note from the add form. |
| `order_id` | `text` |  |  | → orders: the PO this box became, or was added from. SET NULL on PO delete, which returns the package to standalone. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `paypal_txn_id` | `text` |  |  | PayPal transaction id of the payment for the goods. The add form insists on it. It is copied onto the PO, where bank reconciliation auto-links on it. |
| `payment_screenshot_key` | `text` |  |  | R2 key of the PayPal payment screenshot. |
| `payment_screenshot_url` | `text` |  |  | Public URL of the PayPal payment screenshot. |
| `source` | `text` |  |  | Buying channel: facebook, local, reddit or other. The API requires it on new rows; it is NULL only on rows from before the column existed. |
| `tracking_registered_at` | `timestamptz` |  |  | When the number was registered for Shippo webhooks. NULL = not yet, and a sweep registers stragglers. Shippo webhooks are not idempotent, so each number is registered exactly once. |
| `tracking_status_at` | `timestamptz` |  |  | When the carrier says the stored status happened. A pushed event dated earlier is dropped instead of overwriting the newer status. |
| `tracking_claimed_at` | `timestamptz` |  |  | Claim taken before registering, so only one registrant handles a number. It expires after 5 minutes. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null); `order_id` → `orders.id` (on delete set null)
- **Checks:** `carrier IN ('UPS', 'FedEx', 'USPS')`; `source IN ('facebook', 'local', 'reddit', 'other')`; `status IN ('purchased', 'in_transit', 'delivered', 'exception')`
- **Indexes:** `packages_active_track_idx` (status) where `status = ANY (ARRAY['purchased', 'in_transit', 'exception'])`; `packages_created_by_idx` (created_by); `packages_order_id_idx` (order_id); `packages_paypal_txn_upper_idx` (upper(paypal_txn_id)) where `paypal_txn_id IS NOT NULL`; unique `packages_tracking_number_idx` (tracking_number); `packages_unregistered_idx` (created_at) where `(tracking_registered_at IS NULL) AND (status = ANY (ARRAY['purchased', 'in_transit', 'exception']))`

tracking_number is unique, so there is one row per physical box. Status moves only forward through shipping/status.ts, driven by Shippo webhooks and a 45-minute poll.

### Accounting, banking and FX

Money outside the inventory tables. It covers the RMB Flow book (`accounting_entries`, its append-only events and its payment screenshots), the USD bank side synced from Mercury and PayPal (`bank_accounts`, `bank_transactions`), the manager-taught rules and records that classify bank rows (`bank_ignore_rules`, `bank_transfer_counterparties`, `internal_transactions`), and the USD→CNY rate ledger (`fx_rates`) that both sides convert with. Bank links and PO payers feed the book through the `accounting_sync_payer` triggers.

Tables: [`accounting_entries`](#erp-accounting-entries), [`accounting_entry_events`](#erp-accounting-entry-events), [`accounting_entry_attachments`](#erp-accounting-entry-attachments), [`bank_accounts`](#erp-bank-accounts), [`bank_transactions`](#erp-bank-transactions), [`bank_ignore_rules`](#erp-bank-ignore-rules), [`bank_transfer_counterparties`](#erp-bank-transfer-counterparties), [`internal_transactions`](#erp-internal-transactions), [`fx_rates`](#erp-fx-rates)

```mermaid
erDiagram
  after_sales_cases |o--o{ accounting_entries : "after_sales_id"
  orders |o--o{ accounting_entries : "order_id"
  sell_orders |o--o{ accounting_entries : "sell_order_id"
  accounting_entries ||--o{ accounting_entry_events : "entry_id"
  accounting_entries ||--o{ accounting_entry_attachments : "entry_id"
  bank_accounts ||--o{ bank_transactions : "account_id"
  bank_ignore_rules |o--o{ bank_transactions : "ignore_rule_id"
  internal_transactions |o--o{ bank_transactions : "internal_txn_id"
  orders |o--o{ bank_transactions : "order_id"
  sell_orders |o--o{ bank_transactions : "sell_order_id"
```

<a id="erp-accounting-entries"></a>

#### `accounting_entries`

One entry in the RMB Flow, numbered AC-n: money a manager received or paid outside the Business Account (the company's USD bank, which Payments reconciles). An entry is a record only and changes no PO cost or sell-order revenue. Entries are never deleted: a void takes one out of the totals and a restore puts it back.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Human id 'AC-n' from id_counters row 'AC'. |
| `direction` | `text` | ✓ |  | in = received, out = paid. The kind sets the default (a sale is in, everything else out); a manager flips it to record a refund. |
| `kind` | `text` | ✓ |  | What the money was for: purchase (a PO's cost), commission (a PO's purchaser commission), sale (a sell order's payment), after_sales (a case's refund) or other (no record). CHECK constraints allow order_id only on purchase and commission, sell_order_id only on sale, and after_sales_id only on after_sales. |
| `amount` | `numeric(14,2)` | ✓ |  | Always positive, in `currency`. The direction carries the sign. |
| `currency` | `char(3)` | ✓ | `'CNY'` | CNY (the book's currency) or USD. |
| `fx_rate` | `numeric(18,8)` |  |  | CNY per 1 USD that a dollar entry was booked at. Required exactly when currency is USD, and stays put when the FX ledger moves on. |
| `amount_cny` | `numeric(14,2)` |  | generated: `CASE     WHEN (currency = 'CNY') THEN amount     ELSE round((amount * fx_rate), 2) END` | Generated: the amount in RMB (amount itself for CNY, round(amount × fx_rate, 2) for USD). Every total and balance uses it. |
| `method` | `text` | ✓ |  | How the money moved: bank, alipay, wechat, cash or other. |
| `occurred_on` | `date` | ✓ |  | Calendar date as the manager typed it (the managers keep the book on China's side), not an instant. |
| `manager_id` | `uuid` | ✓ |  | → users: the 'Paid by', whose money moved. An active manager, or on a purchase entry the PO's own purchaser. Balances are kept per manager. |
| `order_id` | `text` |  |  | → orders, on purchase and commission entries. SET NULL when a draft PO is deleted, which is logged as an 'unlinked' event. |
| `sell_order_id` | `text` |  |  | → sell_orders, on sale entries. |
| `after_sales_id` | `text` |  |  | → after_sales_cases, on after_sales entries. |
| `counterparty` | `text` |  |  | Supplier, customer or purchaser on the other side. Free text, up to 200 characters. |
| `reference` | `text` |  |  | Transfer or receipt number. Free text, up to 200 characters. The form stopped asking for it in v1.333.0; older entries keep theirs, and an edit leaves it alone. |
| `note` | `text` |  |  |  |
| `created_by` | `uuid` |  |  | → users: who recorded the entry. NULL on entries written by the migration 0196 backfill. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `voided_at` | `timestamptz` |  |  | When set, the entry is voided and out of every total and balance. |
| `voided_by` | `uuid` |  |  | → users. NULL on a void made by the payer sync. |
| `void_reason` | `text` |  |  | Required whenever voided_at is set. The payer sync writes 'Paid from the Business Account'. |
| `author_id` | `uuid` |  |  | → users: who wrote the current version (the recorder, then whoever last changed a field the sign-off covers). The author can't sign it off. NULL, on backfilled entries, lets any manager review. |
| `reviewed_by` | `uuid` |  |  | → users: the manager who signed off. Cleared by an edit to any field except the note. |
| `reviewed_at` | `timestamptz` |  |  |  |
| `review_cleared_at` | `timestamptz` |  |  | When an edit or a payer move cleared a sign-off. While set, the entry reads 'Changed since review'. |
| `query_by` | `uuid` |  |  | → users: the reviewer who asked. |
| `query_text` | `text` |  |  | A reviewer's question about the entry, up to 280 characters. Kept until the next sign-off. |
| `query_at` | `timestamptz` |  |  |  |
| `answer_by` | `uuid` |  |  |  |
| `answer_text` | `text` |  |  | The answer from the person asked, up to 280 characters. |
| `answer_at` | `timestamptz` |  |  |  |
| `query_to` | `uuid` |  |  | → users: who was asked (the author, else manager_id). Stored when the question is asked, so a later payer move doesn't redirect it. |

- **Primary key:** `id`
- **References:** `after_sales_id` → `after_sales_cases.id` (on delete set null); `answer_by` → `users.id` (on delete set null); `author_id` → `users.id` (on delete set null); `created_by` → `users.id` (on delete set null); `manager_id` → `users.id` (on delete restrict); `order_id` → `orders.id` (on delete set null); `query_by` → `users.id` (on delete set null); `query_to` → `users.id` (on delete set null); `reviewed_by` → `users.id` (on delete set null); `sell_order_id` → `sell_orders.id` (on delete set null); `voided_by` → `users.id` (on delete set null)
- **Checks:** `(after_sales_id IS NULL) OR (kind = 'after_sales')`; `amount > 0`; `(answer_at IS NULL) OR (query_at IS NOT NULL)`; `currency IN ('CNY', 'USD')`; `direction IN ('in', 'out')`; `(fx_rate > 0) AND (fx_rate <= 100)`; `kind IN ('purchase', 'commission', 'sale', 'after_sales', 'other')`; `method IN ('bank', 'alipay', 'wechat', 'cash', 'other')`; `(order_id IS NULL) OR kind IN ('purchase', 'commission')`; `(query_at IS NULL) = (query_text IS NULL)`; `(currency = 'USD') = (fx_rate IS NOT NULL)`; `(reviewed_by IS NULL) OR (reviewed_at IS NOT NULL)`; `(sell_order_id IS NULL) OR (kind = 'sale')`; `(voided_at IS NULL) = (void_reason IS NULL)`
- **Indexes:** `accounting_entries_after_sales_id_idx` (after_sales_id); `accounting_entries_answer_by_idx` (answer_by); `accounting_entries_author_id_idx` (author_id); `accounting_entries_book_idx` (occurred_on DESC, created_at DESC, id DESC); `accounting_entries_created_by_idx` (created_by); `accounting_entries_manager_book_idx` (manager_id, occurred_on, created_at, id); `accounting_entries_order_id_idx` (order_id); `accounting_entries_query_by_idx` (query_by); `accounting_entries_query_to_idx` (query_to); `accounting_entries_review_queue_idx` (occurred_on, created_at, id) where `(voided_at IS NULL) AND (reviewed_at IS NULL)`; `accounting_entries_reviewed_by_idx` (reviewed_by); `accounting_entries_sell_order_id_idx` (sell_order_id); `accounting_entries_voided_by_idx` (voided_by)

Triggers on orders (its payer columns) and on bank_transactions call accounting_sync_payer. When the company paid a PO, the function voids the PO's live paid-out purchase and commission entries with the reason 'Paid from the Business Account', unless a manager restored them from that void; otherwise it moves manager_id to the PO's paying person, clears any sign-off, and makes the acting manager (app.actor_id) the author.

<a id="erp-accounting-entry-events"></a>

#### `accounting_entry_events`

History of an RMB Flow entry: every record, edit, void, restore, unlink, review action and screenshot added or removed, with who and when. Written by routes/accounting.ts, by the PO delete path and by accounting_sync_payer.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `entry_id` | `text` | ✓ |  |  |
| `kind` | `text` | ✓ |  | created, edited, voided, restored, unlinked (the PO it was for was deleted), reviewed, unreviewed (a sign-off was withdrawn), queried, answered, query_withdrawn, attachment_added or attachment_removed. |
| `detail` | `jsonb` | ✓ | `'{}'::jsonb` | Kind-specific JSON: field changes, the void reason, the question or answer text, or a screenshot's attachmentId and filename. {synced: 'po'} marks writes by the payer sync, and migration backfills carry a 'backfilled' key. |
| `actor_id` | `uuid` |  |  | → users. NULL on rows from migration backfills, and on payer-sync rows when nobody acted (the bank sync). |
| `created_at` | `timestamptz` | ✓ | `clock_timestamp()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete set null); `entry_id` → `accounting_entries.id` (on delete cascade)
- **Checks:** `kind IN ('created', 'edited', 'voided', 'restored', 'unlinked', 'reviewed', 'unreviewed', 'queried', 'answered', 'query_withdrawn', 'attachment_added', 'attachment_removed')`
- **Indexes:** `accounting_entry_events_actor_id_idx` (actor_id); `accounting_entry_events_entry_idx` (entry_id, created_at); `accounting_entry_events_feed_idx` (created_at DESC, id DESC)
- **Triggers:** `accounting_entry_events_no_delete` (before delete → `accounting_entry_events_lock()`); `accounting_entry_events_no_update` (before update → `accounting_entry_events_lock()`)

Append-only: BEFORE UPDATE and BEFORE DELETE triggers raise, except for deletes cascading from the entry (pg_trigger_depth() > 1). created_at defaults to clock_timestamp() rather than now(), so events written by one transaction keep their order.

<a id="erp-accounting-entry-attachments"></a>

#### `accounting_entry_attachments`

A payment screenshot that proves an RMB Flow entry, stored in R2 under `accounting/<entry id>/`. routes/accounting.ts writes and deletes the rows, managers only, and refuses both on a voided entry. A screenshot is proof, not money: adding or removing one writes an attachment_added or attachment_removed event and leaves the entry's updated_at (its version) and sign-off alone.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `entry_id` | `text` | ✓ |  |  |
| `filename` | `text` | ✓ |  | The name the receipt OCR gave it, `<upload date>-<method>-<amount>.<ext>` (ai/receipt.ts), or the uploaded name when the model couldn't read it. |
| `size_bytes` | `integer` | ✓ |  | After an oversized image was shrunk to the upload cap. |
| `mime_type` | `text` | ✓ |  |  |
| `storage_key` | `text` | ✓ |  | R2 object key ('stub-<uuid>' in dev/tests without R2). Deleted from R2 when the row is. |
| `delivery_url` | `text` | ✓ |  | Public URL the client renders. |
| `uploaded_at` | `timestamptz` | ✓ | `now()` |  |
| `uploaded_by` | `uuid` |  |  | → users. Uploader. |

- **Primary key:** `id`
- **References:** `entry_id` → `accounting_entries.id` (on delete cascade); `uploaded_by` → `users.id` (on delete set null)
- **Indexes:** `accounting_entry_attachments_entry_idx` (entry_id, uploaded_at); `accounting_entry_attachments_uploaded_by_idx` (uploaded_by)

<a id="erp-bank-accounts"></a>

#### `bank_accounts`

One provider account that the bank sync reads: each Mercury account (checking, savings and the IO credit card) and the single PayPal account. banktx/sync.ts upserts it on every run and records the account's sync health.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `source` | `text` | ✓ |  | mercury or paypal. |
| `external_id` | `text` | ✓ |  | The provider's account id. 'primary' for the one PayPal account. |
| `name` | `text` |  |  | Display name: Mercury's nickname or name, 'Mercury Credit' for the card, or 'PayPal'. |
| `last_synced_at` | `timestamptz` |  |  | When a run last synced this account. |
| `sync_cursor` | `text` |  |  | ISO-timestamp watermark of the last completed sync. The next run re-fetches from 5 days before it, because settlements post days after the charge. |
| `dispute_error` | `text` |  |  | Why the last PayPal disputes fetch failed; disputes need a separate PayPal permission. NULL when the fetch worked. |
| `sync_error` | `text` |  |  | The part of the last run that failed without failing the whole source, such as the card list or one card's transactions. A clean run clears it. |
| `deep_synced_at` | `timestamptz` |  |  | When the account was last fetched far enough back to catch a settled row reversed late. Repeated every 7 days. |

- **Primary key:** `id`
- **Unique:** `(source, external_id)`
- **Checks:** `source IN ('mercury', 'paypal')`

<a id="erp-bank-transactions"></a>

#### `bank_transactions`

One provider transaction (a 'leg') from Mercury or PayPal. The bank sync upserts it on (source, external_id), and managers reconcile it on the Payments page by linking it to a PO's cost, a PO's commission or a sell order. A PayPal charge and its Mercury settlement are two legs of one payment that share pair_id; links, notes and owners are written onto every leg of a pair.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `source` | `text` | ✓ |  |  |
| `external_id` | `text` | ✓ |  | The provider's transaction id (PayPal's is uppercased). |
| `account_id` | `uuid` | ✓ |  | → bank_accounts. |
| `posted_at` | `timestamptz` | ✓ |  | The provider's date for the transaction, and the Payments feed's sort key. |
| `amount` | `numeric(12,2)` | ✓ |  | Signed, in `currency`: negative = money out, positive = money in. Direction is always read from the sign. |
| `counterparty` | `text` |  |  | The provider's counterparty name. Transfer rules match it exactly; ignore rules match a substring. |
| `description` | `text` |  |  | The provider's description, rewritten on every sync. |
| `paypal_txn_id` | `text` |  |  | On PayPal legs, equal to external_id. On Mercury legs, parsed from a description that mentions PayPal. Drives auto-pairing and auto-linking to orders.paypal_txn_id. |
| `pair_id` | `uuid` |  |  | Shared by the legs of one payment: a PayPal charge and its Mercury settlement, or the two sides of a transfer. |
| `no_auto_pair` | `boolean` | ✓ | `false` | Tombstone from a person's Ungroup: automatic pairing skips the row on every future sync. |
| `order_id` | `text` |  |  | → orders: the PO this leg is linked to, as its cost or its commission. |
| `link_kind` | `text` |  |  | NULL when unlinked. On a PO: payment = money out to the seller, refund = money back, commission = the purchaser's commission (which never counts toward the PO's cost paid). On a sell order: payment = the buyer's money in, refund = our money out to them. |
| `link_auto` | `boolean` | ✓ | `false` | true when the sync's auto-linker made the link from a matching PayPal transaction id. |
| `linked_by` | `uuid` |  |  | → users: who linked the row. NULL on an auto-link. |
| `linked_at` | `timestamptz` |  |  | Set exactly when the row is linked, i.e. when order_id or sell_order_id is set. |
| `no_auto_link` | `boolean` | ✓ | `false` | Tombstone from a manager's Unlink: the auto-linker never claims the row again. |
| `ignored` | `boolean` | ✓ | `false` | Dismissed from the reconciliation queue and left out of paid totals, either by a person or by a rule (ignore_rule_id set). A CHECK, added NOT VALID, forbids a row that is both ignored and linked. |
| `raw` | `jsonb` | ✓ |  | The provider's full record as fetched. Backfills reclassify rows from it. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `category` | `text` | ✓ | `'external'` | external (money to or from a third party) or transfer (between our own accounts, or from a counterparty taught as a sibling). A transfer can't be linked. |
| `category_manual` | `boolean` | ✓ | `false` | true = a person set category, and syncs and rules never overwrite it. |
| `internal_txn_id` | `uuid` |  |  | → internal_transactions: the internal-movement record this leg is grouped into. A leg in a record can't be linked. |
| `assignee_id` | `uuid` |  |  | → users: the member who owns an unexplained payment. Allowed only on unlinked rows. Unlike other verdicts it keeps the row in the queue. |
| `assigned_by` | `uuid` |  |  |  |
| `assigned_at` | `timestamptz` |  |  | Set exactly when assignee_id is. |
| `dispute` | `jsonb` |  |  | PayPal cases opened on the payment: an array of normalised case objects, newest first, stored on the PayPal leg only, with messages and personal data stripped. |
| `settle_status` | `text` | ✓ | `'settled'` | Whether the money moved: settled, pending, failed or reversed, normalised from PayPal's and Mercury's own statuses. A failed or reversed row can't be linked and doesn't count as a commission payment. |
| `note` | `text` |  |  | One note written by a person, copied to every leg of a pair. The sync never touches it. |
| `note_by` | `uuid` |  |  |  |
| `note_at` | `timestamptz` |  |  |  |
| `ignore_rule_id` | `uuid` |  |  | → bank_ignore_rules: the rule that ignored the row. Deleting or editing the rule un-ignores the row unless another rule matches it. |
| `no_auto_ignore` | `boolean` | ✓ | `false` | Tombstone left when a person un-ignores a rule-ignored row: rules never ignore it again. |
| `currency` | `text` | ✓ | `'USD'` | Currency of amount. Non-USD rows are kept out of pairing, matching and linking, because every PO is in USD. |
| `sell_order_id` | `text` |  |  | → sell_orders: the sell order this leg is linked to. At most one of order_id and sell_order_id is set. |

- **Primary key:** `id`
- **References:** `account_id` → `bank_accounts.id` (on delete cascade); `assigned_by` → `users.id` (on delete set null); `assignee_id` → `users.id` (on delete set null); `ignore_rule_id` → `bank_ignore_rules.id` (on delete set null); `internal_txn_id` → `internal_transactions.id` (on delete set null); `linked_by` → `users.id` (on delete set null); `note_by` → `users.id` (on delete set null); `order_id` → `orders.id` (on delete set null); `sell_order_id` → `sell_orders.id` (on delete set null)
- **Unique:** `(source, external_id)`
- **Checks:** `(assignee_id IS NULL) = (assigned_at IS NULL)`; `(assignee_id IS NULL) OR ((order_id IS NULL) AND (sell_order_id IS NULL))`; `category IN ('external', 'transfer')`; `(link_kind <> 'commission') OR (order_id IS NOT NULL)`; `((NOT (ignored AND ((order_id IS NOT NULL) OR (sell_order_id IS NOT NULL))))) NOT VALID`; `link_kind IN ('payment', 'refund', 'commission')`; `((order_id IS NULL) AND (sell_order_id IS NULL)) = (link_kind IS NULL)`; `((order_id IS NULL) AND (sell_order_id IS NULL)) = (linked_at IS NULL)`; `(note IS NULL) = (note_at IS NULL)`; `(order_id IS NULL) OR (sell_order_id IS NULL)`; `settle_status IN ('settled', 'pending', 'failed', 'reversed')`; `source IN ('mercury', 'paypal')`
- **Indexes:** `bank_transactions_account_id_idx` (account_id); `bank_transactions_assigned_by_idx` (assigned_by); `bank_transactions_assignee_id_idx` (assignee_id); `bank_transactions_counterparty_linked_idx` (counterparty) where `order_id IS NOT NULL`; `bank_transactions_dispute_idx` (posted_at DESC, id) where `dispute IS NOT NULL`; `bank_transactions_feed_idx` (posted_at DESC, id); `bank_transactions_ignore_rule_id_idx` (ignore_rule_id) where `ignore_rule_id IS NOT NULL`; `bank_transactions_internal_txn_id_idx` (internal_txn_id); `bank_transactions_linked_by_idx` (linked_by); `bank_transactions_note_by_idx` (note_by); `bank_transactions_order_id_idx` (order_id); `bank_transactions_pair_id_idx` (pair_id); `bank_transactions_sell_order_id_idx` (sell_order_id); `bank_transactions_settle_idx` (posted_at DESC, id) where `settle_status <> 'settled'`
- **Triggers:** `bank_transactions_sync_accounting_payer` (after insert or delete → `bank_transactions_sync_accounting_payer()`); `bank_transactions_sync_accounting_payer_update` (after update of order_id, link_kind, settle_status → `bank_transactions_sync_accounting_payer()`)

The bank_transactions_sync_accounting_payer triggers fire on insert, delete, and updates that change order_id, link_kind or settle_status. They run accounting_sync_payer for the PO the row left and the PO it joined; a live commission link makes that PO's commission company-paid, which voids its live RMB Flow commission entries.

<a id="erp-bank-ignore-rules"></a>

#### `bank_ignore_rules`

An ignore rule a manager taught, for recurring card spend such as gas, meals or rent. Every sync and every rule edit ignores the open bank rows whose counterparty or description contains the pattern.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `source` | `text` |  |  | mercury or paypal to pin the rule to one source. NULL = either. |
| `pattern` | `text` | ✓ |  | Case-insensitive substring matched against counterparty or description. Must not be blank. |
| `label` | `text` | ✓ | `''` | Name shown on the rows the rule ignored, as 'Ignored · <label>'. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Checks:** `length(btrim(pattern)) > 0`; `source IN ('mercury', 'paypal')`
- **Indexes:** `bank_ignore_rules_created_by_idx` (created_by)

<a id="erp-bank-transfer-counterparties"></a>

#### `bank_transfer_counterparties`

A counterparty taught as internal, such as a sibling company funding Mercury. Every sync marks that source's settled, unlinked external rows with exactly this counterparty as category 'transfer'. Mark as transfer writes it; removing it reverts the rows it classified, except rows with category_manual.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `source` | `text` | ✓ |  | mercury or paypal. |
| `counterparty` | `text` | ✓ |  | Exact counterparty string to match. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Unique:** `(source, counterparty)`
- **Checks:** `source IN ('mercury', 'paypal')`
- **Indexes:** `bank_transfer_counterparties_created_by_idx` (created_by)

<a id="erp-internal-transactions"></a>

#### `internal_transactions`

A record, written by a manager, that groups the bank legs of one internal movement and tells its story. Examples are a Mercury→PayPal transfer, a card-funding chain, or a top-up that arrived split in two. Legs join it through bank_transactions.internal_txn_id.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `title` | `text` |  |  | Short name for the movement. |
| `note` | `text` |  |  | Free-text explanation of the movement. |
| `created_by` | `uuid` |  |  |  |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Indexes:** `internal_transactions_created_by_idx` (created_by); `internal_transactions_feed_idx` (created_at DESC, id)

<a id="erp-fx-rates"></a>

#### `fx_rates`

Ledger of USD→CNY exchange rates. A refresh loop runs every 6 hours and writes at most one Frankfurter row per effective date, and managers can add manual overrides. Sell orders and dollar RMB Flow entries freeze a rate from this ledger when they are written.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | serial |  |
| `base_currency` | `char(3)` | ✓ |  | Always USD (CHECK). |
| `quote_currency` | `char(3)` | ✓ |  | Always CNY (CHECK). |
| `rate` | `numeric(18,8)` | ✓ |  | CNY per 1 USD. Code converts CNY to USD by multiplying by 1/rate. |
| `source` | `text` | ✓ |  | frankfurter (fetched by the refresh loop) or manual (a manager's override). |
| `fetched_at` | `timestamptz` | ✓ | `now()` | When the row was written. The 'latest rate' is the newest fetched_at. |
| `effective_date` | `date` | ✓ |  | The day the rate is for: Frankfurter's date, or the override's. |
| `note` | `text` |  |  | A manager's note on a manual override. |
| `created_by` | `uuid` |  |  | → users: the manager behind a manual row. NULL on fetched rows. |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Checks:** `base_currency = 'USD'`; `quote_currency = 'CNY'`; `rate > 0`; `source IN ('frankfurter', 'manual')`
- **Indexes:** `fx_rates_pair_effective` (base_currency, quote_currency, effective_date DESC, fetched_at DESC); `fx_rates_pair_fetched` (base_currency, quote_currency, fetched_at DESC)

'Latest rate' lookups order by fetched_at, so a manual override wins until a newer row is written. Per-day lookups (lib/fx.ts cnyPerUsdOnFrag) take the newest effective_date on or before the day.

### Market values

Reference prices per part, and the WeChat market report. ref_prices is the Market values list (one row per tracked part), ref_price_events the price readings behind its last_price, and price_sources a display list; the four wechat_market_* tables hold memtrade's daily report (a day row with its board lines, groups read and evidence points), which nothing here feeds into ref_prices or orders. wechat_market_reruns queues a manager's request to have a day redone, for memtrade to claim.

Tables: [`ref_prices`](#erp-ref-prices), [`ref_price_events`](#erp-ref-price-events), [`price_sources`](#erp-price-sources), [`wechat_market_days`](#erp-wechat-market-days), [`wechat_market_groups`](#erp-wechat-market-groups), [`wechat_market_rows`](#erp-wechat-market-rows), [`wechat_market_points`](#erp-wechat-market-points), [`wechat_market_reruns`](#erp-wechat-market-reruns)

```mermaid
erDiagram
  ref_prices ||--o{ ref_price_events : "ref_price_id"
  wechat_market_days ||--o{ wechat_market_groups : "report_date"
  wechat_market_days ||--o{ wechat_market_rows : "report_date"
  wechat_market_days ||--o{ wechat_market_points : "report_date"
```

<a id="erp-ref-prices"></a>

#### `ref_prices`

One row per tracked part on Market values: identifying specs, the scraper's price range, and the latest recorded price that max buy is computed from. Rows come from the seed, from PO intake (auto-tracked, specs only, prices NULL), and from a sell order reaching Done for a part not yet tracked.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Text id: RP-n for seeded rows, a UUID string for auto-tracked ones. |
| `category` | `text` | ✓ |  | Part category id as on PO lines (RAM, SSD, HDD, Other…); no FK. |
| `brand` | `text` |  |  |  |
| `capacity` | `text` |  |  | Capacity as text, e.g. 32GB. |
| `type` | `text` |  |  | RAM generation: DDR3, DDR4 or DDR5. |
| `classification` | `text` |  |  | RAM module class: UDIMM, RDIMM, LRDIMM or SODIMM. |
| `speed` | `text` |  |  | RAM speed as text, e.g. 3200. |
| `interface` | `text` |  |  | Drive interface: SATA, SAS, NVMe, U.2. |
| `form_factor` | `text` |  |  | Drive form factor, e.g. 2.5" or M.2 2280. |
| `description` | `text` |  |  | Free-text description, used for the Other category. |
| `part_number` | `text` |  |  | Manufacturer part number as written; matched in canonical form. |
| `label` | `text` | ✓ |  | Display name; an auto-tracked row builds it from the specs, else the part number. |
| `sub_label` | `text` |  |  | Secondary display line. |
| `target` | `numeric(12,2)` |  |  | Shown as 'Last paid (this team)' on the Market page; only the seed writes it, so auto-tracked rows have none. |
| `low_price` | `numeric(12,2)` |  |  | Scraper's low price, USD. |
| `high_price` | `numeric(12,2)` |  |  | Scraper's high price, USD. |
| `avg_sell` | `numeric(12,2)` |  |  | Scraper's average sell price, USD. The max-buy basis while last_price is NULL; MCP and older readers still show it. |
| `trend` | `real` | ✓ | `0` | Change in avg_sell at the last scraper write, as a fraction of the previous avg_sell (0.05 = +5%); 0 when there was none. The Market page shows it as a percent. |
| `samples` | `integer` | ✓ | `0` | Sales behind avg_sell, as the scraper reports; drives the confidence label (over 20 high, over 10 medium). |
| `source` | `text` |  |  | Legacy source label: the scraper's source name, or auto-intake for a row auto-tracked from a PO or a sale. |
| `stock` | `integer` | ✓ | `0` | Units in stock as shown on the Market page; only the seed writes it. |
| `demand` | `text` | ✓ | `'medium'` | high, medium or low pill on the Market page; only the seed writes it. |
| `history` | `jsonb` | ✓ | `'[]'::jsonb` | Seed-only price series; returned by the API but read by no screen (the sparkline comes from ref_price_events). |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `rank` | `text` |  |  | RAM rank, e.g. 1Rx4 or 2Rx8. |
| `health` | `numeric(4,1)` |  |  | Disk health percent, 0–100. |
| `rpm` | `smallint` |  |  | HDD spindle speed. |
| `last_price` | `numeric(12,2)` |  |  | Newest recorded price, USD, denormalised from ref_price_events; the basis for max buy = basis × (1 − target_margin). |
| `last_price_at` | `timestamptz` |  |  | When last_price was recorded; more than 5 days old reads as stale. |
| `last_price_source` | `text` |  |  | Source tag of that reading (see ref_price_events.source). |

- **Primary key:** `id`
- **Indexes:** `ref_prices_canon_part_idx` (upper(regexp_replace(regexp_replace(COALESCE(part_number, ''), '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)([[:space:]]*[:#][[:space:]]*|[[:space:]]+)', '', 'i'), '[[:space:]_-]+', '', 'g'))); `ref_prices_category_idx` (category); `ref_prices_last_price_at_idx` (last_price_at DESC)

part_number is matched in canonical form (P/N or S/N prefix stripped, spaces, _ and - removed, upper-cased) through an expression index that must stay byte-identical to PART_PREFIX_RE in lib/part-number.ts. It is not unique: rows in different categories may share one, and writes pick the most recently updated.

<a id="erp-ref-price-events"></a>

#### `ref_price_events`

One row per price reading of a part, the history behind ref_prices.last_price. Written only through lib/refPriceEvents.ts, which updates the part's last_price columns in the same transaction; the Market page's sparkline reads the newest 12.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `ref_price_id` | `text` | ✓ |  | → ref_prices (cascade). |
| `price` | `numeric(12,2)` | ✓ |  | Unit price, USD, never negative; a price-list import converts yuan at the FX ledger's latest rate. |
| `source` | `text` | ✓ |  | Origin tag: scraper:<name>, mcp:<client id>, manual:<email>, import:<email>, sale:<sell order id>, seed. The retired bid:<order> survives on old rows. |
| `note` | `text` |  |  | Optional free text: the file name for an import, up to 280 characters over MCP. |
| `actor_user_id` | `uuid` |  |  | → users. Who recorded it; NULL for the scraper, service clients and the seed, and once the user is deleted. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_user_id` → `users.id` (on delete set null); `ref_price_id` → `ref_prices.id` (on delete cascade)
- **Checks:** `price >= 0`
- **Indexes:** `ref_price_events_actor_user_id_idx` (actor_user_id); `ref_price_events_feed_idx` (created_at DESC, id DESC); `ref_price_events_ref_price_id_idx` (ref_price_id, created_at DESC); `ref_price_events_source_idx` (source)

Not trigger-locked like the other ledgers: reopening a Done sell order deletes its sale:<id> events and puts each part's last_price back to its newest remaining reading.

<a id="erp-price-sources"></a>

#### `price_sources`

The list of price sources on a Market row's expanded panel. Rows come from the seed only; no route writes them.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `text` | ✓ |  | Slug; internal-sales is the one the UI computes a price for. |
| `label` | `text` | ✓ |  |  |
| `position` | `integer` | ✓ | `0` | Sort order. |
| `active` | `boolean` | ✓ | `true` | Inactive rows are left out of /api/lookups. |

- **Primary key:** `id`

Only internal-sales (the team's last-30-day PO sell prices) has a value; every other source renders as no feed connected.

<a id="erp-wechat-market-days"></a>

#### `wechat_market_days`

One row per report day of memtrade's WeChat market report (an 08:00 → 08:00 ET window), pushed from the office Mac with a wechat:write service token. A push deletes the day with its children and writes it again; the evidence points follow in batches.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `report_date` | `date` | ✓ |  | The report day; every child table cascades from it. |
| `window_start` | `timestamptz` | ✓ |  | Start of the window memtrade read. |
| `window_end` | `timestamptz` | ✓ |  | End of the window; must be after window_start. |
| `degraded` | `boolean` | ✓ | `false` | TRUE when Claude was unavailable and memtrade parsed the day with its rules; it pushes the day again once redone. |
| `summary` | `text` |  |  | Claude's market notes as markdown bullets; NULL when that call failed. |
| `warnings` | `text[]` | ✓ | `'{}'[]` | memtrade's own warnings, repeated in the page banner. |
| `messages` | `integer` | ✓ |  | Group messages in the window. |
| `groups_total` | `integer` | ✓ |  | Groups memtrade read. |
| `groups_active` | `integer` | ✓ |  | Groups with at least one message in the window. |
| `candidates` | `integer` | ✓ |  | Messages memtrade's prefilter took for possible trade posts. |
| `posts` | `integer` | ✓ |  | Trade posts after deduplication: one sender saying one thing, however many copies. |
| `buy_posts` | `integer` | ✓ |  | Posts wanting to buy. |
| `sell_posts` | `integer` | ✓ |  | Posts offering to sell. |
| `buyers` | `integer` | ✓ |  | Distinct senders of buy posts. |
| `sellers` | `integer` | ✓ |  | Distinct senders of sell posts. |
| `point_count` | `integer` | ✓ |  | How many evidence points the push said would follow. |
| `pushed_at` | `timestamptz` | ✓ | `now()` | When the day was last pushed. |
| `push_id` | `uuid` | ✓ | `gen_random_uuid()` | Id of the current push; a point batch naming an older one is refused with 409 day_replaced. |
| `stored_points` | `integer` | ✓ | `0` | Points actually stored, recounted after every batch. |

- **Primary key:** `report_date`
- **Checks:** `window_end > window_start`

Read-only for the ERP: nothing here feeds ref_prices or any order. stored_points below point_count means the point batches stopped part-way.

<a id="erp-wechat-market-groups"></a>

#### `wechat_market_groups`

One row per WeChat group memtrade read for a report day, so a quiet day can be told from a group the Mac never received. Shown on the WeChat page's Groups tab.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `report_date` | `date` | ✓ |  |  |
| `group_id` | `text` | ✓ |  | WeChat group id. |
| `name` | `text` | ✓ |  |  |
| `messages` | `integer` | ✓ |  | The group's messages in the window. |
| `candidates` | `integer` | ✓ |  | Of those, messages the prefilter took for possible trade posts (About memory on the page). |
| `first_seen` | `timestamptz` |  |  | Earliest message memtrade holds from the group; one inside the window marks it newly joined. |

- **Primary key:** `report_date, group_id`
- **References:** `report_date` → `wechat_market_days.report_date` (on delete cascade)

<a id="erp-wechat-market-rows"></a>

#### `wechat_market_rows`

One price-board line per report day: a memory part family with its buy-side and sell-side statistics side by side. Replaced whole with its day.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `report_date` | `date` | ✓ |  |  |
| `kind` | `text` | ✓ |  | Line family: quote (brand × capacity × speed × short code, e.g. 三星 64G 5600 DM0, the brand & code board), spec (e.g. 64G 5600) or code (the traders' shorthand, e.g. 32G DM0). |
| `row_key` | `text` | ✓ |  | The line's text key; evidence points name it as kind:key. |
| `brand` | `text` |  |  | Module brand; quote lines only. |
| `capacity_gb` | `integer` |  |  | Module capacity, GB. |
| `speed` | `integer` |  |  | Module speed, e.g. 5600. |
| `code` | `text` |  |  | Traders' short part code, e.g. DM0. |
| `ddr` | `text` |  |  | DDR generation. |
| `form_factor` | `text` |  |  | server or pc. |
| `ranks` | `text[]` | ✓ | `'{}'[]` | The most-quoted ranks on the line's posts, up to 3. |
| `part_numbers` | `text[]` | ✓ | `'{}'[]` | The most-quoted full part numbers (codes longer than 5 characters), up to 4. |
| `signal` | `text` |  |  | memtrade's supply read from buy against sell posts: 紧缺 short, 偏紧 tight, 均衡 balanced, 偏松 loose, 过剩 glut; NULL under two posts. |
| `buy_posts` | `integer` | ✓ |  | Buy posts on the line. |
| `buy_senders` | `integer` | ✓ |  | Distinct traders bidding. |
| `buy_groups` | `integer` | ✓ |  | Groups the buy posts appeared in. |
| `buy_exposures` | `integer` | ✓ |  | Copies of the buy posts across groups and hours. |
| `buy_qty` | `integer` | ✓ |  | Total modules wanted. |
| `buy_prices` | `jsonb` | ✓ | `'[]'::jsonb` | Bids per currency-and-tax bucket, most quotes first: [{bucket, n, min, median, max, approx, outliers}] over each trader's latest price, outliers 2.5× off the median dropped. |
| `sell_posts` | `integer` | ✓ |  | Sell posts on the line. |
| `sell_senders` | `integer` | ✓ |  | Distinct traders asking. |
| `sell_groups` | `integer` | ✓ |  | Groups the sell posts appeared in. |
| `sell_exposures` | `integer` | ✓ |  | Copies of the sell posts across groups and hours. |
| `sell_qty` | `integer` | ✓ |  | Total modules offered. |
| `sell_prices` | `jsonb` | ✓ | `'[]'::jsonb` | Asks per bucket, same shape as buy_prices. |

- **Primary key:** `report_date, kind, row_key`
- **References:** `report_date` → `wechat_market_days.report_date` (on delete cascade)
- **Checks:** `form_factor IN ('server', 'pc')`; `kind IN ('spec', 'code', 'quote')`
- **Indexes:** `wechat_market_rows_key_idx` (kind, row_key, report_date)

(kind, row_key) identifies a line across days, indexed for its 30-day history. Prices in different buckets (RMB含税, RMB未税, RMB, USD) are never compared.

<a id="erp-wechat-market-points"></a>

#### `wechat_market_points`

The evidence: one row per quoted item per post on a report day, linked to the board lines it counted toward. Arrives after the day in batches of up to 500; a retried batch's rows already stored are skipped.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `report_date` | `date` | ✓ |  |  |
| `post_key` | `text` | ✓ |  | memtrade's id for the post (one sender saying one thing). |
| `item_index` | `integer` | ✓ |  | Position of the item within the post. |
| `sender_id` | `text` | ✓ |  | Sender's WeChat id. |
| `sender_name` | `text` | ✓ |  | Sender's display name. |
| `group_ids` | `text[]` | ✓ |  | Groups the post appeared in. |
| `first_at` | `timestamptz` | ✓ |  | First copy of the post. |
| `last_at` | `timestamptz` | ✓ |  | Last copy of the post. |
| `messages` | `integer` | ✓ |  | Copies of the post across groups and hours. |
| `source` | `text` | ✓ |  | llm (read by Claude) or rules (memtrade's rule parser, the fallback). |
| `direction` | `text` | ✓ |  | buy (a bid) or sell (an ask). |
| `brands` | `text[]` | ✓ | `'{}'[]` | Brands named on the item. |
| `capacity_gb` | `integer` |  |  | Module capacity, GB. |
| `speed` | `integer` |  |  | Module speed, e.g. 5600. |
| `ddr` | `text` |  |  | DDR3, DDR4 or DDR5. |
| `rank` | `text` |  |  | Module rank, normalised like 2R4. |
| `form_factor` | `text` |  |  | server or pc. |
| `part_codes` | `text[]` | ✓ | `'{}'[]` | Part codes named: short trader codes (5 characters or fewer, e.g. DM0) and full part numbers. |
| `date_code` | `text` |  |  | Batch or year code as quoted, e.g. DC25+ or 24+. |
| `condition` | `text` |  |  | 全新 new, 拆新 pulled but unused, 拆机 pulled or used, 不良 faulty; NULL when unstated. |
| `price` | `numeric(14,2)` |  |  | Price per module in `currency`; NULL when quoted per chip, per box or not at all. |
| `price_approx` | `boolean` | ✓ | `false` | Masked or open-ended price, e.g. 17XXX or 3XXX起. |
| `currency` | `text` |  |  | RMB or USD. |
| `tax` | `text` |  |  | 含税 (tax included) or 未税 (excluded); NULL when unstated. |
| `qty` | `integer` |  |  | Modules offered or wanted. |
| `location` | `text` |  |  | Delivery place as quoted, e.g. 深圳 or 香港. |
| `raw_line` | `text` | ✓ |  | The message line the item was read from; may be empty. |
| `row_keys` | `text[]` | ✓ | `'{}'[]` | kind:key of every board line the item counted toward, e.g. quote:三星 64G 5600 DM0. |

- **Primary key:** `report_date, post_key, item_index`
- **References:** `report_date` → `wechat_market_days.report_date` (on delete cascade)
- **Checks:** `currency IN ('RMB', 'USD')`; `direction IN ('buy', 'sell')`; `form_factor IN ('server', 'pc')`; `source IN ('llm', 'rules')`

Read within one day only, so the primary key's report_date prefix serves as the index; a line finds its posts through row_keys.

<a id="erp-wechat-market-reruns"></a>

#### `wechat_market_reruns`

A manager's Re-run on Monitors ▸ WeChat (v1.363.0). The ERP can't reach memtrade on the office Mac, so the request waits here until memtrade's poller claims it (`POST /api/wechat-market/push/reruns/claim`), reruns the day, pushes it as usual and finishes it. The page shows each day's latest request.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `report_date` | `date` | ✓ |  | The day to redo. No foreign key: the rerun's own push deletes and re-inserts the day. |
| `status` | `text` | ✓ | `'queued'` | queued → running (claimed) → done or failed. A claim not finished within 2 hours is marked failed. |
| `requested_by` | `uuid` |  |  | The manager who clicked Re-run. |
| `requested_at` | `timestamptz` | ✓ | `now()` |  |
| `claimed_at` | `timestamptz` |  |  | When memtrade took it. |
| `finished_at` | `timestamptz` |  |  |  |
| `degraded` | `boolean` | ✓ | `false` | Done, but Claude was still unavailable and memtrade fell back to its rules. |
| `error` | `text` |  |  | Why it failed, as memtrade reported it (up to 2000 characters). |

- **References:** `requested_by` → `users.id` (on delete set null)
- **Checks:** `status IN ('queued', 'running', 'done', 'failed')`
- **Indexes:** unique `(report_date) WHERE status IN ('queued', 'running')`, one open request per day, so a second click joins the first; `(report_date, requested_at DESC)`; `(requested_by)`

### Facebook account pool

The ERP-side Facebook account pool: purchased Marketplace logins that purchasers take and return and managers assign to fleet workers. fb_pool_accounts is one row per login with its secrets sealed, and fb_pool_events is the append-only ledger of who did what to which account. fb_worker_accounts is every stint an account had on a fleet worker, with the proxy it went out through, and fb_proxies holds when a manager last revived a DEAD proxy. The fleet's own worker vault lives in the Facebook tracker's database, not here.

Tables: [`fb_pool_accounts`](#erp-fb-pool-accounts), [`fb_pool_events`](#erp-fb-pool-events), [`fb_worker_accounts`](#erp-fb-worker-accounts), [`fb_proxies`](#erp-fb-proxies)

<a id="erp-fb-pool-accounts"></a>

#### `fb_pool_accounts`

One row per Facebook Marketplace login in the shared pool. Managers add, import, edit, assign, retire and remove accounts; purchasers take up to two, return them or report a problem; an hourly loop checks each live account on Facebook once a week.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `no` | `integer` | ✓ | identity | The pool's #, an identity never reused, so a removed account leaves a gap. |
| `uid` | `text` | ✓ |  | Facebook numeric user id, 10–20 digits; unique. |
| `password_enc` | `text` |  |  | Sealed Facebook password; NULL = none. |
| `totp_enc` | `text` |  |  | Sealed 2FA (TOTP) key; NULL = none. |
| `email` | `text` | ✓ | `''` | Login e-mail, clear text; empty string when none. |
| `email_password_enc` | `text` |  |  | Sealed password of the mailbox; NULL = none. |
| `recovery_email` | `text` | ✓ | `''` | Recovery e-mail, clear text, but sent only to a manager or the holder. |
| `cookie_enc` | `text` |  |  | Sealed session cookie; NULL = none. |
| `cookie_uid` | `text` |  |  | The cookie's c_user, parsed at write time; the one part of a cookie every role sees, for the UID check. |
| `note` | `text` | ✓ | `''` | Free-text note; a purchaser's report can replace it. |
| `status` | `text` | ✓ | `'available'` | available (a spare), taken (a purchaser holds it), fleet (assigned to a monitor worker), problem (Needs attention: reported or failed the weekly check) or retired. |
| `holder_user_id` | `uuid` |  |  | → users. The purchaser holding it while taken; NULL for fleet. |
| `holder_name` | `text` |  |  | Holder's name snapshot, or the worker id when fleet. Kept on problem to show who had the account. |
| `held_since` | `timestamptz` |  |  | When the current holder got it. |
| `added_at` | `timestamptz` | ✓ | `now()` |  |
| `cookie_at` | `timestamptz` |  |  | When the cookie was last set; drives the cookie-freshness display. |
| `batch` | `text` | ✓ |  | Label of the purchase batch it came in; Manual or Imported when none is given. |
| `created_by` | `uuid` |  |  | → users. The manager who added it. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `alive_checked_at` | `timestamptz` |  |  | When the weekly liveness check last claimed it; NULL = never, so checked on the next pass. |
| `token_enc` | `text` |  |  | Sealed Facebook Graph access token (EAA…) that came with the account; NULL = none. |

- **Primary key:** `no`
- **References:** `created_by` → `users.id` (on delete set null); `holder_user_id` → `users.id` (on delete set null)
- **Unique:** `(uid)`
- **Checks:** `status IN ('available', 'taken', 'fleet', 'problem', 'retired')`; `uid ~ '^\d{10,20}$'`
- **Indexes:** `fb_pool_accounts_created_by_idx` (created_by); `fb_pool_accounts_holder_user_id_idx` (holder_user_id); `fb_pool_accounts_status_idx` (status, added_at)
- **Triggers:** `fb_worker_accounts_track` (after insert, update of status or holder_name, or delete → `fb_worker_accounts_track()`)

Secrets are AES-256-GCM blobs sealed under FB_POOL_KEY (lib/sealed.ts, v1.<iv>.<tag>.<body> base64url), never clear text, and are shown only to a manager or the purchaser holding the account; the prod→dev copy nulls every *_enc column. `no` never reuses a removed account's number.

<a id="erp-fb-pool-events"></a>

#### `fb_pool_events`

Append-only ledger of every action on the pool: who did what to which account, including copies and reveals of a secret. Managers read the newest 100 as the pool's activity.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `uuid` | ✓ | `gen_random_uuid()` |  |
| `account_no` | `integer` |  |  | The account's #; NULL for an import, which covers many accounts. |
| `actor_id` | `uuid` |  |  | → users. Who acted; NULL for the weekly check. |
| `actor_name` | `text` | ✓ |  | Actor's name snapshot, so the ledger still names a deactivated member; Weekly check for the liveness loop. |
| `kind` | `text` | ✓ |  | added, edited, imported, took, returned, reported, retired, removed, copied, revealed (a secret shown in the browser) or assigned (login sent to a fleet worker). |
| `status` | `text` | ✓ |  | The account's status after the action; a removal records retired. |
| `detail` | `text` |  |  | Per kind: the report reason (checkpoint, wrong_password, bad_code, disabled); the worker id for assigned; the secret field for copied or revealed; 'N · batch' for imported; the uid for removed; 'replaced by #n on <worker>' for an account a new assignment displaced. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `actor_id` → `users.id` (on delete set null)
- **Checks:** `kind IN ('added', 'edited', 'imported', 'took', 'returned', 'reported', 'retired', 'removed', 'copied', 'revealed', 'assigned')`
- **Indexes:** `fb_pool_events_account_idx` (account_no, created_at DESC); `fb_pool_events_actor_id_idx` (actor_id); `fb_pool_events_created_idx` (created_at DESC)
- **Triggers:** `fb_pool_events_no_delete` (before delete → `fb_pool_events_lock()`); `fb_pool_events_no_update` (before update → `fb_pool_events_lock()`)

UPDATE and DELETE raise (fb_pool_events_lock). account_no has no FK on purpose, so a removed account's history outlives it.

<a id="erp-fb-worker-accounts"></a>

#### `fb_worker_accounts`

One row per stint of a pool account on a fleet worker: it opens when the account becomes fleet on that worker and closes when it stops being that. The worker page lists them as Accounts used, and a proxy's failed stints decide whether it is DEAD.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  | The worker, as the account's holder_name named it; compared case-blind. |
| `account_no` | `integer` | ✓ |  | The pool account's #. No FK, so a removed account's stints are kept. |
| `uid` | `text` | ✓ |  | The account's Facebook uid at the time. |
| `proxy_url` | `text` |  |  | The worker's proxy when the account was sent, scheme://host:port with no login, as the fleet document names it. NULL = the VM's own IP (proxy_known) or not recorded. |
| `proxy_known` | `boolean` | ✓ | `false` | Whether /assign recorded the proxy. False for stints backfilled from the ledger (before v1.319.0), opened by an edit with no Assign, or sent while the fleet document did not list the worker. |
| `started_at` | `timestamptz` | ✓ | `now()` |  |
| `ended_at` | `timestamptz` |  |  | NULL while the account is still on the worker. |
| `outcome` | `text` |  |  | What the account became when the stint ended: a pool status (available, taken, problem, retired), fleet for another worker, or removed when it left the pool. NULL while current. problem and retired count against the proxy. |

- **Primary key:** `id`
- **Checks:** `(ended_at IS NULL) = (outcome IS NULL)`; `outcome IN ('available', 'taken', 'fleet', 'problem', 'retired', 'removed')`
- **Indexes:** `fb_worker_accounts_failed_idx` (proxy_url, ended_at) WHERE outcome IN ('problem', 'retired'); `fb_worker_accounts_open_idx` UNIQUE (account_no) WHERE ended_at IS NULL; `fb_worker_accounts_worker_idx` (lower(worker_id), started_at DESC)

Written only by the fb_worker_accounts_track trigger on fb_pool_accounts, except proxy_url and proxy_known, which /assign stamps on the open stint. A proxy whose distinct failed accounts since its last revive exceed four (FB_PROXY_DEAD_AFTER) is DEAD, and /assign refuses its workers.

<a id="erp-fb-proxies"></a>

#### `fb_proxies`

A row for each proxy a manager has revived. A revive restarts the proxy's failed count: stints that ended before it no longer count.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `url` | `text` | ✓ |  | The proxy, as fb_worker_accounts.proxy_url names it. |
| `revived_at` | `timestamptz` |  |  | The latest revive. |
| `revived_by` | `uuid` |  |  | → users. The manager who revived it. |
| `revived_by_name` | `text` |  |  | Their name snapshot. |

- **Primary key:** `url`
- **References:** `revived_by` → `users.id` (on delete set null)
- **Indexes:** `fb_proxies_revived_by_idx` (revived_by)

Only the latest revive is kept; the backend logs each one.

### Fleet

The ERP fleet: the city task queue the Facebook Marketplace workers pull from, and the slots they run pool accounts in. fleet_cities and fleet_items are the catalog managers edit; fleet_settings holds the queue's knobs; fleet_tasks is one open task per enabled city and item, with fleet_task_events as its log; fleet_hosts are the machines that run worker containers; fleet_slots is the fleet's view of each pool account (who runs it, where, under which lease epoch) and fleet_workers the containers that heartbeat. fleet_minutes is a view that sums each account's leased minutes per UTC day for the daily budget. The accounts themselves and their secrets stay in fb_pool_accounts. Migration 0206 creates all of it; the routes under /api/fleet fill it in later releases.

Tables: [`fleet_cities`](#erp-fleet-cities), [`fleet_items`](#erp-fleet-items), [`fleet_settings`](#erp-fleet-settings), [`fleet_hosts`](#erp-fleet-hosts), [`fleet_claim_tickets`](#erp-fleet-claim-tickets), [`fleet_proxies`](#erp-fleet-proxies), [`fleet_proxy_checks`](#erp-fleet-proxy-checks), [`fleet_proxy_rounds`](#erp-fleet-proxy-rounds), [`fleet_slots`](#erp-fleet-slots), [`fleet_workers`](#erp-fleet-workers), [`fleet_tasks`](#erp-fleet-tasks), [`fleet_task_events`](#erp-fleet-task-events), [`fleet_minutes`](#erp-fleet-minutes) (view)

<a id="erp-fleet-cities"></a>

#### `fleet_cities`

One row per Marketplace location the fleet searches. A city a manager adds starts disabled until a worker has verified its slug (a wrong slug searches the account's own city silently) or the manager overrides the check.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `slug` | `text` | ✓ |  | The Facebook location slug or numeric id in the Marketplace URL. |
| `name` | `text` | ✓ |  | Display name. |
| `radius_km` | `integer` | ✓ | `500` | Search radius. |
| `region` | `text` |  |  | Region label from master.toml, for grouping. |
| `enabled` | `boolean` | ✓ | `false` | True once verified or overridden; only enabled cities get tasks. |
| `per_day` | `integer` |  |  | Searches per item per day; NULL follows per_day_default (and tiers later). |
| `pinned` | `boolean` | ✓ | `false` | Retired in v1.372.0 (RS-435): nothing reads or writes it. Kept until no running release writes it, then dropped. |
| `verified_at` | `timestamptz` |  |  | When a worker confirmed the slug. |
| `verified_as` | `text` |  |  | The location label Facebook showed; 'imported' for cities taken from master.toml. |
| `added_by` | `uuid` |  |  | → users. The manager who added it; NULL for imports. |
| `added_at` | `timestamptz` | ✓ | `now()` |  |
| `disabled_at` | `timestamptz` |  |  | When a manager removed it; its open tasks are cancelled then. |

- **Primary key:** `slug`
- **References:** `added_by` → `users.id` (on delete set null)
- **Indexes:** `fleet_cities_added_by_idx` (added_by)

<a id="erp-fleet-items"></a>

#### `fleet_items`

What the fleet searches for in every city: the search phrases and filters of one item, as the monitor's config names them.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `name` | `text` | ✓ |  | The item's key, e.g. server_ram, enterprise_ssd. |
| `phrases` | `jsonb` | ✓ |  | Search phrases, a JSON array of strings. |
| `filters` | `jsonb` | ✓ | `'{}'` | Marketplace filters: date_listed, delivery_method, max_results and the like. |
| `enabled` | `boolean` | ✓ | `true` | A disabled item gets no tasks and its open ones are cancelled. |

- **Primary key:** `name`

<a id="erp-fleet-settings"></a>

#### `fleet_settings`

The queue's knobs, one JSON value per key: per_day_default, budget_minutes, lease_minutes, task_max_minutes, poll_hold_seconds, familiar_days, start_fresh_hours, quarantine_hours, quarantine_probe_hours, retention_days, max_accounts_per_proxy (RS-415: non-parked slots one proxy may carry, default 2) and search (the monitor's search parameters). A missing key means its default (packages/shared/src/fleet.ts, FLEET_SETTINGS_DEFAULTS).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  |  |
| `value` | `jsonb` | ✓ |  | A number for the limits, an object for search. |
| `updated_by` | `uuid` |  |  | → users. The manager who last changed it; NULL for an import. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `key`
- **References:** `updated_by` → `users.id` (on delete set null)
- **Indexes:** `fleet_settings_updated_by_idx` (updated_by)

<a id="erp-fleet-hosts"></a>

#### `fleet_hosts`

A machine that runs worker containers through one fleet-agent container. The agent authenticates with a bearer token the ERP showed once when the host was added; only its sha256 is stored.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `host_id` | `text` | ✓ |  | The host's name, e.g. homelab, worker-60-14; worker ids are `<host_id>-<n>`. |
| `token_hash` | `text` | ✓ |  | sha256 (hex) of the host's bearer token. |
| `capacity` | `integer` | ✓ | `0` | The most workers the agent may run; `desired.count` is this capped at the accounts the host could run now (CONTRACTS §6). |
| `authoritative` | `boolean` | ✓ | `false` | False means observe only: the agent reports what runs and starts nothing. |
| `version` | `text` |  |  | The agent's version from its last report. |
| `last_seen_at` | `timestamptz` |  |  | The last report or desired-state read. |
| `report` | `jsonb` |  |  | The agent's last report: its version and the containers it runs. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `host_id`

<a id="erp-fleet-claim-tickets"></a>

#### `fleet_claim_tickets`

Single-use bearers the host agent mints right before each `docker run`, one per worker container, so the container claims with a ticket instead of the host token. A ticket is good for one claim, for its host, worker id and handoff epoch, for 10 minutes; only its sha256 is stored. Migration 0211.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `token_hash` | `text` | ✓ |  | sha256 (hex) of the ticket (`fct_…`). |
| `host_id` | `text` | ✓ |  | → fleet_hosts. The host that minted it. |
| `worker_id` | `text` | ✓ |  | The only worker id it may claim for. |
| `handoff_epoch` | `integer` |  |  | The handoff the claim must carry, or none. |
| `expires_at` | `timestamptz` | ✓ |  | Mint time + 10 minutes; no claim after it, not even a retry. |
| `consumed_at` | `timestamptz` |  |  | When the claim it let through committed. |
| `claim_id` | `text` |  |  | That claim's boot id: only its retries pass afterwards. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `token_hash`
- **References:** `host_id` → `fleet_hosts.host_id` (on delete cascade)
- **Indexes:** `fleet_claim_tickets_worker_idx` (host_id, worker_id), `fleet_claim_tickets_expires_idx` (expires_at)

<a id="erp-fleet-proxies"></a>

#### `fleet_proxies`

The proxies the ERP fleet browses through, as a list managers edit on the Account pool tab. A slot made there copies its proxy's sealed URL into `fleet_slots.proxy_url` (what a claim reads) and names the proxy in `fleet_slots.proxy_id`; editing a proxy's URL or timezone rewrites its slots' copy and device clock. No route answers the URL. Migration 0213.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `label` | `text` | ✓ |  | The name managers pick it by, e.g. Decodo NY 1. |
| `url_enc` | `text` | ✓ |  | scheme://user:pass@host:port, sealed under FB_POOL_KEY (lib/sealed.ts). Never returned or logged. |
| `host` | `text` | ✓ |  | The exit's host, lowercased, in clear for the list. |
| `port` | `integer` | ✓ |  | The exit's port (1..65535). |
| `timezone` | `text` | ✓ |  | IANA zone of the exit; a slot's device clock follows it. |
| `note` | `text` | ✓ | `''` |  |
| `created_by` | `uuid` |  |  | → users. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `created_by` → `users.id` (on delete set null)
- **Indexes:** `fleet_proxies_exit_idx` unique (lower(host), port), `fleet_proxies_created_by_idx` (created_by)

<a id="erp-fleet-proxy-checks"></a>

#### `fleet_proxy_checks`

One health check of one proxy port, dialed through the proxy itself to an IP-geo lookup (`fleet/proxyProbe.ts`). Every five minutes a round checks each `fleet_proxies` row from the backend and each port the homelab workers dial through rs_console's `/v1/proxies/health`; **Check now** on the Proxies tab adds rows between rounds. Kept 14 days; each round prunes older rows. No login is stored. Migration 0215.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | identity |  |
| `exit` | `text` | ✓ |  | `scheme://host:port`, login cut out, the name `fb_worker_accounts.proxy_url` uses. |
| `source` | `text` | ✓ |  | `erp` (a `fleet_proxies` row) or `coordinator` (a homelab port). |
| `proxy_id` | `integer` |  |  | → fleet_proxies; NULL for a coordinator port or a removed proxy. |
| `workers` | `text[]` | ✓ | `'{}'` | The homelab workers dialing a coordinator port at the time. |
| `checked_at` | `timestamptz` | ✓ | `now()` | A round's rows share its `fleet_proxy_rounds.started_at`. |
| `ok` | `boolean` | ✓ |  | The lookup answered through the proxy. |
| `latency_ms` | `integer` |  |  | Connect, tunnel and lookup, end to end. |
| `exit_ip` | `text` |  |  | The address the lookup saw. |
| `city` / `region` / `country` / `org` | `text` |  |  | Where the exit IP is, and its ISP. |
| `error` | `text` |  |  | Why a failed check failed, worded by the probe (never a raw socket message). |

- **Primary key:** `id`
- **References:** `proxy_id` → `fleet_proxies.id` (on delete set null)
- **Indexes:** `fleet_proxy_checks_exit_idx` (source, exit, checked_at desc), `fleet_proxy_checks_at_idx` (checked_at), `fleet_proxy_checks_proxy_id_idx` (proxy_id)

<a id="erp-fleet-proxy-rounds"></a>

#### `fleet_proxy_rounds`

A single row. A backend instance claims a round by moving `started_at` forward with a conditional UPDATE, so two instances never run the same one. Migration 0215.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `boolean` | ✓ | `true` | Always true: the one row. |
| `started_at` | `timestamptz` | ✓ | `'-infinity'` | When the last full round started. |
| `coordinator` | `text` |  |  | What rs_console said last round: ok, not_configured, unsupported, unreachable. |
| `coordinator_at` | `timestamptz` |  |  | The last round the console answered; its rows are the homelab ports in use. |

- **Primary key:** `id`

<a id="erp-fleet-slots"></a>

#### `fleet_slots`

The fleet's view of one pool account: which worker runs it, on which host, under which lease epoch. A worker claims a free slot at boot and the claim bumps the epoch; every later call carries it in the worker's token, and a token whose epoch is no longer the slot's is refused with 409, so one account never runs in two browsers. The login itself stays in fb_pool_accounts.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `account_no` | `integer` | ✓ |  | → fb_pool_accounts. The account's #. |
| `worker_id` | `text` |  |  | The worker holding the slot; NULL when free. |
| `host_id` | `text` |  |  | → fleet_hosts. Where it runs now. |
| `last_host_id` | `text` |  |  | Where it last ran; a claim from that host is preferred, so an account keeps its machine. |
| `epoch` | `integer` | ✓ | `0` | Bumped by every claim; the worker token names it. |
| `lease_expires_at` | `timestamptz` |  |  | Renewed by heartbeats; NULL or past means the slot is free to claim. |
| `proxy_url` | `text` |  |  | The account's sticky proxy, scheme://user:pass@host:port, sealed under FB_POOL_KEY (lib/sealed.ts); NULL = the host's own IP. |
| `device` | `jsonb` |  |  | The browser profile the account always presents: user agent, viewport, timezone, locale, datr hints. |
| `home_cities` | `jsonb` | ✓ | `'[]'` | City slugs this account searches first. |
| `quarantined_until` | `timestamptz` |  |  | Set by the 0-card rule; while in the future the slot gets only probe tasks. |
| `claim_id` | `text` | | | Idempotency key for the current process boot; unique within the host when non-null. |
| `handoff_epoch` | `integer` | | | Epoch confirmed stopped by the host; the replacement claims with it while `reserved_until` lasts. |
| `reserved_until` | `timestamptz` | | | A handoff reservation's deadline (gate timeout, 20 min); the lease ends with it. NULL = not reserved. A park is still the infinite lease. |
| `quarantine_reset_at` | `timestamptz` | | | Manual release or positive probe: earlier search results cannot re-quarantine this account. |
| `quarantine_evidence` | `jsonb` | | | Rule, search count, cities and latest result that justified quarantine. |
| `proxy_id` | `integer` | | | → fleet_proxies. The listed proxy the slot was made on (0213); NULL for a seeded slot or once the proxy is removed, when `proxy_url` keeps its copy. |
| `note` | `text` | ✓ | `''` | Free text for managers. |

A slot made on the Account pool tab (`POST /api/fleet/slots`) gets a generated `device`: no user agent (`native: ["user_agent"]`, Chromium's own), a common desktop screen and scale picked from the account number, a viewport of the screen less the browser chrome, the proxy's timezone and `en-US`.

- **Primary key:** `account_no`
- **References:** `account_no` → `fb_pool_accounts.no` (on delete cascade); `host_id` → `fleet_hosts.host_id` (on delete set null); `proxy_id` → `fleet_proxies.id` (on delete set null)
- **Indexes:** `fleet_slots_host_id_idx` (host_id), `fleet_slots_proxy_id_idx` (proxy_id)

<a id="erp-fleet-workers"></a>

#### `fleet_workers`

One row per worker container that has claimed a slot, kept current by its heartbeats. The Slots and Hosts pages read it next to fleet_slots.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  | `<host_id>-<n>`, chosen by the host agent. |
| `host_id` | `text` |  |  | → fleet_hosts. |
| `account_no` | `integer` |  |  | → fb_pool_accounts. The slot it holds. |
| `epoch` | `integer` |  |  | The epoch it claimed. |
| `state` | `text` |  |  | The monitor's state: HEALTHY, SESSION_EXPIRED, CHECKPOINT, CHALLENGE_*, DEGRADED, DEAD. A parked state releases the worker's task. |
| `version` | `text` |  |  | The worker image's version. |
| `last_heartbeat_at` | `timestamptz` |  |  |  |
| `vnc_port` | `integer` |  |  | The host port the agent mapped for noVNC. |
| `detail` | `jsonb` |  |  | Whatever the heartbeat carried: last search, page state. |
| `relogin_id` | `text` |  |  | The latest re-login a manager queued (`POST /api/fleet/workers/:id/relogin`), a random id. Cleared by a fresh claim. Migration 0214. |
| `relogin_requested_at` | `timestamptz` |  |  | When it was queued. |
| `relogin_requested_by` | `text` |  |  | The manager's e-mail. |
| `relogin_delivered_at` | `timestamptz` |  |  | When a heartbeat handed the `relogin` directive over; null while it waits. A heartbeat delivers it once. |

- **Primary key:** `worker_id`
- **References:** `account_no` → `fb_pool_accounts.no` (on delete set null); `host_id` → `fleet_hosts.host_id` (on delete cascade)
- **Indexes:** `fleet_workers_account_no_idx` (account_no); `fleet_workers_host_id_idx` (host_id)

<a id="erp-fleet-tasks"></a>

#### `fleet_tasks`

One search of one item in one city. The scheduler keeps exactly one open (ready or leased) task per city, item and kind; a worker leases the next due one, finishes it, and the scheduler writes the next with `due_at = done + day / per_day`. The partial unique index is what makes that safe from two backend instances.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | sequence |  |
| `city` | `text` | ✓ |  | → fleet_cities. |
| `item` | `text` | ✓ |  | → fleet_items. |
| `kind` | `text` | ✓ | `'search'` | search, verify-slug (a new city's check) or probe (a quarantined slot's periodic test). |
| `due_at` | `timestamptz` | ✓ |  | Not handed out before this. |
| `priority` | `integer` | ✓ | `0` | Higher first; a manager's task is 100, a slug check 50. |
| `state` | `text` | ✓ |  | ready, leased, done, cancelled or expired. |
| `worker_id` | `text` |  |  | Who leased it. |
| `account_no` | `integer` |  |  | The account it was searched with. No FK, so a removed account's history is kept. |
| `epoch` | `integer` |  |  | The lease epoch of the worker that took it. |
| `leased_at` | `timestamptz` |  |  |  |
| `lease_expires_at` | `timestamptz` |  |  | Renewed by HEALTHY heartbeats; past it the task is expired and re-queued. |
| `started_at` | `timestamptz` |  |  | When the worker reported the search began. |
| `done_at` | `timestamptz` |  |  |  |
| `reason` | `text` |  |  | Why it exists: cadence, added (a new city), manual, start (a round start), probe or verify. |
| `result` | `jsonb` |  |  | What the search found: cards, opened, reviewed, alerted, seconds, stopped. |

- **Primary key:** `id`
- **References:** `city` → `fleet_cities.slug`; `item` → `fleet_items.name`
- **Checks:** `state IN ('ready', 'leased', 'done', 'cancelled', 'expired')`
- **Indexes:** `fleet_tasks_due_idx` (state, due_at); `fleet_tasks_item_idx` (item); `fleet_tasks_open_idx` UNIQUE (city, item, kind) WHERE state IN ('ready', 'leased') AND kind <> 'probe'; `fleet_tasks_probe_idx` UNIQUE (account_no) WHERE state IN ('ready','leased') AND kind = 'probe'; `fleet_tasks_worker_idx` (worker_id, leased_at DESC); `fleet_tasks_done_account_idx` (account_no, city, done_at) WHERE state = 'done'; `fleet_tasks_done_pair_idx` (city, item, done_at DESC) WHERE state = 'done' AND kind = 'search'; `fleet_tasks_purge_idx` (COALESCE(done_at, leased_at, due_at), id) WHERE state IN ('done', 'cancelled', 'expired') (migration 0210)

**Retention (RS-409).** Once an hour each backend that runs the scheduler deletes terminal tasks (done, cancelled, expired) whose `COALESCE(done_at, leased_at, due_at)` is older than `fleet_settings.retention_days` (default 90, 30..730, never below `familiar_days`), with their `fleet_task_events` and `fleet_task_attempts` rows, 5,000 tasks per run, oldest first, under an advisory lock so one instance purges at a time. Ready and leased tasks are never deleted. Two kinds of row stay whatever their age, because a rule reads them without a window: the newest done search per city and item (the cadence's last done, the Cities tab's last search) and the verify-slug task holding each city's latest slug verdict (whether the city may be enabled again).

The scheduler sends `NOTIFY fleet_tasks` (payload: the item) after every write that can make a task ready; a worker's held next-task poll listens on it.

<a id="erp-fleet-task-attempts"></a>

#### `fleet_task_attempts`

Closed lease attempts retained independently of requeued tasks (migration 0207).
The fleet_archive_attempt trigger inserts once when a lease ends, or on a
terminal historical task insert. Current leased tasks remain the live part of
the minutes view until closed.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | sequence | |
| `task_id` | `bigint` | | | → fleet_tasks; on delete set null preserves spent minutes. The retention purge deletes a purged task's attempts itself. |
| `account_no` | `integer` | | | Historical account number, retained after pool deletion. |
| `epoch` | `integer` | | | Worker lease generation. |
| `leased_at` | `timestamptz` | ✓ | | Attempt start. |
| `ended_at` | `timestamptz` | ✓ | | Attempt end, never before start. |

Primary key id; UNIQUE NULLS NOT DISTINCT (task_id, account_no, epoch, leased_at)
prevents duplicate charging. Index: fleet_task_attempts_account_idx
(account_no, leased_at); that unique index covers the task FK.

The fleet_fence_pool_owner trigger on pool status/holder/uid changes or deletion advances
the slot epoch and releases its current task atomically. Worker mutations lock
pool account, then slot, then city/task; rollout operations acquire the release
row before those locks. Claims serialize by host/worker and lock pool before
slot. Probes have a separate unique open index on account_no; the city's open
task index excludes probes, so two accounts may probe the same home city.

<a id="erp-fleet-task-events"></a>

#### `fleet_task_events`

What happened to a task, in order: the city log the fleet pages show.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | sequence |  |
| `task_id` | `bigint` |  |  | → fleet_tasks. |
| `worker_id` | `text` |  |  | The worker that reported it; NULL for the scheduler's own (expired). |
| `kind` | `text` | ✓ |  | handed, started, searched, finished, stopped, released, expired or done. |
| `detail` | `jsonb` |  |  | Per kind: the result for done, the parked state for released, the cards seen for searched. |
| `at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`
- **References:** `task_id` → `fleet_tasks.id` (on delete cascade)
- **Indexes:** `fleet_task_events_task_idx` (task_id, at)

<a id="erp-fleet-minutes"></a>

#### `fleet_minutes` (view)

Each account's leased minutes per UTC day, from closed fleet_task_attempts plus
current leased tasks. Time spanning midnight is split by overlap, rather than
assigned entirely to the starting day. Returning a task to ready preserves the
ended attempt. Done uses the completion time; an expired/released lease is
capped at its expiry. The next-task pick skips accounts at budget_minutes.
Migration 0207 backfills known terminal attempts; time erased by earlier
releases cannot be recovered.

| Column | Type | Meaning |
| --- | --- | --- |
| `account_no` | `integer` | The account. |
| `day` | `date` | The UTC day whose overlap is charged. |
| `minutes` | `numeric` | Leased minutes that day. |

### System

Workspace-wide configuration and plumbing: key/value settings (workspace_settings), the counters behind human-readable ids such as PO-1289 (id_counters), and the migration runner's ledger (schema_migrations).

Tables: [`workspace_settings`](#erp-workspace-settings), [`id_counters`](#erp-id-counters), [`schema_migrations`](#erp-schema-migrations)

<a id="erp-workspace-settings"></a>

#### `workspace_settings`

Workspace-wide settings as key → JSON value; managers read and change them on Settings, purchasers read only low_health_pct. Migrations seed the standard keys and code falls back to a default when a key is absent.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  | Setting name. Read by the backend: target_margin (fraction; max buy = basis × (1 − it)), low_margin_floor, category_default_margin, low_health_pct, upload_max_bytes, upload_allowed_mime, public_form_daily_submissions, public_form_daily_bytes, po_ai_review, po_company_txn_required_from, po_self_pay_chat_required_from, po_cash_shot_required_from, mcp.sellOrderCustomerId and crm.* (cadenceDays, tierFloorUsd, quietMultiple, lostMultiple). |
| `value` | `jsonb` | ✓ |  | The value as JSON. The po_*_required_from keys hold the timestamp a PO rule took effect in this environment (older POs exempt; absent = rule off). |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `key`

Pricing and upload keys are type-checked on PATCH (upload_allowed_mime can only narrow the hard-coded safe list); any other key is stored as sent. The Settings → General keys (workspace_name, domain, currency, fiscal_start, timezone, fx_auto, week_start, notify_*) are stored for the page but no backend code reads them, so the notify_* toggles gate nothing.

<a id="erp-id-counters"></a>

#### `id_counters`

One row per human-readable id series; allocating an id is `UPDATE … SET value = value + 1 RETURNING value` (lib/id-seq.ts), whose row lock serialises concurrent creates.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `name` | `text` | ✓ |  | Series: PO (purchase orders; was SO until 0044), SO (sell orders; was SL until 0055), TO (transfer orders), WS (web submissions), AS (after-sales cases), AC (RMB Flow accounting entries). |
| `value` | `bigint` | ✓ |  | The last number handed out; the next id is value + 1. |

- **Primary key:** `name`

Replaced a MAX(id)+1 scheme that collided under concurrent creates. A rolled-back allocation leaves a gap, as a sequence would.

<a id="erp-schema-migrations"></a>

#### `schema_migrations`

Ledger of applied migrations, written by scripts/migrate.mjs at boot: one row per file in apps/backend/migrations/, inserted in the same transaction as the file's DDL.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `filename` | `text` | ✓ |  | Migration file name, e.g. 0193_wechat_market.sql. |
| `applied_at` | `timestamptz` | ✓ | `now()` |  |
| `checksum` | `text` |  |  | SHA-256 hex of the file as applied; NULL rows predate the column and are filled from the file on the next boot. |

- **Primary key:** `filename`

Keyed by file name, so an edited file that was already applied never runs again; the runner only logs a warning when its checksum differs.

### SQL functions

These are the app's own functions. The rest of `public`'s functions belong to
`pgcrypto`.

| Function | Returns | What it does |
| --- | --- | --- |
| `accounting_entry_events_lock()` | `trigger` | Trigger functions behind the BEFORE UPDATE and BEFORE DELETE triggers (<table>_no_update, <table>_no_delete) on accounting_entry_events, fb_pool_events, inventory_events, order_events and sell_order_events: they raise, which makes those ledgers append-only. The inventory, order and accounting-entry versions let a DELETE through when another trigger fired it (pg_trigger_depth() > 1), so a parent's FK cascade can still remove its history; the fb_pool and sell-order versions refuse every update and delete. |
| `accounting_sync_payer(p_order_id text, p_detail jsonb)` | `void` | Applies a PO's payer to its live paid-out commission and purchase RMB Flow entries: voids them as 'Paid from the Business Account' when the company paid (unless a manager restored the entry), otherwise moves their Paid by to the PO's person payer and clears any review, logging voided or edited events. Called by the orders_sync_accounting_payer and bank_transactions_sync_accounting_payer trigger functions, and by routes/accounting.ts when an entry is restored. |
| `bank_transactions_sync_accounting_payer()` | `trigger` | Trigger function on bank_transactions (AFTER INSERT or DELETE, and AFTER UPDATE when order_id, link_kind or settle_status actually changes, via the bank_transactions_sync_accounting_payer and _update triggers) that runs accounting_sync_payer for the previously and newly linked PO. |
| `fb_pool_events_lock()` | `trigger` | Trigger functions behind the BEFORE UPDATE and BEFORE DELETE triggers (<table>_no_update, <table>_no_delete) on accounting_entry_events, fb_pool_events, inventory_events, order_events and sell_order_events: they raise, which makes those ledgers append-only. The inventory, order and accounting-entry versions let a DELETE through when another trigger fired it (pg_trigger_depth() > 1), so a parent's FK cascade can still remove its history; the fb_pool and sell-order versions refuse every update and delete. |
| `fb_worker_accounts_track()` | `trigger` | Trigger function on fb_pool_accounts (AFTER INSERT, UPDATE OF status or holder_name, or DELETE): closes the account's open fb_worker_accounts stint when it stops being fleet on that worker, with what it became (removed on delete), and opens one when it becomes fleet on a worker. |
| `inventory_events_lock()` | `trigger` | Trigger functions behind the BEFORE UPDATE and BEFORE DELETE triggers (<table>_no_update, <table>_no_delete) on accounting_entry_events, fb_pool_events, inventory_events, order_events and sell_order_events: they raise, which makes those ledgers append-only. The inventory, order and accounting-entry versions let a DELETE through when another trigger fired it (pg_trigger_depth() > 1), so a parent's FK cascade can still remove its history; the fb_pool and sell-order versions refuse every update and delete. |
| `order_commission_bank_linked(p_order_id text)` | `boolean` | Returns whether a PO's commission was paid through the bank: a linked bank_transactions row with link_kind commission that has not failed or been reversed. Called by accounting_sync_payer and by banktx/match.ts commissionLinkedFrag, which the PO page and the RMB Flow's refusals use. |
| `order_events_lock()` | `trigger` | Trigger functions behind the BEFORE UPDATE and BEFORE DELETE triggers (<table>_no_update, <table>_no_delete) on accounting_entry_events, fb_pool_events, inventory_events, order_events and sell_order_events: they raise, which makes those ledgers append-only. The inventory, order and accounting-entry versions let a DELETE through when another trigger fired it (pg_trigger_depth() > 1), so a parent's FK cascade can still remove its history; the fb_pool and sell-order versions refuse every update and delete. |
| `order_lines_number_product()` | `trigger` | BEFORE INSERT trigger on order_lines (only when product_no is NULL) that gives the new product the PO's next # from orders.next_product_no and bumps that counter, so a product's # is never renumbered or reused. |
| `orders_sold_lands_as_done()` | `trigger` | BEFORE INSERT OR UPDATE OF lifecycle trigger on orders, firing when lifecycle = 'sold', that rewrites it to 'done': the sold stage was retired, and this keeps an older app instance still writing it harmless through a deploy overlap or rollback. |
| `orders_sync_accounting_payer()` | `trigger` | AFTER UPDATE trigger on orders, firing when commission_paid_by, commission_paid_by_company, payment or paid_by changes, that calls accounting_sync_payer for the PO. |
| `sell_order_events_lock()` | `trigger` | Trigger functions behind the BEFORE UPDATE and BEFORE DELETE triggers (<table>_no_update, <table>_no_delete) on accounting_entry_events, fb_pool_events, inventory_events, order_events and sell_order_events: they raise, which makes those ledgers append-only. The inventory, order and accounting-entry versions let a DELETE through when another trigger fired it (pg_trigger_depth() > 1), so a parent's FK cascade can still remove its history; the fb_pool and sell-order versions refuse every update and delete. |
| `supplier_name_key(name text)` | `text` | A supplier's identity key from its name: an all-ASCII name upper-cased and stripped to A–Z and 0–9, otherwise 'U:' plus the trimmed, whitespace-folded, lower-cased text. It generates suppliers.match_key (with the zip) and is called by routes/suppliers.ts and routes/packages.ts for suggestions, package adoption and the duplicate check. |

## Reddit tracker database

The Reddit tracker's own Postgres. It is the only thing the worker fleet shares. Every worker process (the Railway `worker` service and the OCI VMs) claims subreddits and posts from it through `claimed_by` / `claimed_at` and `FOR UPDATE SKIP LOCKED`, and the `posts` primary key dedupes posts across the fleet. Workers write poll state, posts, verdicts, prompt versions, the alert ledger and their own heartbeats. The single `api` process writes settings, rules and the subreddit list; the ERP's Monitors ▸ Reddit page reaches it over HTTP. Telegram allows one `getUpdates` poller per bot, so the `api` process alone writes the reaction tables and `telegram_state`. Business config lives in `settings` and `rules`, so a change reaches the fleet within a minute without a redeploy. Secrets (the database URL, the OpenRouter key, the bot token) stay in env and never land here. Unlike the Facebook coordinator's, timestamps are real `timestamptz` and flags are `boolean`.

- **Where:** the `Postgres` service in Railway `reddits-tracker`, shared by the
  `api` service, the Railway `worker` and the OCI worker VMs. Public networking
  is on because the VMs connect over the internet.
- **Local:** `docker compose up -d postgres` in `trackers/reddit/` serves
  `127.0.0.1:5433`. Tests create a throwaway database per test file there,
  because the claim logic depends on `FOR UPDATE SKIP LOCKED`, which fakes do
  not reproduce.
- **Migrations:** `scripts/migrate.ts` runs on every container start before
  the app, and locally as `pnpm db:migrate`. It applies each
  `migrations/000N_*.sql` once and records it in `schema_migrations`. Never
  edit an applied file.
- **Backups:** this repo defines no backup job for it.

### Configuration

What the fleet watches and how it judges. `settings` and `rules` change only through the api (the ERP proxies a subset) and reach every worker within a minute through a 60-second cache; `subreddits` is both the watch list and the poll scheduler workers claim from.

Tables: [`settings`](#reddit-settings), [`rules`](#reddit-rules), [`subreddits`](#reddit-subreddits)

<a id="reddit-settings"></a>

#### `settings`

Runtime business config as key → JSON value, one row per key, seeded by migrations. Workers read the whole table through a 60-second cache; the api writes it (`PUT /api/settings/:key` and the prompt-candidate routes).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  | eval_prompt (live system prompt), llm_model (OpenRouter model id), telegram_chat_ids (buyer chats), max_post_age_hours (older posts are rejected unjudged; 1–720), telegram_dev_chat_ids (review chats), candidate_eval_prompt ('' = no trial), candidate_llm_model ('' = use llm_model). |
| `value` | `jsonb` | ✓ |  | JSON string, number or array of chat ids, depending on the key. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `key`

Secrets never go here, only in env. The ERP may set only `llm_model` and drive the candidate routes; the other keys are api-only.

<a id="reddit-rules"></a>

#### `rules`

A named buying rule. Enabled rules are appended to `eval_prompt` as `- name: prompt` lines, so a post is still judged by one LLM call; created and edited through the api.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `name` | `text` | ✓ |  |  |
| `prompt` | `text` | ✓ |  | Plain-English instruction appended to the live prompt. |
| `enabled` | `boolean` | ✓ | `true` | Only enabled rules are appended; changing the enabled set makes a new live prompt version. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `id`

Promoting a candidate prompt disables every rule rather than deleting it, because the candidate was judged without them.

<a id="reddit-subreddits"></a>

#### `subreddits`

One watched subreddit, doubling as the poll scheduler: workers claim up to 20 due rows at a time with `FOR UPDATE SKIP LOCKED` and fetch them in one multireddit request. Added, toggled and deleted through the api.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `name` | `text` | ✓ |  | Lowercase subreddit name without the r/ prefix. |
| `enabled` | `boolean` | ✓ | `true` | Disabled subreddits are never claimed. |
| `poll_interval_seconds` | `integer` | ✓ | `90` | Seconds between polls after a success; at least 30. |
| `next_poll_at` | `timestamptz` | ✓ | `now()` | When the subreddit is next due for polling. |
| `claimed_by` | `text` |  |  | worker_id holding the claim; NULL when free. |
| `claimed_at` | `timestamptz` |  |  | When the claim was taken; it lapses after 300 s. |
| `last_polled_at` | `timestamptz` |  |  |  |
| `last_status` | `text` |  |  | 'ok', or the last failure: http_429, http_<status>, or the error text (up to 200 chars). |
| `consecutive_errors` | `integer` | ✓ | `0` | Failed polls in a row; the next poll waits interval × 2^(errors+1), capped at 30 min. Reset to 0 on success. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `name`
- **Checks:** `poll_interval_seconds >= 30`
- **Indexes:** `CREATE INDEX idx_subreddits_due ON public.subreddits USING btree (next_poll_at) WHERE enabled`

Claims are advisory metadata, not held locks: a claim older than 300 s may be taken by any worker, so a dead worker needs no reaper.

### Ingest

`posts` holds every post any worker fetched, deduped by its Reddit id, and carries it through the pipeline by `status`: new, then rejected or target, then notified, with failed as the dead end a post waits in for a manual requeue. A target that is a copy of a listing buyers already got (a cross-post or a repost, `src/dedup.ts`) becomes duplicate instead of notified. A day after posting, the PM tracer (`src/loops/trace.ts`, migration 0006) counts the buyers who asked for it in the comments.

Tables: [`posts`](#reddit-posts)

```mermaid
erDiagram
  prompt_versions |o--o{ posts : "prompt_version_id"
```

<a id="reddit-posts"></a>

#### `posts`

Every Reddit post any worker fetched that was younger than `max_post_age_hours`, inserted with ON CONFLICT DO NOTHING so the primary key dedupes it fleet-wide. Workers carry it from new to rejected or target to notified, claiming the row at each stage.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `reddit_id` | `text` | ✓ |  | Reddit fullname from the Atom feed, e.g. t3_1abcde. |
| `subreddit` | `text` | ✓ |  | Lowercase subreddit name; matches subreddits.name by value (no foreign key). |
| `title` | `text` | ✓ |  |  |
| `selftext` | `text` | ✓ | `''` | Post body as plain text with the feed's footer stripped, capped at 8,000 chars. |
| `author` | `text` |  |  | Reddit username without the /u/ prefix. |
| `flair` | `text` |  |  | Always NULL: the Atom feed the tracker reads carries no flair. |
| `url` | `text` | ✓ |  | Permalink to the post. |
| `posted_at` | `timestamptz` | ✓ |  | Reddit's publish time; a post older than max_post_age_hours is rejected as too_old without an LLM call. |
| `discovered_at` | `timestamptz` | ✓ | `now()` | When the first worker inserted it; the `since` filter for matches and stats. |
| `status` | `text` | ✓ | `'new'` | new = awaiting judgement; rejected = not a buy (terminal); target = awaiting buyer alert; notified = alert reached at least one buyer chat; duplicate = a target whose listing went out through another copy (terminal); failed = gave up after 5 attempts at a stage. |
| `is_target` | `boolean` |  |  | The live prompt's verdict; NULL until judged. |
| `llm_summary` | `text` |  |  | The model's one-to-two-sentence summary for buyers; the alert's text. |
| `llm_price` | `text` |  |  | Asking price exactly as written in the post (free text, no currency parsing); NULL if not stated. |
| `llm_raw` | `jsonb` |  |  | The parsed verdict object: reasoning, is_target, summary, price. |
| `reject_reason` | `text` |  |  | too_old (rejected before the LLM) or not_target (the model said no). |
| `attempts` | `integer` | ✓ | `0` | Failed tries at the current stage; reset on success, and the fifth failure parks the post in failed. |
| `next_retry_at` | `timestamptz` | ✓ | `now()` | When the post may be claimed again; backoff 30 s × 2^attempts, capped at 15 min. |
| `claimed_by` | `text` |  |  | worker_id holding the post; NULL when free. |
| `claimed_at` | `timestamptz` |  |  | When the claim was taken; it lapses after 300 s. |
| `notified_at` | `timestamptz` |  |  | When the buyer alert went out. |
| `prompt_version_id` | `integer` |  |  | → prompt_versions: the live prompt that judged it; NULL for verdicts made before versioning existed. |
| `duplicate_of` | `text` |  |  | → posts: for a duplicate, the copy buyers were alerted to. |
| `comments_checked_at` | `timestamptz` |  |  | When the PM tracer read its comments; NULL until then. Set with NULL counts when the post was gone or unreadable. |
| `comment_count` | `integer` |  |  | Comments on the post when traced. |
| `pm_count` | `integer` |  |  | Distinct commenters, other than the seller and bots, who asked by PM or chat. Five or more on a memory post makes it "hot" in Analytics. |

- **Primary key:** `reddit_id`
- **References:** `prompt_version_id` → `prompt_versions.id` (on delete no action); `duplicate_of` → `posts.reddit_id` (on delete no action)
- **Checks:** `status IN ('new', 'rejected', 'target', 'notified', 'failed', 'duplicate')`
- **Indexes:** `idx_posts_pending_eval` (next_retry_at) where `status = 'new'`; `idx_posts_pending_notify` (next_retry_at) where `status = 'target'`; `idx_posts_prompt_version` (prompt_version_id) where `prompt_version_id IS NOT NULL`; `CREATE INDEX idx_posts_targets ON public.posts USING btree (discovered_at DESC) WHERE is_target`; `idx_posts_author` (lower(author), posted_at) where `author IS NOT NULL`, for finding a listing's copies; `idx_posts_pending_trace` (posted_at DESC) where `comments_checked_at IS NULL`

Posts are never deleted. `rejected` and `duplicate` are terminal; `failed` waits for `POST /api/posts/:id/requeue`, which sends a judged target back to notify and anything else back to evaluation.

### Judging

Which prompt judged what. Each live verdict on `posts` points at the `prompt_versions` row it came from; a prompt on trial writes its verdicts to `candidate_verdicts` instead, so it can be scored against the live one without ever reaching buyers.

Tables: [`prompt_versions`](#reddit-prompt-versions), [`candidate_verdicts`](#reddit-candidate-verdicts)

```mermaid
erDiagram
  prompt_versions ||--o{ candidate_verdicts : "prompt_version_id"
  posts ||--o{ candidate_verdicts : "reddit_id"
```

<a id="reddit-prompt-versions"></a>

#### `prompt_versions`

One exact combination of response schema, model and system prompt that judged posts, found by hash so a prompt edited back to earlier wording counts as the earlier version again. A worker records it the first time it judges a batch with it; `GET /api/prompt-stats` scores each one.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `hash` | `text` | ✓ |  | SHA-256 of the response-schema id, model and system prompt. |
| `model` | `text` | ✓ |  | OpenRouter model id. |
| `system_prompt` | `text` | ✓ |  | The full prompt as sent: eval_prompt plus enabled rules for the live prompt, or the candidate exactly as written for a trial. |
| `first_used_at` | `timestamptz` | ✓ | `now()` |  |
| `last_used_at` | `timestamptz` | ✓ | `now()` | Last batch it judged. |
| `response_schema` | `text` | ✓ | `'verdict-first'` | Field order the verdict was asked for in: verdict-first (every version recorded before this column existed) or reasoning-first (current). |

- **Primary key:** `id`
- **Unique:** `(hash)`

The live system prompt includes the enabled rules, so toggling a rule starts a new version. Workers update before inserting so the identity counter is not drawn on every batch.

<a id="reddit-candidate-verdicts"></a>

#### `candidate_verdicts`

The verdict a prompt on trial (`candidate_eval_prompt`) gave a post, written by the evaluating worker alongside the live verdict. It never changes `posts.status`, so a candidate can reach the dev chat but never buyers.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `reddit_id` | `text` | ✓ |  | → posts; deleted with the post. |
| `prompt_version_id` | `integer` | ✓ |  | → prompt_versions: the candidate's version. |
| `is_target` | `boolean` | ✓ |  | The candidate's verdict. |
| `summary` | `text` | ✓ |  | The candidate's summary for buyers. |
| `price` | `text` |  |  | Asking price as the candidate read it, free text. |
| `reasoning` | `text` | ✓ |  | The model's justification for the verdict. |
| `raw` | `jsonb` |  |  | The parsed verdict object. |
| `created_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `reddit_id, prompt_version_id`
- **References:** `prompt_version_id` → `prompt_versions.id` (on delete no action); `reddit_id` → `posts.reddit_id` (on delete cascade)
- **Indexes:** `idx_candidate_verdicts_version` (prompt_version_id)

Re-judging a post under the same version overwrites its row. Ending a trial keeps its rows, so the version keeps its numbers.

### Alerts

`alert_messages` records every Telegram message a buyer alert or a dev-chat review went out as. Telegram identifies a reaction only by chat and message, so this ledger is the only way back from a reaction to its post.

Tables: [`alert_messages`](#reddit-alert-messages)

```mermaid
erDiagram
  posts ||--o{ alert_messages : "reddit_id"
```

<a id="reddit-alert-messages"></a>

#### `alert_messages`

One Telegram message an alert or a review went out as, one row per chat that received it, written by the notifying or evaluating worker after the send.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  | Telegram chat the message went to. |
| `message_id` | `bigint` | ✓ |  | Telegram message id within that chat. |
| `reddit_id` | `text` | ✓ |  | → posts; deleted with the post. |
| `audience` | `text` | ✓ |  | buyers = the alert in a telegram_chat_ids chat; dev = a review copy carrying each prompt's verdict and reasoning, in a telegram_dev_chat_ids chat. |
| `sent_at` | `timestamptz` | ✓ | `now()` |  |
| `sent_as` | `text` | ✓ | `'bot'` | user = sent by the api's Telegram user account, so its readers can be fetched; bot = sent by the bot, which Telegram gives no read receipts (migration 0007). |

- **Primary key:** `chat_id, message_id`
- **References:** `reddit_id` → `posts.reddit_id` (on delete cascade)
- **Checks:** `audience IN ('buyers', 'dev')`, `sent_as IN ('bot', 'user')`
- **Indexes:** `idx_alert_messages_post` (reddit_id)

Buyer rows are inserted in the same statement that marks the post notified, so a post is never notified without the message ids its reactions will arrive under.

### Reaction feedback

Reactions on those messages, pulled from Telegram by the api's `getUpdates` loop: the raw event log, the current reaction per person (groups) or per emoji (channels), the cursor, and the `message_labels` view that reads them as lead or not-lead. `GET /api/prompt-stats` joins these to `alert_messages` and the verdicts to score each prompt version.

Tables: [`reaction_events`](#reddit-reaction-events), [`message_reactions`](#reddit-message-reactions), [`message_reaction_counts`](#reddit-message-reaction-counts), [`message_labels`](#reddit-message-labels), [`telegram_state`](#reddit-telegram-state)

<a id="reddit-reaction-events"></a>

#### `reaction_events`

Every reaction update Telegram delivered for a configured chat, verbatim and append-only; the long-term source data the current-state tables are derived from. Written by the api's reactions loop.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `update_id` | `bigint` | ✓ |  | Telegram update id; as the primary key it makes a replayed update a no-op. |
| `chat_id` | `text` | ✓ |  | Chat of the message reacted to. |
| `message_id` | `bigint` | ✓ |  | Message reacted to. |
| `payload` | `jsonb` | ✓ |  | The raw message_reaction (group) or message_reaction_count (channel) object. |
| `received_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `update_id`

Not joined to alert_messages on write, so a reaction on an alert sent before the ledger existed is kept and counted as unmatched.

<a id="reddit-message-reactions"></a>

#### `message_reactions`

The current reaction of one person on one message in a group chat, where Telegram names who reacted. Upserted by the api's reactions loop.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  |  |
| `message_id` | `bigint` | ✓ |  |  |
| `reactor` | `text` | ✓ |  | Telegram user id, or chat:<id> for an anonymous admin reacting as the group. Bot reactions are skipped. |
| `reactor_name` | `text` |  |  | Display name: first and last name, else username, else the group title. |
| `emoji` | `jsonb` | ✓ | `'[]'::jsonb` | JSON array of the reactions the person has on the message now: emoji, custom-emoji id, or the reaction type (e.g. paid). |
| `first_reacted_at` | `timestamptz` |  |  | First time the person had any reaction on the message; kept across removals. |
| `updated_at` | `timestamptz` | ✓ |  | Telegram's time of the latest change. |

- **Primary key:** `chat_id, message_id, reactor`

A removed reaction leaves `emoji` as '[]' and keeps the row.

<a id="reddit-message-reaction-counts"></a>

#### `message_reaction_counts`

Current reaction totals on one message in a channel, where reactions are anonymous and Telegram reports only counts. Upserted by the api's reactions loop.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  |  |
| `message_id` | `bigint` | ✓ |  |  |
| `counts` | `jsonb` | ✓ | `'{}'::jsonb` | JSON map of reaction → total, e.g. {"👍": 3}. |
| `updated_at` | `timestamptz` | ✓ |  | Telegram's time of the latest count. |

- **Primary key:** `chat_id, message_id`

<a id="reddit-message-labels"></a>

#### `message_labels` (view)

View that reads each message's reactions, from both reaction tables, as a label. 👎 means the alert should not have gone out; any other reaction (👍, 🔥, a custom emoji, a paid star) means someone found it worth acting on, a lead.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` |  |  |  |
| `message_id` | `bigint` |  |  |  |
| `positive` | `boolean` |  |  | The message has at least one reaction other than 👎. |
| `negative` | `boolean` |  |  | The message has at least one 👎. |
| `reactions` | `integer` |  |  | Total reactions counted: one per person-emoji in groups plus the channel totals. |

Defined as:

```sql
WITH reacted AS (
         SELECT r.chat_id,
            r.message_id,
            e.emoji,
            1 AS n
           FROM message_reactions r,
            LATERAL jsonb_array_elements_text(r.emoji) e(emoji)
        UNION ALL
         SELECT c.chat_id,
            c.message_id,
            kv.key,
            kv.value::integer AS value
           FROM message_reaction_counts c,
            LATERAL jsonb_each_text(c.counts) kv(key, value)
          WHERE kv.value::integer > 0
        )
 SELECT chat_id,
    message_id,
    bool_or(emoji <> '👎'::text) AS positive,
    bool_or(emoji = '👎'::text) AS negative,
    sum(n)::integer AS reactions
   FROM reacted
  GROUP BY chat_id, message_id;
```

<a id="reddit-telegram-state"></a>

#### `telegram_state`

Single-row `getUpdates` cursor for the tracker's bot, so a restarted api resumes instead of replaying. Only the api process polls, because Telegram allows one poller per bot token.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `boolean` | ✓ | `true` | Always TRUE; the CHECK keeps the table to one row. |
| `next_offset` | `bigint` | ✓ | `0` | Next getUpdates offset (last handled update_id + 1); advanced past every update, handled or not. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |
| `user_sender_at` | `timestamptz` |  |  | Renewed by the api on every pass while its Telegram user session sends buyer alerts. While it is under two minutes old, the workers' notify loops stand down. Cleared on a clean api shutdown; null means the bot sends (migration 0007). |
| `user_sender_owner` | `text` |  |  | The api process holding the user session (`<worker id>:<uuid>`). A redeploy's new api waits for it to clear or for `user_sender_at` to go stale before connecting, so the session is never live twice; renew and release touch only the holder's own row (migration 0008). |

- **Primary key:** `id`
- **Checks:** `id`

### Read receipts

Who read each buyer alert, for the ERP's Reddit ▸ Seen tab (migration 0007). Telegram reports a message's readers only to the user account that sent it, only in groups of up to 100 members, and only for 7 days. So the api's `reads` loop (`src/loops/reads.ts`) asks again every 5 minutes for the user-sent alerts of the last 24 hours that someone in the chat has not read yet, and keeps what it gets. It also refreshes the buyer chats' member list, so the tab can list people who read nothing. `GET /api/seen` reads both.

Tables: [`message_reads`](#reddit-message-reads), [`chat_members`](#reddit-chat-members)

```mermaid
erDiagram
  alert_messages ||--o{ message_reads : "chat_id, message_id"
```

<a id="reddit-message-reads"></a>

#### `message_reads`

One person who read one user-sent alert. Written only by the api's reads loop. Telegram's own read list expires after 7 days, so a row here outlives it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  | → alert_messages, with message_id; deleted with it. |
| `message_id` | `bigint` | ✓ |  |  |
| `user_id` | `text` | ✓ |  | Telegram user id of the reader. The sending account itself is never recorded. |
| `read_at` | `timestamptz` | ✓ |  | When Telegram says they read it. |

- **Primary key:** `chat_id, message_id, user_id`
- **References:** `chat_id, message_id` → `alert_messages` (on delete cascade)

<a id="reddit-chat-members"></a>

#### `chat_members`

The people in each buyer chat, as of the reads loop's last pass, without bots or the sending account.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  | A telegram_chat_ids chat. |
| `user_id` | `text` | ✓ |  | Telegram user id. |
| `name` | `text` | ✓ |  | First and last name, or the username or id when Telegram has neither. |
| `username` | `text` |  |  | Telegram @username, without the @. |
| `left_at` | `timestamptz` |  |  | Set when a pass no longer finds them; cleared if they come back. Null = still in the chat. |
| `updated_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `chat_id, user_id`

### Operations

Fleet visibility, the ops watch's state and the migration ledger. Nothing in the pipeline reads any of them. The api's watch (`src/loops/watch.ts`, migration 0005) reads `workers` and `worker_errors` and sends down workers, failing loops and every warn/error line to the ops Telegram group through the alert relay.

Tables: [`workers`](#reddit-workers), [`worker_errors`](#reddit-worker-errors), [`watch_alerts`](#reddit-watch-alerts), [`loop_leases`](#reddit-loop-leases), [`schema_migrations`](#reddit-schema-migrations)

<a id="reddit-workers"></a>

#### `workers`

One running process, upserted by its 30-second heartbeat and deleted on clean shutdown. Observational only: nothing schedules off it, and a crashed process's row stays behind to show it as dead.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  | WORKER_ID from env, else hostname-pid-random suffix. |
| `role` | `text` | ✓ |  | worker = polls Reddit, judges and alerts; api = serves the admin API and polls Telegram for reactions. |
| `started_at` | `timestamptz` | ✓ |  | When the process started. |
| `last_heartbeat_at` | `timestamptz` | ✓ | `now()` |  |
| `loops` | `jsonb` | ✓ | `'{}'::jsonb` | JSON per loop (poll, evaluate, notify) with lastSuccessAt and lastWorkAt, rewritten whole on each beat. Part of the ERP's `/api/workers` contract. |
| `loop_failures` | `jsonb` | ✓ | `'{}'::jsonb` | JSON per loop with consecutiveFailures (iterations in a row that threw or logged a warn/error), lastError and lastErrorAt. Kept out of `loops` so that contract stays as it was. |

- **Primary key:** `worker_id`
- **Checks:** `role IN ('worker', 'api')`

Liveness is computed on read: stale after 90 s without a beat, dead after 600 s. There is no reaper; `DELETE /api/workers/:id` clears a dead row.

<a id="reddit-worker-errors"></a>

#### `worker_errors`

Every warn/error line any process logged, buffered in memory and inserted after the heartbeat that follows it. The watch sends unsent rows as a digest each minute and deletes rows older than seven days.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `bigint` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  | The process that logged it (not a foreign key: the line outlives the worker row). |
| `scope` | `text` | ✓ |  | Logger scope, e.g. evaluate, poll, reactions, heartbeat, watch. Empty for the top level. |
| `level` | `text` | ✓ |  | warn or error. |
| `message` | `text` | ✓ |  | The log message, NUL bytes stripped. |
| `fields` | `jsonb` | ✓ | `'{}'::jsonb` | The line's fields, as the log printed them. |
| `at` | `timestamptz` | ✓ |  | When it was logged, not when it was stored. |
| `sent_at` | `timestamptz` |  |  | When a digest carrying it was accepted by the relay. NULL = not yet sent. |

- **Primary key:** `id`
- **Checks:** `level IN ('warn', 'error')`
- **Indexes:** `worker_errors_unsent` on `id` where `sent_at IS NULL`; `worker_errors_at` on `at`

<a id="reddit-watch-alerts"></a>

#### `watch_alerts`

Alerts the watch has raised and not yet resolved, so a restarted api neither pages twice nor forgets to say an alert cleared. A row is written only after the relay accepted the alert, and deleted only after it accepted the resolution.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  | `down:<worker_id>` or `failing:<worker_id>:<loop>`. |
| `worker_id` | `text` | ✓ |  | The worker it is about. |
| `raised_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `key`

<a id="reddit-loop-leases"></a>

#### `loop_leases`

Jobs exactly one process in the fleet runs at a time (migration 0006). Today the only one is `comment_tracer`, the PM tracer. Its holder renews the row every minute or so; once `expires_at` passes, any worker started without `COMMENT_TRACER=off` may take it over. A worker Reddit blocks gives it up at once, and a clean shutdown deletes it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `name` | `text` | ✓ |  | The job, e.g. comment_tracer. |
| `worker_id` | `text` | ✓ |  | The worker holding it. |
| `expires_at` | `timestamptz` | ✓ |  | When it lapses unless renewed (10 minutes after the last renewal). |

- **Primary key:** `name`

<a id="reddit-schema-migrations"></a>

#### `schema_migrations`

Ledger of the applied files from `trackers/reddit/migrations/`, written by `scripts/migrate.ts` in the same transaction as each file's DDL.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `filename` | `text` | ✓ |  | Migration file name, e.g. 0003_prompt_feedback.sql. |
| `applied_at` | `timestamptz` | ✓ | `now()` |  |

- **Primary key:** `filename`

Same name and shape as the ERP's ledger, and both start at 0001_init.sql, which is why the two must never share a database. The runner holds advisory lock 778431 so VMs booting together never double-apply.

## Facebook coordinator database

Only the `rs_coordinator` process opens this database: its FastAPI handlers, its background thread (outbox delivery, liveness sweep, fleet placement and rollouts), its Telegram update consumer and the `rsc` CLI. Workers, `rs-fleetd` agents, `rs-messenger`, `rs-router`, rs_console and the ERP all reach it over HTTP. Secrets are sealed with the Fernet vault key `RS_VAULT_KEY`, which only the coordinator's environment holds. Three columns are ciphertext: `accounts.secret_blob` (password, email login, TOTP seed, IMAP settings, access token), `session_snapshots.state_blob` (a whole Playwright storage state) and `device_profiles.device_cookies_blob` (`datr`/`sb`). `accounts.proxy` is plaintext, even though a proxy URL can carry credentials.

- **Where:** Railway project `facebook-tracker`, using the
  `postgres-ssl:16` template with a `pgdata` volume. Terraform for it is in
  `trackers/facebook/infra/terraform/`. The coordinator runs on the homelab VM
  and connects through Railway's public TCP proxy; `pg.normalize_url` adds
  `sslmode=require`.
- **Local and tests:** SQLite, at `RS_COORDINATOR_DB` or
  `data/coordinator.db` in the tracker checkout.
  `rs_coordinator/tests/test_postgres.py` runs the same suite against a
  throwaway Postgres. Never point it at the ERP's ports (5432, 55432), because
  it drops the tables it touches.
- **Schema changes:** no numbered migrations and no `schema_migrations`
  table. On every boot, `PostgresDatabase._create_schema` takes an advisory
  lock, then:
  1. runs `CREATE TABLE IF NOT EXISTS` from `SCHEMA`;
  2. adds any missing column from the `*_EXTRA_COLUMNS` / `*_LOCK_COLUMNS`
     lists with `ADD COLUMN IF NOT EXISTS`;
  3. seeds `alert_claims`.

  A column is never dropped or retyped this way.
- **Types:**
  - Timestamps are ISO-8601 `text` and booleans are `0`/`1` `integer`, in both
    backends. That is on purpose, because callers compare and parse those
    values as strings and ints (`pg.py` docstring).
  - The only translations are `BLOB` → `bytea` and autoincrement → `integer
    GENERATED ALWAYS AS IDENTITY`. The tables below show the Postgres form.
- **No foreign keys.** Rows join by convention, on `dedupe_key`, `worker_id`
  and account id. Nothing enforces them, so there are no diagrams.
- **Backups:** this repo defines no backup job for it.

### Fleet and search config

Where workers run and what they search. Each Docker host's rs-fleetd agent reports into `fleet_hosts` and runs what `fleet_assignments` says; `fleet_releases` rolls an image through one worker at a time; `worker_configs` is each worker's published TOML; the `city_tier_*` tables decide how often each of its cities is searched.

Tables: [`fleet_hosts`](#facebook-fleet-hosts), [`fleet_assignments`](#facebook-fleet-assignments), [`fleet_releases`](#facebook-fleet-releases), [`worker_configs`](#facebook-worker-configs), [`city_tier_settings`](#facebook-city-tier-settings), [`city_tier_pins`](#facebook-city-tier-pins)

<a id="facebook-fleet-hosts"></a>

#### `fleet_hosts`

A Docker host that runs workers through its rs-fleetd agent. Registered observe-only the first time its agent asks for work, refreshed by the agent's report every 30 s; capacity and trust are set by an operator.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `host_id` | `text` | ✓ |  |  |
| `capacity` | `integer` | ✓ | `4` | Most running workers the fleet places on it; default 4. |
| `cordoned` | `integer` | ✓ | `0` | 1 = no worker is placed or restarted here unless its slot is pinned to this host. |
| `authoritative` | `integer` | ✓ | `0` | 0 = the agent only reports and applies nothing, and releases skip its workers; 1 = it reconciles containers to the desired state. |
| `vnc_host` | `text` |  |  | Where the console reaches the VNC ports this host publishes; NULL = the console's own host, over the rs-fleet network. |
| `agent_version` | `text` |  |  | rs-fleetd version in the last report. |
| `last_seen_at` | `text` |  |  | Last agent report; a host silent for 2 min is neither placed on nor rolled. |
| `report_json` | `text` |  |  | The agent's last full report (its containers), truncated to 200,000 chars. |
| `created_at` | `text` | ✓ |  |  |

- **Primary key:** `host_id`

<a id="facebook-fleet-assignments"></a>

#### `fleet_assignments`

Where one worker runs and on which image, kept by the coordinator's 30-second fleet loop and served to each host's agent as its desired state. A slot gets a row once its account is fleet-enabled and its config is published.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  |  |
| `host_id` | `text` | ✓ |  | → fleet_hosts.host_id (by value): where the worker runs. |
| `state` | `text` | ✓ | `'run'` | run, or stopped (slot disabled, config missing, or no account names the worker). |
| `image` | `text` | ✓ |  | Worker image the agent should run. |
| `previous_image` | `text` |  |  | Image before the last rollout step; a worker that fails the release gate goes back to it. |
| `generation` | `integer` | ✓ | `1` | Bumped on every start, image change, move or restart; a new value makes the agent recreate the container. |
| `move_to_host` | `text` |  |  | Pending move target; while set, the worker drops out of its current host's desired state. |
| `move_requested_at` | `text` |  |  | When the pending move was asked for. |
| `vnc_port` | `integer` |  |  | Published VNC port in 5901–5999, given only on hosts that have a vnc_host. |
| `created_at` | `text` | ✓ |  |  |
| `updated_at` | `text` | ✓ |  |  |

- **Primary key:** `worker_id`

Placement is sticky and nothing moves on its own; a move completes only once the old host reports the container gone, so one session never runs in two browsers. A stopped row keeps host_id so the slot returns to the disk that holds its session.

<a id="facebook-fleet-releases"></a>

#### `fleet_releases`

A worker image rolled out one worker at a time (`rsc fleet release`). The fleet loop moves to the next worker only once the current one heartbeats on the new version in a state no worse than before.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `version` | `text` | ✓ |  | Release version (X.Y.Z) the upgraded worker must report. |
| `image` | `text` | ✓ |  | Image being rolled out. |
| `state` | `text` | ✓ |  | rolling, paused, done, failed (a worker missed the 20-minute gate and was rolled back), aborted, or superseded. |
| `current_worker` | `text` |  |  | Worker being upgraded now; NULL between steps and once finished. |
| `current_started_at` | `text` |  |  | When the current step began; the gate times out 20 min later. |
| `current_pre_state` | `text` |  |  | The worker's state before the step, or DOWN if it had not beaten in 15 min; decides what counts as coming back no worse. |
| `upgraded_json` | `text` |  |  | JSON array of worker ids upgraded so far. |
| `skipped_json` | `text` |  |  | JSON array of worker ids skipped: host offline or observe-only, or the worker stopped mid-step. |
| `failed_worker` | `text` |  |  | Worker that failed the gate. |
| `failure` | `text` |  |  | Why the release stopped. |
| `created_by` | `text` |  |  | Who started the release. |
| `created_at` | `text` | ✓ |  |  |
| `finished_at` | `text` |  |  |  |

- **Primary key:** `id`

The newest release that is not failed or aborted names the image new workers start on. Starting a release supersedes any active one.

<a id="facebook-worker-configs"></a>

#### `worker_configs`

Each fleet worker's TOML config as it should run, rendered and published by rs_console (master values plus what the ERP saved). Agents fetch it by its hash.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  |  |
| `toml` | `text` | ✓ |  | Full config text; refused unless it parses, up to 256 KB. |
| `sha256` | `text` | ✓ |  | SHA-256 of the toml; republishing identical text changes nothing. |
| `updated_at` | `text` | ✓ |  |  |
| `updated_by` | `text` |  |  | Who published it, as the console sent. |

- **Primary key:** `worker_id`

A slot is not started until its config is published here.

<a id="facebook-city-tier-settings"></a>

#### `city_tier_settings`

Single row holding the rule for how often a worker's cities are searched by rank, saved from the ERP through rs_console (`PUT /v1/city-tiers`). Workers read the result through `POST /v1/workers/{id}/search-plan`.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ |  | Always 1; the CHECK keeps the table to one row. |
| `body` | `text` | ✓ |  | JSON of the stored keys only: top_pct and mid_pct (default 20 each), per_day searches a day for the busiest, middle and rest tiers (default [3, 2, 1]) and window_days (default 30). Missing keys take the defaults. |
| `updated_at` | `text` | ✓ |  |  |
| `updated_by` | `text` |  |  | Who saved it. |

- **Primary key:** `id`
- **Checks:** `id = 1`

The rank itself is computed on read from alert_messages, never stored.

<a id="facebook-city-tier-pins"></a>

#### `city_tier_pins`

A city a manager pinned to a fixed number of searches a day, overriding its rank wherever it is searched. The ERP replaces the whole set at once.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `city` | `text` | ✓ |  | Lowercase Facebook city slug. |
| `per_day` | `integer` | ✓ |  | Searches a day, 1–6. |

- **Primary key:** `city`

### Accounts, devices and logins

The vault and the login trail. One `accounts` row per Facebook login holds its sealed secrets and the worker slot it fills; one `device_profiles` row per account makes every worker present the same browser; `session_snapshots` lets a slot restore its session. The other three record each login, each secret released, and each obstacle that needed a human.

Tables: [`accounts`](#facebook-accounts), [`device_profiles`](#facebook-device-profiles), [`session_snapshots`](#facebook-session-snapshots), [`login_attempts`](#facebook-login-attempts), [`code_audit`](#facebook-code-audit), [`challenges`](#facebook-challenges)

<a id="facebook-accounts"></a>

#### `accounts`

One Facebook login in the vault and the worker slot it fills. Written by `rsc vault set-account` and by the ERP through rs_console (`PUT /v1/accounts/{id}` for credentials, `PUT /v1/fleet/workers/{id}` for fleet on/off and host pin).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `account_id` | `text` | ✓ |  | Operator-chosen label: letters, digits and . _ @ -, up to 64 chars. |
| `worker_id` | `text` |  |  | The fleet slot (worker id) this account runs in; that worker's codes, credentials and session come from this row. |
| `fb_username` | `text` |  |  | The Facebook login handed out with the password; not the recovery email sealed in the vault. |
| `region` | `text` |  |  | Region key such as rs_west; sets the timezone of a generated device profile. |
| `proxy` | `text` |  |  | Proxy URL set with `rsc vault set-account --proxy`. Plaintext although it can carry credentials, so the console is told only whether it is set. |
| `vnc_url` | `text` |  |  | Static fallback link for driving the browser; the worker's heartbeat value wins. |
| `allow_password_login` | `integer` |  | `0` | 1 lets /v1/auth/credentials release the password (still refused while locked or over the daily budget); 0 means session restore only. |
| `secret_blob` | `bytea` |  |  | Fernet ciphertext (RS_VAULT_KEY) of a JSON object with password, email, email_password, totp_secret, imap_host, imap_port and fb_token. |
| `created_at` | `text` |  |  |  |
| `updated_at` | `text` |  |  |  |
| `fb_uid` | `text` |  |  | Facebook numeric uid of this login; keys its device profile as uid:<fb_uid>. Cleared when fb_username changes without a new uid. |
| `fleet_enabled` | `integer` |  | `0` | 1 = the fleet runs a worker for this slot once its config is published; default 0. |
| `pin_host` | `text` |  |  | Host this slot must run on: a slot with no proxy egresses through its host's IP, and its session is bound to that IP. |
| `locked_at` | `text` |  |  | Set when a worker hits Facebook's lock page; while set, no password or access token is released. Cleared by `rsc vault unlock`. |
| `locked_reason` | `text` |  |  | The lock page URL a worker reported, or 'Facebook lock page'. |

- **Primary key:** `account_id`

Listing routes never return `secret_blob` or the proxy value. A worker id belongs to at most one account; the console route enforces this with a 409, not a constraint.

<a id="facebook-device-profiles"></a>

#### `device_profiles`

The browser identity one Facebook account presents on whichever worker runs it: viewport, screen, locale, timezone and the account's own datr/sb cookies. Created on a worker's first `POST /v1/workers/{id}/identity` for the account and kept for the account's life.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `identity_key` | `text` | ✓ |  | uid:<Facebook uid> of the account. |
| `device_id` | `text` | ✓ |  | Our UUID label for the device; session backups and login_attempts name it. |
| `fb_uid` | `text` |  |  |  |
| `user_agent` | `text` |  |  | NULL = the browser's own user agent, which stays consistent with its client hints. |
| `viewport_w` | `integer` | ✓ |  |  |
| `viewport_h` | `integer` | ✓ |  |  |
| `screen_w` | `integer` | ✓ |  |  |
| `screen_h` | `integer` | ✓ |  |  |
| `device_scale_factor` | `real` | ✓ | `1` |  |
| `locale` | `text` | ✓ |  |  |
| `timezone_id` | `text` | ✓ |  | IANA timezone: from the account's region for a generated profile, copied from the browser for a seeded one. |
| `device_cookies_blob` | `bytea` |  |  | Fernet ciphertext of {"cookies": [...]} holding the account's datr and sb. The first writer wins; logged-in session backups keep it current. |
| `source` | `text` |  |  | generated = a new random device; seeded = copied from a browser already logged in as this account. |
| `created_at` | `text` | ✓ |  |  |
| `updated_at` | `text` | ✓ |  |  |

- **Primary key:** `identity_key`
- **Unique:** `(device_id)`

One per account, created insert-or-nothing so racing workers share one device; `device_id` is written once and never regenerated. A lost row makes the account look like a new machine to Facebook, so it cannot simply be rebuilt.

<a id="facebook-session-snapshots"></a>

#### `session_snapshots`

The latest encrypted Playwright storage_state for one worker slot, so a rebuilt or moved worker restores its Facebook session instead of logging in again. Workers back it up (`POST /v1/session/backup`); the ERP's cookie-first assign seeds it from a pool cookie (`PUT /v1/workers/{id}/session`).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  |  |
| `account_id` | `text` |  |  | Account the slot held at backup time, from the fleet's own mapping rather than the worker's claim. |
| `state_blob` | `bytea` |  |  | Fernet ciphertext of the whole storage_state: cookies, localStorage and origins. |
| `user_agent` | `text` |  |  | Browser user agent at backup; NULL for a seeded cookie. |
| `session_expiry` | `text` |  |  | Session expiry the worker reported; NULL for a seeded cookie. |
| `backed_up_at` | `text` |  |  |  |
| `fb_user_id` | `text` |  |  | Facebook uid from the session's c_user cookie; public, used to match a snapshot to its account. |
| `identity_key` | `text` |  |  | Device profile the session was taken under; a restore requires it to match the account's. |

- **Primary key:** `worker_id`

Restored only onto the slot it came from and only under the same device identity. A backup with no `xs` cookie is refused, so a logged-out jar never replaces a good snapshot.

<a id="facebook-login-attempts"></a>

#### `login_attempts`

Ledger of each Facebook login a worker starts and the device it presented, opened at the start and closed with the outcome (`POST /v1/workers/{id}/logins`).

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `account_id` | `text` |  |  | Account the slot held when the login started. |
| `identity_key` | `text` |  |  | Device profile key (uid:<uid>) of that account. |
| `device_id` | `text` |  |  | Device profile the browser presented. |
| `datr_fp` | `text` |  |  | First 16 hex chars of the SHA-256 of the datr cookie presented: comparable, never the cookie itself. |
| `device_drift` | `integer` |  | `0` | 1 when datr_fp differed from the profile's stored datr, i.e. Facebook saw a new machine. |
| `trigger` | `text` |  |  | boot, relogin, forced, swap, cookie-restore or token-refresh. |
| `outcome` | `text` |  |  | restored, password_ok, watch_ok, challenge, locked, failed or timed_out; NULL while the attempt is open. |
| `detail_json` | `text` |  |  | Detail the worker sent with the outcome, e.g. the lock page URL. |
| `started_at` | `text` | ✓ |  |  |
| `finished_at` | `text` |  |  | NULL while the attempt is open. |

- **Primary key:** `id`
- **Indexes:** `idx_login_attempts_worker` (worker_id, started_at)

A start on a datr the device profile does not hold pages ops at once; an outcome of locked locks the account.

<a id="facebook-code-audit"></a>

#### `code_audit`

Append-only record of every secret released to a worker, or refused, so a compromised worker shows up as releases nobody can explain. Written by the auth and session routes.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` |  |  |  |
| `account_id` | `text` |  |  |  |
| `kind` | `text` |  |  | totp or email = a 2FA code; password = credentials released; password_refused = a release refused; token = access token released; session = a pool cookie sealed as the slot's snapshot. |
| `reason` | `text` |  |  | The caller's stated reason, or the refusal text for password_refused. |
| `released_at` | `text` | ✓ |  |  |

- **Primary key:** `id`
- **Indexes:** `idx_code_audit_time` (released_at)

`password` rows in the last 24 h count against RS_PASSWORD_LOGINS_PER_DAY (default 2); refusals are logged as password_refused so they never use up the budget.

<a id="facebook-challenges"></a>

#### `challenges`

A login obstacle a worker could not clear by itself (CAPTCHA, checkpoint, lock page), filed with a screenshot for a human to handle over VNC. The worker files it (`POST /v1/auth/escalate`), ops get one Telegram page, and an operator resolves it from the ERP.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `account_id` | `text` |  |  |  |
| `kind` | `text` |  |  | Worker-supplied, default captcha; locked also locks the account. |
| `status` | `text` |  | `'open'` | open until an operator resolves it, then resolved. |
| `screenshot_path` | `text` |  |  | Path of the PNG on the coordinator's disk (<screenshot dir>/<id>.png); NULL if none was sent or it could not be written. |
| `vnc_url` | `text` |  |  | Link to drive the stuck browser, from the worker's heartbeat, else its account. |
| `detail_json` | `text` |  |  | Worker-supplied JSON detail. |
| `created_at` | `text` | ✓ |  |  |
| `resolved_at` | `text` |  |  |  |
| `resolved_by` | `text` |  |  | Who resolved it, as the console sent. |

- **Primary key:** `id`
- **Indexes:** `idx_challenges_status` (status)

### Search activity

What workers did between a search and an alert, for the ERP's funnel card and fleet table, and the city queue that hands enrolled workers their cities. Nothing in the alert path reads these.

Tables: [`review_stats`](#facebook-review-stats), [`search_cycles`](#facebook-search-cycles), [`search_cities`](#facebook-search-cities), [`city_searches`](#facebook-city-searches), [`city_leases`](#facebook-city-leases), [`city_events`](#facebook-city-events), [`queue_config`](#facebook-queue-config)

<a id="facebook-review-stats"></a>

#### `review_stats`

Search-to-alert funnel counts, one row per worker per UTC day, behind the ERP's review-volume and funnel cards. Workers post per-search-page deltas, the coordinator adds the two stages it runs, and the upsert accumulates.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `day` | `text` | ✓ |  | UTC date, YYYY-MM-DD. |
| `worker_id` | `text` | ✓ |  | Reporting worker, or 'coordinator' for outbox deliveries. |
| `reviewed` | `integer` | ✓ | `0` | Fresh AI verdicts. |
| `alerted` | `integer` | ✓ | `0` | Alerts the worker delivered. |
| `updated_at` | `text` | ✓ |  | Last time any counter on the row moved. |
| `searches` | `integer` | ✓ | `0` | Search result pages loaded. |
| `cards` | `integer` | ✓ | `0` | Result cards collected. |
| `title_pass` | `integer` | ✓ | `0` | Cards that passed the title gate. |
| `opened` | `integer` | ✓ | `0` | Listing pages actually visited. |
| `keyword_pass` | `integer` | ✓ | `0` | Listings that passed the keyword gate. |
| `fresh` | `integer` | ✓ | `0` | Listings not yet alerted. |
| `coordinated` | `integer` | ✓ | `0` | Counted by the coordinator: ingested matches it found new, changed or cheaper, plus direct-send alerts reported to it. |
| `sent` | `integer` | ✓ | `0` | Counted by the coordinator: listing alerts delivered from the outbox, plus reported direct sends. |

- **Primary key:** `day, worker_id`

Listing alerts delivered from the outbox are counted under worker_id 'coordinator', because the outbox row does not keep the reporter. Counter columns after reviewed/alerted were added by the additive column list.

<a id="facebook-search-cycles"></a>

#### `search_cycles`

A worker starting a search pass over one item, logged when a heartbeat carries a new `last_search_at`. Feeds the ERP fleet table's day strip.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `at` | `text` | ✓ |  | The worker's last_search_at, normalized to UTC in utcnow()'s form so it compares as text. |
| `item` | `text` |  |  | The search item named in the heartbeat's detail. |

- **Primary key:** `id`
- **Indexes:** `idx_search_cycles_at` (at)

Pruned to 14 days on each insert.

<a id="facebook-search-cities"></a>

#### `search_cities`

When each worker last searched each city, from funnel reports that count a search and name its city. One row per worker and city, so it needs no pruning.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  |  |
| `city` | `text` | ✓ |  | Facebook city slug. |
| `last_at` | `text` | ✓ |  | Coordinator time of the latest search of that city. |

- **Primary key:** `worker_id, city`

<a id="facebook-city-searches"></a>

#### `city_searches`

Every funnel report that counts a search and names its city, one row per search page, with what that page found. `search_cities` keeps only the latest per worker and city. The city queue (`rs_coordinator/city_queue.py`) needs the history: when each city was last searched by anyone, and which accounts get 0 cards where others get some.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `city` | `text` | ✓ |  | Facebook city slug. |
| `at` | `text` | ✓ |  | Coordinator time the report arrived, in utcnow()'s form. |
| `cards` | `integer` | ✓ | `0` | Result cards the search returned. 0 where other accounts get cards is how a blind account shows. |
| `opened` | `integer` | ✓ | `0` | Listing pages visited from that search. |
| `reviewed` | `integer` | ✓ | `0` | Fresh AI verdicts from that search. |
| `alerted` | `integer` | ✓ | `0` | Alerts the worker delivered from that search. |
| `item` | `text` |  |  | The search item it was for. NULL from workers before 0.13.14, which search every item. |

- **Primary key:** `id`
- **Indexes:** `idx_city_searches_at` (at)

Pruned to 14 days on each insert. `item` was added by the additive column list. Read by the city queue (`next-city`, `/v1/queue/status`) and `POST /v1/queue/shadow`.

<a id="facebook-city-leases"></a>

#### `city_leases`

The city queue's hand-outs: one row per (item, city) given to an enrolled worker. A live lease keeps the city off every other worker, and the lease rows are what an account's daily minutes are counted from.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `item` | `text` | ✓ |  | Search item the city was handed out for. |
| `city` | `text` | ✓ |  | Facebook city slug. |
| `leased_at` | `text` | ✓ |  | When the city was handed out. |
| `expires_at` | `text` | ✓ |  | When the lease lapses unless renewed. A HEALTHY heartbeat moves it `lease_minutes` on; any other state pulls it to now. |
| `closed_at` | `text` |  |  | When the worker's next ask reported the city done. NULL while live, or once abandoned (expired unclosed), in which case the city goes back to the queue. |
| `why` | `text` |  |  | home, familiar or other: which of the worker's groups the city came from. |

- **Primary key:** `id`
- **Indexes:** `idx_city_leases_leased` (leased_at), `idx_city_leases_worker` (worker_id)

Pruned to 14 days on each insert.

<a id="facebook-city-events"></a>

#### `city_events`

The city log: what happened to each city on each worker, one row per step. `rs_coordinator/city_log.py` groups the rows into one visit per city, from its handout or start to its end. The steps come from two writers:

- **The coordinator:**
  - `handed`, at `next-city`, stamped as the lease's `leased_at`;
  - `searched`, from each funnel report that counts a search and names its city;
  - `alerted`, from each delivered alert that names its city;
  - `released`, when a heartbeat parks the worker or its next ask finds a lease a restart left.
- **The monitor**, through `POST /v1/workers/{id}/city-events`: `started`, `finished` and `stopped`.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity | Breaks ties between steps in the same second. |
| `at` | `text` | ✓ |  | Coordinator time of the step, in utcnow()'s form. |
| `worker_id` | `text` | ✓ |  |  |
| `item` | `text` |  |  | The search item. NULL on pages from workers before 0.13.14. |
| `city` | `text` | ✓ |  | Facebook city slug. |
| `event` | `text` | ✓ |  | handed, started, searched, alerted, finished, stopped or released. |
| `detail` | `text` |  |  | JSON: `why` (handed); `phrase` and the page's counts (searched); the listing's `title`, `price`, `score`, `url` (alerted); the city's counts, `empty` and `seconds` (finished, stopped); `reason`, `wall`, `error`, `of` (stopped); `reason`, the parked state or `restarted` (released). NULL when the step said nothing more. |

- **Primary key:** `id`
- **Indexes:** `idx_city_events_at` (at), `idx_city_events_worker` (worker_id, at)

Pruned to 14 days on each insert. Read by `GET /v1/city-log` and `rsc queue log`. An *expired* visit is not a row: it is read from a lease that ran out with no close and no `released` step.

<a id="facebook-queue-config"></a>

#### `queue_config`

The city queue's JSON documents: `settings`, `roster` and `start`.

- **`settings`** holds only the keys someone set, through `rsc queue` or `PUT /v1/queue/settings`. The rest come from `city_queue.DEFAULTS`. The keys are `enrolled`, `regions`, `partners`, `per_day`, `budget_minutes`, `window_hours` and the others listed there.
- **`roster`** is what the console last pushed: the catalog with each city's region and radius, the enabled search items, and each worker's home cities, partner key, `start_at` and phrase count.
- **`start`** is the last round started by hand (`POST /v1/queue/start`, `rsc queue start`): `{at, by}`. For `window_hours` from `at`, every enrolled worker's window is open and a city is due once it was not searched in the last `start_fresh_hours`. Afterwards the row is inert until the next start replaces it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  | 'settings', 'roster' or 'start'. |
| `body` | `text` | ✓ |  | The JSON document. |
| `updated_at` | `text` | ✓ |  |  |
| `updated_by` | `text` |  |  | 'rsc', 'rs-console', or who saved it through the API. |

- **Primary key:** `key`

### Listings and dedupe

One alert per listing, fleet-wide, by two routes. `listings` and `sightings` serve workers that report matches over `POST /api/v1/listings` and let the coordinator alert; `alert_claims` serves the homelab workers that send their own alerts and must claim each listing first.

Tables: [`listings`](#facebook-listings), [`sightings`](#facebook-sightings), [`alert_claims`](#facebook-alert-claims)

<a id="facebook-listings"></a>

#### `listings`

One Marketplace listing reported over `POST /api/v1/listings`, deduped across workers by its item id. A new, edited or cheaper listing queues one coordinator alert in `outbox`; homelab workers that send their own alerts go through `alert_claims` instead.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `dedupe_key` | `text` | ✓ |  | SHA-1 hex of '<marketplace>:<listing_id>'. |
| `marketplace` | `text` | ✓ |  | Always facebook today. |
| `listing_id` | `text` | ✓ |  | Facebook Marketplace item id. |
| `item_name` | `text` |  |  | The search item that matched (master.toml). |
| `title` | `text` |  |  |  |
| `price` | `text` |  |  | Price text as shown on the listing, e.g. '$1,200'; its first number is compared to detect a price drop. |
| `location` | `text` |  |  |  |
| `post_url` | `text` |  |  |  |
| `condition` | `text` |  |  |  |
| `seller` | `text` |  |  |  |
| `description` | `text` |  |  |  |
| `image` | `text` |  |  |  |
| `listing_hash` | `text` |  |  | The worker's hash of the listing; a different hash on a later report alerts as an update. |
| `ai_score` | `integer` |  |  | AI rating, 1–5. |
| `ai_comment` | `text` |  |  | The AI's note, shown in the alert. |
| `ai_count` | `text` |  |  | The AI's unit count as a display phrase, e.g. '8 sticks'; NULL from workers that predate it. |
| `first_seen_at` | `text` | ✓ |  |  |
| `last_seen_at` | `text` | ✓ |  | Latest report from any worker; `GET /api/v1/listings?since=` filters on it. |
| `first_worker_id` | `text` |  |  | Worker whose report created the row. |
| `notified_at` | `text` |  |  | When the latest alert for it actually reached Telegram, set by outbox delivery. |

- **Primary key:** `dedupe_key`
- **Indexes:** `idx_listings_last_seen` (last_seen_at); `idx_listings_score` (ai_score)

Newness is decided by whose insert wins (insert-or-nothing), not by an earlier read, so two workers reporting a border listing at once alert once.

<a id="facebook-sightings"></a>

#### `sightings`

Append-only log of every report of a listing by any worker, so overlapping regions stay auditable. One row per listing in each `POST /api/v1/listings` batch.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `dedupe_key` | `text` | ✓ |  | → listings.dedupe_key (by value). |
| `worker_id` | `text` | ✓ |  | Reporting worker. |
| `seen_at` | `text` | ✓ |  |  |
| `price` | `text` |  |  | Price text in that report. |
| `ai_score` | `integer` |  |  | AI rating (1–5) in that report. |

- **Primary key:** `id`
- **Indexes:** `idx_sightings_key` (dedupe_key)

Never pruned, and no route reads it; only the tests count rows.

<a id="facebook-alert-claims"></a>

#### `alert_claims`

Which worker may alert one listing, for the homelab workers that send their own Telegram alerts (`POST /v1/alerts/claim`). The first claim wins; once the holder reports delivery, later claims are duplicates unless the price falls below the alerted one.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `marketplace` | `text` | ✓ |  | Always facebook today. |
| `listing_id` | `text` | ✓ |  | Facebook item id; matches alert_messages.listing_id. |
| `worker_id` | `text` | ✓ |  | Worker holding the claim, or the one that sent the alert. |
| `price` | `text` |  |  | Price text the claimed alert announced; NULL on seeded rows until a later claim sets a baseline. |
| `price_value` | `double precision` |  |  | First number parsed from price; a later claim below it alerts once more. DOUBLE PRECISION so $1234.56 does not compare as a drop against itself. |
| `claimed_at` | `text` | ✓ |  | When the current holder took the claim; the 15-minute lease runs from here. |
| `delivered_at` | `text` |  |  | NULL while the holder is still sending; set when it reports the alert delivered. |

- **Primary key:** `marketplace, listing_id`

A claim left undelivered for 15 min passes to the next worker that asks. Seeded at boot from alert_messages, only while the table is empty, so listings alerted before claims existed count as delivered.

### Telegram delivery

`outbox` holds every message the coordinator itself owes Telegram (listing, Messenger and ops alerts) until it is delivered. `alert_messages` records each listing alert a worker sent directly, so partner reactions can be joined back to the listing.

Tables: [`outbox`](#facebook-outbox), [`alert_messages`](#facebook-alert-messages)

<a id="facebook-outbox"></a>

#### `outbox`

One message the coordinator owes Telegram, written in the request that decided to send it and delivered by the background loop. A Telegram outage delays an alert instead of losing it.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `kind` | `text` | ✓ |  | listing_new / listing_changed / listing_discounted go to the listings chat; message_in / message_autoreply to the thread's war-room topic (the listings chat if no war room is set); ops_fleet / ops_liveness / ops-incident to the ops chat. |
| `dedupe_key` | `text` |  |  | listings.dedupe_key for listing kinds, the Facebook thread id for message kinds (used to pick the topic), the incident key for ops-incident; NULL otherwise. Not a uniqueness guard. |
| `text` | `text` | ✓ |  | Telegram MarkdownV2 body, already escaped. |
| `created_at` | `text` | ✓ |  |  |
| `attempts` | `integer` | ✓ | `0` | Failed send attempts so far. |
| `next_attempt_at` | `text` | ✓ |  | Earliest time of the next send. |
| `last_error` | `text` |  |  | Last send failure; cleared on delivery. |
| `delivered_at` | `text` |  |  | NULL until Telegram accepts the message. |

- **Primary key:** `id`
- **Indexes:** `idx_outbox_pending` (delivered_at, next_attempt_at)

Failed sends retry forever, backing off from 5 s and doubling to a 15-minute cap. Delivered rows are kept.

<a id="facebook-alert-messages"></a>

#### `alert_messages`

One Telegram message a worker's listing alert went out as, reported by the worker right after sending (`POST /v1/alerts/telegram`) so partner reactions can be joined back to the listing. Feeds the alert hit rate and the city tier rank.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  | Telegram chat the alert went to. |
| `message_id` | `integer` | ✓ |  | Telegram message id within that chat. |
| `worker_id` | `text` |  |  | Worker that sent the alert. |
| `topic_id` | `integer` |  |  | Forum topic (message_thread_id) it was posted in; NULL = General. |
| `priority` | `text` |  |  | Unit-count bucket that chose the topic: high (50+ units), medium (10–49), low (5–9). |
| `part` | `integer` | ✓ | `1` | Which message this is when a long alert was split; hit-rate counts use part 1 only. |
| `parts` | `integer` | ✓ | `1` | How many messages the alert was split into. |
| `listing_id` | `text` |  |  | Facebook item id; a reaction on any part credits the listing. |
| `post_url` | `text` |  |  |  |
| `item_name` | `text` |  |  | Search item that found the listing. |
| `search_city` | `text` |  |  | City slug searched. |
| `search_phrase` | `text` |  |  | Search phrase that found the listing. |
| `ai_score` | `integer` |  |  | AI rating of the listing. |
| `unit_count` | `integer` |  |  | The AI's count of units in the listing. |
| `prompt_hash` | `text` |  |  |  |
| `sent_at` | `text` | ✓ |  | Coordinator time it recorded the report, just after the send. |

- **Primary key:** `chat_id, message_id`
- **Indexes:** `idx_alert_messages_sent` (sent_at)

Fail-open: a coordinator outage costs a data point, never an alert. Never pruned; it also seeds alert_claims.

### Reactions and the update cursor

The Telegram update consumer's side: partner reactions on alerts in the listings chat, kept raw and as current state for the alert hit rate, and the one `getUpdates` cursor they share with war-room replies.

Tables: [`alert_reaction_events`](#facebook-alert-reaction-events), [`alert_reactions`](#facebook-alert-reactions), [`telegram_offset`](#facebook-telegram-offset)

<a id="facebook-alert-reaction-events"></a>

#### `alert_reaction_events`

Every reaction change a partner made on a message in the listings chat, appended verbatim by the Telegram update consumer: the long-term source data for prompt and region tuning.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `chat_id` | `text` | ✓ |  |  |
| `message_id` | `integer` | ✓ |  |  |
| `user_id` | `text` | ✓ |  | Telegram user id of the partner. |
| `user_name` | `text` |  |  | First and last name, else username. |
| `old_reaction` | `text` | ✓ | `'[]'` | Telegram's raw ReactionType JSON array before the change. |
| `new_reaction` | `text` | ✓ | `'[]'` | Telegram's raw ReactionType JSON array after the change. |
| `reacted_at` | `text` |  |  | Telegram's time of the change. |
| `recorded_at` | `text` | ✓ |  | When the coordinator stored it. |

- **Primary key:** `id`
- **Indexes:** `idx_reaction_events_msg` (chat_id, message_id)

Anonymous and bot reactions are dropped. Not checked against alert_messages, so a reaction on an alert sent before the ledger existed is kept.

<a id="facebook-alert-reactions"></a>

#### `alert_reactions`

The current reaction of one partner on one listings-chat message, upserted alongside each event. The hit-rate queries read this table.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `chat_id` | `text` | ✓ |  |  |
| `message_id` | `integer` | ✓ |  |  |
| `user_id` | `text` | ✓ |  |  |
| `user_name` | `text` |  |  |  |
| `emoji` | `text` | ✓ | `'[]'` | JSON array of the partner's current reactions as strings: emoji, custom-emoji id, or reaction type. |
| `first_reacted_at` | `text` |  |  | Set once, by the first event that carries a reaction. |
| `last_updated_at` | `text` | ✓ |  | Coordinator time of the latest change. |

- **Primary key:** `chat_id, message_id, user_id`

A removed reaction leaves `emoji` as '[]' and keeps the row; any other value counts as a hit.

<a id="facebook-telegram-offset"></a>

#### `telegram_offset`

Single-row `getUpdates` cursor for the coordinator's bot, so the update consumer resumes after a restart instead of replaying or skipping. One poll carries both war-room replies and listings-chat reactions.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ |  | Always 1; the CHECK keeps the table to one row. |
| `update_offset` | `integer` | ✓ |  | Next offset to ask for (last handled update_id + 1), advanced past every update, handled or not. |

- **Primary key:** `id`
- **Checks:** `id = 1`

getUpdates is exclusive per bot token, so nothing else may poll this bot while the coordinator runs. It is a different bot from the Reddit tracker's.

### Messenger bridge

Marketplace inbox conversations reported by `rs-messenger` (Playwright) and `rs-router` (mautrix-meta), and the replies queued for them to send. The coordinator decides; the bridges act.

Tables: [`threads`](#facebook-threads), [`messages`](#facebook-messages), [`outbound_messages`](#facebook-outbound-messages)

<a id="facebook-threads"></a>

#### `threads`

One Marketplace Messenger conversation, upserted from each inbox snapshot a bridge reports (`POST /v1/messages/sync`). Ties the Facebook thread to its Matrix room and its Telegram war-room topic.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `thread_id` | `text` | ✓ |  | Facebook conversation id. |
| `worker_id` | `text` |  |  | Worker that last reported the thread; Playwright replies are queued for it. |
| `counterpart` | `text` |  |  | The other party's display name. |
| `listing_title` | `text` |  |  | The Marketplace listing the conversation is about. |
| `last_message_at` | `text` |  |  | Last message time as the bridge reported it. |
| `human_claimed` | `integer` | ✓ | `0` | 1 = an operator took over (claimed it or replied); auto-reply never answers it again. |
| `autoreplied_at` | `text` |  |  | When the thread's one auto-reply was queued; stamped at queue time so a second sync cannot queue another. |
| `matrix_room_id` | `text` |  |  | mautrix-meta portal room it arrives from; NULL for threads only the Playwright scraper has reported. |
| `telegram_topic_id` | `integer` |  |  | War-room forum topic (message_thread_id), created by the first message alert that needs one. |
| `topic_state` | `text` |  | `'open'` | Defaults to 'open'; no code in trackers/facebook writes or reads it. |
| `created_at` | `text` | ✓ |  |  |

- **Primary key:** `thread_id`
- **Indexes:** `idx_threads_room` (matrix_room_id); `idx_threads_topic` (telegram_topic_id)

The upsert COALESCEs each field, so a sparser snapshot never blanks what a fuller one recorded.

<a id="facebook-messages"></a>

#### `messages`

One Messenger message, inserted only if its fingerprint is new, so bridges can re-report whole threads on every poll. Each new inbound message queues a message_in alert in outbox.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `fingerprint` | `text` | ✓ |  | SHA-1 of thread id, direction, sender, text and sent_at. |
| `thread_id` | `text` | ✓ |  | → threads.thread_id (by value). |
| `direction` | `text` | ✓ |  | in = from the counterpart; out = sent by us, human or bot. |
| `sender` | `text` |  |  | Sender name as scraped. |
| `text` | `text` |  |  |  |
| `sent_at` | `text` |  |  | Timestamp as the bridge scraped it; may be relative ('5m ago') or absent. |
| `created_at` | `text` | ✓ |  |  |

- **Primary key:** `fingerprint`
- **Indexes:** `idx_messages_thread` (thread_id)

Scraped timestamps are unreliable, so the fingerprint leans on content: the same sender sending identical text with the same or no timestamp collapses into one row.

<a id="facebook-outbound-messages"></a>

#### `outbound_messages`

A reply waiting to be typed into Facebook, queued by the auto-reply policy or by an operator (console, or a staff answer in a war-room topic). A bridge fetches its queue, sends and acks; nothing here sends anything itself.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `thread_id` | `text` | ✓ |  |  |
| `worker_id` | `text` |  |  | Worker that should send it; NULL = any bridge of that transport (all Matrix replies, or an operator reply before the thread had an owner). |
| `text` | `text` | ✓ |  |  |
| `origin` | `text` | ✓ |  | autoreply or operator. |
| `transport` | `text` | ✓ | `'playwright'` | playwright = rs-messenger sends it; matrix = rs-router sends it through mautrix-meta. |
| `status` | `text` | ✓ | `'queued'` | queued, sent, or failed (after 3 failed attempts, or one the bridge marked permanent). A failure never demotes a sent row. |
| `created_at` | `text` | ✓ |  |  |
| `sent_at` | `text` |  |  |  |
| `attempts` | `integer` | ✓ | `0` | Delivery attempts acked so far. |
| `last_error` | `text` |  |  | Last error the bridge reported. |

- **Primary key:** `id`
- **Indexes:** `idx_outbound_status` (status)

`transport` partitions the queue, so the Playwright scraper and the Matrix router never both send one reply.

### Fleet health and incidents

Each worker's latest heartbeat, the log of its status changes, and fleet-wide incidents that page ops once per outage.

Tables: [`workers`](#facebook-workers), [`worker_status_events`](#facebook-worker-status-events), [`incidents`](#facebook-incidents)

<a id="facebook-workers"></a>

#### `workers`

One worker's latest reported health, upserted by each heartbeat (`POST /v1/heartbeat`) and listing upload; fields a heartbeat leaves out keep their earlier values. Also holds the directives an operator queues for the worker and the markers the liveness sweep keeps.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `worker_id` | `text` | ✓ |  |  |
| `region` | `text` |  |  | Region the worker reports. |
| `status` | `text` |  |  | Free-text status from workers that predate the control plane, default ok; superseded by state. |
| `detail_json` | `text` |  |  | The heartbeat's detail object as JSON, e.g. the item being searched. |
| `last_heartbeat_at` | `text` |  |  |  |
| `last_listing_at` | `text` |  |  | Last listing upload over POST /api/v1/listings. |
| `state` | `text` |  |  | HEALTHY, DEGRADED, SESSION_EXPIRED, CHALLENGE_2FA, CHALLENGE_EMAIL, CHALLENGE_CAPTCHA, CHECKPOINT or DEAD; anything but HEALTHY flags the worker. |
| `account_id` | `text` |  |  | Account the worker says it runs; the vault's own mapping is accounts.worker_id. |
| `session_expiry` | `text` |  |  | When the worker's Facebook session lapses; within 14 days flags the worker. |
| `last_search_at` | `text` |  |  | When the worker last started an item's search cycle, in the worker's own ISO form. |
| `error_count` | `integer` |  | `0` |  |
| `browser_ok` | `integer` |  |  | The worker's own browser check, 1/0; NULL if never reported. |
| `proxy_ok` | `integer` |  |  | The worker's own proxy check, 1/0; NULL if never reported. |
| `vnc_url` | `text` |  |  | Where the worker's browser can be driven now; wins over accounts.vnc_url. |
| `version` | `text` |  |  | Build the worker reports (version and short commit); release gates compare it. |
| `alerted_liveness` | `text` |  |  | 'dead' once ops was paged that the worker went silent; NULL after the back-online page. Persisted so a restart does not re-page. |
| `relogin_requested_at` | `text` |  |  | Set when an operator presses Re-login; cleared when the worker's next heartbeat or directive poll takes it. |
| `relogin_last_requested_at` | `text` |  |  | The same stamp, kept after pickup so the ERP can tell a queued re-login from one under way. |
| `restore_requested_at` | `text` |  |  | Set by the ERP's cookie-first assign to restore the seeded snapshot now; cleared on pickup. |
| `sweep_requested_at` | `text` |  |  | Set when a manager starts the city round by hand, for each worker that can start a sweep on a directive; cleared when its directive poll picks it up. |
| `login_step` | `text` |  |  | Where the latest login has got to: picked_up, typing, submitted, challenge, waiting_for_human, logged_in or failed (free text, up to 32 chars). |
| `login_step_at` | `text` |  |  | When login_step was reached, as the worker reported it. |
| `host_id` | `text` |  |  | Docker host the worker reports running on (RS_HOST_ID). |
| `retired_at` | `text` |  |  | Set when the fleet stops the worker on purpose; liveness pages and the status log skip it. Cleared when it is started again. |
| `logged_liveness` | `text` |  |  | Liveness last written to worker_status_events (live, stale, dead); NULL before anything was logged or while retired. |

- **Primary key:** `worker_id`

Liveness is derived on read from last_heartbeat_at: stale after 2 h, dead after 6 h, since searches run every 45–75 min. Only the latest beat is kept; worker_status_events is the history.

<a id="facebook-worker-status-events"></a>

#### `worker_status_events`

Every change in a worker's reported state or in its liveness, appended by heartbeats and by the background sweep. The only history of either; the ERP lists it as Recent activity.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `id` | `integer` | ✓ | identity |  |
| `worker_id` | `text` | ✓ |  |  |
| `at` | `text` | ✓ |  |  |
| `kind` | `text` | ✓ |  | state = the reported state changed; liveness = live / stale / dead changed. |
| `was` | `text` |  |  | Previous value; NULL for a worker's first. |
| `became` | `text` | ✓ |  | New value. |

- **Primary key:** `id`
- **Indexes:** `idx_worker_status_events_at` (at)

`at` is when the change happened, not when it was noticed. Pruned to 30 days on write.

<a id="facebook-incidents"></a>

#### `incidents`

One fleet-wide fault, such as the AI evaluator being down, folded from workers' down/up reports (`POST /v1/incidents`) so ops are paged once per outage rather than once per worker.

| Column | Type | Not null | Default | Meaning |
| --- | --- | :-: | --- | --- |
| `key` | `text` | ✓ |  | Fault name, e.g. ai_unavailable. |
| `is_open` | `integer` | ✓ | `0` | 1 while any live down vote remains. |
| `opened_at` | `text` |  |  |  |
| `closed_at` | `text` |  |  |  |
| `last_reported_at` | `text` |  |  | Latest report from any worker. |
| `last_alerted_at` | `text` |  |  | Latest page; outlives the incident so a relapse within the cooldown stays quiet. |
| `alerted` | `integer` | ✓ | `0` | 1 if the current opening was paged, which decides whether closing sends a recovered note. |
| `detail` | `text` |  |  | Last error a down report carried, up to 300 chars. |
| `reporters` | `text` | ✓ | `'{}'` | JSON map of worker id → ISO time of its latest live down vote. |

- **Primary key:** `key`

Closes when every worker that voted down has reported up or its vote aged out after 24 h. A relapse within the 6-hour cooldown reopens and closes without a page.

## Other stored state

None of these are databases, but each holds state something depends on.

- **ERP attachments, R2.** Uploaded files (status evidence, line photos, label
  scans, web-submission photos, sell-order attachments) go to the Cloudflare R2
  bucket managed in `infra/terraform/modules/cloudflare/r2.tf`, through
  `apps/backend/src/r2.ts`. Rows keep the storage key. With no R2 settings
  (dev, tests), uploads return a stub key and a `data:` URL.
- **ERP backups, R2.** The `recycle-db-backup` bucket (see *Running it*).
- **WeChat market report.** memtrade, on the office Mac outside this repo,
  keeps its own state and pushes each day's report into the `wechat_market_*`
  tables.
- **Facebook fleet hosts.**
  - `rs_fleetd` keeps its desired state, adopted containers, each worker's
    `config.toml` and each worker's session directory under `RS_FLEET_ROOT`
    (`rs_fleetd/state.py`).
  - Each worker keeps its browser session and `identity.json` in its own
    `/data`, and backs the session up to the coordinator (`session_snapshots`).
  - `rs_poster` keeps its own ledger of posted ads and pacing in
    `ads/state.json` (`rs_poster/state.py`).
  - Live credentials sit in gitignored files beside the tree
    (`configs/secrets.env`, `configs/sessions/`).

## Keeping this file current

- **A migration that adds, drops or changes a table updates that table's
  section here in the same PR.** That covers ERP and Reddit migration files,
  and changes to the Facebook `SCHEMA` or `*_EXTRA_COLUMNS` lists. Update the
  *As of* line too.
- To see a table exactly as the code defines it, build a scratch copy and read
  it back. Use a free port, never 5432, 5433 or 55432:

  ```sh
  docker run -d --rm --name dbdoc -e POSTGRES_PASSWORD=doc -e POSTGRES_USER=doc \
    -e POSTGRES_DB=erp -p 127.0.0.1:55499:5432 postgres:18-alpine
  docker exec dbdoc psql -U doc -d erp -c 'create database reddit' -c 'create database fb'
  (cd apps/backend && DATABASE_URL=postgres://doc:doc@127.0.0.1:55499/erp node scripts/migrate.mjs)
  (cd trackers/reddit && DATABASE_URL=postgres://doc:doc@127.0.0.1:55499/reddit pnpm db:migrate)
  # Python 3.11+ with psycopg[binary] and psycopg_pool installed:
  (cd trackers/facebook/rs_coordinator && python -c "from rs_coordinator.pg import PostgresDatabase as P; P('postgresql://doc:doc@127.0.0.1:55499/fb')")
  docker exec -it dbdoc psql -U doc -d erp -c '\d+ orders'
  docker stop dbdoc
  ```
