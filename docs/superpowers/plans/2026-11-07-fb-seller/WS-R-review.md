# WS-R — Independent review

Starts when A2, B, C, D1, D2 and E have merged. A fresh agent that did not
build any of it reviews the merged diff against `CONTRACTS.md` only — not the
workstream files, not the PR bodies — so it reads what the code does, not what
it was meant to do.

## Look for

1. **Duplicates**: any path where a lost lease, a retried report, a second
   backend instance or a double click sends a message twice or posts an ad
   twice.
2. **Guard bypasses**: a profile setting, a rule order, a skill prompt, a
   seller message or a model reply that gets a number above ceiling, an
   acceptance, or a "I'm a person" into a sent message. Try the injection
   fixtures plus your own.
3. **Logins**: anything that could make a worker exit (a 401/409 on a worker
   route, an unhandled exception in seller dispatch that kills the process),
   restart a container, or touch a session.
4. **Search regressions**: anything that changes what a search worker is
   handed, how its minutes count, or what the fleet pages show for search
   tasks.
5. **Data**: cost/margin leaking to a non-manager; personal data in logs;
   R2 keys guessable for screenshots; photo reuse under a race.
6. **Config**: every limit really read from the DB per tick/run; nothing
   reading `ads.toml` or another file.

## Output

- A findings list ranked by severity, each with the failing scenario.
- One PR fixing the confirmed ones, with a test per fix; anything not fixed
  is listed in the README Status notes with why.

## Outcome

Reviewed `cf991fcb..origin/dev` (`apps`, `packages`, through v1.442.0) and
monitor commit `d788039`, against `CONTRACTS.md` only. Fixed in v1.442.1 with
monitor pin `2378351` (private mirror only). A second, separate review found
five more (14–18), fixed in the same PR with monitor pin `6dceddf`. Every fix
has a test: `fb-agent-loop`, `fb-agent-rules`, `fb-seller-tick`,
`fb-seller-inbox`, `fb-agent-profiles-lifecycle`, the frontend's
`fleetWorkerView.test.ts`, and the monitor's `test_seller_tasks.py`.

### Findings, most severe first (14–18, from the second review, ranked among themselves)

| # | Sev | Area | Failing scenario | Fixed |
| --- | --- | --- | --- | --- |
| 1 | High | Guard (§6.6.2–3) | The money check reads the draft with `{{offer}}` blanked out. With an offer of 208, a model reply `We can offer {{offer}}0` sends "$2080", `{{offer}}k` sends "$208k", `{{offer}} each` sends 208 per stick, `1{{offer}}` sends "1$208". All of these are above the ceiling. | Yes. `checkReply` refuses any digit, letter, `$` or unit word next to the placeholder, and a second placeholder. |
| 2 | High | Duplicate | A run whose model calls take over 5 minutes is retaken by `claimFbAgentRun` on another instance (or the next tick). Both runners reach the apply transaction and both `queueOutbound`, so the seller gets two replies. | Yes. The apply transaction locks the run and applies only if `state = 'running'` and `attempts` is still the claim's. |
| 3 | High | Duplicate (worker) | `looks_like_message` treats a row of digits as a timestamp. A reply "300" is sent, but `count_outbound` never rises, so it's reported `uncertain`. The next inbox sync doesn't show it, so the ERP fails it and hands off with "may not have reached the seller", a person re-sends, and the seller gets two. A seller's "250" also vanishes from the inbox. | Yes. A lone amount is a message. |
| 4 | Medium | Duplicate | A seller sends two messages that land in two inbox syncs while our first reply is still `sending`. The second run doesn't see that reply (it has no `seq`) and answers again: two replies, and the offer ladder climbs twice. | Yes. The claim skips a thread with an outbound `queued`, `sending` or `uncertain`. |
| 5 | Medium | Duplicate (worker) | A CR or tab in a body: Playwright types `\r` as Enter (two messages, neither matches, then uncertain, failed and re-sent) and `\t` as Tab (focus leaves the box). | Yes. Normalised before typing. |
| 6 | Medium | Duplicate (worker) | An exception after the Publish click, Delete confirm or Enter (for example "Target closed") falls to the catch-all as `failed`. The ERP reads `failed` as "known not done", so a manager retry posts or sends twice. §4.6 says uncertain. | Yes. `Context.submitted` is set before each submit; a later failure is `uncertain`. |
| 7 | Medium | Duplicate | The worker reports bubbles trimmed and without blank lines, but the ERP matched outbound text exactly. A staff reply with a blank line or trailing spaces never settles: uncertain, then failed, then a hand-off and a re-send. Alignment also mis-matched it and appended copies. | Yes. Alignment and the outbound match compare whitespace-collapsed text. |
| 8 | Medium | Guard (§6.5, §6.6.5) | The bot question queues the honest line and then calls `flagHuman`, which holds every queued agent reply, that one too. The tick also holds agent replies on `needs_human` threads. The honest line was never sent. | Yes. A hand-off and the tick leave the honest line queued; a take-over, a close, the kill switch or the agent turned off still hold it. |
| 9 | Medium | Guard (kill switch, take-over) | The holds touched only `queued` replies. A reply already turned into a `ready` msg-send task (the worker busy with an inbox sync) still went out after a take-over, a close, the kill switch or the agent turned off. | Yes. `holdAgentReplies` and the tick cancel the unleased task and hold the reply. A leased one runs out, since it may be typing. |
| 10 | Medium | Guard (§6.6.3) | Small bare prices passed: "How about 95?", "80 for both", "budget is 90", "ninety for the pair". | Yes. A price word before, or a clause end after, a 1–2 digit number, and tens in words, are blocked. Counts inside a sentence ("are all 8 the same") still pass. |
| 11 | Low | Worker | The summary log passed `kind` twice to `aimm_event`. Every seller task on a worker with a logger raised `TypeError` after its report, so `done` carried an error and the `finished` event was skipped. The loop caught it, so there was no exit. | Yes. |
| 12 | Low | Guard 8 | Failed agent sends (a report, or an uncertain one the inbox fails) never ran the circuit breaker, which counted them only when a later run was blocked. | Yes. Both paths call `checkCircuitBreaker`. |
| 13 | Low | Config | D2's `fbAgentProfiles.ts` validated against a local copy of §6.5. | Yes. It uses `agentRegistry()` from `fbAgent/registry.ts`, and the five parameterised rules now mark their parameter `required`, as the copy did. |
| 14 | High | Duplicate (worker) | `already_sent` checked only the newest bubble (WS-B step 6 says the newest *outbound* one). With page [in x, out "We can do 400", in "hmm"] and tail [in x], a staff retry of the uncertain message typed it again; an `unknown`-direction bubble of ours did the same. | Yes. It finds where the tail ends on the page and counts any later `out`/`unknown` bubble with the body. With no tail on the page, our newest bubble decides. |
| 15 | Medium | Guard (§4.6) | A selling restriction that shows after the photo upload broke the next `_fill`/`_select`, which raised `StepError`, and `run()` reported `failed` with no park. `ad_delete` had no wall check after opening the listing. The worker kept driving a restricted account, and a failed ad-post could be re-queued into the same wall. | Yes. `run()` checks for a wall (no navigation) before reporting `failed` or `uncertain` on any task that opened a page; `ad_delete` checks once the listing opens. |
| 16 | Medium | Data (§4.5) | `inbox_sync` with no thread link reported `ok` with zero threads, so a Facebook redesign read as "no conversations" forever and uncertain sends never settled. | Yes. No links and no empty-inbox notice is `failed` at `open-inbox`. |
| 17 | Low | Login (wall) | The blocked-text check matched conversation text, so a seller writing "I was temporarily blocked" parked the account. | Yes. On a conversation only a dialog or text outside the pane counts. |
| 18 | Low | Data | `FleetWorkerEvent.city`/`.item` were typed `string`, but seller task events carry null since migration 0232, and the worker history and city log used them unguarded. | Yes. Both are `string \| null`, and the history and city log take the null. |

