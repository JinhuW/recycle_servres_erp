# Facebook fleet: recognise walls mid-sweep with a decision model

_Model-agnostic: Jev, OpenAI GPT-6 Luna Decisions or another Decisions-API model. The probe in step 2 picked `openai/gpt-6-luna-decisions`; results in RS-311's Notes. Ticket: RS-311._
_Model-agnostic: Jev, OpenAI GPT-6 Luna Decisions or another Decisions-API model. The probe in step 2 picks the default._

## Context

**The model.** TypeSafe's **Jev 1.14** (`typesafe/jev-1.14`, listed Oct 14 2026) is a
*decision model* on OpenRouter's Decisions API (`POST https://openrouter.ai/api/alpha/decisions`).
- Input: a `state` (text, or text plus base64 PNG/JPEG parts) and typed questions:
  - `noul` returns P(yes).
  - `choice` returns one label, the probability of every label, and a confidence.
  - `score` returns a position on ordered levels.
  - `box` returns a bounding box (early feature).
- Output: probabilities only. No text, no rationale.
- Price: $0.042 per million input tokens; output is free. Median latency is about 0.15 s.
- Documented weak spots: numbers, dates, adversarial content.
- 21 decision models share the same API (GPT-6 Luna Decisions, Cloudflare Clef, Perplexity Decider, and others), so switching model means changing one id.

**Where each model fits.** These are the conclusions of the evaluation the user asked for:

| Call site | Today | Jev fit |
|---|---|---|
| Reddit post judge (`trackers/reddit/src/llm.ts`) | `llm_model` DB setting (fallback `gpt-4o-mini`). It returns is_target plus **summary and price** for the alert. | Replacement: no, because the alert needs text. A pre-screen saves only cents. **No change.** |
| FB listing evaluation (vendored `ai.py` `OpenAIBackend`) | `openai/gpt-5.6-luna`. It returns rating, **unit_count, count_phrase and summary**. | Replacement: no, because the alert needs text and Jev is weak at counting (`min_unit_count = 5`). A pre-screen is possible later, after a shadow run against the `ai_eval` history. **Phase 2.** |
| FB messenger item count (`rs_coordinator/ai.py`) | Extracts a quantity phrase. | No, because it's text extraction. |
| **FB browser automation ("computer use")** | URL substrings, iframe selectors and the `xs` cookie. | **Best fit.** The step is a pure screen-state judgment on text or a screenshot. |

**Why start there.** The fleet can't see a wall that appears after login.
- `facebook.py` (vendored, ~1788–1808) runs no URL or text check after a search navigation. A checkpoint, captcha or "Temporarily Blocked" page looks exactly like an empty city (`search_empty`).
- The worker heartbeats HEALTHY and keeps searching the account's remaining cities, which makes the flag worse.
- No challenge record and no screenshot are created. The only place it shows up is the daily `fleet-verify.py` run at 21:05 UTC.
- `detect_login_challenge` (facebook.py ~1019–1050) knows only `"checkpoint" in url`, reCAPTCHA iframes and "I'm not a robot". On 2026-10-17 va-2 stopped on a captcha at `two_step_verification` and no challenge was filed (left out of scope in RS-286).

A decision model that answers "what screen is this?" closes both gaps. It costs about $0.0001 a call and runs only when something already looks wrong.

## Implementation

1. **Set up.**
   - Rebase `houndshark` onto `origin/dev`, create the ticket, and fill it in.
   - Clone the main checkout's vendored repo into `trackers/facebook/ai-marketplace-monitor` on `recycle-patches` at the pin in `VENDOR.md`. Build `.venv-aimm` and `.venv-coordinator` as README → *Tests* describes.
   - Watch for overlap: other sessions patch the vendored repo too; re-check the pin before committing.

2. **Pick the model with a probe** (script in the scratchpad, not committed).
   - Build about 20–30 states with known answers:
     - challenge PNGs copied read-only from the coordinator's screenshot dir on `10.10.10.73`;
     - frames from healthy workers via `scripts/vnc-screenshot.py`;
     - text-only states using known Facebook wall wording.
   - Run each state against every candidate on the Decisions API that takes images: `typesafe/jev-1.14`, `openai/gpt-6-luna-decisions`, `cloudflare/clef` (and `clef-flash`), plus any other listed model that scores well on the first pass. Text-only and with the image, twice each to see run-to-run variance.
   - Pin the exact request and response shape against the live endpoint here. The code only needs the shared `choice` shape, so it stays model-agnostic.
   - Choose the model on accuracy first, then latency and price. Jev is not the presumed winner; GPT-6 Luna Decisions is the main rival and may read screenshots better. Decide whether to send the image, and set the threshold. Start it at 0.5, and raise it if `no_results` gets confused with a wall.
   - Post the results table in chat. Cost: cents.

