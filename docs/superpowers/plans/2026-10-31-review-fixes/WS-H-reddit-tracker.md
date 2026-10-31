# WS-H — Reddit tracker fixes (plan)

Planned 2026-10-31 against `origin/dev` f0c1d856. Planning only; nothing here
has been built, deployed or run live.

## 1. Goal and scope

Close the 17 Reddit-tracker findings from lanes A9 and A9t of
`docs/review-2026-10-31/` (all P3 after verification). The tracker is a
standalone pnpm project with no release process: each ticket is one PR to
`dev`, versioned only by the monorepo SHA its OCI image is tagged with. Pushes
that touch only `trackers/` need no root `package.json` bump. No ticket touches
the ERP contract (`apps/backend/src/routes/tracker.ts` allowlist) or anything
Facebook, so **no ticket causes a Facebook login**. A tracker deploy restarts the
Reddit api/worker processes (Railway `railway up`, OCI `scripts/deploy-workers.sh`),
not the Facebook fleet.

Findings covered: A9-01, A9-02, A9-04, A9-05, A9-06, A9-07, A9-08, A9-09,
A9-10, A9t-01, A9t-02, A9t-03, A9t-04, A9t-05, A9t-06, A9t-07, A9t-08.
(A9-03 was rejected in verification; see *Dropped/deferred* for the one
constraint it puts on H1.)

Shared ground for every ticket:

- **Tests**: `cd trackers/reddit && docker compose up -d postgres && pnpm typecheck && pnpm test`.
  Root CI never runs this suite, so the PR description must paste the result
  (suite count was 281 tests at review time).
- **Ticket workflow**: `scripts/ticket.sh new` per ticket (`## Ask` = the review
  finding text, verbatim from `reddit-tracker-todo.md`). No root
  `CHANGELOG.md`/version bump (tracker-only push). `docs/FEATURES.md` only where
  noted.
- **Deploy batching**: the Reddit image is SHA-tagged, so H1–H5 should merge
  first and ship as **one** rollout (one `railway up` per service and one
  `deploy-workers.sh <sha>` over the OCI fleet) rather than one rollout per PR.
  This is not a login concern, but every OCI redeploy is a fleet-wide restart
  and today's restart path is exactly what H1 fixes, so H1 must be in the first
  image that ships.

## 2. Tickets

### H1 — Shutdown that doesn't wait out the pacer, plus loop-runner tests

| | |
|---|---|
| Findings | A9-01, A9t-04, A9t-01 |
| Severity | P3 (A9-01 raised as P2, verified P3: stale `workers` row + false "worker down" page, claims self-heal via TTL) |
| Versions under | reddit SHA |
| Restarts workers | Reddit api/worker only (no Facebook); rides the batched rollout |

**Change**

