// Cross-post detection. Sellers post one listing to r/homelabsales and
// r/hardwareswap (and repost it a day later), and each copy has its own reddit
// id, so the primary key alone alerts buyers once per copy. The feed carries no
// crosspost_parent — most copies are pasted by hand — so a copy is recognised
// by its author and its words.

import type {Sql} from './db.ts';

/** How far apart two copies of one listing may be posted. */
export const DUPLICATE_WINDOW_HOURS = 72;
const TITLE_MATCH = 0.6;
// Model numbers and capacities ("7070" vs "5000", "pm893" vs "pm863a") are
// what tell one seller's similar listings apart.
const TITLE_NUMBERS_MATCH = 0.5;
// Only across subreddits: within one, a seller's separate lots often share a
// template body word for word.
const BODY_MATCH = 0.8;
// Shorter bodies are mostly "see title" or a timestamp link.
const MIN_BODY_CHARS = 80;

export interface ListingText {
  subreddit: string;
  author: string | null;
  title: string;
  selftext: string;
  postedAt: Date;
}

/**
 * The words that say what is for sale. Swap titles read
 * "[USA-CA] [H] what they have [W] what they want", sale titles
 * "[FS][US-CA] what they have"; the "want" part and the tags are dropped.
 */
export function listingWords(title: string): Set<string> {
  const have = title.toLowerCase().replace(/\[w\][\s\S]*$/, '');
  return words(have.replace(/\[[^\]]*\]/g, ' '));
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function sameAuthor(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  return x !== '[deleted]' && x === b.toLowerCase();
}

/** True when two posts are copies of one listing. */
export function isSameListing(a: ListingText, b: ListingText): boolean {
  if (!sameAuthor(a.author, b.author)) return false;
  if (Math.abs(a.postedAt.getTime() - b.postedAt.getTime()) > DUPLICATE_WINDOW_HOURS * 3600_000) {
    return false;
  }
  const titleA = listingWords(a.title);
  const titleB = listingWords(b.title);
  // "16x SK Hynix 32GB" and "15x Micron 32GB" are two lots, however alike.
  if (conflicts(titleA, titleB, isQuantity) || conflicts(titleA, titleB, (w) => MAKERS.has(w))) {
    return false;
  }
  if (jaccard(titleA, titleB) >= TITLE_MATCH) {
    const numbersA = withDigits(titleA);
    const numbersB = withDigits(titleB);
    if (numbersA.size === 0 || numbersB.size === 0) return true;
    if (jaccard(numbersA, numbersB) >= TITLE_NUMBERS_MATCH) return true;
  }
  return a.subreddit !== b.subreddit
    && a.selftext.length >= MIN_BODY_CHARS && b.selftext.length >= MIN_BODY_CHARS
    && jaccard(words(a.selftext), words(b.selftext)) >= BODY_MATCH;
}

const MAKERS = new Set([
  'samsung', 'hynix', 'skhynix', 'micron', 'crucial', 'kingston', 'corsair', 'gskill', 'intel',
  'seagate', 'wd', 'toshiba', 'hgst', 'sandisk', 'kioxia', 'solidigm',
]);

function isQuantity(word: string): boolean {
  return /^(?:\d+x|x\d+)$/.test(word);
}

/** Both titles name words of a kind, and none of them in common. */
function conflicts(a: Set<string>, b: Set<string>, kind: (w: string) => boolean): boolean {
  const ofA = [...a].filter(kind);
  const ofB = new Set([...b].filter(kind));
  return ofA.length > 0 && ofB.size > 0 && !ofA.some((w) => ofB.has(w));
}

function withDigits(words: Set<string>): Set<string> {
  return new Set([...words].filter((w) => /\d/.test(w)));
}

interface Sibling {
  reddit_id: string;
  subreddit: string;
  status: string;
  title: string;
  selftext: string;
  author: string | null;
  posted_at: Date;
}

/** Another copy of a listing; `sent` once buyers have it. */
export interface AlertedCopy {
  redditId: string;
  sent: boolean;
}

/**
 * The copy of this listing that buyers got (or are about to get), or null when
 * this post is the one to alert. Whichever target sorts first on
 * (posted_at, reddit_id) is the one alerted, so two workers holding both
 * copies at once still pick the same one without a lock; a copy already
 * alerted wins whatever its order.
 */
export async function findAlertedCopy(
  sql: Sql,
  post: {reddit_id: string; subreddit: string; author: string | null; title: string; selftext: string; posted_at: Date},
): Promise<AlertedCopy | null> {
  if (!post.author || post.author.toLowerCase() === '[deleted]') return null;
  const siblings = await sql<Sibling[]>`
    SELECT reddit_id, subreddit, status, title, selftext, author, posted_at
      FROM posts
     WHERE lower(author) = ${post.author.toLowerCase()}
       AND reddit_id <> ${post.reddit_id}
       AND status IN ('target', 'notified')
       AND posted_at BETWEEN ${post.posted_at}::timestamptz - make_interval(hours => ${DUPLICATE_WINDOW_HOURS})
                         AND ${post.posted_at}::timestamptz + make_interval(hours => ${DUPLICATE_WINDOW_HOURS})
     ORDER BY posted_at, reddit_id`;
  const self = toListing(post);
  const copies = siblings.filter((s) => isSameListing(self, toListing(s)));
  const alerted = copies.find((s) => s.status === 'notified');
  if (alerted) return {redditId: alerted.reddit_id, sent: true};
  const earlier = copies.find((s) =>
    s.posted_at.getTime() < post.posted_at.getTime()
    || (s.posted_at.getTime() === post.posted_at.getTime() && s.reddit_id < post.reddit_id));
  return earlier ? {redditId: earlier.reddit_id, sent: false} : null;
}

function toListing(p: {
  subreddit: string; author: string | null; title: string; selftext: string; posted_at: Date;
}): ListingText {
  return {subreddit: p.subreddit, author: p.author, title: p.title, selftext: p.selftext, postedAt: p.posted_at};
}
