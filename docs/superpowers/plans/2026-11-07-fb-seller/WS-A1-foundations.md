# WS-A1 — Foundations

One small PR that everything else builds on. Merge it as soon as CI is green.

## Owns

- `apps/backend/migrations/<next>_fb_seller.sql` (0232 at the time of writing; recheck) and `docs/DATABASE.md` sections for every new table and column.
- `packages/shared/src/fbSeller.ts`, its export from `packages/shared/src/index.ts`, and the `shared/fleet.ts` additions named in CONTRACTS §4.1–4.3 (kinds, `FLEET_SELLER_TASK_KINDS`, `FLEET_SELLER_MIN_WORKER_VERSION = '99.0.0'`, the `HandedTask` union, `SellerReport`, `InboxThread`, `SellerTaskPayload`).
- Mount points, once: `apps/backend/src/index.ts` (mount `/api/fb-seller` and `/api/fb-agent`), `src/server.ts` (start `startFbSellerLoop` and `startFbAgentLoop`), `src/routes/fleet.ts` (nothing new; the worker routes mount inside `fleet/claim.ts`'s `worker` app or a sibling A2 owns — leave a comment where A2 will mount `/seller`).
- Stub modules with the exact contract signatures, each throwing `not implemented` or returning the documented neutral value:
  - `src/routes/fbSeller.ts`, `src/routes/fbAgent.ts` (empty Hono apps with the manager guard and mirror refusal wired),
  - `src/services/fbConfig.ts` (`loadFbSellerSettings` really reads the seeded row — callers need it),
  - `src/services/fbThreads.ts`, `src/services/fbSellerReports.ts` (`applySellerReport` → `{ accepted: true }`), `src/lib/fbSellerAlert.ts`,
  - `src/services/fbAgent/index.ts` (`enqueueAgentRun` no-op, `decide` throws, `startFbAgentLoop` no-op), `src/services/fbAgentEval.ts`,
  - `src/fleet/seller.ts` (`enqueueSellerTask` throws).
- Frontend: `desktopNav.ts` entry `leadsFacebook` (manager only), `lib/route.ts` paths from CONTRACTS §8, `DesktopApp.tsx` view, and a stub page `pages/desktop/leads/fb/FbSellerPage.tsx` that renders the tab bar and "Coming soon" per tab. i18n keys for the nav label and tab names (prefix `fbs_`), English and Chinese.

## Do

1. Read CONTRACTS §3 and write the migration exactly; confirm `fleet_tasks_state_check` is the constraint's real name (`\d fleet_tasks` on a local DB) before dropping it.
2. Seed `fb_seller_settings` with CONTRACTS §2.1's defaults and `fb_agent_profiles` `default` v1 `active` with CONTRACTS §6.3/§6.5's skills, rules and parameters. Write the v1 prompts plainly: a polite buyer for Recycle Servers (Denver), asks for part numbers, quantities, condition and a photo; never names a price itself (the placeholder `{{offer}}` is the only way a number appears); never claims to be human.
3. Make sure nothing in search changes: the existing fleet suites must pass untouched. `handed()`/`taskRows` changes belong to A2, but the type union must compile against the current `claim.ts` (search tasks still carry city and item).
4. Version bump (minor) and `CHANGELOG.md` section: "Foundations for Facebook seller accounts (RS-565): tables, settings, the default agent profile; nothing visible yet beyond an empty Leads ▸ Facebook page for managers."

## Exit criteria

- [ ] `scripts/migrate.mjs` applies the migration on a fresh DB and on a copy with fleet rows (seed + a few `fleet_tasks`), and the test template builds.
- [ ] `pnpm typecheck`, backend and frontend suites pass with no fleet test edited.
- [ ] The seeded settings validate against the TS type (a unit test parses them).
- [ ] Leads ▸ Facebook shows for a manager, not for a purchaser.
- [ ] `docs/DATABASE.md` updated, *As of* line bumped.
- [ ] README Status row updated.