- `src/pacing.ts` `RedditPacer.acquire(signal?: AbortSignal): Promise<boolean>`:
  sleep through an abortable wait (race the injected `sleepFn` against
  `signal`'s `abort` event); return `false` without reserving the slot
  (`lastRequestAt` untouched) when aborted, `true` otherwise. Keep the existing
  signature-compatible default (no signal = old behaviour).
- `src/loops/runner.ts` `startLoop`: own an `AbortController`; pass
  `iteration(signal)` (type becomes `(signal: AbortSignal) => Promise<boolean>`;
  existing iterations ignore the arg). `stop()` sets `running = false`, calls
  `wake?.()` **and** `controller.abort()`.
- `src/heartbeat.ts` `LoopRegistry.wrap`: forward the signal
  (`(signal) => iteration(signal)`).
- `src/loops/poll.ts` `pollOnce(deps, signal?)`: `if (!await pacer.acquire(signal)) return false;`
  before `claimDueSubreddits` (poll.ts:36-38). Nothing after a successful
  acquire changes: the claim + one fetch (20 s timeout) still completes, and
  shutdown then releases it via `releaseAllClaims`.
- `src/loops/trace.ts` `Tracer.once(signal?)`: same check at trace.ts:86; on
  abort `releaseLease` and return false.
- `src/index.ts:245,290`: pass the signal through the wrapped iterations.
- `scripts/deploy-workers.sh:63`: `docker stop -t 35` → `-t 90`. After the
  fix the poll loop exits within one fetch (20 s), but an evaluate iteration
  can be mid-OpenRouter call (60 s timeout) and is not aborted; 90 s covers
  it. Say so in the comment at :60-62. Update README *Deploying* if it quotes 35.
- **Do not** add a Railway draining period/overlap as part of this fix: with
  the Railway worker's fixed `WORKER_ID`, a ≥40 s drain makes the rejected A9-03
  hazard real (old shutdown releasing the new process's claims). Add one line
  to `trackers/reddit/AGENTS.md` *Deploying* saying so.

**Tests**

- New `tests/runner.test.ts` (A9t-04): iteration throws once then returns
  true → called again, `logger.error` once; `busyMs` vs `idleMs` chosen by the
  return value (fake timers); `stop()` during an idle sleep resolves `stopped`
  within ~10 ms; `stop()` aborts the signal passed to a pending iteration.
- `tests/pacing.test.ts`: `acquire(signal)` resolves `false` promptly when
  aborted mid-wait and does not move `lastRequestAt`.
- `tests/poll.test.ts` (A9-01): pacer with a real gap (`maxRpm: 1`, real
  `sleep`); start `pollOnce` via `startLoop`, `stop()` mid-wait, assert
  `stopped` resolves fast and `SELECT count(*) FROM subreddits WHERE claimed_by IS NOT NULL` = 0.
  Port of `docs/review-2026-10-31/repro/A9-verify/a9-01-shutdown-waits-pacer.ts`.
- `tests/poll.test.ts` 'holds no claim while waiting on the pacer' (A9t-01):
  a pacer stub whose `acquire` runs the claimed-count query and asserts 0. Must
  fail under mutation M1 (`docs/review-2026-10-31/repro/A9t/mutate.py`); run
  that mutation once locally and note the result in the PR.

**Owner gates**: none for the code. Rollout is the batched deploy (gate G1).

**Rollout and verification**: ships in the batched rollout. Read-only check:
after `deploy-workers.sh`, `GET /api/workers?status=all` (via the ERP Monitors ▸
Reddit page) shows no rows with `started_at` before the deploy, and the ops
Telegram gets no "Reddit worker down" page in the following 15 min. Rollback:
`deploy-workers.sh <previous-sha>`; Railway redeploy of the previous upload.

**Effort**: M.

---

### H2 — Buyer-alert exactly-once guards

| | |
|---|---|
| Findings | A9-02, A9t-05, A9-05 |
| Severity | P3 (A9-02 is P2 if the owner finds a VM on console — gate G2) |
| Versions under | reddit SHA |
| Restarts workers | Reddit only; batched rollout |

**Change**

- **A9-02 console mode never consumes buyer targets.**
  - `src/loops/notify.ts:41-46`: when `deps.alerts.transport === 'console'`
    and `settings.telegramChatIds.length > 0`, return false before
    `claimPosts` and log once per process at `info` ("console transport with
    buyer chats configured: leaving targets to a telegram sender"). Console
    still prints targets in a fresh local DB (no chat ids), which is what it is
    for (`alerts.ts:1-3`).
  - `src/loops/evaluate.ts:129-141`: same rule for the candidate-only dev
    review (skip when console and dev chat ids are set), so a console worker
    does not burn the one-shot review.
  - `scripts/deploy-workers.sh:33`: `ALERT_TRANSPORT=${ALERT_TRANSPORT:?set telegram or console in secrets.env}`
    — no default. Also require `TELEGRAM_BOT_TOKEN` when it is `telegram`.
  - `scripts/secrets.env.example:17-19`: `ALERT_TRANSPORT=telegram`, with the
    comment saying console never claims buyer targets.
  - `README.md:378-380`: replace "sets console unless…" with the new rule.
    (Coordinate with WS-I C1-10, which edits the README's local-api line; the
    two edits are in different paragraphs.)
- **A9t-05 requeue only failed posts.**
  - `src/claims.ts:344-355` `requeuePost`: add `AND status = 'failed'`; return
    `{requeued: true} | {requeued: false, status: string | null}` (one extra
    `SELECT status` when the UPDATE matched nothing).
  - `src/api.ts:342-346`: 404 when no such post, 409 `{error: 'not failed', status}`
    otherwise. `README.md:263` already says "Retry a post that gave up"; add
    "(failed only; 409 otherwise)". The ERP does not proxy this route, so no
    contract change.
- **A9-05 claims renewed per post.**
  - `src/claims.ts`: new `renewPostClaim(sql, workerId, redditId): Promise<boolean>`
    — `UPDATE posts SET claimed_at = NOW() WHERE reddit_id = … AND claimed_by = … RETURNING 1`.
  - `src/loops/notify.ts:53` and `src/loops/evaluate.ts:54`: at the top of
    each post iteration after the first, `if (!await renewPostClaim(...)) { logger.info('claim lapsed; leaving post to its new holder', …); continue; }`.
    Also call it in `evaluate.ts` between the live and candidate
    `evaluatePost` calls (two 60 s calls). Notify's worst case per post (N chats
    × (20 s + 60 s retry_after + 20 s)) stays bounded by the per-post renew for
    up to 3 chats; note that in the code comment at `NOTIFY_BATCH_SIZE`.

**Tests**

- `tests/pipeline.test.ts` (A9-02): with `telegram_chat_ids=['buyer-chat']`, a
  console-transport `notifyOnce` returns false and the post stays `target`;
  with no chat ids it still prints and marks notified (existing test at :315
  keeps that case). Port of `docs/review-2026-10-31/repro/A9-verify/a9-02-console-marks-notified.test.ts`
  with the assertion inverted.
- `tests/requeue.test.ts` (A9t-05): copy
  `docs/review-2026-10-31/repro/A9t/requeue-notified.test.ts` into `tests/`
  (fix its import paths), now expected to pass. `tests/claims.test.ts`:
  requeue of `notified`, `rejected`, `duplicate` returns not-requeued and leaves
  status. `tests/api.test.ts`: requeue of a notified post → 409 with status,
  unknown id → 404, failed → 200 (existing case at :406-420).
- `tests/pipeline.test.ts` (A9-05): fake sender whose `send` advances the DB
  clock past the TTL for post 1 (set `claimed_at = NOW() - 301 s` for the rest
  of the batch from inside the fake), then a second worker claims; assert the
  first worker renews before post 2 and the second worker's claim returns none
  of the batch. Second case: claim stolen mid-batch → first worker skips that
  post, exactly one telegram call for it.

**Owner gates**

- **G2**: On every OCI VM (`/opt/reddits_tracker/.env`) and in
  `scripts/secrets.env`, is `ALERT_TRANSPORT=telegram`? (Value check, names
  only; the reviewer could not read it.) If any is `console`, that VM has been
  eating buyer targets whenever the api's user session was down, and A9-02 is
  P2: ship H2 first.

**Rollout and verification**: batched rollout. Read-only: in the week after,
every `notified` post has an `alert_messages` row (the verifier's
145/145 query, run read-only by the owner or via `GET /api/stats`), and
`POST /api/posts/<a notified id>/requeue` is not used to test live (it would be
a write). Rollback: previous SHA.

**Effort**: M.

---

### H3 — Telegram failures that page and self-explain

| | |
|---|---|
| Findings | A9-06, A9-07 |
| Severity | P3 |
| Versions under | reddit SHA |
| Restarts workers | Reddit only; batched rollout |

**Change**

- **A9-06 supergroup migration.**
  - `src/telegram.ts:142-151` `sendOne`: read `parameters.migrate_to_chat_id`
    from the 400 body; return `{ok: false, error, migratedTo: string}`; carry
    `migratedTo` into `SendReport.failed[]` entries.
  - `src/loops/notify.ts` and `src/review.ts`: when any failure has
    `migratedTo`, log at `error` "chat <old> was upgraded to a supergroup; its
    new id is <new>" (reaches the ops group through the digest and fails the
    loop iteration).
  - If gate G3 is yes: also, in one statement, replace the old id with the new
    one in `telegram_chat_ids` / `telegram_dev_chat_ids`
    (`UPDATE settings SET value = (SELECT jsonb_agg(CASE WHEN e = to_jsonb(old) THEN to_jsonb(new) ELSE e END) …) WHERE key IN (…) AND value ? old`),
    then resend once to the new id. New helper in `src/settings.ts`; it only
    ever swaps an id Telegram itself named.
  - `docs/debug-notes/telegram-supergroup-migration.md`: add a "Now handled"
    section citing the PR.
- **A9-07 api user-notify can page.**
  - `src/heartbeat.ts`: add `'user-notify'` as a **failure-only** loop name:
    `FAILURE_LOOP_NAMES = [...LOOP_NAMES, 'user-notify']`; `failures` keyed by
    that, `loops` (the `workers.loops` JSON the ERP reads,
    `DesktopTracker.tsx:500`) still keyed by `LOOP_NAMES` only. `wrap` accepts
    either; `recordSuccess` skips names outside `LOOP_NAMES`.
  - `src/index.ts:153-166`: wrap the api's user-notify iteration in
    `registry.wrap('user-notify', …)` and give it `logger.child('user-notify')`
    so its warns mark that loop troubled (`noteProblem` keys on the scope
    prefix). `watch.ts:85-91` already iterates `loop_failures` entries
    generically, so a "Reddit api: user-notify failing" page needs no watch
    change; check the title wording reads right.
  - `reads` stays unwrapped (receipts only, not alert delivery).

**Tests**

- `tests/telegram.test.ts`: a 400 with
  `{"description":"Bad Request: group chat was upgraded to a supergroup chat","parameters":{"migrate_to_chat_id":-1001234}}`
  yields `migratedTo: '-1001234'`.
- `tests/pipeline.test.ts`: notify with that response logs the error with the
  new id; with G3 yes, settings now hold the new id and a second send went to
  it exactly once.
- `tests/heartbeat.test.ts`: three failed `wrap('user-notify', …)` iterations
  → `failureSnapshot()['user-notify'].consecutiveFailures === 3`, and
  `snapshot()` has no `user-notify` key. `tests/watch.test.ts`: an api row
  with that failure pages once.

**Owner gates**

- **G3**: Should a worker rewrite `telegram_chat_ids` itself when Telegram
  reports the group's new id (yes = auto-heal; no = error log with the new id
  only, and a person edits the setting)?

