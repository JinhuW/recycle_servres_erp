---
id: RS-311
title: Recognise Facebook walls mid-sweep with a decision model
type: story
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: judge-model-eval-trackers
pr: 771
version: facebook-tracker 0.13.0
related: [RS-286, RS-280]
---

## Ask

> Due to the Jav (Judgment / Discriminative / Decision Model) releasinb. Pls evaluate which is the best model for us to use in our facebook / reddit tracker here.
>
> ultrathink the best fit in our workflow and inetgrate with the facebook tracker computer use immedditately
>
> fine, let we pass this
>
> Seem jev good at computer use. maybe a good start for us?
>
> You may also use the openai decision model or Jav. Does not limit to the Jav

## Context

*Decision models* (TypeSafe Jev 1.14, OpenAI GPT-6 Luna Decisions, Cloudflare
Clef and others) share OpenRouter's Decisions API: text and optional screenshot
in, typed probabilities out, no prose. Jev costs $0.042 per million input
tokens with free output, about 0.15 s a call.

Where they fit in the trackers, evaluated against each LLM call site:

- **Reddit post judge** (`trackers/reddit/src/llm.ts`) and the **Facebook
  listing evaluation** (vendored `ai.py`) both need text back, the alert's
  summary, price and count phrase. A decision model cannot replace either; a
  pre-screen would save cents. No change.
- **Facebook browser automation** is a pure screen-state judgment and is where
  the fleet is blind today:
  - After a search navigation the monitor checks neither URL nor page text. A
    checkpoint, captcha or "You're Temporarily Blocked" wall looks exactly like
    an empty city (`search_empty`), the worker heartbeats HEALTHY and keeps
    searching the account's remaining cities. No challenge, no screenshot; the
    first sign is the daily `fleet-verify.py` run.
  - `detect_login_challenge` knows only `checkpoint` in the URL, reCAPTCHA
    iframes and "I'm not a robot". On 2026-10-17 `va-2` stopped on a captcha at
    `two_step_verification` and no challenge was filed (RS-286 left that out).

Plan: `docs/superpowers/plans/2026-10-19-facebook-wall-decision-model.md`.

## Acceptance criteria

- [ ] An empty search result whose URL carries no interstitial marker triggers one page-state classification (URL, title, body text, screenshot if the probe shows it helps). The `search_empty` event carries `page_state`, its probability and the model id.
- [ ] A wall verdict files one challenge with screenshot through `/v1/auth/escalate`, reports CHECKPOINT (checkpoint, blocked, disabled), CHALLENGE_CAPTCHA (captcha), CHALLENGE_2FA (two_factor) or SESSION_EXPIRED (login), stops the job's remaining cities, and keeps the worker off HEALTHY until the wall clears.
- [ ] A failed login the heuristics cannot name (the `va-2` case) is classified and escalated.
- [ ] A wall cleared by an operator in Watch is noticed within about 60 s by re-classifying the current page, without navigating; the worker reports HEALTHY and resumes. Re-login also clears it.
- [ ] Any classifier failure (no key, timeout, HTTP error, bad answer) leaves today's behaviour unchanged; it never raises.
- [ ] The model is `RS_PAGE_CHECK_MODEL` (env), defaulting to the probe's winner; empty disables the check. No new TOML key.
- [ ] All ten monitors run the new image.

## Out of scope

- Pre-screening Facebook listings with a decision model (phase 2, after a shadow run against `ai_eval` history).
- The Reddit tracker and the messenger item count.
- `box` element-finding for selector breakage; checks in poster and messenger (`raise_if_restricted`).
- Auto-resolving challenge records; the two or three Telegram pages one login wall sends today.
- `deploy.sh` recreating the regional monitors.

## Notes

- **Probe, 2026-10-19.** 27 Facebook page states as text (URL, title, visible
  text), two runs each, one `choice` question with ten labels, gate on the
  summed wall mass at 0.5. Every reachable model told walls from clear pages
  54/54. Exact label: `openai/gpt-6-luna-decisions` 52/54 (0 flips, 231 ms p50,
  $0.000039/call), `liquid/d1` 52/54 (0 flips, 217 ms, $0.000006),
  `typesafe/jev-1.14` 51/54 (1 flip, 206 ms, $0.000027), `cloudflare/clef`
  50/54, `microsoft/microsoft-decision-1` 50/54, `inception/mercury-decide`
  50/54, `cloudflare/clef-flash` 48/54; `perplexity/pplx-decider-v1.1-27b` has
  no endpoint. Every miss was `other`/`error` read as `results` (the Marketplace
  home grid, an empty body), never a wall. Default: `gpt-6-luna-decisions`, the
  vendor already paid for listings; switch with `RS_PAGE_CHECK_MODEL`.
- **Text only, no screenshot to the model.** The coordinator's screenshot dir
  on the VM holds no past challenge PNGs (`RS_SCREENSHOT_DIR` is unset and
  `/app/data/screenshots` was never written), so image input could not be
  probed against real walls; text alone gated 54/54. The challenge record still
  carries the viewport screenshot for the human.
- **Login and 2FA pages are not walls.** A search that lands on either raises
  `SessionExpiredError` and lets the next cycle's `login` run its credential and
  TOTP flow; only checkpoint, captcha, blocked and disabled park the worker and
  file a challenge. `detect_login_challenge` ignores those two kinds for the
  same reason: it would otherwise ticket every password login.
- **Not fixed here, found on the way:** `deploy.sh` recreates only `rs-monitor`
  (nine regional monitors keep their old image); `is_visible(timeout=…)` is
  ignored by Playwright 1.64 so every such "wait" is an instant snapshot; the
  messenger's send check may ack an unsent reply; challenge screenshots are
  written outside the coordinator's data volume.
