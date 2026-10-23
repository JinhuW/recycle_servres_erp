-- 0204: every pool account a fleet worker has signed in with, and the proxy it
-- browsed through at the time. A proxy that has burned more than four accounts
-- is DEAD (routes/facebookPool.ts) until a manager revives it.
--
-- One row per stint: it opens when an account becomes `fleet` on a worker and
-- closes when it stops being that, with what it became as the outcome ('fleet'
-- = moved to another worker, 'removed' = deleted from the pool). account_no
-- has no FK, as in fb_pool_events: a removed account's history is kept.
-- proxy_url is the worker's proxy as the fleet document names it
-- (scheme://host:port, no login), stamped by /assign; NULL with proxy_known
-- means the VM's own IP, NULL without it means nobody recorded it.

CREATE TABLE fb_worker_accounts (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id   TEXT NOT NULL,
  account_no  INTEGER NOT NULL,
  uid         TEXT NOT NULL,
  proxy_url   TEXT,
  proxy_known BOOLEAN NOT NULL DEFAULT FALSE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  outcome     TEXT CHECK (outcome IN ('available','taken','fleet','problem','retired','removed')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX fb_worker_accounts_worker_idx ON fb_worker_accounts (lower(worker_id), started_at DESC);
CREATE INDEX fb_worker_accounts_failed_idx ON fb_worker_accounts (proxy_url, ended_at)
  WHERE outcome IN ('problem','retired');

-- A revive restarts a proxy's count: failures that ended before it no longer
-- make it DEAD. Only the latest revive is kept.
CREATE TABLE fb_proxies (
  url             TEXT PRIMARY KEY,
  revived_at      TIMESTAMPTZ,
  revived_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revived_by_name TEXT
);
CREATE INDEX fb_proxies_revived_by_idx ON fb_proxies(revived_by);

-- The stints that already happened, read back from the pool ledger: each
-- 'assigned' (a re-send to the same worker continues the stint), ended by the
-- account's next move off that worker. Edits that kept the account fleet are
-- skipped because they don't say on which worker.
WITH ev AS (
  SELECT account_no, kind, status, detail, created_at
  FROM fb_pool_events
  WHERE account_no IS NOT NULL
    AND (kind = 'assigned'
         OR (kind IN ('returned','reported','retired','removed','edited','took') AND status <> 'fleet'))
), lagged AS (
  SELECT ev.*,
         LAG(kind)   OVER (PARTITION BY account_no ORDER BY created_at) AS prev_kind,
         LAG(detail) OVER (PARTITION BY account_no ORDER BY created_at) AS prev_detail
  FROM ev
), starts AS (
  SELECT account_no, detail AS worker_id, created_at AS started_at
  FROM lagged
  WHERE kind = 'assigned' AND detail IS NOT NULL
    AND NOT (prev_kind IS NOT DISTINCT FROM 'assigned' AND lower(prev_detail) = lower(detail))
)
INSERT INTO fb_worker_accounts (worker_id, account_no, uid, started_at, ended_at, outcome)
SELECT s.worker_id, s.account_no, COALESCE(a.uid, rm.detail), s.started_at, e.created_at,
       CASE WHEN e.kind IS NULL THEN NULL
            WHEN e.kind = 'assigned' THEN 'fleet'
            WHEN e.kind = 'removed' THEN 'removed'
            ELSE e.status END
FROM starts s
LEFT JOIN fb_pool_accounts a ON a.no = s.account_no
LEFT JOIN LATERAL (
  SELECT detail FROM fb_pool_events
  WHERE account_no = s.account_no AND kind = 'removed' ORDER BY created_at DESC LIMIT 1
) rm ON TRUE
LEFT JOIN LATERAL (
  SELECT kind, status, created_at FROM ev
  WHERE ev.account_no = s.account_no AND ev.created_at > s.started_at
    AND NOT (ev.kind = 'assigned' AND lower(ev.detail) = lower(s.worker_id))
  ORDER BY created_at LIMIT 1
) e ON TRUE
WHERE COALESCE(a.uid, rm.detail) IS NOT NULL;

-- The ledger and the rows can disagree (an edit that moved an account between
-- workers names neither). The rows win: close what isn't on its worker now,
-- and open a stint for every fleet account that has none.
UPDATE fb_worker_accounts w
SET ended_at = COALESCE(a.updated_at, NOW()),
    outcome = CASE WHEN a.no IS NULL THEN 'removed' WHEN a.status = 'fleet' THEN 'fleet' ELSE a.status END
FROM (SELECT w2.id, a2.no, a2.status, a2.updated_at, a2.holder_name
      FROM fb_worker_accounts w2 LEFT JOIN fb_pool_accounts a2 ON a2.no = w2.account_no
      WHERE w2.ended_at IS NULL) a
WHERE w.id = a.id
  AND (a.no IS NULL OR a.status <> 'fleet' OR lower(a.holder_name) IS DISTINCT FROM lower(w.worker_id));

INSERT INTO fb_worker_accounts (worker_id, account_no, uid, started_at)
SELECT a.holder_name, a.no, a.uid, COALESCE(a.held_since, a.updated_at)
FROM fb_pool_accounts a
WHERE a.status = 'fleet' AND a.holder_name IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM fb_worker_accounts w WHERE w.account_no = a.no AND w.ended_at IS NULL);

-- One open stint per account. Each backfilled stint ends before the account's
-- next one starts, so the rows above already hold to it.
CREATE UNIQUE INDEX fb_worker_accounts_open_idx ON fb_worker_accounts (account_no) WHERE ended_at IS NULL;

-- From here on the pool's own writes keep the stints: /assign (both of its
-- updates), the editor, retire, delete and the weekly liveness check all
-- change status or holder_name, and none of them has to know about this table.
CREATE FUNCTION fb_worker_accounts_track() RETURNS trigger AS $$
DECLARE
  closing BOOLEAN := FALSE;
  opening BOOLEAN := FALSE;
  fate    TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    closing := OLD.status = 'fleet';
    fate := 'removed';
  ELSIF TG_OP = 'UPDATE' THEN
    closing := OLD.status = 'fleet' AND (NEW.status <> 'fleet'
               OR lower(NEW.holder_name) IS DISTINCT FROM lower(OLD.holder_name));
    opening := NEW.status = 'fleet' AND (OLD.status <> 'fleet'
               OR lower(NEW.holder_name) IS DISTINCT FROM lower(OLD.holder_name));
    fate := NEW.status;
  ELSE
    opening := NEW.status = 'fleet';
  END IF;
  IF closing THEN
    UPDATE fb_worker_accounts SET ended_at = NOW(), outcome = fate
    WHERE account_no = OLD.no AND ended_at IS NULL;
  END IF;
  IF opening AND NEW.holder_name IS NOT NULL THEN
    INSERT INTO fb_worker_accounts (worker_id, account_no, uid)
    VALUES (NEW.holder_name, NEW.no, NEW.uid);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER fb_worker_accounts_track
  AFTER INSERT OR UPDATE OF status, holder_name OR DELETE ON fb_pool_accounts
  FOR EACH ROW EXECUTE FUNCTION fb_worker_accounts_track();
