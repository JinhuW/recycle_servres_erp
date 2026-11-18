import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {fetchComments, fetchNewPosts} from '../src/reddit.ts';
import {
  fetchNewPostsOAuth,
  parseCommentTree,
  parseListing,
  resetTokenCache,
} from '../src/redditOAuth.ts';

const AUTH = {clientId: 'cid', clientSecret: 'secret'};

function tokenResponse(): Response {
  return new Response(JSON.stringify({access_token: 'tok', token_type: 'bearer', expires_in: 86400}), {status: 200});
}

const LISTING = {
  kind: 'Listing',
  data: {
    children: [
      {
        kind: 't3',
        data: {
          name: 't3_abc',
          subreddit: 'HomelabSales',
          title: ' [FS] 512GB DDR4 RDIMM ',
          selftext: 'Samsung M393A4K40DB3',
          author: 'seller1',
          link_flair_text: 'FS',
          permalink: '/r/homelabsales/comments/abc/fs_512gb/',
          created_utc: 1_794_960_000,
        },
      },
      {kind: 't3', data: {name: 't3_bad'}},
      {kind: 't1', data: {name: 't1_x'}},
      {
        kind: 't3',
        data: {
          name: 't3_def',
          subreddit: 'hardwareswap',
          title: 'link post',
          selftext: '',
          author: '[deleted]',
          link_flair_text: null,
          permalink: '/r/hardwareswap/comments/def/link/',
          created_utc: 1_794_960_100,
        },
      },
    ],
  },
};

beforeEach(() => resetTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('parseListing', () => {
  it('maps t3 things to posts and skips malformed ones', () => {
    const posts = parseListing(LISTING);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual({
      redditId: 't3_abc',
      subreddit: 'homelabsales',
      title: '[FS] 512GB DDR4 RDIMM',
      selftext: 'Samsung M393A4K40DB3',
      author: 'seller1',
      flair: 'FS',
      url: 'https://www.reddit.com/r/homelabsales/comments/abc/fs_512gb/',
      postedAt: new Date(1_794_960_000 * 1000),
    });
    expect(posts[1]!.author).toBeNull();
    expect(posts[1]!.flair).toBeNull();
  });

  it('returns nothing for a malformed body', () => {
    expect(parseListing(null)).toEqual([]);
    expect(parseListing({data: {}})).toEqual([]);
  });
});

describe('parseCommentTree', () => {
  it('flattens replies in reading order and skips "more" stubs', () => {
    const tree = [
      {kind: 'Listing', data: {children: [{kind: 't3', data: {}}]}},
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                author: 'buyer1',
                body: 'PM',
                replies: {kind: 'Listing', data: {children: [{kind: 't1', data: {author: 'seller1', body: 'replied', replies: ''}}]}},
              },
            },
            {kind: 't1', data: {author: '[deleted]', body: 'chat sent', replies: ''}},
            {kind: 'more', data: {count: 3}},
          ],
        },
      },
    ];
    expect(parseCommentTree(tree)).toEqual([
      {author: 'buyer1', text: 'PM'},
      {author: 'seller1', text: 'replied'},
      {author: null, text: 'chat sent'},
    ]);
  });
});

describe('fetchNewPostsOAuth', () => {
  it('gets a token once, then reads the multireddit with it', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementation(async () => new Response(JSON.stringify(LISTING), {
        status: 200,
        headers: {'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '300'},
      }));
    vi.stubGlobal('fetch', spy);

    const first = await fetchNewPosts(['homelabsales', 'hardwareswap'], 'ua', AUTH);
    const second = await fetchNewPosts(['homelabsales'], 'ua', AUTH);

    expect(first).toMatchObject({kind: 'ok', rateLimit: {remaining: 99, resetSeconds: 300}});
    if (first.kind === 'ok') expect(first.posts).toHaveLength(2);
    // A broken cache would send the second call to the token endpoint again.
    expect(second.kind).toBe('ok');
    const urls = spy.mock.calls.map((call) => call[0] as string);
    expect(urls.filter((u) => u.endsWith('/api/v1/access_token'))).toHaveLength(1);

    expect(spy).toHaveBeenCalledTimes(3);
    const [tokenUrl, tokenInit] = spy.mock.calls[0]! as [string, RequestInit];
    expect(tokenUrl).toBe('https://www.reddit.com/api/v1/access_token');
    expect(tokenInit.body).toBe('grant_type=client_credentials');
    expect((tokenInit.headers as Record<string, string>)['Authorization'])
      .toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);

    const [listUrl, listInit] = spy.mock.calls[1]! as [string, RequestInit];
    expect(listUrl).toBe('https://oauth.reddit.com/r/homelabsales+hardwareswap/new?limit=100&raw_json=1');
    expect((listInit.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect((listInit.headers as Record<string, string>)['User-Agent']).toBe('ua');
  });

  it('reports rejected credentials as blocked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status: 401})));
    expect(await fetchNewPostsOAuth(['homelab'], 'ua', AUTH)).toEqual({kind: 'blocked', status: 401});
  });

  it('reports a token error body as blocked, like a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({error: 'invalid_grant'}), {status: 200})));
    expect(await fetchNewPostsOAuth(['homelab'], 'ua', AUTH))
      .toEqual({kind: 'blocked', status: 401});
  });

  it('reports a rate-limited token endpoint as rate_limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', {status: 429, headers: {'retry-after': '30'}})));
    expect(await fetchNewPostsOAuth(['homelab'], 'ua', AUTH))
      .toEqual({kind: 'rate_limited', retryAfterSeconds: 30});
  });

  it('passes a 429 through with its reset window', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('', {status: 429, headers: {'x-ratelimit-reset': '42'}})));
    expect(await fetchNewPostsOAuth(['homelab'], 'ua', AUTH))
      .toEqual({kind: 'rate_limited', retryAfterSeconds: 42});
  });

  it('drops the token after a 401 so the next call fetches a new one', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('', {status: 401}))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify(LISTING), {status: 200}));
    vi.stubGlobal('fetch', spy);

    expect((await fetchNewPostsOAuth(['homelab'], 'ua', AUTH)).kind).toBe('error');
    expect((await fetchNewPostsOAuth(['homelab'], 'ua', AUTH)).kind).toBe('ok');
    expect(spy.mock.calls[2]![0]).toBe('https://www.reddit.com/api/v1/access_token');
  });

  it('never throws on a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    expect(await fetchNewPostsOAuth(['homelab'], 'ua', AUTH))
      .toEqual({kind: 'error', message: 'token: socket hang up'});
  });
});

describe('fetchComments with credentials', () => {
  it('reads the comment tree by post id', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {data: {children: []}},
        {data: {children: [{kind: 't1', data: {author: 'b', body: 'PM', replies: ''}}]}},
      ]), {status: 200}));
    vi.stubGlobal('fetch', spy);

    const result = await fetchComments('https://www.reddit.com/r/hardwareswap/comments/abc/slug/', 'ua', AUTH);

    expect(result).toMatchObject({kind: 'ok', comments: [{author: 'b', text: 'PM'}]});
    expect(spy.mock.calls[1]![0]).toBe('https://oauth.reddit.com/comments/abc?limit=500&raw_json=1');
  });
});