**Rollout and verification**: batched rollout; the api must go out with it
(`railway up --service api`; the api's user-session handover is covered by
invariant 8, which this ticket does not touch). Read-only: the ERP Reddit page
lists the api row with unchanged `loops`, and `workers.loop_failures` on the
api row now has a `user-notify` key (owner read-only SQL or the next digest).
Rollback: previous SHA.

**Effort**: M.

---

### H4 — Security hardening: SSH ingress, worker DB role, token handling

| | |
|---|---|
| Findings | A9-08, A9-09, A9-10 |
| Severity | P3 |
| Versions under | reddit SHA (+ terraform apply by owner) |
| Restarts workers | Part 2 needs a worker redeploy with a new `DATABASE_URL`; rides the batched rollout or a later single `deploy-workers.sh` |

**Change**

- **A9-10** `src/api.ts:76-83`: compare with `crypto.timingSafeEqual` on
  SHA-256 digests of both strings (equal length by construction, no length
  leak).
- **A9-09** `scripts/deploy-workers.sh:57-58`: send the token on stdin —
  `printf '%s' "$GHCR_READ_TOKEN" | ssh … "sudo docker login ghcr.io -u '$GHCR_USERNAME' --password-stdin"`
  as its own ssh call, then the pull/stop/run call without the token. This is
  also WS-B's **B4-09** (same line, cross-lane duplicate): WS-H ships it; WS-B
  should list B4-09 as closed by H4.
