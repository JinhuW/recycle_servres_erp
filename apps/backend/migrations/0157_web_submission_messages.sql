-- The email conversation on a web submission. Replies go out over SMTP from
-- one shared company mailbox; the customer's answers are pulled back from its
-- INBOX over IMAP and land on the same thread.
--
-- message_id is the RFC 5322 Message-ID and the dedupe key: two backend
-- instances overlapping during a deploy both see the same inbound mail, and
-- only one row may survive. A message that arrived without one gets a
-- synthetic `imap:<uidvalidity>:<uid>` key, which is never used for threading.
--
-- Attachments on a reply are only named here; the files stay in the mailbox.
CREATE TABLE web_submission_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id     TEXT NOT NULL REFERENCES web_submissions(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  from_addr         TEXT NOT NULL,
  to_addr           TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body_text         TEXT NOT NULL DEFAULT '',
  message_id        TEXT NOT NULL UNIQUE,
  in_reply_to       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'received')),
  error             TEXT,
  -- The receiving server's DMARC verdict for inbound mail, when it reports
  -- one. A From header is trivially forged, and a forged "pay me at this new
  -- PayPal address" on a seller's thread is the case this exists for.
  dmarc             TEXT,
  attachment_names  TEXT[] NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX web_submission_messages_submission_idx
  ON web_submission_messages (submission_id, created_at);
CREATE INDEX web_submission_messages_author_idx
  ON web_submission_messages (author_id);

-- How far the IMAP poll has read, per mailbox. Keyed by the account too, so
-- pointing MAIL_USER at a different box can't inherit this one's watermark.
-- A changed UIDVALIDITY means the server renumbered the folder and the
-- watermark is meaningless.
CREATE TABLE mail_sync_state (
  account       TEXT NOT NULL,
  mailbox       TEXT NOT NULL,
  uid_validity  BIGINT NOT NULL,
  last_uid      BIGINT NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account, mailbox)
);
