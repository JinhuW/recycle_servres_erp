import {
  FB_SELLER_DEFAULT_SETTINGS,
  type AgentDecision, type AgentExtract, type AgentIntent, type FbAd, type FbAdInput, type FbAgentEvalCase, type FbAgentRunBrief,
  type FbMessage, type FbPhoto, type FbPhotoPool, type FbPlacement, type FbSellerAccount, type FbSellerSettings,
  type FbSettingsChange, type FbThreadDetail, type FbThreadEvent,
} from '@recycle-erp/shared';
import { ApiError } from './api';
import type { FbThreadListRow } from './fbSeller';

// ─── An in-memory /api/fb-seller, for a dev build ──────────────────────────────
// Loaded only when lib/fbSeller.ts's mock switch is on in a dev build, for the
// /api/fb-seller paths only. It answers them with the same shapes, and refuses the way the backend
// does ({ error, detail } with a sentence), so the pages can be built and
// screenshotted before the seller backend lands. Every name, message and
// listing here is invented.

const now = () => new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const later = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function refuse(status: number, error: string, detail: string, path: string, method: string): never {
  throw new ApiError(status, detail, { path, method }, { error, detail });
}

// A grey tile with a number, standing in for a photo.
const tile = (n: number) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="hsl(${(n * 47) % 360} 25% 82%)"/><text x="80" y="68" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#445">#${n}</text></svg>`)}`;

const MANAGER = { id: '00000000-0000-0000-0000-000000000001', name: 'Alex Manager' };

let settings: { value: FbSellerSettings; version: number } = { value: structuredClone(FB_SELLER_DEFAULT_SETTINGS), version: 3 };
const history: FbSettingsChange[] = [
  { id: 2, version: 3, before: { ...FB_SELLER_DEFAULT_SETTINGS, pacing: { ...FB_SELLER_DEFAULT_SETTINGS.pacing, sends_per_account_day: 30 } },
    after: FB_SELLER_DEFAULT_SETTINGS, changed_by: MANAGER.id, changed_by_name: MANAGER.name, changed_at: ago(60 * 26) },
  { id: 1, version: 2, before: { ...FB_SELLER_DEFAULT_SETTINGS, offer: { ...FB_SELLER_DEFAULT_SETTINGS.offer, opening_pct: 65 } },
    after: { ...FB_SELLER_DEFAULT_SETTINGS, pacing: { ...FB_SELLER_DEFAULT_SETTINGS.pacing, sends_per_account_day: 30 } },
    changed_by: MANAGER.id, changed_by_name: MANAGER.name, changed_at: ago(60 * 50) },
];

const accounts: FbSellerAccount[] = [
  { account_no: 12, role: 'seller', agent_on: true, agent_profile_id: null, worker_id: 'erp-w-12', account_state: 'HEALTHY', live_ads: 2, open_threads: 3, needs_human: 2, sends_today: 9 },
  { account_no: 17, role: 'seller', agent_on: false, agent_profile_id: 2, worker_id: 'erp-w-17', account_state: 'HEALTHY', live_ads: 1, open_threads: 1, needs_human: 1, sends_today: 2 },
  { account_no: 23, role: 'search', agent_on: false, agent_profile_id: null, worker_id: 'erp-w-23', account_state: 'HEALTHY', live_ads: 0, open_threads: 0, needs_human: 0, sends_today: 0 },
  { account_no: 31, role: 'seller', agent_on: false, agent_profile_id: null, worker_id: null, account_state: 'RETIRED', live_ads: 0, open_threads: 1, needs_human: 0, sends_today: 0 },
];

