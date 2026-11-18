#!/usr/bin/env tsx
// Configures the redditapis.com "monitoring" side of the tracker: one webhook
// target pointing at the api's POST /webhooks/redditapis, and one monitor that
// watches every new post in the enabled subreddits. Ops-only; the tracker
// itself never calls the vendor's management API.
//
//   REDDITAPIS_KEY=… pnpm redditapis setup --url https://…/webhooks/redditapis --from-db
//   REDDITAPIS_KEY=… pnpm redditapis sync --from-db --dry-run
//   REDDITAPIS_KEY=… pnpm redditapis status
//
// Vendor reference: https://docs.redditapis.com/docs/monitoring/endpoints and
// the request schemas in https://docs.redditapis.com/openapi.json.

import 'dotenv/config';
import {realpathSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs as utilParseArgs} from 'node:util';
import postgres from 'postgres';

const API_BASE = 'https://api.redditapis.com/api/reddit/monitor';

/** The vendor caps one monitor at 50 subreddits (filter_spec.subreddit). */
export const MAX_SUBREDDITS_PER_MONITOR = 50;

/** webhook/redrive `limit` maximum (openapi: 1..1000, default 100). */
export const REDRIVE_MAX_LIMIT = 1000;

/** webhook/redrive is rate-limited to 10 calls a minute; stay just under. */
const REDRIVE_CALL_INTERVAL_MS = 6_500;

/** Safety stop for the redrive loop (20 × 1000 deliveries). */
const REDRIVE_MAX_CALLS = 20;

/** Pause between `sync --one-at-a-time` update calls. */
const ONE_AT_A_TIME_INTERVAL_MS = 2_000;

const USAGE = `Usage: pnpm redditapis <command> [options]

Configures the redditapis.com monitor that pushes new Reddit posts to the
tracker api. Needs REDDITAPIS_KEY. Unknown or misspelt options are an error.

Subreddit source (setup and sync need exactly one):
  --subreddits a,b,c   Use this list.
  --from-db            Read the enabled subreddits through DATABASE_URL. The
                       host/port/database is printed first: dotenv often
                       points it at the LOCAL compose DB (127.0.0.1:5433).

Commands:
  setup --url <webhook url> (--subreddits a,b,c | --from-db)
      Create the webhook target (prints its signing secret ONCE) and one
      monitor for the subreddits, delivering only to that webhook. If the
      vendor refuses the monitor, the new webhook is deleted again and the
      printed secret is void.
  sync (--subreddits a,b,c | --from-db) [--dry-run] [--yes] [--one-at-a-time]
      Make the existing monitor's subreddit list match the source. This
      REPLACES the live monitor's list.
        --dry-run        Print the +/- diff and change nothing.
        --yes            Required when the diff removes any subreddit.
        --one-at-a-time  Add new subreddits with one update call each, and
                         carry on past ones the vendor refuses for capacity
                         (503 capacity_temporarily_unavailable); refused ones
                         are listed at the end. Use this when the vendor's
                         service-wide cap on never-watched subreddits bites.
  status
      Monitors, plan slots, webhooks, per-monitor health and recent
      deliveries.
  test [--webhook <id>] [--comment]
      Send a signed synthetic delivery to the webhook.
  redrive --since-hours N [--dry-run] [--webhook <id>]
      Re-send the webhook's dead-lettered deliveries from the last N hours,
      ${REDRIVE_MAX_LIMIT} per call, oldest first, calling again (at most 10
      calls a minute) until none are left. --dry-run makes one call and lists
      what would be re-sent.
  help
      This text.
`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Every option the CLI knows; per-command subsets are in COMMAND_OPTIONS. */
const OPTIONS = {
  'url': {type: 'string'},
  'subreddits': {type: 'string'},
  'from-db': {type: 'boolean'},
  'dry-run': {type: 'boolean'},
  'yes': {type: 'boolean'},
  'one-at-a-time': {type: 'boolean'},
  'webhook': {type: 'string'},
  'comment': {type: 'boolean'},
  'since-hours': {type: 'string'},
  'help': {type: 'boolean', short: 'h'},
} as const;

/** Parsed option values; absent options are undefined. */
export interface CliValues {
  'url'?: string;
  'subreddits'?: string;
  'from-db'?: boolean;
  'dry-run'?: boolean;
  'yes'?: boolean;
  'one-at-a-time'?: boolean;
  'webhook'?: string;
  'comment'?: boolean;
  'since-hours'?: string;
  'help'?: boolean;
}

