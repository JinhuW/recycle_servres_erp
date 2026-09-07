import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import type {
  AlertHitRow, Challenge, FleetAccount, FleetCity, FleetDoc, FleetFilter, WorkerState,
} from '../../lib/coordinator';
import {
  accountAlerts, accountHaystack, browserLabel, hitsByCity, isActive, liveness, matchesTerms,
  needsAttention, queryTerms, searchersByCity, splitHighlights, whoIs, type AccountLiveness,
  type CityHits,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';

// ─── Fleet accounts ───────────────────────────────────────────────────────────
// The cards that answer "which account is searching which cities for which
// phrases, and is it alive?": a KPI row, the accounts table (one row per
// Facebook account, expandable to its city list and identity), the search
// phrases per item, the shared search settings, and the coverage map. All of
// them read one FleetDoc from the facade; the search box on the page head
// filters accounts, cities and phrases at once, with matches highlighted.

export const HITS_DAYS = 7;

type T = (k: string, vars?: Record<string, string | number>) => string;

// A run of text with the search terms wrapped in <mark>.
function Hi({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {splitHighlights(text, terms).map((run, i) =>
        run.hit ? <mark key={i}>{run.text}</mark> : <span key={i}>{run.text}</span>)}
    </>
  );
}

const LIVENESS_CHIP: Record<AccountLiveness, { chip: string; key: string }> = {
  live: { chip: 'chip pos', key: 'fbcLive' },
  stale: { chip: 'chip warn', key: 'fbcStale' },
  dead: { chip: 'chip neg', key: 'fbcDead' },
  unknown: { chip: 'chip muted', key: 'fbcNeverReported' },
  none: { chip: 'chip muted', key: 'fbcNotDeployed' },
};

const STATE_CHIP: Record<WorkerState, string> = {
  HEALTHY: 'chip pos',
  DEGRADED: 'chip warn',
  SESSION_EXPIRED: 'chip warn',
  CHALLENGE_2FA: 'chip accent',
  CHALLENGE_EMAIL: 'chip accent',
  CHALLENGE_CAPTCHA: 'chip accent',
  CHECKPOINT: 'chip accent',
  DEAD: 'chip neg',
};

// The control plane can add states faster than this UI ships, so an unknown
// one falls back to its raw name rather than a blank cell.
function stateLabel(t: T, state: WorkerState): string {
  const key = `fbcState_${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function fmtDays(t: T, days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return t('fbcSessionExpired');
  if (days < 1) return t('fbcHoursLeft', { n: Math.round(days * 24) });
  return t('fbcSessionDays', { n: Math.round(days) });
}

function StatusCell({ account }: { account: FleetAccount }) {
  const { t } = useT();
  const lv = liveness(account);
  const chip = LIVENESS_CHIP[lv];
  return (
    <span className="fl-status">
      {lv === 'live'
        ? <span className="vl-dot" />
        : <span className={`dot ${lv}`} />}
      <span className={chip.chip}>{t(chip.key)}</span>
    </span>
  );
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export function FleetKpis({ fleet, challenges, locale }: {
  fleet: FleetDoc | null;
  challenges: Challenge[] | null;
  locale: string;
}) {
  const { t } = useT();
  const fmt = new Intl.NumberFormat(locale);
  const workers = fleet?.workers ?? [];
  const configured = workers.filter(w => w.source !== 'unconfigured');
  const live = workers.filter(w => liveness(w) === 'live');
  const reporting = workers.filter(w => w.health);
  const attention = workers.filter(needsAttention);

  const searchedNow = new Set(workers.filter(isActive).flatMap(w => w.cities.map(c => c.slug)));
  const allCities = new Set((fleet?.regions ?? []).flatMap(r => r.cities.map(c => c.slug)));
  for (const w of workers) for (const c of w.cities) allCities.add(c.slug);

  const items = fleet?.items ?? [];
  const enabled = items.filter(i => i.enabled);
  const phrases = enabled.reduce((n, i) => n + i.search_phrases.length, 0);
  const open = challenges?.length ?? null;

  const value = (n: number) => (fleet ? fmt.format(n) : '…');

  return (
    <div className="kpi-grid" style={{ marginBottom: 16 }}>
      <div className="kpi">
        <div className="kpi-label">{t('fbcKpiAccountsLive')}</div>
        <div className="kpi-value mono">
          {value(live.length)}
          {fleet && <small className="fl-of">/ {configured.length}</small>}
        </div>
        <div className={`kpi-trend ${attention.length ? 'down' : ''}`}>
          {attention.length
            ? <><Icon name="alert" size={12} /> {t('fbcKpiAttention', { n: attention.length })}</>
            : t('fbcKpiAccountsSub', { reporting: reporting.length, configured: configured.length })}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">{t('fbcKpiCities')}</div>
        <div className="kpi-value mono">
          {value(searchedNow.size)}
          {fleet && <small className="fl-of">/ {allCities.size}</small>}
        </div>
        <div className="kpi-trend">
          {t('fbcKpiCitiesSub', { n: allCities.size, regions: fleet?.regions.length ?? 0 })}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi-label">{t('fbcKpiPhrases')}</div>
        <div className="kpi-value mono">{value(phrases)}</div>
        <div className="kpi-trend">{t('fbcKpiPhrasesSub', { on: enabled.length, n: items.length })}</div>
      </div>
      <div className="kpi">
        <div className="kpi-label">{t('fbcKpiCheckpoints')}</div>
        <div className="kpi-value mono">{open === null ? '…' : fmt.format(open)}</div>
        <div className={`kpi-trend ${open ? 'down' : ''}`}>
          {open ? t('fbcKpiCheckpointsSub') : t('fbcKpiCheckpointsNone')}
        </div>
      </div>
    </div>
  );
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function CityChip({ city, hits, terms, tone }: {
  city: FleetCity; hits: Map<string, CityHits>; terms: readonly string[]; tone: 'accent' | 'muted';
}) {
  const { t } = useT();
  const hit = hits.get(city.slug);
  const title = [
    city.slug,
    city.radius_km ? `${city.radius_km} km` : null,
    hit ? t('fbcCityHint', { sent: hit.sent, days: HITS_DAYS }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`chip ${tone}`} title={title}>
      <span><Hi text={city.name} terms={terms} /></span>
      {hit && hit.sent > 0 && <span className="n">{hit.sent}</span>}
    </span>
  );
}

export function AccountsCard({ fleet, unavailable, hits, query, filter, expanded, onToggle, locale }: {
  fleet: FleetDoc | null;
  // The facade answered with something other than a fleet document (an older
  // facade, or the tunnel is down): say so in the card, keep the page.
  unavailable?: boolean;
  hits: AlertHitRow[] | null;
  query: string;
  filter: FleetFilter;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  locale: string;
}) {
  const { t } = useT();
  const terms = queryTerms(query);
  const byCity = hitsByCity(hits ?? []);
  const all = fleet?.workers ?? [];
  const shown = all.filter(w =>
    (filter === 'all' || (filter === 'active' ? Boolean(w.health) : needsAttention(w)))
    && matchesTerms(accountHaystack(w), terms));

  const missing = fleet
    ? [!fleet.sources.fleet && 'fleet.toml', !fleet.sources.master && 'master.toml'].filter(Boolean) as string[]
    : [];

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcAccTitle')}</div>
          <div className="card-sub">
            {fleet ? t('fbcAccSub', { shown: shown.length, n: all.length }) : '…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {fleet && (['coordinator', 'console'] as const).map(svc => (
            fleet.versions[svc]
              ? <span key={svc} className="chip info mono" title={t('fbcBuildOf', { svc })}>{svc} {fleet.versions[svc]}</span>
              : <span key={svc} className="chip muted" title={t('fbcBuildUnknown', { svc })}>{svc} ?</span>
          ))}
          {fleet && (fleet.health.ok
            ? <span className="chip muted" title={t('fbcLivenessHint')}>{t('fbcAccAsOf', { age: relTime(fleet.generated_at, locale) })}</span>
            : <span className="chip neg">{t('fbcAccHealthDown')}</span>)}
          {!fleet && unavailable && <span className="chip neg">{t('fbcFleetUnavailable')}</span>}
        </div>
      </div>

      {!fleet && unavailable && (
        <div className="card-note">
          <Icon name="info" size={16} />
          <span>{t('fbcFleetUnavailableNote')}</span>
        </div>
      )}

      {fleet && !fleet.health.ok && (
        <div className="card-note">
          <Icon name="alert" size={16} />
          <span>{t('fbcAccHealthDownNote', { error: fleet.health.error ?? '' })}</span>
        </div>
      )}
      {missing.length > 0 && (
        <div className="card-note">
          <Icon name="info" size={16} />
          <span>{t('fbcAccConfigMissing', { files: missing.join(' + ') })}</span>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('fbcColStatus')}</th>
              <th>{t('fbcColAccount')}</th>
              <th>{t('fbcColRegion')}</th>
              <th>{t('fbcColState')}</th>
              <th>{t('fbcColSession')}</th>
              <th>{t('fbcColLastSearch')}</th>
              <th>{t('fbcColHeartbeat')}</th>
              <th className="num" title={t('fbcColAlertsHint', { days: HITS_DAYS })}>
                {t('fbcColAlerts', { days: HITS_DAYS })}
              </th>
              <th title={t('fbcColBuildHint')}>{t('fbcColBuild')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(w => (
              <AccountRow key={w.worker_id} account={w} hits={byCity} terms={terms}
                coordinatorVersion={fleet?.versions.coordinator ?? null}
                open={expanded.has(w.worker_id)} onToggle={() => onToggle(w.worker_id)} locale={locale} />
            ))}
          </tbody>
        </table>
        {fleet && shown.length === 0 && (
          <div className="fl-empty">
            {terms.length ? t('fbcAccEmptySearch')
              : filter === 'attention' ? t('fbcFleetAllWell')
              : filter === 'active' ? t('fbcAccEmptyReporting')
              : t('fbcAccEmptyAll')}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountRow({ account: w, hits, terms, coordinatorVersion, open, onToggle, locale }: {
  account: FleetAccount;
  hits: Map<string, CityHits>;
  terms: readonly string[];
  coordinatorVersion: string | null;
  open: boolean;
  onToggle: () => void;
  locale: string;
}) {
  const { t } = useT();
  const h = w.health;
  const days = h?.session_days_left ?? null;
  const alerts = accountAlerts(w, hits);
  const customList = w.region.scope === 'subset' || w.region.scope === 'custom';

  const sessionCell = !h ? <span className="muted">—</span>
    : !h.session_expiry ? <span className="muted">{t('fbcSessionUnknown')}</span>
    : days !== null && days <= 3 ? <span style={{ color: 'var(--neg)', fontWeight: 550 }}>{fmtDays(t, days)}</span>
    : days !== null && days <= 14 ? <span style={{ color: 'var(--warn-strong)', fontWeight: 550 }}>{fmtDays(t, days)}</span>
    : <>{fmtDays(t, days)}</>;

  return (
    <>
      <tr
        className={`fl-row${needsAttention(w) ? ' needs-attention' : ''}`}
        role="button" tabIndex={0} aria-expanded={open}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <td><StatusCell account={w} /></td>
        <td className="mono">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="chevronRight" size={12} className="caret" />
            <Hi text={w.worker_id} terms={terms} />
          </span>
          {h && h.error_count > 0 && <span className="chip neg" style={{ marginLeft: 6 }}>×{h.error_count}</span>}
          {w.source === 'monitor' && <span className="chip info" style={{ marginLeft: 6 }} title={t('fbcPhase1Hint')}>{t('fbcPhase1')}</span>}
          {w.source === 'unconfigured' && <span className="chip warn" style={{ marginLeft: 6 }} title={t('fbcUnconfiguredHint')}>{t('fbcUnconfigured')}</span>}
          <AccountLine account={w} terms={terms} />
        </td>
        <td>
          <div><Hi text={w.region.name} terms={terms} /></div>
          <div className="muted" style={{ fontSize: 12 }}>
            {w.cities.length ? t('fbcCities', { n: w.cities.length }) : t('fbcNoCities')}
            {customList && ` · ${t('fbcCustomList')}`}
          </div>
        </td>
        <td>
          {h?.state
            ? <span className={STATE_CHIP[h.state] ?? 'chip muted'}>{stateLabel(t, h.state)}</span>
            : <span className="muted">—</span>}
        </td>
        <td title={h?.session_expiry ?? undefined}>{sessionCell}</td>
        <td className={h?.last_search_at ? undefined : 'muted'} title={h?.last_search_at ?? undefined}>
          {h?.last_search_at ? relTime(h.last_search_at, locale) : '—'}
        </td>
        <td className={h?.last_heartbeat_at ? undefined : 'muted'} title={h?.last_heartbeat_at ?? undefined}>
          {h?.last_heartbeat_at ? relTime(h.last_heartbeat_at, locale) : t('fbcNever')}
        </td>
        <td className={`num ${alerts ? '' : 'muted'}`}>{h ? alerts : '—'}</td>
        <td><BuildChip health={h} coordinatorVersion={coordinatorVersion} /></td>
      </tr>
      {open && <AccountDetail account={w} hits={hits} terms={terms} locale={locale} />}
    </>
  );
}

// A worker's build next to the coordinator's: the same build is quiet, a
// different one is flagged, so a container left on an old image stands out.
function BuildChip({ health, coordinatorVersion }: {
  health: FleetAccount['health']; coordinatorVersion: string | null;
}) {
  const { t } = useT();
  if (!health) return <span className="muted">—</span>;
  const v = health.version;
  if (!v) return <span className="chip muted" title={t('fbcBuildPreHint')}>{t('fbcBuildPre')}</span>;
  const same = Boolean(coordinatorVersion && v.startsWith(coordinatorVersion));
  return (
    <span className={`chip ${same ? 'muted' : 'warn'} mono`}
      title={same ? t('fbcBuildSame') : t('fbcBuildDiffers', { v: coordinatorVersion ?? '?' })}>
      {v}
    </span>
  );
}

// Who the worker logs in as: the vault's login (or its label) and the
// session's Facebook user id, under the worker id.
function AccountLine({ account: w, terms }: { account: FleetAccount; terms: readonly string[] }) {
  const { t } = useT();
  const who = whoIs(w);
  if (!who.login && !who.label && !who.userId) {
    return <div className="fl-account muted">{t('fbcNoAccountOnFile')}</div>;
  }
  return (
    <div className="fl-account">
      {who.login
        ? <span title={t('fbcFbLoginHint')}><Hi text={who.login} terms={terms} /></span>
        : who.label && <span title={t('fbcVaultAccountHint')}><Hi text={who.label} terms={terms} /></span>}
      {who.userId && (who.login || who.label) && <span className="sep">·</span>}
      {who.userId && <span className="mono" title={t('fbcFbUserHint')}><Hi text={who.userId} terms={terms} /></span>}
    </div>
  );
}

function AccountDetail({ account: w, hits, terms, locale }: {
  account: FleetAccount; hits: Map<string, CityHits>; terms: readonly string[]; locale: string;
}) {
  const { t } = useT();
  const h = w.health;
  // With a query, the row matched on something — narrow the chips to the
  // cities that matched, unless the match was elsewhere (id, region…).
  const cityMatches = w.cities.filter(c => matchesTerms(`${c.name} ${c.slug}`, terms));
  const cities = terms.length && cityMatches.length ? cityMatches : w.cities;
  const tone = isActive(w) ? 'accent' : 'muted';
  const pace = w.pacing.search_interval
    ? `${w.pacing.search_interval} – ${w.pacing.max_search_interval ?? w.pacing.search_interval}${w.pacing.overridden ? ` ${t('fbcPacingOverride')}` : ''}`
    : '—';
  const vnc = h?.vnc_url ?? w.vnc_url ?? w.account?.vnc_url ?? null;
  const muted = (text: string) => <span className="muted">{text}</span>;
  const who = whoIs(w);
  const acct = w.account;
  const sess = w.session;
  const stored = acct ? Object.entries(acct.secrets).filter(([, on]) => on).map(([k]) => k) : [];
  const browser = browserLabel(sess?.user_agent);

  const rows: Array<[string, ReactNode]> = [
    [t('fbcDetailFbUser'), who.userId
      ? <a className="mono" href={`https://www.facebook.com/${encodeURIComponent(who.userId)}`} target="_blank" rel="noopener">{who.userId}</a>
      : muted(t('fbcFbUserUnknown'))],
    [t('fbcDetailFbLogin'), who.login ? who.login : muted(t('fbcNotInVault'))],
    [t('fbcDetailVaultAccount'), acct
      ? <>{acct.account_id}{acct.allow_password_login && <> <span className="chip warn">{t('fbcPasswordLoginOn')}</span></>}</>
      : muted(t('fbcNoVaultAccount'))],
    [t('fbcDetailSecrets'), acct
      ? (stored.length
        ? <span className="fl-cities">{stored.map(k => <span key={k} className="chip muted mono">{k}</span>)}</span>
        : muted(t('fbcNone')))
      : muted('—')],
    [t('fbcDetailUa'), browser ? <span title={sess?.user_agent ?? undefined}>{browser}</span> : muted('—')],
    [t('fbcDetailBackup'), sess?.backed_up_at
      ? <>{relTime(sess.backed_up_at, locale)} {muted(`(${sess.backed_up_at})`)}</>
      : muted(t('fbcNeverBackedUp'))],
    [t('fbcDetailRegionKey'), w.region.key ? <span className="mono">{w.region.key}</span> : muted('—')],
    [t('fbcDetailProxy'), w.proxy_env ? <span className="mono">${w.proxy_env}</span> : muted(t('fbcOwnIp'))],
    [t('fbcDetailSessionFile'), w.session_file ? <span className="mono">{w.session_file}</span> : muted('—')],
    [t('fbcDetailPacing'), pace],
    [t('fbcDetailExpires'), h?.session_expiry
      ? <>{fmtDays(t, h.session_days_left)} {muted(`(${h.session_expiry})`)}</>
      : muted('—')],
    [t('fbcDetailLastListing'), h?.last_listing_at ? relTime(h.last_listing_at, locale) : muted(t('fbcNoListing'))],
    [t('fbcDetailErrors'), h ? String(h.error_count) : muted('—')],
    [t('fbcDetailVnc'), vnc
      ? <a href={vnc} target="_blank" rel="noopener">{t('fbcOpenVnc')}</a>
      : muted(t('fbcNoVnc'))],
  ];

  return (
    <tr className="fl-detail">
      <td colSpan={9}>
        <div className="fl-detail-inner">
          <div>
            <div className="fl-section-label">
              {cities.length ? t('fbcDetailSearches', { n: cities.length }) : t('fbcNoCities')}
              {!isActive(w) && ` ${t('fbcDetailWhenRunning')}`}
            </div>
            <div className="fl-cities">
              {cities.length
                ? cities.map(c => <CityChip key={c.slug} city={c} hits={hits} terms={terms} tone={tone} />)
                : <span className="muted">{t('fbcDetailNoCities')}</span>}
            </div>
          </div>
          <div>
            <div className="fl-section-label">{t('fbcDetailAccountSection')}</div>
            <dl>
              {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── Search phrases ───────────────────────────────────────────────────────────

export function PhrasesCard({ fleet, query }: { fleet: FleetDoc | null; query: string }) {
  const { t } = useT();
  const terms = queryTerms(query);
  const items = fleet?.items ?? [];
  const shown = items.filter(i => matchesTerms(
    [i.name, i.description, ...i.search_phrases, ...i.keywords, ...i.antikeywords].filter(Boolean).join(' '),
    terms,
  ));

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcPhrasesTitle')}</div>
          <div className="card-sub">{t('fbcPhrasesSub')}</div>
        </div>
        <span className="chip muted">{t('fbcFromMaster')}</span>
      </div>
      {shown.map(i => (
        <div key={i.name} className={`fl-item${i.enabled ? '' : ' off'}`}>
          <div className="fl-item-head">
            <span className="name"><Hi text={i.name} terms={terms} /></span>
            {i.enabled
              ? <span className="chip pos">{t('fbcItemSearching')}</span>
              : <span className="chip muted">{t('fbcItemPaused')}</span>}
            <span className="muted" style={{ fontSize: 12 }}>{t('fbcPhraseCount', { n: i.search_phrases.length })}</span>
          </div>
          {i.description && (
            <div className="fl-item-desc"><Hi text={i.description.replace(/\s+/g, ' ').trim()} terms={terms} /></div>
          )}
          <div className="fl-cities">
            {i.search_phrases.map(p => (
              <span key={p} className="fl-phrase">
                <Icon name="search" size={12} />
                <span><Hi text={p} terms={terms} /></span>
              </span>
            ))}
          </div>
          <div className="fl-rules">
            <span className="k" title={t('fbcTitleGateHint')}>{t('fbcTitleGate')}</span>
            <div>
              {i.keywords.length
                ? i.keywords.map(k => <div key={k} className="fl-rule"><Hi text={k} terms={terms} /></div>)
                : <span className="muted">{t('fbcNone')}</span>}
            </div>
            <span className="k" title={t('fbcRejectsHint')}>{t('fbcRejects')}</span>
            <div>
              {i.antikeywords.length
                ? i.antikeywords.map(k => <div key={k} className="fl-rule"><Hi text={k} terms={terms} /></div>)
                : <span className="muted">{t('fbcNone')}</span>}
            </div>
            {(i.min_price != null || i.max_price != null) && (
              <>
                <span className="k">{t('fbcPrice')}</span>
                <div>{i.min_price ?? 0} – {i.max_price ?? '∞'}</div>
              </>
            )}
          </div>
        </div>
      ))}
      {fleet && shown.length === 0 && (
        <div className="fl-empty">{terms.length ? t('fbcPhrasesEmptySearch') : t('fbcPhrasesEmpty')}</div>
      )}
    </div>
  );
}

// ─── Search settings ──────────────────────────────────────────────────────────

export function SettingsCard({ fleet }: { fleet: FleetDoc | null }) {
  const { t } = useT();
  const s = fleet?.search ?? {};
  const rows: Array<[string, string]> = [];
  if (s.rating != null) rows.push([t('fbcSetRating'), `${s.rating} / 5`]);
  if (s.min_unit_count != null) rows.push([t('fbcSetMinUnits'), String(s.min_unit_count)]);
  if (s.min_seller_rating != null) rows.push([t('fbcSetSellerRating'), `${s.min_seller_rating} / 5`]);
  if (s.exclude_unrated_sellers != null) rows.push([t('fbcSetUnrated'), s.exclude_unrated_sellers ? t('fbcSetDropped') : t('fbcSetAllowed')]);
  if (s.date_listed != null) rows.push([t('fbcSetWindow'), Array.isArray(s.date_listed) ? s.date_listed[s.date_listed.length - 1] : s.date_listed]);
  if (s.delivery_method) rows.push([t('fbcSetDelivery'), s.delivery_method.replace(/_/g, ' ')]);
  if (s.max_results != null) rows.push([t('fbcSetMaxResults'), String(s.max_results)]);
  if (s.title_prefilter != null) rows.push([t('fbcSetPrefilter'), s.title_prefilter ? t('fbcOn') : t('fbcOff')]);
  if (s.search_interval) rows.push([t('fbcSetInterval'), `${s.search_interval}${s.max_search_interval ? ` – ${s.max_search_interval}` : ''}`]);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcSettingsTitle')}</div>
          <div className="card-sub">{t('fbcSettingsSub')}</div>
        </div>
      </div>
      <dl className="fl-settings">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        {fleet?.ai_model && <div><dt>{t('fbcSetModel')}</dt><dd className="mono">{fleet.ai_model}</dd></div>}
      </dl>
      <div className="card-note">
        <Icon name="info" size={16} />
        <span>{t('fbcSettingsNote')}</span>
      </div>
    </div>
  );
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

export function CoverageCard({ fleet, hits, query }: {
  fleet: FleetDoc | null; hits: AlertHitRow[] | null; query: string;
}) {
  const { t } = useT();
  const terms = queryTerms(query);
  const byCity = hitsByCity(hits ?? []);
  const workers = fleet?.workers ?? [];
  const searchers = searchersByCity(workers.filter(isActive));
  const assigned = searchersByCity(workers.filter(w => w.source === 'fleet'));

  const regions = (fleet?.regions ?? []).map(r => {
    const cities = r.cities.filter(c => matchesTerms(`${c.name} ${c.slug} ${r.name} ${r.key}`, terms));
    if (terms.length && cities.length === 0) return null;
    const liveCount = r.cities.filter(c => searchers.has(c.slug)).length;
    const activeHere = [...new Set(r.cities.flatMap(c => (searchers.get(c.slug) ?? []).map(w => w.worker_id)))];
    const owners = [...new Set(r.cities.flatMap(c => (assigned.get(c.slug) ?? []).map(w => w.worker_id)))]
      .filter(id => !activeHere.includes(id));
    const alerts = r.cities.reduce((n, c) => n + (byCity.get(c.slug)?.sent ?? 0), 0);
    return (
      <div key={r.key} className="fl-region">
        <div className="fl-region-head">
          <span className="name"><Hi text={r.name} terms={terms} /></span>
          <span className="count">
            {t('fbcCities', { n: r.cities.length })}
            {liveCount > 0 && ` · ${t('fbcRegionSearched', { n: liveCount })}`}
            {alerts > 0 && ` · ${t('fbcRegionAlerts', { n: alerts, days: HITS_DAYS })}`}
          </span>
          {activeHere.map(id => <span key={id} className="chip pos mono">{id}</span>)}
          {owners.map(id => <span key={id} className="chip muted mono" title={t('fbcAssignedIdle')}>{id}</span>)}
        </div>
        <div className="fl-cities">
          {cities.map(c => (
            <CityChip key={c.slug} city={c} hits={byCity} terms={terms}
              tone={searchers.has(c.slug) ? 'accent' : 'muted'} />
          ))}
        </div>
      </div>
    );
  }).filter(Boolean);

  // Cities a running worker searches that no region lists (a custom phase-1
  // list) still belong on the map.
  const regionSlugs = new Set((fleet?.regions ?? []).flatMap(r => r.cities.map(c => c.slug)));
  const extra: FleetCity[] = [];
  const seen = new Set<string>();
  for (const w of workers) for (const c of w.cities) {
    if (!regionSlugs.has(c.slug) && !seen.has(c.slug)) { seen.add(c.slug); extra.push(c); }
  }
  const extraShown = extra.filter(c => matchesTerms(`${c.name} ${c.slug}`, terms));

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcCoverageTitle')}</div>
          <div className="card-sub">{t('fbcCoverageSub')}</div>
        </div>
        <div className="fl-legend">
          <span className="chip accent">{t('fbcLegendNow')}</span>
          <span className="chip muted">{t('fbcLegendIdle')}</span>
          <span className="chip accent">{t('fbcLegendCity')}<span className="n">3</span></span>
          <span>{t('fbcLegendAlerts', { days: HITS_DAYS })}</span>
        </div>
      </div>
      {regions}
      {extraShown.length > 0 && (
        <div className="fl-region">
          <div className="fl-region-head">
            <span className="name">{t('fbcOutsideRegions')}</span>
            <span className="count">{t('fbcOutsideSub', { n: extra.length })}</span>
          </div>
          <div className="fl-cities">
            {extraShown.map(c => (
              <CityChip key={c.slug} city={c} hits={byCity} terms={terms}
                tone={searchers.has(c.slug) ? 'accent' : 'muted'} />
            ))}
          </div>
        </div>
      )}
      {fleet && regions.length === 0 && extraShown.length === 0 && (
        <div className="fl-empty">{terms.length ? t('fbcCoverageEmptySearch') : t('fbcCoverageEmpty')}</div>
      )}
    </div>
  );
}