let nextId = 1000;
const pools: Omit<FbPhotoPool, 'used' | 'unused'>[] = [
  { id: 1, name: 'Server racks', note: 'Rack shots, no labels visible', created_by: MANAGER.id, created_at: ago(60 * 24 * 9), archived_at: null },
  { id: 2, name: 'Memory and drives', note: '', created_by: MANAGER.id, created_at: ago(60 * 24 * 4), archived_at: null },
];
const photos: FbPhoto[] = [];
for (let i = 1; i <= 26; i++) {
  const pool_id = i <= 18 ? 1 : 2;
  photos.push({
    id: i, pool_id, url: tile(i), mime: 'image/jpeg', bytes: 180_000 + i * 913, width: 1600, height: 1200,
    sha256: `mock${String(i).padStart(60, '0')}`, uploaded_by: MANAGER.id, uploaded_at: ago(60 * 24 * 3 + i),
    used_at: null, used_by_placement: null,
  });
}
const poolOut = (p: (typeof pools)[number]): FbPhotoPool => {
  const mine = photos.filter(x => x.pool_id === p.id);
  const used = mine.filter(x => x.used_at).length;
  return { ...p, used, unused: mine.length - used };
};

const ads: Omit<FbAd, 'live_placements' | 'placements'>[] = [
  { id: 1, title: 'We buy used servers and parts', description: 'Recycle Servers in Denver buys used servers, memory, CPUs and drives. Send us the model and quantity and we will make you an offer. Local pickup or shipping.',
    price_usd: 1, category: 'Electronics', condition: 'Used - Good', renew_days: 7, photo_pool_id: 1, photos_min: 3, photos_max: 5, state: 'ready',
    created_by: MANAGER.id, updated_by: MANAGER.id, created_at: ago(60 * 24 * 8), updated_at: ago(60 * 24 * 2) },
  { id: 2, title: 'Cash for DDR4 / DDR5 server memory', description: 'Buying registered server memory in any quantity. Tell us the part number and how many sticks.',
    price_usd: 1, category: 'Electronics', condition: 'Used - Good', renew_days: 7, photo_pool_id: 2, photos_min: 2, photos_max: 4, state: 'draft',
    created_by: MANAGER.id, updated_by: MANAGER.id, created_at: ago(60 * 24), updated_at: ago(60 * 5) },
  { id: 3, title: 'Old winter ad', description: 'Archived copy.', price_usd: 1, category: 'Electronics', condition: 'Used - Good', renew_days: 7,
    photo_pool_id: 1, photos_min: 3, photos_max: 5, state: 'archived', created_by: MANAGER.id, updated_by: MANAGER.id, created_at: ago(60 * 24 * 40), updated_at: ago(60 * 24 * 30) },
];
const placements: FbPlacement[] = [];
function addPlacement(ad_id: number, account_no: number, location: string, state: FbPlacement['state'], nPhotos: number, extra: Partial<FbPlacement> = {}): FbPlacement {
  const ad = ads.find(a => a.id === ad_id)!;
  const id = ++nextId;
  const free = photos.filter(p => p.pool_id === ad.photo_pool_id && !p.used_at).slice(0, nPhotos);
  for (const p of free) { p.used_at = ago(60); p.used_by_placement = id; }
  const pl: FbPlacement = {
    id, ad_id, account_no, location, content: { title: ad.title, description: ad.description, price_usd: ad.price_usd, category: ad.category, condition: ad.condition },
    photo_ids: free.map(p => p.id), state, renews_id: null, fb_listing_id: null, posted_at: null, next_renew_at: null, removed_at: null,
    last_error: null, task_id: null, created_by: MANAGER.id, created_at: ago(60 * 30), updated_at: ago(30), ...extra,
  };
  placements.push(pl);
  return pl;
}
addPlacement(1, 12, 'Denver, CO', 'live', 4, { fb_listing_id: '900000000000001', posted_at: ago(60 * 24 * 2), next_renew_at: later(60 * 24 * 5) });
addPlacement(1, 12, 'Aurora, CO', 'live', 3, { fb_listing_id: '900000000000002', posted_at: ago(60 * 24), next_renew_at: later(60 * 24 * 6) });
addPlacement(1, 17, 'Boulder, CO', 'uncertain', 5, { last_error: 'The publish button was pressed but the page never showed the listing.' });
addPlacement(1, 17, 'Lakewood, CO', 'queued', 3);
const adOut = (a: (typeof ads)[number], withPlacements = false): FbAd => ({
  ...a,
  live_placements: placements.filter(p => p.ad_id === a.id && p.state === 'live').length,
  ...(withPlacements ? { placements: placements.filter(p => p.ad_id === a.id).sort((x, y) => y.id - x.id) } : {}),
});