- **A9-08 part 1 (SSH)**: `infra/terraform/variables.tf:16-20` — drop the
  `0.0.0.0/0` default (make `ssh_ingress_cidr` required, with a validation
  that rejects `0.0.0.0/0`); `terraform.tfvars.example:5` shows a `/32`
  placeholder; `infra/README.md` says to set the office/VPN egress CIDR.
- **A9-08 part 2 (least-privilege DB role)**:
  - Workers run `scripts/migrate.ts` on every boot (`Dockerfile:28`), so a
    restricted role first needs migrations off the workers:
    `Dockerfile` CMD runs migrate only when `ROLE=api` (the api is
    single-copy and already deployed first). Document "deploy the api before
    the workers when a migration ships" in AGENTS.md *Deploying*.
  - New `infra/sql/worker-role.sql` (checked in, no password): creates
    `reddit_worker` with `SELECT, INSERT, UPDATE` on `subreddits`, `posts`,
    `loop_leases`, `candidate_verdicts`, `alert_messages`, `prompt_versions`,
    `workers`; `DELETE` on `workers`, `loop_leases`; `INSERT` on
    `worker_errors`; `SELECT` on `settings`, `rules`, `telegram_state`,
    `schema_migrations`; sequence usage as needed. Derive the exact list by
    grepping `src/` for every table the worker role touches, and verify by
    running the suite's worker paths as that role (see Tests).
  - `scripts/secrets.env.example`: `DATABASE_URL` comment says use the
    `reddit_worker` role URL.

