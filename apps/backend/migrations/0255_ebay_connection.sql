-- The eBay seller account the ERP publishes to and reads orders from. One
-- account per ERP, so one row. The refresh token is sealed with ebayKey
-- (lib/sealed.ts); access tokens are minted from it and live only in memory.
-- Managers connect, reconnect and disconnect it on Settings ▸ eBay; the sync
-- job (ebay/sync.ts) keeps its cursor and last outcome here.

CREATE TABLE ebay_connection (
  id                        SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Sandbox and production are separate eBay worlds: a row made under one
  -- keyset means nothing to the other, and the routes treat it as absent.
  environment               TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  refresh_token_sealed      TEXT NOT NULL,
  refresh_token_expires_at  TIMESTAMPTZ NOT NULL,
  ebay_user_id              TEXT,
  ebay_username             TEXT,
  marketplace_id            TEXT NOT NULL DEFAULT 'EBAY_US',
  -- Picked from the account when it connects (no UI chooses them): the first
  -- enabled inventory location, and per policy type the one eBay marks
  -- default, else the only one. NULL when none could be picked; setup_issues
  -- says why, and publishing refuses until it is fixed on eBay.
  merchant_location_key     TEXT,
  fulfillment_policy_id     TEXT,
  payment_policy_id         TEXT,
  return_policy_id          TEXT,
  setup_issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Orders modified at or after this were not read yet (less an overlap the
  -- sync re-reads). Advanced in the same transaction as the sales it found.
  sync_cursor               TIMESTAMPTZ,
  last_sync_at              TIMESTAMPTZ,
  last_error                TEXT,
  last_result               JSONB,
  connected_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ebay_connection_connected_by_idx ON ebay_connection(connected_by);

-- One-time `state` values of the consent round trip, stored hashed and bound
-- to the manager who started it, so a callback can't be replayed or completed
-- in another user's session.
CREATE TABLE ebay_oauth_states (
  state_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ebay_oauth_states_user_id_idx ON ebay_oauth_states(user_id);
CREATE INDEX ebay_oauth_states_expires_idx ON ebay_oauth_states(expires_at);
