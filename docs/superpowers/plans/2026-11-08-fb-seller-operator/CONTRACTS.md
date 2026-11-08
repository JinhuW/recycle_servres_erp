# Contracts

Everything two workstreams share, in one place.

**State: draft.** The orchestrator freezes this file once spike S1 passes. S1
can change §5, and S2 can change §7. After the freeze, a change goes through
the orchestrator in one PR. Section numbers stay stable so PRs can cite them.

Path shorthand:

- `apps/backend/src/…` is written `src/…`;
- `packages/shared/src/…` is written `shared/…`;
- `apps/seller-operator/src/…` is written `op/…`.

RS-565's [CONTRACTS.md](../2026-11-07-fb-seller/CONTRACTS.md) still holds for
everything this file doesn't change: the seller task kinds, payloads, the
report route, lost leases, settings, threads and the agent. It is cited as
"RS-565 §n".

## 1. Words

| Word | Meaning |
| --- | --- |
| seller pool | pool accounts with `fb_pool_accounts.purpose = 'seller'` |
| seller host | a `fleet_hosts` row with `kind = 'seller'`; only it claims seller slots, and it claims nothing else |
| operator | `apps/seller-operator`, one process per seller host |
| browser | one container that runs one seller account's CloakBrowser, for weeks |
| identity | one worker id `<host_id>-<n>`, held by the operator, one per browser |
| skill | fixed TS code that drives a page with no model call |
| agent job | one browser-use run, started by the operator for one step it can't do with a skill |
| commit | pressing Send, Publish, Delete or the final Confirm; only skills do it |
| safe point | a moment in a skill or job where stopping leaves nothing half-committed |
| control | a manager holds a browser (`fleet_slots.control_by`); no task runs on it |
| hold | the system stopped a browser's tasks for a reason (`fleet_slots.hold_kind`) until a manager acts |
| run | one row in `fb_operator_runs`: a skill or an agent job, with its outcome and cost |
| tile | the browser's latest screenshot, refreshed on a timer |

## 2. Configuration

`fb_seller_settings` (RS-565 §2.1) gains an `operator` block, typed in
`shared/fbSeller.ts`. Every module reads it at least once per tick, per run or
per job, as RS-565 requires.

```ts
operator: {
  model: string | null;            // OpenRouter model id for browser-use; null = no agent jobs, failed skills go to a person
  daily_spend_usd: number;         // all agent jobs on all accounts, per calendar day in active_hours.tz
  max_agent_steps: number;         // per job
  max_parallel_jobs: number;       // across the host
  tile_every_seconds: number;      // screenshot refresh per browser
  control_reminder_minutes: number;// alert when a person has held a browser this long
}
```

Seeded defaults: `{ "model": null, "daily_spend_usd": 5, "max_agent_steps": 25,
"max_parallel_jobs": 2, "tile_every_seconds": 30, "control_reminder_minutes": 30 }`.

Bounds:

| Field | Allowed values |
| --- | --- |
| `daily_spend_usd` | 0 to 100 |
| `max_agent_steps` | 5 to 60 |
| `max_parallel_jobs` | 1 to 8 |
| `tile_every_seconds` | 10 to 600 |
| `control_reminder_minutes` | 5 to 480 |
| `model` | null or 1 to 120 characters matching `^[a-z0-9._/-]+$` |

A refused save answers RS-565 §2.1's 422 `bad_settings` with the field path,
and history works as in RS-565 §2.2. The agent's existing `daily_spend_usd` is
unchanged: it covers fbAgent runs only.

## 3. Schema

A writes one migration (0235 at the time of writing; re-check before merging)
and the matching `docs/DATABASE.md` sections. Every foreign key gets its index
in the same migration and an explicit `ON DELETE`.

