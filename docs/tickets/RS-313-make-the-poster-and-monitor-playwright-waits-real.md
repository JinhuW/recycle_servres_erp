---
id: RS-313
title: Make the poster and monitor Playwright waits real
type: bug
status: done
priority: P2
created: 2026-10-19
reporter: jinhu
branch: fix/rs-313-playwright-waits
pr: 776
version: facebook-tracker 0.13.1
related: [RS-311]
---

## Ask

> create a plan to fix them:
>
> Found on the way, not fixed
>
> - is_visible(timeout=…) is ignored by Playwright 1.64, so every such "wait" in poster/messenger/monitor is an instant snapshot.
> - Messenger's send check (get_by_text(...).last) may ack an unsent reply.
> - Challenge screenshots write outside the coordinator's data volume (RS_SCREENSHOT_DIR unset): none from past checkpoints survived.
> - Phase 2 candidate: a decision-model pre-screen in front of the listing LLM, after a shadow run against ai_eval history.

## Context

Playwright's `Locator.is_visible(timeout=…)` ignores the argument: the option is
deprecated and the call is an instant snapshot. Both venvs and the worker image
run Playwright 1.64.0. Ten calls in `rs_poster` and the vendored monitor pass a
timeout as if it waited. Where the element appears only after a navigation or a
submit, the snapshot can miss it: the 2FA "Trust this device" button
(`rs_poster/rs_poster/session.py`, `session_cli.py`, vendored `facebook.py`
`trust_this_device`), the cookie banner, the Publish form's Next button and the
locked-account text on a checkpoint URL (a miss reports a locked account as a
plain checkpoint). Every call sits in a `try/except Exception` that treats a
failure as "not visible", so a real `wait_for` timeout is handled the same way.

Plan: `docs/superpowers/plans/2026-10-19-rs311-follow-ups.md`.

## Acceptance criteria

- [x] Every `is_visible(timeout=…)` in `rs_poster`, `rs_messenger` and the vendored monitor either waits for real (`wait_for(state="visible", timeout=…)`) where the element is expected to appear, or drops the argument where a snapshot is what was meant.
- [x] A test in each package fails if `is_visible(timeout`, `is_hidden(timeout`, `is_enabled(timeout` or `is_checked(timeout` reappears in the sources.
- [x] The existing test doubles that stub `is_visible` raise Playwright's `TimeoutError` from `wait_for` when not visible, and every suite stays green.
- [x] `detect_login_challenge` is not slowed: the three captcha selector checks stay snapshots (the decision-model fallback from RS-311 covers what they miss).

## Out of scope

- Pinning Playwright in the worker `Dockerfile` (`pip install .` takes whatever satisfies `>=1.51.0`). A chore of its own.
- A shared wait helper: none exists, and the AGPL monitor cannot import `rs_poster`.

## Notes

- `raise_if_restricted` keeps its snapshot on purpose: it runs on every navigation, the restriction banner persists, so the next navigation catches a miss, and a 1 s wait on every healthy page is not worth it.
