# WS-E — ERP pages

**Leads ▸ Facebook**, manager-only, English and Chinese. Build against the
CONTRACTS §5.1 / §6.7 routes and the `shared/fbSeller.ts` DTOs with a mock
layer until C, D1 and D2 merge; swap to the real API at rebase.

## Owns

- `apps/frontend/src/pages/desktop/leads/fb/*` (replace A1's stub), `apps/frontend/src/lib/fbSeller.ts` (API client + polling hooks), i18n keys prefixed `fbs_` in `lib/i18n.tsx` and `lib/i18n.zh.ts`.
- The Fleet worker page addition (seller role, agent toggle, profile choice) in `pages/desktop/fleet/` — one small component, mounted in one line.
- `fleetKind_*` labels for the four seller kinds; the Fleet Tasks tab rendering a task with no city/item.
- Frontend tests next to the code.

## Look and behaviour

Model it on **Leads ▸ Reddit** (icon tabs with counts and a line saying what
each tab is for) and `DesktopWebSubmissionThread.tsx` for the conversation.
Use the existing tokens, components and `lib/api.ts`; errors through
`handleFetchError` (the reason in words, never a status code).

- **Needs human** (default tab): closing deals first, then by waiting time; each row: seller, account, listing, the reason in words, current offer and ceiling, waiting since.
- **Inbox**: every open thread; stage chip, account (stranded when the account is gone or retired), last message, offer, unread dot; search; closed threads under a filter.
- **Thread**: the conversation with send state per outbound (queued, held, sending, sent, uncertain, failed) and author (seller, agent, staff); a side panel with what the agent extracted, Market matches with ceiling and price date, the offer ladder, rules that fired on the last runs, events; actions take over / hand back / reply box / close won or lost / save as test case. Polls every 15 s.
- **Ads**: list of ads (draft / ready / archived) and an editor with a live preview of how the post reads (title, price, description, photo count range, pool); place on accounts × locations with the refusals shown per pair; placements table with state, the photos each drew (thumbnails), listing id, posted / next renew, renew / remove / resolve.
- **Photos**: pools with used / unused counts and a low-pool warning; drag-and-drop bulk upload with per-file results (added / refused with why); a grid filterable by used / unused showing which placement used each.
- **Agent**: profile versions (state chips), a draft editor (system and skill prompts, skills on/off with params, rules in order with params — forms rendered from `/registry` param schemas, models via `ModelPicker`), promote / retire / roll back; Shadow (live vs candidate decisions side by side); Tests (cases list, run an eval, compare two runs).
- **Settings**: every field of `FbSellerSettings` grouped (kill switch at the top, visibly), with validation mirroring the backend; the change history below.
- Sidebar badge: `needs_human` count, polled every 60 s while visible.

Desktop only; the mobile shell is out of scope.

## Exit criteria

- [ ] All tabs work against the real API on a local stack with seeded data (C/D1/D2 merged) — screenshots of each tab in the PR.
- [x] Purchasers see neither the nav entry nor the routes (the view bounces).
- [x] Frontend tests for the API client, the settings form validation and the thread send-state rendering; `pnpm typecheck` green.
- [x] `docs/FEATURES.md` section "Leads ▸ Facebook" complete, citing the version.
- [x] Version bump, CHANGELOG, README Status.

## Outcome

v1.441.0. Notes for R and F:

- **Seller routes not yet against the real API.** C had not merged when this
  landed, so the `/api/fb-seller` tabs were built and screenshotted against
  `lib/fbSellerMock.ts`, an in-memory fake of every CONTRACTS §5.1 route. A dev
  build turns it on with `localStorage['erp.fbSeller.mock'] = '1'` (a "Mock
  data" chip shows in the page head); a production build never loads it.
  `/api/fb-agent` always reaches the backend (D1 and D2 merged first). The
  first exit criterion is left for a follow-up once C merges: screenshots from
  a seeded local stack, then delete the mock or keep it as a dev aid.
- The Agent tab uses D1's and D2's shared types. Only `ceiling_usd` on the
  thread list row is declared locally (`FbThreadListRow` in `lib/fbSeller.ts`)
  until C adds it to `FbThreadRow`.
- The settings form's bounds mirror §2.1 in `validateFbSettings`; the offer
  ladder mirrors §6.6 in `offerLadder` (rounds `0 … max_rounds-1`). If C's
  `fbConfig.ts` or D1's `fbOffer.ts` read either differently, the form and the
  thread's ladder have to follow.
- Outside the owned paths: one line in `components/Sidebar.tsx` (the
  needs-human badge), the seller card's mount in `fleet/FleetErpWorker.tsx`, the
  seller-row branch in `fleet/FleetTasksTab.tsx`, and a `fleetState_uncertain`
  label (A1 added the state; nothing labelled it).
- The Fleet worker card is not screenshotted: the local DB has no ERP fleet
  worker to open. It loads nothing and renders nothing on an ERP without the
  seller routes.
