-- 0216: who wrote an account's stored session, beside when (cookie_at).
-- A fleet worker's upload writes its worker id; a pool import or edit that
-- changes the cookie writes the manager's name. NULL for rows saved before.

ALTER TABLE fb_pool_accounts ADD COLUMN cookie_by TEXT;
