# Fleet live settings (RS-455)

Fleet workers read their settings once, at boot, from the claim. This plan
makes the ERP the live source: a worker takes new settings between tasks, and
nothing the ERP edits needs a container restart (which is a Facebook login).

## Where each setting comes from

| Setting | Today | After |
| --- | --- | --- |
| `search` (rating gate, `min_unit_count`, prompts, `title_prefilter`, …) | claim, rendered into `config.toml` at boot | `next-task` answer, applied between tasks |
| Alerts on/off | `RS_ALERTS` in `FLEET_WORKER_ENV`, at boot | `fleet_settings.alerts.on`, live |
| Topic routing | `alert_priority` in the monitor, by unit count | unchanged: by unit count, whatever the rating (owner, 2026-10-29) |
| Telegram chat and topic ids | `FLEET_WORKER_ENV`, at boot | `fleet_settings.alerts` (not secret), live |
| Telegram bot token, OpenRouter key, coordinator tokens | `FLEET_WORKER_ENV`, at boot | the same secret, also served by `POST /api/fleet/worker/env` |
| Proxy, account, browser profile | claim | claim (boot-only by nature) |

## 1. ERP backend

- `fleet_settings` gains an `alerts` row:
  `{on: boolean, chat_id: string, topics: {high, medium, low}}`.
  Default `on: false` until the owner turns it on. Validation in `apps/backend/src/fleet/cities.ts` beside
  `SEARCH_FIELDS`.
- `loadSettings` returns a `version`: a short hash of `search` + `alerts`.
- `POST /api/fleet/worker/next-task` takes an optional `settings_version`
  and, when it differs (or is absent), answers
  `settings: {version, search, alerts}`. Older workers send no version and
  ignore the field.
- `POST /api/fleet/worker/env` (worker scope, same epoch check as
  `next-task`) answers `{}`; the Cloudflare Worker adds `env` exactly as it
  does for a claim (`withWorkerEnv` in `deploy/cloudflare/worker.js`, path
  added beside `FLEET_CLAIM_PATH`). The secret stays out of Postgres.
- Tests: `apps/backend/tests/fleet-*.test.ts` (version changes, field
  absent when unchanged, env route auth); `deploy/cloudflare/worker.test.mjs`.

## 2. ERP frontend

- Fleet ▸ Analysis, the Telegram alert stage: an **Edit** form for alerts on,
  the chat and the topic ids, like the other
  stages' forms. FEATURES.md updated.

## 3. Worker (facebook-tracker release + image)

- `FleetClient.next_task` sends `settings_version`; the monitor keeps the
  last version it applied.
- On a new version, between tasks, the monitor:
  - overlays `search` onto the marketplace and item configs (the fields
    `SEARCH_FIELDS` allows);
  - applies `alerts`: `marketplace.set_fleet(alerts=on)`, builds or updates
    the Telegram user (`[user.recycle]`) from the chat, topics and the bot
    token, and sets the control-plane URL for claims;
  - when it turns alerts on without the secrets, asks
    `POST /api/fleet/worker/env` once and keeps the answer in memory only.
- The entrypoint keeps rendering the boot config from the claim, so the
  first task runs as today.
- Tests: the monitor's fleet loop against the fake fleet (a version change
  mid-run applies, alerts flip on and a listing is claimed and sent, nothing
  restarts the browser); rs_worker entry tests unchanged.

## 4. Rollout

1. Backend + Cloudflare Worker to prod (backward-compatible: older workers
   ignore `settings`, the env route is new).
2. Save `alerts` in the ERP with the chat and topics; keep `on: false` until
   the new image runs anywhere, since the stopgap sender already covers the
   running workers.
3. facebook-tracker release, worker image pushed, `FLEET_IMAGE_WORKER`
   bumped. No forced restart: each worker takes the image at its next start
   (the agent's roll command replaces only on request).
4. When a worker on the new image runs, turn `alerts.on` in the ERP; it
   applies within a task.
5. When no running worker is older than the image, remove both cron lines
   (`ai-verdict-bridge.py`, `fleet-alert-sender.py`) on both hosts.

## Open questions for the owner

- Should `RS_ALERTS` in `FLEET_WORKER_ENV` stay as a master kill switch over
  the ERP's `alerts.on`, or go away?
- An alert with no unit count: General (today) or Low?