### Not fixed, and why

- **The closing rule can be switched off by a profile.** It hands off before the
  last round (`offer.round >= max_rounds`, with round counted from the next
  offer) whenever it's enabled. Disabled, the last round goes out. That is the
  profile's choice by contract: §6.5 rules are configurable, while the offer
  ceiling (§6.6) is not and still holds.
- **401 on an expired worker token** at `/seller/report` and `/seller/screenshot`
  makes the worker exit, the same as every other worker route. The contract only
  rules out 401/409 over a stale epoch or a lost lease, which these routes never
  return. A worker heartbeats long before its token expires.
- **`done` after a report that never landed** (monitor finding). A placement whose
  ad-post task is `done` stays out of the tick's queue (`openTask` counts `done`),
  and a message stays `sending`, so nothing is posted or sent twice. They wait
  visibly for a manager. Worth a "report unsent" marker later.
- **A late `ok` after the inbox already failed a message** leaves it `failed`.
  That's the safe direction.
- **Screenshot keys** are `fb-seller/screenshots/<account>/<uuid>-<task>-<step>.png`
  (`uploadAttachment` prefixes a random UUID), not the contract's bare
  `<task>-<step>`. Kept: the random part is what makes them unguessable.
- **Speculative worker items, not fixed without a live page:** a lazy-loaded
  "Your listings" could make `ad-post` report an older listing id; a wide
  bubble with no "You sent" label reads as `unknown`. The empty-inbox wording
  (finding 16) is a guess at Facebook's text. F.live should check all three
  against a real page.

### Checked and clean

- **Search:** a non-seller slot never gets seller kinds, its budget gate and
  minutes are unchanged (`minutesTodaySql` and `fleet_minutes` drop only seller
  kinds), and the seller dispatch in `monitor.py` runs before the item lookup.
- **Logins:** the seller routes answer 200 `{accepted:false}` for a task they
  can't use and 422 for a bad body. The fence trigger and `releaseTasks` keep the
  account and turn writes uncertain. No path touches a session or a container.
- **Data:** every `/api/fb-seller` and `/api/fb-agent` route is behind
  `managerSession`. No message body or seller name is logged, and photos are
  drawn with `FOR UPDATE SKIP LOCKED` inside the placement transaction.
- **Config:** settings are read per tick, per run and per report, and nothing
  reads `ads.toml` or another file.
