import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { ApiError } from '../../lib/api';
import {
  challengeScreenshotUrl,
  coordinatorApi,
  type Challenge,
  type FilterPrompt,
  type FleetFilter,
  type FleetWorker,
  type ReviewStatsDay,
  type WorkerLiveness,
  type WorkerState,
} from '../../lib/coordinator';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';

// ─── Facebook tracker console ─────────────────────────────────────────────────
// The dedicated Facebook Marketplace monitor page: review volume, the worker
// fleet, the checkpoint queue (workers parked on a CAPTCHA or login challenge
// until a human clears them), the content-filter prompt, and a placeholder for
// per-ad click stats. Fleet + queue go through the /api/coordinator proxy; a
// 501 from it means the backend has no control-plane credentials, which gets
// its own quiet state instead of error toasts. The review-volume and prompt
// cards are UI-only for now — they render bundled sample data (marked as such)
// until the coordinator grows stats/prompt endpoints.

const REFRESH_MS = 30_000;

const STATS_DAYS = 14;

// ── Sample fallback data ───────────────────────────────────────────────────────
// Shown (badged as sample) when the stats endpoint is unreachable, so the page
// keeps its shape whatever the homelab is doing. Fourteen daily totals,
// oldest first; today is the last entry.
const SAMPLE_REVIEWED_PER_DAY = [212, 187, 243, 198, 231, 176, 204, 259, 221, 194, 248, 233, 207, 96];
const SAMPLE_ALERTS_7D = 14;

// Data either arrives or the card quietly falls back to samples — never an
// error dialog: this page must stay a non-blocker for the rest of the ERP.
type Unavailable = 'unavailable';

// Fallback snapshot of the monitor's AI evaluation prompt
// (facebook_tracker/configs/master.toml). Shown, badged as sample, only when
// the facade's live filter-prompt endpoint is unreachable; the live copy is
// read from the monitor's actual mounted config.
const FILTER_PROMPT = `You are a purchasing agent for Recycle Servers LLC, a used-server hardware reseller in Denver, CO.

Decide whether this Facebook Marketplace listing is a FOR-SALE listing of ONE of the component types we are buying, offered as a BULK LOT:

- RAM: DDR4 or DDR5 memory modules ONLY — server ECC RDIMM/LRDIMM, desktop
  DIMMs, and laptop SODIMMs are ALL wanted in all three form factors, EXCEPT
  consumer gaming-brand kits (see the reject rules). We do
  NOT buy DDR3, DDR2 or older generations any more. Module label prefixes
  identify the generation when the seller doesn't say: PC4-xxxxx is DDR4,
  PC5-xxxxx is DDR5 (wanted); PC3/PC3L is DDR3 and PC2 is DDR2 (rejected).
- SSD: enterprise/datacenter solid-state drives (SATA, SAS, or NVMe/U.2).

The listing must include AT LEAST 5 units of that component (5+ DDR4/DDR5 RAM modules or 5+ SSDs).

We are NOT buying CPUs at the moment. Reject Xeon and EPYC processors even though they are server parts.

You are judging TEXT ONLY — the title and the description. The photos are not
attached, so never assume what they show. Read the whole description before
deciding the quantity: sellers often bury the count in a sentence rather than
the title ("clearing out a box of 24", "$8 each, 40 available", "12 sticks
total", "3 trays of 8"). Work the count out from whatever the text gives —
an explicit number, a per-unit price with an available count, or a lot
described as N x M — and only treat the quantity as unstated when the text
really gives nothing to count.

When the text makes you CONFIDENT the seller is offering exactly ONE unit,
reject the listing. Singular phrasing all the way through is the signal:
"selling my 32GB stick", "1x 960GB SSD", "this drive", "the module", one
price for one item, a title naming a single part number with no count. This
rule outranks everything else about the listing — a lone module or drive is
rejected however large its capacity, however low its price, however rare the
part. We are buying lots; one unit is not a lot, and it is not worth the
drive. Only genuine doubt about the count sends you to the quantity-unclear
rule instead — do not manufacture doubt to rescue an attractive single item.

Reject the listing when ANY of these is true:
- It is not RAM or an SSD as defined above. Reject whole servers, CPUs, motherboards, GPUs, hard disk drives (HDD), networking gear (NICs, switches), and other parts.
- The memory is DDR3, DDR2 or older ONLY. A mixed-generation lot qualifies on its DDR4/DDR5 modules alone: count only those toward the 5-unit minimum and reject if fewer than 5 remain.
- The seller is clearly offering ONE unit (see the single-unit rule above).
- It has fewer than 5 units of the component, or the text gives nothing to work a quantity out from.
- The memory is a consumer gaming-brand kit: Corsair (Vengeance, Dominator),
  G.Skill (Trident, Ripjaws, Aegis), Kingston Fury / HyperX, TeamGroup
  T-Force, Crucial Ballistix, ADATA XPG, or any RGB-branded kit. These
  consumer-facing lines are not bought. Plain/OEM desktop and laptop modules
  (Samsung, SK Hynix, Micron, plain Crucial or Kingston ValueRAM) still
  qualify — the brand line, not the form factor, is what rejects.
- The SSDs are low-capacity consumer drives with no resale value to us. This
  exclusion does NOT apply to RAM: plain desktop and laptop memory are
  wanted, so never reject a memory lot merely for being non-ECC or SODIMM —
  only the gaming-brand kits listed above are rejected.
- The seller is looking to buy or trade, or it is a discussion rather than a real for-sale listing.
- The listing is already marked sold or pending.
- It is an eBay (or other online marketplace) reseller cross-posting their storefront inventory rather than a local seller with the parts in hand. Tell-tales: pointing at their eBay store or feedback score, stock/catalogue photos instead of photos of the actual parts, "brand new sealed" retail stock, shipping-only with no local pickup, or a description written as a retail spec sheet.
  Do NOT reject a genuine local seller merely for mentioning eBay — quoting eBay prices to justify their own ("these go for $1k on eBay") is normal and is not a reason to reject.`;