/** Options each command accepts (`--help` is accepted everywhere). */
const COMMAND_OPTIONS: Record<string, ReadonlyArray<keyof CliValues>> = {
  help: [],
  setup: ['url', 'subreddits', 'from-db'],
  sync: ['subreddits', 'from-db', 'dry-run', 'yes', 'one-at-a-time'],
  status: [],
  test: ['webhook', 'comment'],
  redrive: ['since-hours', 'dry-run', 'webhook'],
};

/** Parsed command line: the command and its option values. */
export interface ParsedArgs {
  command: string;
  values: CliValues;
}

/**
 * Parses `argv` (without node and script path) with `node:util` parseArgs in
 * strict mode: unknown options, a value on a boolean, a missing value, extra
 * positionals and an option the command does not take all throw UsageError.
 * The first positional is the command; no command means `help`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let parsed: {values: unknown; positionals: string[]};
  try {
    parsed = utilParseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    const code = (e as {code?: unknown}).code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError((e as Error).message);
    }
    throw e;
  }
  const values = parsed.values as CliValues;
  const [command = 'help', ...extra] = parsed.positionals;
  if (extra.length > 0) {
    throw new UsageError(`Unexpected argument(s): ${extra.join(' ')}`);
  }
  const allowed = COMMAND_OPTIONS[command];
  if (allowed) {
    for (const [name, v] of Object.entries(values)) {
      if (v === undefined || name === 'help') continue;
      if (!allowed.includes(name as keyof CliValues)) {
        throw new UsageError(`${command} does not take --${name}.`);
      }
    }
  }
  return {command, values};
}

/** Where `setup`/`sync` get their subreddit list from. */
export type SubredditSource = {kind: 'list'; names: string[]} | {kind: 'db'};

/** Requires exactly one of `--subreddits` and `--from-db`. */
export function subredditSource(command: string, values: CliValues): SubredditSource {
  const list = values['subreddits'];
  const fromDb = values['from-db'] === true;
  if (list !== undefined && fromDb) {
    throw new UsageError('Pass either --subreddits or --from-db, not both.');
  }
  if (list !== undefined) {
    const names = parseSubredditList(list);
    if (names.length === 0) throw new UsageError('--subreddits is empty.');
    return {kind: 'list', names};
  }
  if (fromDb) return {kind: 'db'};
  throw new UsageError(
    `${command} needs an explicit subreddit source: --subreddits a,b,c, or --from-db ` +
      '(reads the enabled subreddits through DATABASE_URL).',
  );
}

/**
 * Describes a postgres URL as `host:port/dbname` without credentials, flagged
 * when it points at this machine.
 */
export function describeDatabaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '(unparseable DATABASE_URL)';
  }
  const host = u.hostname || '(local socket)';
  const where = `${host}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default db)'}`;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', ''].includes(u.hostname);
  return local ? `${where}  (LOCAL database, not production)` : where;
}

/** What `sync` should do with a diff, given --dry-run and --yes. */
export type SyncAction = 'noop' | 'dry-run' | 'needs-yes' | 'apply';

/**
 * No diff → noop; --dry-run → dry-run; a removal without --yes → needs-yes;
 * otherwise apply.
 */
export function syncAction(
  diff: {added: readonly string[]; removed: readonly string[]},
  opts: {dryRun: boolean; yes: boolean},
): SyncAction {
  if (diff.added.length === 0 && diff.removed.length === 0) return 'noop';
  if (opts.dryRun) return 'dry-run';
  if (diff.removed.length > 0 && !opts.yes) return 'needs-yes';
  return 'apply';
}

/** One webhook/redrive call's outcome and whether to call again. */
export interface RedriveStep {
  selected: number | undefined;
  done: boolean;
  reason: string;
}

/**
 * Decides whether the redrive loop goes on: it stops when the vendor selected
 * fewer than `limit` (nothing left), when the answer has no numeric
 * `selected`, or when it repeats a delivery id already re-sent (which would
 * loop forever). Adds this call's ids to `seen`.
 */
export function redriveStep(body: unknown, limit: number, seen: Set<string>): RedriveStep {
  const res = asRecord(body);
  const selected = typeof res['selected'] === 'number' ? res['selected'] : undefined;
  if (selected === undefined) {
    return {selected, done: true, reason: 'the response has no numeric `selected`; stopping'};
  }
  const ids = Array.isArray(res['delivery_ids'])
    ? res['delivery_ids'].filter((x): x is string => typeof x === 'string')
    : [];
  const repeated = ids.some((id) => seen.has(id));
  for (const id of ids) seen.add(id);
  if (repeated) {
    return {selected, done: true, reason: 'the vendor selected deliveries already re-sent; stopping'};
  }
  if (selected < limit) return {selected, done: true, reason: 'no more dead deliveries'};
  return {selected, done: false, reason: ''};
}

