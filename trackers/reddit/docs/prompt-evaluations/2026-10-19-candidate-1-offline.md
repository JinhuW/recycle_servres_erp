# 2026-10-19 — candidate 1 and reasoning-first, measured offline

The question: is [candidate 1](2026-10-18-baseline.md#candidate-1) better than
the live prompt? And does asking for the reasoning before the verdict help?
This answers both on real posts, before any reactions exist. The prod trial
(`GET /api/prompt-stats`) will answer the same question with leads, but that
takes weeks at about 15 alerts a day.

## Method

- **Posts.** The 100 sampled in the baseline, from prod:
  - the 40 most recent alerts, Oct 13–18;
  - the 60 most recent rejected posts from homelabsales, hardwareswap,
    canadianhardwareswap and hardwareswapuk.
- **Labels.** The baseline audit labelled the 40 alerts against the rule's
  spec: 18 meet it and 22 don't. The 60 rejected posts count as correct
  rejects unless a prompt flags them. A flagged one is then read by hand.
- **Model.** `openai/gpt-4o-mini` at temperature 0, through OpenRouter, with
  the same user message the tracker sends (`buildUserMessage`).
- **Four configurations.**
  - The live prompt (`eval_prompt` plus the "Reddit Buyer" rule) and candidate
    1.
  - Each with the tracker's response schema, which asks for `is_target`
    before `reasoning`, and with a copy that asks for `reasoning` first.
  - The live, verdict-first row is the prod verdicts themselves.

## Result

| Configuration | Alerts | Meet the spec | Junk | Precision |
| --- | --- | --- | --- | --- |
| Live, verdict first (prod today) | 40 | 18 | 22 | 45% |
| Live, reasoning first | 31 | 17 | 13 | 57% |
| Candidate 1, verdict first | 20 | 15 | 5 | 75% |
| **Candidate 1, reasoning first** | **20** | **17** | **3** | **85%** |

- **Each fix helps on its own, and together they help most.**
  - The rewritten prompt removes most of the junk.
  - Reasoning first makes the model's verdict agree with its own count.
  - Neither one finds new alerts among the 60 rejected posts. The live prompt
    with reasoning first flagged one: a 4-module ECC lot, whose own reasoning
    said it "does not meet the bulk-quantity requirement".
- **With the verdict first, the model contradicts itself.** In 4 of the 5
  junk alerts candidate 1 kept, the reasoning ends "…totaling 4 target items,
  which does not meet the minimum of 7" and the verdict is still true.
  Reasoning first removes all four.
- **The best configuration's remaining errors are mostly in the labels.** The
  audit labelled from one-line summaries; the model read the full posts.
  - One "junk" alert is a server sale whose body lists 2 × 4 × 16 GB ECC.
    That's 8 modules, so it does qualify.
  - One counts a lot's SAS HDDs as well as its SSDs. That's a real error, but
    the SSDs alone may reach 7.
  - The one spec-OK alert it drops is the 6-or-7-unit cross-post the audit
    had already called ambiguous.
  - A `[PC]` (price check) listing the audit had counted as good is rejected
    by every reasoning-first run. The spec says to reject valuation requests.
- **Volume.** Candidate 1 alerts on half as many posts as live: 20 against 40
  here, so about 7–8 alerts a day instead of 15.

## Decision this supports

1. **Reasoning first is a code change**, because the schema lives in
   `src/llm.ts`. It changes every verdict at once, live and candidate alike.
   It needs a new prompt version identity, or stats would mix
   reasoning-first verdicts into today's versions.
2. **Candidate 1** is better against the written spec by a wide margin. The
   prod trial keeps running until buyers' reactions confirm it doesn't lose
   leads the spec misses; promote it then.

Spec precision is not lead rate: a listing can meet the spec and still be
something the buyers never act on. Reactions decide that. This measurement
is the reason to keep the trial running, not a substitute for it.

## Reproducing

The two scripts used are not in the repo, because they call paid APIs.
Re-run it like this:

1. Load the sample into a scratch tracker database as `eval_sample`. Use the
   two queries in the baseline, plus `is_target AS prod_target`.
2. For each post, call OpenRouter with `buildUserMessage(post)` and each
   system prompt, once with `RESPONSE_SCHEMA` and once with its properties
   reordered to `reasoning, is_target, summary, price`.
3. Compare the verdicts with the labels above.

It costs about 300 gpt-4o-mini calls.
