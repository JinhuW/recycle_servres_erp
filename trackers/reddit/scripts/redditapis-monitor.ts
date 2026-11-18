#!/usr/bin/env tsx
// Configures the redditapis.com "monitoring" side of the tracker: one webhook
// target pointing at the api's POST /webhooks/redditapis, and one monitor that
// watches every new post in the enabled subreddits. Ops-only; the tracker
// itself never calls the vendor's management API.
//
//   REDDITAPIS_KEY=… pnpm redditapis setup --url https://…/webhooks/redditapis
//   REDDITAPIS_KEY=… pnpm redditapis sync
//   REDDITAPIS_KEY=… pnpm redditapis status
//
// Vendor reference: https://docs.redditapis.com/docs/monitoring/endpoints and
// the request schemas in https://docs.redditapis.com/openapi.json.

import 'dotenv/config';
import postgres from 'postgres';

const API_BASE = 'https://api.redditapis.com/api/reddit/monitor';

/** The vendor caps one monitor at 50 subreddits (filter_spec.subreddit). */
export const MAX_SUBREDDITS_PER_MONITOR = 50;

const USAGE = `Usage: pnpm redditapis <command> [options]

Configures the redditapis.com monitor that pushes new Reddit posts to the
tracker api. Needs REDDITAPIS_KEY; reads enabled subreddits via DATABASE_URL
unless --subreddits is given.

Commands:
  setup --url <webhook url> [--subreddits a,b,c]
      Create the webhook target (prints its signing secret ONCE) and one
      monitor for the subreddits, delivering only to that webhook.
  sync [--subreddits a,b,c]
      Make the existing monitor's subreddit list match the enabled
      subreddits (or the flag).
  status
      Monitors, plan slots, webhooks, per-monitor health and recent
      deliveries.
  test [--webhook <id>] [--comment]
      Send a signed synthetic delivery to the webhook.
  redrive --since-hours N [--dry-run] [--webhook <id>]
      Re-send the webhook's dead-lettered deliveries from the last N hours.
  help
      This text.
`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parsed command line: the command, positional args and `--flag [value]`s. */
export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Boolean flags never consume the following token as their value. */
const BOOLEAN_FLAGS = new Set(['dry-run', 'comment']);

/**
 * Parses `argv` (without node and script path). Accepts `--name value`,
 * `--name=value` and bare boolean flags. The first positional is the command;
 * no command means `help`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  const [command = 'help', ...rest] = positionals;
  return {command, positionals: rest, flags};
}

/** Returns a flag's string value, or undefined; throws if it was given bare. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
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
    lines.push('  Monitoring is restarting; nothing was changed. Retry in a few seconds.');
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
      'DATABASE_URL is not set. Set it, or pass --subreddits a,b,c instead.',
    );
  }
  const sql = postgres(url, {onnotice: () => {}, max: 1});
  try {
    const rows = await sql`SELECT name FROM subreddits WHERE enabled ORDER BY name`;
    return rows.map((r) => r['name'] as string);
  } finally {
    await sql.end();
  }
}

async function wantedSubreddits(args: ParsedArgs): Promise<string[]> {
  const flag = stringFlag(args, 'subreddits');
  const names = flag !== undefined ? parseSubredditList(flag) : await enabledSubredditsFromDb();
  console.log(
    `· ${names.length} subreddit(s) from ${flag !== undefined ? '--subreddits' : 'the subreddits table'}: ` +
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

async function cmdSetup(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const url = stringFlag(args, 'url');
  if (!url) throw new UsageError('setup needs --url <webhook url>.');
  if (!url.startsWith('https://')) throw new UsageError('The webhook url must be https://.');

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
  const filterSpec = buildFilterSpec(await wantedSubreddits(args));

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
  console.log('  !! The secret is shown ONCE and cannot be read back. Set it now as');
  console.log('  !! REDDITAPIS_WEBHOOK_SECRET on the Railway api service.');
  console.log('');
  if (!webhookId) {
    console.error('✗ No webhook id in the response; not creating the monitor.');
    process.exitCode = 1;
    return;
  }

  const monitor = asRecord(
    await api.post('add', {filter_spec: filterSpec, webhook_ids: [webhookId]}),
  );
  const m = asRecord(monitor['monitor']);
  const monitorId = monitor['id'] ?? m['id'];
  const cadence = monitor['cadence_s'] ?? m['cadence_s'];
  console.log('✓ Monitor created');
  console.log(`  id:       ${String(monitorId)}`);
  console.log(`  cadence:  ${cadence === undefined ? '?' : `${String(cadence)}s`}`);
  console.log(`  watching: ${filterSpec.subreddit.length} subreddit(s), kind=post, no keyword filter`);
  console.log(`  delivers: only to webhook ${webhookId}`);
  const notices = monitor['notices'];
  if (Array.isArray(notices) && notices.length > 0) {
    console.log(`  notices:  ${JSON.stringify(notices, null, 2)}`);
  }
  console.log('');
  console.log('Next: set the secret on Railway, then `pnpm redditapis test`.');
}

async function cmdSync(api: RedditApisClient, args: ParsedArgs): Promise<void> {
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
  const current = monitorSubreddits(monitor);
  const wanted = normalizeSubreddits(await wantedSubreddits(args));
  const {added, removed} = diffSubreddits(current, wanted);
  if (added.length === 0 && removed.length === 0) {
    console.log(`✓ Monitor ${String(monitor['id'])} already watches exactly these subreddits.`);
    return;
  }
  if (added.length) console.log(`  + ${added.join(', ')}`);
  if (removed.length) console.log(`  - ${removed.join(', ')}`);
  const filterSpec = withSubreddits(asRecord(monitor['filter_spec']), wanted);
  const res = asRecord(await api.post('update', {id: monitor['id'], filter_spec: filterSpec}));
  console.log(`✓ Monitor ${String(monitor['id'])} updated (new subreddits start from now; no backfill).`);
  const notices = res['notices'];
  if (Array.isArray(notices) && notices.length > 0) {
    console.log(`  notices: ${JSON.stringify(notices, null, 2)}`);
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
  const flag = stringFlag(args, 'webhook');
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
  if (args.flags.get('comment') === true) body['item_kind'] = 'comment';
  console.log(`· Sending a test delivery to webhook ${id}…`);
  const res = await api.post('webhook/test', body);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdRedrive(api: RedditApisClient, args: ParsedArgs): Promise<void> {
  const raw = stringFlag(args, 'since-hours');
  const sinceHours = Number(raw);
  if (raw === undefined || !Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 720) {
    throw new UsageError('redrive needs --since-hours N, an integer from 1 to 720.');
  }
  const dryRun = args.flags.get('dry-run') === true;
  const id = await resolveWebhookId(api, args);
  console.log(`· Redrive webhook ${id}, last ${sinceHours}h${dryRun ? ' (dry run)' : ''}…`);
  const res = await api.post('webhook/redrive', {id, since_hours: sinceHours, dry_run: dryRun});
  console.log(JSON.stringify(res, null, 2));
}

/** Entry point; returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help' || args.flags.has('help')) {
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

const isCliEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isCliEntry) {
  process.exitCode = await main(process.argv.slice(2));
}
