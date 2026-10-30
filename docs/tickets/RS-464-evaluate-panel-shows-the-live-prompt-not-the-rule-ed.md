---
id: RS-464
title: Evaluate panel shows the live prompt, not the rule editor
type: story
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/plaice
pr: 1005
version: 1.386.0
related: []
---

## Ask

> It seem alerts rule has been move to the prompt table.
>
> let we keep it as it and turn this into a prompt display.

(Screenshot: Reddit tracker → Workflow → Evaluate, the Alert rules panel.)

## Context

The Evaluate stage on `/tracker/workflow` showed an **Alert rules** editor
(New rule, toggle, edit, delete). Rules have since become part of the prompt:
promoting a candidate on the Prompts tab folds them into the base prompt and
switches them off (`trackers/reddit/src/api.ts`, promote), and the Prompts
table already shows the composed prompt (`composeEvalPrompt`,
`trackers/reddit/src/rules.ts`). The editor was a second, older way to change
what the model reads.

## Acceptance criteria

- [ ] Evaluate's right panel is titled "Live prompt" and shows
      `config.live.systemPrompt` from `/api/tracker/prompt-stats` read-only:
      the base prompt plus enabled rules, exactly what the model reads.
- [ ] No New rule / toggle / edit / delete controls remain; the rule dialog
      and delete confirmation are gone.
- [ ] A note under the panel sends prompt changes to the Prompts tab.
- [ ] Settings chips (Model + edit, Rules on x / y, …) and the Fleet summary's
      rules count are unchanged.
- [ ] Promoting on the Prompts tab refreshes the shown prompt.

## Out of scope

The tracker's rule endpoints and table, the ERP proxy allowlist, deleting
existing rules, the Prompts tab itself.

## Notes

- The panel reads `config.live.systemPrompt` from the prompt-stats call the
  page already made for the live model, so no new request or endpoint.
- The frontend's `createRule` / `updateRule` / `deleteRule` client calls went
  with the editor; the ERP proxy and tracker endpoints stay.
