---
id: RS-319
title: Pre-screen Facebook listings with a decision model before the LLM
type: task
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: feat/rs-317-listing-prescreen
pr: 780, 781
version: facebook-tracker 0.13.4
related: [RS-311, RS-316]
---

## Ask

> based on research, start the implementation

## Context

RS-316's shadow run over the 14 days to 2026-10-19: `typesafe/jev-1.14` at
P(reject) ≥ 0.99 would have saved 79.8% of the 11,099 billed LLM calls
($0.00006 and 170 ms each) and kept 98.9% of the listings the LLM scored 4+.
The one it drops ("2x8 sticks of samsung 3200 ddr4 laptop ram", scored 5) is
two modules, which the purchasing rules reject; the ones it is next-surest
about (a sealed 2x32 kit, an i7 bundle with one module, a whole R740xd) read
the same way. The rule as written (≥ 99% kept) was a no-go by one listing
that reads as an LLM false positive.

This ticket builds the gate RS-316 left as the follow-up and ships it in
shadow mode: every LLM-cache-miss listing is asked the same reject/maybe/buy
question with the production prompt, the verdict is logged beside the LLM's,
nothing is skipped. The live stream then reproduces the measurement with the
full description and `unit_count` on the record, and enforcement is a
one-variable flip on the VM rather than a release.

Where it sits: vendored `monitor.py` `_search_item`, before `evaluate_by_ai`,
only when `AIResponse.from_cache` misses (so a lingering listing with a cached
verdict costs nothing). The call follows `page_state.py`'s contract: any
failure returns None and the LLM runs as today.

Plan: `docs/superpowers/plans/2026-10-19-facebook-listing-prescreen.md`.

## Acceptance criteria

- [x] With `RS_PRESCREEN_MODEL` set, every LLM-cache-miss listing is asked one
      `choice` question (`reject` / `maybe` / `buy`, production prompt) and
      logs a `prescreen` event with choice, P(reject), model, cost and latency.
- [x] With `RS_PRESCREEN_ENFORCE` unset, nothing is skipped (shadow).
- [x] With `RS_PRESCREEN_ENFORCE=1`, a `reject` at or above
      `RS_PRESCREEN_THRESHOLD` (default 0.99) skips the LLM, logs
      `listing_skip reason=prescreen`, and is remembered so a lingering listing
      is not re-asked each sweep.
- [x] Any pre-screen failure leaves today's behaviour: the LLM runs.
- [x] `scripts/prescreen-shadow.py --live` prints the gate table from live
      `prescreen` events joined to `ai_eval`.
- [x] Deployed with shadow on, fleet-wide; the first sweep's `prescreen` events
      appear in OpenSearch with `prescreen_cached: false`.

## Out of scope

- Turning enforcement on. That is a separate yes, after `--live` over a week
  of events reproduces the shadow numbers.
- Caching `maybe` / `buy` verdicts (the LLM verdict that follows is cached);
  replacing or re-prompting the LLM.
- A per-item knob in `master.toml`: one fleet-wide env setting is enough.

## Notes

- Live request shape pinned on 2026-10-19 with the vendored `prescreen.py`
  and the production prompt: a 16-stick Samsung RDIMM lot came back `buy`
  at 1.0, a 2x8 Corsair gaming kit `reject` at 1.0, 160-210 ms and $0.000062
  each (`typesafe/jev-1.14-20261014`).
- Enforced rejects are cached under `CacheType.PRESCREEN` keyed by model and
  listing, storing the probabilities rather than the decision, so a changed
  threshold needs no cache flush. Shadow verdicts are not cached: the LLM
  verdict that follows is.
- 0.13.2 put the model default in `deploy/docker-compose.worker.yml`, but the
  homelab workers are the `docker-compose.homelab*.yml` files, which carry
  their own `environment:` and read `configs/secrets.env` through `env_file`;
  the default never reached them. 0.13.4 defaults the model in code (unset
  = `typesafe/jev-1.14`, empty = off), and `RS_PRESCREEN_ENFORCE=1` in the
  VM's `configs/secrets.env` plus a worker recreate is the enforce flip.
- The coordinator's funnel stage list is fixed (`db.py`, `schemas.py`), so
  an enforced skip is counted through `listing_skip reason=prescreen` and
  the sweep report, not a new stage.
- Deployed 2026-10-19 19:15 UTC as facebook-tracker 0.13.4 (0.13.3's tag was
  taken by RS-318 on another branch, so the release was re-cut). All ten
  workers and the coordinator verified on the tree; `rs-monitor` carries no
  `RS_PRESCREEN_*` env, so the code defaults apply. Within the first ten
  minutes OpenSearch held 42 `prescreen` events, all `prescreen_cached: false`,
  `enforce: false`, `skipped: false`, from eight workers, 230 ms median and
  $0.000064 each; `listing_skip reason=prescreen` was zero and no worker
  logged a pre-screen warning. Every uncached `ai_eval` after a worker's
  restart has a matching `prescreen` event; the only unmatched ones were
  homelab-1's last evaluations on 0.13.1 before its own restart.
  `scripts/prescreen-shadow.py --live --days 1` printed the gate table (38
  joined, all LLM 1-3, so the 4+ recall column is empty until the week's
  sweeps fill it). Enforcement stays off until `--live --days 7` is read.