// ─── Threads ──────────────────────────────────────────────────────────────────

type MockThread = Omit<FbThreadDetail, 'last_body'>;
const runBrief = (id: number, decision: AgentDecision, extra: Partial<FbAgentRunBrief> = {}): FbAgentRunBrief => ({
  id, profile_id: 1, shadow: false, state: 'done', outcome: decision.outcome, decision, cost_usd: 0.0021, error: null,
  created_at: ago(20), finished_at: ago(19), ...extra,
});
const extract = (desc: string, pn: string, qty: number, ask: number | null, intent: AgentIntent, agreeing = false): AgentExtract =>
  ({ items: [{ part_number: pn, description: desc, qty }], seller_ask_usd: ask, intent, agreeing, confidence: 0.86 });

function msg(thread_id: number, seq: number | null, direction: FbMessage['direction'], author: FbMessage['author'], body: string, minAgo: number, extra: Partial<FbMessage> = {}): FbMessage {
  return {
    id: ++nextId, thread_id, seq, direction, author, body, has_image: false,
    send_state: direction === 'in' ? null : 'sent', task_id: null, agent_run_id: null, staff_user_id: null, staff_name: null,
    error: null, created_at: ago(minAgo), sent_at: direction === 'in' ? null : ago(minAgo), ...extra,
  };
}
function ev(thread_id: number, kind: FbThreadEvent['kind'], minAgo: number, detail: Record<string, unknown> = {}, actor = 'system'): FbThreadEvent {
  return { id: ++nextId, thread_id, kind, actor_id: null, actor_name: actor, detail, created_at: ago(minAgo) };
}

const closingDecision: AgentDecision = {
  outcome: 'handoff', extract: extract('Dell R740 servers', 'R740', 4, 1800, 'agree', true), skill: 'negotiate', reply: null,
  offer: { offer_usd: 1620, ceiling_usd: 1800, round: 2 }, stage: 'closing',
  rules_fired: [{ kind: 'closing', reason: 'The seller agreed to the offer.' }], guard: { ok: true, failures: [] },
  handoff_reason: 'The seller agreed to $1,620 for 4 × Dell R740. Confirm the deal and arrange pickup.', usage: [{ model: 'openai/gpt-6-luna', prompt_tokens: 812, completion_tokens: 96, cost_usd: 0.0021 }],
};
const sendDecision: AgentDecision = {
  outcome: 'send', extract: extract('Samsung 32GB DDR4 RDIMM', 'M393A4K40DB3-CWE', 24, null, 'offer_items'), skill: 'negotiate',
  reply: 'Thanks! For 24 of those we can offer $672. Does that work for you?', offer: { offer_usd: 672, ceiling_usd: 960, round: 0 },
  stage: 'negotiating', rules_fired: [], guard: { ok: true, failures: [] }, handoff_reason: null,
  usage: [{ model: 'openai/gpt-6-luna', prompt_tokens: 700, completion_tokens: 80, cost_usd: 0.0018 }],
};

