-- AI review: when a PO reaches Reviewing, a background worker checks every
-- line against its part number, its label photo and the market, and leaves
-- findings for the manager. It never edits a line; a manager applies or
-- dismisses each finding.
--
-- The queued row is inserted in the same transaction as the move, so a move
-- that commits always has its review, and one that rolls back has none.
CREATE TABLE po_ai_reviews (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL CHECK (trigger IN ('stage','manual')),
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','done','failed','superseded')),
  requested_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  model             TEXT,
  -- What the lines looked like when the review read them; a mismatch at
  -- write time means someone edited mid-run.
  lines_hash        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);
CREATE INDEX po_ai_reviews_order_idx ON po_ai_reviews(order_id, created_at DESC);
CREATE INDEX po_ai_reviews_requested_by_idx ON po_ai_reviews(requested_by);
-- One pending review per PO: a second move into Reviewing, or a re-run
-- pressed twice, adds nothing.
CREATE UNIQUE INDEX po_ai_reviews_pending_uidx ON po_ai_reviews(order_id)
  WHERE status IN ('queued','running');
CREATE INDEX po_ai_reviews_queue_idx ON po_ai_reviews(created_at)
  WHERE status IN ('queued','running');

CREATE TABLE po_ai_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID NOT NULL REFERENCES po_ai_reviews(id) ON DELETE CASCADE,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_id         UUID REFERENCES order_lines(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('error','warn','info')),
  -- The line field the finding is about (LineFields key), or NULL for one
  -- that proposes nothing to apply (a price note).
  field           TEXT,
  -- What kind of finding, for the client to word: spec_mismatch, spec_blank,
  -- pn_label_differs, pn_misread, pn_missing, cost_missing, above_market,
  -- budget_exhausted.  `message` is the same in English, for the log and
  -- the notification.
  code            TEXT NOT NULL,
  current_value   TEXT,
  suggested_value TEXT,
  message         TEXT NOT NULL,
  confidence      REAL,
  sources         JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolution      TEXT CHECK (resolution IN ('applied','dismissed')),
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX po_ai_findings_review_idx ON po_ai_findings(review_id);
CREATE INDEX po_ai_findings_order_idx ON po_ai_findings(order_id);
CREATE INDEX po_ai_findings_line_idx ON po_ai_findings(line_id);
CREATE INDEX po_ai_findings_resolved_by_idx ON po_ai_findings(resolved_by);

-- What the web says a part number is, paid for once. Keyed by the canonical
-- part number (partNumberCanon), so separators and label prefixes share a row.
CREATE TABLE part_number_lookups (
  canon_pn    TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  specs       JSONB NOT NULL,
  source_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  model       TEXT,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Off until a manager turns it on: every review spends OpenRouter credit.
INSERT INTO workspace_settings (key, value)
VALUES ('po_ai_review', '{"enabled": false, "webLookup": true, "maxCostPerPoUsd": 0.5}'::jsonb)
ON CONFLICT (key) DO NOTHING;