/**
 * Normalises subreddit names the way the vendor does (drops a leading `r/` or
 * `/r/`, trims) and removes case-insensitive duplicates, keeping the first
 * spelling. Empty entries are dropped.
 */
export function normalizeSubreddits(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/^\/?r\//i, '').replace(/\/+$/, '');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Splits a `--subreddits a,b,c` value into normalised names. */
export function parseSubredditList(value: string): string[] {
  return normalizeSubreddits(value.split(','));
}

/** The vendor's monitor filter: every new post in the given subreddits. */
export interface FilterSpec {
  subreddit: string[];
  kind: 'post';
  [key: string]: unknown;
}

/**
 * Builds the filter_spec for "every new post in these subreddits": anchored by
 * `subreddit`, `kind: "post"`, and no keyword fields, so nothing is filtered
 * out on the vendor side (the tracker's own LLM does the judging).
 */
export function buildFilterSpec(subreddits: readonly string[]): FilterSpec {
  const names = normalizeSubreddits(subreddits);
  if (names.length === 0) {
    throw new UsageError('No subreddits to monitor: the list is empty.');
  }
  if (names.length > MAX_SUBREDDITS_PER_MONITOR) {
    throw new UsageError(
      `${names.length} subreddits, but one monitor holds at most ` +
        `${MAX_SUBREDDITS_PER_MONITOR}. Disable some, or split them across monitors by hand.`,
    );
  }
  return {subreddit: names, kind: 'post'};
}

/**
 * Applies a new subreddit list to an existing filter_spec, keeping every other
 * field the monitor already has. `stream_since` is vendor-owned ("anything you
 * send is replaced"), so it is left out of the update.
 */
export function withSubreddits(
  existing: Record<string, unknown> | undefined,
  subreddits: readonly string[],
): Record<string, unknown> {
  const base = buildFilterSpec(subreddits);
  const rest: Record<string, unknown> = {...(existing ?? {})};
  delete rest['stream_since'];
  return {...rest, subreddit: base.subreddit};
}

/** Case-insensitive difference between the current and the wanted lists. */
export function diffSubreddits(
  current: readonly string[],
  wanted: readonly string[],
): {added: string[]; removed: string[]} {
  const cur = new Set(current.map((s) => s.toLowerCase()));
  const want = new Set(wanted.map((s) => s.toLowerCase()));
  return {
    added: wanted.filter((s) => !cur.has(s.toLowerCase())),
    removed: current.filter((s) => !want.has(s.toLowerCase())),
  };
}

/**
 * Pulls a webhook's id and signing secret out of a webhook/create response.
 * The docs say the response "returns the webhook with its signing secret" but
 * do not pin field names, so the plausible spellings are all accepted.
 */
export function extractWebhookCreated(body: unknown): {id?: string; secret?: string} {
  const top = asRecord(body);
  const nested = asRecord(top['webhook']);
  const pick = (...keys: string[]): string | undefined => {
    for (const src of [top, nested]) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === 'string' && v) return v;
      }
    }
    return undefined;
  };
  return {
    id: pick('id', 'webhook_id'),
    secret: pick('secret', 'signing_secret', 'webhook_secret'),
  };
}

/** Reads `subreddit` from a monitor's filter_spec as a string list. */
export function monitorSubreddits(monitor: Record<string, unknown>): string[] {
  const spec = asRecord(monitor['filter_spec']);
  const subs = spec['subreddit'];
  return Array.isArray(subs) ? subs.filter((s): s is string => typeof s === 'string') : [];
}

/** Treats anything that is not a plain object as an empty record. */
export function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Returns `body[key]` as an array of records (missing or wrong type → []). */
export function recordList(body: unknown, key: string): Array<Record<string, unknown>> {
  const v = asRecord(body)[key];
  return Array.isArray(v) ? v.map(asRecord) : [];
}

// ---------------------------------------------------------------------------
// Vendor client
// ---------------------------------------------------------------------------

/** A bad command line; printed without a stack trace. */
export class UsageError extends Error {}

