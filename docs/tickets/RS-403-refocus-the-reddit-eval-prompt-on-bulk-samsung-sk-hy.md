---
id: RS-403
title: Refocus the Reddit eval prompt on bulk Samsung, SK Hynix and Micron RAM
type: story
status: backlog
priority: P2
created: 2026-10-26
reporter: jinhu
branch: JinhuW/reddit-bulk-ram-prompt
pr:
version:
related: []
---


## Ask

> refine the current reddites AI review prompt and it is shipping a lots of noise data now.
>
> We are only target bulk rams (Samsung, SK, Micron) brand.
>
> Base on inventory, refine the prompt to make it more accurate for the bulk post.

## Context

The live prompt (version 66, `openai/gpt-4o-mini`) is `eval_prompt` with the
"Reddit Buyer" rule appended. That is two full prompts that disagree: one takes
SSDs in any quantity, the other wants 7 or more units. The rule's
`ALERT`/`NO_ALERT` output instruction also leaks into the summaries.

Of the 102 alerts sent Oct 19–26, only about 30 were bulk server or OEM RAM.
The rest were single SSDs or a handful, HDD lots, whole servers and desktops,
firewalls, and one `[W]` buyer post. Some went out with an empty summary.
Candidate 1 (version 68) still targets SSDs. Reactions can't score a change:
no alert got a positive reaction in 8 days.

The ERP inventory says what is worth alerting on. These figures cover all RAM
PO lines on the dev copy of prod:

- Samsung, SK Hynix and Micron are 92% of RAM spend.
- By type: server RDIMM $424k, LRDIMM $245k, laptop SODIMM $126k, desktop
  UDIMM $35k.
- 87% of spend comes from POs of 50 or more modules. POs of 1–6 modules total
  $3k. DDR3 averages about $7 a module.
- The 9 Reddit-sourced POs were all DDR4/DDR5 modules from the three makers,
  7 to over 100 modules each.

## Acceptance criteria

- [x] Candidate 2's text and its offline numbers are in
      `trackers/reddit/docs/prompt-evaluations/2026-10-26-candidate-2-bulk-ram.md`.
- [x] On the eval set, precision against the spec is at least 90%: every
      alert is a bulk lot from the three makers.
- [x] Candidate 2 keeps every hand-labelled bulk-RAM lot that live flagged,
      or the write-up explains each one it drops.
- [x] It alerts on no SSD-only, HDD-only, whole-server or `[W]` post.
- [x] Once promoted, `GET /api/prompt-stats` shows it as live and the
      "Reddit Buyer" rule is disabled.

## Out of scope

- Deduplicating cross-posts.
- Code or response-schema changes.
- Changes to the subreddit list.

## Notes

- Owner decisions, 2026-10-26:
  - OEM laptop and desktop modules (SODIMM/UDIMM) from the three makers count,
    not only server memory.
  - Roll out with an offline eval, then promote. No reaction-scored trial.
- Thresholds come from the inventory. A post qualifies with at least 7 DDR4 or
  DDR5 modules of 16GB or more, or at least 20 target modules of any size.
- Offline result, in
  `trackers/reddit/docs/prompt-evaluations/2026-10-26-candidate-2-bulk-ram.md`:
  - 1,503 prod posts over 14 days: 54 alerts against live's 229, and all 54
    meet the spec.
  - It flags 15 of the 15 sellable historic lots, PO-1454's post among them.
  - `gpt-4o-mini` reached only 84% (it ignored `[PC]` and `[W]`), so the
    promoted model is `openai/gpt-6-luna-pro`.
- Promoted to prod 2026-10-26 05:03 UTC with
  `POST /api/prompt-candidate/promote`, after the owner approved. Rule 1
  ("Reddit Buyer") is now disabled.
