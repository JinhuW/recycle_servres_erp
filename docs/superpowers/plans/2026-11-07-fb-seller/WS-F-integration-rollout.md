# WS-F — Integration and rollout

## F.local (no Facebook)

1. `scripts/fake-seller-worker.ts`: claims nothing; given a worker token
   minted for a local test slot (see the `fleet-page-local-e2e` memory recipe
   for minting), it long-polls `next-task`, answers seller tasks with scripted
   results (a listing id, an inbox window that grows each sync, sends that
   land), and reports through the real report route.
2. Local stack: backend + frontend on your own ports, a seeded seller slot set
   to `role = 'seller'`, `agent_on`, and `FLEET_SELLER_MIN_WORKER_VERSION`
   satisfied by the fake worker's reported version (set it in the test env,
   not in the shared constant).
3. Walk with Playwright and screenshots: upload a photo pool → draft an ad →
   place it on two locations (photos never shared) → the fake worker posts →
   a seller message arrives → the agent screens → the seller gives a part
   number in the Market table → the agent offers → the seller counters close
   to the offer → hand-off "about to close" → Needs human shows it → a manager
   takes over and replies → the fake worker sends it → close as won.
4. Also: change `send_gap_seconds` and watch the next tick follow it; make a
   draft profile, promote to candidate, see shadow decisions, run an eval,
   compare, promote, roll back; flip the kill switch mid-conversation and see
   agent messages held.
5. Report to the owner with the screenshots (copy them to
   `~/archify-previews/` and link `http://10.10.100.225:8800/...`).

## F.live — each step needs the owner's yes, asked when reached

1. **Release `dev` to `main`** (merge commit). The fleet lives in prod; dev is
   a read-only mirror, so nothing seller-side can run from dev.
2. **Railway prod variable** `FB_SELLER_TELEGRAM_BOT_TOKEN` (optional; in-app
   alerts work without it) and the chat id in Settings.
3. **Tracker release** with `scripts/release.sh minor`; push the worker image;
   set `FLEET_SELLER_MIN_WORKER_VERSION` to that version in an ERP PR; post
   the image as a **staged** release (`staged: true`) so no running worker is
   replaced.
4. **The first seller account.** The owner picks one account (not a
   CloakBrowser pilot account). Set its slot to `seller`. Its worker must run
   the new image, which means one container recreate: **one Facebook login.**
   Do it only on the owner's explicit yes, the way the fleet-release memory
   notes describe.
5. **Inbox first.** Let `inbox-sync` run with `agent_on` false; compare what
   the ERP shows with the account's real inbox (the owner checks, or VNC
   read-only). Refresh B's fixtures from the real pages.
6. **One ad.** A manager drafts and places one Denver ad. Confirm it's live,
   the listing id is right, and remove → repost works.
7. **Test conversation** from the owner's own Facebook account: screening, an
   offer, injections, a bot question, a closing hand-off, a staff reply.
8. **Agent on** for that account. Watch a day. Then add accounts one at a
   time, each with the owner's yes (each is a login if its container must be
   recreated).

## Exit criteria

- [x] F.local walk passes with screenshots, reported to the owner.
- [ ] Each F.live step done with the owner's recorded yes, results written
      here, ticket RS-565 closed with `pr:` and `version:` filled.

## F.local outcome

v1.445.1, 2026-11-07. All fifteen steps passed on a private local database
with the backend and frontend on their own ports. Screenshots and a pass/fail
table are at `http://10.10.100.225:8800/rs565-f-local/index.html`.

- **Fake worker.** `apps/backend/scripts/fake-seller-worker.ts`, beside
  `fleet-fake-worker.mjs` so it imports the backend's sealing and types.
  `--seed` writes a host and made-up seller slots into a local
  `DATABASE_URL` and refuses any other database; the worker refuses a
  non-local ERP. It reports `FLEET_SELLER_MIN_WORKER_VERSION` by default
  (`--version` overrides it), so the shared constant stays `99.0.0` until
  F.live sets it. The inbox stays empty until an ad posts; a script message
  can wait for a gate file, which is how the kill switch was caught
  mid-conversation.
- **Model.** No OpenRouter key on this Mac, so outside production the agent
  now falls back to `services/fbAgent/stubLlm.ts`, a deterministic reader.
  It passes the seeded eval cases except the keyword case, which needs a
  pattern by design. The real-model transcript is still F.live's.
- **Fixed.** A handed-off thread's header chip said "Agent answering".
- **Seen, not changed.** Releasing the kill switch leaves held agent replies
  held (C's design). The backend process exits when Postgres goes away, and
  the walk resumed from the database after a restart with nothing lost.
  Photo thumbnails are blank locally because uploads go to the no-R2 stub.
