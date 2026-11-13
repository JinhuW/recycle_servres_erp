// Facebook chat hub: the owner's Chrome extensions push their Marketplace
// inboxes to /api/fb-chat/push/* and claim the replies typed in Telegram. The
// extension lives outside this repo (facebook_messager_extenion/ in the
// workspace), so this file is an HTTP contract: change it on both sides.

export type FbChatDirection = 'in' | 'out';

/** One message bubble as the page showed it. */
export type FbChatRow = {
  direction: FbChatDirection;
  text: string;
  /** Image URLs on the bubble. They are signed and expire. */
  images: string[];
  /** When it was sent, in Facebook's own words ("Tuesday 5:57pm"). */
  at?: string;
};

export type FbChatBuyer = {
  name: string | null;
  profileId: string | null;
  location: string | null;
  joinedYear: number | null;
  /** Marketplace star average, 0 to 5. */
  rating: number | null;
  ratingCount: number | null;
};

export type FbChatListing = { id: string | null; title: string | null };

export type FbChatAccountRef = {
  /** The Facebook numeric uid the tab is logged in as. */
  fbUid: string;
  /** What the owner calls this Chrome profile. */
  label: string;
  extVersion?: string;
};

/** `POST /push/sync`: the window of one conversation, oldest first. */
export type FbChatSyncPush = {
  account: FbChatAccountRef;
  thread: {
    /**
     * The extension's key for the conversation. Facebook's page shows no id
     * for one, so the key is derived from its title (`<buyer> · <listing>`):
     * stable, but not a number and not part of any Facebook address.
     */
    fbThreadId: string;
    buyer: FbChatBuyer;
    listing: FbChatListing;
    rows: FbChatRow[];
    /** The extension tried to scroll to the first message before reading. */
    full: boolean;
    /** It got there: `rows` is the whole conversation. */
    complete: boolean;
  };
};

export type FbChatSyncAnswer = {
  /**
   * The thread is new here and the push was not `full`: nothing was stored.
   * Read the whole conversation and push again.
   */
  needsFull: boolean;
  added: number;
};

/** `POST /push/buyer`: what the buyer's own Marketplace profile page showed. */
export type FbChatBuyerPush = {
  account: FbChatAccountRef;
  fbThreadId: string;
  buyer: FbChatBuyer;
};

/** `POST /push/outbox/claim`. Answers 204 when nothing is queued. */
export type FbChatClaimRequest = {
  account: FbChatAccountRef;
  /** Longest the hub may hold the request open, seconds. */
  wait?: number;
};

export type FbChatClaimAnswer = { id: number; fbThreadId: string; body: string };

/** `POST /push/outbox/:id/result`. */
export type FbChatSendResult = {
  account: FbChatAccountRef;
  /** `uncertain`: typed and submitted, but the bubble was not seen. */
  outcome: 'sent' | 'failed' | 'uncertain';
  error?: string;
  typingMs?: number;
};

export const FB_CHAT_EVENT_KINDS = ['restricted', 'recovered', 'error'] as const;
export type FbChatEventKind = (typeof FB_CHAT_EVENT_KINDS)[number];

/** `POST /push/events`. */
export type FbChatEventPush = {
  account: FbChatAccountRef;
  kind: FbChatEventKind;
  fbThreadId?: string;
  detail?: Record<string, unknown>;
};

/** Longest claim hold the hub grants, seconds. */
export const FB_CHAT_MAX_WAIT_SEC = 25;
/** A claimed reply not reported within this is marked uncertain, never resent. */
export const FB_CHAT_SEND_STALE_MS = 5 * 60_000;

// ── Remote settings ───────────────────────────────────────────────────────────
// The extension's options page holds only what it takes to reach the ERP.
// Everything else is set on Settings ▸ Chat bridge. The set of settings is not
// fixed here: each extension reports the fields it understands, the page draws
// its form from them, and values are plain JSON. An extension ignores a key it
// does not know, so the ERP may hold keys ahead of an extension release.

export const FB_CHAT_CONFIG_TYPES = ['boolean', 'integer', 'number', 'string', 'json'] as const;
export type FbChatConfigType = (typeof FB_CHAT_CONFIG_TYPES)[number];
export const FB_CHAT_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** Largest stored value, as JSON text. */
export const FB_CHAT_CONFIG_VALUE_MAX = 16_000;

