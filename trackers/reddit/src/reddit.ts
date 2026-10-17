// Reads new posts from Reddit without credentials.
//
// The anonymous JSON API (/r/x/new.json) is 403-blocked for every User-Agent,
// so this uses the Atom feed instead, which is still open. One request to a
// multireddit path (r/a+b+c/new.rss) returns up to 100 entries spanning every
// watched subreddit — that is why the poll loop claims subreddits in batches.
// See docs/debug-notes/reddit-anonymous-json-blocked.md.

export interface RedditPost {
  redditId: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string | null;
  /** Always null: the Atom feed does not carry flair. */
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

const FEED_TIMEOUT_MS = 20_000;
/** Reddit's maximum; anything higher is silently clamped. */
const FEED_LIMIT = 100;

/** Builds the multireddit feed URL for a batch of subreddits. */
export function feedUrl(subreddits: string[]): string {
  const path = subreddits.map((s) => encodeURIComponent(s)).join('+');
  return `https://www.reddit.com/r/${path}/new.rss?limit=${FEED_LIMIT}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#0?32;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    // Ampersand last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, '&');
}

function tagContent(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

/**
 * Turns Reddit's HTML post body into plain text for the LLM. The feed wraps
 * every body in a thumbnail table plus a "submitted by … to r/x" footer; the
 * footer is dropped so the prompt sees only what the author wrote.
 */
export function htmlToText(html: string): string {
  const decoded = decodeEntities(html);
  const body = /<div class="md">([\s\S]*?)<\/div>/.exec(decoded)?.[1] ?? decoded;
  return decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parses an Atom feed into posts. Malformed entries are skipped rather than
 * failing the batch — one bad entry must not cost us the other 99.
 */
export function parseFeed(xml: string): RedditPost[] {
  const posts: RedditPost[] = [];

  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (!entry) continue;

    const redditId = tagContent(entry, 'id')?.trim();
    const title = tagContent(entry, 'title');
    const published = tagContent(entry, 'published')?.trim();
    const href = /<link[^>]*href="([^"]+)"/.exec(entry)?.[1];
    const subreddit = /<category[^>]*term="([^"]+)"/.exec(entry)?.[1];

    if (!redditId || !title || !published || !href || !subreddit) continue;

    const postedAt = new Date(published);
    if (Number.isNaN(postedAt.getTime())) continue;

    const authorRaw = tagContent(tagContent(entry, 'author') ?? '', 'name');
    const content = tagContent(entry, 'content');

    posts.push({
      redditId,
      subreddit: subreddit.toLowerCase(),
      title: decodeEntities(title).trim(),
      // Bodies get long; the LLM prompt truncates further, this just bounds
      // what we store.
      selftext: content ? htmlToText(content).slice(0, 8000) : '',
      author: authorRaw ? authorRaw.replace(/^\/u\//, '') : null,
      flair: null,
      url: decodeEntities(href),
      postedAt,
    });
  }

  return posts;
}

/**
 * Reads a numeric header. Returns undefined for an absent header — plain
 * Number() would turn that null into 0, which reads as "no wait needed".
 */
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

/**
 * Fetches the newest posts across every given subreddit in a single request.
 * Never throws: transport and block failures come back as typed results so the
 * poll loop can decide between backing off and retrying.
 */
export async function fetchNewPosts(
  subreddits: string[],
  userAgent: string,
): Promise<FetchResult> {
  if (subreddits.length === 0) return {kind: 'ok', posts: [], rateLimit: {}};

  let response: Response;
  try {
    response = await fetch(feedUrl(subreddits), {
      headers: {'User-Agent': userAgent, Accept: 'application/atom+xml, application/xml'},
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
  } catch (e) {
    return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }

  if (response.status === 429) {
    const seconds = numericHeader(response.headers, 'retry-after')
      ?? numericHeader(response.headers, 'x-ratelimit-reset');
    return {kind: 'rate_limited', ...(seconds !== undefined ? {retryAfterSeconds: seconds} : {})};
  }

  if (response.status === 403 || response.status === 401) {
    return {kind: 'blocked', status: response.status};
  }

  if (!response.ok) {
    return {kind: 'error', message: `HTTP ${response.status}`};
  }

  const body = await response.text();

  // A 200 carrying HTML is Reddit's block page, not a feed. Treat it exactly
  // like a 403 rather than letting the parser return zero posts and look like
  // a quiet subreddit.
  if (!body.trimStart().startsWith('<?xml') && !body.includes('<feed')) {
    return {kind: 'blocked', status: response.status};
  }

  return {kind: 'ok', posts: parseFeed(body), rateLimit: readRateLimit(response.headers)};
}
