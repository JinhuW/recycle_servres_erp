-- An account can also be `blocked`: Facebook showed an in-page warning that it
-- is limiting the account ("temporarily blocked", "going too fast", a security
-- check). The extension (0.6.0) stops for a set number of hours, then reports
-- `recovered`.
ALTER TABLE fb_chat_accounts DROP CONSTRAINT IF EXISTS fb_chat_accounts_restricted_check;
ALTER TABLE fb_chat_accounts ADD CONSTRAINT fb_chat_accounts_restricted_check
  CHECK (restricted IN ('login', 'checkpoint', 'blocked'));