**Tests**

- `tests/api.test.ts`: existing auth cases unchanged; add wrong token of equal
  and different length → 401.
- `tests/roles.test.ts` (new): in the test DB, apply `infra/sql/worker-role.sql`
  with a test password, connect as that role, run `pollOnce`/`evaluateOnce`/
  `notifyOnce`/`heartbeatOnce`/`releaseAllClaims` once each against fixtures;
  any `permission denied` fails it. Also assert the role cannot `UPDATE settings`.
- `shellcheck scripts/deploy-workers.sh` clean, and
  `grep -n "GHCR_READ_TOKEN" scripts/deploy-workers.sh` shows it only in the
  `printf` and the `:?` guard.

**Owner gates**

- **G4a**: Exact action: set `ssh_ingress_cidr` in `infra/terraform/terraform.tfvars`
  to the office/VPN CIDR and run `terraform -chdir=infra/terraform plan` then
  `apply` (security-list change only; no instance replacement expected —
  confirm the plan says 0 to destroy).
- **G4b**: Exact action: run `infra/sql/worker-role.sql` against the Railway
  `reddits-tracker` Postgres with a new password, put the role's public-proxy
  URL in `scripts/secrets.env` as `DATABASE_URL`, then `deploy-workers.sh <sha>`.
  Railway's own `worker` service may keep the owner URL (private network) —
  yes/no: move it to the role too?

**Rollout and verification**: code parts ride the batched rollout. After G4a:
`ssh` to a worker from outside the CIDR times out; from inside works. After
G4b: ERP Reddit page shows every OCI worker live with fresh beats and no
`permission denied` lines in the next digest. Rollback for G4b: restore the
previous `DATABASE_URL` in `secrets.env` and rerun `deploy-workers.sh`;
for G4a: revert tfvars and apply.

**Effort**: M (code S; role script + test M).

---

### H5 — Pipeline test gaps and link-post bodies

| | |
|---|---|
| Findings | A9t-02, A9t-03, A9t-08 |
| Severity | P3 |
| Versions under | reddit SHA |
| Restarts workers | Only via the batched rollout (one code change: `htmlToText`) |

**Change**