/** A non-2xx answer from the vendor, carrying its JSON (or text) body. */
export class VendorError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} → HTTP ${status}`);
  }
}

/**
 * For a 503 `capacity_temporarily_unavailable` whose `detail.limit` is
 * `new_subreddits` (the vendor's service-wide cap on subreddits nobody watches
 * yet), returns the vendor's `detail.message`; otherwise undefined.
 */
export function newSubredditCapacityMessage(
  status: number,
  body: unknown,
): {message: string} | undefined {
  if (status !== 503) return undefined;
  const top = asRecord(body);
  const nested = asRecord(top['error']);
  // The live vendor sends the code as a top-level `error` string, e.g.
  // {"error":"capacity_temporarily_unavailable","detail":{"limit":"new_subreddits",...}}
  // (seen 2026-11-18); `code` and a nested object are kept for other shapes.
  const code = top['code']
    ?? (typeof top['error'] === 'string' ? top['error'] : nested['code']);
  const detail = asRecord(top['detail'] ?? nested['detail']);
  if (code !== 'capacity_temporarily_unavailable' || detail['limit'] !== 'new_subreddits') {
    return undefined;
  }
  return {message: typeof detail['message'] === 'string' ? detail['message'] : ''};
}

/** True for the vendor's 503 new-subreddit capacity refusal. */
export function isNewSubredditCapacityError(e: unknown): e is VendorError {
  return e instanceof VendorError && newSubredditCapacityMessage(e.status, e.body) !== undefined;
}

/** The operator hint for a new-subreddit capacity refusal. */
export function newSubredditCapacityHint(message: string): string[] {
  const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(message)?.[0];
  return [
    '  The vendor caps how many never-watched subreddits can be added service-wide',
    '  at a time; nothing was changed. Adding them ONE AT A TIME often gets most in:',
    '    pnpm redditapis sync --one-at-a-time (--subreddits a,b,c | --from-db)',
    `  To raise the cap, the vendor asks you to email ${email ?? 'them (see their message)'}` +
      (message ? `: "${message}"` : '.'),
  ];
}

/** Human-readable explanation of a vendor error, with a hint for known codes. */
export function describeVendorError(err: VendorError): string {
  const lines = [`✗ ${err.message}`];
  lines.push(
    typeof err.body === 'string' ? `  ${err.body}` : `  ${JSON.stringify(err.body, null, 2)}`,
  );
  if (err.status === 402) {
    lines.push('  The current plan does not allow this — subscribe to the Growth plan.');
  } else if (err.status === 401) {
    lines.push('  REDDITAPIS_KEY is missing or invalid.');
  } else if (err.status === 429) {
    lines.push('  Management rate limit hit; wait a minute and retry.');
  } else if (err.status === 503) {
    const capacity = newSubredditCapacityMessage(err.status, err.body);
    if (capacity) {
      lines.push(...newSubredditCapacityHint(capacity.message));
    } else {
      lines.push('  Monitoring is restarting; nothing was changed. Retry in a few seconds.');
    }
  }
  return lines.join('\n');
}

class RedditApisClient {
  constructor(private readonly key: string) {}

  get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    return this.request('GET', qs ? `${path}?${qs}` : path);
  }

  post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', path, body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.key}`,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (proxy error page); keep the text.
    }
    if (!res.ok) throw new VendorError(method, `/api/reddit/monitor/${path}`, res.status, parsed);
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function enabledSubredditsFromDb(): Promise<string[]> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new UsageError(
      '--from-db needs DATABASE_URL. Set it, or pass --subreddits a,b,c instead.',
    );
  }
  console.log(`· Reading enabled subreddits from ${describeDatabaseUrl(url)}`);
  const sql = postgres(url, {onnotice: () => {}, max: 1});
  try {
    const rows = await sql`SELECT name FROM subreddits WHERE enabled ORDER BY name`;
    return rows.map((r) => r['name'] as string);
  } finally {
    await sql.end();
  }
}

async function wantedSubreddits(source: SubredditSource): Promise<string[]> {
  const names =
    source.kind === 'list' ? source.names : normalizeSubreddits(await enabledSubredditsFromDb());
  console.log(
    `· ${names.length} subreddit(s) from ${source.kind === 'list' ? '--subreddits' : 'the subreddits table'}: ` +
      names.join(', '),
  );
  return names;
}

async function listMonitors(api: RedditApisClient): Promise<{
  monitors: Array<Record<string, unknown>>;
  body: unknown;
}> {
  const body = await api.get('list');
  return {monitors: recordList(body, 'monitors'), body};
}

function printNotices(res: Record<string, unknown>, indent: string): void {
  const notices = res['notices'];
  if (Array.isArray(notices) && notices.length > 0) {
    console.log(`${indent}notices: ${JSON.stringify(notices, null, 2)}`);
  }
}

/**
 * Deletes a webhook that `setup` just created when the monitor it was for
 * could not be created, so a retry does not pile up orphans.
 */
