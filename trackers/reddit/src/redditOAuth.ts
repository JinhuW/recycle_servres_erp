// Reads new posts and comments through Reddit's OAuth Data API.
//
// Reddit withdrew logged-out RSS in November 2026, so every anonymous feed
// URL now returns an Atom "Not Found" (docs/debug-notes/reddit-new-rss-404.md).
// This uses app-only OAuth (grant_type=client_credentials): a client id and
// secret from a "script" app at reddit.com/prefs/apps, with no user account.
// It reads the same r/a+b+c multireddit listing in one request, so the poll
// loop's one-request-per-cycle invariant holds.

import type {RedditComment, RedditPost, RateLimitHint} from './reddit.ts';

export interface RedditAuth {
  clientId: string;
  clientSecret: string;
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const REQUEST_TIMEOUT_MS = 20_000;
/** Renew this long before Reddit's stated expiry, so no request races it. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const LISTING_LIMIT = 100;
const COMMENTS_LIMIT = 500;

interface CachedToken {
  key: string;
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

/** Forgets the cached token. For tests, and after Reddit rejects one. */
export function resetTokenCache(): void {
  cached = null;
}

type TokenResult =
  | {kind: 'ok'; token: string}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'error'; message: string};

async function accessToken(auth: RedditAuth, userAgent: string): Promise<TokenResult> {
  const key = auth.clientId;
  if (cached && cached.key === key && cached.expiresAt > Date.now()) {
    return {kind: 'ok', token: cached.token};
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return {kind: 'error', message: `token: ${e instanceof Error ? e.message : String(e)}`};
  }

  // Wrong credentials come back as 401; a revoked or unapproved app as 403.
  if (response.status === 401 || response.status === 403) {
    return {kind: 'blocked', status: response.status};
  }
  // Callers back off on rate_limited and blocked, but read error as "this one
  // request failed": the tracer would write the post off as untraceable.
  if (response.status === 429) {
    const seconds = numericHeader(response.headers, 'retry-after');
    return {kind: 'rate_limited', ...(seconds !== undefined ? {retryAfterSeconds: seconds} : {})};
  }
  if (!response.ok) return {kind: 'error', message: `token: HTTP ${response.status}`};

  let body: {access_token?: unknown; expires_in?: unknown; error?: unknown};
  try {
    body = await response.json() as typeof body;
  } catch {
    return {kind: 'error', message: 'token: response was not JSON'};
  }
  if (typeof body.access_token !== 'string') {
    // Reddit answers bad credentials with 200 {"error": ...} as well as 401:
    // the same refusal, so the same result.
    return {kind: 'blocked', status: 401};
  }

  const lifetimeMs = (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000;
  cached = {
    key,
    token: body.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_MARGIN_MS, 60_000),
  };
  return {kind: 'ok', token: body.access_token};
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readRateLimit(headers: Headers): RateLimitHint {
  const remaining = numericHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = numericHeader(headers, 'x-ratelimit-reset');
  return {
    ...(remaining !== undefined ? {remaining} : {}),
    ...(resetSeconds !== undefined ? {resetSeconds} : {}),
  };
}

type ApiResult =
  | {kind: 'ok'; json: unknown; rateLimit: RateLimitHint}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'gone'}
  | {kind: 'error'; message: string};

/** One authenticated GET, with Reddit's failure modes told apart. Never throws. */
async function apiGet(path: string, userAgent: string, auth: RedditAuth): Promise<ApiResult> {
  const token = await accessToken(auth, userAgent);
  if (token.kind !== 'ok') return token;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: {'User-Agent': userAgent, Authorization: `Bearer ${token.token}`},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }

  if (response.status === 429) {
    const seconds = numericHeader(response.headers, 'retry-after')
      ?? numericHeader(response.headers, 'x-ratelimit-reset');
    return {kind: 'rate_limited', ...(seconds !== undefined ? {retryAfterSeconds: seconds} : {})};
  }
  if (response.status === 401) {
    // The token expired early or was revoked; the next call fetches a new one.
    resetTokenCache();
    return {kind: 'error', message: 'HTTP 401 (token refreshed)'};
  }
  if (response.status === 403) return {kind: 'blocked', status: 403};
  if (response.status === 404) return {kind: 'gone'};
  if (!response.ok) return {kind: 'error', message: `HTTP ${response.status}`};

  try {
    return {kind: 'ok', json: await response.json(), rateLimit: readRateLimit(response.headers)};
  } catch {
    // An HTML body on a 200 is a block page, as with the old feed.
    return {kind: 'blocked', status: response.status};
  }
}