- **A9t-08 code**: `src/reddit.ts:67-79` `htmlToText` returns `''` when there
  is no `<div class="md">` (today it falls back to the whole content, i.e.
  Reddit's "submitted by … [link] [comments]" footer). Comments
  (`reddit.ts:242`) keep the current fallback — check their markup has the md
  div first; if it does, apply the same rule.
- Everything else is tests (below).

**Tests**

- `tests/fixtures/new-listing.xml`: add one link post and one image post
  captured from a real feed (no live fetch needed if one is already under
  `tests/fixtures/` or the debug notes; otherwise a hand-built entry in Reddit's
  exact link-post markup). Update the 9-entry counts in `tests/reddit.test.ts`,
  `tests/poll.test.ts`.
- `tests/reddit.test.ts`: the link-post entry parses to `selftext === ''`.
  `tests/llm.test.ts`: `buildUserMessage` for it contains `(no body text)`.
- `tests/rules.test.ts:44-57,89-99`: replace the self-filtering assert with
  one through `liveConfig(settings, rules)`; `updated_at` assert becomes
  strictly greater (`toBeGreaterThan`, with a forced clock gap).
  `tests/dedup.test.ts:78-83`: retitle "a week later" to match 4 days, or make
  it 7.
- **A9t-02** `tests/claims.test.ts`: after `releasePostFailure`, `claimPosts(..., 'new')`
  returns `[]`; after `deferPost(…, 30)`, `claimPosts(..., 'target')` returns `[]`;
  after moving `next_retry_at` into the past, both return the row. Must fail
  under mutation M5. `tests/poll.test.ts`: a 403 poll, then a 200 poll →
  `pacer.waitMs()` equals only the request gap. Must fail under M4.
- **A9t-03** `tests/pipeline.test.ts` (candidate prompt trial): live TARGET,
  candidate TARGET, `telegram_dev_chat_ids=['dev-1']`; after `evaluateOnce` +
  `notifyOnce`, exactly one telegram call to `dev-1`, text includes "flagged by
  live and candidate". Must fail under M2.
- Run `docs/review-2026-10-31/repro/A9t/mutate.py` for M2/M4/M5 against the
  branch and paste the "killed" lines in the PR.

**Owner gates**

- **G5**: `htmlToText` returning `''` for link/image posts changes what the
  live prompt sees for those posts (now "(no body text)" instead of Reddit's
  footer). Ship it without a candidate trial (yes), or trial it first per
  `docs/prompt-evaluations/` (no)? Recommended: yes — it removes boilerplate,
  not author text, and `RESPONSE_SCHEMA_ID`/prompt hash are unchanged.

**Rollout and verification**: batched rollout. Read-only: in OpenSearch
`post_evaluated` events for link posts after the deploy, `selftext` is empty.
Rollback: previous SHA.

**Effort**: M.

---

### H6 — Close out the prompt-evaluation log

| | |
|---|---|
| Findings | A9t-06 |
| Severity | P3 |
| Versions under | docs only (no image, no deploy) |
| Restarts workers | No |

**Change**

- `trackers/reddit/docs/prompt-evaluations/2026-10-26-candidate-2-bulk-ram.md`:
  add `## Result` — promoted 2026-10-26 05:03 UTC (per RS-404), live version id
  N, retired version ids 66/68, model `openai/gpt-6-luna-pro`, rule 1
  ("Reddit Buyer") disabled, rollback recipe pointing at version 66. Correct
  the "known dedup gap, out of scope" line (~:100): RS-413 (v1.362.0) shipped
  cross-post dedup the same day.
- `2026-10-18-baseline.md:139-141`: "Superseded: candidate 1 was never
  promoted; the trial ended when candidate 2 was promoted on 2026-10-26."
- New `docs/prompt-evaluations/live-prompt.md`: the promoted prompt text
  verbatim and its version id, with a line saying prod `settings.eval_prompt`
  is authoritative and this file must be updated on every promote (add that as
  step 7b in README's trial steps, ~:312). The `0001_init.sql` seed stays as
  is (never edit an applied migration); the file notes that fresh/dev DBs
  judge with the original prompt until someone sets `eval_prompt`.
- `docs/tickets/RS-404-*.md:81`: link to the new Result section.

**Tests**: none (docs).

**Owner gates**

- **G6**: Exact action: read `GET /api/prompt-stats` and `GET /api/settings`
  on the prod tracker (read-only, needs `API_TOKEN`) or the ERP Monitors ▸
  Reddit ▸ prompt tab, and give the planner the live version id, the
  `eval_prompt` text and `llm_model`, and confirm `candidate_eval_prompt = ''`
  and rule 1 disabled. Without it the Result section can't name the version.

**Rollout and verification**: docs-only push; no deploy. Verify the ids in the
doc match the ERP prompt tab.

**Effort**: S.

## 3. Order

| # | Ticket | Why here |
|---|---|---|
| 1 | H2 if G2 finds a console VM, else H1 | A console VM is live buyer loss; otherwise H1 must be in the first image, since every rollout restarts the fleet through the path it fixes |
| 2 | H1 / H2 (whichever is left) | Both touch `deploy-workers.sh` (different lines); merge sequentially and rebase |
| 3 | H3 | Touches `notify.ts` after H2; rebase onto it |
| 4 | H5 | Tests touch `pipeline.test.ts`/`poll.test.ts` after H1–H3 |
| 5 | H4 | Code parts can merge any time; G4a/G4b are owner actions after the batched rollout |
| — | **Batched rollout (G1)** | After H1, H2, H3, H5 (and H4's code) are on `dev`: build `ghcr.io/jinhuw/reddits_tracker:<sha>`, `railway status` → `reddits-tracker`, `railway up --service api --detach`, then `--service worker`, then `scripts/deploy-workers.sh <sha>`; walk README *Verifying a deployment* |
| any | H6 | Docs only; independent; blocked on G6 |

**G1** (owner gate for the rollout): Exact action — approve one Reddit rollout
(Railway api, Railway worker, OCI fleet) of the SHA that carries H1–H5. The
owner runs it or authorizes the session to; the session must first confirm
`GHCR_READ_TOKEN` per `docs/debug-notes/ghcr-read-token-dead.md` with one curl.

Cross-workstream dependencies:

- **WS-B**: B4-09 is the same defect as A9-09; closed by H4 (WS-B should not
  plan it separately).
- **WS-I**: C1-10, C1-27, C1-28 edit `trackers/reddit/README.md`. H2 (README
  :263, :378-380) and H6 (:312) edit other paragraphs; whichever merges second
  rebases. C1-28's loop list should include `user-notify` as a paging loop
  after H3.
- **WS-C**: B4-05 (`.gitignore` for `secrets.env*` backups) touches the same
  `scripts/` folder as H2/H4 but no shared lines; no ordering.
- **WS-D**: A11-07 adds `trackers/reddit` to the dependency audit; that is the
  interim control for A9t-07 (deferred below).
- **WS-E**: A8-03 (ERP proxies rule create/edit/delete no UI calls) is on the
  ERP side of the Reddit contract; H1–H6 change no proxied route or shape, so
  no ordering either way.

## 4. Dropped / deferred

| Finding | Disposition | Reason |
|---|---|---|
| A9-04 | **Deferred** pending owner probe | Unverified: whether Reddit's multireddit Atom feed returns 403/404 for a batch containing one banned/private sub is unknown, and fixing it (bisect on failure) costs extra Reddit requests against a ~1 req/40 s/IP budget, against invariant 1. Note 404 already doesn't touch the IP pacer (`reddit.ts:204` → `error`, `poll.ts:60-63`). **Gate G7**: Exact action — from the office, one logged-out `curl -A '<UA>' https://www.reddit.com/r/homelabsales+<a-known-banned-sub>/new/.rss` and report status + whether entries came back. If it fails the whole batch, open a ticket: on a batch `error`/`blocked` with >1 sub, split the batch in half on the next two polls (bisect) and tag the culprit's `consecutive_errors` alone. |
| A9t-07 | **Deferred** to its own ticket after WS-D A11-07 | GramJS `telegram@2.26.22` is archived, but no advisory is known against it and it holds the owner's Telegram user session (invariant 8: a session used wrongly gets revoked). A swap to `teleproto` needs a careful live cutover of that session, which is out of proportion for a P3 with no exploit. Interim: WS-D A11-07's audit covers `trackers/reddit`. Revisit when an advisory lands or Telegram changes layer; the ticket then adapts `src/userSender.ts` and extends `tests/seen.test.ts`. |
| A9-03 | Not in this input (rejected in verification) | Recorded only for H1's constraint: no Railway drain ≥ 40 s while the Railway worker has a fixed `WORKER_ID`. |

## Owner gates summary

| Gate | Ticket | Kind |
|---|---|---|
| G1 | rollout | Approve one batched Reddit rollout (Railway api + worker, OCI fleet) |
| G2 | H2 | Confirm `ALERT_TRANSPORT=telegram` on every OCI VM + `secrets.env` |
| G3 | H3 | Yes/no: auto-rewrite `telegram_chat_ids` on supergroup migration |
| G4a | H4 | Set `ssh_ingress_cidr`, terraform plan/apply |
| G4b | H4 | Create `reddit_worker` role, swap worker `DATABASE_URL`, redeploy; yes/no for Railway worker |
| G5 | H5 | Yes/no: ship the `htmlToText` change without a candidate trial |
| G6 | H6 | Read prod prompt ids/text (read-only, needs `API_TOKEN`) |
| G7 | A9-04 (deferred) | One logged-out Reddit probe of a multireddit with a banned sub |