const RATING_PROMPT = `Rate this listing from 1 to 5:
1 - Reject: not RAM/SSD, DDR3-or-older memory only, fewer than 5 units, a consumer SSD, an eBay/marketplace reseller cross-post, or already sold/pending (see the reject rules above). A listing you are confident is a SINGLE unit is always a 1 — never rate it higher on capacity, price or condition.
2 - Unlikely: probably not a qualifying bulk component lot, or the text establishes no quantity.
3 - Maybe: a qualifying component type but borderline quantity (around 5), unclear condition, or a memory lot whose generation cannot be determined from the text.
4 - Good: a clear bulk lot of 5+ DDR4/DDR5 memory modules (server, desktop or laptop) or 5+ enterprise SSDs, with usable details.
5 - Strong: a large or high-value bulk lot (many units, high capacity, or priced well below market). "Large" and "high-value" describe the lot, never a single unit.
Conclude with exactly one JSON object and nothing else — no prose before or after it, no code fences:
{"rating": <1-5>, "unit_count": <integer or null>, "count_phrase": "<phrase>", "summary": "<summary>"}
where:
- rating is the 1-5 rating defined above;
- unit_count is the number of units you worked out from the text. Use 1 ONLY when you are confident the seller is offering exactly one unit (the single-unit rule above); use null when the text gives nothing to count or you are genuinely unsure. A confident unit_count of 1 must always come with a rating of 1.
- count_phrase is that count as a short phrase (e.g. "8 sticks", "24 SSDs"), or "" when unit_count is null;
- summary names the component type, the unit count, and the price (max 25 words). Always state the count explicitly, e.g. "8x 32GB DDR4 ECC RDIMM".`;

type Props = { showToast?: (msg: string, kind?: 'success' | 'error') => void };

