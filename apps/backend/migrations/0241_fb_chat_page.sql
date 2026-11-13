-- The Leads ▸ Facebook page: the chat hub read and answered in the ERP as well
-- as in Telegram.

-- A reply may now be typed in the ERP; the row says so, and who typed it.
ALTER TABLE fb_chat_messages DROP CONSTRAINT fb_chat_messages_source_check;
ALTER TABLE fb_chat_messages ADD CONSTRAINT fb_chat_messages_source_check
  CHECK (source IN ('facebook','telegram','erp'));
ALTER TABLE fb_chat_messages
  ADD COLUMN erp_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX fb_chat_messages_erp_user_idx ON fb_chat_messages(erp_user_id)
  WHERE erp_user_id IS NOT NULL;
-- The chat list reads each chat's newest message and its newest reply.
CREATE INDEX fb_chat_messages_thread_idx ON fb_chat_messages(thread_id, id);

-- One read mark per chat, shared by the team: the conversation position (seq)
-- read up to, beside the position of the buyer's newest message.
ALTER TABLE fb_chat_threads
  ADD COLUMN last_inbound_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN read_seq         INTEGER NOT NULL DEFAULT 0;
-- Everything already here has been worked in Telegram, so it starts read.
UPDATE fb_chat_threads t SET
  last_inbound_seq = COALESCE((SELECT MAX(m.seq) FROM fb_chat_messages m
                                WHERE m.thread_id = t.id AND m.direction = 'in'), 0),
  read_seq = t.last_seq;
CREATE INDEX fb_chat_threads_unread_idx ON fb_chat_threads(account_id)
  WHERE last_inbound_seq > read_seq;

-- A display number per account, the # on its badge. The id cannot serve: the
-- upsert every push used to make burned a sequence value each time.
ALTER TABLE fb_chat_accounts
  ADD COLUMN no INTEGER,
  -- Set once a manager names the account, so the extension's own profile
  -- label no longer replaces the name.
  ADD COLUMN label_locked BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE fb_chat_accounts a SET no = n.no
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id)::int AS no FROM fb_chat_accounts) n
 WHERE n.id = a.id;
ALTER TABLE fb_chat_accounts ALTER COLUMN no SET NOT NULL;
ALTER TABLE fb_chat_accounts ADD CONSTRAINT fb_chat_accounts_no_key UNIQUE (no);

-- What the manager chose when approving, applied when the device's account is
-- first seen: its Facebook user may not be known at approval. No foreign key
-- joins an account to its device (client_id = 'device:' || id is the link):
-- the nightly prod → dev sync copies accounts from prod and keeps dev's own
-- devices, so a key between them would fail the restore.
ALTER TABLE fb_chat_devices
  ADD COLUMN account_label TEXT,
  ADD COLUMN start_paused  BOOLEAN NOT NULL DEFAULT FALSE;
