# Facebook chats page (Leads ▸ Facebook) — contract

Ticket: RS-583. Design source of truth: the owner-approved mockup
`fb-chats-design.html` (outside the repo, in `~/archify-previews/`). This file
is the contract between the backend and the three tabs. If you must deviate,
change this file in the same edit and say so in your report.

All types named here are exported from `packages/shared/src/fbChat.ts`
(section "Leads ▸ Facebook"). The frontend client for every endpoint is
`apps/frontend/src/lib/fbChat.ts` (`fbChatApi`).

## 1. Decisions that are settled

- Managers only. Every route below sits behind the existing session +
  `requireManager` gate in `routes/fbChat.ts`.
- The extension contract is frozen. `/api/fb-chat/push/*` and `/enroll` accept
  exactly what extensions 0.2.0 and 0.3.0 send, and answer what they answer
  today. Nothing in this spec adds a required field to them.
- Row fields are snake_case (as the existing reads are); request bodies are
  camelCase (as `PUT /config/:key` is). Errors keep the route file's shape:
  `{ error: 'invalid_request', detail }` 400, `{ error: 'not_found' }` 404,
  `{ error: 'conflict', detail }` 409.
- Text replies only. No archive, no purchase order, no per-user read state.
- The page shows only what the server knows.

## 2. Migration `0241_fb_chat_page.sql`

Next free number on `origin/dev` is **0241** (0240 is `fb_chat_devices`).

```sql
-- Where a reply was typed now includes the ERP, and who typed it there.
ALTER TABLE fb_chat_messages DROP CONSTRAINT fb_chat_messages_source_check;
ALTER TABLE fb_chat_messages ADD CONSTRAINT fb_chat_messages_source_check
  CHECK (source IN ('facebook','telegram','erp'));
ALTER TABLE fb_chat_messages
  ADD COLUMN erp_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX fb_chat_messages_erp_user_idx ON fb_chat_messages(erp_user_id)
  WHERE erp_user_id IS NOT NULL;
-- The chat list reads each chat's newest message and newest reply.
CREATE INDEX fb_chat_messages_thread_idx ON fb_chat_messages(thread_id, id);

-- One read mark per chat, shared by the team: the conversation position
-- (seq) read up to, beside the position of the buyer's newest message.
ALTER TABLE fb_chat_threads
  ADD COLUMN last_inbound_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN read_seq         INTEGER NOT NULL DEFAULT 0;
-- Everything already here has been worked in Telegram: it starts read.
UPDATE fb_chat_threads t SET
  last_inbound_seq = COALESCE((SELECT MAX(m.seq) FROM fb_chat_messages m
                                WHERE m.thread_id = t.id AND m.direction = 'in'), 0),
  read_seq = t.last_seq;
CREATE INDEX fb_chat_threads_unread_idx ON fb_chat_threads(account_id)
  WHERE last_inbound_seq > read_seq;

-- A display number per account (the # on its badge). The id cannot serve:
-- the upsert on every push burns sequence values.
ALTER TABLE fb_chat_accounts
  ADD COLUMN no INTEGER,
  -- Set once a manager names the account, so the extension's own profile
  -- label no longer replaces it.
  ADD COLUMN label_locked BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE fb_chat_accounts a SET no = n.no
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id)::int AS no FROM fb_chat_accounts) n
 WHERE n.id = a.id;
ALTER TABLE fb_chat_accounts ALTER COLUMN no SET NOT NULL;
ALTER TABLE fb_chat_accounts ADD CONSTRAINT fb_chat_accounts_no_key UNIQUE (no);

-- What the manager chose when approving, applied when the device's account
-- is first seen (its Facebook user may not be known at approval).
ALTER TABLE fb_chat_devices
  ADD COLUMN account_label TEXT,
  ADD COLUMN start_paused  BOOLEAN NOT NULL DEFAULT FALSE;
```

Notes for whoever writes the file:

- The comments above are the "why"; keep them, in the migration's own words.
- No foreign key from accounts to devices, on purpose. An account's device is
  `fb_chat_accounts.client_id = 'device:' || fb_chat_devices.id`, which the
  push guard already writes. The nightly prod → dev sync copies accounts from
  prod but keeps dev's own `fb_chat_devices` (`deploy/railway-sync`), so a key
  between them would fail the restore.
- The new device columns have defaults, so the kept dev rows restore over
  them.
- Update `docs/DATABASE.md` for the changed tables.

## 3. Derivation rules

### Unread (shared)

