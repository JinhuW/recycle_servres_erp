# Recycle Servers — monorepo

Recycle Servers LLC, a used-server and parts business in Denver, runs on this
repo. It holds two things:

- The **ERP**: purchasing, inventory, sales and finance (`apps/`, `packages/`).
- Two **listing monitors** that find it buying leads (`trackers/`).

[README.md](./README.md) covers what the ERP does. This file is the map and the
rules that hold everywhere. Each area keeps its own conventions in its own
`AGENTS.md`; read that file before working there.

## Map

| Path | What | Stack | Runs on | Versioned by | Agent doc |
| --- | --- | --- | --- | --- | --- |
| `apps/backend/` | ERP API | Hono, Node 24, Postgres 18, raw SQL | Railway `recycle-erp-experiment` → `backend` | root `package.json`, `v*` tags | [apps/backend/AGENTS.md](apps/backend/AGENTS.md) |
| `apps/frontend/` | ERP UI, desktop + mobile PWA | Vite, React | Cloudflare Workers `recycle-erp-prod` / `-dev` | root | [apps/frontend/AGENTS.md](apps/frontend/AGENTS.md) |
| `packages/shared/` | Types and helpers both apps import | TS source, no build step | — | root | — |
| `deploy/` `backup/` `infra/` | ERP ops: Worker deploy, prod→dev sync, uptime cron, R2 backup, Terraform | shell, Docker, Terraform | Railway crons, Cloudflare | root | [docs/agents/erp-ops.md](docs/agents/erp-ops.md) |
| `trackers/reddit/` | Reddit for-sale monitor: polls subreddits, LLM-judges posts, alerts Telegram | Hono, Node 24, Postgres; **standalone pnpm project** | Railway `reddits-tracker` (`api`, `worker`) + OCI worker fleet | its `package.json`, no tags | [trackers/reddit/AGENTS.md](trackers/reddit/AGENTS.md) |
| `trackers/facebook/` | Facebook Marketplace fleet: coordinator, console, poster, messenger, router | Python, FastAPI, Playwright | Homelab VM `10.10.10.73` (Compose) + Railway Postgres `facebook-tracker` | `VERSION`, its `CHANGELOG.md`, `facebook-tracker/v*` tags | [trackers/facebook/AGENTS.md](trackers/facebook/AGENTS.md) |

## Boundaries

- **The root pnpm workspace is `apps/*` and `packages/*` only.**
  `trackers/reddit/` has its own `pnpm-workspace.yaml` and lockfile, so run its
  commands from inside it (`cd trackers/reddit && pnpm test`). Root `pnpm`
  commands never reach it. `trackers/facebook/` is Python with venvs in its own
  folder.
- **Root CI is path-filtered to ERP paths.** No workflow tests the trackers, so
  run a tracker's own suite before pushing a change to it.
- **The ERP and the trackers share no code and no database.** They talk only
  over the HTTP contracts below.

## Contracts

The ERP proxies manager-only admin traffic to each tracker. Each row is one
contract, and both sides change together.

| ERP side | Tracker side | Backend env | Test |
| --- | --- | --- | --- |
| `/api/tracker/*` → `apps/backend/src/routes/tracker.ts` (allowlist: workers, rules, subreddits, matches, stats, prompt-stats, prompt-candidate, and the single setting `settings/llm_model`); UI `pages/desktop/DesktopTracker.tsx` + `lib/tracker.ts` | `trackers/reddit/src/api.ts`, Bearer `API_TOKEN` | `TRACKER_API_URL`, `TRACKER_API_TOKEN` | `apps/backend/tests/tracker-routes.test.ts` |
| `/api/coordinator/*` → `routes/coordinator.ts`, noVNC relay `src/vncBridge.ts`; UI `DesktopCoordinator.tsx`, `FleetAccounts.tsx`, `FleetWatch.tsx` + `lib/coordinator.ts` | rs_console, `trackers/facebook/rs_console/`, at `fbc-api.recycleservers.com`, Bearer `RS_CONSOLE_TOKEN` + Cloudflare Access | `COORDINATOR_API_URL`, `COORDINATOR_API_TOKEN`, `COORDINATOR_ACCESS_CLIENT_ID` / `_SECRET` | `apps/backend/tests/coordinator-routes.test.ts` |

