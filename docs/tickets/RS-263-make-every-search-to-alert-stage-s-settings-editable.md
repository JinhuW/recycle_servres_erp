---
id: RS-263
title: Make every search-to-alert stage's settings editable from the ERP
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/editable-stage-config
pr: 672
version: 1.265.0
related: [RS-261, RS-262]
---

## Ask

> enable all configuration editbale.
>
> [Image #1]
>
> Each stage should configurable.
>
> Plan first and start the implementation without asking

The screenshot is the Fleet tab's *From a search to an alert* card with the
AI rating stage open: the chips (Alert at AI rating 4 / 5, Minimum units per
lot 5, AI model) and the evaluation prompt and rating rubric, all read-only.

## Context

RS-261 (v1.263.0) added the flow card. Its settings come from `/v1/fleet`,
which rs_console composes from `master.toml`, and the card says they are
read-only "because nothing writes master.toml from the ERP yet". Changing a
threshold, a phrase or the prompt meant an edit to `master.toml`, a
regenerate and a deploy.

`master.toml` is tracked in git and every deploy rsyncs it, so the ERP cannot
write there: the next deploy would put the git copy back. The workers run the
per-worker configs (`configs/homelab*.toml`) as single-file bind mounts, and
the vendored monitor reloads its config when the file's hash changes
(`monitor.py`, "Config file changed, restarting monitor").

## Acceptance criteria

- [x] Each stage that reads a setting has an Edit button in the flow card; the
      form edits exactly the settings that stage shows:
  - Search: sweep times (`start_at`), listing window, delivery, results per
    search, interval, and each item's search phrases.
  - Result cards: results per search.
  - Title gate: title prefilter and each item's anti-keywords.
  - Keyword gate: each item's keywords and anti-keywords, minimum seller
    rating, unrated sellers.
  - AI rating: alert rating, minimum units, AI model, evaluation prompt,
    rating rubric.
- [x] Stages with no setting (open, new to us, coordinator, alert) keep their
      "code, not a setting" chips and offer no form.
- [x] Saving goes `PUT /api/coordinator/settings` (manager-only, field
      allowlist, editor logged by field name) → rs_console
      `PUT /v1/config/settings`, which validates, stores the values in a
      console-owned volume and rewrites every worker config in place.
- [x] `/v1/fleet` shows the effective values (master.toml + saved settings)
      and says whether the console can save; an older console shows the card
      read-only as before.
- [x] A deploy keeps the saved settings: worker configs pass through the
      console's renderer on the way to the VM, and verify compares against
      that.
- [x] Bad input (unknown item, rating 7, an empty phrase list, a malformed
      time) is a 400 with the reason, and nothing is written.

## Out of scope

- Making code-defined behaviour (5 s page pause, listing cache, dedupe by
  item id, Telegram topic thresholds) configurable. Those are code in the
  vendored monitor and the coordinator, not config.
- Editing regions, cities, fleet.toml or credentials-bearing keys (proxies,
  API keys, Telegram ids).
- Resetting a saved value back to master.toml's: a saved value stays until it
  is saved again.

## Notes

- Saved settings live in `/state/settings.json` on the `rs-console-state`
  volume, not in git. `master.toml` stays the default; the saved values are an
  overlay the console applies with `tomlkit`, which keeps every comment.
- Worker configs are rewritten in place, never replaced: a single-file bind
  mount keeps pointing at the old inode after a rename, so the worker would
  never see the change.
- A config change makes the monitor restart its jobs, which runs a sweep
  immediately. The form says so.
