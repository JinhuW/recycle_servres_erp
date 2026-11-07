# WS-C — Seller backend

Settings, photo pools, ads and placements, threads and messages, the pacing
tick, report handling and alerts. CONTRACTS §2, §5 are the spec.

## Owns

- `src/routes/fbSeller.ts`, `src/services/fbConfig.ts`, `src/services/fbThreads.ts`, `src/services/fbAds.ts`, `src/services/fbPacing.ts` (the tick), `src/services/fbSellerReports.ts`, `src/lib/fbSellerAlert.ts`.
- Tests `apps/backend/tests/fb-seller-*.test.ts`.

## Do

1. **Settings** (`fbConfig.ts`): load, validate (CONTRACTS §2.1 bounds), save with version check and history. Validation errors name the field and say why in words.
2. **Photo pools**: multipart upload of many files at once through `r2.ts` with `getUploadLimits()`; `sha256` computed server-side; duplicates refused per file with the existing photo's pool and id; image size read for width/height where cheap. Delete only unused photos (R2 object too).
3. **Ads and placements**: CRUD, `place` with the random photo pick (CONTRACTS §5.1) in one transaction, `needs_photos` when short, renew (new placement, `renews_id`, new photos, old one → `removing`), remove, resolve.
4. **Threads**: list views, detail (messages, events, last 10 runs, Market matches for extracted part numbers), staff reply (`queueOutbound` as staff), take over, hand back, close, read, save-case (calls D2's `saveCaseFromThread`; stub-tolerant until D2 merges).
5. **Accounts**: list every fleet slot with role, `agent_on`, profile override, worker state, live ads, open threads, sends today; PATCH role / agent / profile. Switching a slot to `seller` cancels its open search tasks only if A2's rules wouldn't already skip them (they will — just don't create any).
6. **Report handling** (`applySellerReport`): CONTRACTS §5.4 for inbox (window alignment, outbound matching, agent enqueue), placements for ad-post/ad-delete, messages for msg-send, `wall` → alert. Idempotent.
7. **Tick** (`startFbSellerLoop`): CONTRACTS §5.3, every 30 s, single-instance safe (advisory lock or `SKIP LOCKED` — several backend instances may run).
8. **Alerts**: in-app via `notifyManagers` inside the tx; Telegram after commit when `FB_SELLER_TELEGRAM_BOT_TOKEN` and `alerts.telegram_chat_id` are set; add the env var to `src/env.ts` as optional. Reasons in words, never a status code.
9. **Dev mirror question**: `deploy/railway-sync/sync.sh` copies prod's whole DB to dev, so seller conversations (third-party personal data) would reach dev. Don't change the sync; write the options in your PR body (copy as is / truncate `fb_messages` bodies / exclude the tables) for the owner to choose.

## Exit criteria

- [x] Tests: settings validation, history, stale-version 409; a pacing change in the DB changes the next tick's behaviour with no restart.
- [x] Tests: random photo picks never repeat — including two placements racing for the last photos of a pool; duplicate upload refused with a reason; pool exhaustion → `needs_photos` + one alert; low-pool alert fires once.
- [x] Tests: window alignment — new messages appended, repeats kept, a sent outbound settled, an unmatched window realigned with an event; agent enqueued only under the right conditions.
- [x] Tests: take over stops agent sends (`queueOutbound` refuses), kill switch holds agent messages but not staff ones, mirror mode refuses writes.
- [x] Tests: the tick respects active hours, gaps, daily caps and the one-open-send-per-account rule.
- [x] Version bump, CHANGELOG, `docs/FEATURES.md` draft section (E completes it), README Status.

## Outcome

PR #1152, v1.438.0. Notes for the workstreams after C:

- `queueOutbound` throws `FbThreadRefusal` (exported from `fbThreads.ts`) with the reason in words; D1 can catch it by class.
- One `enqueueAgentRun` per thread per inbox sync, on the newest new `in`/`unknown` message.
- Kill switch, take-over, hand-off (`flagHuman`) and close move the agent's `queued` messages to `held`; nothing revives them.
- A failed `msg-send` calls `flagHuman` ("A reply could not be sent: …"); D1's circuit breaker can count `fb_messages.send_state = 'failed'` by account.
- `src/index.ts` gained one `isUploadPath` line for `/api/fb-seller/pools/:id/photos`.
- The dev-sync options are in the PR body; while the fleet runs on dev, `keep-fleet.sql` does not keep the `fb_*` seller tables.
