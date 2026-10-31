// Reddit leads: sellers from the swap subreddits' trade-bot records that
// purchasers claim and work from a first DM to a deal. Shared by the
// /api/leads/reddit routes and the Leads ▸ Reddit page.

export const REDDIT_LEAD_STAGES = ['claimed', 'dm', 'replied', 'talks', 'won'] as const;
export type RedditLeadStage = (typeof REDDIT_LEAD_STAGES)[number];

/** Why an open lead was closed without a deal. '' = not closed. */
export const REDDIT_LEAD_CLOSINGS = ['nostock', 'lost'] as const;
export type RedditLeadClosing = (typeof REDDIT_LEAD_CLOSINGS)[number];

export type RedditLeadEventKind =
  | 'imported' | 'claimed' | 'released' | 'dm' | 'reply'
  | 'stage' | 'follow_up' | 'closed' | 'reopened';

/** A claim this old with no DM yet is stale: a manager should free it. */
export const REDDIT_LEAD_STALE_HOURS = 48;
/** A sent DM gets a nudge this many days later unless a date is set. */
export const REDDIT_LEAD_DM_FOLLOW_UP_DAYS = 3;
/** "No stock now" comes back as a follow-up this many days later. */
export const REDDIT_LEAD_NOSTOCK_DAYS = 30;
export const REDDIT_LEAD_REPLY_MAX = 2000;
export const REDDIT_LEAD_IMPORT_MAX = 5000;

export interface RedditLeadReply {
  text: string;
  at: number;
  by: string;
}

/**
 * One seller as the caller may see it. For a seller someone else holds, a
 * purchaser gets `claimed: true` and nothing about the holder or the
 * conversation: holder, stage, follow-up and replies stay null/defaults.
 */
export interface RedditLead {
  username: string;
  name: string;
  sales: number;
  buys: number;
  recordSource: string;
  subreddits: string[];
  lastDeal: string | null;
  itemsSold: string[];
  latestPostTitle: string;
  latestPostUrl: string;
  trackerAlerts: number;
  claimed: boolean;
  mine: boolean;
  holderId: string | null;
  holderName: string | null;
  claimedAt: number | null;
  stage: RedditLeadStage;
  closed: RedditLeadClosing | '';
  followUp: string | null;
  dmAt: number | null;
  lastReply: RedditLeadReply | null;
}

export interface RedditLeadEvent {
  at: number;
  actor: string;
  kind: RedditLeadEventKind;
  detail: string;
}

export interface RedditBuyer {
  username: string;
  name: string;
  buys: number;
  sales: number;
  sellers: number;
}

export interface RedditBuyerTrade {
  item: string;
  date: string | null;
  url: string;
  subreddit: string;
}

export interface RedditBuyerTree {
  buyer: RedditBuyer;
  sellers: { username: string; name: string; trades: RedditBuyerTrade[] }[];
}

export interface RedditLeadImportSeller {
  name: string;
  sales: number;
  buys: number;
  recordSource?: string;
  subreddits?: string[];
  lastDeal?: string | null;
  itemsSold?: string[];
  latestPostTitle?: string;
  latestPostUrl?: string;
  trackerAlerts?: number;
}

export interface RedditLeadImport {
  sellers: RedditLeadImportSeller[];
  buyers?: { name: string; buys: number; sales: number }[];
  trades?: { buyer: string; seller: string; item?: string; date?: string | null; url?: string; subreddit?: string }[];
}

/** Reddit names are case-insensitive; the key is lower case, no `u/`. */
export function redditKey(name: string): string {
  return name.trim().replace(/^\/?u\//i, '').toLowerCase();
}

export function isRedditName(key: string): boolean {
  return /^[a-z0-9_-]{2,30}$/.test(key);
}

export const isRedditLeadStage = (v: unknown): v is RedditLeadStage =>
  typeof v === 'string' && (REDDIT_LEAD_STAGES as readonly string[]).includes(v);

export const isRedditLeadClosing = (v: unknown): v is RedditLeadClosing =>
  typeof v === 'string' && (REDDIT_LEAD_CLOSINGS as readonly string[]).includes(v);

type LeadState = Pick<RedditLead, 'claimed' | 'stage' | 'closed' | 'followUp' | 'claimedAt'>;

/** Still being worked: claimed, not closed, no deal yet. */
export function redditLeadIsOpen(l: LeadState): boolean {
  return l.claimed && l.closed === '' && l.stage !== 'won';
}

export function redditLeadIsStale(l: LeadState, now: number): boolean {
  return l.claimed && l.stage === 'claimed' && l.closed === '' && l.claimedAt !== null
    && now - l.claimedAt > REDDIT_LEAD_STALE_HOURS * 3_600_000;
}

/** `today` is the caller's local date, YYYY-MM-DD. */
export function redditLeadIsDue(l: LeadState, today: string): boolean {
  return redditLeadIsOpen(l) && l.followUp !== null && l.followUp <= today;
}

/**
 * Where a lead sits in its holder's queue: 0 follow-up due, 1 waiting for a
 * first DM, 2 in conversation, 3 closed or won.
 */
export function redditLeadRank(l: LeadState, today: string): number {
  if (redditLeadIsDue(l, today)) return 0;
  if (!redditLeadIsOpen(l)) return 3;
  return l.stage === 'claimed' ? 1 : 2;
}

/** A lead needs its holder now: a first DM or a due follow-up. */
export function redditLeadNeedsAction(l: LeadState, today: string): boolean {
  return redditLeadRank(l, today) <= 1;
}
