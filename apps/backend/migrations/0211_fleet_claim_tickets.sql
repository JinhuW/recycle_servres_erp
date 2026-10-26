-- One claim ticket per worker container: the host agent mints it right before
-- `docker run` and the container claims with it instead of the host token, so
-- a compromised worker can claim once, for its own worker id, and nothing
-- else. Only the hash is kept; the ticket is spent by its first successful
-- claim (`claim_id` lets that boot's HTTP retries through until it expires).
CREATE TABLE fleet_claim_tickets (
  token_hash    TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL REFERENCES fleet_hosts(host_id) ON DELETE CASCADE,
  worker_id     TEXT NOT NULL,
  handoff_epoch INTEGER,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  claim_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fleet_claim_tickets_worker_idx ON fleet_claim_tickets(host_id, worker_id);
CREATE INDEX fleet_claim_tickets_expires_idx ON fleet_claim_tickets(expires_at);
