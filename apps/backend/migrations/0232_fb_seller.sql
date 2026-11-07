-- Facebook seller accounts: a pool account that stops searching, posts "we buy"
-- ads with photos drawn from a manager-filled pool, reads its Marketplace inbox,
-- and lets an agent screen and negotiate under a versioned profile. Everything
-- the domain is configured by lives here, not in a file. The shapes are fixed
-- by docs/superpowers/plans/2026-11-07-fb-seller/CONTRACTS.md §3.

-- ─── Agent profiles ─────────────────────────────────────────────────────────
-- First, because fleet_slots.agent_profile_id points at it.
CREATE TABLE fb_agent_profiles (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','candidate','active','retired')),
  prompts     JSONB NOT NULL,
  skills      JSONB NOT NULL,
  rules       JSONB NOT NULL,
  models      JSONB NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  based_on    BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ,
  UNIQUE (name, version)
);
CREATE UNIQUE INDEX fb_agent_profiles_one_active ON fb_agent_profiles((TRUE)) WHERE state = 'active';
CREATE UNIQUE INDEX fb_agent_profiles_one_candidate ON fb_agent_profiles((TRUE)) WHERE state = 'candidate';
CREATE INDEX fb_agent_profiles_based_on_idx ON fb_agent_profiles(based_on);
CREATE INDEX fb_agent_profiles_created_by_idx ON fb_agent_profiles(created_by);

-- ─── Fleet ──────────────────────────────────────────────────────────────────
-- Search kinds keep their city and item; seller kinds name their account and a
-- ref, and a lost lease on a seller write lands in 'uncertain' rather than being
-- retried, since the post or message may already be out.
ALTER TABLE fleet_tasks ALTER COLUMN city DROP NOT NULL, ALTER COLUMN item DROP NOT NULL;
ALTER TABLE fleet_tasks ADD COLUMN payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE fleet_tasks DROP CONSTRAINT fleet_tasks_state_check;
ALTER TABLE fleet_tasks ADD CONSTRAINT fleet_tasks_state_check
  CHECK (state IN ('ready','leased','done','cancelled','expired','uncertain'));
ALTER TABLE fleet_tasks ADD CONSTRAINT fleet_tasks_seller_shape CHECK (
  CASE WHEN kind IN ('ad-post','ad-delete','inbox-sync','msg-send')
       THEN city IS NULL AND item IS NULL AND account_no IS NOT NULL AND payload ? 'ref'
       ELSE city IS NOT NULL AND item IS NOT NULL END);
CREATE UNIQUE INDEX fleet_tasks_seller_open_idx ON fleet_tasks(account_no, kind, (payload->>'ref'))
  WHERE state IN ('ready','leased') AND kind IN ('ad-post','ad-delete','inbox-sync','msg-send');

-- Setting a role changes no container and causes no login.
ALTER TABLE fleet_slots ADD COLUMN role TEXT NOT NULL DEFAULT 'search' CHECK (role IN ('search','seller'));
ALTER TABLE fleet_slots ADD COLUMN agent_on BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fleet_slots ADD COLUMN agent_profile_id BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL;
CREATE INDEX fleet_slots_agent_profile_id_idx ON fleet_slots(agent_profile_id);

