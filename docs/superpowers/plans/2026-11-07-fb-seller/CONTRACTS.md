# Contracts

The one source for everything two workstreams share. **Frozen**: an agent that
needs a change stops and reports it to the orchestrator, who changes this file
in one PR and tells every running agent. Section numbers are stable so PRs can
cite them.

Paths: `apps/backend/src/…` is written as `src/…`; `packages/shared/src/…` as
`shared/…`; the vendored monitor's package
`trackers/facebook/ai-marketplace-monitor/src/ai_marketplace_monitor/` as
`aimm/`.

## 1. Words

| Word | Meaning |
| --- | --- |
| seller account | a pool account whose `fleet_slots.role = 'seller'`; it never searches |
| ad | a manager-written "we buy" listing text, `fb_ads` |
| placement | one ad posted by one account in one location, `fb_ad_placements`; a renewal is a new placement |
| pool | a named set of photos, `fb_photo_pools` / `fb_photos` |
| thread | one Marketplace conversation on one seller account, `fb_threads` |
| run | one agent decision about one thread, `fb_agent_runs` |
| profile | one immutable version of the agent's prompts, skills, rules and models, `fb_agent_profiles` |
| hand-off | the thread moves to Needs human with a reason in words, and the agent stops replying until a manager hands it back |

## 2. Configuration

The database is the only source. Nothing new reads a file. Secrets stay in
env: `OPENROUTER_API_KEY` (exists), `FB_SELLER_TELEGRAM_BOT_TOKEN` (new,
optional; Telegram is skipped when unset). Selectors and step timings stay in
the worker code (owner, 2026-11-07).

### 2.1 `fb_seller_settings`

One row (`id = 1`), the value typed as `FbSellerSettings` in
`shared/fbSeller.ts`. `src/services/fbConfig.ts` (C) owns load, validate and
save; every other module calls `loadFbSellerSettings(sql)` and must read it
per tick or per run, never cache it past one.

```ts
export type FbSellerSettings = {
  kill_switch: boolean;                       // true: no agent run sends, queued agent messages are held
  active_hours: { start: string; end: string; tz: string };   // 'HH:MM', IANA tz; outside them no seller task is due
  pacing: {
    ad_action_gap_minutes: number;            // between any ad-post/ad-delete on one account
    max_live_ads_per_account: number;
    same_ad_location_per_day: number;         // placements of one ad in one location per day
    renew_days: number;                       // default for new ads
    renew_jitter_days: number;
    send_gap_seconds: number;                 // between msg-send tasks on one account
    send_jitter_seconds: number;
    sends_per_account_day: number;
    inbox_every_minutes: number;
    inbox_jitter_minutes: number;
    inbox_max_threads: number;
    inbox_max_messages: number;
  };
  offer: {
    opening_pct: number;                      // first offer as % of ceiling
    step_pct: number;                         // added per round, in % of ceiling
    max_rounds: number;
    price_max_age_days: number;               // older Market price → hand off
  };
  agent: {
    daily_spend_usd: number;                  // all runs, shadow included
    circuit_breaker_failures: number;         // consecutive guard/send failures on one account → agent_on false
  };
  photos: { low_pool_warning: number };       // unused photos left in a pool that raise an alert
  alerts: { telegram_chat_id: string | null };
};
```