async function deleteOrphanWebhook(api: RedditApisClient, webhookId: string): Promise<void> {
  console.error('');
  console.error('✗ The monitor was not created; deleting the webhook target created above.');
  try {
    await api.post('webhook/delete', {id: webhookId});
    console.error(`✓ Deleted webhook ${webhookId}. The secret printed above is now VOID:`);
    console.error('  do not set it on Railway. A retry of setup creates a new one.');
  } catch (e) {
    console.error(`✗ Could not delete webhook ${webhookId}; delete it on the dashboard.`);
    if (e instanceof VendorError) console.error(describeVendorError(e));
    else console.error(`  ${String(e)}`);
  }
  console.error('');
}

async function cmdSetup(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const url = args.values['url'];
  if (!url) throw new UsageError('setup needs --url <webhook url>.');
  if (!url.startsWith('https://')) throw new UsageError('The webhook url must be https://.');
  const source = subredditSource('setup', args.values);

  const {monitors} = await listMonitors(api);
  if (monitors.length > 0) {
    console.error('✗ A monitor already exists; setup only creates the first one.');
    for (const m of monitors) console.error(`  ${String(m['id'])}  (${monitorSubreddits(m).join(', ')})`);
    console.error('  Use `pnpm redditapis sync` to update its subreddits.');
    process.exitCode = 1;
    return;
  }

  // Resolve the subreddit list before creating anything, so a bad list does
  // not leave an orphan webhook behind.
  const filterSpec = buildFilterSpec(await wantedSubreddits(source));

  const created = await api.post('webhook/create', {kind: 'webhook', url});
  const {id: webhookId, secret} = extractWebhookCreated(created);
  console.log('');
  console.log('✓ Webhook target created');
  if (!webhookId || !secret) {
    // Unknown response shape: never lose the one-time secret.
    console.log('  Could not find id/secret fields; full response (contains the secret):');
    console.log(JSON.stringify(created, null, 2));
  } else {
    console.log(`  id:     ${webhookId}`);
    console.log(`  secret: ${secret}`);
  }
  console.log('');
  console.log('  !! The secret is shown ONCE and cannot be read back. Copy it now; it is');
  console.log('  !! only valid if the monitor below is created too.');
  console.log('');
  if (!webhookId) {
    console.error('✗ No webhook id in the response; not creating the monitor.');
    process.exitCode = 1;
    return;
  }

  let monitor: Record<string, unknown>;
  try {
    monitor = asRecord(
      await api.post('add', {filter_spec: filterSpec, webhook_ids: [webhookId]}),
    );
  } catch (e) {
    if (e instanceof VendorError) {
      // The vendor answered and refused: no monitor exists for this webhook.
      await deleteOrphanWebhook(api, webhookId);
    } else {
      // Network failure: the monitor may or may not exist, so keep the webhook.
      console.error(
        `✗ No answer from add; the monitor may or may not exist. Webhook ${webhookId} is ` +
          'kept. Run `pnpm redditapis status` before retrying.',
      );
    }
    throw e;
  }
  const m = asRecord(monitor['monitor']);
  const monitorId = monitor['id'] ?? m['id'];
  const cadence = monitor['cadence_s'] ?? m['cadence_s'];
  console.log('✓ Monitor created');
  console.log(`  id:       ${String(monitorId)}`);
  console.log(`  cadence:  ${cadence === undefined ? '?' : `${String(cadence)}s`}`);
  console.log(`  watching: ${filterSpec.subreddit.length} subreddit(s), kind=post, no keyword filter`);
  console.log(`  delivers: only to webhook ${webhookId}`);
  printNotices(monitor, '  ');
  console.log('');
  console.log('Next: set the secret as REDDITAPIS_WEBHOOK_SECRET on the Railway api');
  console.log('service, then `pnpm redditapis test`.');
}

