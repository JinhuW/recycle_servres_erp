# Telegram alerts silently die when a group becomes a supergroup

**Date:** 2026-08-16 · **Symptom:** every alert fails with
`Bad Request: group chat was upgraded to a supergroup chat`; after
`MAX_ATTEMPTS` the target posts park in `failed` and nothing reaches the chat.

## What happened

Telegram permanently changes a group's chat id when it is upgraded to a
supergroup (this happens implicitly — e.g. changing certain group settings or
member counts). The old id (`-51…`) stops working forever; the new id is a
`-100…` id. Our `telegram_chat_ids` setting still held the old id, so every
worker failed every send, burned its retries, and parked the posts.

## How to diagnose fast

1. OpenSearch (10.10.10.73:5601): search `"alert delivery failed"` — the
   per-chat error names the cause.
2. The error response from Telegram *contains the new chat id*, but
   `sendOne()` in `src/telegram.ts` only keeps `description` and drops
   `parameters.migrate_to_chat_id`. To recover it, probe by hand:

   ```sh
   curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" \
     -H 'Content-Type: application/json' \
     -d '{"chat_id": "<old id>", "text": "probe"}'
   # → {"ok":false, ..., "parameters":{"migrate_to_chat_id":-100…}}
   ```

## Fix (no redeploy — settings live in the DB, invariant 5)

```sh
# 1. point the fleet at the new id
curl -X PUT $API/api/settings/telegram_chat_ids \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"value": ["-100…"]}'

# 2. verify delivery
curl -X POST $API/api/telegram/test -H "Authorization: Bearer $API_TOKEN" -d '{}'

# 3. requeue the posts that parked while it was broken
#    (find them via /api/matches — status "failed")
curl -X POST $API/api/posts/<reddit_id>/requeue -H "Authorization: Bearer $API_TOKEN"
```

## Trap to remember

- A `failed` post count in `/api/stats` after an alert outage means missed
  alerts that will **never** retry on their own — always requeue after fixing
  the transport.
- Possible hardening (not done yet): have `sendOne()` surface
  `parameters.migrate_to_chat_id` in the failure report, or auto-rewrite the
  setting when Telegram reports a migration.