`unread := t.last_inbound_seq > t.read_seq`. Writers:

| Event | Effect on the thread |
| --- | --- |
| `ingestSync` stores a fresh inbound row at seq `s` (new thread or not) | `last_inbound_seq = s` |
| `ingestSync` stores a fresh outbound row, or settles a pending reply, at seq `s` | `read_seq = GREATEST(read_seq, s)` |
| `recordSendResult` outcome `sent` gives the reply seq `s` | `read_seq = GREATEST(read_seq, s)` |
| A reply is queued from Telegram (`handleUpdate`) or the ERP | `read_seq = last_seq` |
| `POST /threads/:id/read` | `read_seq = last_seq` |
| `POST /threads/:id/unread` | `read_seq = LEAST(read_seq, last_inbound_seq - 1)` when `last_inbound_seq > 0`, else nothing |

So a chat is unread while the buyer's message is the newest thing nobody has
opened or answered, wherever the answer was typed. A newly found chat is
unread only if its history ends with the buyer.

### Failed ("Not sent")

`failed :=` the thread's newest outbound message (highest `id` with
`direction = 'out'`) has `send_state IN ('failed','uncertain')`. A later
reply, or a retry, clears it. Old failed replies further up a conversation
still show "Not sent · Retry" on their own bubble.

### Last message and last activity

`last_message` is the thread's row with the highest `id`.
`last_activity_at := GREATEST(t.last_inbound_at, t.last_outbound_at, t.created_at, last_message.created_at)`.
The list is ordered by it, newest first, at most 500 rows.

### Author name

`author_name`: for `source = 'erp'` the `users.name` of `erp_user_id`; for
`'telegram'` the row's `tg_user_name`; otherwise null (an outbound `facebook`
row was typed in Messenger by whoever holds the account; an inbound row is the
buyer).

### Account status

Computed on the client by `fbChatAccountStatus(row, Date.now())` (shared), so
a silent account turns stale without a refetch. First match wins:

1. `restricted` is `'login'` or `'checkpoint'` → that.
2. `device` is not null and `device.status !== 'approved'` → `stale`.
3. `now - last_seen_at > stale_after_sec` → `stale`.
4. `paused` → `paused`.
5. → `running`.

Server inputs:

- `paused`: the account's effective `paused` setting is `true`
  (`configFor(account).values.paused === true`).
- `stale_after_sec`: `max(300, 3 × configPollSec)`, where `configPollSec` is
  the account's effective setting when it is a number, else 60 (the
  extensions' default). An account is touched at least once per settings
  check, so three missed checks is silence.
- `replies_waiting`: its messages with `send_state IN ('queued','sending')`.
- `last_sync_at`: `MAX(fb_chat_threads.last_synced_at)` over its threads.
- `config_state`: `'up_to_date'` when `config_rev` equals the revision
  `configFor(account)` gives now, else `'waiting'` (including never picked
  up).
- `device`: the `fb_chat_devices` row whose id follows `device:` in
  `client_id`; null for a service-client account or a deleted device.
- `unread`: its threads with `last_inbound_seq > read_seq`.

### Account display number and name

- `no` is assigned once, `MAX(no) + 1`, when the account row is created.
- `touchAccount` must stop burning ids and must not race on `no`: `UPDATE …
  RETURNING` first (the common path); only when no row exists, take
  `pg_advisory_xact_lock(hashtextextended('fb-chat-account-no', 0))` and
  insert with the next `no` (`ON CONFLICT (fb_uid) DO UPDATE` as today, for
  the two-requests-at-once case).
- Label: while `label_locked` is false the extension's non-empty label
  replaces it, as today. Once true (a manager named it at approval or with
  `PATCH /accounts/:id`) the extension's label is ignored. `helloDevice` is
  unchanged: `fb_chat_devices.label` stays the Chrome profile's own name and
  is what the page shows as "the Chrome".
- When `touchAccount` creates an account and `clientId` is `device:<id>`: use
  that device's `account_label` as the label (and lock it) when set; and when
  its `start_paused` is true, insert `fb_chat_config (account_id, 'paused',
  true, updated_by = device.decided_by)` and clear `start_paused`. One code
  path: approval never creates the account row itself, so an approved account
  appears on the page at its first check-in (within its settings check).

## 4. Endpoints

All under `/api/fb-chat`. "Unchanged" means request and response stay as they
are today.

### `GET /summary` → `FbChatSummary`

```json
{ "unread": 7, "pending_devices": 2 }
```