export type FbChatConfigField = {
  key: string;
  label: string;
  help?: string;
  type: FbChatConfigType;
  default: unknown;
  min?: number;
  max?: number;
  unit?: string;
  /** For a `string` field: the only values allowed. */
  options?: string[];
};

/** `POST /push/config`. */
export type FbChatConfigRequest = {
  /** Absent until the extension's tab has seen which account is logged in. */
  account?: FbChatAccountRef;
  extVersion: string;
  fields: FbChatConfigField[];
};

export type FbChatConfigAnswer = {
  /** Changes whenever `values` does. */
  rev: string;
  /** Only what the ERP sets; a profile's own value wins over the shared one. */
  values: Record<string, unknown>;
};

/** Why `value` does not fit `field`, or null when it does. */
export function fbChatConfigProblem(field: FbChatConfigField, value: unknown): string | null {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (field.type === 'integer' && !Number.isInteger(value)) return 'must be a whole number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return 'must be text';
      return field.options && !field.options.includes(value) ? `must be one of ${field.options.join(', ')}` : null;
    case 'json':
      return null;
  }
}

// ── Enrollment ───────────────────────────────────────────────────────
// An extension needs nothing typed in. With no device it asks `POST /enroll`
// (no auth) and gets a token; it then waits, asking `POST /push/device`, until
// a manager approves it on Settings ▸ Chat bridge, where its pairing code is
// shown next to the one on the extension's options page. The bearer it sends
// on every push route is `fbd_<deviceId>_<token>`.

export const FB_CHAT_DEVICE_STATUSES = ['pending', 'approved', 'rejected', 'revoked'] as const;
export type FbChatDeviceStatus = (typeof FB_CHAT_DEVICE_STATUSES)[number];
export const FB_CHAT_DEVICE_BEARER_PREFIX = 'fbd_';

/** `POST /enroll`. Every field is optional and only shown to the approver. */
export type FbChatEnrollRequest = {
  label?: string;
  extVersion?: string;
  fbUid?: string;
};

export type FbChatEnrollAnswer = {
  deviceId: string;
  /** Shown once; the ERP keeps only its hash. */
  token: string;
  /** `XXXX-XXXX`, shown on both sides. */
  code: string;
  status: FbChatDeviceStatus;
};

/** `POST /push/device`: the extension's hello while it waits, and after. */
export type FbChatDeviceHello = FbChatEnrollRequest;
export type FbChatDeviceAnswer = { deviceId: string; code: string; status: FbChatDeviceStatus };

/**
 * What `/push/*` answers a device that may not push yet: 403 with
 * `device_pending`, or `device_rejected` once refused or revoked.
 */
export type FbChatDeviceRefusal = { error: 'device_pending' | 'device_rejected' };