```sql
ALTER TABLE fb_pool_accounts
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'search' CHECK (purpose IN ('search','seller')),
  ADD COLUMN seller_metro TEXT REFERENCES fleet_cities(slug) ON DELETE SET NULL,
  ADD COLUMN seller_location TEXT;          -- what the composer's location box takes, e.g. 'Denver, CO'
ALTER TABLE fb_pool_accounts ADD CONSTRAINT fb_pool_accounts_seller_fields
  CHECK (purpose = 'seller' OR (seller_metro IS NULL AND seller_location IS NULL));
CREATE INDEX fb_pool_accounts_seller_metro_idx ON fb_pool_accounts(seller_metro);

ALTER TABLE fleet_hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'search' CHECK (kind IN ('search','seller'));

ALTER TABLE fleet_slots
  ADD COLUMN control_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN control_since TIMESTAMPTZ,
  ADD COLUMN hold_kind TEXT CHECK (hold_kind IN
    ('login','checkpoint','wall','exit_moved','exit_shared','licence','crashed','step_cap','no_model')),
  ADD COLUMN hold_detail TEXT,
  ADD COLUMN hold_since TIMESTAMPTZ,
  ADD COLUMN tile_key TEXT,
  ADD COLUMN tile_at TIMESTAMPTZ;
ALTER TABLE fleet_slots ADD CONSTRAINT fleet_slots_control_pair CHECK ((control_by IS NULL) = (control_since IS NULL));
ALTER TABLE fleet_slots ADD CONSTRAINT fleet_slots_hold_pair CHECK ((hold_kind IS NULL) = (hold_since IS NULL));
CREATE INDEX fleet_slots_control_by_idx ON fleet_slots(control_by);

CREATE TABLE fb_operator_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_uid TEXT NOT NULL UNIQUE,              -- the operator's id for the run; a re-post is a no-op
  account_no INTEGER NOT NULL REFERENCES fb_pool_accounts(no) ON DELETE CASCADE,
  task_id BIGINT,                            -- no FK: tasks are purged (as fb_ad_placements.task_id)
  kind TEXT NOT NULL CHECK (kind IN ('ad-post','ad-delete','inbox-sync','msg-send','boot','repair')),
  path TEXT NOT NULL CHECK (path IN ('skill','agent','person')),
  name TEXT NOT NULL,                        -- the skill or the job's goal
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed','uncertain','wall','held','cap','refused')),
  detail TEXT,                               -- a reason in words
  steps INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  model TEXT,
  trace_key TEXT,                            -- R2 key of the JSON trace
  screenshot_keys TEXT[] NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX fb_operator_runs_account_idx ON fb_operator_runs(account_no, started_at DESC);
CREATE INDEX fb_operator_runs_task_idx ON fb_operator_runs(task_id);
CREATE INDEX fb_operator_runs_spend_idx ON fb_operator_runs(started_at) WHERE path = 'agent';
```

- `fleet_slots.role` (RS-565) stays. The seller pool sets it to `seller`
  whenever `purpose = 'seller'`, and A's code keeps the two in step.
- The prod→dev copy nulls nothing new except `fb_operator_runs.detail`. The
  trace and screenshot keys point at R2 objects that dev can't read anyway.

## 4. Operator ↔ ERP

The operator uses the existing host routes and worker routes. They are listed
here only where this plan changes them.

### 4.1 Host

- A seller host is added like any fleet host: a bearer token shown once, and
  `authoritative` false until a manager flips it.
- A sets `kind = 'seller'` on the host's add and edit routes.
- The operator uses the agent routes with the host token: `desired`, `tickets`,
  `stopped` and `report`, through `apps/fleet-agent/src/client.ts`'s shapes.
  `desired.count` is capped at the seller slots the host can run.

### 4.2 Claims

- `src/fleet/claim.ts` gains a host-kind clause beside `engineRuns` and
  `roleRuns`:
  - a seller host claims only slots whose account has `purpose = 'seller'`;
  - a search host never claims one.
- Every other claim rule still applies: cloak version, exhausted ports, epoch
  fencing, tickets.
- **A claim answer to a seller host carries no secrets the operator must not
  hold.** `account.password` and `account.totp_secret` are empty strings, and
  `shared/fleet.ts` documents it. Cookies and storage state still come in the
  answer. The operator injects them only into a profile volume it has just
  created, which is the account's first boot. Later starts reopen the volume
  and inject nothing.
- The operator keeps one identity per browser and renews each identity's lease
  with its own heartbeat.

### 4.3 Heartbeat and tasks

- `HeartbeatAnswer` gains:

  ```ts
  control: { by: string | null; since: string | null; hold: FbHoldKind | null; hold_detail: string | null };
  ```

  `by` is the manager's display name.
