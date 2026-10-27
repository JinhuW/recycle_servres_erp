-- Which api process holds the Telegram user session. A redeploy starts the
-- new api before the old one stops, and the same session live in both gets
-- revoked (AUTH_KEY_DUPLICATED), so the new one waits for this to clear or go
-- stale before it connects (src/loops/notify.ts).
ALTER TABLE telegram_state ADD COLUMN IF NOT EXISTS user_sender_owner TEXT;
