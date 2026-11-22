# A deploy from `dev` removed the webhook route that was live but unmerged

**2026-11-22.** No buyer alerts for two days. `GET /health` was fine and
nothing paged.

## What happened

- The redditapis.com webhook (`src/webhook.ts`, PR #1232) was deployed to
  Railway by `railway up` from its session branch on 2026-11-18 and worked,
  but the PR stayed open.
- On 2026-11-20 23:54 UTC the dedup fix (PR #1234) was deployed from a branch
  cut from `dev`. Railway deploys are uploads of the folder, so the new build
  had no `/webhooks/redditapis` route.
- The vendor kept finding posts and got `404 Not Found` on every delivery
  (601 in a row). `poll_source` was still `webhook`, so the poll loop was idle
  too. The "no delivery for 90 minutes" watch lived in the same unmerged
  branch, so it went with the route and nothing paged.

## How to tell

- `pnpm redditapis status`: `delivered_24h 0`, `failed_24h` in the hundreds,
  deliveries `dead … http_error(404)`.
- `curl -X POST https://<api>/webhooks/redditapis` returns 404. A healthy api
  returns 401 (bad signature).
- `webhook_deliveries.received_at` stops at the minute of a deploy
  (`railway deployment list --service api`).

## Fix, and the rule

Redeploy from a branch that has the route, then
`pnpm redditapis redrive --since-hours N`. Posts older than
`max_post_age_hours` are dropped on arrival, so redrive within a day.

**Merge before or right after deploying.** What runs on Railway is whatever
folder was uploaded last, not `dev`. Before `railway up`, check that the
branch contains everything the running build has: after the deploy,
`POST /webhooks/redditapis` must not be 404.
