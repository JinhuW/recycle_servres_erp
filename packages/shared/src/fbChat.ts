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