-- ─── Settings ───────────────────────────────────────────────────────────────
CREATE TABLE fb_seller_settings (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  value       JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_seller_settings_updated_by_idx ON fb_seller_settings(updated_by);

CREATE TABLE fb_seller_settings_history (
  id          BIGSERIAL PRIMARY KEY,
  version     INTEGER NOT NULL,
  before      JSONB,
  after       JSONB NOT NULL,
  changed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_seller_settings_history_changed_by_idx ON fb_seller_settings_history(changed_by);

-- Append-only, the same way as reddit_lead_events (0219).
CREATE OR REPLACE FUNCTION fb_seller_settings_history_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fb_seller_settings_history is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fb_seller_settings_history_no_update BEFORE UPDATE ON fb_seller_settings_history
  FOR EACH ROW EXECUTE FUNCTION fb_seller_settings_history_lock();
CREATE TRIGGER fb_seller_settings_history_no_delete BEFORE DELETE ON fb_seller_settings_history
  FOR EACH ROW EXECUTE FUNCTION fb_seller_settings_history_lock();

INSERT INTO fb_seller_settings (id, value) VALUES (1, '{
  "kill_switch": false,
  "active_hours": { "start": "08:00", "end": "22:00", "tz": "America/Denver" },
  "pacing": {
    "ad_action_gap_minutes": 20, "max_live_ads_per_account": 3, "same_ad_location_per_day": 1,
    "renew_days": 7, "renew_jitter_days": 2,
    "send_gap_seconds": 60, "send_jitter_seconds": 30, "sends_per_account_day": 40,
    "inbox_every_minutes": 5, "inbox_jitter_minutes": 2, "inbox_max_threads": 10, "inbox_max_messages": 25
  },
  "offer": { "opening_pct": 70, "step_pct": 10, "max_rounds": 3, "price_max_age_days": 30 },
  "agent": { "daily_spend_usd": 5, "circuit_breaker_failures": 3 },
  "photos": { "low_pool_warning": 15 },
  "alerts": { "telegram_chat_id": null }
}'::jsonb);
INSERT INTO fb_seller_settings_history (version, before, after)
  SELECT version, NULL, value FROM fb_seller_settings WHERE id = 1;

-- ─── Photos and ads ─────────────────────────────────────────────────────────
CREATE TABLE fb_photo_pools (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  note        TEXT NOT NULL DEFAULT '',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX fb_photo_pools_created_by_idx ON fb_photo_pools(created_by);

-- A photo is used once, ever: used_at is set once and never cleared, and the
-- same file (sha256) is refused in every pool.
CREATE TABLE fb_photos (
  id                BIGSERIAL PRIMARY KEY,
  pool_id           BIGINT NOT NULL REFERENCES fb_photo_pools(id) ON DELETE RESTRICT,
  r2_key            TEXT NOT NULL,
  mime              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  width             INTEGER,
  height            INTEGER,
  sha256            TEXT NOT NULL UNIQUE,
  uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at           TIMESTAMPTZ,
  used_by_placement BIGINT
);
CREATE INDEX fb_photos_unused_idx ON fb_photos(pool_id) WHERE used_at IS NULL;
CREATE INDEX fb_photos_pool_id_idx ON fb_photos(pool_id);
CREATE INDEX fb_photos_uploaded_by_idx ON fb_photos(uploaded_by);
CREATE INDEX fb_photos_used_by_placement_idx ON fb_photos(used_by_placement);

CREATE TABLE fb_ads (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  price_usd     NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
  category      TEXT NOT NULL DEFAULT 'Electronics',
  condition     TEXT NOT NULL DEFAULT 'Used - Good',
  renew_days    INTEGER NOT NULL DEFAULT 7 CHECK (renew_days BETWEEN 1 AND 60),
  photo_pool_id BIGINT REFERENCES fb_photo_pools(id) ON DELETE SET NULL,
  photos_min    INTEGER NOT NULL DEFAULT 3,
  photos_max    INTEGER NOT NULL DEFAULT 5,
  state         TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','ready','archived')),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (photos_min BETWEEN 1 AND 10 AND photos_max BETWEEN photos_min AND 10)
);
CREATE INDEX fb_ads_photo_pool_id_idx ON fb_ads(photo_pool_id);
CREATE INDEX fb_ads_created_by_idx ON fb_ads(created_by);
CREATE INDEX fb_ads_updated_by_idx ON fb_ads(updated_by);

-- One ad posted by one account in one location; a renewal is a new row.
CREATE TABLE fb_ad_placements (
  id            BIGSERIAL PRIMARY KEY,
  ad_id         BIGINT NOT NULL REFERENCES fb_ads(id) ON DELETE RESTRICT,
  account_no    INTEGER REFERENCES fb_pool_accounts(no) ON DELETE SET NULL,
  location      TEXT NOT NULL,
  content       JSONB NOT NULL,
  photo_ids     BIGINT[] NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL CHECK (state IN ('needs_photos','queued','live','removing','removed','failed','uncertain')),
  renews_id     BIGINT REFERENCES fb_ad_placements(id) ON DELETE SET NULL,
  fb_listing_id TEXT,
  posted_at     TIMESTAMPTZ,
  next_renew_at TIMESTAMPTZ,
  removed_at    TIMESTAMPTZ,
  last_error    TEXT,
  task_id       BIGINT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_ad_placements_ad_id_idx ON fb_ad_placements(ad_id);
CREATE INDEX fb_ad_placements_account_no_idx ON fb_ad_placements(account_no);
CREATE INDEX fb_ad_placements_renews_id_idx ON fb_ad_placements(renews_id);
CREATE INDEX fb_ad_placements_created_by_idx ON fb_ad_placements(created_by);
ALTER TABLE fb_photos ADD CONSTRAINT fb_photos_used_by_placement_fkey
  FOREIGN KEY (used_by_placement) REFERENCES fb_ad_placements(id) ON DELETE SET NULL;

-- ─── Threads and messages ───────────────────────────────────────────────────
CREATE TABLE fb_threads (
  id               BIGSERIAL PRIMARY KEY,
  account_no       INTEGER REFERENCES fb_pool_accounts(no) ON DELETE SET NULL,
  fb_thread_id     TEXT NOT NULL,
  seller_name      TEXT NOT NULL DEFAULT '',
  listing_title    TEXT NOT NULL DEFAULT '',
  placement_id     BIGINT REFERENCES fb_ad_placements(id) ON DELETE SET NULL,
  stage            TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','screening','negotiating','closing','won','lost')),
  mode             TEXT NOT NULL DEFAULT 'agent' CHECK (mode IN ('agent','human')),
  needs_human      BOOLEAN NOT NULL DEFAULT FALSE,
  human_reason     TEXT,
  human_at         TIMESTAMPTZ,
  offer_usd        NUMERIC(10,2),
  ceiling_usd      NUMERIC(10,2),
  round            INTEGER NOT NULL DEFAULT 0,
  extracted        JSONB NOT NULL DEFAULT '{}',
  last_seq         INTEGER NOT NULL DEFAULT 0,
  last_inbound_at  TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  unread           BOOLEAN NOT NULL DEFAULT FALSE,
  closed_at        TIMESTAMPTZ,
  close_note       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_no, fb_thread_id)
);
CREATE INDEX fb_threads_needs_human_idx ON fb_threads(human_at) WHERE needs_human;
CREATE INDEX fb_threads_placement_id_idx ON fb_threads(placement_id);

-- seq is the ERP's position in the conversation; an outbound stays NULL until
-- an inbox sync sees it land.
CREATE TABLE fb_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL REFERENCES fb_threads(id) ON DELETE CASCADE,
  seq           INTEGER,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out','unknown')),
  author        TEXT NOT NULL CHECK (author IN ('seller','agent','staff','facebook')),
  body          TEXT NOT NULL,
  has_image     BOOLEAN NOT NULL DEFAULT FALSE,
  send_state    TEXT CHECK (send_state IN ('queued','held','sending','sent','uncertain','failed')),
  task_id       BIGINT,
  agent_run_id  BIGINT,
  staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at       TIMESTAMPTZ,
  UNIQUE (thread_id, seq)
);
CREATE INDEX fb_messages_outbox_idx ON fb_messages(send_state, created_at)
  WHERE send_state IN ('queued','held','sending','uncertain');
CREATE INDEX fb_messages_staff_user_id_idx ON fb_messages(staff_user_id);

-- No FK on thread_id, so a thread's history outlives it.
CREATE TABLE fb_thread_events (
  id         BIGSERIAL PRIMARY KEY,
  thread_id  BIGINT NOT NULL,
  kind       TEXT NOT NULL,
  actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT 'system',
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fb_thread_events_thread_idx ON fb_thread_events(thread_id, created_at);
CREATE INDEX fb_thread_events_actor_id_idx ON fb_thread_events(actor_id);

CREATE OR REPLACE FUNCTION fb_thread_events_lock() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fb_thread_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fb_thread_events_no_update BEFORE UPDATE ON fb_thread_events
  FOR EACH ROW EXECUTE FUNCTION fb_thread_events_lock();
CREATE TRIGGER fb_thread_events_no_delete BEFORE DELETE ON fb_thread_events
  FOR EACH ROW EXECUTE FUNCTION fb_thread_events_lock();

-- ─── Agent runs and evaluation ──────────────────────────────────────────────
CREATE TABLE fb_agent_runs (
  id                 BIGSERIAL PRIMARY KEY,
  thread_id          BIGINT REFERENCES fb_threads(id) ON DELETE CASCADE,
  trigger_message_id BIGINT REFERENCES fb_messages(id) ON DELETE SET NULL,
  profile_id         BIGINT REFERENCES fb_agent_profiles(id) ON DELETE SET NULL,
  shadow             BOOLEAN NOT NULL DEFAULT FALSE,
  eval_run_id        BIGINT,
  eval_case_id       BIGINT,
  state              TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  claimed_at         TIMESTAMPTZ,
  input              JSONB,
  decision           JSONB,
  outcome            TEXT CHECK (outcome IN ('send','handoff','noop','blocked','error')),
  model              TEXT,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cost_usd           NUMERIC(10,5),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);
CREATE INDEX fb_agent_runs_queue_idx ON fb_agent_runs(state, created_at) WHERE state IN ('queued','running');
CREATE INDEX fb_agent_runs_thread_id_idx ON fb_agent_runs(thread_id);
CREATE INDEX fb_agent_runs_trigger_message_id_idx ON fb_agent_runs(trigger_message_id);
CREATE INDEX fb_agent_runs_profile_id_idx ON fb_agent_runs(profile_id);
CREATE INDEX fb_agent_runs_eval_run_id_idx ON fb_agent_runs(eval_run_id);
CREATE INDEX fb_agent_runs_eval_case_id_idx ON fb_agent_runs(eval_case_id);

CREATE TABLE fb_agent_eval_cases (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  source_thread_id BIGINT REFERENCES fb_threads(id) ON DELETE SET NULL,
  input            JSONB NOT NULL,
  expected         JSONB NOT NULL,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at      TIMESTAMPTZ
);
CREATE INDEX fb_agent_eval_cases_source_thread_id_idx ON fb_agent_eval_cases(source_thread_id);
CREATE INDEX fb_agent_eval_cases_created_by_idx ON fb_agent_eval_cases(created_by);

CREATE TABLE fb_agent_eval_runs (
  id          BIGSERIAL PRIMARY KEY,
  profile_id  BIGINT NOT NULL REFERENCES fb_agent_profiles(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  cases       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(10,5) NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX fb_agent_eval_runs_profile_id_idx ON fb_agent_eval_runs(profile_id);
CREATE INDEX fb_agent_eval_runs_created_by_idx ON fb_agent_eval_runs(created_by);

ALTER TABLE fb_agent_runs ADD CONSTRAINT fb_agent_runs_eval_run_id_fkey
  FOREIGN KEY (eval_run_id) REFERENCES fb_agent_eval_runs(id) ON DELETE CASCADE;
ALTER TABLE fb_agent_runs ADD CONSTRAINT fb_agent_runs_eval_case_id_fkey
  FOREIGN KEY (eval_case_id) REFERENCES fb_agent_eval_cases(id) ON DELETE SET NULL;

-- ─── The default agent profile, v1 ──────────────────────────────────────────
-- Prices never come from the model: the only number a reply carries is
-- {{offer}}, which code fills from the Market table (src/lib/fbOffer.ts).
INSERT INTO fb_agent_profiles (name, version, state, prompts, skills, rules, models, notes, promoted_at)
VALUES ('default', 1, 'active',
$json${
  "system": "You write Facebook Marketplace messages for Recycle Servers, a used server and parts buyer in Denver, Colorado. We buy servers, memory, drives, CPUs and networking gear from people selling them. Be polite, brief and plain: one short paragraph, no lists, no emoji. Never name a price, a number of dollars or an amount yourself; when the instructions say to make an offer, write the placeholder {{offer}} exactly where the amount goes and nowhere else. Never agree to a deal, confirm a sale, promise payment, or suggest pickup, shipping or a meeting: a person on our team handles those. You are an automated assistant. Never say or suggest you are a person; if asked, say you are Recycle Servers' automated assistant and that someone from the team will pick the conversation up.",
  "extract": "Read the conversation between Recycle Servers (the buyer) and a seller on Facebook Marketplace. From the seller's messages, list each item they are offering with its part number if they gave one, a short description and the quantity if they said it. Note the price they asked for, if any, in US dollars. Classify the seller's latest message as one intent: offer_items, question, counter, agree, decline, logistics, bot_question, hostile, off_topic or other. Set agreeing to true only when the seller accepts our last offer. Give your confidence from 0 to 1. Answer only with the JSON the schema asks for.",
  "skills": {
    "screen": "The seller has not yet told us exactly what they have. Thank them for reaching out and ask for what we need to price it: the exact part numbers or model numbers, how many of each, the condition, and a photo of the labels if they can. Ask only for what is still missing.",
    "negotiate": "We know what the seller has and how many. Make our offer using the placeholder {{offer}} for the amount, say briefly that it reflects current resale prices for used parts, and invite them to reply. If they countered, acknowledge their number without repeating it and give our offer with {{offer}}.",
    "answer": "The seller asked a question. Answer it honestly and briefly from what Recycle Servers is: a buyer of used server hardware in Denver. If they asked whether you are a bot or a person, say exactly: I'm Recycle Servers' automated assistant. Let me get a person on our team to pick this up. Do not make an offer in this message."
  }
}$json$::jsonb,
$json$[
  { "kind": "screen", "enabled": true, "params": {} },
  { "kind": "negotiate", "enabled": true, "params": {} },
  { "kind": "answer", "enabled": true, "params": {} }
]$json$::jsonb,
$json$[
  { "kind": "closing", "enabled": true, "params": { "gap_pct": 10 } },
  { "kind": "no_market_match", "enabled": true, "params": {} },
  { "kind": "price_stale", "enabled": true, "params": {} },
  { "kind": "logistics", "enabled": true, "params": { "words": ["pay", "payment", "paypal", "venmo", "zelle", "cash", "check", "wire", "ship", "shipping", "freight", "ups", "fedex", "usps", "pickup", "pick up", "drop off", "address", "meet", "where are you"] } },
  { "kind": "has_image", "enabled": true, "params": {} },
  { "kind": "unknown_direction", "enabled": true, "params": {} },
  { "kind": "confidence_below", "enabled": true, "params": { "min": 0.6 } },
  { "kind": "intent", "enabled": true, "params": { "kinds": ["hostile", "off_topic"] } },
  { "kind": "bot_question", "enabled": true, "params": {} },
  { "kind": "keyword", "enabled": true, "params": { "patterns": [] } }
]$json$::jsonb,
'{ "extract": "openai/gpt-6-luna", "reply": "openai/gpt-6-luna" }'::jsonb,
'The first profile, seeded with the schema.',
NOW());
