# Facebook fleet: a decision-model pre-screen in front of the listing LLM (RS-317)

## Context

RS-316 shadow-ran a pre-screen over 14 days of billed `ai_eval` verdicts (11,099 LLM calls, 793 a day). `typesafe/jev-1.14` at P(reject) ≥ 0.99 would have saved 79.8% of those calls for $0.00006 and 170 ms each, keeping 98.9% of the listings the LLM scored 4+. The one it drops ("2x8 sticks of samsung 3200 ddr4 laptop ram", scored 5) is two modules, which the purchasing rules reject; the next-surest drops (a sealed 2x32 kit, an i7 bundle with one module, a whole R740xd) read the same way. So the research says the gate is sound, the LLM's 4+ set is what is noisy, and the remaining risk is only measurable live.

This ticket builds the gate the RS-316 ticket named as the follow-up: `RS_PRESCREEN_MODEL`, `listing_skip reason=prescreen`. Everything under `trackers/facebook/`.

**Rollout decision baked into this plan:** the gate ships **on in shadow mode** across the fleet (every billed listing is asked, the verdict is logged beside the LLM's, nothing is skipped) and **enforcement off**. Flipping `RS_PRESCREEN_ENFORCE=1` is one env change on the VM, no release, and this plan asks for that yes separately once a week of live `prescreen` events reproduces the shadow numbers (the report script below reads them). Shadow costs about $0.05 a day. If you want enforcement on from this deploy, say so at approval and step 6 does it.

## Design

**Where the call goes.** In the vendored `monitor.py` `_search_item` (~line 256), right before `evaluate_by_ai`. The pre-screen runs only when the LLM cache misses (`AIResponse.from_cache(listing, item_config, marketplace_config) is None`, `ai.py:83`), so a lingering listing that already has a verdict costs nothing and logs nothing. The LLM then runs exactly as today unless the gate is enforced and the verdict is `reject` at or above the threshold.

**New vendored module `src/ai_marketplace_monitor/prescreen.py`**, modelled on `page_state.py` (same Decisions API, `requests`, `OPENROUTER_API_KEY`, best-effort: any failure returns None and the LLM runs as today):
- Constants: `ENV_MODEL = "RS_PRESCREEN_MODEL"` (empty/unset = off; the deployment choice lives in compose, below), `ENV_ENFORCE = "RS_PRESCREEN_ENFORCE"` (truthy `1/true/yes`, default off), `ENV_THRESHOLD = "RS_PRESCREEN_THRESHOLD"` (default `0.99`), `MAX_DESCRIPTION_CHARS = 2000` (what the shadow run measured: the `ai_eval` event's cap), `REQUEST_TIMEOUT_S = 20`.
- `CRITERIA` = the three labels from `scripts/prescreen-shadow.py:51` (`reject` / `maybe` / `buy`), verbatim, and the same question: instructions = production `prompt` (`item_config.prompt or marketplace_config.prompt`, the field `ai.py:get_prompt` reads) + the shadow script's trailer line. State = `{item, title, price, description[:2000]}`. Identical inputs to the shadow run, so its numbers transfer.
- `PrescreenSettings(model, enforce, threshold)` from `settings(env)`; None when off or no key.
- `PrescreenVerdict(choice, probabilities, model, cost, latency_ms, cached=False)` with `p_reject`, `rejects(threshold)` and `event_fields()` (`prescreen_choice`, `prescreen_p_reject`, `prescreen_model`, `prescreen_cost`, `prescreen_ms`, `prescreen_cached`).
- `parse_verdict(payload, model)` and `prescreen_listing(listing, item_config, marketplace_config, settings, logger)` → verdict or None.
- Cache for enforced rejects only: new `CacheType.PRESCREEN = "prescreen"` in `utils.py`; key `(CacheType.PRESCREEN.value, model, item_config.hash, marketplace_config.hash, listing.hash)`, value = probabilities (threshold applied on read, so changing the threshold needs no cache flush). Without it an enforced reject would be re-asked every sweep for as long as the listing lingers (80% of `ai_eval` events are cache hits today). Passes are not cached: the LLM verdict that follows is.

**`monitor.py`:**
- `MarketplaceMonitor.prescreen(listing, item_config, marketplace_config) -> PrescreenVerdict | None`: settings off → None; LLM cache hit → None; prescreen cache hit → cached verdict; else call, log one `prescreen` event (`listing_id, title, url, price, item, enforce, skipped` + `event_fields()`), cache when enforced and rejecting.
- `_search_item`: if the verdict rejects and enforcement is on → `[Skip]` line with `listing_skip reason=prescreen` (plus `score`-free fields: `prescreen_p_reject`, `prescreen_model`), `counter.increment(CounterItem.EXCLUDED_LISTING, …)`, `_count_stage(marketplace, "prescreened")`, `continue`. Otherwise fall through to `evaluate_by_ai` unchanged. Attributes read with `getattr` defaults since tests build the monitor with `object.__new__`.
- `page_state.py` stays untouched (its tests patch `page_state.requests.post`); the ~15 duplicated lines of HTTP are the price of not churning RS-311's module.

**Tests, vendored `tests/test_prescreen.py`** (patterns from `test_page_state.py` and `test_single_unit_gate.py`; fixtures from `conftest.py`):
- settings: unset model → None; no key → None; enforce parsing; threshold default and override.
- `parse_verdict` reads the Decisions answer; a garbled payload → None.
- request shape: model, three criteria, production prompt in the instructions, description capped.
- `_search_item` scenarios with `monitor_mod.prescreen.requests.post` faked and `evaluate_by_ai` recording calls: shadow mode asks and still calls the LLM (one `prescreen` event, `skipped=False`); enforced reject at 0.995 skips the LLM and logs `listing_skip reason=prescreen`; enforced reject at 0.98 under a 0.99 threshold goes through; `maybe`/`buy` go through; HTTP failure → LLM runs; LLM cache hit → no decision call; second sweep of an enforced reject is served from the prescreen cache (one `requests.post` total).
- Keep `test_single_unit_gate.py`, `test_ai_fail_closed.py`, `test_review_stats_reporting.py` green (they set no key, so the gate is off for them).

**Repo side:**
- `deploy/docker-compose.worker.yml` `environment:` beside `OPENROUTER_API_KEY`: `RS_PRESCREEN_MODEL: ${RS_PRESCREEN_MODEL:-typesafe/jev-1.14}`, `RS_PRESCREEN_ENFORCE: ${RS_PRESCREEN_ENFORCE:-0}`, `RS_PRESCREEN_THRESHOLD: ${RS_PRESCREEN_THRESHOLD:-0.99}`, with a comment on shadow vs enforce. (Workers run under compose, not fleetd: `deploy.sh` `fleet_mode` is false on the VM.)
- `configs/secrets.env.example`: the three variables, commented, after `RS_PAGE_CHECK_MODEL`.
- `scripts/sweep-report.py`: a `prescreen` row from `reason.get("prescreen", 0)` so the funnel shows enforced skips.
- `scripts/prescreen-shadow.py --live`: instead of re-asking a model, read the last `--days` of `prescreen` events (`kind.keyword: prescreen`, `prescreen_cached: false`) and join them to `ai_eval` by `listing_id`; feed the existing gate-table code the real `p_reject` and LLM score. This is the report the enforce decision reads.
- README: "Upstream patches" row; a paragraph under the wall-detection one explaining shadow vs enforce, the three variables, cost, and the `--live` report. `CHANGELOG.md` `[Unreleased]` Added entry. `docs/FEATURES.md`: one sentence after the RS-315 one.
- `scripts/check-vendor.sh update` after the vendored commit; fast-forward the main checkout's clone afterwards (memory note).

## Ticket (RS-317, type task, P2) — drafted, written on approval

```
title: Pre-screen Facebook listings with a decision model before the LLM
related: [RS-311, RS-316]

## Ask
> based on research, start the implementation

## Context
RS-316's shadow run: Jev 1.14 at P(reject) ≥ 0.99 saves 79.8% of billed LLM
calls and keeps 98.9% of the LLM's 4+ listings; the one it drops, and the ones
it is next-surest about, are listings the purchasing rules reject and the LLM
over-scored. The rule as written (≥ 99% kept) was a no-go by one listing that
reads as an LLM false positive. This ticket builds the gate the RS-316 ticket
left as the follow-up, ships it in shadow mode so the live stream reproduces
the measurement at full description length and with `unit_count` on the
record, and makes enforcement a one-variable flip.

## Acceptance criteria
- [ ] With RS_PRESCREEN_MODEL set, every LLM-cache-miss listing is asked one
      `choice` question (reject/maybe/buy, production prompt) and logs a
      `prescreen` event with choice, P(reject), model, cost and latency.
- [ ] With RS_PRESCREEN_ENFORCE unset, nothing is skipped (shadow).
- [ ] With RS_PRESCREEN_ENFORCE=1, a `reject` at or above RS_PRESCREEN_THRESHOLD
      (default 0.99) skips the LLM, logs `listing_skip reason=prescreen`, and is
      remembered so a lingering listing is not re-asked each sweep.
- [ ] Any pre-screen failure leaves today's behaviour: the LLM runs.
- [ ] `scripts/prescreen-shadow.py --live` prints the gate table from live
      `prescreen` events joined to `ai_eval`.
- [ ] Deployed with shadow on, fleet-wide; the first sweep's `prescreen` events
      appear in OpenSearch with `prescreen_cached: false`.

## Out of scope
- Turning enforcement on. Separate yes, after `--live` over a week of events.
- Caching `maybe`/`buy` verdicts; replacing or re-prompting the LLM.
- A per-item knob in master.toml (env is enough for one fleet-wide setting).

## Notes
Plan: docs/superpowers/plans/2026-10-19-facebook-listing-prescreen.md
```

## Steps

1. Rebase the worktree branch on `origin/dev` (`f2cf298c`); `scripts/ticket.sh new … --type task --priority P2` → RS-317 (confirm the number is free); copy this plan to `docs/superpowers/plans/2026-10-19-facebook-listing-prescreen.md`.
2. Vendored commit on `recycle-patches` (clone at pin `72bfc76`): `prescreen.py`, `utils.py` CacheType, `monitor.py`, `tests/test_prescreen.py`. Ruff with `--no-fix`, diffed against HEAD to see only new findings. Suite: `.venv-aimm/bin/python -m pytest tests -q --ignore=tests/test_facebook.py`.
3. Repo PR to `dev` (squash): compose, secrets example, sweep report, `--live` mode, README, CHANGELOG, FEATURES, `check-vendor.sh update`, ticket. Dry-run the full gate: `AIMM_PYTHON=$PWD/.venv-aimm/bin/python scripts/release.sh --dry-run patch`.
4. One live decision call from the laptop (the shadow script's `decide` with the production prompt, one listing) to pin the request shape before relying on it; cost under a cent.
5. Release `scripts/release.sh patch` → `facebook-tracker/v0.13.2` (additive: new env vars with safe defaults, nothing required to come up); `scripts/deploy.sh` outside the 10:00 UTC sweep (6–9 h long; today's started 10:00). Fast-forward the main checkout's vendored clone. Approving this plan is the go-ahead for that deploy, as with RS-311 and 0.13.1.
6. Enforcement stays off unless you say otherwise at approval. Close the ticket with `pr:` and `version:`.

## Verification

- Unit: the vendored suite plus `release.sh --dry-run patch` (all five package suites).
- After deploy, in a worker: `docker exec rs-monitor env | grep RS_PRESCREEN` shows the model and `ENFORCE=0`; the boot log has no pre-screen warnings.
- After the next sweep, OpenSearch (`ssh -L 19200:127.0.0.1:9200 jinhu@10.10.10.73`): `kind.keyword: prescreen` count ≈ the day's `ai_eval cached:false` count; `scripts/prescreen-shadow.py --live --days 1` prints a table; `listing_skip reason=prescreen` is zero.
- Then, a week in: `--live --days 7`. If 4+ recall at 0.99 holds at or above the shadow run's 98.9% and the dropped rows still read as rule-rejects, ask for the `RS_PRESCREEN_ENFORCE=1` flip.
