// The shapes both post sources share: the poll loop's OAuth reads
// (redditOAuth.ts) and the redditapis.com webhook (webhook.ts).
//
// Reddit has no logged-out way in any more. The anonymous JSON API is
// 403-blocked, and the Atom feeds were withdrawn in November 2026 (see
// docs/debug-notes/reddit-new-rss-404.md), so reading Reddit directly needs
// OAuth credentials.

export interface RedditPost {
  redditId: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string | null;
  flair: string | null;
  url: string;
  postedAt: Date;
}

export interface RateLimitHint {
  /** Requests left in the current window, as reported by Reddit. */
  remaining?: number;
  /** Seconds until the window resets. */
  resetSeconds?: number;
}

export type FetchResult =
  | {kind: 'ok'; posts: RedditPost[]; rateLimit: RateLimitHint}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'error'; message: string};

export interface RedditComment {
  author: string | null;
  text: string;
}

export type CommentsResult =
  | {kind: 'ok'; comments: RedditComment[]; rateLimit: RateLimitHint}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'gone'}
  | {kind: 'error'; message: string};

/** Reddit's ceiling for one comment page; a thread longer than this is rare on a sale post. */
export const COMMENTS_LIMIT = 500;

/**
 * Reads a numeric header. Returns undefined for an absent header — plain
 * Number() would turn that null into 0, which reads as "no wait needed".
 */
export function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function readRateLimit(headers: Headers): RateLimitHint {
  const remaining = numericHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = numericHeader(headers, 'x-ratelimit-reset');
  return {
    ...(remaining !== undefined ? {remaining} : {}),
    ...(resetSeconds !== undefined ? {resetSeconds} : {}),
  };
}
