import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {
  buildFilterSpec,
  describeDatabaseUrl,
  describeVendorError,
  diffSubreddits,
  extractWebhookCreated,
  isEntryScript,
  isNewSubredditCapacityError,
  normalizeSubreddits,
  parseArgs,
  parseSubredditList,
  redriveStep,
  subredditSource,
  syncAction,
  UsageError,
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
    expect(a.values['since-hours']).toBe('24');
    expect(a.values['dry-run']).toBe(true);
    expect(a.values['webhook']).toBe('wh_1');
  });

  it('reads the sync flags', () => {
    const a = parseArgs(['sync', '--from-db', '--dry-run', '--yes', '--one-at-a-time']);
    expect(a.values).toMatchObject({'from-db': true, 'dry-run': true, 'yes': true, 'one-at-a-time': true});
  });

  it('rejects unknown flags, such as a --subreddit typo', () => {
    expect(() => parseArgs(['sync', '--subreddit', 'x'])).toThrow(UsageError);
    expect(() => parseArgs(['sync', '--subreddit', 'x'])).toThrow(/--subreddit/);
  });

  it('rejects stray positionals, values on booleans and missing values', () => {
    expect(() => parseArgs(['redrive', '--dry-run', 'extra'])).toThrow(/extra/);
    expect(() => parseArgs(['sync', '--yes=no'])).toThrow(UsageError);
    expect(() => parseArgs(['sync', '--subreddits'])).toThrow(UsageError);
  });

  it('rejects an option the command does not take', () => {
    expect(() => parseArgs(['setup', '--dry-run'])).toThrow(/setup does not take --dry-run/);
    expect(() => parseArgs(['status', '--yes'])).toThrow(/status does not take --yes/);
  });

  it('accepts --help on any command', () => {
    expect(parseArgs(['sync', '--help']).values['help']).toBe(true);
  });
});

describe('subredditSource', () => {
  it('needs exactly one explicit source', () => {
    expect(() => subredditSource('sync', {})).toThrow(/--subreddits a,b,c, or --from-db/);
    expect(() => subredditSource('sync', {'subreddits': 'a', 'from-db': true})).toThrow(/not both/);
    expect(() => subredditSource('sync', {subreddits: ' , '})).toThrow(/empty/);
  });

  it('returns the list or the db', () => {
    expect(subredditSource('sync', {subreddits: 'r/a,b'})).toEqual({kind: 'list', names: ['a', 'b']});
    expect(subredditSource('setup', {'from-db': true})).toEqual({kind: 'db'});
  });
});

describe('describeDatabaseUrl', () => {
  it('shows host, port and db without credentials', () => {
    const d = describeDatabaseUrl('postgres://user:hunter2@db.railway.internal:6543/railway');
    expect(d).toBe('db.railway.internal:6543/railway');
    expect(d).not.toContain('hunter2');
    expect(d).not.toContain('user');
  });

  it('flags the local compose database', () => {
    expect(describeDatabaseUrl('postgres://t:t@127.0.0.1:5433/tracker')).toBe(
      '127.0.0.1:5433/tracker  (LOCAL database, not production)',
    );
  });

  it('survives a bad url', () => {
    expect(describeDatabaseUrl('not a url')).toBe('(unparseable DATABASE_URL)');
  });
});

describe('syncAction', () => {
  const none = {added: [], removed: []};
  const add = {added: ['a'], removed: []};
  const remove = {added: ['a'], removed: ['b']};
  it('does nothing without a diff', () => {
    expect(syncAction(none, {dryRun: false, yes: false})).toBe('noop');
  });
  it('never writes on --dry-run, even with --yes', () => {
    expect(syncAction(remove, {dryRun: true, yes: true})).toBe('dry-run');
  });
  it('needs --yes when anything is removed', () => {
    expect(syncAction(remove, {dryRun: false, yes: false})).toBe('needs-yes');
    expect(syncAction(remove, {dryRun: false, yes: true})).toBe('apply');
  });
  it('applies pure additions without --yes', () => {
    expect(syncAction(add, {dryRun: false, yes: false})).toBe('apply');
  });
});

describe('redriveStep', () => {
  it('continues while a full page comes back', () => {
    const seen = new Set<string>();
    expect(redriveStep({selected: 1000, delivery_ids: ['d1']}, 1000, seen).done).toBe(false);
    expect(redriveStep({selected: 3, delivery_ids: ['d2']}, 1000, seen)).toMatchObject({
      selected: 3,
      done: true,
    });
  });
  it('stops on a repeated delivery id or an unknown shape', () => {
    const seen = new Set<string>(['d1']);
    expect(redriveStep({selected: 1000, delivery_ids: ['d1']}, 1000, seen).done).toBe(true);
    expect(redriveStep({ok: true}, 1000, new Set())).toMatchObject({selected: undefined, done: true});
  });
});

describe('isEntryScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redditapis entry '));
  afterAll(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, 'real dir'));
  const real = join(dir, 'real dir', 'script.ts');
  writeFileSync(real, '');
  const link = join(dir, 'link.ts');
  symlinkSync(real, link);
  const url = pathToFileURL(real).href;

  it('matches paths with spaces and symlinks', () => {
    expect(url).toContain('%20');
    expect(isEntryScript(url, real)).toBe(true);
    expect(isEntryScript(url, link)).toBe(true);
  });
  it('rejects other or missing scripts', () => {
    expect(isEntryScript(url, undefined)).toBe(false);
    expect(isEntryScript(url, join(dir, 'missing.ts'))).toBe(false);
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

  const capacityBody = {
    error: 'Capacity temporarily unavailable',
    code: 'capacity_temporarily_unavailable',
    detail: {
      limit: 'new_subreddits',
      message: 'New subreddits are capped right now. Email support@redditapis.com to raise it.',
    },
  };

  it('recognizes the live vendor shape: the code as a top-level error string', () => {
    // Trimmed from the real 503 the vendor returned on 2026-11-18.
    const live = {
      error: 'capacity_temporarily_unavailable',
      detail: {
        message: 'The limit is on subreddits nobody watches yet, service-wide. '
          + 'Contact emma@redditapis.com and we will get this raised for you.',
        limit: 'new_subreddits',
        opening_subreddits: ['minerswap'],
      },
    };
    const err = new VendorError('POST', '/api/reddit/monitor/update', 503, live);
    expect(isNewSubredditCapacityError(err)).toBe(true);
    expect(describeVendorError(err)).toContain('emma@redditapis.com');
  });

  it('explains the new-subreddit cap on that 503', () => {
    const err = new VendorError('POST', '/api/reddit/monitor/update', 503, capacityBody);
    expect(isNewSubredditCapacityError(err)).toBe(true);
    const msg = describeVendorError(err);
    expect(msg).toContain('never-watched subreddits');
    expect(msg).toContain('--one-at-a-time');
    expect(msg).toContain('email support@redditapis.com');
    expect(msg).not.toContain('restarting');
  });

  it('keeps the generic hint for other 503s', () => {
    const other = new VendorError('POST', '/api/reddit/monitor/update', 503, {
      code: 'capacity_temporarily_unavailable',
      detail: {limit: 'something_else'},
    });
    expect(isNewSubredditCapacityError(other)).toBe(false);
    expect(describeVendorError(other)).toContain('Monitoring is restarting');
    const plain = new VendorError('GET', '/api/reddit/monitor/list', 503, 'Service Unavailable');
    expect(describeVendorError(plain)).toContain('Monitoring is restarting');
    expect(isNewSubredditCapacityError(new VendorError('POST', '/x', 429, capacityBody))).toBe(false);
  });
});