export function DesktopCoordinator({ showToast }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [workers, setWorkers] = useState<FleetWorker[] | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [stats, setStats] = useState<ReviewStatsDay[] | Unavailable | null>(null);
  const [prompt, setPrompt] = useState<FilterPrompt | Unavailable | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const fail = useCallback((err: unknown) => {
    // 501 = proxy env vars unset; 404 = a backend that predates the proxy
    // route entirely. Both mean "no control plane here", not an error.
    if (err instanceof ApiError && (err.status === 501 || err.status === 404)) {
      setNotConfigured(true);
      return;
    }
    handleFetchError(err);
  }, []);

  const load = useCallback(() => {
    coordinatorApi.listWorkers().then(setWorkers).catch(fail);
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(fail);
    // Stats and prompt fail soft to their sample fallbacks — never a dialog.
    coordinatorApi.reviewStats(STATS_DAYS)
      .then(setStats)
      .catch(() => setStats('unavailable'));
    coordinatorApi.filterPrompt()
      .then(p => setPrompt(p.prompt ? p : 'unavailable'))
      .catch(() => setPrompt('unavailable'));
  }, [fail]);

  useEffect(() => { load(); }, [load]);

  // Liveness and queue age both move on their own, so the whole page refetches
  // on a timer rather than waiting for a navigation.
  useEffect(() => {
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <PageHead t={t} />

      {/* ── Review volume (live when the facade answers, sample otherwise) ── */}
      <ReviewVolumeCard locale={locale} stats={stats} />

      {notConfigured ? (
        // The live parts (queue + fleet) need control-plane credentials; the
        // sample-backed cards around them render either way.
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-muted)' }}>
            <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ maxWidth: '65ch' }}>{t('fbcNotConfigured')}</span>
          </div>
        </div>
      ) : (
        <>
          {/* ── Checkpoint queue (first of the live parts: it has a human in it) ── */}
          <ChallengeQueueCard
            challenges={challenges}
            locale={locale}
            onResolved={id => {
              setChallenges(cs => (cs ?? []).filter(c => c.id !== id));
              showToast?.(t('fbcResolved'));
              load();
            }}
            onError={fail}
          />

          {/* ── Fleet ── */}
          <FleetCard workers={workers} locale={locale} />
        </>
      )}

      {/* ── Content filter prompt ── */}
      <ContentFilterCard prompt={prompt} />

      {/* ── Buy-ad clicks (placeholder) ── */}
      <ClicksPlaceholderCard />
    </>
  );
}

function PageHead({ t }: { t: (k: string, vars?: Record<string, string>) => string }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{t('fbcTitle')}</h1>
        <div className="page-sub">{t('fbcSubtitle')}</div>
      </div>
    </div>
  );
}

const FLEET_FILTERS: readonly FleetFilter[] = ['all', 'attention'];
const FILTER_LABEL_KEY: Record<FleetFilter, string> = {
  all: 'fbcFilterAll', attention: 'fbcFilterAttention',
};

