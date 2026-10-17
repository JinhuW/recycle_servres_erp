-- 0184: when the weekly liveness check last looked at an account on Facebook.
-- NULL means never, so a new account is probed on the next pass. The check
-- stamps it when it claims the account, which is what keeps two backend
-- instances from probing the same one.
ALTER TABLE fb_pool_accounts ADD COLUMN alive_checked_at TIMESTAMPTZ;