Seeded defaults (A1's migration):

```json
{
  "kill_switch": false,
  "active_hours": { "start": "08:00", "end": "22:00", "tz": "America/Denver" },
  "pacing": {
    "ad_action_gap_minutes": 20, "max_live_ads_per_account": 3, "same_ad_location_per_day": 1,
    "renew_days": 7, "renew_jitter_days": 2,
    "send_gap_seconds": 60, "send_jitter_seconds": 30, "sends_per_account_day": 40,
    "inbox_every_minutes": 5, "inbox_jitter_minutes": 2, "inbox_max_threads": 10, "inbox_max_messages": 25
  },
  "offer": { "opening_pct": 70, "step_pct": 10, "max_rounds": 3, "price_max_age_days": 30 },
  "agent": { "daily_spend_usd": 5, "circuit_breaker_failures": 3 },
  "photos": { "low_pool_warning": 15 },
  "alerts": { "telegram_chat_id": null }
}
```

Validation bounds (C enforces, E mirrors in the form): every number is a
finite integer ≥ 0 except percentages (1–100); `send_gap_seconds` ≥ 10;
`ad_action_gap_minutes` ≥ 5; `inbox_every_minutes` ≥ 2; `start`/`end` match
`^\d{2}:\d{2}$`; `tz` is a valid IANA zone. A refused save answers 422
`{ error: 'bad_settings', detail: '<field path>: <reason in words>' }`.

### 2.2 History

Every save writes `fb_seller_settings_history` (append-only) with the version,
the value before and after, who and when. Saves are optimistic: the PUT
carries `version`; a stale one answers 409
`{ error: 'stale_settings', detail: 'Someone saved the settings since you opened them.' }`.

## 3. Schema

A1 writes one migration (next free number; 0232 at the time of writing) with
everything below, and the matching `docs/DATABASE.md` sections. A2 adds one
more migration for the fencing trigger (§4.5). No other workstream adds a
migration without a contract change. Every FK gets its index in the same
migration and an explicit `ON DELETE`.

### 3.1 Fleet

```sql
ALTER TABLE fleet_tasks ALTER COLUMN city DROP NOT NULL, ALTER COLUMN item DROP NOT NULL;
ALTER TABLE fleet_tasks ADD COLUMN payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE fleet_tasks DROP CONSTRAINT fleet_tasks_state_check;   -- A1: confirm the name in 0206 first
ALTER TABLE fleet_tasks ADD CONSTRAINT fleet_tasks_state_check
  CHECK (state IN ('ready','leased','done','cancelled','expired','uncertain'));
-- Search kinds keep their city and item; seller kinds name their account and a ref.
ALTER TABLE fleet_tasks ADD CONSTRAINT fleet_tasks_seller_shape CHECK (
  CASE WHEN kind IN ('ad-post','ad-delete','inbox-sync','msg-send')
       THEN city IS NULL AND item IS NULL AND account_no IS NOT NULL AND payload ? 'ref'
       ELSE city IS NOT NULL AND item IS NOT NULL END);
CREATE UNIQUE INDEX fleet_tasks_seller_open_idx ON fleet_tasks(account_no, kind, (payload->>'ref'))
  WHERE state IN ('ready','leased') AND kind IN ('ad-post','ad-delete','inbox-sync','msg-send');

ALTER TABLE fleet_slots ADD COLUMN role TEXT NOT NULL DEFAULT 'search' CHECK (role IN ('search','seller'));
ALTER TABLE fleet_slots ADD COLUMN agent_on BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fleet_slots ADD COLUMN agent_profile_id BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL;
```

`fleet_slots.agent_profile_id` needs `fb_agent_profiles` created first, in the
same migration.

### 3.2 Settings

```sql
CREATE TABLE fb_seller_settings (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  value       JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE fb_seller_settings_history (            -- append-only (trigger, as reddit_lead_events)
  id          BIGSERIAL PRIMARY KEY,
  version     INTEGER NOT NULL,
  before      JSONB,
  after       JSONB NOT NULL,
  changed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.3 Photos and ads

```sql
CREATE TABLE fb_photo_pools (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE TABLE fb_photos (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL REFERENCES fb_photo_pools(id) ON DELETE RESTRICT,
  r2_key TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER,
  sha256 TEXT NOT NULL UNIQUE,                       -- the same file is refused in every pool
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,                               -- set once, never cleared: a photo is used once, ever
  used_by_placement BIGINT                           -- FK added after fb_ad_placements exists, ON DELETE SET NULL
);
CREATE INDEX fb_photos_unused_idx ON fb_photos(pool_id) WHERE used_at IS NULL;

CREATE TABLE fb_ads (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL, description TEXT NOT NULL, price_usd NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
  category TEXT NOT NULL DEFAULT 'Electronics', condition TEXT NOT NULL DEFAULT 'Used - Good',
  renew_days INTEGER NOT NULL DEFAULT 7 CHECK (renew_days BETWEEN 1 AND 60),
  photo_pool_id BIGINT REFERENCES fb_photo_pools(id) ON DELETE SET NULL,
  photos_min INTEGER NOT NULL DEFAULT 3, photos_max INTEGER NOT NULL DEFAULT 5,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','ready','archived')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (photos_min BETWEEN 1 AND 10 AND photos_max BETWEEN photos_min AND 10)
);

CREATE TABLE fb_ad_placements (
  id BIGSERIAL PRIMARY KEY,
  ad_id BIGINT NOT NULL REFERENCES fb_ads(id) ON DELETE RESTRICT,
  account_no INTEGER REFERENCES fb_pool_accounts(no) ON DELETE SET NULL,
  location TEXT NOT NULL,                            -- what the composer's location box takes, e.g. 'Denver, CO'
  content JSONB NOT NULL,                            -- frozen copy: {title, description, price_usd, category, condition}
  photo_ids BIGINT[] NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('needs_photos','queued','live','removing','removed','failed','uncertain')),
  renews_id BIGINT REFERENCES fb_ad_placements(id) ON DELETE SET NULL,   -- the placement this one replaced
  fb_listing_id TEXT, posted_at TIMESTAMPTZ, next_renew_at TIMESTAMPTZ, removed_at TIMESTAMPTZ,
  last_error TEXT, task_id BIGINT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE fb_photos ADD CONSTRAINT fb_photos_used_by_placement_fkey
  FOREIGN KEY (used_by_placement) REFERENCES fb_ad_placements(id) ON DELETE SET NULL;
```

### 3.4 Threads and messages

```sql
CREATE TABLE fb_threads (
  id BIGSERIAL PRIMARY KEY,
  account_no INTEGER REFERENCES fb_pool_accounts(no) ON DELETE SET NULL,
  fb_thread_id TEXT NOT NULL,
  seller_name TEXT NOT NULL DEFAULT '', listing_title TEXT NOT NULL DEFAULT '',
  placement_id BIGINT REFERENCES fb_ad_placements(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','screening','negotiating','closing','won','lost')),
  mode TEXT NOT NULL DEFAULT 'agent' CHECK (mode IN ('agent','human')),
  needs_human BOOLEAN NOT NULL DEFAULT FALSE, human_reason TEXT, human_at TIMESTAMPTZ,
  offer_usd NUMERIC(10,2), ceiling_usd NUMERIC(10,2), round INTEGER NOT NULL DEFAULT 0,
  extracted JSONB NOT NULL DEFAULT '{}',
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TIMESTAMPTZ, last_outbound_at TIMESTAMPTZ, unread BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at TIMESTAMPTZ, close_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_no, fb_thread_id)
);
CREATE INDEX fb_threads_needs_human_idx ON fb_threads(human_at) WHERE needs_human;

CREATE TABLE fb_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES fb_threads(id) ON DELETE CASCADE,
  seq INTEGER,                                       -- position in the conversation, assigned by the ERP (§5.4); NULL while an outbound is unseen
  direction TEXT NOT NULL CHECK (direction IN ('in','out','unknown')),
  author TEXT NOT NULL CHECK (author IN ('seller','agent','staff','facebook')),   -- 'facebook': an outbound we did not queue
  body TEXT NOT NULL, has_image BOOLEAN NOT NULL DEFAULT FALSE,
  send_state TEXT CHECK (send_state IN ('queued','held','sending','sent','uncertain','failed')),  -- NULL for inbound
  task_id BIGINT, agent_run_id BIGINT, staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), sent_at TIMESTAMPTZ,
  UNIQUE (thread_id, seq)
);
CREATE INDEX fb_messages_outbox_idx ON fb_messages(send_state, created_at) WHERE send_state IN ('queued','held','sending','uncertain');