const LIVENESS_CHIP: Record<WorkerLiveness, { chip: string; key: string }> = {
  live: { chip: 'chip pos', key: 'fbcLive' },
  stale: { chip: 'chip warn', key: 'fbcStale' },
  dead: { chip: 'chip neg', key: 'fbcDead' },
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

function FleetCard({ workers, locale }: { workers: FleetWorker[] | null; locale: string }) {
  const { t } = useT();
  const [filter, setFilter] = useState<FleetFilter>('all');

  const shown = (workers ?? []).filter(w => filter === 'all' || w.needs_attention);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcFleetTitle')}</div>
          <div className="card-sub">
            {workers
              ? t('fbcFleetSub', { shown: String(shown.length), n: String(workers.length) })
              : '…'}
          </div>
        </div>
        <div className="seg" role="tablist" aria-label={t('fbcFleetTitle')}>
          {FLEET_FILTERS.map(f => (
            <button key={f} type="button" role="tab" aria-selected={filter === f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}>
              {t(FILTER_LABEL_KEY[f])}
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('fbcColStatus')}</th>
              <th>{t('fbcColWorker')}</th>
              <th>{t('fbcColRegion')}</th>
              <th>{t('fbcColState')}</th>
              <th>{t('fbcColSession')}</th>
              <th>{t('fbcColHeartbeat')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(w => <WorkerRow key={w.worker_id} worker={w} locale={locale} />)}
          </tbody>
        </table>
        {workers && shown.length === 0 && (
          <div style={{ padding: '14px 16px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {filter === 'attention' ? t('fbcFleetAllWell') : t('fbcFleetEmpty')}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkerRow({ worker, locale }: { worker: FleetWorker; locale: string }) {
  const { t } = useT();
  const live = LIVENESS_CHIP[worker.liveness] ?? LIVENESS_CHIP.dead;
  const days = worker.session_days_left;

  return (
    <tr style={worker.needs_attention ? { background: 'var(--warn-soft)' } : undefined}>
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className={worker.liveness === 'live' ? 'vl-dot' : undefined}
            style={worker.liveness === 'live' ? undefined : {
              width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
              background: worker.liveness === 'dead' ? 'var(--neg)' : 'var(--warn)',
            }} />
          <span className={live.chip}>{t(live.key)}</span>
        </span>
      </td>
      <td className="mono">
        {worker.worker_id}
        {worker.error_count > 0 && (
          <span className="chip neg" style={{ marginLeft: 6 }}>×{worker.error_count}</span>
        )}
      </td>
      <td className={worker.region ? undefined : 'muted'}>{worker.region ?? '—'}</td>
      <td>
        <span className={STATE_CHIP[worker.state] ?? 'chip muted'}>{stateLabel(t, worker.state)}</span>
      </td>
      <td
        className={worker.session_expiry ? undefined : 'muted'}
        title={worker.session_expiry ?? undefined}
        style={days !== null && days <= 3 ? { color: 'var(--neg)', fontWeight: 550 } : undefined}
      >
        {!worker.session_expiry ? '—'
          : days === null ? worker.session_expiry
          : days <= 0 ? t('fbcSessionExpired')
          : t('fbcSessionDays', { n: String(days) })}
      </td>
      <td className={worker.last_heartbeat_at ? undefined : 'muted'}>
        {worker.last_heartbeat_at ? relTime(worker.last_heartbeat_at, locale) : t('fbcNever')}
      </td>
    </tr>
  );
}

// The control plane can add states faster than this UI ships, so an unknown
// one falls back to its raw name rather than a blank cell.
function stateLabel(t: (k: string) => string, state: WorkerState): string {
  const key = `fbcState_${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function ChallengeQueueCard({ challenges, locale, onResolved, onError }: {
  challenges: Challenge[] | null;
  locale: string;
  onResolved: (id: number) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  const [zoom, setZoom] = useState<Challenge | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcQueueTitle')}</div>
          <div className="card-sub">{t('fbcQueueSub')}</div>
        </div>
        {challenges && challenges.length > 0 && (
          <span className="chip warn">{t('fbcQueueCount', { n: String(challenges.length) })}</span>
        )}
      </div>

      {challenges?.length === 0 && (
        <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icon name="check2" size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--accent-strong)' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('fbcQueueEmpty')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('fbcQueueEmptySub')}
            </div>
          </div>
        </div>
      )}

      {(challenges ?? []).map(ch => (
        <div key={ch.id} style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '12px 16px', borderTop: '1px solid var(--border)',
        }}>
          <Thumbnail challenge={ch} onZoom={() => setZoom(ch)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>{ch.worker_id}</span>
              <span className="chip accent">{ch.kind}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('fbcFlagged', { age: relTime(ch.created_at, locale) })}
              {ch.account_id && ` · ${ch.account_id}`}
            </div>
          </div>
          {ch.vnc_url && (
            <a className="btn sm" href={ch.vnc_url} target="_blank" rel="noopener">
              <Icon name="eye" size={13} />
              {t('fbcOpenVnc')}
            </a>
          )}
          <button className="btn primary sm" disabled={resolving === ch.id}
            onClick={() => {
              setResolving(ch.id);
              coordinatorApi.resolveChallenge(ch.id)
                .then(() => onResolved(ch.id))
                .catch(onError)
                .finally(() => setResolving(null));
            }}>
            {t('fbcResolve')}
          </button>
        </div>
      ))}

      {zoom && (
        <ImageLightbox
          url={challengeScreenshotUrl(zoom.id)}
          alt={t('fbcScreenshotAlt', { id: zoom.worker_id })}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}

function Thumbnail({ challenge, onZoom }: { challenge: Challenge; onZoom: () => void }) {
  const { t } = useT();
  const [broken, setBroken] = useState(false);

  if (!challenge.screenshot_url || broken) {
    return (
      <div style={{
        width: 96, height: 60, borderRadius: 6, border: '1px solid var(--border)',
        background: 'var(--bg-soft)', display: 'grid', placeItems: 'center',
        color: 'var(--fg-subtle)', flexShrink: 0,
      }} title={t('fbcNoScreenshot')}>
        <Icon name="image" size={16} />
      </div>
    );
  }

  return (
    <button type="button" onClick={onZoom} title={t('fbcZoom')} style={{
      width: 96, height: 60, padding: 0, borderRadius: 6, overflow: 'hidden',
      border: '1px solid var(--border)', background: 'var(--bg-soft)',
      cursor: 'zoom-in', flexShrink: 0,
    }}>
      <img
        src={challengeScreenshotUrl(challenge.id)}
        alt={t('fbcScreenshotAlt', { id: challenge.worker_id })}
        onError={() => setBroken(true)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </button>
  );
}

// ─── Review volume ─────────────────────────────────────────────────────────────

type DayPoint = { day: string; reviewed: number; alerted: number };

// Days are UTC on the coordinator side, so the window is built in UTC too —
// otherwise an evening viewer west of Greenwich would see "today" empty.
function lastDaysUtc(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function ReviewVolumeCard({ locale, stats }: {
  locale: string;
  stats: ReviewStatsDay[] | Unavailable | null;
}) {
  const { t } = useT();
  const loading = stats === null;
  const sample = stats === 'unavailable';

  const series: DayPoint[] = (() => {
    const window = lastDaysUtc(STATS_DAYS);
    if (Array.isArray(stats)) {
      const byDay = new Map(stats.map(d => [d.day, d]));
      return window.map(day => ({
        day,
        reviewed: byDay.get(day)?.reviewed ?? 0,
        alerted: byDay.get(day)?.alerted ?? 0,
      }));
    }
    return window.map((day, i) => ({
      day,
      reviewed: SAMPLE_REVIEWED_PER_DAY[i] ?? 0,
      alerted: 0,
    }));
  })();

  const today = series[series.length - 1].reviewed;
  const last7 = series.slice(-7).reduce((sum, d) => sum + d.reviewed, 0);
  const alerts7 = sample
    ? SAMPLE_ALERTS_7D
    : series.slice(-7).reduce((sum, d) => sum + d.alerted, 0);
  const passRate = last7 > 0 ? (alerts7 / last7) * 100 : 0;
  const fmt = new Intl.NumberFormat(locale);
  const value = (n: number | string) => (loading ? '…' : typeof n === 'number' ? fmt.format(n) : n);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcReviewTitle')}</div>
          <div className="card-sub">{t('fbcReviewSub')}</div>
        </div>
        {sample && (
          <span className="chip muted" title={t('fbcSampleNote')}>{t('fbcSample')}</span>
        )}
      </div>
      <div className="card-body">
        <div className="kpi-grid" style={{ marginBottom: 18 }}>
          <div className="kpi">
            <div className="kpi-label">{t('fbcKpiToday')}</div>
            <div className="kpi-value mono">{value(today)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('fbcKpi7d')}</div>
            <div className="kpi-value mono">{value(last7)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('fbcKpiAlerts')}</div>
            <div className="kpi-value mono">{value(alerts7)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t('fbcKpiPassRate')}</div>
            <div className="kpi-value mono">{loading ? '…' : `${passRate.toFixed(1)}%`}</div>
          </div>
        </div>
        {!loading && <ReviewBars series={series} locale={locale} />}
      </div>
    </div>
  );
}

// Single-series daily bar chart: thin accent bars with rounded tops anchored
// to the baseline, first/last date labels, a direct label on today's bar, and
// a native tooltip per bar. No legend — the card title names the series.
function ReviewBars({ series, locale }: { series: readonly DayPoint[]; locale: string }) {
  const { t } = useT();
  const days = series.map(d => d.reviewed);
  const w = 560, h = 120;
  const pad = { l: 4, r: 4, t: 18, b: 16 };
  const innerW = w - pad.l - pad.r, innerH = h - pad.t - pad.b;
  const baseY = pad.t + innerH;
  const max = Math.max(...days, 1);
  const gap = 2;
  const slot = innerW / days.length;
  const barW = slot - gap;

  // Days are UTC dates; format them as such so the labels match the data.
  const dayLabel = (i: number) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${series[i].day}T00:00:00Z`));

  // Rounded-top bar anchored to the baseline; the radius shrinks with very
  // short bars so the corners never invert.
  const barPath = (i: number, v: number) => {
    const x = pad.l + i * slot + gap / 2;
    const bh = Math.max((v / max) * innerH, 1);
    const topY = baseY - bh;
    const r = Math.min(3, bh / 2, barW / 2);
    return `M ${x} ${baseY} L ${x} ${topY + r} Q ${x} ${topY} ${x + r} ${topY}`
      + ` L ${x + barW - r} ${topY} Q ${x + barW} ${topY} ${x + barW} ${topY + r}`
      + ` L ${x + barW} ${baseY} Z`;
  };

  const last = days.length - 1;
  const lastX = pad.l + last * slot + gap / 2 + barW / 2;
  const lastTopY = baseY - Math.max((days[last] / max) * innerH, 1);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={t('fbcChartLabel', { n: String(days.length) })}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <line x1={pad.l} y1={baseY} x2={w - pad.r} y2={baseY}
        stroke="var(--border)" strokeWidth={1} />
      {days.map((v, i) => (
        <path key={i} d={barPath(i, v)} fill="var(--accent)" opacity={i === last ? 1 : 0.75}>
          <title>{`${dayLabel(i)} — ${t('fbcChartTooltip', { n: String(v) })}`}</title>
        </path>
      ))}
      <text x={lastX} y={lastTopY - 6} textAnchor="middle" fontSize={11} fontWeight={600}
        fill="var(--fg)" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {days[last]}
      </text>
      <text x={pad.l} y={h - 3} fontSize={10} fill="var(--fg-subtle)">{dayLabel(0)}</text>
      <text x={w - pad.r} y={h - 3} textAnchor="end" fontSize={10} fill="var(--fg-subtle)">
        {dayLabel(last)}
      </text>
    </svg>
  );
}

// ─── Content filter ────────────────────────────────────────────────────────────

function ContentFilterCard({ prompt }: { prompt: FilterPrompt | Unavailable | null }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  const live = prompt !== null && prompt !== 'unavailable';
  const mainText = live ? (prompt.prompt ?? '') : FILTER_PROMPT;
  const ratingText = live ? (prompt.rating_prompt ?? '') : RATING_PROMPT;
  const model = live ? prompt.model : null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcPromptTitle')}</div>
          <div className="card-sub">{t('fbcPromptSub')}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {model && <span className="chip info mono">{model}</span>}
          {prompt === 'unavailable' && (
            <span className="chip muted" title={t('fbcPromptSourceNote')}>{t('fbcSample')}</span>
          )}
          <span className="chip muted">{t('fbcPromptReadOnly')}</span>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-subtle)', fontSize: 12.5 }}>
          <Icon name="info" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ maxWidth: '75ch' }}>
            {live ? t('fbcPromptLiveNote') : t('fbcPromptSourceNote')}
          </span>
        </div>
        <PromptBlock label={t('fbcPromptMain')} text={mainText} expanded={expanded} />
        {expanded && ratingText && (
          <PromptBlock label={t('fbcPromptRating')} text={ratingText} expanded />
        )}
        <button className="btn sm" style={{ alignSelf: 'flex-start' }}
          onClick={() => setExpanded(x => !x)}>
          <Icon name={expanded ? 'minus' : 'plus'} size={13} />
          {expanded ? t('fbcPromptHide') : t('fbcPromptShow')}
        </button>
      </div>
    </div>
  );
}