const threads: MockThread[] = [];
function addThread(t: Partial<MockThread> & Pick<MockThread, 'id' | 'account_no' | 'seller_name' | 'listing_title' | 'stage'>): MockThread {
  const row: MockThread = {
    fb_thread_id: `t_${t.id}`, placement_id: null, mode: 'agent', needs_human: false, human_reason: null, human_at: null,
    offer_usd: null, round: 0, unread: false, last_inbound_at: null, last_outbound_at: null, closed_at: null, updated_at: now(),
    ceiling_usd: null, extracted: {}, close_note: null, messages: [], events: [], runs: [], market: [], ...t,
  };
  threads.push(row);
  return row;
}
{
  const t = addThread({
    id: 1, account_no: 12, seller_name: 'Jordan P.', listing_title: 'We buy used servers and parts', stage: 'closing', needs_human: true,
    human_reason: 'The seller agreed to $1,620 for 4 × Dell R740. Confirm the deal and arrange pickup.', human_at: ago(42),
    offer_usd: 1620, ceiling_usd: 1800, round: 2, unread: true, last_inbound_at: ago(42), last_outbound_at: ago(80), placement_id: 1001,
    extracted: closingDecision.extract!,
    market: [{ canon: 'R740', part_number: 'R740', label: 'Dell PowerEdge R740 (2× Silver 4114, 64 GB)', max_buy_unit: 450, price_at: ago(60 * 24 * 6) }],
  });
  t.messages = [
    msg(1, 1, 'in', 'seller', 'Hi, I have 4 Dell R740 servers from an office closing. Interested?', 200),
    msg(1, 2, 'out', 'agent', 'Hi! Yes, we buy those. What CPUs and memory do they have, and are they working?', 190, { agent_run_id: 11 }),
    msg(1, 3, 'in', 'seller', 'Dual silver 4114, 64GB each, all working. Looking for 2k for all four.', 150),
    msg(1, 4, 'out', 'agent', 'Thanks for the details. We can offer $1,440 for all four.', 140, { agent_run_id: 12 }),
    msg(1, 5, 'in', 'seller', 'Could you do a bit better?', 100),
    msg(1, 6, 'out', 'agent', 'We can go to $1,620 for the four.', 80, { agent_run_id: 13 }),
    msg(1, 7, 'in', 'seller', 'Ok deal, when can you pick up?', 42),
  ];
  t.events = [ev(1, 'created', 200), ev(1, 'inbound', 200), ev(1, 'agent_sent', 190), ev(1, 'offer', 140, { offer_usd: 1440 }), ev(1, 'offer', 80, { offer_usd: 1620 }),
    ev(1, 'stage', 42, { to: 'closing' }), ev(1, 'handed_off', 42, { reason: t.human_reason })];
  t.runs = [runBrief(14, closingDecision, { created_at: ago(42), finished_at: ago(41) }), runBrief(13, { ...sendDecision, offer: { offer_usd: 1620, ceiling_usd: 1800, round: 2 }, reply: 'We can go to $1,620 for the four.' })];
}
{
  const t = addThread({
    id: 2, account_no: 12, seller_name: 'Sam K.', listing_title: 'We buy used servers and parts', stage: 'screening', needs_human: true,
    human_reason: 'The seller sent a photo the agent cannot read.', human_at: ago(15), unread: true, last_inbound_at: ago(15),
  });
  t.messages = [msg(2, 1, 'in', 'seller', 'What would you pay for these?', 15, { has_image: true })];
  t.events = [ev(2, 'created', 15), ev(2, 'inbound', 15), ev(2, 'handed_off', 15, { reason: t.human_reason })];
  t.runs = [runBrief(21, { ...closingDecision, offer: null, stage: 'screening', rules_fired: [{ kind: 'has_image', reason: 'The latest message has an image.' }], handoff_reason: t.human_reason })];
}
{
  const t = addThread({
    id: 3, account_no: 17, seller_name: 'Riley M.', listing_title: 'We buy used servers and parts', stage: 'negotiating', needs_human: true, mode: 'human',
    human_reason: 'No Market price for HPE DL380 Gen10 Plus.', human_at: ago(180), offer_usd: null, last_inbound_at: ago(185), last_outbound_at: ago(30),
  });
  t.messages = [
    msg(3, 1, 'in', 'seller', 'Got two DL380 gen10 plus, what is your offer?', 185),
    msg(3, null, 'out', 'staff', 'Thanks Riley, checking our price and will get back to you shortly.', 30, { send_state: 'queued', sent_at: null, staff_user_id: MANAGER.id, staff_name: MANAGER.name }),
  ];
  t.events = [ev(3, 'created', 185), ev(3, 'handed_off', 180, { reason: t.human_reason }), ev(3, 'taken_over', 35, {}, MANAGER.name), ev(3, 'staff_sent', 30, {}, MANAGER.name)];
}
{
  const t = addThread({
    id: 4, account_no: 12, seller_name: 'Casey D.', listing_title: 'We buy used servers and parts', stage: 'negotiating', offer_usd: 672, ceiling_usd: 960,
    last_inbound_at: ago(9), last_outbound_at: ago(6),
    extracted: sendDecision.extract!,
    market: [{ canon: 'M393A4K40DB3CWE', part_number: 'M393A4K40DB3-CWE', label: 'Samsung 32GB 2Rx4 DDR4-3200 RDIMM', max_buy_unit: 40, price_at: ago(60 * 24 * 2) }],
  });
  t.messages = [
    msg(4, 1, 'in', 'seller', 'I have 24 sticks of M393A4K40DB3-CWE', 9),
    msg(4, null, 'out', 'agent', 'Thanks! For 24 of those we can offer $672. Does that work for you?', 6, { send_state: 'sending', sent_at: null, agent_run_id: 41 }),
  ];
  t.events = [ev(4, 'created', 9), ev(4, 'inbound', 9), ev(4, 'offer', 7, { offer_usd: 672 })];
  t.runs = [runBrief(41, sendDecision, { created_at: ago(7), finished_at: ago(7) })];
}
{
  const t = addThread({
    id: 5, account_no: 31, seller_name: 'Morgan T.', listing_title: 'We buy used servers and parts', stage: 'screening', last_inbound_at: ago(60 * 30), last_outbound_at: ago(60 * 29),
  });
  t.messages = [
    msg(5, 1, 'in', 'seller', 'Do you buy network switches?', 60 * 30),
    msg(5, 2, 'out', 'agent', 'We do! Which models and how many?', 60 * 29, { send_state: 'failed', error: 'The message box was not found on the conversation page.' }),
  ];
  t.events = [ev(5, 'created', 60 * 30), ev(5, 'send_failed', 60 * 29)];
}
addThread({ id: 6, account_no: 17, seller_name: 'Taylor B.', listing_title: 'We buy used servers and parts', stage: 'won', closed_at: ago(60 * 24 * 2), close_note: 'Picked up 6 drives.', offer_usd: 180 });
addThread({ id: 7, account_no: 12, seller_name: 'Avery L.', listing_title: 'We buy used servers and parts', stage: 'lost', closed_at: ago(60 * 24 * 3), close_note: 'Sold elsewhere.' });