async function cmdSync(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const source = subredditSource('sync', args.values);
  const dryRun = args.values['dry-run'] === true;
  const yes = args.values['yes'] === true;

  const {monitors} = await listMonitors(api);
  if (monitors.length !== 1) {
    console.error(
      monitors.length === 0
        ? '✗ No monitor exists yet. Run `pnpm redditapis setup --url …` first.'
        : `✗ ${monitors.length} monitors exist; sync only manages a single one. ` +
            'Remove the extras on the dashboard, or edit them by hand.',
    );
    for (const m of monitors) console.error(`  ${String(m['id'])}  (${monitorSubreddits(m).join(', ')})`);
    process.exitCode = 1;
    return;
  }
  const monitor = monitors[0]!;
  const monitorId = String(monitor['id']);
  const current = monitorSubreddits(monitor);
  const wanted = normalizeSubreddits(await wantedSubreddits(source));
  buildFilterSpec(wanted); // Validates size before anything is written.
  const diff = diffSubreddits(current, wanted);
  console.log(`· Monitor ${monitorId} watches ${current.length}; the source has ${wanted.length}.`);
  if (diff.added.length) console.log(`  + ${diff.added.join(', ')}`);
  if (diff.removed.length) console.log(`  - ${diff.removed.join(', ')}`);

  switch (syncAction(diff, {dryRun, yes})) {
    case 'noop':
      console.log(`✓ Monitor ${monitorId} already watches exactly these subreddits.`);
      return;
    case 'dry-run':
      console.log('· Dry run: nothing was changed.');
      if (diff.removed.length && !yes) {
        console.log(`  Applying it would remove ${diff.removed.length} subreddit(s), which needs --yes.`);
      }
      return;
    case 'needs-yes':
      console.error(
        `✗ This would REMOVE ${diff.removed.length} subreddit(s) from the live monitor: ` +
          diff.removed.join(', '),
      );
      console.error('  Nothing was changed. Re-run with --yes to remove them (--dry-run to preview).');
      process.exitCode = 1;
      return;
    case 'apply':
      break;
  }

  const spec = asRecord(monitor['filter_spec']);
  if (args.values['one-at-a-time'] === true && diff.added.length > 0) {
    await syncOneAtATime(api, monitorId, spec, current, diff);
    return;
  }
  const res = asRecord(
    await api.post('update', {id: monitor['id'], filter_spec: withSubreddits(spec, wanted)}),
  );
  console.log(`✓ Monitor ${monitorId} updated (new subreddits start from now; no backfill).`);
  printNotices(res, '  ');
}

/**
 * Applies removals in one update, then each addition in its own update,
 * skipping (and reporting) subreddits the vendor refuses for new-subreddit
 * capacity. Any other error stops the run after reporting progress.
 */
async function syncOneAtATime(
  api: RedditApisClient,
  monitorId: string,
  spec: Record<string, unknown>,
  current: readonly string[],
  diff: {added: string[]; removed: string[]},
): Promise<void> {
  const removedKeys = new Set(diff.removed.map((s) => s.toLowerCase()));
  const applied = current.filter((s) => !removedKeys.has(s.toLowerCase()));
  const update = (list: readonly string[]) =>
    api.post('update', {id: monitorId, filter_spec: withSubreddits(spec, list)});

  // An empty filter is invalid, so if every current subreddit goes, the
  // removals ride along with the first accepted addition instead.
  let removalsPending = diff.removed.length > 0;
  let calls = 0;
  if (removalsPending && applied.length > 0) {
    await update(applied);
    calls++;
    removalsPending = false;
    console.log(`✓ Removed ${diff.removed.length}: ${diff.removed.join(', ')}`);
  }

  const added: string[] = [];
  const refused: string[] = [];
  let capacityMessage = '';
  for (const [i, sub] of diff.added.entries()) {
    if (calls > 0) await sleep(ONE_AT_A_TIME_INTERVAL_MS);
    calls++;
    const progress = `(${i + 1}/${diff.added.length})`;
    try {
      const res = asRecord(await update([...applied, sub]));
      applied.push(sub);
      added.push(sub);
      removalsPending = false;
      console.log(`  ✓ + ${sub} ${progress}`);
      printNotices(res, '    ');
    } catch (e) {
      if (!isNewSubredditCapacityError(e)) {
        console.error(`✗ Stopped at ${sub} ${progress}.`);
        console.error(`  added so far: ${added.join(', ') || '(none)'}`);
        console.error(`  not tried:    ${diff.added.slice(i).join(', ')}`);
        if (refused.length) console.error(`  refused:      ${refused.join(', ')}`);
        throw e;
      }
      capacityMessage = newSubredditCapacityMessage(e.status, e.body)?.message ?? capacityMessage;
      refused.push(sub);
      console.log(`  ✗ + ${sub} ${progress} refused: vendor new-subreddit capacity`);
    }
  }

  console.log('');
  console.log(
    `✓ Monitor ${monitorId}: added ${added.length}/${diff.added.length}` +
      ' (new subreddits start from now; no backfill).',
  );
  if (removalsPending) {
    console.log(`  Removals NOT applied (every addition was refused): ${diff.removed.join(', ')}`);
  }
  if (refused.length) {
    console.log(`✗ Refused for capacity (${refused.length}): ${refused.join(', ')}`);
    console.log('  Re-run the same sync later to retry just these.');
    for (const line of newSubredditCapacityHint(capacityMessage)) console.log(line);
    process.exitCode = 1;
  }
}

