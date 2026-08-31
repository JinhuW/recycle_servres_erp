// Client (buy-side) types and the plain-language labels the screen uses.
//
// The API speaks in system terms — tier A/B/C, health quiet/lost, prospect.
// A purchaser never sees any of those words: they see "Top seller", "Gone
// quiet", "New lead". Keeping the translation in one place means a future
// field cannot leak the internal vocabulary into the UI by accident.

export type Tier = 'A' | 'B' | 'C';
export type Health = 'new' | 'ok' | 'quiet' | 'lost';
export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export type Standing = 'prospect' | 'active' | 'archived';
export type ContactKind = 'call' | 'text' | 'visit' | 'offer' | 'note';

export type ClientAddress = {
  street1: string | null; street2: string | null; city: string | null;
  state: string | null; zip: string | null; country: string | null;
};

export type Client = {
  id: string; name: string; company: string | null;
  phone: string | null; email: string | null;
  address: ClientAddress;
  ownerId: string | null; ownerName: string | null;
  source: string; status: Standing; supplies: string[];
  preferences: {
    payment: string | null; logistics: string | null; contact: string | null;
    bestTime: string | null; price: string | null;
  };
  notes: string | null;
  tier: Tier; tierPinned: boolean; cadenceDays: number; health: Health;
  typicalGapDays: number | null; measuredGapDays: number;
  poCount: number; spendTotal: number; spendRecent: number;
  lastPoAt: string | null; daysSinceLastPo: number | null;
  itemTypes: string[];
  /** Days-ago per purchase order, newest first — the rhythm strip's marks. */
  rhythm: number[];
  nextFollowUpAt: string | null; lastContactedAt: string | null;
  daysUntilDue: number | null; dueState: DueState;
  createdAt: string;
};

export type ClientNote = {
  id: string; kind: ContactKind | 'owner_changed'; body: string;
  created_at: string; author: string | null;
};

export type ClientDetail = Client & {
  canEdit: boolean;
  /** The contact log. Deliberately not called `notes` — `Client.notes` is the
   *  client's own free-text note, and naming both the same silently replaced
   *  the string with these rows. */
  timeline: ClientNote[];
  orders: { id: string; lifecycle: string; total_cost: number | null; created_at: string }[];
  sold: { item_type: string; qty: number; spend: number }[];
  rhythm: number[];
};

export type Suggestion = {
  matchKey: string; name: string; ownerId: string | null;
  city: string | null; state: string | null; zip: string | null;
  phone: string | null; street1: string | null; street2: string | null;
  country: string | null; poCount: number; spend: number;
  lastSeen: string; source: 'shipping' | 'package';
};

export type ClientList = {
  items: Client[];
  counts: { due: number; soon: number; quiet: number; total: number };
  settings: { cadenceDays: Record<string, number> };
};

/** i18n keys, so the plain words are translatable and the mapping lives once. */
export const TIER_KEY: Record<Tier, string> = {
  A: 'cliTierTop', B: 'cliTierRegular', C: 'cliTierOccasional',
};
export const HEALTH_KEY: Record<Health, string> = {
  new: 'cliHealthNew', ok: 'cliHealthOk', quiet: 'cliHealthQuiet', lost: 'cliHealthLost',
};
export const HEALTH_TONE: Record<Health, 'pos' | 'warn' | 'muted' | 'info'> = {
  new: 'info', ok: 'pos', quiet: 'warn', lost: 'muted',
};
export const KIND_KEY: Record<ContactKind, string> = {
  call: 'cliKindCall', text: 'cliKindText', visit: 'cliKindVisit',
  offer: 'cliKindOffer', note: 'cliKindNote',
};

/** "3 days late" / "Call today" / "In 5 days" — never a raw date the reader
 *  has to subtract from today in their head. */
export function dueLabel(
  c: Pick<Client, 'dueState' | 'daysUntilDue'>,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  switch (c.dueState) {
    case 'overdue': {
      const n = Math.abs(c.daysUntilDue ?? 0);
      return n === 1 ? t('cliDueLate1') : t('cliDueLate', { n });
    }
    case 'today':   return t('cliDueToday');
    case 'soon':
    case 'later':   return (c.daysUntilDue ?? 0) === 1
      ? t('cliDueIn1') : t('cliDueIn', { n: c.daysUntilDue ?? 0 });
    default:        return t('cliDueNone');
  }
}

export function dueTone(s: DueState): 'neg' | 'info' | 'muted' {
  if (s === 'overdue' || s === 'today') return 'neg';
  if (s === 'soon') return 'info';
  return 'muted';
}

/** What the backend writes when a contact is logged with no typed note. The
 *  timeline shows the kind in its meta line, so repeating it as the body reads
 *  as a stutter ("Called" / "Called · Aug 28"). */
const AUTO_BODIES = new Set(['Called', 'Texted', 'Visited', 'Made an offer', 'Note']);
export function isAutoBody(body: string): boolean {
  return AUTO_BODIES.has(body.trim());
}

/** Days-ago marks for the rhythm strip, from ISO order dates. */
export function rhythmMarks(orders: { created_at: string }[]): number[] {
  const now = Date.now();
  return orders.map((o) =>
    Math.max(0, Math.round((now - new Date(o.created_at).getTime()) / 86_400_000)));
}