`unread`: chats with `last_inbound_seq > read_seq`, all accounts.
`pending_devices`: devices with `status = 'pending'`. Polled every 30 s by the
sidebar; keep it to two counts.

### `GET /threads?account=<id>&q=<text>&filter=all|unread|failed` → `FbChatThreadsAnswer`

All three query parameters are optional. `account`: an account id. `q`:
trimmed, at most 100 characters; case-insensitive substring over
`buyer_name`, `listing_title` and any message `body` of the thread. `filter`
defaults to `all`; an unknown value is 400.

```json
{ "threads": [ {
  "id": 12, "fb_thread_id": "Jaden · $1 - Sell Your Server RAM",
  "account_id": 3, "account_no": 1, "account_label": "Denver RAM Buyer",
  "buyer_name": "Jaden", "buyer_location": "Watertown, MA",
  "rating": 4.8, "rating_count": 23, "joined_year": 2019,
  "listing_id": "1234567890", "listing_title": "$1 - Sell Your Server RAM & SSDs",
  "telegram_topic_id": 5521, "telegram_topic_url": "https://t.me/c/1234567890/5521",
  "last_message": { "direction": "out", "source": "erp", "author_name": "Jin Hu",
                    "body": "Nope", "images": 0, "send_state": "sent",
                    "created_at": "2026-11-12T22:38:00.000Z" },
  "unread": true, "failed": false,
  "last_activity_at": "2026-11-12T22:41:00.000Z", "created_at": "2026-11-03T18:00:00.000Z"
} ] }
```

- The fields the route returns today (`account`, `last_seq`,
  `last_inbound_at`, `last_outbound_at`) may stay; nothing reads them.
- `telegram_topic_url`: `https://t.me/c/<chat id without its -100 prefix>/<topic id>`
  when the thread has a topic and `FB_CHAT_TELEGRAM_CHAT_ID` is a supergroup
  id; else null.
- `last_message.images` is a count. `last_message` is null only for a thread
  with no rows.
- There is no thread address on Facebook (the thread key is derived from its
  title). "Open on Facebook" links to the listing:
  `fbChatListingUrl(listing_id)` on the client, hidden when `listing_id` is
  null.

### `GET /threads/:id/messages` → `FbChatMessagesAnswer`

```json
{ "thread": { "…": "one FbChatThreadRow, as above" },
  "messages": [ {
    "id": 881, "seq": 9, "direction": "out", "source": "erp", "body": "Nope", "images": [],
    "backfill": false, "fb_sent_label": null, "send_state": "sent", "error": null, "typing_ms": 2100,
    "tg_user_name": null, "erp_user_id": "6f0c…", "author_name": "Jin Hu",
    "created_at": "2026-11-12T22:38:00.000Z", "sent_at": "2026-11-12T22:38:09.000Z"
  } ],
  "also_messaged": [ {
    "thread_id": 40, "account_id": 5, "account_no": 3, "account_label": "Front Range Tech",
    "last_body": "Asked about SSD pricing", "last_activity_at": "2026-10-30T19:00:00.000Z"
  } ] }
```

- `messages` keeps today's order: `seq NULLS LAST, id`. Added to today's
  fields: `fb_sent_label`, `erp_user_id`, `author_name`.
- `also_messaged` comes from `fb_chat_buyers`: the other threads with the same
  non-null `buyer_id` (so on other accounts), newest activity first.
  `last_body` is that thread's newest message body. Empty when the buyer's
  profile id is not known yet.
- 404 for an unknown thread.
- Reading does **not** mark the chat read; the page calls `/read`.

### `POST /threads/:id/messages` `FbChatReplyRequest` → 201 `FbChatReplyAnswer`

```json
{ "body": "We can do $38 each." }
```
```json
{ "message": { "…": "the new FbChatMessageRow: source 'erp', send_state 'queued', seq null" } }
```

- `body` is trimmed; empty or longer than `FB_CHAT_REPLY_MAX_CHARS` (2000,
  the same limit Telegram replies have: make `lib/fbChat.ts`'s
  `FB_CHAT_REPLY_MAX` read the shared constant) is 400. Unknown thread 404.
  A leading `/` is sent as typed: the note-to-self rule is Telegram's.
- In one transaction: insert `(thread_id, 'out', 'erp', body, 'queued',
  erp_user_id = the caller, mirrored_at NULL)`, set `read_seq = last_seq`,
  `notifyOutbox`. Then `kickFbChatTelegram()`.
- It is queued whatever the account's state (paused, restricted, stale). It
  goes out when the account next claims.
