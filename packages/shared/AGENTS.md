# Shared package — `packages/shared/`

`@recycle-erp/shared`: the types and pure helpers the backend and the
frontend both import. The root [AGENTS.md](../../AGENTS.md) has the repo map
and workflow. Bare paths such as `fleet.ts` are under `packages/shared/src/`;
anything else is relative to the repo root.

## Shape

- **The source is the package.** `main`, `types` and `exports["."]` all point
  at `src/index.ts`. There is no build step and no runtime dependency; add
  neither. The backend image copies the source as it is.
- **One entry point.** Consumers import from `@recycle-erp/shared` only;
  there are no subpath exports. A new module is invisible until `index.ts`
  has its `export * from "./<name>.js";` line.
- **Relative imports end in `.js`**, inside the package too. The apps use
  extensionless imports, so fix them when moving code in or out.
- **Export names are unique across the package**, because `index.ts` is all
  `export *`. A name two modules both export is a compile error at the
  barrel, for every consumer.
- **It runs in the browser and in Node.** `tsconfig.json` has
  `lib: ["ES2022"]` and nothing else: no DOM, no `node:` imports, no
  `Buffer`, `process` or `crypto`. `fleet.ts` hashes with FNV-1a for that
  reason.

## Who must not import it

- **`apps/fleet-agent/`.** Its image builds from its own sources alone,
  without `packages/shared/`, so `apps/fleet-agent/src/types.ts` is a hand
  copy of the host shapes here.
- **Any backend file that a plain-`node` `.mjs` script loads**, directly or
  through another import (`lib/log.ts`, `lib/dbTarget.ts`, `lib/sealed.ts`,
  … under `apps/backend/src/`; the scripts are `apps/backend/scripts/*.mjs`).
  Node's type-stripping maps no extensions, and `index.ts` here imports
  `./<name>.js` files that exist only as `.ts`, so the import fails when the
  script starts. For `migrate.mjs` and `init-admin.mjs` that is container
  boot. A script run under tsx may import the package.

## Wire contracts

Most of this package is internal: both apps build from the same commit.
Three groups of shapes are read by code that deploys on its own, so a rename
or a removed field there breaks something already running. Add optional
fields; don't rename or drop one.

- The push half of `wechatMarket.ts` is the payload memtrade pushes (root
  AGENTS.md → *Contracts*). The ERP keeps accepting what the deployed
  memtrade sends.
- The host shapes in `fleet.ts` (`DesiredAnswer`, `ClaimTicketAnswer`,
  `FleetHostReport`, `FleetHostContainer`) are what deployed fleet agents
  parse and send. Change `apps/fleet-agent/src/types.ts` in the same PR;
  nothing checks that the two agree.
- The worker-protocol shapes in `fleet.ts` (`ClaimRequest`/`ClaimAnswer`,
  `HeartbeatRequest`/`HeartbeatAnswer`, `NextTaskAnswer`, `HandedTask`,
  `SellerReport`) are what the Facebook worker image sends and parses:
  `trackers/facebook/rs_worker/entry.py` the claim, the vendored monitor's
  fleet mode the rest.

## Tests

- There is no test runner here. `pnpm --filter @recycle-erp/shared typecheck`
  checks this package alone; a changed export breaks its consumers, so run
  `pnpm typecheck` from the root.
- Test a pure helper from `apps/frontend/src/lib/<name>.test.ts`: it needs no
  database. A backend test needs a reachable Postgres even for a pure
  function, because the suite's global setup provisions one for every run.
- A code change under `packages/shared/` runs `backend-tests.yml` (the root
  typecheck and every suite) and, on `dev` or `main`, redeploys the frontend
  Worker.

## Versioning

`packages/` is ERP code. A code change here needs the root `package.json`
bump and a `CHANGELOG.md` section (root AGENTS.md → *Workspace*). The `0.1.0`
in this package's own manifest means nothing; leave it.