/** A row on Settings ▸ Chat bridge ▸ Extensions. */
export type FbChatDevice = {
  id: string;
  code: string;
  status: FbChatDeviceStatus;
  label: string;
  fb_uid: string | null;
  ext_version: string | null;
  created_ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

// ── Leads ▸ Facebook (the manager page) ───────────────────────────────────────
// Everything below is read and written by the ERP's own page, never by an
// extension, so it may change with the page. Rows keep the database's
// snake_case, as the older reads here do.

/** Where an outbound message was typed. Inbound ones are always `facebook`. */
export const FB_CHAT_MESSAGE_SOURCES = ['facebook', 'telegram', 'erp'] as const;
export type FbChatMessageSource = (typeof FB_CHAT_MESSAGE_SOURCES)[number];

export const FB_CHAT_SEND_STATES = ['queued', 'sending', 'sent', 'failed', 'uncertain'] as const;
export type FbChatSendState = (typeof FB_CHAT_SEND_STATES)[number];

/** Longest reply the hub takes, from Telegram or the ERP. */
export const FB_CHAT_REPLY_MAX_CHARS = 2000;
export const FB_CHAT_ACCOUNT_LABEL_MAX = 60;

export type FbChatLastMessage = {
  direction: FbChatDirection;
  source: FbChatMessageSource;
  /** Who typed an outbound one: the ERP user or the Telegram sender. Null when typed on Facebook, and for the buyer. */
  author_name: string | null;
  body: string;
  /** How many photos the bubble carried. */
  images: number;
  send_state: FbChatSendState | null;
  created_at: string;
};

/** One row of `GET /threads`, and `thread` of `GET /threads/:id/messages`. */
export type FbChatThreadRow = {
  id: number;
  fb_thread_id: string;
  account_id: number;
  /** The account's display number, the `#` on its badge. */
  account_no: number;
  account_label: string;
  buyer_name: string | null;
  buyer_location: string | null;
  rating: number | null;
  rating_count: number | null;
  joined_year: number | null;
  listing_id: string | null;
  listing_title: string | null;
  telegram_topic_id: number | null;
  /** A t.me link to the topic; null without a topic or when Telegram is not set up. */
  telegram_topic_url: string | null;
  last_message: FbChatLastMessage | null;
  /** The buyer wrote after the team last read or answered. One mark for everyone. */
  unread: boolean;
  /** A reply failed or may not have arrived, and nothing was sent after it. */
  failed: boolean;
  last_activity_at: string;
  created_at: string;
};

export const FB_CHAT_THREAD_FILTERS = ['all', 'unread', 'failed'] as const;
export type FbChatThreadFilter = (typeof FB_CHAT_THREAD_FILTERS)[number];

/** Query of `GET /threads`. */
export type FbChatThreadsQuery = {
  account?: number;
  q?: string;
  filter?: FbChatThreadFilter;
};
export type FbChatThreadsAnswer = { threads: FbChatThreadRow[] };

export type FbChatMessageRow = {
  id: number;
  /** Null while a reply has not been seen on Facebook yet. */
  seq: number | null;
  direction: FbChatDirection;
  source: FbChatMessageSource;
  body: string;
  images: string[];
  /** Read with the history when the chat was first found; `created_at` is then when it was read. */
  backfill: boolean;
  /** Facebook's own wording for when it was sent, where the page showed one. */
  fb_sent_label: string | null;
  send_state: FbChatSendState | null;
  error: string | null;
  typing_ms: number | null;
  tg_user_name: string | null;
  erp_user_id: string | null;
  /** The ERP user's name for `erp`, the Telegram sender's for `telegram`, else null. */
  author_name: string | null;
  created_at: string;
  sent_at: string | null;
};

/** The same buyer's chat on another of our accounts. */
export type FbChatAlsoMessaged = {
  thread_id: number;
  account_id: number;
  account_no: number;
  account_label: string;
  last_body: string | null;
  last_activity_at: string;
};

/** `GET /threads/:id/messages`. */
export type FbChatMessagesAnswer = {
  thread: FbChatThreadRow;
  messages: FbChatMessageRow[];
  also_messaged: FbChatAlsoMessaged[];
};

/** `POST /threads/:id/messages`: a reply typed in the ERP. */
export type FbChatReplyRequest = { body: string };
/**
 * Body of `POST /messages/:id/retry`. A `failed` reply needs none. An
 * `uncertain` one may already be on Facebook, so the hub refuses to send it
 * again (409) unless `force` is true.
 */
export type FbChatRetryRequest = { force?: boolean };
/** Answer of `POST /threads/:id/messages` and `POST /messages/:id/retry`. */
export type FbChatReplyAnswer = { message: FbChatMessageRow };

/** The Chrome that relays an account. */
export type FbChatAccountDevice = {
  id: string;
  /** The Chrome profile's name, as the extension reports it. */
  label: string;
  status: FbChatDeviceStatus;
  ext_version: string | null;
  user_agent: string | null;
  created_ip: string | null;
  last_seen_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

export type FbChatConfigState = 'up_to_date' | 'waiting';

/** One row of `GET /accounts`. */
export type FbChatAccountRow = {
  id: number;
  /** Display number: 1, 2, 3 in the order the accounts were first seen. Never reused. */
  no: number;
  fb_uid: string;
  label: string;
  ext_version: string | null;
  restricted: 'login' | 'checkpoint' | null;
  restricted_at: string | null;
  last_seen_at: string;
  created_at: string;
  threads: number;
  unread: number;
  /** Replies queued or being typed. */
  replies_waiting: number;
  /** The newest conversation window it pushed; null before the first. */
  last_sync_at: string | null;
  /** The `paused` setting it gets, its own or every account's. */
  paused: boolean;
  /** Silent for longer than this, it counts as not checking in. */
  stale_after_sec: number;
  config_state: FbChatConfigState;
  config_seen_at: string | null;
  /** Null for an account set up with a service client, or whose device was deleted. */
  device: FbChatAccountDevice | null;
};

export type FbChatAccountsAnswer = {
  accounts: FbChatAccountRow[];
  /** The number the next new account gets. */
  next_no: number;
  /** The newest version any extension has reported; null before any has. */
  latest_ext_version: string | null;
};

/** `PATCH /accounts/:id`. */
export type FbChatAccountPatch = { label: string };

export const FB_CHAT_ACCOUNT_STATUSES = ['running', 'paused', 'login', 'checkpoint', 'stale'] as const;
export type FbChatAccountStatus = (typeof FB_CHAT_ACCOUNT_STATUSES)[number];

/**
 * What the Accounts tab says about an account. A Facebook wall outranks
 * silence, since it is the thing to act on; a pause only shows on an account
 * that is otherwise working.
 */
export function fbChatAccountStatus(
  a: Pick<FbChatAccountRow, 'restricted' | 'last_seen_at' | 'stale_after_sec' | 'paused' | 'device'>,
  nowMs: number,
): FbChatAccountStatus {
  if (a.restricted) return a.restricted;
  if (a.device && a.device.status !== 'approved') return 'stale';
  if (nowMs - Date.parse(a.last_seen_at) > a.stale_after_sec * 1000) return 'stale';
  return a.paused ? 'paused' : 'running';
}

/** Body of `POST /devices/:id/approve`. Both ignored when the device reconnects a known account. */
export type FbChatDeviceApproval = {
  /** The account's name. Without one the Chrome profile's own name is used. */
  label?: string;
  /** The account reads its inbox but types nothing until sending is turned on. */
  startPaused?: boolean;
};

/** One row of `GET /devices`. */
export type FbChatDeviceRow = FbChatDevice & {
  /** The account this device's Facebook user already is. Approving it reconnects that account. */
  matches_account: { id: number; no: number; label: string } | null;
};

/** `GET /summary`: the counts on the sidebar and the page's tabs. */
export type FbChatSummary = {
  /** Chats with an unread message, across all accounts. */
  unread: number;
  /** Extensions waiting for approval. */
  pending_devices: number;
};

/** `GET /telegram`. */
export type FbChatTelegramStatus = {
  configured: boolean;
  /** Chats that have a topic. */
  topics: number;
};

/** `GET /config`: what Settings draws its form from. */
export type FbChatKnownConfigField = FbChatConfigField & {
  /** Recent extension versions that report this field, newest first. */
  versions: string[];
};
export type FbChatConfigEntry = {
  /** Null: the value for every account. */
  account_id: number | null;
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
};
export type FbChatConfigAccount = {
  id: number;
  fb_uid: string;
  label: string;
  ext_version: string | null;
  last_seen_at: string;
  config_rev: string | null;
  config_seen_at: string | null;
  expected_rev: string;
};
export type FbChatConfigPage = {
  fields: FbChatKnownConfigField[];
  entries: FbChatConfigEntry[];
  accounts: FbChatConfigAccount[];
};

/** Body of `PUT /config/:key`. */
export type FbChatConfigWrite = { accountId?: number | null; value: unknown };

/**
 * The value an account runs with: its own, else every account's, else the
 * field's default. `accountId` null reads the shared value.
 */
export function fbChatConfigValue(page: Pick<FbChatConfigPage, 'fields' | 'entries'>, key: string, accountId: number | null): unknown {
  const own = accountId === null ? undefined : page.entries.find((e) => e.key === key && e.account_id === accountId);
  if (own) return own.value;
  const shared = page.entries.find((e) => e.key === key && e.account_id === null);
  if (shared) return shared.value;
  return page.fields.find((f) => f.key === key)?.default;
}
