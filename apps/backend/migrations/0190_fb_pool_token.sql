-- A Facebook Graph access token (EAA…) sometimes ships with a purchased
-- account. Like the other credentials it is sealed (AES-GCM under FB_POOL_KEY,
-- lib/sealed.ts), never clear text; NULL means the account has none.

ALTER TABLE fb_pool_accounts ADD COLUMN token_enc TEXT;