- Same outbox as Telegram: `claimReply` takes it as it is. `recordSendResult`
  filters `m.source = 'telegram'` today; it must take `'erp'` too.
- Telegram: the mirror pass posts it into the chat's topic because
  `mirrored_at` is null. For `source = 'erp'` the text is
  `↩️ <first word of users.name> (ERP): <body>` (in a transcript line:
  `<first name> (ERP): <body>`). Outbound `facebook` rows stay `↩️ You:`.
- Outcome in Telegram (`ackReplies`, which today skips rows without
  `tg_message_id`): for an `erp` row, `sent` only sets `acked_at`; `failed`
  and `uncertain` post one line into the topic (no `reply_parameters`), e.g.
  `❌ Jin's reply from the ERP was not sent to Facebook: <error>. Retry it in the ERP.`
  and then set `acked_at`.

### `POST /messages/:id/retry` → `FbChatReplyAnswer`

No body. Requeues in place: the row keeps its id, source and author.

- Allowed when `direction = 'out'`, `seq IS NULL` and `send_state IN
  ('failed','uncertain')`: set `send_state = 'queued'`, `error = NULL`,
  `claimed_at = NULL`, `acked_at = NULL`; `notifyOutbox`. A Telegram-typed
  reply retried here gets its 👍 on the original Telegram message when it
  lands, through the existing ack.
- Anything else is 409 (`detail`: "this reply is not waiting for a retry");
  unknown id 404.
- `uncertain` means the text may be on Facebook already. The server allows the
  retry (the owner's decision); the Chats tab words the action accordingly.

### `POST /threads/:id/read`, `POST /threads/:id/unread` → `{ "ok": true }`

No body. Effects in "Unread" above. 404 for an unknown thread. Both are
idempotent.

### `GET /accounts` → `FbChatAccountsAnswer`

```json
{ "accounts": [ {
  "id": 3, "no": 1, "fb_uid": "100089231457", "label": "Denver RAM Buyer",
  "ext_version": "0.3.0", "restricted": null, "restricted_at": null,
  "last_seen_at": "2026-11-12T22:40:20.000Z", "created_at": "2026-11-03T18:00:00.000Z",
  "threads": 41, "unread": 2, "replies_waiting": 0, "last_sync_at": "2026-11-12T22:40:20.000Z",
  "paused": false, "stale_after_sec": 300,
  "config_state": "up_to_date", "config_seen_at": "2026-11-12T22:40:20.000Z",
  "device": { "id": "a1b2c3d4e5f6a7b8c9", "label": "Buyer 1", "status": "approved",
              "ext_version": "0.3.0", "user_agent": "Mozilla/5.0 …", "created_ip": "73.14.202.18",
              "last_seen_at": "2026-11-12T22:40:20.000Z",
              "decided_by": "Jin Hu", "decided_at": "2026-11-03T18:00:00.000Z" }
} ],
  "next_no": 11, "latest_ext_version": "0.3.0" }
```

Ordered by `no`. `next_no` is `MAX(no) + 1` (1 with no accounts).
`latest_ext_version` is the highest `ext_version` in `fb_chat_config_fields`
seen within its freshness window (`compareVersions`), or null: an account on
an older one gets the "Update" chip.

### `PATCH /accounts/:id` `FbChatAccountPatch` → `{ "ok": true }`

`{ "label": "Westside Parts" }`. Trimmed, 1 to `FB_CHAT_ACCOUNT_LABEL_MAX`
(60) characters, else 400; unknown id 404. Sets `label` and `label_locked =
true`. Existing Telegram topics are named after the buyer, so nothing is
renamed there; new topic headers use the new name.

### Pause and resume

No new endpoint. `PUT /config/paused` `{ accountId, value: true|false }` and
`DELETE /config/paused?accountId=` (both unchanged). The client helper
`setFbChatAccountPaused(accountId, paused)` keeps an override only while it
differs from the value every account has.

### `GET /devices` → `{ "devices": FbChatDeviceRow[] }`

Today's rows, plus on each:

```json
"matches_account": { "id": 9, "no": 7, "label": "Westside Parts" }
```

the `fb_chat_accounts` row with the device's `fb_uid`, or null (also null when
the device has no `fb_uid`). On a pending device a non-null value means the
card offers Reconnect.

The Accounts tab shows `status = 'pending'` as request cards. An approved
device that is no account's `device` and has `matches_account === null` is an
approved Chrome that has not checked in yet; show it as a muted "waiting for
its first check-in" row. Rejected and revoked devices are not listed on the
page.