- `next-task` hands an identity nothing while its slot has `control_by` or
  `hold_kind` set. It answers as if the queue were empty.
- An operator that sees `control.by` or `control.hold` stops the browser's
  current skill or job at its next safe point.

### 4.4 Hold

`POST /api/fleet/worker/seller/hold` takes a worker bearer and
`{ kind: FbHoldKind, detail: string }`.

- It sets `hold_kind`, `hold_detail` and `hold_since`, and alerts in-app and on
  Telegram through RS-565's alert path. The alert text is a reason in words,
  with no status code.
- It is idempotent while the same kind is held.
- It never answers 401 or 409 over a stale epoch. The browser behind it is still
  real, so it answers 200 `{ accepted: false, detail }` instead, as RS-565 §4.4
  does.
- Only a manager clears a hold: Release (§6) clears both control and hold.

| kind | Raised when |
| --- | --- |
| `login` | the page asks for a login |
| `checkpoint` | Facebook shows a checkpoint or a "confirm you're human" page |
| `wall` | any other restriction page, from the ported wall patterns |
| `exit_moved` | the browser's measured exit differs from the slot's expected one |
| `exit_shared` | another seller slot measures the same exit IP |
| `licence` | the browser exited 74, or the licence recheck refused |
| `crashed` | the browser container exited for any other reason |
| `step_cap` | an agent job hit `max_agent_steps` or the spend cap during a write task |
| `no_model` | a skill failed and `operator.model` is null |

### 4.5 Reports, runs, tiles and launches

- **Seller reports**: `POST /api/fleet/worker/seller/report`, unchanged
  (RS-565 §4.4). The operator sends one per task, before `done`.
- **Runs**: `POST /api/fleet/worker/seller/run` takes `FbOperatorRunInput`, the
  §3 row minus `id`, at most 64 KB. It is idempotent on `run_uid`, and a stale
  epoch gives 200 `{ accepted: false }`. Before each agent job, the operator
  asks `GET /api/fleet/worker/seller/spend`, which answers
  `{ spent_usd, cap_usd }`.
- **Tiles**: `POST /api/fleet/worker/seller/tile` takes a multipart JPEG up to
  400 KB. It is stored at `fb-seller/tiles/<account_no>.jpg`, overwritten each
  time, and sets `tile_key` and `tile_at`. No run row is written per tile.
- **Launches**: every browser start posts RS-554's
  `POST /api/fleet/worker/profile-launch` before any Facebook page, and writes a
  `boot` run with `path = 'skill'`. Fingerprint mismatches keep RS-554's
  verdicts.
- **Screenshots**: step screenshots use RS-565's
  `POST /api/fleet/worker/seller/screenshot`.

### 4.6 VNC

For each browser, the operator dials `GET /api/fleet/worker/vnc` with that
identity's token, the way `trackers/facebook/rs_worker/vnc_relay.py` does. On
the `viewer` text frame, it opens TCP to the container's VNC port on the
private network and pipes bytes. The relay (`src/fleet/vnc.ts`) is unchanged.

## 5. Browser container (C ↔ B)

- **Image**: `ghcr.io/jinhuw/rs-seller-browser:<version>`, built from
  `apps/seller-operator/browser/`. It bakes CloakBrowser `155.0.8059.39.2` the
  way `push-fleet-images.sh` pins it. A tag is never re-pushed.
- **Env, from an env file the keeper writes with mode 0600 and deletes after
  start**:
  - `RS_SEED`, `RS_GPU`, `RS_TZ`, `RS_LOCALE`, `RS_SCREEN` (`WxH`) and
    `RS_WEBRTC_IP`;
  - `RS_UPSTREAM_PROXY` (`scheme://user:pass@host:port`);
  - `CLOAKBROWSER_LICENSE_KEY`.
- **Volumes**:
  - `rs-seller-profile-<account_no>` at `/profile`, used as `--user-data-dir`;
  - the shared host directory `/srv/rs-seller/uploads/<account_no>` at
    `/uploads`, read-only. The operator writes photos there and the browser
    uploads from the same path.
