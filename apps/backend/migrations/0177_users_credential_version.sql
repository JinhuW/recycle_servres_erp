-- `tokens_valid_after` (0144) has whole-second resolution, the same as a
-- token's iat, so a token minted in the very second of a password change
-- compared as not older and stayed accepted for its whole lifetime.  Every
-- credential change (password reset or change, deactivation) now also bumps
-- this counter; a token carries the version it was minted under and is
-- refused once the live row has moved on, whatever the clock says.  The
-- timestamp stays for tokens minted before this column existed.
ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1;