CREATE TABLE fb_thread_events (                      -- append-only; no FK so a thread's history outlives it
  id BIGSERIAL PRIMARY KEY, thread_id BIGINT NOT NULL,
  kind TEXT NOT NULL,                                -- created, inbound, agent_sent, staff_sent, handed_off, taken_over, handed_back, stage, offer, closed, send_failed, send_uncertain
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL DEFAULT 'system',
  detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_thread_events_thread_idx ON fb_thread_events(thread_id, created_at);
```

### 3.5 Agent

```sql
CREATE TABLE fb_agent_profiles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','candidate','active','retired')),
  prompts JSONB NOT NULL, skills JSONB NOT NULL, rules JSONB NOT NULL, models JSONB NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  based_on BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX fb_agent_profiles_one_active ON fb_agent_profiles((TRUE)) WHERE state = 'active';
CREATE UNIQUE INDEX fb_agent_profiles_one_candidate ON fb_agent_profiles((TRUE)) WHERE state = 'candidate';

CREATE TABLE fb_agent_runs (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT REFERENCES fb_threads(id) ON DELETE CASCADE,          -- NULL for an eval run's case
  trigger_message_id BIGINT REFERENCES fb_messages(id) ON DELETE SET NULL,
  profile_id BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL,
  shadow BOOLEAN NOT NULL DEFAULT FALSE,
  eval_run_id BIGINT,                                -- FK added after fb_agent_eval_runs, ON DELETE CASCADE
  eval_case_id BIGINT,                               -- FK added after fb_agent_eval_cases, ON DELETE SET NULL
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, claimed_at TIMESTAMPTZ,
  input JSONB,                                       -- AgentInput (§6.1): everything needed to replay
  decision JSONB,                                    -- AgentDecision (§6.1)
  outcome TEXT CHECK (outcome IN ('send','handoff','noop','blocked','error')),
  model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd NUMERIC(10,5),
  error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
);
CREATE INDEX fb_agent_runs_queue_idx ON fb_agent_runs(state, created_at) WHERE state IN ('queued','running');

CREATE TABLE fb_agent_eval_cases (
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL,
  source_thread_id BIGINT REFERENCES fb_threads(id) ON DELETE SET NULL,
  input JSONB NOT NULL,                              -- AgentInput with the Market snapshot frozen
  expected JSONB NOT NULL,                           -- EvalExpectation (§6.4)
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE TABLE fb_agent_eval_runs (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES fb_agent_profiles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  cases INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,5) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
```

A1 seeds profile `default` v1 as `active` (§6.3) and the settings row.

## 4. Worker protocol

### 4.1 Kinds and who gets them

`FLEET_TASK_KINDS` becomes `['search','verify-slug','probe','ad-post','ad-delete','inbox-sync','msg-send']`.
`FLEET_SELLER_TASK_KINDS = ['ad-post','ad-delete','inbox-sync','msg-send']`.
`FLEET_SELLER_MIN_WORKER_VERSION` in `shared/fleet.ts` starts as `'99.0.0'`,
so no worker gets a seller task until F sets it to the released tracker
version.

- A seller kind is handed only to the worker holding that task's
  `account_no`, only when that slot's `role = 'seller'`, and only when the
  worker's reported version is at least `FLEET_SELLER_MIN_WORKER_VERSION`.
- A slot with `role = 'seller'` is never handed `search` or `verify-slug`. It
  still takes its own `probe`.
- `claim`: a seller slot is claimable only by a worker at or above
  `FLEET_SELLER_MIN_WORKER_VERSION`, the same way as the cloak check
  (`src/fleet/claim.ts`, `FLEET_CLOAK_MIN_WORKER_VERSION`).
- Setting `role` on a slot changes no container and causes no login.
- Seller task minutes are not charged to the search budget
  (`minutesTodaySql` filters `kind NOT IN seller kinds`), and the budget gate
  in `pickTask` does not stop seller kinds.
- A quarantined slot gets no seller kinds. A worker with a wall stops asking
  for tasks, as today.

### 4.2 Handed task

```ts
export type HandedTask =
  | { id: number; kind: 'search' | 'verify-slug' | 'probe'; city: { slug: string; name: string; radius_km: number }; item: string; lease_expires_at: string }
  | { id: number; kind: FleetSellerTaskKind; city: null; item: null; payload: SellerTaskPayload; lease_expires_at: string };
```

A worker too old to know a seller kind never gets one (§4.1). A worker that
does know them dispatches on `kind` **before** it looks up `item`.

### 4.3 Payloads

All carry `ref`, a string, unique per open task per account and kind.

```ts
export type SellerTaskPayload =
  | { ref: string /* placement id */; kind: 'ad-post'; location: string; title: string; description: string;
      price_usd: number; category: string; condition: string; photos: { url: string; sha256: string }[] }
  | { ref: string /* placement id */; kind: 'ad-delete'; fb_listing_id: string; title: string }
  | { ref: string /* 'inbox:' + ISO minute */; kind: 'inbox-sync'; max_threads: number; max_messages: number }
  | { ref: string /* message id */; kind: 'msg-send'; fb_thread_id: string; body: string;
      /** the last few messages the ERP knows, newest last, so the worker can tell whether this one already landed */
      tail: { direction: 'in' | 'out' | 'unknown'; body: string }[] };
```

Photo URLs are public R2 URLs (`R2_ATTACHMENTS_PUBLIC_URL/<key>`). The worker
downloads them into its own temp directory and deletes them after the task.

### 4.4 Report and screenshot routes

`POST /api/fleet/worker/seller/report` (worker bearer, CSRF-exempt like the
rest of `/api/fleet/worker/`):

```ts
export type SellerReport = {
  task_id: number;
  kind: FleetSellerTaskKind;
  ref: string;
  outcome: 'ok' | 'failed' | 'uncertain' | 'wall';
  detail?: string;                      // a reason in words for failed / uncertain / wall
  data?:
    | { fb_listing_id: string }                                            // ad-post ok
    | Record<string, never>                                                // ad-delete
    | { threads: InboxThread[] }                                           // inbox-sync ok
    | { already_sent: boolean };                                           // msg-send ok
};
export type InboxThread = {
  fb_thread_id: string; seller_name: string; listing_title: string;
  /** oldest first, the window the page showed (up to max_messages) */
  messages: { direction: 'in' | 'out' | 'unknown'; body: string; has_image: boolean }[];
};
```

- The worker sends the report **before** `done` on `next-task`.
- The route checks the token's HMAC, worker id and account. It does **not**
  check the epoch or the slot's eligibility: a report of something that
  happened is accepted even after the lease is lost.
- It is idempotent on `(account_no, kind, ref)`: the second report of the same
  outcome is a no-op.
- It never answers 401 or 409 over a stale epoch or a lost lease; a worker
  exits on those, and each exit is a login. A report it can't use answers 200
  `{ accepted: false, detail }`. A malformed body is 422.
- Body limit 512 KB. A2 checks what the Cloudflare edge allows and records it.
- A2 owns the route and stores the report; C owns what it does to the domain,
  through `applySellerReport(tx, accountNo, report)` in
  `src/services/fbSellerReports.ts` (C), which A2 calls inside the same
  transaction. Until C merges, A1's stub returns `{ accepted: true }`.

`POST /api/fleet/worker/seller/screenshot` (worker bearer), multipart with
`task_id`, `ref`, `step` and an image file. Stored in R2 under
`fb-seller/screenshots/<account>/<task>-<step>.png` with `getUploadLimits`.
It answers `{ ok: true, key }`, and is never required for a task to finish.

### 4.5 Lost leases

| Path | `ad-post`, `ad-delete`, `msg-send` | `inbox-sync` |
| --- | --- | --- |
| `releaseTasks` (`src/fleet/claim.ts`) | → `uncertain` | → `ready` |
| `fleet_fence_pool_owner` trigger (0207) | → `uncertain` | → `cancelled` |
| scheduler lease expiry (`src/fleet/scheduler.ts`) | → `uncertain` | → `expired` |

- Seller tasks always keep their `account_no`.
- `notifyReady` must skip null items.
- The domain side is C's: its tick finds `uncertain` seller tasks it has not
  settled, and marks the message `uncertain` or the placement `uncertain`.
  - **An uncertain message** is settled by the next `inbox-sync`. If its body
    appears as an outbound message in the thread, it becomes `sent`.
    Otherwise it becomes `failed` and the thread hands off with the reason
    "A reply may not have reached the seller".
  - **An uncertain placement** waits for a manager to resolve it on the Ads
    tab.

### 4.6 Worker behaviour every seller task shares

- Runs on the worker's existing page and session; never a second browser, never a login.
- Checks for a wall (`_wall_kind_from_url` and the restriction text patterns ported from `rs_poster/selectors.py`) after every navigation **and after every submit**; a wall reports `outcome: 'wall'` and parks the worker the existing way.
- English (US) UI only; any page the selectors don't recognise is `failed` with the step named, plus a screenshot.
- Never retries a submit inside the task. A send or a publish whose result it could not see is `uncertain`, never retried.

## 5. Seller backend (C)

### 5.1 HTTP routes, `/api/fb-seller`

Every route is manager-only, using a cookie session and `effectiveRole`.

- **Writes in mirror mode:** a write on a mirror ERP (`FLEET_ROLE=mirror`) answers 409 `{ error: 'mirror', detail }`.
- **Refusals:** `{ error, detail }`, where `detail` is a sentence, never a status code.
- **Lists:** paginate with `cursor` and `limit`, using `lib/pagination.ts`.

| Method | Path | Body or query | Answer |
| --- | --- | --- | --- |
| GET | `/summary` | | `FbSellerSummary` (badge counts) |
| GET | `/settings` | | `{ value: FbSellerSettings, version }` |
| PUT | `/settings` | `{ value, version }` | `{ value, version }` |
| GET | `/settings/history` | `cursor` | `{ rows: FbSettingsChange[], next }` |
| GET | `/accounts` | | `{ rows: FbSellerAccount[] }` (every fleet slot, with role, agent, live ads, threads, sends today) |
| PATCH | `/accounts/:no` | `{ role?, agent_on?, agent_profile_id? }` | `FbSellerAccount` |
| GET | `/pools` | | `{ rows: FbPhotoPool[] }` (with used / unused counts) |
| POST | `/pools` | `{ name, note? }` | `FbPhotoPool` |
| PATCH | `/pools/:id` | `{ name?, note?, archived? }` | `FbPhotoPool` |
| GET | `/pools/:id/photos` | `cursor`, `used=all\|used\|unused` | `{ rows: FbPhoto[], next }` |
| POST | `/pools/:id/photos` | multipart, many `file` | `{ added: FbPhoto[], refused: { name, reason }[] }`; a duplicate names the pool and photo it duplicates |
| DELETE | `/photos/:id` | | unused only, else 409 `photo_used` |
| GET | `/ads` | `state` | `{ rows: FbAd[] }` |
| POST | `/ads` | `FbAdInput` | `FbAd` |
| GET | `/ads/:id` | | `FbAd` with its placements |
| PATCH | `/ads/:id` | partial `FbAdInput` plus `state` | `FbAd` |
| POST | `/ads/:id/place` | `{ account_nos: number[], locations: string[] }` | `{ placements: FbPlacement[], refused: { account_no, location, reason }[] }` |
| GET | `/placements` | `state`, `account_no`, `cursor` | `{ rows: FbPlacement[], next }` |
| POST | `/placements/:id/renew` | | `FbPlacement` (the new one) |
| POST | `/placements/:id/remove` | | `FbPlacement` |
| POST | `/placements/:id/resolve` | `{ live: boolean, fb_listing_id? }` | `FbPlacement` (only from `uncertain`) |
| GET | `/threads` | `view=needs_human\|inbox\|closed`, `account_no`, `q`, `cursor` | `{ rows: FbThreadRow[], next }` |
| GET | `/threads/:id` | | `FbThreadDetail` (messages, events, last runs, Market matches) |
| POST | `/threads/:id/reply` | `{ body }` | `FbMessage` (`queued`, author `staff`) |
| POST | `/threads/:id/take-over` | | `FbThreadDetail` (`mode = 'human'`) |
| POST | `/threads/:id/hand-back` | | `FbThreadDetail` (`mode = 'agent'`, `needs_human` false) |
| POST | `/threads/:id/close` | `{ outcome: 'won'\|'lost', note? }` | `FbThreadDetail` |
| POST | `/threads/:id/read` | | `{ ok: true }` |
| POST | `/threads/:id/save-case` | `{ name, expected: EvalExpectation }` | `{ case_id }` (calls D2's `saveCaseFromThread`) |

**Placing an ad** picks photos inside the same transaction:

1. Choose a random count between `photos_min` and `photos_max`.
2. Pick from the pool's unused photos with `ORDER BY random() ... FOR UPDATE SKIP LOCKED`.
3. Set `used_at` and `used_by_placement` on each photo picked.
4. If too few are left, the placement is `needs_photos`, and managers get an alert with the pool name and how many are short.
5. Renewal draws new photos the same way.

The placement is refused, with the reason in words, when:
- the ad isn't `ready`;
- the account isn't a seller;
- `same_ad_location_per_day` would be exceeded.

### 5.2 Services other workstreams call

`src/services/fbThreads.ts`. Every function takes a transaction:

```ts
export async function loadThreadSnapshot(tx: SqlLike, threadId: number): Promise<FbThreadSnapshot>;
export async function queueOutbound(tx: SqlLike, threadId: number, body: string,
  by: { author: 'agent'; agentRunId: number } | { author: 'staff'; userId: string }): Promise<{ messageId: number }>;
export async function flagHuman(tx: SqlLike, threadId: number, reason: string, detail?: Record<string, unknown>): Promise<void>;
export async function setStage(tx: SqlLike, threadId: number, stage: FbThreadStage): Promise<void>;
export async function recordOffer(tx: SqlLike, threadId: number, o: { offerUsd: number; ceilingUsd: number; round: number }): Promise<void>;
export async function recordExtract(tx: SqlLike, threadId: number, extracted: AgentExtract): Promise<void>;
```

- **`queueOutbound`** from the agent refuses, by throwing, when the thread's `mode` is `human`, `needs_human` is set, or the kill switch is on. A staff reply is always accepted.
- **`flagHuman`** sets `needs_human`, `human_reason` and `human_at`, writes the event, and alerts managers (§5.4).

`src/services/fbSellerReports.ts`: `applySellerReport(tx, accountNo, report): Promise<{ accepted: boolean; detail?: string }>`.

`src/lib/fbSellerAlert.ts`: `alertManagers(tx, a: { kind: string; title: string; reason: string; threadId?: number })`. It calls `notifyManagers` inside the transaction and queues the Telegram send for after commit. Telegram is skipped when the token or chat ID is unset. The text gives the reason and never a status code.

### 5.3 Tick

`startFbSellerLoop(env)` is started from `server.ts` by A1 as a stub. Every 30 s, each pass reads the settings and does nothing outside active hours, except settling reports.

1. Settle `uncertain` seller tasks into the domain.
2. For each seller slot whose worker is HEALTHY, queue `inbox-sync` when the last one is older than `inbox_every_minutes` plus jitter.
3. Turn `queued` messages into `msg-send` tasks, oldest first, no more than one open per account, spaced by `send_gap_seconds` plus jitter, under `sends_per_account_day`. Agent-authored messages are `held` while the kill switch is on.
4. Turn `queued` placements into `ad-post` tasks, and `removing` placements and due renewals into `ad-delete`, spaced by `ad_action_gap_minutes` and under `max_live_ads_per_account`.
5. Raise the low-pool alert once per pool when a pool drops below `low_pool_warning`.

Tasks are written only through `enqueueSellerTask(tx, accountNo, kind, ref, payload, dueAt)` in `src/fleet/seller.ts` (A2). A1 stubs it.

### 5.4 Ingesting an inbox

For each `InboxThread`:

1. Upsert `fb_threads` by `(account_no, fb_thread_id)`.
2. **Align the window.** Find the longest match between the end of the stored conversation (`direction`, `body`, in `seq` order) and the start of the window.
3. Append everything after the match with new `seq` values.
4. If nothing matches and the thread has stored messages, append the window and add a `realigned` event.

Two identical messages in a row stay two messages, because alignment works on the sequence rather than on text. An appended `out` message that matches a `sending` or `uncertain` outbound by body becomes that message (`sent`). An `out` message matching nothing is stored with author `facebook`.

Each new `in` message:
- sets `unread`;
- creates a `created` event for a new thread and an `inbound` event;
- calls `enqueueAgentRun(tx, threadId, messageId)` (D1) when the thread is in `agent` mode, not `needs_human`, the account has `agent_on`, and the kill switch is off.

A `has_image` or `unknown` message still reaches the agent, whose rules hand it off.

## 6. Agent (D1, D2)

### 6.1 Types (`shared/fbSeller.ts`)

```ts
export type AgentInput = {
  thread: { id: number | null; stage: FbThreadStage; round: number; offer_usd: number | null; listing_title: string };
  messages: { seq: number; direction: 'in' | 'out' | 'unknown'; author: string; body: string; has_image: boolean }[];
  market: { canon: string; part_number: string; label: string; max_buy_unit: number | null; price_at: string | null }[];
  settings: FbSellerSettings['offer'];
  now: string;
};
export type AgentExtract = {
  items: { part_number: string | null; description: string; qty: number | null }[];
  seller_ask_usd: number | null;
  intent: 'offer_items' | 'question' | 'counter' | 'agree' | 'decline' | 'logistics' | 'bot_question' | 'hostile' | 'off_topic' | 'other';
  agreeing: boolean;
  confidence: number;                    // 0..1
};
export type AgentDecision = {
  outcome: 'send' | 'handoff' | 'noop' | 'blocked';
  extract: AgentExtract | null;
  skill: string | null;
  reply: string | null;                  // final text, placeholder filled
  offer: { offer_usd: number; ceiling_usd: number; round: number } | null;
  stage: FbThreadStage | null;
  rules_fired: { kind: string; reason: string }[];
  guard: { ok: boolean; failures: string[] };
  handoff_reason: string | null;         // in words, shown to managers
  usage: { model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[];
};
```

`market` is built by code from the extracted part numbers, using `canonPartNumberJs` and an exact match on the Market table. `max_buy_unit` is `maxBuyFor(last_price ?? avg_sell, target_margin)` (`src/lib/market.ts`). **`market` and `settings` never go into a prompt.**

### 6.2 Entry points

`src/services/fbAgent/index.ts` (D1):

```ts
export async function enqueueAgentRun(tx: SqlLike, threadId: number, triggerMessageId: number): Promise<void>;
// Pure decision: no DB writes, no sends. The LLM call goes through `llm`, so tests and replays can stub it.
export async function decide(input: AgentInput, profile: FbAgentProfile, llm: AgentLlm): Promise<AgentDecision>;
export function startFbAgentLoop(env: Env): void;   // A1 stubs it in server.ts
export type AgentLlm = (req: { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[];
  schema: Record<string, unknown> }) => Promise<{ json: Record<string, unknown>; usage: AgentDecision['usage'][number] }>;
```

**The loop:**
1. Claim queued runs with `SKIP LOCKED`, retaking runs stuck in `running` over 5 minutes, at most 3 attempts.
2. Build `AgentInput` from `loadThreadSnapshot` and store it on the run.
3. Load the account's `agent_profile_id`, or the `active` profile.
4. `decide`, then store the decision.
5. Apply it in one transaction:
   - `send`: `recordExtract`, `recordOffer`, `setStage`, then `queueOutbound`.
   - `handoff`: `flagHuman`.
   - `blocked`: `flagHuman` with the guard's failures, and count toward the circuit breaker.
6. If a `candidate` profile exists, also run `decide` with it and store a second run with `shadow = true`. A shadow run never writes to the thread.

Spend is capped by `agent.daily_spend_usd` across all runs. At the cap, runs hand off with the reason "The agent's daily budget is used up".

### 6.3 Profiles

```ts
export type FbAgentProfile = {
  id: number; name: string; version: number; state: 'draft' | 'candidate' | 'active' | 'retired';
  prompts: { system: string; extract: string; skills: Record<string, string> };
  skills: { kind: string; enabled: boolean; params: Record<string, unknown> }[];
  rules: { kind: string; enabled: boolean; params: Record<string, unknown> }[];   // run in this order
  models: { extract: string; reply: string };
  notes: string;
};
```

**Seeded v1 (`default`, `active`):**
- Prompts written by A1, in plain English, as Recycle Servers buying used server hardware.
- Skills `screen`, `negotiate`, `answer`, all enabled.
- Every rule kind in §6.5, enabled, with the parameters shown there.
- Models: both `openai/gpt-6-luna`, the ERP's current default. D1 confirms it supports structured outputs through `/api/ai/models`. If it doesn't, D1 reports to the orchestrator.

**Lifecycle (D2):**
- A version is editable only while `draft`.
- A draft can be promoted to `candidate` or straight to `active`.
- Promoting to `active` retires the previous active version, and promoting a new `candidate` returns the old one to `draft`. This happens in one transaction.
- Rolling back makes an earlier version `active` again.
- Each skill's and rule's `params` are validated against that module's schema from the registry before a version leaves `draft`.

### 6.4 Registries

`src/services/fbAgent/skills/<kind>.ts` and `src/services/fbAgent/rules/<kind>.ts`. Each module default-exports:

```ts
export type AgentRule = {
  kind: string; label: string; params: ParamSchema;            // ParamSchema: a small JSON-schema subset the UI renders
  check(ctx: RuleContext): { fire: false } | { fire: true; reason: string };
};
export type AgentSkill = {
  kind: string; label: string; params: ParamSchema;
  when(ctx: SkillContext): boolean;                            // which skill runs: first enabled one whose `when` is true
  reply(ctx: SkillContext, llm: AgentLlm): Promise<{ text: string; stage: FbThreadStage; wants_offer: boolean }>;
};
export type EvalExpectation = { handoff: boolean; reason_kind?: string; max_offer_usd?: number; must_not_contain?: string[] };
```

- `GET /api/fb-agent/registry` lists every rule and skill with its `label` and `params`, so the editor renders forms from it.
- Adding a rule or skill means adding one module and its test, plus one line in the registry index.

### 6.5 Rules shipped

| Kind | Fires when | Seeded parameters |
| --- | --- | --- |
| `closing` | `agreeing`, or the gap between ask and offer is within `gap_pct`, or the next offer would be the last round | `{ gap_pct: 10 }` |
| `no_market_match` | an extracted item has no exact Market match | |
| `price_stale` | a matched price is older than `offer.price_max_age_days`, or missing | |
| `logistics` | intent is `logistics`, or the text matches payment, shipping, pickup or address words | `{ words: [...] }` |
| `has_image` | the latest inbound message has an image | |
| `unknown_direction` | any message in the window has `direction = 'unknown'` | |
| `confidence_below` | `extract.confidence` is below `min` | `{ min: 0.6 }` |
| `intent` | intent is in `kinds` | `{ kinds: ['hostile','off_topic'] }` |
| `bot_question` | intent is `bot_question` | the `answer` skill first sends the honest line in §6.6, then the thread hands off |
| `keyword` | the latest inbound message matches a regex in `patterns` | `{ patterns: [] }` |

### 6.6 Guards (code, not configurable)

These run after the skill, and none of them can be changed by any profile:

1. The model never receives `market`, `settings`, ceiling, cost or margin. D1 tests the built prompt for those values.
2. **Offers come only from `src/lib/fbOffer.ts`:**
   - `ceiling = Σ max_buy_unit × qty`;
   - `offer = min(ceiling, round_to_dollar(ceiling × (opening_pct + step_pct × round) / 100))`;
   - no offer without a quantity and an exact match on every item.
3. The reply carries the offer only through `{{offer}}`, which code fills in. A reply containing any other money figure (`$`, `usd`, `dollars`, or a number next to `k`) is `blocked`.
4. The reply never accepts, confirms a deal, promises payment, or proposes pickup, shipping or a meeting. Any of those is `blocked`, with a phrase list in code and a second check by the extract model.
5. **Honesty.** Asked whether it's a bot, the reply is "I'm Recycle Servers' automated assistant. Let me get a person on our team to pick this up." It never claims to be a person.
6. The reply is at most 600 characters, on a single line or paragraph. The worker sends it as one message.
7. The kill switch, `agent_on`, `mode` and `needs_human` are re-checked inside `queueOutbound`'s transaction.
8. **Circuit breaker.** When `circuit_breaker_failures` consecutive `blocked` or send-`failed` results occur on one account, `agent_on` is set false and managers are alerted.

### 6.7 Profiles and evaluation routes, `/api/fb-agent` (D2, manager-only)

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/registry` | `{ rules: RegistryEntry[], skills: RegistryEntry[] }` (D1 provides the data) |
| GET | `/profiles` | every version, newest first |
| GET | `/profiles/:id` | `FbAgentProfile` |
| POST | `/profiles/:id/draft` | a new draft version copied from `:id` |
| PATCH | `/profiles/:id` | draft only |
| POST | `/profiles/:id/promote` | `{ to: 'candidate'\|'active' }` |
| POST | `/profiles/:id/retire` | |
| GET | `/shadow` | `profile_id`, `cursor`: shadow decisions beside the live ones for the same trigger |
| GET | `/cases` | |
| POST | `/cases` | `{ name, input, expected }` |
| PATCH | `/cases/:id` | |
| DELETE | `/cases/:id` | archives |
| POST | `/evals` | `{ profile_id }`, run against every non-archived case, in the background |
| GET | `/evals/:id` | per-case `AgentDecision`, pass or fail, and why |
| GET | `/evals/compare` | `a`, `b` (two eval run ids): a per-case diff |

`saveCaseFromThread(tx, threadId, name, expected)` is in `src/services/fbAgentEval.ts` (D2). C's `save-case` route calls it.

## 7. Shared types file

A1 writes `shared/fbSeller.ts` with every type named in this file, plus the DTOs for the §5.1 and §6.7 routes:
`FbSellerSummary`, `FbSettingsChange`, `FbSellerAccount`, `FbPhotoPool`, `FbPhoto`, `FbAdInput`, `FbAd`, `FbPlacement`, `FbThreadRow`, `FbThreadDetail`, `FbMessage`, `FbThreadEvent`, `FbThreadSnapshot`, `FbThreadStage`, `RegistryEntry`, `ParamSchema`.

It is exported from `shared/index.ts`. Fields are snake_case, as in `shared/fleet.ts`. A1 decides the exact DTO fields from this file's tables. After A1 merges, a DTO change is a contract change.

## 8. Frontend routes (E, stubbed by A1)

| Path | View |
| --- | --- |
| `#/leads/facebook` | Needs human |
| `#/leads/facebook/inbox` | Inbox |
| `#/leads/facebook/thread/:id` | Thread |
| `#/leads/facebook/ads` | Ads and placements |
| `#/leads/facebook/photos` | Photo pools |
| `#/leads/facebook/agent` | Profiles, shadow, evals |
| `#/leads/facebook/settings` | Settings and history |

- The nav id is `leadsFacebook`, under Leads, manager-only.
- The badge is `FbSellerSummary.needs_human`, polled every 60 s while the page is visible.
- An open thread polls every 15 s.
