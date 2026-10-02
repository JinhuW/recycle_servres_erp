-- A password change revoked refresh tokens but left every access token already
-- issued working until it expired: up to an hour for the session cookie, and
-- for any OAuth bearer token too.  Tokens issued before this moment are refused
-- (authMiddleware and bearerGuard compare it with the token's iat).  NULL
-- means the password has never changed since, so nothing is refused.
ALTER TABLE users ADD COLUMN tokens_valid_after TIMESTAMPTZ;