3. **Vendored patch** (one commit on `recycle-patches`, source and tests together).
   - New `src/ai_marketplace_monitor/page_state.py`: `classify_page(page) -> PageVerdict | None`.
     - Uses `requests`, which is already a dependency, with `OPENROUTER_API_KEY` from env (every monitor already has it).
     - Runs only after the cheap checks pass: the URL carries none of `_INTERSTITIAL_URL_MARKERS` and the result set is empty. A redirect to `/checkpoint` is handled by the substring, not the model.
     - Sends URL, title and `inner_text("body")` capped at ~6k chars, plus the viewport screenshot if the probe shows it helps.
     - Asks one `choice` question with these labels: `results`, `no_results`, `checkpoint`, `captcha`, `two_factor`, `login`, `blocked`, `disabled`, `error`, `other`.
     - Gates on **summed mass**, not the top label: `wall = checkpoint+captcha+two_factor+login+blocked+disabled`, `clear = results+no_results`. A wall verdict needs `wall ≥ WALL_THRESHOLD`; the specific state is the argmax inside the wall group. With ten labels the top probability alone is too diluted to threshold.
     - `results` on a page our parser emptied means the grid selectors broke. It is logged as `page_state=results` so `fleet-verify` can tell a DOM change from a quiet city.
     - Keeps the labels, threshold and default model as named constants. The default model is the probe's winner, and switching later is an env-var change, not a code change.
     - Follows the best-effort contract of `rs_coordinator/ai.py`: any failure returns None.
   - `facebook.py`:
     - `detect_login_challenge`: when the heuristics return None, fall back to `classify_page`. `escalate_login_challenge` (screenshot, escalate, `report_state`, `_escalated_kind` dedupe) is reused unchanged, plus the kind→state mapping.
     - Empty-search branch: classify. On a wall, call `escalate_login_challenge`, set `self._wall`, and raise `SessionExpiredError`, which `monitor.search_item` already swallows, so the remaining cities stop. Add `page_state` to the `search_empty` event.
     - `search()` top and `report_search_heartbeat`: while `_wall` is set, skip the item and report the wall state instead of HEALTHY. This follows the `waiting_for_a_new_session` skip at ~1684–1708.
     - Idle loop: model it on `manual_login_ready` / `adopt_manual_login` (~1577–1610, called from `monitor.py` ~727–746). Every 60 s while walled, check the URL first, then re-classify the current page. Clear `_wall` when `clear` mass ≥ threshold. `login()` also clears it. The `xs` cookie stays valid through a checkpoint, so `is_logged_in()` alone cannot clear it; cost is about one call a minute per walled worker, cents a day.
     - Read new attributes with `getattr` defaults, because tests build the class with `object.__new__`.
   - Tests in `tests/test_page_state.py`:
     - request shape and response parsing;
     - failure returns None;
     - an empty search with a wall verdict escalates once and stops the cities;
     - `no_results` keeps searching;
     - None falls back to today's behaviour;
     - the idle re-check clears the wall.
   - Keep `test_single_unit_gate.py` and `test_ai_fail_closed.py` green.

4. **Repo side** (PR to `dev`, squash).
   - Add a row to the README "Upstream patches" table, and document `RS_PAGE_CHECK_MODEL` in README and `configs/secrets.env.example`.
   - Run `scripts/check-vendor.sh update`, which writes `VENDOR.md`.
   - Add a tracker `CHANGELOG.md` `[Unreleased]` entry.
   - Fill in the ticket.
   - These paths are tracker-only, so there's no ERP version bump.

5. **Release and deploy** (approving this plan is the go-ahead for prod).
   - Fetch the patch into the main checkout's vendored repo, so the pin resolves there.
   - Run `scripts/release.sh minor` (feature, following the 0.8–0.12 precedent) to get `facebook-tracker/v0.13.0`, then `scripts/deploy.sh`.
   - Deploy outside the 10:00 UTC sweep, which runs 6–9 h.
   - `deploy.sh` recreates only `rs-monitor`. Recreate the nine regional monitors (`-ne -denver -sc -mw -west -nyc -phl -va1 -va2`) with `--force-recreate` and check each container's version.
   - Close the ticket with `pr:` and `version:`.

## Verification

- Vendored suite: `.venv-aimm/bin/python -m pytest tests/ -q --ignore=tests/test_facebook.py`. Then `scripts/release.sh --dry-run minor`, which runs every gate and suite.
- The live probe from step 2 doubles as the quality check: the table of verdicts per state, per model, per run.
- After deploy:
  - Query OpenSearch `fb-tracker-*` for `search_empty` events from the next sweep. Each should carry a `page_state`.
  - Any wall should appear as an open challenge, with screenshot, on Monitors ▸ Facebook.
  - Compare the next day's `fleet-verify.py` empty-search counts with today's.

## Flagged for the user, not fixed here

- Regional monitors may be running stale images, because `deploy.sh` never recreates them.
- `is_visible(timeout=…)` is ignored by Playwright 1.64, so every "wait" there is an instant snapshot.
- Challenge screenshots are probably written outside the coordinator's data volume (`RS_SCREENSHOT_DIR` is unset).
- Messenger's send check may ack an unsent reply.