function PromptBlock({ label, text, expanded }: { label: string; text: string; expanded: boolean }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--fg-subtle)', marginBottom: 6,
      }}>
        {label}
      </div>
      <pre className="mono" style={{
        margin: 0, padding: '12px 14px', fontSize: 12, lineHeight: 1.55,
        whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
        background: 'var(--bg-soft)', border: '1px solid var(--border)', borderRadius: 8,
        maxHeight: expanded ? undefined : 150, overflow: 'hidden',
        // Collapsed: fade the cut-off edge so it reads as truncated, not broken.
        maskImage: expanded ? undefined : 'linear-gradient(to bottom, black 60%, transparent)',
        WebkitMaskImage: expanded ? undefined : 'linear-gradient(to bottom, black 60%, transparent)',
      }}>
        {text}
      </pre>
    </div>
  );
}

// ─── Buy-ad clicks (placeholder) ───────────────────────────────────────────────
// Long-term goal: per-ad click-throughs for every buy ad the poster publishes.
// Nothing measures clicks yet, so this is an announced empty state — it holds
// the page position and names the columns the future table will have.

function ClicksPlaceholderCard() {
  const { t } = useT();
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">{t('fbcClicksTitle')}</div>
          <div className="card-sub">{t('fbcClicksSub')}</div>
        </div>
        <span className="chip muted">{t('fbcClicksPlanned')}</span>
      </div>
      <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Icon name="trending" size={16} style={{ flexShrink: 0, marginTop: 2, color: 'var(--fg-subtle)' }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('fbcClicksEmpty')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2, maxWidth: '65ch' }}>
            {t('fbcClicksEmptySub')}
          </div>
        </div>
      </div>
    </div>
  );
}