- **Network**: the docker network `rs-seller`, internal. Inside it, the
  container answers CDP on `9222` and VNC on `5900`, and publishes no host
  port.
  - Egress allows only the upstream proxy's `host:port`.
  - Chromium goes through a local no-auth forwarder to the upstream.
  - WebRTC announces `RS_WEBRTC_IP` only.
  - S1 settles how CDP and egress are wired, and S3 proves no leak.
- **Labels**: `rs.seller.account`, `rs.seller.worker` and `rs.seller.image`.
  The restart policy is `no`: the keeper decides every start.
- **Exit codes**: `0` stopped; `74` licence outage (as the fleet worker uses
  it); `70` bad configuration; anything else is `crashed`.
- **Health**: `GET http://<container>:9222/json/version` answers within 2 s.

## 6. Manager routes (A ↔ F), `/api/fb-seller`

All are manager-only through `managerSession`. A write on a mirror answers 409
`mirror`, and every refusal is `{ error, detail }` with a sentence.

| Route | Does |
| --- | --- |
| `GET /accounts` | `{ rows: FbSellerAccountRow[] }`: the seller pool |
| `POST /accounts/:no/purpose` `{ purpose }` | Moves an account in or out of the seller pool. Refused 409 `account_running` while a worker holds its slot, because moving it would need a restart, and a restart is a login |
| `PATCH /accounts/:no` `{ seller_metro?, seller_location?, note? }` | Edits the metro and the composer location |
| `GET /browsers` | `{ rows: FbBrowserTile[] }`: one per seller slot |
| `POST /browsers/:no/control` `{ action: 'take' \| 'release' }` | `take` sets `control_by` to the caller. `release` clears control and hold, and is refused 409 `held_by_other` when another manager holds it |
| `POST /browsers/:no/restart` | Queues one browser start for the operator; the UI says it is one boot. Refused 409 `browser_running` while the container is up |
| `GET /tiles/:no` | The tile image, streamed from R2 |
| `GET /runs?account=&cursor=` | `{ rows: FbOperatorRunRow[]; next: string \| null }`, newest first |

Placement rule (D8): `placeAd` refuses 422 `location_outside_metro` when a
placement's `location` isn't its account's `seller_location`. RS-565's Ads tab
offers each seller account's `seller_location`.

```ts
export type FbHoldKind = 'login'|'checkpoint'|'wall'|'exit_moved'|'exit_shared'|'licence'|'crashed'|'step_cap'|'no_model';
export type FbSellerAccountRow = {
  no: number; uid: string; batch: string; status: string;
  seller_metro: string | null; seller_location: string | null;
  exit_ip: string | null; exit_checked_at: string | null;   // from the latest proxy check
  engine: 'stock' | 'cloak' | null; profile_first_launched_at: string | null;
  live_ads: number; sends_today: number; last_inbox_at: string | null;
  hold_kind: FbHoldKind | null; hold_detail: string | null;
};
export type FbBrowserTile = {
  no: number; worker_id: string | null; host_id: string | null;
  state: 'running' | 'starting' | 'stopped' | 'held' | 'controlled';
  tile_at: string | null; current: { kind: string; name: string; started_at: string } | null;
  control_by: string | null; control_since: string | null;
  hold_kind: FbHoldKind | null; hold_detail: string | null; hold_since: string | null;
};
export type FbOperatorRunRow = Omit<FbOperatorRunInput, 'screenshot_keys'> & { id: number; screenshots: number };
```

## 7. Agent job (B ↔ E)

The operator runs `seller-agent run --cdp <ws-url> --job <path>` from
`apps/seller-operator/agent-py/`, one process per job. The process writes
`AgentJobResult` as JSON on stdout. Logs go to stderr and may hold no secrets.

```ts
export type AgentJob = {
  job_id: string;                   // becomes the run's run_uid
  account_no: number; task_id: number | null;
  goal: 'prepare-ad-composer' | 'open-thread' | 'open-listing' | 'reach-page';
  instructions: string;             // written by code from a template; never seller text
  payload: Record<string, string>;  // the only text it may type, by key
  photos: string[];                 // paths under /uploads it may attach
  allowed_hosts: string[];          // facebook.com, www.facebook.com, *.fbcdn.net
  max_steps: number; budget_usd: number; model: string;
  done_check: string;               // what a finished page looks like, in words; code verifies after
};
export type AgentJobResult = {
  job_id: string;
  outcome: 'ready' | 'failed' | 'cap' | 'wall' | 'refused';
  detail: string;                   // in words
  steps: number; tokens_in: number; tokens_out: number; cost_usd: number;
  trace: { n: number; action: string; target: string | null; refused: string | null; url: string; screenshot: string | null }[];
};
```

