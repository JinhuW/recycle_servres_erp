-- The Facebook chats page searches message bodies for any substring, and its
-- thread list repeats the search on every poll: a trigram index keeps that off
-- a scan of every message ever pushed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX fb_chat_messages_body_trgm_idx ON fb_chat_messages USING gin (body gin_trgm_ops);
