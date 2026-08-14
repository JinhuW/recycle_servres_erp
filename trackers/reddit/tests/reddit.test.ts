import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {fetchNewPosts, feedUrl, htmlToText, parseFeed} from '../src/reddit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'new-listing.xml'), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feedUrl', () => {
  it('packs every subreddit into one multireddit request', () => {
    expect(feedUrl(['homelabsales', 'hardwareswap', 'homelab'])).toBe(
      'https://www.reddit.com/r/homelabsales+hardwareswap+homelab/new.rss?limit=100',
    );
  });
});

describe('parseFeed', () => {
  const posts = parseFeed(fixture);

  it('reads every entry in the captured feed', () => {
    expect(posts.length).toBe(9);
  });

  it('uses the reddit fullname as the dedup key', () => {
    for (const post of posts) {
      expect(post.redditId).toMatch(/^t3_[a-z0-9]+$/);
    }
    expect(new Set(posts.map((p) => p.redditId)).size).toBe(posts.length);
  });

  it('attributes each post to the subreddit it came from', () => {
    expect(new Set(posts.map((p) => p.subreddit))).toEqual(
      new Set(['homelab', 'hardwareswap', 'homelabsales']),
    );
  });

  it('extracts author, link and timestamp', () => {
    const post = posts[0]!;
    expect(post.author).not.toBeNull();
    expect(post.author).not.toMatch(/^\/u\//);
    expect(post.url).toMatch(/^https:\/\/www\.reddit\.com\/r\//);
    expect(post.postedAt.getTime()).toBeGreaterThan(0);
  });

  it('decodes HTML entities in titles', () => {
    const titles = posts.map((p) => p.title);
    expect(titles.some((t) => t.includes('&amp;'))).toBe(false);
    expect(titles.some((t) => t.includes('['))).toBe(true);
  });

  it('leaves flair null because the feed does not carry it', () => {
    expect(posts.every((p) => p.flair === null)).toBe(true);
  });

  it('strips markup from bodies so the prompt sees plain text', () => {
    for (const post of posts) {
      expect(post.selftext).not.toMatch(/<\/?(table|div|a|img)\b/);
      expect(post.selftext).not.toContain('&lt;');
    }
  });

  it('skips entries missing required fields instead of failing the batch', () => {
    const broken = `<feed><entry><title>no id</title></entry>${
      /<entry>[\s\S]*?<\/entry>/.exec(fixture)![0]
    }</feed>`;

    expect(parseFeed(broken)).toHaveLength(1);
  });

  it('skips entries with an unparseable timestamp', () => {
    const bad = `<feed><entry><id>t3_x</id><title>t</title>`
      + `<published>not-a-date</published><link href="https://x"/>`
      + `<category term="homelab"/></entry></feed>`;

    expect(parseFeed(bad)).toEqual([]);
  });

  it('returns nothing for a feed with no entries', () => {
    expect(parseFeed('<?xml version="1.0"?><feed></feed>')).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('keeps the author body and drops the submitted-by footer markup', () => {
    const html = '&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;div class="md"&gt;'
      + '&lt;p&gt;Selling a Dell R730.&lt;/p&gt;&lt;p&gt;$400 shipped.&lt;/p&gt;'
      + '&lt;/div&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;';

    const text = htmlToText(html);

    expect(text).toContain('Selling a Dell R730.');
    expect(text).toContain('$400 shipped.');
    expect(text).not.toContain('<');
  });

  it('turns line breaks into newlines', () => {
    expect(htmlToText('&lt;div class="md"&gt;a&lt;br/&gt;b&lt;/div&gt;')).toBe('a\nb');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('&lt;div class="md"&gt;a&amp;#32;b&lt;/div&gt;')).toBe('a b');
  });
});

describe('fetchNewPosts', () => {
  function stubFetch(response: Response): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  }

  it('returns parsed posts and the rate-limit hint on success', async () => {
    stubFetch(new Response(fixture, {
      status: 200,
      headers: {'x-ratelimit-remaining': '0.0', 'x-ratelimit-reset': '40'},
    }));

    const result = await fetchNewPosts(['homelab'], 'test-agent');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.posts).toHaveLength(9);
    expect(result.rateLimit).toEqual({remaining: 0, resetSeconds: 40});
  });

  it('reports a 429 with the reset window Reddit gave us', async () => {
    stubFetch(new Response('', {status: 429, headers: {'x-ratelimit-reset': '40'}}));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 40,
    });
  });

  it('prefers an explicit retry-after header', async () => {
    stubFetch(new Response('', {status: 429, headers: {'retry-after': '90'}}));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 90,
    });
  });

  it('reports a 403 as blocked', async () => {
    stubFetch(new Response('<body>blocked</body>', {status: 403}));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({kind: 'blocked', status: 403});
  });

  it('treats an HTML body with status 200 as a block, not an empty feed', async () => {
    stubFetch(new Response('<body class=theme-beta><div>…</div></body>', {status: 200}));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({kind: 'blocked', status: 200});
  });

  it('reports transport failures without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({
      kind: 'error',
      message: 'socket hang up',
    });
  });

  it('reports other error statuses', async () => {
    stubFetch(new Response('oops', {status: 503}));

    expect(await fetchNewPosts(['homelab'], 'ua')).toEqual({kind: 'error', message: 'HTTP 503'});
  });

  it('makes no request when there is nothing claimed', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    expect(await fetchNewPosts([], 'ua')).toEqual({kind: 'ok', posts: [], rateLimit: {}});
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the configured User-Agent', async () => {
    const spy = vi.fn().mockResolvedValue(new Response(fixture, {status: 200}));
    vi.stubGlobal('fetch', spy);

    await fetchNewPosts(['homelab'], 'recycle-servers-tracker/1.0');

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent'])
      .toBe('recycle-servers-tracker/1.0');
  });
});
