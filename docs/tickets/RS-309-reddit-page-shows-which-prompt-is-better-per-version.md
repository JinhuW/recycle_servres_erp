---
id: RS-309
title: Reddit page shows which prompt is better: per-version leads and the candidate trial
type: story
status: done
priority: P2
created: 2026-10-18
reporter: jinhu
branch: reddit-prompt-card
pr: "#761"
version: 1.291.0
related: [RS-305]
---

## Ask

> due to this change, Didyou update the UI to reflect this candidate prompt?

> the goal here is to build some data point to help us better undertand which prompt is better

## Context

RS-305 made the Reddit tracker record three things:

- the prompt version behind every verdict;
- the Telegram message id of every alert;
- every reaction on an alert. Any reaction except 👎 makes it a **lead**.

It can also judge every post a second time with a candidate prompt. Candidate
1 has been on trial in prod since 2026-10-19. All of this is visible only
through the tracker's own API (`GET /api/prompt-stats`). The ERP's
Monitors ▸ Reddit page shows none of it, and the proxy doesn't forward those
routes.

The card exists to answer one question: is the candidate better than the live
prompt? So it leads with the comparison. That means the candidate's verdicts
against live's on the same posts, and leads per version shown next to how
many posts they rest on. Starting, ending and promoting a trial come second.

This changes the contract between the ERP and the tracker (root `AGENTS.md`
→ *Contracts*). The tracker side ships first and stays backward-compatible.

## Acceptance criteria

- [x] The tracker's `GET /api/prompt-stats` also returns `config`:
  - the live and candidate model and prompt text, with their version ids
    (`null` until a prompt has judged a post);
  - the number of enabled rules.

  Its existing fields are unchanged.
- [x] `PUT /api/prompt-candidate` starts or replaces a trial, and validates
  the prompt and the model. `DELETE /api/prompt-candidate` ends it and keeps
  its numbers.
- [x] The ERP proxy forwards `prompt-stats`, `prompt-candidate` and
  `prompt-candidate/promote` to managers only. Generic `settings` stays
  outside the allowlist.
- [x] Monitors ▸ Reddit has a **Which prompt is better** card. When a trial is
  running, it shows the 2×2 of *both / only live / only candidate / neither*,
  with posts, leads and 👎 in each cell. Above that is one sentence saying
  how many leads the candidate would gain or lose and how much junk it would
  drop, and it warns when under 20 posts are labelled.
- [x] The card lists every prompt version with:
  - its role (live, candidate or retired) and model;
  - posts judged and flagged;
  - buyer alerts and leads, as "x of n" plus a rate;
  - dev-chat leads and 👎.

  Each row expands to the full prompt.
- [x] A 7 days / 30 days / all time switch scopes the numbers.
- [x] A manager can start, edit and end a trial from the card, and promote
  the candidate after a confirmation that names the rules promoting will
  disable.
- [x] English and Chinese strings, with the i18n parity and coverage tests
  passing.

## Out of scope

- **A per-day lead trend.** Totals per window answer the question first.
- **Editing `eval_prompt` from the ERP.** Rules already change the live
  prompt, and promoting a candidate replaces it.
- **The mobile shell**, which has no tracker page.

## Notes

- The tracker deploy for this also carries #758 (prompt version ids without
  gaps), which the user chose to ship with the next change.
- The tracker side was deployed on 2026-10-19 as image `4282291f` (api,
  worker and all five OCI VMs) before the ERP release. It also shipped #758.
- Released to `main` in v1.291.0 (#765) on 2026-10-19. Prod health reports
  1.291.0 at `962a95ef`.
- Verified locally with Playwright against a seeded trial covering all four
  cells, 17 checks:
  - the verdict sentence;
  - the cells and per-version numbers;
  - the 7-day window;
  - expanding a row;
  - editing, ending and starting a trial;
  - promoting, including its confirm text and the rules list switching off.
