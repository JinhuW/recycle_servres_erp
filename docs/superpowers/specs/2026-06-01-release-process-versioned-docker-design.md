# Release Process & Versioned Docker Images — Design

**Date:** 2026-06-01
**Status:** Approved, Phase 1 in implementation

## Goal

Give the ERP a standardized, repeatable release process: a single SemVer
source of truth, an auto-generated changelog, version-tagged Docker images,
and a way to see which version is actually running. Phase 1 ships the local
tooling; a GHCR/CI push can be bolted on later (Phase 2) without reworking
the version scheme.

## Hard constraint — Phase 1 is non-breaking

The existing deploy flow must keep working untouched:

```
git pull && docker compose up -d --build
```

With `APP_VERSION` **unset**, Compose builds the images and tags them as
`recycle-erp-{backend,web}:latest`, then runs them — identical to today's
behavior. Versioned images are strictly **opt-in**: set `APP_VERSION=X.Y.Z`
(the release script does this) to build/run a tagged image. Nothing about the
current refresh-by-git-pull workflow changes.

## Versioning

- **Source of truth:** root `package.json` `version` (SemVer
  `MAJOR.MINOR.PATCH`). The two app `package.json`s are left as-is to avoid
  drift.
- The release script bumps it: `scripts/release.sh patch|minor|major`.

## Components

### 1. `scripts/release.sh <patch|minor|major>`

Runs on the deploy host or a dev machine. Does **not** push or deploy on its
own — it prints the next commands and leaves the operator in control.

1. **Pre-flight gate**
   - Must be on `main` and in sync with `origin/main`.
   - Refuses a dirty working tree unless `--allow-dirty` is passed (the user
     keeps WIP on `main`, so the escape hatch is required, but the default is
     safe).
   - Runs `pnpm typecheck` and `pnpm build` (hard gate).
   - Runs backend tests **if** Postgres is reachable on `127.0.0.1:5432`,
     otherwise warns and skips (the integration suite needs the DB and is
     known-flaky under harness lock contention).
2. **Bump** `version` in root `package.json`.
3. **Generate `CHANGELOG.md`** — collect `git log <last-tag>..HEAD` (or full
   history when no tag exists), group commit subjects by Conventional-Commit
   type into `### Features` / `### Fixes` / `### Refactors` / `### Other`, and
   prepend a `## [X.Y.Z] - YYYY-MM-DD` section. Fully automated; committed
   as-is.
4. **Commit** `chore(release): vX.Y.Z` (package.json + CHANGELOG.md).
5. **Tag** `vX.Y.Z`.
6. **Build images** via `docker compose build` with `APP_VERSION=X.Y.Z` and
   `GIT_SHA=<short-sha>` exported, producing
   `recycle-erp-{backend,web}:X.Y.Z`. Also re-tag `:latest`.
7. **Print next steps**: `git push && git push --tags`, then
   `APP_VERSION=X.Y.Z docker compose up -d`.

The build+tag logic is kept as a discrete step so a Phase-2 GitHub Action can
reuse it and append `docker push` to GHCR.

### 2. Dockerfiles

Both `apps/backend/Dockerfile` and `apps/frontend/Dockerfile` gain:

```dockerfile
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_SHA
```

Backend additionally promotes them to runtime env (`ENV APP_VERSION=...`,
`ENV GIT_SHA=...`) so the health route can read them. Defaults (`dev` /
`unknown`) keep a plain `docker build` working with no args.

### 3. `docker-compose.yml`

`backend` and `web` services each gain, alongside their existing `build:`
block:

```yaml
    image: recycle-erp-backend:${APP_VERSION:-latest}   # web -> recycle-erp-web
    build:
      context: .
      dockerfile: apps/backend/Dockerfile
      args:
        APP_VERSION: ${APP_VERSION:-dev}
        GIT_SHA: ${GIT_SHA:-unknown}
```

`${APP_VERSION:-latest}` on `image:` is what preserves the non-breaking
contract: unset → `:latest`, which `up -d --build` builds and runs as before.

### 4. Runtime version exposure

- **Backend** `/api/health` (`apps/backend/src/index.ts`) returns the existing
  `status` plus `version` (`process.env.APP_VERSION ?? 'dev'`) and `commit`
  (`process.env.GIT_SHA ?? 'unknown'`). Additive — existing consumers
  (Docker/Traefik probe) ignore the extra fields. Covered by a backend test.
- **Frontend footer**: a small shared helper fetches `/api/health` once and
  renders `v<version>` in an About/Settings corner. Reading from the backend
  (rather than a build-time constant) means the footer reflects what is
  actually deployed, needs no frontend build arg, and works across all three
  shells. Strings go through `useT()`.

## Out of scope (Phase 2)

- GitHub Actions workflow that builds on a `v*` tag and pushes to GHCR.
- Automatic deploy/rollback.
- Per-app independent versioning.

## Testing

- Backend: a test asserting `/api/health` includes `version`/`commit` from env.
- `release.sh`: validated by a dry run on the repo (bump math, changelog
  grouping, no push) before first real use.
- Frontend footer: validated by visiting it.