interface Thing {
  kind?: string;
  data?: Record<string, unknown>;
}

function children(listing: unknown): Thing[] {
  const data = (listing as {data?: {children?: unknown}} | null)?.data;
  return Array.isArray(data?.children) ? data.children as Thing[] : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Turns a listing of `t3` things into posts, skipping malformed ones. */
export function parseListing(json: unknown): RedditPost[] {
  const posts: RedditPost[] = [];
  for (const child of children(json)) {
    if (child.kind !== 't3' || !child.data) continue;
    const d = child.data;
    const name = str(d['name']);
    const subreddit = str(d['subreddit']);
    const title = str(d['title']);
    const permalink = str(d['permalink']);
    const created = typeof d['created_utc'] === 'number' ? d['created_utc'] : NaN;
    if (!name || !subreddit || !title || !permalink || !Number.isFinite(created)) continue;

    const author = str(d['author']);
    posts.push({
      redditId: name,
      subreddit: subreddit.toLowerCase(),
      title: title.trim(),
      selftext: (str(d['selftext']) ?? '').slice(0, 8000),
      author: author && author !== '[deleted]' ? author : null,
      flair: str(d['link_flair_text']),
      url: `https://www.reddit.com${permalink}`,
      postedAt: new Date(created * 1000),
    });
  }
  return posts;
}

/** Flattens a comment tree, replies included, in reading order. */
export function parseCommentTree(json: unknown): RedditComment[] {
  const out: RedditComment[] = [];
  const walk = (listing: unknown): void => {
    for (const child of children(listing)) {
      if (child.kind !== 't1' || !child.data) continue;
      const author = str(child.data['author']);
      out.push({
        author: author && author !== '[deleted]' ? author : null,
        text: str(child.data['body']) ?? '',
      });
      walk(child.data['replies']);
    }
  };
  // The response is [post listing, comment listing].
  if (Array.isArray(json)) walk(json[1]);
  return out;
}

export type OAuthPostsResult =
  | {kind: 'ok'; posts: RedditPost[]; rateLimit: RateLimitHint}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'error'; message: string};

/** The newest posts across every given subreddit, in one request. */
export async function fetchNewPostsOAuth(
  subreddits: string[],
  userAgent: string,
  auth: RedditAuth,
): Promise<OAuthPostsResult> {
  const path = subreddits.map((s) => encodeURIComponent(s)).join('+');
  const result = await apiGet(`/r/${path}/new?limit=${LISTING_LIMIT}&raw_json=1`, userAgent, auth);
  switch (result.kind) {
    case 'ok':
      return {kind: 'ok', posts: parseListing(result.json), rateLimit: result.rateLimit};
    case 'gone':
      return {kind: 'error', message: 'HTTP 404'};
    default:
      return result;
  }
}

export type OAuthCommentsResult =
  | {kind: 'ok'; comments: RedditComment[]; rateLimit: RateLimitHint}
  | {kind: 'rate_limited'; retryAfterSeconds?: number}
  | {kind: 'blocked'; status: number}
  | {kind: 'gone'}
  | {kind: 'error'; message: string};

/** A post's comments, from its permalink. */
export async function fetchCommentsOAuth(
  postUrl: string,
  userAgent: string,
  auth: RedditAuth,
): Promise<OAuthCommentsResult> {
  const id = /\/comments\/([a-z0-9]+)/i.exec(postUrl)?.[1];
  if (!id) return {kind: 'gone'};
  const result = await apiGet(`/comments/${id}?limit=${COMMENTS_LIMIT}&raw_json=1`, userAgent, auth);
  if (result.kind !== 'ok') return result;
  return {kind: 'ok', comments: parseCommentTree(result.json), rateLimit: result.rateLimit};
}
