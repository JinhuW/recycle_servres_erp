// Fleet dashboard — reads the rs-console facade and renders the fleet.
//
// One document does most of the work: GET /v1/fleet joins fleet.toml,
// master.toml, the live monitor config and the coordinator's worker health.
// Three smaller reads decorate it — open checkpoints, review volume, and
// alert hits per city. Everything fails soft: a read that errors leaves its
// card badged "unavailable" and the rest of the page standing.
//
// No framework, no build step: this is the standalone face of the data. The
// markup and class names mirror the ERP's DesktopCoordinator page so the
// cards here can be ported into it as React components later.

const REFRESH_MS = 30_000;
const STATS_DAYS = 14;
const HITS_DAYS = 7;
const TOKEN_KEY = 'rs-console-token';

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  fleet: null,        // the /v1/fleet document, or 'unavailable'
  challenges: null,   // open checkpoints, or 'unavailable'
  stats: null,        // review-stats days, or 'unavailable'
  hits: null,         // alert-hit rows, or 'unavailable'
  updatedAt: null,
  query: '',
  filter: 'all',      // all | active | attention
  expanded: new Set(),
};

// ── Tiny helpers ───────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  check2: '<path d="M20 6L9 17l-5-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
};
const icon = (name, size = 14, cls = '') =>
  `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const fmt = new Intl.NumberFormat('en-US');
const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

// Same thresholds as the ERP's relTime, so the two pages agree on "3 hours ago".
function relTime(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return rtf.format(0, 'second');
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), 'hour');
  if (diff < 86400 * 7) return rtf.format(-Math.floor(diff / 86400), 'day');
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

// Where to watch a worker's browser. The console's own viewer page
// (`vnc_live`) beats a link written into config, and a challenge row that
// names no URL borrows its worker's.
function vncLink(w) {
  if (!w) return null;
  return w.vnc_url ?? w.health?.vnc_url ?? w.account?.vnc_url ?? null;
}
function vncFor(workerId) {
  const fleet = state.fleet;
  if (!fleet || fleet === 'unavailable') return null;
  return vncLink((fleet.workers ?? []).find(w => w.worker_id === workerId));
}
function watchButton(url, live, label = 'Watch') {
  if (!url) return '';
  const title = live ? "Open the worker's live browser in a new tab" : 'VNC link from config';
  return `<a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener" title="${title}">${icon('eye', 13)} ${label}</a>`;
}

// "Chrome 151 · macOS" from a full user-agent string, or the raw string
// shortened when it matches nothing familiar.
function browserLabel(ua) {
  if (!ua) return null;
  const browser = ua.match(/(Firefox|Edg|Chrome|Safari)\/(\d+)/);
  const os = /Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux|X11/.test(ua) ? 'Linux' : null;
  if (!browser) return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
  const name = browser[1] === 'Edg' ? 'Edge' : browser[1];
  return `${name} ${browser[2]}${os ? ` · ${os}` : ''}`;
}

// The Facebook identity behind a worker: login email/name from the vault
// account, numeric user id from the backed-up session.
function whoIs(w) {
  return {
    login: w.account?.fb_username || null,
    label: w.account?.account_id || w.session?.account_id || null,
    userId: w.session?.fb_user_id || null,
  };
}

// Query matching: every whitespace-separated term must appear somewhere in
// the haystack. Case-insensitive; a slug like "fort-myers-fl" matches "myers".
function terms() {
  return state.query.toLowerCase().split(/\s+/).filter(Boolean);
}
function matches(haystack, ts = terms()) {
  if (ts.length === 0) return true;
  const h = haystack.toLowerCase();
  return ts.every(t => h.includes(t));
}
// Wrap matched terms in <mark>. Input must already be escaped.
function hi(escapedText, ts = terms()) {
  if (ts.length === 0) return escapedText;
  const pattern = ts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return escapedText.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
}

// ── API ────────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function get(path) {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) throw new ApiError(401, 'No token');
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch { /* not JSON */ }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

async function load() {
  if (!localStorage.getItem(TOKEN_KEY)) { openTokenModal(); return; }

  const soft = (p, key) => p.then(v => { state[key] = v; }).catch(err => {
    if (err instanceof ApiError && err.status === 401) throw err;
    state[key] = 'unavailable';
  });

  try {
    await Promise.all([
      soft(get('/v1/fleet'), 'fleet'),
      soft(get('/v1/challenges?status=open').then(r => r.challenges ?? []), 'challenges'),
      soft(get(`/v1/stats/reviews?days=${STATS_DAYS}`).then(r => r.days ?? []), 'stats'),
      soft(get(`/v1/stats/alert-hits?days=${HITS_DAYS}`).then(r => r.rows ?? []), 'hits'),
    ]);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      openTokenModal('That token was refused. Check it against the homelab’s secrets.env.');
      return;
    }
    throw err;
  }
  state.updatedAt = Date.now();
  render();
}

// ── Derived views ──────────────────────────────────────────────────────────────

const liveness = (w) => w.health?.liveness ?? 'none';
const isActive = (w) => liveness(w) === 'live' || liveness(w) === 'stale';
const needsAttention = (w) => Boolean(w.health?.needs_attention);