Tools: the sidecar removes browser-use's default click and type actions and
offers only these.

| Tool | Does |
| --- | --- |
| `safe_click(index)` | Refuses an element whose accessible name or text matches, case-insensitive, `send`, `publish`, `post`, `delete`, `remove`, `confirm`, `submit` or `mark as sold`, or the localised equivalents in the guard list |
| `fill_field(index, key)` | Types `payload[key]` and nothing else |
| `attach(index, path)` | Attaches a path from `photos` |
| `scroll`, `wait`, `go_back` | — |
| `navigate(url)` | Allowed only within `allowed_hosts`, never `/settings`, `/security`, `/login`, `/checkpoint` or a payments path |
| `done(summary)` | Ends the job |

The sidecar offers no JavaScript evaluation and no file read.

- A refused action is recorded in `trace[].refused`. After 3 refusals the job
  ends with outcome `refused`.
- A wall pattern on the page ends the job with outcome `wall`.
- `budget_usd` is the smaller of the job's share and the spend left today. The
  sidecar stops at it with outcome `cap`.
- The operator never trusts `ready`. It runs the task's skill again, and the
  skill checks the page itself (§8) before any commit.

## 8. Skills (B ↔ D), `op/skills/`

```ts
export type SkillContext = {
  page: import('playwright-core').Page;
  accountNo: number;
  task: HandedSellerTask;                       // RS-565 §4.2 seller variant
  signal: AbortSignal;                          // aborted by control or hold
  safePoint(): Promise<void>;                   // throws Held when control or hold is set
  shot(step: string): Promise<string | null>;   // uploads a step screenshot, returns its key
};
export type SkillResult =
  | { outcome: 'ok'; data: SellerReport['data'] }
  | { outcome: 'failed' | 'uncertain' | 'wall'; detail: string }
  | { outcome: 'needs-agent'; goal: AgentJob['goal']; detail: string };  // the operator may run a job, then call the skill again once
```

- Skills port the Python seller tasks from the vendored monitor's
  `seller_tasks.py` (pin `9a7004e`): `inboxSync`, `msgSend`, `adDelete` and
  `adPost`. `adPost` checks the composer against the payload field by field,
  presses Publish once and finds the listing id.
- They also export `wallKind(page)` (`_wall_kind_from_url` plus the
  restriction patterns) and `unreadCount(page)`.
- `inboxSync` reads `unreadCount` first. When it is unchanged since the last
  sync and fewer than 30 minutes have passed, it reports the RS-565 window
  unchanged and opens no thread.
- Every RS-565 §4.6 rule applies. The fixtures are RS-565 WS-B's, until G.live
  refreshes them from real pages.
- A skill calls `safePoint()` before each navigation and before each commit,
  never between a commit and its check. A commit that can't be confirmed is
  `uncertain` and is never retried.

## 9. Frontend routes (F)

| Path | Shows |
| --- | --- |
| `/leads/facebook/accounts` | Accounts tab: the seller pool table, with metro and location editing |
| `/leads/facebook/browsers` | Browsers tab: the tile wall, refreshed on `tile_every_seconds` |
| `/leads/facebook/browsers/:no` | Live view: noVNC from `pages/desktop/fleet/watchAccount.tsx`, the server-side Take control and Release, the hold banner and the run log |

i18n keys are prefixed `fbs_`.

## 10. Invariants

1. Only skills commit, at most once per task. A commit that can't be confirmed
   is `uncertain` and RS-565 §4.5 settles it.
2. The operator never receives a password or TOTP secret, and never types one.
3. The keeper never restarts a running browser. An operator restart re-attaches
   by label.
4. No task runs while control or a hold is set.
5. Every browser start is a `boot` run and a launch record. After the first
   one, each start needs a manager's Restart.
6. Seller text never becomes an agent job's instructions or payload, and
   fbAgent never gets a browser tool.
7. No two seller slots share a measured exit IP.
