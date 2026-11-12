-- The chat hub can post as an ordinary Telegram account instead of a bot. Such
-- an account reads replies from the group's history, so its cursor is the last
-- message id seen in the group, not a bot's update id: switching modes must
-- not carry one cursor over to the other.
ALTER TABLE fb_chat_telegram_state ADD COLUMN user_last_message_id BIGINT NOT NULL DEFAULT 0;