Some changes touch both sides of a contract: a new or reshaped tracker endpoint
a page needs, or one the ERP allowlist proxies. Make those in one PR: the
tracker, the ERP route's allowlist, the frontend client, and the ticket. Each
side still deploys on its own, so ship the tracker side first and keep it
backward-compatible until the ERP release reaches `main`.

## Git workflow

- **Branches.** Branch off `origin/dev` and open the PR against `dev`. `dev` →
  `main` is the release: Railway production and the prod Worker track `main`.
  Feature PRs go to `dev`, never straight to `main`. `dev` is
  deletion-protected because `delete_branch_on_merge` is on, and merging a
  release would otherwise delete it
  ([debug note](docs/debug-notes/2026-10-16-auto-delete-head-branch-deleted-dev.md)).
- **Staging.** Stage by explicit path. A checkout routinely holds untracked
  operational files that must stay out of commits, such as `rollback/` SQL
  with prod ids, `.env` files and tracker tokens.
- **Merging.** Squash-merge feature PRs into `dev`. Use a **merge commit** when
  the commits themselves are the payload: an imported history, a dev → `main`
  release.
- **Sessions.** Each session gets its own branch and worktree through
  `scripts/new-session.sh`. Details are in
  [docs/agents/session-isolation.md](docs/agents/session-isolation.md).

## Versioning by path

- **ERP.** It uses the root `package.json`, `CHANGELOG.md` and `v*` tags (see
  *Workspace* and *Tickets* below). `version-check.yml` decides what counts as
  ERP code from a fixed path list. `trackers/` is not on it, and
  `scripts/changelog.sh` leaves tracker commits out of ERP release notes.
- **`trackers/facebook/`.** It uses `VERSION` and its own `CHANGELOG.md`.
  Releases are cut by `trackers/facebook/scripts/release.sh` and tagged
  `facebook-tracker/vX.Y.Z`. Its deploy refuses an unreleased tree.
- **`trackers/reddit/`.** It has no release process. OCI images are tagged with
  the commit SHA.
- **Tickets.** `docs/tickets/` (RS-nnn) covers the whole repo, trackers
  included.
- **Imported hashes.** The trackers were imported on 2026-10-16 with rewritten
  history. Commit hashes cited before then resolve only in the archived
  `JinhuW/reddits_tracker` and `JinhuW/facebook_tracker` repos.

## Workspace

- **pnpm only** — `packageManager` is pinned to `pnpm@11.0.9` and the lockfile
  is `pnpm-lock.yaml`.  Don't introduce `package-lock.json` or `yarn.lock`.
- Workspaces are declared in `pnpm-workspace.yaml`: `apps/*` and `packages/*`.
- **Every code push to `dev` bumps the root `package.json` version** (patch
  for fixes, minor for features). CI (`.github/workflows/version-check.yml`)
  fails the push if `apps/`, `packages/`, `deploy/`, `backup/`, `infra/`,
  `docker-compose.yml` or a root manifest (`package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`) changed
  since the latest `v*` tag without a bump, and auto-tags `v<version>` on
  green. Docs-only pushes, and pushes that only touch `trackers/`, are exempt.
- Common entry points from the repo root:
  - `pnpm dev` — runs backend (`:8787`) and frontend (`:5173`) in parallel.
  - `pnpm typecheck` / `pnpm build` — recursive across the workspace.
  - `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` — proxy to backend
    scripts.
  - `pnpm --filter recycle-erp-backend test` (vitest, integration) and
    `pnpm --filter recycle-erp-frontend test`.
- The `@recycle-erp/shared` package is imported as a workspace dep (`main:
  "./src/index.ts"`) — there's no build step.  Don't add one.

## Tickets, changelog & features

