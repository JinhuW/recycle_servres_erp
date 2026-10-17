-- The Facebook account pool: shared Marketplace logins that purchasers take
-- and return, with the spares, the ones assigned to monitor workers and the
-- ones that need a manager's attention. The secret columns hold AES-GCM blobs
-- sealed by the backend (lib/sealed.ts) under FB_POOL_KEY, never clear text;
-- NULL means the account has none. cookie_uid is the cookie's c_user parsed
-- at write time, the one part of a cookie a purchaser may see before taking
-- the account.
--
-- `no` is the pool's "#": a plain identity that is never reused, so a removed
-- account leaves a gap and a purchaser's "#7" always meant one account.

CREATE TABLE fb_pool_accounts (
  no                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid                TEXT NOT NULL UNIQUE CHECK (uid ~ '^\d{10,20}$'),
  password_enc       TEXT,
  totp_enc           TEXT,
  email              TEXT NOT NULL DEFAULT '',
  email_password_enc TEXT,
  recovery_email     TEXT NOT NULL DEFAULT '',
  cookie_enc         TEXT,
  cookie_uid         TEXT,
  note               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available','taken','fleet','problem','retired')),
  holder_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  holder_name        TEXT,
  held_since         TIMESTAMPTZ,
  added_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cookie_at          TIMESTAMPTZ,
  batch              TEXT NOT NULL,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_pool_accounts_holder_user_id_idx ON fb_pool_accounts(holder_user_id);
CREATE INDEX fb_pool_accounts_created_by_idx     ON fb_pool_accounts(created_by);
CREATE INDEX fb_pool_accounts_status_idx         ON fb_pool_accounts(status, added_at);

-- Who did what to which account. account_no has no FK on purpose: a removed
-- account's history is the one record left of it. actor_name is a snapshot
-- because the page shows the name even after the member is deactivated.
CREATE TABLE fb_pool_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_no  INTEGER,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('added','edited','imported','took','returned',
                                           'reported','retired','removed','copied','revealed')),
  status      TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_pool_events_created_idx  ON fb_pool_events(created_at DESC);
CREATE INDEX fb_pool_events_account_idx  ON fb_pool_events(account_no, created_at DESC);
CREATE INDEX fb_pool_events_actor_id_idx ON fb_pool_events(actor_id);

-- Append-only, the same way as the order ledgers (0037, 0050).
CREATE OR REPLACE FUNCTION fb_pool_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fb_pool_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER fb_pool_events_no_update BEFORE UPDATE ON fb_pool_events
  FOR EACH ROW EXECUTE FUNCTION fb_pool_events_lock();
CREATE TRIGGER fb_pool_events_no_delete BEFORE DELETE ON fb_pool_events
  FOR EACH ROW EXECUTE FUNCTION fb_pool_events_lock();