const listRow = (t: MockThread): FbThreadListRow => {
  const { messages, events: _e, runs: _r, market: _m, extracted: _x, close_note: _c, ...row } = t;
  return { ...row, last_body: messages[messages.length - 1]?.body ?? null };
};
const detail = (t: MockThread): FbThreadDetail => ({ ...t, last_body: t.messages[t.messages.length - 1]?.body ?? null });

// Saved test cases, which "Save as test case" adds to; the agent routes
// themselves are the backend's.
const cases: FbAgentEvalCase[] = [];

// ─── The router ───────────────────────────────────────────────────────────────

const summary = () => ({
  needs_human: threads.filter(t => t.needs_human && !t.closed_at).length,
  unread: threads.filter(t => t.unread).length,
  uncertain_placements: placements.filter(p => p.state === 'uncertain').length,
  needs_photos: placements.filter(p => p.state === 'needs_photos').length,
  low_pools: pools.filter(p => !p.archived_at && poolOut(p).unused < settings.value.photos.low_pool_warning).length,
});

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: unknown) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

on('GET', /^\/api\/fb-seller\/summary$/, () => summary());
on('GET', /^\/api\/fb-seller\/settings$/, () => structuredClone(settings));
on('PUT', /^\/api\/fb-seller\/settings$/, (_m, _q, b) => {
  const { value, version } = b as { value: FbSellerSettings; version: number };
  if (version !== settings.version) refuse(409, 'stale_settings', 'Someone saved the settings since you opened them.', '/api/fb-seller/settings', 'PUT');
  history.unshift({ id: history.length + 1, version: version + 1, before: settings.value, after: value, changed_by: MANAGER.id, changed_by_name: MANAGER.name, changed_at: now() });
  settings = { value: structuredClone(value), version: version + 1 };
  return structuredClone(settings);
});
on('GET', /^\/api\/fb-seller\/settings\/history$/, () => ({ rows: history, next: null }));
on('GET', /^\/api\/fb-seller\/accounts$/, () => ({ rows: accounts }));
on('PATCH', /^\/api\/fb-seller\/accounts\/(\d+)$/, (m, _q, b) => {
  const a = accounts.find(x => x.account_no === Number(m[1]));
  if (!a) refuse(404, 'not_found', 'That account is not in the fleet.', m[0], 'PATCH');
  Object.assign(a, b);
  if (a.role === 'search') a.agent_on = false;
  return a;
});
on('GET', /^\/api\/fb-seller\/pools$/, () => ({ rows: pools.map(poolOut) }));
on('POST', /^\/api\/fb-seller\/pools$/, (_m, _q, b) => {
  const { name, note } = b as { name: string; note?: string };
  if (pools.some(p => p.name === name)) refuse(409, 'pool_exists', `A pool named "${name}" already exists.`, '/api/fb-seller/pools', 'POST');
  const p = { id: ++nextId, name, note: note ?? '', created_by: MANAGER.id, created_at: now(), archived_at: null };
  pools.push(p);
  return poolOut(p);
});
on('PATCH', /^\/api\/fb-seller\/pools\/(\d+)$/, (m, _q, b) => {
  const p = pools.find(x => x.id === Number(m[1]))!;
  const { archived, ...rest } = b as { archived?: boolean; name?: string; note?: string };
  Object.assign(p, rest);
  if (archived !== undefined) p.archived_at = archived ? now() : null;
  return poolOut(p);
});
on('GET', /^\/api\/fb-seller\/pools\/(\d+)\/photos$/, (m, q) => {
  const used = q.get('used') ?? 'all';
  const rows = photos.filter(p => p.pool_id === Number(m[1]) && (used === 'all' || (used === 'used') === !!p.used_at)).sort((a, b) => b.id - a.id);
  return { rows, next: null };
});
on('POST', /^\/api\/fb-seller\/pools\/(\d+)\/photos$/, (m, _q, b) => {
  const files = (b as FormData).getAll('file') as File[];
  const added: FbPhoto[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) { refused.push({ name: f.name, reason: 'Only photos can go in a pool.' }); continue; }
    const dup = photos.find(p => p.bytes === f.size);
    if (dup) { refused.push({ name: f.name, reason: `The same photo is already in "${pools.find(p => p.id === dup.pool_id)?.name}" as photo #${dup.id}.` }); continue; }
    const p: FbPhoto = { id: ++nextId, pool_id: Number(m[1]), url: URL.createObjectURL(f), mime: f.type, bytes: f.size, width: null, height: null,
      sha256: `mock-${nextId}`, uploaded_by: MANAGER.id, uploaded_at: now(), used_at: null, used_by_placement: null };
    photos.push(p);
    added.push(p);
  }
  return { added, refused };
});
on('DELETE', /^\/api\/fb-seller\/photos\/(\d+)$/, m => {
  const i = photos.findIndex(p => p.id === Number(m[1]));
  if (photos[i]?.used_at) refuse(409, 'photo_used', 'That photo has been posted, so it stays on record.', m[0], 'DELETE');
  photos.splice(i, 1);
  return { ok: true };
});
on('GET', /^\/api\/fb-seller\/ads$/, (_m, q) => ({ rows: ads.filter(a => !q.get('state') || a.state === q.get('state')).map(a => adOut(a)) }));
on('GET', /^\/api\/fb-seller\/ads\/(\d+)$/, m => adOut(ads.find(a => a.id === Number(m[1]))!, true));
on('POST', /^\/api\/fb-seller\/ads$/, (_m, _q, b) => {
  const i = b as FbAdInput;
  const a = { category: 'Electronics', condition: 'Used - Good', renew_days: settings.value.pacing.renew_days, photos_min: 3, photos_max: 5, ...i,
    id: ++nextId, state: 'draft' as const, created_by: MANAGER.id, updated_by: MANAGER.id, created_at: now(), updated_at: now() };
  ads.unshift(a);
  return adOut(a, true);
});
on('PATCH', /^\/api\/fb-seller\/ads\/(\d+)$/, (m, _q, b) => {
  const a = ads.find(x => x.id === Number(m[1]))!;
  Object.assign(a, b, { updated_at: now() });
  return adOut(a, true);
});
on('POST', /^\/api\/fb-seller\/ads\/(\d+)\/place$/, (m, _q, b) => {
  const { account_nos, locations } = b as { account_nos: number[]; locations: string[] };
  const ad = ads.find(x => x.id === Number(m[1]))!;
  const out: FbPlacement[] = [];
  const refused: { account_no: number; location: string; reason: string }[] = [];
  for (const no of account_nos) for (const loc of locations) {
    const acct = accounts.find(a => a.account_no === no);
    if (ad.state !== 'ready') refused.push({ account_no: no, location: loc, reason: 'The ad is not ready; mark it ready first.' });
    else if (acct?.account_state === 'RETIRED') refused.push({ account_no: no, location: loc, reason: `Account #${no} is retired, so it cannot post.` });
    else if (acct?.role !== 'seller') refused.push({ account_no: no, location: loc, reason: `Account #${no} is not a seller account.` });
    else if (placements.some(p => p.ad_id === ad.id && p.location === loc && Date.parse(p.created_at) > Date.now() - 86_400_000)) {
      refused.push({ account_no: no, location: loc, reason: `This ad was already placed in ${loc} today.` });
    } else out.push(addPlacement(ad.id, no, loc, 'queued', ad.photos_max));
  }
  return { placements: out, refused };
});
on('GET', /^\/api\/fb-seller\/placements$/, (_m, q) => ({
  rows: placements.filter(p => (!q.get('state') || p.state === q.get('state')) && (!q.get('account_no') || p.account_no === Number(q.get('account_no')))).sort((a, b) => b.id - a.id),
  next: null,
}));
const pl = (m: RegExpMatchArray) => placements.find(p => p.id === Number(m[1]))!;
on('POST', /^\/api\/fb-seller\/placements\/(\d+)\/renew$/, m => {
  const old = pl(m);
  old.state = 'removing';
  return addPlacement(old.ad_id, old.account_no!, old.location, 'queued', 3, { renews_id: old.id });
});
on('POST', /^\/api\/fb-seller\/placements\/(\d+)\/remove$/, m => Object.assign(pl(m), { state: 'removing', updated_at: now() }));
on('POST', /^\/api\/fb-seller\/placements\/(\d+)\/resolve$/, (m, _q, b) => {
  const p = pl(m);
  if (p.state !== 'uncertain') refuse(409, 'not_uncertain', 'Only a placement whose outcome is unknown can be resolved.', m[0], 'POST');
  const { live, fb_listing_id } = b as { live: boolean; fb_listing_id?: string };
  return Object.assign(p, live ? { state: 'live', fb_listing_id: fb_listing_id ?? null, posted_at: now(), last_error: null } : { state: 'failed' });
});
const th = (m: RegExpMatchArray) => threads.find(t => t.id === Number(m[1]))!;
on('GET', /^\/api\/fb-seller\/threads$/, (_m, q) => {
  const view = q.get('view');
  const needle = (q.get('q') ?? '').toLowerCase();
  const rows = threads.filter(t =>
    (view === 'needs_human' ? t.needs_human && !t.closed_at : view === 'closed' ? !!t.closed_at : !t.closed_at)
    && (!q.get('account_no') || t.account_no === Number(q.get('account_no')))
    && (!needle || [t.seller_name, t.listing_title, ...t.messages.map(x => x.body)].some(s => s.toLowerCase().includes(needle))));
  return { rows: rows.map(listRow).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)), next: null };
});
on('GET', /^\/api\/fb-seller\/threads\/(\d+)$/, m => {
  const t = th(m);
  if (!t) refuse(404, 'not_found', 'That conversation does not exist.', m[0], 'GET');
  return detail(t);
});
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/reply$/, (m, _q, b) => {
  const t = th(m);
  const out = msg(t.id, null, 'out', 'staff', (b as { body: string }).body, 0, { send_state: 'queued', sent_at: null, staff_user_id: MANAGER.id, staff_name: MANAGER.name });
  t.messages.push(out);
  t.events.push(ev(t.id, 'staff_sent', 0, {}, MANAGER.name));
  return out;
});
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/take-over$/, m => {
  const t = th(m);
  Object.assign(t, { mode: 'human' });
  t.events.push(ev(t.id, 'taken_over', 0, {}, MANAGER.name));
  return detail(t);
});
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/hand-back$/, m => {
  const t = th(m);
  Object.assign(t, { mode: 'agent', needs_human: false, human_reason: null, human_at: null });
  t.events.push(ev(t.id, 'handed_back', 0, {}, MANAGER.name));
  return detail(t);
});
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/close$/, (m, _q, b) => {
  const t = th(m);
  const { outcome, note } = b as { outcome: 'won' | 'lost'; note?: string };
  Object.assign(t, { stage: outcome, closed_at: now(), close_note: note ?? null, needs_human: false });
  t.events.push(ev(t.id, 'closed', 0, { outcome }, MANAGER.name));
  return detail(t);
});
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/read$/, m => { th(m).unread = false; return { ok: true }; });
on('POST', /^\/api\/fb-seller\/threads\/(\d+)\/save-case$/, (m, _q, b) => {
  const t = th(m);
  const { name, expected } = b as { name: string; expected: FbAgentEvalCase['expected'] };
  const c: FbAgentEvalCase = { id: ++nextId, name, source_thread_id: t.id, expected, created_by: MANAGER.id, created_at: now(), archived_at: null,
    input: { thread: { id: null, stage: t.stage, round: t.round, offer_usd: t.offer_usd, listing_title: t.listing_title },
      messages: t.messages.filter(x => x.seq !== null).map(x => ({ seq: x.seq!, direction: x.direction, author: x.author, body: x.body, has_image: x.has_image })),
      market: t.market, settings: settings.value.offer, now: now() } };
  cases.unshift(c);
  return { case_id: c.id };
});

async function handle<T>(method: string, path: string, body?: unknown): Promise<T> {
  await new Promise(r => setTimeout(r, 120));
  const [p, query = ''] = path.split('?');
  for (const [mth, re, h] of routes) {
    const m = mth === method ? p.match(re) : null;
    if (m) return structuredClone(h(m, new URLSearchParams(query), body)) as T;
  }
  return refuse(404, 'not_found', `The mock has no ${method} ${p}.`, p, method);
}

export const fbMockTransport = {
  get: <T,>(path: string) => handle<T>('GET', path),
  post: <T,>(path: string, body: unknown) => handle<T>('POST', path, body),
  put: <T,>(path: string, body: unknown) => handle<T>('PUT', path, body),
  patch: <T,>(path: string, body: unknown) => handle<T>('PATCH', path, body),
  delete: <T,>(path: string) => handle<T>('DELETE', path),
  upload: <T,>(path: string, form: FormData) => handle<T>('POST', path, form),
};
