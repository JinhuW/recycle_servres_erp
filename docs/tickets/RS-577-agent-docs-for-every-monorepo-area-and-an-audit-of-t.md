---
id: RS-577
title: Agent docs for every monorepo area, and an audit of the existing ones
type: task
status: done
priority: P2
created: 2026-11-11
reporter: jinhu
branch: docs/agent-docs
pr:
version: n/a — docs only, no release
related: []
---

## Ask

> help me set up my momorepo claude code configurations. I meant the clayde.md file for all subprojects.

Clarified in the same conversation: the ERP monorepo only, not the sibling
repos; fill the gaps and audit the existing docs for stale facts, not a trim
or rewrite.

## Context

Each area keeps an `AGENTS.md` and a one-line `CLAUDE.md` that imports it, so
Claude Code loads the area's rules when it reads files there. Five areas had
the pair. Three did not: `apps/fleet-agent/` (which decides when a Facebook
worker's browser opens), `packages/shared/` (imported by both apps and
hand-copied into the fleet agent), and the ops folders `deploy/`, `backup/`
and `infra/`, whose doc `docs/agents/erp-ops.md` never loaded on its own. An
audit of the existing docs against `origin/dev` found stale or imprecise facts
in the root, backend, frontend, Facebook tracker, ops and session docs: the
two `/api/fleet` contracts were missing from the root map, the backend doc
described transition tables that two of three order types don't have, and
several bare filenames had become ambiguous.

## Acceptance criteria

- [x] `apps/fleet-agent/` and `packages/shared/` each have an `AGENTS.md` and a
      `CLAUDE.md` that is exactly `@AGENTS.md`.
- [x] `deploy/`, `backup/` and `infra/` each have a `CLAUDE.md` that is exactly
      `@../docs/agents/erp-ops.md`.
- [x] The root `AGENTS.md` map lists `apps/fleet-agent/`, links both new docs,
      names fleet-agent starts as logins, and its *Contracts* section carries
      the fleet-agent and fleet-worker contracts, including the Cloudflare
      Worker's part in them.
- [x] The root `CLAUDE.md` *Nested docs* bullet names every folder that has a
      `CLAUDE.md`.
- [x] Every audit finding listed in the plan for `apps/backend/AGENTS.md`,
      `apps/frontend/AGENTS.md`, `trackers/facebook/AGENTS.md`,
      `docs/agents/erp-ops.md` and `docs/agents/session-isolation.md` is
      corrected.
- [x] How the fleet agent image is pushed is written in one place,
      `docs/agents/erp-ops.md`, and the other docs point there.
- [x] Every relative Markdown link in the agent docs resolves, and every path
      the new docs name exists.
- [x] The diff holds Markdown only: no version bump, no `CHANGELOG.md` section.

## Out of scope

Code and config the audit surfaced, left for their own tickets:

- The root `pnpm dev` script also launches the fleet agent, which exits
  without its environment.
- Local compose runs Postgres 16 while prod and CI run 18.
- `.github/workflows/fleet-images.yml` opens with a "SUPERSEDED … OCIR" header
  that the registry runbook has since reversed, and passes a
  `FLEET_AGENT_VERSION` build-arg the Dockerfile never reads.
- `apps/fleet-agent/src/types.ts` and `packages/shared/src/fleet.ts` have
  drifted, and nothing checks them.
- The *As of* line in `docs/DATABASE.md`.
- The sibling repos (`home_page`, `ram4cash`, `auto_ram_scanner`).
- Trimming the long docs.
- Stale bits in files no task owned: `apps/fleet-agent/README.md` lists a
  `license_outage` hold that `src/types.ts` `Hold` lacks;
  `trackers/facebook/README.md` still cites `rs_coordinator/fleet.py` (the
  file is `rs_coordinator/rs_coordinator/fleet.py`); `session-isolation.md`'s
  idle-slot and prune paragraphs still say `origin/dev` where the script now
  uses `--base`.

## Notes

- `trackers/reddit/AGENTS.md` passed the audit and was left untouched.
- The ops folders import `docs/agents/erp-ops.md` instead of getting an
  `AGENTS.md` each, so there stays one ops doc.
- `docker-compose.yml` and `.github/workflows/` sit at the repo root, so no
  nested `CLAUDE.md` covers them. Path-scoped rules under `.claude/rules/`
  would; they were not used here.
- Markdown is exempt from the version gate (`version-check.yml` excludes
  `*.md`), hence no release.
