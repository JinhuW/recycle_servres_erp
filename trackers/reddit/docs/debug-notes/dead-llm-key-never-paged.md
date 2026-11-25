# A dead OpenRouter key stopped every evaluation and nothing paged

**Date:** 2026-11-24 · **Symptom:** the ops group's Reddit · Errors topic
showed one digest a minute:

```
ℹ️ Reddit: 1 warn/error line
1× evaluate · evaluation failed: OpenRouter HTTP 401: {"error":{"message":"User not found.","code":401}} — railway-worker
```

Reddit · Workers showed nothing. No lead had been judged for about 20 hours.

## What happened

The OpenRouter key in `llm_keys` (`…8fc5`) was replaced at 06:16 UTC with
one OpenRouter didn't recognise. Its `401 User not found` means the key maps
to no account: it was deleted, revoked or mistyped. It does not mean a
transient error. The last verdict was at 06:10. After that every attempt
failed, and 301 posts used up their attempts and ended `failed`.

The "evaluate failing" alert needs 3 bad iterations in a row. Posts arrive
one at a time from the webhook, so most evaluate iterations find nothing to
claim. Those count as clean, and the streak dropped back to 0 between posts:
`workers.loop_failures->'evaluate'` showed `consecutiveFailures: 0` while
everything was failing.

## Checking a key

```bash
# 200 = live; 401 "User not found" = the key is dead
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key
```

To compare, `GET /api/llm-keys` on the tracker shows `last4` of the stored
key, and `llm_keys.updated_at` shows when it last changed.

## Fix

- Paste a working key on the ERP's Settings ▸ AI models. It pushes the key to
  the tracker, which picks it up within a minute without a restart. Pushing
  it to the tracker directly leaves the ERP's sealed copy stale, and the next
  sync sends the dead key back.
- Posts that gave up stay `failed`. Requeue the ones still worth judging with
  `POST /api/posts/:id/requeue`.
- The watch now has an outcome-based alert, "Reddit evaluation stalled"
  (`eval_stall_alert_min`, set on the ERP's Reddit page), which fires when
  posts have waited unjudged past the threshold whatever the loop's streak
  says.
