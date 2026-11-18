import {describe, expect, it} from 'vitest';
import {
  buildFilterSpec,
  describeVendorError,
  diffSubreddits,
  extractWebhookCreated,
  normalizeSubreddits,
  parseArgs,
  parseSubredditList,
  VendorError,
  withSubreddits,
} from '../scripts/redditapis-monitor.ts';

describe('parseArgs', () => {
  it('defaults to help', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('reads valued, = and boolean flags', () => {
    const a = parseArgs(['redrive', '--since-hours', '24', '--dry-run', '--webhook=wh_1']);
    expect(a.command).toBe('redrive');
    expect(a.flags.get('since-hours')).toBe('24');
    expect(a.flags.get('dry-run')).toBe(true);
    expect(a.flags.get('webhook')).toBe('wh_1');
  });

  it('never lets a boolean flag swallow the next token', () => {
    const a = parseArgs(['redrive', '--dry-run', 'extra']);
    expect(a.flags.get('dry-run')).toBe(true);
    expect(a.positionals).toEqual(['extra']);
  });
});

describe('subreddit lists', () => {
  it('strips r/ prefixes, blanks and case-insensitive duplicates', () => {
    expect(normalizeSubreddits([' r/homelabsales', '/r/HomeLabSales', '', 'hardwareswap/'])).toEqual([
      'homelabsales',
      'hardwareswap',
    ]);
    expect(parseSubredditList('a, b,,A')).toEqual(['a', 'b']);
  });

  it('builds an every-new-post filter', () => {
    expect(buildFilterSpec(['homelabsales', 'r/hardwareswap'])).toEqual({
      subreddit: ['homelabsales', 'hardwareswap'],
      kind: 'post',
    });
  });

  it('rejects empty and over-50 lists', () => {
    expect(() => buildFilterSpec([])).toThrow(/empty/);
    const many = Array.from({length: 51}, (_, i) => `s${i}`);
    expect(() => buildFilterSpec(many)).toThrow(/at most 50/);
  });

  it('keeps other spec fields but drops vendor-owned stream_since', () => {
    const spec = withSubreddits(
      {subreddit: ['a'], kind: 'post', whole_words: true, stream_since: {a: 'x'}},
      ['a', 'b'],
    );
    expect(spec).toEqual({subreddit: ['a', 'b'], kind: 'post', whole_words: true});
  });

  it('diffs case-insensitively', () => {
    expect(diffSubreddits(['A', 'b'], ['a', 'c'])).toEqual({added: ['c'], removed: ['b']});
  });
});

describe('vendor responses', () => {
  it('finds webhook id and secret at the top level or nested', () => {
    expect(extractWebhookCreated({id: 'wh_1', secret: 's'})).toEqual({id: 'wh_1', secret: 's'});
    expect(extractWebhookCreated({webhook: {webhook_id: 'wh_2', secret: 't'}})).toEqual({
      id: 'wh_2',
      secret: 't',
    });
    expect(extractWebhookCreated(null)).toEqual({id: undefined, secret: undefined});
  });

  it('tells the operator to upgrade on 402', () => {
    const msg = describeVendorError(
      new VendorError('POST', '/api/reddit/monitor/add', 402, {error: 'x', code: 'subscription_required'}),
    );
    expect(msg).toContain('subscription_required');
    expect(msg).toContain('subscribe to the Growth plan');
  });
});