### `POST /devices/:id/approve` body `FbChatDeviceApproval` (optional) → `{ "ok": true }`

```json
{ "label": "Littleton Lots", "startPaused": true }
```

- An empty or absent body behaves as today.
- `label`: trimmed, at most 60 characters; empty counts as absent.
  `startPaused`: boolean. A wrong type is 400.
- The device's `fb_uid` matches no account: store `account_label` and
  `start_paused` on the device (applied at the account's first sight, see
  "Account display number and name").
- It matches an account (Reconnect): `label` and `startPaused` are ignored. In
  the same transaction, revoke that account's current device when it is
  another, approved one (`status = 'revoked'`, `decided_by`, `decided_at`),
  and point the account at this one (`client_id = 'device:<id>'`). The
  account, its chats and its topics are untouched.
- 409 as today when the device is not in a state approval applies to.

`POST /devices/:id/reject` (Deny), `POST /devices/:id/revoke` (Disconnect this
Chrome: the extension is refused from then on, the account and its chats
stay, and the account shows `stale`) and `DELETE /devices/:id` are unchanged.

### `GET /config`, `PUT /config/:key`, `DELETE /config/:key` — unchanged

Typed now as `FbChatConfigPage`, `FbChatConfigWrite`. Settings tab rules:

| Group | Keys |
| --- | --- |
| Sending | `paused`, `minSendIntervalSec`, `typingPace` |
| Reading the inbox | `inboxRefreshMinSec` + `inboxRefreshMaxSec` as one range field, `quietThreadMin` |
| Advanced (closed by default) | `configPollSec`, then every other reported field, then every stored key no extension reports (shown with its raw value and a reset) |

- Labels, help, units, bounds and defaults for the known keys come from the
  mockup's copy through i18n (the extension's own `label`/`help` are English
  only); a field not in the table above uses the extension's `label` and
  `help` as reported. Bounds (`min`, `max`) and `default` always come from the
  reported field.
- A known key no extension reports is not shown.
- The range field writes its two keys with two `PUT`s; when the new shortest
  is above the longest, raise the longest to match, as the mockup does.
- Scope "Every account" writes `accountId: null`; an account's own value is
  an override, reset with `DELETE …?accountId=`.
- `fbChatConfigValue(page, key, accountId)` (shared) gives the effective
  value: own, else shared, else default.

### `GET /telegram` → `FbChatTelegramStatus`

```json
{ "configured": true, "topics": 412 }
```

`configured` is `fbChatTelegramConfigured(env)`; `topics` counts threads with
a `telegram_topic_id`. The card's third cell ("Account alerts: General
topic") is fixed copy.

## 5. Frontend shell (built in the Contract phase)

- Route (`lib/route.ts`): view `leadsFacebook`; `/leads/facebook` (Chats),
  `/leads/facebook/chat/:id` (Chats with a chat open), `/leads/facebook/accounts`,
  `/leads/facebook/settings`. Helpers: `fbChatTabPath(tab)`,
  `fbChatThreadPath(id)`, `matchFbChatRoute(path)`.
- Nav (`lib/desktopNav.ts`): Leads ▸ Facebook, managers only; `DesktopApp.tsx`
  sends a purchaser Home and gives the page the `page-fbchat` variant.
- `pages/desktop/leads/fbchat/FbChatsPage.tsx` renders the page head, the tab
  bar (counts from `useFbChatSummary`), the lede, and one of the three tabs
  inside `.fbc-body`: `.fbc-fill` for Chats (a flex column that fills the
  window; scroll inside your own columns), `.fbc-scroll` for Accounts and
  Settings (the body scrolls).
- Tab props: `ChatsTab({ threadId, showToast })`, `AccountsTab({ showToast })`,
  `SettingsTab({ showToast })`. Open a chat with
  `navigate(fbChatThreadPath(id))`; `threadId` comes back from the route.
- `pages/desktop/leads/fbchat/shared.tsx`: `AccountBadge`, `BuyerAvatar`,
  `AccountHealth`, `fbcHueStyle(no)` (puts `--h` on a wrapper with class
  `fbc-acct`, which defines `--c` and `--cs`).
- `lib/fbChat.ts`: `fbChatApi`, `usePolled(read, ms, deps)`,
  `FB_CHAT_POLL_MS`, `useFbChatSummary`, `fbChatChanged()` (call after a write
  that changes a count: read/unread, approve, deny), `fbChatStatusOf`,
  `fbChatHoldsReplies`, `setFbChatAccountPaused`, `fbChatHue`,
  `fbChatNameHue`, `fbChatInitials`, `fbChatAccountName`, `fbChatListingUrl`,
  `FB_CHAT_STATUS_KEY`.