Three documents carry the project's memory.  `docs/tickets/` says what was
asked, `CHANGELOG.md` says when it shipped, `docs/FEATURES.md` says what the
system does today.  Read `docs/FEATURES.md` first when you don't know this
codebase.

1. **A change request becomes a ticket** in `docs/tickets/` —
   `scripts/ticket.sh new "<title>"`.  Changes here are planned before they're
   built, so the ticket is *drafted inside plan mode* and shown as part of the
   plan, then written as the first step of implementation.  The `## Ask` block is the
   requester's own words, **verbatim** — that field is the only thing in the
   file that can't be reconstructed from the code later.  The `ticket-workflow`
   skill in `.claude/skills/` covers the rest; `/ticket` is the manual path.
2. **The version bump that ships it adds a `## [X.Y.Z]` section to
   `CHANGELOG.md` in the same push.**  `version-check.yml` fails the push
   otherwise.  `scripts/changelog.sh draft` prints a starting point from the
   branch's commits; rewrite it into prose — what changed and why it mattered,
   not the commit subject again.
3. **If user-visible behaviour changed, edit `docs/FEATURES.md`** and cite the
   new version.  Nothing enforces this one, which is exactly why it needs
   saying: it is the document that rots first.
4. **Close the ticket** — `scripts/ticket.sh status RS-nnn done`, and fill its
   `pr:` and `version:` fields.  `version:` is the join back to the changelog.

Four things worth knowing:

- **A version collision renumbers the changelog header too.**  When another
  session takes the version you bumped to, the fix is a fresh bump *and* a
  renamed `## [X.Y.Z]` heading — the CI gate matches the header against
  `package.json` exactly.
- **`version-check.yml` runs on `dev` and `main`, but only `dev` creates
  tags.**  A hotfix pushed straight to `main` gets the same bump + changelog
  demand; the tag is created when the version reaches `dev`, because a tag
  minted on a `main` commit would make the back-port fail "tag exists on an
  unrelated commit".  `LAST_TAG` is the newest tag *reachable from HEAD*
  (`--merged HEAD`) — on `main`, which runs several releases behind, the global
  newest tag would fail every push including docs-only ones.
- **The `docs/FEATURES.md` check is a `::warning::`, never a failure.**  A
  release carrying `feat()` commits that doesn't touch it gets an annotation.
  Whether a change altered user-visible behaviour isn't machine-decidable, and
  a gate that produces false blocks gets cleared by touching the file for no
  reason.
- `scripts/changelog.sh backfill` rebuilds the whole file from the tag list and
  is idempotent.  It preserves hand-written sections verbatim, so running it
  is safe — but it is a repair tool, not part of the release flow.

## Fixed business rules

- **Commission payment types are exactly two**: Company pay and Self pay.
  Don't expose UI to add, remove, or rename them.  Backend enums and seed
  data assume the closed set.  See [the commission-rate design][5].

## Style

- Prefer editing existing files over adding new ones.  Match the
  surrounding style.
- Comments: only the `Why`, not the `What`.  Don't reference issue numbers,
  current task, or the PR — those rot.  See existing route files for the
  tone: terse, contextual, only present where a future reader would be
  surprised.
- Don't add fallbacks, error handlers, or feature flags for scenarios that
  can't happen.  Validate at boundaries; trust internal code.

## Pointers

- What the system does today, by area: `docs/FEATURES.md`.
- What was asked, and by whom: `docs/tickets/` (index in `INDEX.md`).
- What shipped when: `CHANGELOG.md` — one section per `v*` tag.
- Per-feature design docs: `docs/superpowers/specs/`.
- Implementation plans (in-flight and finished): `docs/superpowers/plans/`.
- ERP deploys, releases, Railway, Cloudflare Workers, Docker, Terraform:
  [docs/agents/erp-ops.md](docs/agents/erp-ops.md).
- Each tracker's manual: `trackers/reddit/README.md` and
  `trackers/facebook/README.md`, with their debug notes under each tracker's
  `docs/`.

[5]: docs/superpowers/specs/2026-05-17-per-order-commission-rate-design.md
