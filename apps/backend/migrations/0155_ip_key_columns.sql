-- Per-address budgets that count stored rows (the public forms' daily share,
-- the DCR per-IP throttle) compared full addresses, so an IPv6 sender rotating
-- inside its /64 started every request with a fresh count. They count by the
-- limiter key instead (lib/clientIp.ts). No backfill: both windows are a day
-- at most, and an IPv4 key is the address itself, so `COALESCE(key, ip)` reads
-- older rows the same.
ALTER TABLE web_submissions ADD COLUMN ip_key TEXT;
ALTER TABLE oauth_clients ADD COLUMN created_ip_key TEXT;