- `styles/fbChat.css`: page layout, `.fbc-tabs`, `.fbc-lede`, `.fbc-badge`,
  `.fbc-av`, `.fbc-health`, and the three source colours `--fbc-src-erp`,
  `--fbc-src-tg`, `--fbc-src-fb`. Import your own sheet from your tab file.
- Times: `relTime` from `lib/format.ts`.
- i18n: shell keys are `fbc_*` (status labels included). Each tab adds one
  contiguous block with its own prefix, in `lib/i18n.tsx` and `lib/i18n.zh.ts`,
  right after the `fbc_` block. A count's singular is the same key plus `One`
  (`t()` picks it when `n` is 1); both tables need it.

## 6. File ownership

| Owner | Owns (create or edit) | Notes |
| --- | --- | --- |
| **Backend** | `apps/backend/migrations/0241_fb_chat_page.sql`; `apps/backend/src/routes/fbChat.ts`; `apps/backend/src/services/fbChat.ts`, `fbChatConfig.ts`, `fbChatDevices.ts`, `fbChatTelegram.ts`; `apps/backend/src/lib/fbChat.ts`; `apps/backend/tests/fb-chat.test.ts` and new `apps/backend/tests/fb-chat-*.test.ts`; the `fb_chat_*` sections of `docs/DATABASE.md` | The existing extension tests must pass unchanged. May make additive edits to `packages/shared/src/fbChat.ts`; say so in the report. |
| **Chats tab** | `pages/desktop/leads/fbchat/ChatsTab.tsx` and new `pages/desktop/leads/fbchat/Chat*.tsx`; `styles/fbChatChats.css`; i18n prefix `fbcc_` | Mockup: `#view-chats`, `strip()`, `list()`, `convo()`, `details()`, `stamp()`. |
| **Accounts tab** | `pages/desktop/leads/fbchat/AccountsTab.tsx` and new `pages/desktop/leads/fbchat/Account*.tsx`; `styles/fbChatAccounts.css`; i18n prefix `fbca_` | Mockup: `#view-accounts`, `requests()`, `acctTable()`. Rename and disconnect dialogs use `components/Modal.tsx`. |
| **Settings tab** | `pages/desktop/leads/fbchat/SettingsTab.tsx` and new `pages/desktop/leads/fbchat/Setting*.tsx`; `styles/fbChatSettings.css`; i18n prefix `fbcs_`; and, as its last step, removing the page this one replaces: `pages/desktop/settings/FbChatBridgePanel.tsx`, its `fbChat` section in `pages/desktop/DesktopSettings.tsx`, and the `settingsNavFbChat*`, `fbcfg*`, `fbdev*` keys in both i18n tables | Mockup: `#view-settings`, `FIELDS`, `fieldRow()`, `fields()`. Other tabs may read `FbChatBridgePanel.tsx` for reference until it goes; nothing may import it. |
| **Contract (done)** | `packages/shared/src/fbChat.ts`; `apps/frontend/src/lib/fbChat.ts`; `lib/route.ts`, `lib/desktopNav.ts`, `DesktopApp.tsx`, `components/Sidebar.tsx`; `pages/desktop/leads/fbchat/FbChatsPage.tsx`, `shared.tsx`; `styles/fbChat.css`; `fbc_*` i18n keys; this spec; the ticket | Tabs treat these as read-only. If one is wrong, make the smallest fix in place and report it. |
| **Shared by all** | `apps/frontend/src/lib/i18n.tsx`, `apps/frontend/src/lib/i18n.zh.ts` | One contiguous block per owner. If an Edit fails because the file moved, re-read and retry. |

Paths without a root are under `apps/frontend/src/`.

## 7. Left for the wrap-up, owned by nobody above

- Root `package.json` minor bump and its `CHANGELOG.md` section.
- `docs/FEATURES.md`: the chat hub section still describes Settings ▸ Chat
  bridge.
- Mentions of "Settings ▸ Chat bridge" in the root `AGENTS.md` contract
  paragraph and in comments (`packages/shared/src/fbChat.ts`,
  `services/fbChatConfig.ts`, `services/fbChatDevices.ts`, migrations 0238 and
  0240 stay as written).
- The extension's own text that says "approve in Settings ▸ Chat bridge", in
  the extension repo, which this work does not touch.
- Closing RS-583.
