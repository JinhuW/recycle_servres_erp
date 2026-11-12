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
