-- Runs inside the restore transaction, right after prod's dump lands on dev.
--
-- Dev is a copy of prod for testing against real data, not a second way into
-- prod. A refresh token, an OAuth grant or a client secret copied across would
-- keep working against prod's own backend for as long as it is valid there:
-- everyone with dev database access could replay it. So every live
-- credential is cleared here. Password hashes stay, so people can still sign
-- in to dev with their own passwords — the trade-off chosen for this copy.
--
-- No CASCADE, on purpose: a new table with an FK onto one of these must be
-- decided on (scrub it too, or not), not silently emptied. Such an FK makes
-- the TRUNCATE fail, and tests/sync-scrub.test.ts fails with it in CI rather
-- than the nightly restore failing on dev.
TRUNCATE refresh_tokens, oauth_refresh_tokens, oauth_authorization_codes,
         oauth_pending_consent, login_attempts;
UPDATE oauth_clients SET secret_hash = NULL, revoked_at = COALESCE(revoked_at, NOW());