// Alert hits per search city over the window: {slug: {sent, hit}}.
function hitsByCity() {
  const out = new Map();
  if (!Array.isArray(state.hits)) return out;
  for (const row of state.hits) {
    if (!row.search_city) continue;
    const cur = out.get(row.search_city) ?? { sent: 0, hit: 0 };
    cur.sent += row.sent ?? 0;
    cur.hit += row.hit ?? 0;
    out.set(row.search_city, cur);
  }
  return out;
}

// Which workers currently search a given city slug — for the coverage card.
function searchersByCity(workers) {
  const out = new Map();
  for (const w of workers) {
    for (const c of w.cities ?? []) {
      if (!out.has(c.slug)) out.set(c.slug, []);
      out.get(c.slug).push(w);
    }
  }
  return out;
}

function workerHaystack(w) {
  return [
    w.worker_id, w.health?.account_id, w.health?.state, liveness(w),
    w.region?.key, w.region?.name, w.source, w.proxy_env,
    w.account?.account_id, w.account?.fb_username, w.session?.fb_user_id,
    ...(w.cities ?? []).flatMap(c => [c.name, c.slug]),
  ].filter(Boolean).join(' ');
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function render() {
  renderUpdated();
  renderKpis();
  renderAttention();
  renderAccounts();
  renderAccountInfo();
  renderPhrases();
  renderSettings();
  renderCoverage();
}

function renderUpdated() {
  const el = $('#updated');
  if (!state.updatedAt) { el.textContent = 'Loading…'; return; }
  const sec = Math.round((Date.now() - state.updatedAt) / 1000);
  el.textContent = sec < 5 ? 'Updated just now' : `Updated ${relTime(new Date(state.updatedAt).toISOString())}`;
}

function kpi(label, value, trend, opts = {}) {
  return `<div class="kpi">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value mono">${value}${opts.of != null ? `<small>/ ${esc(opts.of)}</small>` : ''}</div>
    <div class="kpi-trend ${opts.tone ?? ''}">${trend}</div>
  </div>`;
}

function renderKpis() {
  const fleet = state.fleet;
  const el = $('#kpis');
  if (!fleet) {
    el.innerHTML = Array.from({ length: 4 }, () => kpi('', '<span class="skeleton"></span>', '<span class="skeleton" style="width:80px"></span>')).join('');
    return;
  }
  if (fleet === 'unavailable') {
    el.innerHTML = kpi('Fleet', '—', 'The facade did not answer') + kpi('', '', '') + kpi('', '', '') + kpi('', '', '');
    return;
  }

  const workers = fleet.workers ?? [];
  const configured = workers.filter(w => w.source !== 'unconfigured');
  const live = workers.filter(w => liveness(w) === 'live');
  const reporting = workers.filter(w => w.health);
  const attention = workers.filter(needsAttention);

  const searchedNow = new Set(workers.filter(isActive).flatMap(w => (w.cities ?? []).map(c => c.slug)));
  const allCities = new Set((fleet.regions ?? []).flatMap(r => r.cities.map(c => c.slug)));
  for (const w of workers) for (const c of w.cities ?? []) allCities.add(c.slug);

  const items = fleet.items ?? [];
  const enabled = items.filter(i => i.enabled);
  const phrases = enabled.reduce((n, i) => n + (i.search_phrases?.length ?? 0), 0);

  let reviewedToday = '—', alertsToday = null, reviewed7 = null;
  if (Array.isArray(state.stats)) {
    const today = state.stats.find(d => d.day === todayUtc());
    reviewedToday = fmt.format(today?.reviewed ?? 0);
    alertsToday = today?.alerted ?? 0;
    const cutoff = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    reviewed7 = state.stats.filter(d => d.day >= cutoff).reduce((n, d) => n + d.reviewed, 0);
  }

  el.innerHTML = [
    kpi('Accounts live', fmt.format(live.length),
      attention.length
        ? `${icon('alert', 12)} ${attention.length} need${attention.length === 1 ? 's' : ''} attention`
        : `${reporting.length} reporting · ${configured.length} configured`,
      { of: configured.length, tone: attention.length ? 'down' : '' }),
    kpi('Cities searched now', fmt.format(searchedNow.size),
      `${fmt.format(allCities.size)} configured across ${(fleet.regions ?? []).length} regions`,
      { of: allCities.size }),
    kpi('Search phrases', fmt.format(phrases),
      `${enabled.length} of ${items.length} item${items.length === 1 ? '' : 's'} enabled`),
    kpi('Listings reviewed today', reviewedToday,
      state.stats === 'unavailable' ? 'Review stats unavailable'
        : alertsToday === null ? '…'
        : `${fmt.format(alertsToday)} alerted today · ${fmt.format(reviewed7 ?? 0)} reviewed in 7 days`),
  ].join('');
}

function renderAttention() {
  const el = $('#attention');
  const fleet = state.fleet;
  const challenges = Array.isArray(state.challenges) ? state.challenges : [];
  const flagged = fleet && fleet !== 'unavailable'
    ? (fleet.workers ?? []).filter(needsAttention)
    : [];
  const healthDown = fleet && fleet !== 'unavailable' && fleet.health && !fleet.health.ok;

  if (!challenges.length && !flagged.length && !healthDown) { el.innerHTML = ''; return; }

  const rows = [];
  if (healthDown) {
    rows.push(`<div class="fl-attn-row">
      ${icon('alert', 16)}
      <div class="what"><div><b>Coordinator not answering</b></div>
      <div class="sub">${esc(fleet.health.error)}. Configuration is shown; liveness and states are not.</div></div>
    </div>`);
  }
  for (const ch of challenges) {
    rows.push(`<div class="fl-attn-row">
      <span class="chip accent">${esc(ch.kind ?? 'challenge')}</span>
      <div class="what">
        <div><span class="mono" style="font-weight:600">${esc(ch.worker_id)}</span> is parked on a ${esc(ch.kind ?? 'challenge')}</div>
        <div class="sub">Flagged ${esc(relTime(ch.created_at) ?? '')}${ch.account_id ? ` · ${esc(ch.account_id)}` : ''} · a human has to clear it in the worker's browser</div>
      </div>
      ${watchButton(ch.vnc_url ?? vncFor(ch.worker_id), true)}
    </div>`);
  }
  for (const w of flagged) {
    if (challenges.some(c => c.worker_id === w.worker_id)) continue;
    const h = w.health;
    const why = liveness(w) === 'dead' ? `stopped reporting ${esc(relTime(h.last_heartbeat_at) ?? '')}`
      : h.state && h.state !== 'HEALTHY' ? `reports ${esc(stateLabel(h.state))}`
      : h.session_days_left != null && h.session_days_left <= 0 ? 'its session has expired'
      : h.session_days_left != null ? `its session expires in ${esc(fmtDays(h.session_days_left))}`
      : 'needs a look';
    rows.push(`<div class="fl-attn-row">
      <span class="chip warn">attention</span>
      <div class="what">
        <div><span class="mono" style="font-weight:600">${esc(w.worker_id)}</span> ${why}</div>
        <div class="sub">${esc(w.region?.name ?? '')}${h.account_id ? ` · ${esc(h.account_id)}` : ''}</div>
      </div>
      ${watchButton(vncLink(w), w.vnc_live)}
    </div>`);
  }

  el.innerHTML = `<div class="card fl-attention">
    <div class="card-head">
      <div><div class="card-title">Needs a human</div>
      <div class="card-sub">Checkpoints and accounts the control plane has flagged</div></div>
      <span class="chip warn">${rows.length}</span>
    </div>
    ${rows.join('')}
  </div>`;
}

const LIVENESS_CHIP = {
  live: ['chip pos', 'Live'],
  stale: ['chip warn', 'Stale'],
  dead: ['chip neg', 'Dead'],
  unknown: ['chip muted', 'Never reported'],
  none: ['chip muted', 'Not deployed'],
};
const STATE_CHIP = {
  HEALTHY: 'chip pos', DEGRADED: 'chip warn', SESSION_EXPIRED: 'chip warn',
  CHALLENGE_2FA: 'chip accent', CHALLENGE_EMAIL: 'chip accent',
  CHALLENGE_CAPTCHA: 'chip accent', CHECKPOINT: 'chip accent', DEAD: 'chip neg',
};
const STATE_LABEL = {
  HEALTHY: 'Healthy', DEGRADED: 'Degraded', SESSION_EXPIRED: 'Session expired',
  CHALLENGE_2FA: '2FA challenge', CHALLENGE_EMAIL: 'Email challenge',
  CHALLENGE_CAPTCHA: 'CAPTCHA', CHECKPOINT: 'Checkpoint', DEAD: 'Dead',
};
const stateLabel = (s) => STATE_LABEL[s] ?? s;

function fmtDays(days) {
  if (days == null) return '—';
  if (days <= 0) return 'expired';
  if (days < 1) return `${Math.round(days * 24)} h`;
  return `${Math.round(days)} d`;
}

function statusCell(w) {
  const lv = liveness(w);
  const [chip, label] = LIVENESS_CHIP[lv] ?? LIVENESS_CHIP.none;
  const dot = lv === 'live' ? '<span class="vl-dot"></span>' : `<span class="dot ${esc(lv)}"></span>`;
  return `<span class="fl-status">${dot}<span class="${chip}">${label}</span></span>`;
}

function renderAccounts() {
  const el = $('#accounts');
  const fleet = state.fleet;
  if (!fleet) {
    el.innerHTML = `<div class="card"><div class="card-head"><div><div class="card-title">Accounts</div><div class="card-sub"><span class="skeleton"></span></div></div></div></div>`;
    return;
  }
  if (fleet === 'unavailable') {
    el.innerHTML = `<div class="card"><div class="card-head"><div><div class="card-title">Accounts</div></div><span class="chip neg">unavailable</span></div>
      <div class="card-note">${icon('info', 16)}<span>The facade did not answer. Check that rs-console is up on the homelab and that the tunnel is connected.</span></div></div>`;
    return;
  }

  const ts = terms();
  const all = fleet.workers ?? [];
  const shown = all.filter(w =>
    (state.filter === 'all' || (state.filter === 'active' ? Boolean(w.health) : needsAttention(w)))
    && matches(workerHaystack(w), ts));

  const hits = hitsByCity();

  const rows = shown.map(w => {
    const h = w.health;
    const open = state.expanded.has(w.worker_id);
    const cityCount = (w.cities ?? []).length;
    const regionName = w.region?.name ?? '—';
    const days = h?.session_days_left;
    const sessionCell = !h ? '<span class="muted">—</span>'
      : !h.session_expiry ? '<span class="muted">unknown</span>'
      : days != null && days <= 3 ? `<span style="color:var(--neg);font-weight:550">${esc(fmtDays(days))}</span>`
      : days != null && days <= 14 ? `<span style="color:var(--warn-strong);font-weight:550">${esc(fmtDays(days))}</span>`
      : esc(fmtDays(days));

    // Hits are keyed by search city, so only a worker that has reported can
    // own them — an undeployed worker sharing a region would otherwise be
    // credited with the live monitor's alerts.
    const alerts7 = h ? (w.cities ?? []).reduce((n, c) => n + (hits.get(c.slug)?.sent ?? 0), 0) : 0;

    return `<tr class="fl-row${needsAttention(w) ? ' needs-attention' : ''}" data-id="${esc(w.worker_id)}" role="button" tabindex="0" aria-expanded="${open}">
      <td>${statusCell(w)}</td>
      <td class="mono">
        <span style="display:inline-flex;align-items:center;gap:6px">${icon('chevronRight', 12, 'caret')}${hi(esc(w.worker_id), ts)}</span>
        ${h?.error_count > 0 ? `<span class="chip neg" style="margin-left:6px">×${h.error_count}</span>` : ''}
        ${w.source === 'monitor' ? '<span class="chip info" style="margin-left:6px" title="The phase-1 single-machine monitor, searching its own city list">phase 1</span>' : ''}
        ${w.source === 'unconfigured' ? '<span class="chip warn" style="margin-left:6px" title="Reporting to the coordinator but described by no config">unconfigured</span>' : ''}
        ${accountLine(w, ts)}
      </td>
      <td>
        <div>${hi(esc(regionName), ts)}</div>
        <div class="muted" style="font-size:12px">${cityCount ? `${cityCount} cit${cityCount === 1 ? 'y' : 'ies'}` : 'no cities'}${w.region?.scope === 'subset' || w.region?.scope === 'custom' ? ' · custom list' : ''}</div>
      </td>
      <td>${h?.state ? `<span class="${STATE_CHIP[h.state] ?? 'chip muted'}">${esc(stateLabel(h.state))}</span>` : '<span class="muted">—</span>'}</td>
      <td title="${esc(h?.session_expiry ?? '')}">${sessionCell}</td>
      <td class="${h?.last_search_at ? '' : 'muted'}" title="${esc(h?.last_search_at ?? '')}">${h?.last_search_at ? esc(relTime(h.last_search_at)) : '—'}</td>
      <td class="${h?.last_heartbeat_at ? '' : 'muted'}" title="${esc(h?.last_heartbeat_at ?? '')}">${h?.last_heartbeat_at ? esc(relTime(h.last_heartbeat_at)) : 'never'}</td>
      <td class="num ${alerts7 ? '' : 'muted'}">${h ? (alerts7 || '0') : '—'}</td>
      <td>${buildCell(w, fleet)}</td>
      <td>${vncLink(w) ? watchButton(vncLink(w), w.vnc_live) : '<span class="muted" title="Not in RS_VNC_TARGETS">—</span>'}</td>
    </tr>
    ${open ? detailRow(w, hits, ts) : ''}`;
  });

  const empty = shown.length === 0
    ? `<div class="fl-empty">${ts.length ? 'No account matches that search.' : state.filter === 'attention' ? 'Every account is healthy and reporting.' : state.filter === 'active' ? 'No account has reported to the coordinator yet.' : 'No workers are configured.'}</div>`
    : '';

  const sources = fleet.sources ?? {};
  const missing = [];
  if (!sources.fleet) missing.push('fleet.toml');
  if (!sources.master) missing.push('master.toml');
  const note = missing.length
    ? `<div class="card-note">${icon('info', 16)}<span>${esc(missing.join(' and '))} ${missing.length === 1 ? 'is' : 'are'} not mounted into rs-console, so only the live monitor's own config is shown. Mount them (deploy/docker-compose.console.yml) to see the six sharded workers.</span></div>`
    : '';

  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Accounts</div>
        <div class="card-sub">${shown.length} of ${all.length} shown · click a row for its cities, session and proxy</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        ${versionChips(fleet)}
        ${fleet.health && !fleet.health.ok ? '<span class="chip neg" title="Liveness and states could not be read">health unavailable</span>' : `<span class="chip muted" title="Liveness is judged by the coordinator: 2 h silent = stale, 6 h = dead">as of ${esc(relTime(fleet.generated_at) ?? '')}</span>`}
      </div>
    </div>
    ${note}
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>Status</th><th>Account</th><th>Region</th><th>State</th>
          <th title="Days until the saved Facebook session lapses">Session</th>
          <th>Last search</th><th>Heartbeat</th>
          <th class="num" title="Alerts sent from this account's cities in the last ${HITS_DAYS} days">Alerts ${HITS_DAYS}d</th>
          <th title="The build the worker reported in its last heartbeat">Build</th>
          <th title="Open the worker's live browser">Watch</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      ${empty}
    </div>
  </div>`;
}

// Every account's identity in one flat table — the facts otherwise spread
// over each row's expandable detail. Rows with nothing to identify them (a
// worker configured but never logged in) are left out; the Accounts card
// above still lists them.
function renderAccountInfo() {
  const el = $('#account-info');
  const fleet = state.fleet;
  if (!fleet || fleet === 'unavailable') { el.innerHTML = ''; return; }

  const ts = terms();
  const all = (fleet.workers ?? []).filter(w => {
    const who = whoIs(w);
    return who.login || who.userId || who.label;
  });
  const shown = all.filter(w =>
    (state.filter === 'all' || (state.filter === 'active' ? Boolean(w.health) : needsAttention(w)))
    && matches(workerHaystack(w), ts));
  const unregistered = all.filter(w => !w.account).length;

  const none = '<span class="muted">—</span>';
  const rows = shown.map(w => {
    const who = whoIs(w);
    const acct = w.account;
    const sess = w.session;
    const h = w.health;
    const twoFa = acct?.secrets?.totp_secret
      ? '<span class="chip pos" title="A TOTP secret is stored in the vault">TOTP</span>'
      : acct ? '<span class="chip muted">none</span>' : none;
    const stored = acct
      ? Object.entries(acct.secrets ?? {}).filter(([k, on]) => on && k !== 'totp_secret').map(([k]) => k)
      : [];
    return `<tr>
      <td>
        ${who.login ? `<div>${hi(esc(who.login), ts)}</div>` : '<div class="muted" title="No vault record — register it with rsc vault set-account">not in the vault</div>'}
        ${acct?.account_id ? `<div class="muted mono" style="font-size:11.5px">${hi(esc(acct.account_id), ts)}</div>` : ''}
      </td>
      <td>${who.userId
        ? `<a class="mono" href="https://www.facebook.com/profile.php?id=${esc(who.userId)}" target="_blank" rel="noopener" title="Open this Facebook profile">${hi(esc(who.userId), ts)}</a>`
        : none}</td>
      <td class="mono" style="white-space:nowrap">${hi(esc(w.worker_id), ts)}</td>
      <td>${hi(esc(w.region?.name ?? '—'), ts)}</td>
      <td>${h?.state ? `<span class="${STATE_CHIP[h.state] ?? 'chip muted'}">${esc(stateLabel(h.state))}</span>` : none}</td>
      <td>${w.proxy_env ? `<span class="mono" style="font-size:12px">$${esc(w.proxy_env)}</span>` : '<span class="muted">own IP</span>'}</td>
      <td>${twoFa}${stored.length ? ` ${stored.map(k => `<span class="chip muted mono">${esc(k)}</span>`).join(' ')}` : ''}${acct?.allow_password_login ? ' <span class="chip warn">password login</span>' : ''}</td>
      <td style="white-space:nowrap">${sess?.user_agent ? `<span title="${esc(sess.user_agent)}">${esc(browserLabel(sess.user_agent))}</span>` : none}</td>
      <td title="${esc(sess?.backed_up_at ?? '')}">${sess?.backed_up_at ? esc(relTime(sess.backed_up_at)) : '<span class="muted">never</span>'}</td>
      <td title="${esc(h?.session_expiry ?? sess?.session_expiry ?? '')}">${h?.session_days_left != null ? esc(fmtDays(h.session_days_left)) : none}</td>
    </tr>`;
  });

  const note = unregistered
    ? `<div class="card-note">${icon('info', 16)}<span><b>${unregistered} of ${all.length}</b> account${all.length === 1 ? '' : 's'} ha${unregistered === 1 ? 's' : 've'} a live session but no vault record, so the login email and stored secrets are unknown here. Register each with <span class="mono">rsc vault set-account --account-id &lt;fb user id&gt; --worker &lt;worker&gt; --fb-username &lt;email&gt;</span>.</span></div>`
    : '';

  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Account information</div>
        <div class="card-sub">${shown.length} of ${all.length} accounts · the Facebook identity behind each worker</div>
      </div>
    </div>
    ${note}
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>Facebook login</th><th>Facebook user id</th><th>Worker</th><th>Region</th><th>State</th>
          <th title="The env var holding this worker's proxy">Proxy</th>
          <th title="Secrets stored in the coordinator vault">2FA · secrets</th>
          <th title="Browser identity the session was captured with">Browser</th>
          <th title="When the session was last backed up to the coordinator">Session backup</th>
          <th title="Days until the saved Facebook session lapses">Expires</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      ${shown.length ? '' : `<div class="fl-empty">${ts.length ? 'No account matches that search.' : 'No accounts to show.'}</div>`}
    </div>
  </div>`;
}

// A worker's build next to the coordinator's: same = quiet, different =
// flagged, so a container left on an old image stands out at a glance.
function versionChips(fleet) {
  const v = fleet?.versions ?? {};
  const chip = (label, value) => value
    ? `<span class="chip info mono" title="${label} build">${label} ${esc(value)}</span>`
    : `<span class="chip muted" title="${label} build not reported">${label} ?</span>`;
  return chip('coordinator', v.coordinator) + chip('console', v.console);
}

function buildCell(w, fleet) {
  const v = w.health?.version;
  if (!w.health) return '<span class="muted">—</span>';
  if (!v) return '<span class="chip muted" title="This worker runs an image that predates build reporting">pre-0.5.6</span>';
  const current = fleet?.versions?.coordinator;
  const same = current && v.startsWith(current);
  return `<span class="chip ${same ? 'muted' : 'warn'} mono" title="${same ? 'Same build as the coordinator' : `Coordinator runs ${esc(current ?? 'unknown')}`}">${esc(v)}</span>`;
}

function accountLine(w, ts) {
  const who = whoIs(w);
  if (!who.login && !who.userId && !who.label) {
    return '<div class="fl-account muted">no account on file</div>';
  }
  const parts = [];
  if (who.login) parts.push(`<span title="Facebook login (vault)">${hi(esc(who.login), ts)}</span>`);
  else if (who.label) parts.push(`<span title="Vault account">${hi(esc(who.label), ts)}</span>`);
  if (who.userId) parts.push(`<span class="mono" title="Facebook user id (from the backed-up session)">${hi(esc(who.userId), ts)}</span>`);
  return `<div class="fl-account">${parts.join('<span class="sep">·</span>')}</div>`;
}

function cityChip(c, hits, ts, tone) {
  const hit = hits.get(c.slug);
  const label = hi(esc(c.name), ts);
  const title = `${c.slug}${c.radius_km ? ` · ${c.radius_km} km` : ''}${hit ? ` · ${hit.sent} alert${hit.sent === 1 ? '' : 's'} in ${HITS_DAYS}d` : ''}`;
  return `<span class="chip ${tone}${hit ? ' hit' : ''}" title="${esc(title)}"><span>${label}</span>${hit?.sent ? `<span class="n">${hit.sent}</span>` : ''}</span>`;
}

function detailRow(w, hits, ts) {
  const h = w.health ?? {};
  const cities = (w.cities ?? []).filter(c => matches(`${c.name} ${c.slug}`, ts) || ts.length === 0 || matches(workerHaystack(w), ts));
  const tone = isActive(w) ? 'accent' : 'muted';
  const pacing = w.pacing ?? {};
  const pace = pacing.search_interval ? `${pacing.search_interval} – ${pacing.max_search_interval ?? pacing.search_interval}${pacing.overridden ? ' (per-worker override)' : ''}` : '—';
  const who = whoIs(w);
  const acct = w.account;
  const sess = w.session;
  const secrets = acct ? Object.entries(acct.secrets ?? {}).filter(([, on]) => on).map(([k]) => k) : [];
  const dl = [
    ['Facebook user', who.userId
      ? `<a class="mono" href="https://www.facebook.com/${esc(who.userId)}" target="_blank" rel="noopener">${esc(who.userId)}</a>`
      : '<span class="muted">unknown until the session is backed up</span>'],
    ['Facebook login', who.login ? esc(who.login) : '<span class="muted">not in the vault</span>'],
    ['Vault account', acct
      ? `${esc(acct.account_id)}${acct.allow_password_login ? ' <span class="chip warn">password login allowed</span>' : ''}`
      : '<span class="muted">none · <span class="mono">rsc vault set-account</span></span>'],
    ['Stored secrets', acct
      ? (secrets.length ? secrets.map(k => `<span class="chip muted mono">${esc(k)}</span>`).join(' ') : '<span class="muted">none</span>')
      : '<span class="muted">—</span>'],
    ['Browser', sess?.user_agent
      ? `<span title="${esc(sess.user_agent)}">${esc(browserLabel(sess.user_agent))}</span>`
      : '<span class="muted">—</span>'],
    ['Session backup', sess?.backed_up_at
      ? `${esc(relTime(sess.backed_up_at))} <span class="muted">(${esc(sess.backed_up_at)})</span>`
      : '<span class="muted">never backed up</span>'],
    ['Region key', w.region?.key ? `<span class="mono">${esc(w.region.key)}</span>` : '<span class="muted">—</span>'],
    ['Proxy', w.proxy_env ? `<span class="mono">$${esc(w.proxy_env)}</span>` : '<span class="muted">none · own IP</span>'],
    ['Session file', w.session_file ? `<span class="mono">${esc(w.session_file)}</span>` : '<span class="muted">—</span>'],
    ['Pacing', esc(pace)],
    ['Session expires', h.session_expiry ? `${esc(fmtDays(h.session_days_left))} <span class="muted">(${esc(h.session_expiry)})</span>` : '<span class="muted">—</span>'],
    ['Last listing', h.last_listing_at ? esc(relTime(h.last_listing_at)) : '<span class="muted">none via coordinator</span>'],
    ['Errors', h.error_count != null ? esc(String(h.error_count)) : '<span class="muted">—</span>'],
    ['Browser view', vncLink(w)
      ? `<a href="${esc(vncLink(w))}" target="_blank" rel="noopener">${w.vnc_live ? 'Watch live' : 'Open VNC'}</a>${w.vnc_live ? '' : ' <span class="muted">(from config)</span>'}`
      : '<span class="muted">not reachable · add this worker to RS_VNC_TARGETS in docker-compose.console.yml</span>'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  return `<tr class="fl-detail"><td colspan="10"><div class="fl-detail-inner">
    <div>
      <div class="fl-section-label">Searches ${cities.length ? `${cities.length} cit${cities.length === 1 ? 'y' : 'ies'}` : 'no cities'}${isActive(w) ? '' : ' (when running)'}</div>
      <div class="fl-cities">${cities.map(c => cityChip(c, hits, ts, tone)).join('') || '<span class="muted">No city list — the worker has no region in fleet.toml.</span>'}</div>
    </div>
    <div><div class="fl-section-label">Account</div><dl>${dl}</dl></div>
  </div></td></tr>`;
}

function renderPhrases() {
  const el = $('#phrases');
  const fleet = state.fleet;
  if (!fleet || fleet === 'unavailable') {
    el.innerHTML = `<div class="card"><div class="card-head"><div><div class="card-title">Search phrases</div><div class="card-sub">${fleet ? 'unavailable' : '<span class="skeleton"></span>'}</div></div></div></div>`;
    return;
  }
  const ts = terms();
  const items = fleet.items ?? [];
  const shown = items.filter(i => matches([
    i.name, i.description, ...(i.search_phrases ?? []), ...(i.keywords ?? []), ...(i.antikeywords ?? []),
  ].filter(Boolean).join(' '), ts));

  const blocks = shown.map(i => `<div class="fl-item${i.enabled ? '' : ' off'}">
    <div class="fl-item-head">
      <span class="name">${hi(esc(i.name), ts)}</span>
      ${i.enabled ? '<span class="chip pos">searching</span>' : '<span class="chip muted">paused</span>'}
      <span class="muted" style="font-size:12px">${(i.search_phrases ?? []).length} phrase${(i.search_phrases ?? []).length === 1 ? '' : 's'}</span>
    </div>
    ${i.description ? `<div class="fl-item-desc">${hi(esc(String(i.description).replace(/\s+/g, ' ').trim()), ts)}</div>` : ''}
    <div class="fl-cities">${(i.search_phrases ?? []).map(p => `<span class="fl-phrase">${icon('search', 12)}<span>${hi(esc(p), ts)}</span></span>`).join('')}</div>
    <div class="fl-rules">
      <span class="k" title="Title must match one of these before the listing page is opened">Title gate</span>
      <div>${(i.keywords ?? []).map(k => `<div class="fl-rule">${hi(esc(k), ts)}</div>`).join('') || '<span class="muted">none</span>'}</div>
      <span class="k" title="A match on any of these rejects the listing">Rejects</span>
      <div>${(i.antikeywords ?? []).map(k => `<div class="fl-rule">${hi(esc(k), ts)}</div>`).join('') || '<span class="muted">none</span>'}</div>
      ${i.min_price != null || i.max_price != null ? `<span class="k">Price</span><div>${esc(i.min_price ?? '0')} – ${esc(i.max_price ?? '∞')}</div>` : ''}
    </div>
  </div>`);

  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Search phrases</div>
        <div class="card-sub">What goes in the Marketplace search bar, per item, and the gates around it</div>
      </div>
      <span class="chip muted">from master.toml</span>
    </div>
    ${blocks.join('') || `<div class="fl-empty">${ts.length ? 'No item matches that search.' : 'No items are configured.'}</div>`}
  </div>`;
}

const SETTING_ROWS = [
  ['rating', 'Alert at AI rating', v => `${v} / 5`],
  ['min_unit_count', 'Minimum units per lot', v => String(v)],
  ['min_seller_rating', 'Minimum seller rating', v => `${v} / 5`],
  ['exclude_unrated_sellers', 'Unrated sellers', v => (v ? 'dropped' : 'allowed')],
  ['date_listed', 'Listing window', v => (Array.isArray(v) ? v[v.length - 1] : String(v))],
  ['delivery_method', 'Delivery', v => String(v).replace(/_/g, ' ')],
  ['max_results', 'Results read per search', v => String(v)],
  ['title_prefilter', 'Title prefilter', v => (v ? 'on' : 'off')],
  ['search_interval', 'Sweep interval', (v, s) => `${v}${s.max_search_interval ? ` – ${s.max_search_interval}` : ''}`],
];

function renderSettings() {
  const el = $('#settings');
  const fleet = state.fleet;
  if (!fleet || fleet === 'unavailable') {
    el.innerHTML = `<div class="card"><div class="card-head"><div><div class="card-title">Search settings</div></div></div></div>`;
    return;
  }
  const s = fleet.search ?? {};
  const rows = SETTING_ROWS
    .filter(([k]) => s[k] != null)
    .map(([k, label, f]) => `<div><dt>${esc(label)}</dt><dd>${esc(f(s[k], s))}</dd></div>`);
  if (fleet.ai_model) rows.push(`<div><dt>AI model</dt><dd class="mono">${esc(fleet.ai_model)}</dd></div>`);

  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Search settings</div>
        <div class="card-sub">Shared by every account; per-worker pacing shows on the row</div>
      </div>
    </div>
    <dl class="fl-settings">${rows.join('')}</dl>
    <div class="card-note">${icon('info', 16)}<span>Radius is not the coverage knob: Marketplace returns the same results at 37 and 311 miles. Coverage comes from the city list, so a metro is searched only when it appears below.</span></div>
  </div>`;
}

function renderCoverage() {
  const el = $('#coverage');
  const fleet = state.fleet;
  if (!fleet || fleet === 'unavailable') {
    el.innerHTML = `<div class="card"><div class="card-head"><div><div class="card-title">Coverage</div></div></div></div>`;
    return;
  }
  const ts = terms();
  const hits = hitsByCity();
  const workers = fleet.workers ?? [];
  const searchers = searchersByCity(workers.filter(isActive));
  const assigned = searchersByCity(workers.filter(w => w.source === 'fleet'));

  const regions = (fleet.regions ?? []).map(r => {
    const cities = r.cities.filter(c => ts.length === 0 || matches(`${c.name} ${c.slug} ${r.name} ${r.key}`, ts));
    if (ts.length && cities.length === 0) return '';
    const liveCount = r.cities.filter(c => searchers.has(c.slug)).length;
    const owners = [...new Set(r.cities.flatMap(c => (assigned.get(c.slug) ?? []).map(w => w.worker_id)))];
    const activeHere = [...new Set(r.cities.flatMap(c => (searchers.get(c.slug) ?? []).map(w => w.worker_id)))];
    const alerts = r.cities.reduce((n, c) => n + (hits.get(c.slug)?.sent ?? 0), 0);
    return `<div class="fl-region">
      <div class="fl-region-head">
        <span class="name">${hi(esc(r.name), ts)}</span>
        <span class="count">${r.cities.length} cit${r.cities.length === 1 ? 'y' : 'ies'}${liveCount ? ` · ${liveCount} searched now` : ''}${alerts ? ` · ${alerts} alert${alerts === 1 ? '' : 's'} in ${HITS_DAYS}d` : ''}</span>
        ${activeHere.map(id => `<span class="chip pos mono">${esc(id)}</span>`).join('')}
        ${owners.filter(id => !activeHere.includes(id)).map(id => `<span class="chip muted mono" title="Assigned in fleet.toml, not reporting">${esc(id)}</span>`).join('')}
      </div>
      <div class="fl-cities">${cities.map(c => cityChip(c, hits, ts, searchers.has(c.slug) ? 'accent' : 'muted')).join('')}</div>
    </div>`;
  }).filter(Boolean);

  // Cities a running worker searches that no region lists (a custom phase-1
  // list) still belong on the map.
  const regionSlugs = new Set((fleet.regions ?? []).flatMap(r => r.cities.map(c => c.slug)));
  const extra = [];
  const seen = new Set();
  for (const w of workers) for (const c of w.cities ?? []) {
    if (!regionSlugs.has(c.slug) && !seen.has(c.slug)) { seen.add(c.slug); extra.push(c); }
  }
  if (extra.length) {
    const cities = extra.filter(c => ts.length === 0 || matches(`${c.name} ${c.slug}`, ts));
    if (cities.length) regions.push(`<div class="fl-region">
      <div class="fl-region-head"><span class="name">Outside every region</span><span class="count">${extra.length} cit${extra.length === 1 ? 'y' : 'ies'} from a worker's own list</span></div>
      <div class="fl-cities">${cities.map(c => cityChip(c, hits, ts, searchers.has(c.slug) ? 'accent' : 'muted')).join('')}</div>
    </div>`);
  }

  el.innerHTML = `<div class="card">
    <div class="card-head">
      <div>
        <div class="card-title">Coverage</div>
        <div class="card-sub">Every search centre, by region. A metro is invisible until it has its own entry here.</div>
      </div>
      <div class="fl-legend">
        <span class="chip accent">searched now</span>
        <span class="chip muted">configured, idle</span>
        <span class="chip accent">city<span class="n">3</span></span><span>= alerts in ${HITS_DAYS}d</span>
      </div>
    </div>
    ${regions.join('') || `<div class="fl-empty">${ts.length ? 'No city matches that search.' : 'No regions are configured — master.toml is not mounted.'}</div>`}
  </div>`;
}

// ── Token modal ────────────────────────────────────────────────────────────────

function openTokenModal(error) {
  const modal = $('#token-modal');
  const err = $('#token-error');
  modal.hidden = false;
  if (error) { err.textContent = error; err.hidden = false; } else { err.hidden = true; }
  $('#token-input').focus();
}

$('#token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('#token-input').value.trim();
  if (!value) return;
  localStorage.setItem(TOKEN_KEY, value);
  $('#token-input').value = '';
  $('#token-modal').hidden = true;
  load().catch(showLoadError);
});

$('#change-token').addEventListener('click', () => openTokenModal());

// ── Wiring ─────────────────────────────────────────────────────────────────────

function showLoadError(err) {
  $('#updated').textContent = `Refresh failed: ${err.message}`;
}

$('#refresh').addEventListener('click', () => {
  $('#updated').textContent = 'Refreshing…';
  load().catch(showLoadError);
});

$('#q').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

for (const btn of document.querySelectorAll('.seg [data-filter]')) {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    for (const b of document.querySelectorAll('.seg [data-filter]')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    render();
  });
}

// Row expansion is delegated: rows re-render on every refresh.
$('#accounts').addEventListener('click', (e) => {
  if (e.target.closest('a, button')) return;
  const row = e.target.closest('.fl-row');
  if (row) toggleRow(row.dataset.id);
});
$('#accounts').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.fl-row');
  if (!row) return;
  e.preventDefault();
  toggleRow(row.dataset.id);
});
function toggleRow(id) {
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  renderAccounts();
  const row = document.querySelector(`.fl-row[data-id="${CSS.escape(id)}"]`);
  row?.focus();
}

setInterval(() => { load().catch(showLoadError); }, REFRESH_MS);
setInterval(renderUpdated, 10_000);

render();
load().catch(showLoadError);