function fmt(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function printHealth(health: Record<string, unknown>): void {
  console.log('    health (24h):');
  for (const k of ['delivered_24h', 'failed_24h', 'suppressed_24h', 'ceiling_reached', 'last_match_at']) {
    console.log(`      ${k.padEnd(16)} ${fmt(health[k])}`);
  }
  const breakdown = asRecord(health['suppressed_breakdown']);
  if (Object.keys(breakdown).length) {
    console.log(`      suppressed_breakdown ${JSON.stringify(breakdown)}`);
  }

  const liveness = asRecord(health['stream_liveness']);
  console.log(
    `      stream_liveness  ${fmt(liveness['status'])}` +
      (liveness['reason'] ? ` (${fmt(liveness['reason'])})` : ''),
  );
  for (const s of recordList(liveness, 'streams')) {
    const bad = s['status'] !== undefined && s['status'] !== 'live';
    if (!bad && !s['last_poll_error'] && !s['consecutive_errors']) continue;
    console.log(`        ${JSON.stringify(s)}`);
  }

  const coverage = asRecord(health['coverage_24h']);
  console.log(
    `      coverage_24h     ${fmt(coverage['status'])}` +
      (coverage['reason'] ? ` (${fmt(coverage['reason'])})` : ''),
  );
  const gaps = recordList(coverage, 'gaps');
  if (gaps.length) {
    console.log(
      `        ${gaps.length} gap(s); posts_in_window_at_least=${fmt(coverage['posts_in_window_at_least'])}` +
        ` posts_missed_estimate=${fmt(coverage['posts_missed_estimate'])}`,
    );
    for (const g of gaps.slice(0, 5)) console.log(`        ${JSON.stringify(g)}`);
  }
}

function printDeliveries(body: unknown): void {
  const rows = recordList(body, 'deliveries');
  console.log(`    last ${rows.length} deliveries:`);
  for (const d of rows) {
    const items = recordList(asRecord(d['payload']), 'items');
    const first = items[0];
    const what = first
      ? `r/${fmt(first['subreddit'])} "${String(first['title'] ?? '').slice(0, 60)}"` +
        (items.length > 1 ? ` (+${items.length - 1})` : '')
      : '';
    console.log(
      `      ${fmt(d['created_at'])}  ${fmt(d['status']).padEnd(10)} attempts=${fmt(d['attempts'])}` +
        (d['last_error'] ? ` err=${fmt(d['last_error'])}` : '') +
        (what ? `  ${what}` : ''),
    );
  }
}

async function cmdStatus(api: RedditApisClient): Promise<void> {
  const {monitors, body} = await listMonitors(api);
  const slots = asRecord(asRecord(body)['slots']);
  console.log(`Plan: tier=${fmt(slots['tier'])}  slots ${fmt(slots['used'])}/${fmt(slots['total'])}`);
  const otherSlotFields = Object.entries(slots).filter(([k]) => !['tier', 'used', 'total'].includes(k));
  for (const [k, v] of otherSlotFields) console.log(`  ${k}: ${fmt(v)}`);

  const webhooks = recordList(await api.get('webhook/list'), 'webhooks');
  console.log(`\nWebhooks (${webhooks.length}):`);
  for (const w of webhooks) {
    console.log(
      `  ${fmt(w['id'] ?? w['webhook_id'])}  kind=${fmt(w['kind'])} active=${fmt(w['active'])} url=${fmt(w['url'])}`,
    );
  }

  console.log(`\nMonitors (${monitors.length}):`);
  for (const m of monitors) {
    const id = String(m['id']);
    const spec = asRecord(m['filter_spec']);
    const subs = monitorSubreddits(m);
    console.log(`  ${id}  active=${fmt(m['active'])} cadence=${fmt(m['cadence_s'])}s kind=${fmt(spec['kind'])}`);
    console.log(`    webhook_ids: ${fmt(m['webhook_ids'])}${m['webhook_ids'] === null ? ' (every active webhook)' : ''}`);
    console.log(`    subreddits (${subs.length}): ${subs.join(', ')}`);
    try {
      printHealth(asRecord(await api.get('health', {id})));
      printDeliveries(await api.get('deliveries', {id, limit: '5'}));
    } catch (e) {
      if (!(e instanceof VendorError)) throw e;
      console.log(describeVendorError(e).replace(/^/gm, '    '));
    }
  }
}

/**
 * Picks the webhook to act on: `--webhook`, else the one the single monitor
 * targets, else the only webhook on the account.
 */
async function resolveWebhookId(api: RedditApisClient, args: ParsedArgs): Promise<string> {
  const flag = args.values['webhook'];
  if (flag) return flag;
  const {monitors} = await listMonitors(api);
  const targeted = new Set<string>();
  for (const m of monitors) {
    const ids = m['webhook_ids'];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') targeted.add(id);
  }
  if (targeted.size === 1) return [...targeted][0]!;
  const webhooks = recordList(await api.get('webhook/list'), 'webhooks')
    .filter((w) => (w['kind'] ?? 'webhook') === 'webhook');
  if (webhooks.length === 1) return String(webhooks[0]!['id'] ?? webhooks[0]!['webhook_id']);
  throw new UsageError(
    `Cannot tell which webhook to use (${webhooks.length} webhook targets). Pass --webhook <id>; ` +
      '`pnpm redditapis status` lists them.',
  );
}

async function cmdTest(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const id = await resolveWebhookId(api, args);
  const body: Record<string, unknown> = {id};
  if (args.values['comment'] === true) body['item_kind'] = 'comment';
  console.log(`· Sending a test delivery to webhook ${id}…`);
  const res = await api.post('webhook/test', body);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdRedrive(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const raw = args.values['since-hours'];
  const sinceHours = Number(raw);
  if (raw === undefined || !Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 720) {
    throw new UsageError('redrive needs --since-hours N, an integer from 1 to 720.');
  }
  const dryRun = args.values['dry-run'] === true;
  const id = await resolveWebhookId(api, args);
  const limit = REDRIVE_MAX_LIMIT;
  console.log(`· Redrive webhook ${id}, last ${sinceHours}h${dryRun ? ' (dry run)' : ''}…`);
  const request = {id, since_hours: sinceHours, limit, dry_run: dryRun};

  if (dryRun) {
    const res = await api.post('webhook/redrive', request);
    console.log(JSON.stringify(res, null, 2));
    if (redriveStep(res, limit, new Set()).selected === limit) {
      console.log(`· At least ${limit} would be re-sent; the real run keeps calling for the rest.`);
    }
    return;
  }

  const seen = new Set<string>();
  let total = 0;
  for (let call = 1; ; call++) {
    if (call > 1) await sleep(REDRIVE_CALL_INTERVAL_MS);
    const res = asRecord(await api.post('webhook/redrive', request));
    const step = redriveStep(res, limit, seen);
    total += step.selected ?? 0;
    const skipped = res['skipped_permanent'];
    console.log(
      `  call ${call}: re-sent ${step.selected ?? '?'} (running total ${total})` +
        (typeof skipped === 'number' && skipped > 0
          ? `; skipped_permanent=${skipped} ${JSON.stringify(res['skipped_by_reason'] ?? {})}`
          : ''),
    );
    if (step.selected === undefined) console.log(JSON.stringify(res, null, 2));
    if (step.done) {
      console.log(`✓ Redrive finished: ${total} re-sent (${step.reason}).`);
      return;
    }
    if (call >= REDRIVE_MAX_CALLS) {
      console.log(
        `· Stopping after ${call} calls (${total} re-sent); run redrive again for any rest.`,
      );
      return;
    }
  }
}

/** Entry point; returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`✗ ${e.message}\n`);
    console.error(USAGE);
    return 2;
  }
  if (args.command === 'help' || args.values['help'] === true) {
    console.log(USAGE);
    return 0;
  }
  const commands: Record<string, (api: RedditApisClient, args: ParsedArgs) => Promise<void>> = {
    setup: cmdSetup,
    sync: cmdSync,
    status: (api) => cmdStatus(api),
    test: cmdTest,
    redrive: cmdRedrive,
  };
  const run = commands[args.command];
  if (!run) {
    console.error(`Unknown command "${args.command}".\n`);
    console.error(USAGE);
    return 2;
  }
  const key = process.env['REDDITAPIS_KEY'];
  if (!key) {
    console.error('✗ REDDITAPIS_KEY is not set (the redditapis.com API key).');
    return 1;
  }
  try {
    await run(new RedditApisClient(key), args);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof VendorError) {
      console.error(describeVendorError(e));
      return 1;
    }
    if (e instanceof UsageError) {
      console.error(`✗ ${e.message}`);
      return 2;
    }
    throw e;
  }
}

/**
 * True when `scriptPath` (process.argv[1]) is this module. Compares real paths,
 * so symlinked invocations and paths with spaces (percent-encoded in
 * import.meta.url) still match.
 */
export function isEntryScript(moduleUrl: string, scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}

if (isEntryScript(import.meta.url, process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
