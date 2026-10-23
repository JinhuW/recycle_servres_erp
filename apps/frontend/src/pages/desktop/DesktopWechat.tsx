import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  headlinePrice,
  priceChange,
  priceSpread,
  type WechatDay,
  type WechatDaySummary,
  type WechatEvidence,
  type WechatHistoryDay,
  type WechatPrice,
  type WechatPriceBucket,
  type WechatRow,
  type WechatRowKind,
  type WechatSide,
} from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { RefinePanel } from '../../components/RefinePanel';
import { Skeleton, TableSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useElementWidth } from '../../lib/useElementWidth';
import { hrefFor, matchWechatDay, navigate, readHashQuery, replaceHashQuery, useRoute, wechatDayPath } from '../../lib/route';
import { queryTerms } from '../../lib/fleetView';
import {
  BUCKET_LABEL_KEY,
  BUCKET_TAX_KEY,
  FACETS,
  SIGNAL_KEY,
  SIGNAL_TONE,
  SIGNALS,
  UNBRANDED,
  boardOrder,
  boardRows,
  facetCounts,
  facetOrder,
  fmtPrice,
  fmtRange,
  hasPrice,
  ladder,
  parseNotes,
  signalCounts,
  traders,
  wechatApi,
  type Facet,
  type FacetPicks,
} from '../../lib/wechatMarket';
import { niceStep } from './DashboardChart';
import { Hi } from './FleetAccounts';
import '../../styles/facebookPool.css';

// ─── Monitors ▸ WeChat ────────────────────────────────────────────────────────
// The daily memory-module market memtrade reads out of the team's WeChat
// trading groups and pushes here after its 08:00 ET run. One report day at a
// time, in the Facebook fleet page's chrome: a signal legend and the
// inventory page's refine chips that filter the price board — what buyers bid and sellers ask for each module, how many
// traders stand behind each price, against the day before, and the posts
// themselves — beside the day's notes and rankings; the groups on a tab of
// their own.

const KINDS: readonly WechatRowKind[] = ['quote', 'spec', 'code'];
const KIND_KEY: Record<WechatRowKind, string> = { quote: 'wxKindQuote', spec: 'wxKindSpec', code: 'wxKindCode' };
const TOP_N = 6;
const HISTORY_DAYS = 30;
// Report days are cut at 08:00 New York time, so their windows read in ET.
const REPORT_TZ = 'America/New_York';

type Loaded = { day: WechatDay; rows: WechatRow[] };
type Tab = 'board' | 'groups';

const tabFromUrl = (): Tab => (readHashQuery().get('view') === 'groups' ? 'groups' : 'board');

// The legend wears the board's side colours: demand-heavy is the bid's.
const SIGNAL_CLASS: Record<'info' | 'accent' | 'muted', string> = {
  info: 'wx-sig-bid', muted: 'wx-sig-even', accent: 'wx-sig-ask',
};

export function DesktopWechat() {
  const { t, locale } = useT();
  const { path } = useRoute();
  const routed = matchWechatDay(path)?.date ?? null;

  const [days, setDays] = useState<WechatDaySummary[] | null>(null);
  const [kind, setKind] = useState<WechatRowKind>('quote');
  const [loaded, setLoaded] = useState<Loaded | 'missing' | null>(null);
  const [specRows, setSpecRows] = useState<WechatRow[] | null>(null);
  const [search, setSearch] = useState('');
  const [pricedOnly, setPricedOnly] = useState(true);
  const [signal, setSignal] = useState<string | null>(null);
  // Held across families and days; a family applies the facets it has.
  const [picks, setPicks] = useState<FacetPicks>({});
  // The view rides the route's query, so a reload or a copied link opens the
  // same tab. The path carries the day, and a day change keeps the tab.
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  useEffect(() => {
    const q = readHashQuery();
    if (tab === 'board') q.delete('view'); else q.set('view', tab);
    replaceHashQuery(q);
  }, [tab, path]);

  const date = routed ?? days?.[0]?.date ?? null;

  // One request per day and family while the page is open: the board and the
  // side panel both read a day's spec lines. A failed one is dropped so the
  // next look asks again.
  const dayCache = useRef(new Map<string, Promise<Loaded>>());
  const loadDay = useCallback((d: string, k: WechatRowKind) => {
    const key = `${d}:${k}`;
    let p = dayCache.current.get(key);
    if (!p) {
      p = wechatApi.day(d, k);
      dayCache.current.set(key, p);
      p.catch(() => dayCache.current.delete(key));
    }
    return p;
  }, []);

  useEffect(() => {
    let alive = true;
    wechatApi.days().then(d => { if (alive) setDays(d); }).catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    setLoaded(null);
    loadDay(date, kind)
      .then(r => { if (alive) setLoaded(r); })
      .catch(err => {
        if (!alive) return;
        // A 400 is a date that can't be one (2026-02-30): no report either.
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) setLoaded('missing');
        else handleFetchError(err);
      });
    return () => { alive = false; };
  }, [date, kind, loadDay]);

  // The side panel ranks specs whichever family the board shows.
  useEffect(() => {
    if (!date) return;
    let alive = true;
    setSpecRows(null);
    loadDay(date, 'spec')
      .then(r => { if (alive) setSpecRows(r.rows); })
      .catch(() => { if (alive) setSpecRows([]); });
    return () => { alive = false; };
  }, [date, loadDay]);

  // The rankings rank by traders, priced or not, so a pick the priced-only
  // filter, the signal or a refine chip would hide clears them.
  const pickSpec = (row: WechatRow) => {
    setKind('spec');
    setSearch(row.key);
    setSignal(null);
    setPicks({});
    if (!hasPrice(row)) setPricedOnly(false);
  };
  const active = useMemo(
    () => Object.fromEntries(FACETS[kind].filter(f => picks[f]?.length).map(f => [f, picks[f]])) as FacetPicks,
    [kind, picks],
  );
  const togglePick = (f: Facet, v: string) => setPicks(p => {
    const cur = p[f] ?? [];
    return { ...p, [f]: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] };
  });

  const day = loaded && loaded !== 'missing' ? loaded.day : null;
  const rows = loaded && loaded !== 'missing' ? loaded.rows : null;
  const summary = days?.find(d => d.date === date) ?? null;
  const prevSummary = day?.prevDate ? days?.find(d => d.date === day.prevDate) ?? null : null;
  // As the Facebook legend ignores its search box, the counts ignore this
  // one: they are the lines each pill would show.
  const legend = useMemo(
    () => (rows ? signalCounts(boardRows(rows, { pricedOnly, search: '', signal: null, picks: active })) : null),
    [rows, pricedOnly, active],
  );

  const head = (
    <div className="page-head">
      <div><div className="page-sub">{t('nav_monitors')} / {t('nav_wechat')}</div>
        <h1 className="page-title">{t('wxTitle')}</h1></div>
      {days && days.length > 0 && date && (
        <DayNav days={days} date={date} prev={day?.prevDate ?? null} next={day?.nextDate ?? null} />
      )}
    </div>
  );
  // Links, as the fleet pages' tabs are, so a view opens in a tab of its own.
  // A plain click stays on the page: the query is all that moves.
  const tabLink = (v: Tab) => ({
    className: `tab ${tab === v ? 'active' : ''}`,
    href: hrefFor(path + (v === 'groups' ? '?view=groups' : '')),
    'aria-current': tab === v ? ('page' as const) : undefined,
    onClick: (e: React.MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setTab(v);
    },
  });
  const tabs = (
    <nav className="tabs fp-view-tabs" aria-label={t('wxViews')}>
      <a {...tabLink('board')}>
        <Icon name="tag" size={14} />{t('wxBoard')}{rows && <span className="chip muted">{rows.length}</span>}
      </a>
      <a {...tabLink('groups')}>
        <Icon name="chats" size={14} />{t('wxTabGroups')}{summary && <span className="chip muted">{summary.totals.groupsTotal}</span>}
      </a>
    </nav>
  );

  if (days && days.length === 0) {
    return (
      <>
        {head}
        <div className="card">
          <div className="card-body wx-empty">
            <Icon name="chats" size={18} />
            <div>
              <b>{t('wxEmptyTitle')}</b>
              <p>{t('wxEmptyBody')}</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Head and tabs sit outside .fp-pool, as on the Facebook page.
  return (
    <>
      {head}
      {tabs}
      <div className="fp-pool wx-page">
        {loaded === 'missing' && (
          <div className="wx-banner"><Icon name="info" size={15} /><span>{t('wxDayMissing', { date: date ?? '' })}</span></div>
        )}
        {day?.degraded && (
          <div className="wx-banner wx-warn"><Icon name="alert" size={15} /><span>{t('wxDegraded')}</span></div>
        )}
        {day && day.storedPoints < day.pointCount && (
          <div className="wx-banner wx-warn">
            <Icon name="alert" size={15} />
            <span>{t('wxPartial', { n: day.storedPoints, total: day.pointCount })}</span>
          </div>
        )}
        {day && day.warnings.length > 0 && (
          <div className="wx-banner wx-warn">
            <Icon name="alert" size={15} />
            <ul>{day.warnings.map(w => <li key={w}>{w}</li>)}</ul>
          </div>
        )}

        {tab === 'board' && loaded !== 'missing' && <>
          <SignalLegend counts={legend} signal={signal} onSignal={setSignal} />
          <div className="fp-split wx-split">
            <BoardCard
              kind={kind}
              onKind={k => { setKind(k); setSearch(''); setSignal(null); }}
              loaded={loaded}
              search={search}
              onSearch={setSearch}
              pricedOnly={pricedOnly}
              onPricedOnly={setPricedOnly}
              signal={signal}
              picks={active}
              onPick={togglePick}
              onClearPicks={() => setPicks({})}
              onClear={() => { setSearch(''); setSignal(null); setPicks({}); }}
              summary={summary}
              prev={prevSummary}
              locale={locale}
            />
            <aside className="wx-aside">
              <NotesCard day={day} />
              <TopCard title={t('wxMostWanted')} sub={t('wxMostWantedSub')} rows={specRows} side="buy" locale={locale}
                onPick={pickSpec} />
              <TopCard title={t('wxMostOffered')} sub={t('wxMostOfferedSub')} rows={specRows} side="sell" locale={locale}
                onPick={pickSpec} />
            </aside>
          </div>
        </>}

        {tab === 'groups' && loaded !== 'missing' && <GroupsCard day={day} locale={locale} />}
      </div>
    </>
  );
}

// memtrade spells a spec quoted without a speed "64G 速率未注明".
const SPEED_UNKNOWN = '速率未注明';
function lineKey(key: string, t: (k: string) => string): string {
  return key.endsWith(SPEED_UNKNOWN) ? key.slice(0, -SPEED_UNKNOWN.length) + t('wxSpeedUnknown') : key;
}

function fmtWindow(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: REPORT_TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

function fmtDay(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' })
    .format(new Date(`${date}T00:00:00Z`));
}

function DayNav({ days, date, prev, next }: {
  days: WechatDaySummary[];
  date: string;
  prev: string | null;
  next: string | null;
}) {
  const { t, locale } = useT();
  return (
    <div className="page-actions wx-daynav">
      <button className="btn icon" disabled={!prev} title={t('wxPrevDay')} aria-label={t('wxPrevDay')}
        onClick={() => prev && navigate(wechatDayPath(prev))}>
        <Icon name="chevronLeft" size={14} />
      </button>
      <select className="select" aria-label={t('wxReportDay')} value={date}
        onChange={e => navigate(wechatDayPath(e.target.value))}>
        {days.some(d => d.date === date) ? null : <option value={date}>{date}</option>}
        {days.map(d => (
          <option key={d.date} value={d.date}>
            {fmtDay(d.date, locale)}{d.degraded ? ` · ${t('wxRulesShort')}` : ''}
          </option>
        ))}
      </select>
      <button className="btn icon" disabled={!next} title={t('wxNextDay')} aria-label={t('wxNextDay')}
        onClick={() => next && navigate(wechatDayPath(next))}>
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  );
}

function SignalLegend({ counts, signal, onSignal }: {
  counts: Record<string, number> | null;
  signal: string | null;
  onSignal: (s: string | null) => void;
}) {
  const { t } = useT();
  return (
    <div className="fp-legend" role="group" aria-label={t('wxSignals')}>
      {SIGNALS.map(s => (
        <button key={s} type="button" className={`fp-legend-item ${SIGNAL_CLASS[SIGNAL_TONE[s] ?? 'muted']}`}
          aria-pressed={signal === s} onClick={() => onSignal(signal === s ? null : s)}>
          <i className="fp-dot" />
          <span>{t(SIGNAL_KEY[s]!)}</span>
          <b>{counts ? counts[s] : <Skeleton width={14} height={13} radius={4} />}</b>
        </button>
      ))}
    </div>
  );
}

// "+12%" against the day before; null when that day had none to compare.
function trend(cur: number, before: number): string | null {
  if (before === 0) return null;
  const pct = (cur - before) / before;
  if (Math.abs(pct) < 0.005) return '±0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%`;
}

// ── The board ─────────────────────────────────────────────────────────────────

const FACET_KEY: Record<Facet, string> = {
  ddr: 'wxFacetGeneration', speed: 'wxFacetSpeed', brand: 'wxFacetBrand',
  capacity: 'wxFacetCapacity', form: 'wxFacetDevice', rank: 'wxFacetRank',
};

function BoardCard({
  kind, onKind, loaded, search, onSearch, pricedOnly, onPricedOnly, signal, picks, onPick, onClearPicks, onClear,
  summary, prev, locale,
}: {
  kind: WechatRowKind;
  onKind: (k: WechatRowKind) => void;
  loaded: Loaded | 'missing' | null;
  search: string;
  onSearch: (s: string) => void;
  pricedOnly: boolean;
  onPricedOnly: (v: boolean) => void;
  signal: string | null;
  picks: FacetPicks;
  onPick: (f: Facet, v: string) => void;
  onClearPicks: () => void;
  onClear: () => void;
  summary: WechatDaySummary | null;
  prev: WechatDaySummary | null;
  locale: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const data = loaded && loaded !== 'missing' ? loaded : null;
  const fmt = new Intl.NumberFormat(locale);
  // Spec and part-code lines have no brand to show.
  const branded = kind === 'quote';
  const cols = branded ? 9 : 8;

  useEffect(() => { setOpen(null); }, [kind, data?.day.date]);

  const terms = useMemo(() => queryTerms(search), [search]);
  const rows = useMemo(() => {
    const shown = boardRows(data?.rows ?? [], { pricedOnly, search, signal, picks });
    return branded ? shown.sort(boardOrder) : shown;
  }, [data, pricedOnly, search, signal, picks, branded]);
  // As the legend's, the chip counts ignore the search.
  const counts = useMemo(
    () => facetCounts(boardRows(data?.rows ?? [], { pricedOnly, search: '', signal, picks: {} }), FACETS[kind], picks),
    [data, pricedOnly, signal, kind, picks],
  );
  const facetLabel = (f: Facet) => (v: string): string => {
    switch (f) {
      case 'speed': return `${v} MHz`;
      case 'capacity': return `${v}GB`;
      case 'brand': return v === UNBRANDED ? t('wxUnbranded') : v;
      case 'form': return t(v === 'server' ? 'wxFormServer' : 'wxFormPc');
      default: return v;
    }
  };
  // A key per count, so a count of one can read singular.
  const tot = summary?.totals;
  const summaryLine = tot && [
    t('wxSumBuyers', { n: fmt.format(tot.buyers) }),
    t('wxSumSellers', { n: fmt.format(tot.sellers) }),
    t('wxSumPosts', { n: fmt.format(tot.posts) }),
    tot.groupsTotal === 1
      ? t('wxSumGroupsOne', { active: tot.groupsActive, total: 1 })
      : t('wxSumGroups', { active: tot.groupsActive, total: tot.groupsTotal }),
  ].join(' · ');

  return (
    <section className="card wx-board" aria-label={t('wxBoard')}>
      <div className="fp-toolbar">
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={search} autoComplete="off"
            placeholder={t('wxSearch')} aria-label={t('wxSearch')}
            onChange={e => onSearch(e.target.value)} />
        </label>
        {(search || signal || Object.keys(picks).length > 0) && (
          <button type="button" className="btn ghost sm" onClick={onClear}>
            <Icon name="x" size={12} />
            {t('fpClear')}
          </button>
        )}
        <span className="ff-summary" title={summary && prev ? t('wxSummaryVsPrev', {
          b: trend(summary.totals.buyers, prev.totals.buyers) ?? '—',
          s: trend(summary.totals.sellers, prev.totals.sellers) ?? '—',
          date: fmtDay(prev.date, locale),
        }) : undefined}>
          {summaryLine ?? <Skeleton width={240} height={11} />}
        </span>
      </div>
      {/* The Facebook toolbar is search and summary alone; the board's two
          controls would wrap it at this width, so they get a row of their own. */}
      <div className="fp-toolbar wx-board-by">
        <div className="seg" role="tablist" aria-label={t('wxBoardBy')}>
          {KINDS.map(k => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => onKind(k)}>
              {t(KIND_KEY[k])}
            </button>
          ))}
        </div>
        <label className="wx-check">
          <input type="checkbox" checked={pricedOnly} onChange={e => onPricedOnly(e.target.checked)} />
          {t('wxPricedOnly')}
        </label>
      </div>
      <RefinePanel
        id="wx-refine-body"
        title={<>{t('invRefinePre')} <strong>RAM</strong></>}
        open={refineOpen}
        onOpen={setRefineOpen}
        rows={FACETS[kind].map(f => ({
          key: f,
          label: t(FACET_KEY[f]),
          values: facetOrder(f, Object.keys(counts[f])),
          counts: counts[f],
          format: facetLabel(f),
        }))}
        selected={picks}
        onToggle={(f, v) => onPick(f as Facet, v)}
        onClear={onClearPicks}
      />

      {!data ? (
        <TableSkeleton rows={10} cols={6} />
      ) : (
        <div className="fp-table-wrap">
          <table className="fp-table wx-table">
            <thead>
              <tr>
                {branded && <th>{t('wxColBrand')}</th>}
                <th>{t(kind === 'quote' ? 'wxColModule' : kind === 'spec' ? 'wxColSpec' : 'wxColCode')}</th>
                <th>{t('wxColGeneration')}</th>
                <th className="wx-num" title={t('wxColBidHint')}>{t('wxColBid')}</th>
                <th className="wx-num" title={t('wxColAskHint')}>{t('wxColAsk')}</th>
                <th title={t('wxColSpreadHint')}>{t('wxColSpread')}</th>
                <th className="wx-num" title={t('wxColTradersHint')}>{t('wxColTraders')}</th>
                <th>{t('wxColSignal')}</th>
                <th className="wx-num" title={t('wxColChangeHint', { date: data.day.prevDate ?? '—' })}>{t('wxColChange')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = open === r.key;
                return (
                  <Fragment key={r.key}>
                    <BoardRow row={r} branded={branded} terms={terms} open={isOpen} locale={locale}
                      onToggle={() => setOpen(isOpen ? null : r.key)} />
                    {isOpen && (
                      <tr className="wx-detail-row">
                        <td colSpan={cols}><LineDetail date={data.day.date} row={r} locale={locale} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={cols} className="fp-empty">{data.rows.length ? t('wxNoMatch') : t('wxNoLines')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="fp-table-foot wx-foot">
        <span>
          {data ? t('wxBoardCount', { shown: rows.length, n: data.rows.length }) : <Skeleton width={90} height={11} />}
          {summary && ` · ${t('wxWindow', {
            from: fmtWindow(summary.windowStart, locale),
            to: fmtWindow(summary.windowEnd, locale),
            age: relTime(summary.pushedAt, locale),
          })}`}
        </span>
        <span>{t('wxBoardFoot')}</span>
      </div>
    </section>
  );
}

function LineName({ row, terms }: { row: WechatRow; terms: readonly string[] }) {
  const { t } = useT();
  const spec = [row.ranks[0], row.formFactor === 'pc' ? t('wxFormPc') : null, row.partNumbers[0]].filter(Boolean);
  return (
    <span className="fp-holder">
      {row.kind === 'quote' ? (
        <span className="wx-line">
          <b><Hi text={`${row.capacityGb}G`} terms={terms} /></b>
          <span><Hi text={String(row.speed ?? '—')} terms={terms} /></span>
          {row.code ? <span className="wx-code"><Hi text={row.code} terms={terms} /></span> : <span className="fp-muted">{t('wxAnyCode')}</span>}
        </span>
      ) : (
        <span className="wx-line"><b><Hi text={lineKey(row.key, t)} terms={terms} /></b></span>
      )}
      {spec.length > 0 && <small className="mono"><Hi text={spec.join(' · ')} terms={terms} /></small>}
    </span>
  );
}

function PriceCell({ stats, side, locale }: { stats: WechatRow['buy']; side: WechatSide; locale: string }) {
  const { t } = useT();
  const p = headlinePrice(stats);
  if (!p) return <td className="wx-num fp-muted">—</td>;
  const tax = BUCKET_TAX_KEY[p.bucket];
  const range = fmtRange(p, locale);
  const others = stats.prices.slice(1);
  return (
    <td className="wx-num">
      <span className="fp-holder">
        <span className={`wx-price wx-${side}`}>
          <b className="mono">{fmtPrice(p.median, p.bucket, locale)}</b>
          {tax && <em>{t(tax)}</em>}
        </span>
        <small title={others.map(o => `${fmtPrice(o.median, o.bucket, locale)} ${BUCKET_TAX_KEY[o.bucket] ? t(BUCKET_TAX_KEY[o.bucket]!) : ''} · ${t('wxQuotes', { n: o.n })}`).join('\n') || undefined}>
          {t('wxQuotes', { n: p.n })}{range ? ` · ${range}` : ''}{others.length ? ` · +${others.length}` : ''}
        </small>
      </span>
    </td>
  );
}

function Ladder({ row, locale }: { row: WechatRow; locale: string }) {
  const { t } = useT();
  const l = ladder(row);
  const spread = priceSpread(row);
  if (!l) return <td className="fp-muted">—</td>;
  const seg = (s: { from: number; to: number; at: number } | null, side: WechatSide) => s && (
    <>
      <i className={`wx-range wx-${side}`} style={{ left: `${s.from}%`, width: `${Math.max(s.to - s.from, 1.5)}%` }} />
      <i className={`wx-tick wx-${side}`} style={{ left: `${s.at}%` }} />
    </>
  );
  return (
    <td>
      <span className="fp-holder">
        <span className="wx-ladder" aria-hidden>{seg(l.bid, 'buy')}{seg(l.ask, 'sell')}</span>
        <small className={spread && spread.value < 0 ? 'fp-warn' : undefined}>
          {spread
            ? `${spread.value < 0
                ? t('wxCrossed', { v: fmtPrice(-spread.value, spread.bucket, locale) })
                : t('wxSpread', { v: fmtPrice(spread.value, spread.bucket, locale) })} · ${t(BUCKET_LABEL_KEY[spread.bucket])}`
            : t(l.bid ? 'wxBidOnly' : 'wxAskOnly')}
        </small>
      </span>
    </td>
  );
}

function Change({ cur, prev }: { cur: WechatPrice | null; prev: WechatPrice | null | undefined }) {
  const pct = prev === undefined ? null : priceChange(cur, prev);
  if (pct === null) return <span className="fp-muted">—</span>;
  if (Math.abs(pct) < 0.0005) return <span className="fp-muted">0%</span>;
  return (
    <span className={pct > 0 ? 'wx-up' : 'wx-down'}>
      <Icon name={pct > 0 ? 'arrowUp' : 'arrowDown'} size={10} />
      {Math.abs(pct * 100).toFixed(1)}%
    </span>
  );
}

function BoardRow({ row, branded, terms, open, locale, onToggle }: {
  row: WechatRow;
  branded: boolean;
  terms: readonly string[];
  open: boolean;
  locale: string;
  onToggle: () => void;
}) {
  const { t } = useT();
  const signal = row.signal ? SIGNAL_KEY[row.signal] : undefined;
  return (
    <tr className={`wx-row${open ? ' wx-open' : ''}`} onClick={onToggle} aria-expanded={open}
      tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
      {branded && (
        <td className="wx-tag">
          {row.brand && row.brand !== UNBRANDED
            ? <Hi text={row.brand} terms={terms} /> : <span className="fp-muted">{t('wxUnbranded')}</span>}
        </td>
      )}
      <td className="wx-line-cell"><LineName row={row} terms={terms} /></td>
      <td className="wx-tag mono">{row.ddr ? <Hi text={row.ddr} terms={terms} /> : <span className="fp-muted">—</span>}</td>
      <PriceCell stats={row.buy} side="buy" locale={locale} />
      <PriceCell stats={row.sell} side="sell" locale={locale} />
      <Ladder row={row} locale={locale} />
      <td className="wx-num">
        <span className="fp-holder">
          <span className="mono"><span className="wx-bid-n">{row.buy.senders}</span><span className="fp-muted"> / </span><span className="wx-ask-n">{row.sell.senders}</span></span>
          <small>{t('wxPostsPair', { b: row.buy.posts, s: row.sell.posts })}</small>
        </span>
      </td>
      <td>
        {row.signal && signal
          ? <span className={`chip ${SIGNAL_TONE[row.signal] ?? 'muted'}`} title={t('wxSignalHint', { b: row.buy.posts, s: row.sell.posts })}>{t(signal)}</span>
          : <span className="fp-muted">—</span>}
      </td>
      <td className="wx-num">
        {row.prev === null ? (
          <span className="chip muted" title={t('wxNewHint')}>{t('wxNew')}</span>
        ) : (
          <span className="fp-holder wx-changes">
            <span title={t('wxBid')}><Change cur={headlinePrice(row.buy)} prev={row.prev.buy} /><i className="wx-dot wx-buy" /></span>
            <span title={t('wxAsk')}><Change cur={headlinePrice(row.sell)} prev={row.prev.sell} /><i className="wx-dot wx-sell" /></span>
          </span>
        )}
      </td>
    </tr>
  );
}

// ── One line, opened ──────────────────────────────────────────────────────────

function LineDetail({ date, row, locale }: { date: string; row: WechatRow; locale: string }) {
  const { t } = useT();
  const [points, setPoints] = useState<WechatEvidence[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [history, setHistory] = useState<WechatHistoryDay[] | null>(null);
  const [side, setSide] = useState<WechatSide | 'all'>('all');

  // Each side is its own request: the newest posts of both sides are mostly
  // one side's on a busy line, so filtering them here would hide the other.
  useEffect(() => {
    let alive = true;
    setPoints(null);
    wechatApi.evidence(date, row.kind, row.key, side === 'all' ? undefined : side)
      .then(r => { if (alive) { setPoints(r.points); setLimit(r.limit); } })
      .catch(err => { if (alive) { setPoints([]); handleFetchError(err); } });
    return () => { alive = false; };
  }, [date, row.kind, row.key, side]);

  useEffect(() => {
    let alive = true;
    wechatApi.history(row.kind, row.key, date, HISTORY_DAYS)
      .then(h => { if (alive) setHistory(h); })
      .catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [date, row.kind, row.key]);


  return (
    <div className="wx-detail">
      <div className="wx-posts">
        <div className="fp-row fp-between">
          <div className="fp-section-label">{t('wxPosts')}</div>
          <div className="seg wx-seg-sm">
            {(['all', 'buy', 'sell'] as const).map(s => (
              <button key={s} className={side === s ? 'active' : ''} onClick={e => { e.stopPropagation(); setSide(s); }}>
                {t(s === 'all' ? 'all' : s === 'buy' ? 'wxBids' : 'wxAsks')}
              </button>
            ))}
          </div>
        </div>
        <ul className="wx-evidence">
          {!points && [0, 1, 2].map(i => (
            <li key={i} aria-hidden><Skeleton width={180} height={12} /><Skeleton width={260} height={10} /></li>
          ))}
          {points?.map(p => <EvidenceItem key={`${p.postKey}#${p.itemIndex}`} p={p} locale={locale} />)}
          {points?.length === 0 && <li className="fp-muted">{t('wxNoPosts')}</li>}
        </ul>
        {points && points.length >= limit && limit > 0 && <span className="fp-muted rt-help">{t('wxPostsCapped', { n: limit })}</span>}
      </div>
      <div className="wx-side-stats">
        <div className="fp-section-label">{t('wxHistory', { n: HISTORY_DAYS })}</div>
        <HistoryChart history={history} locale={locale} />
        <div className="fp-section-label">{t('wxBuckets')}</div>
        <table className="fp-table wx-buckets">
          <tbody>
            {(['buy', 'sell'] as const).flatMap(s => row[s].prices.map(p => (
              <tr key={`${s}${p.bucket}`}>
                <td><span className={`wx-dot wx-${s}`} />{t(s === 'buy' ? 'wxBid' : 'wxAsk')}</td>
                <td className="mono">{fmtPrice(p.median, p.bucket, locale)} {BUCKET_TAX_KEY[p.bucket] ? <em className="fp-muted">{t(BUCKET_TAX_KEY[p.bucket]!)}</em> : null}</td>
                <td className="fp-muted">{t('wxQuotes', { n: p.n })}{fmtRange(p, locale) ? ` · ${fmtRange(p, locale)}` : ''}</td>
                <td className="fp-muted">{p.outliers ? t('wxOutliers', { n: p.outliers }) : ''}</td>
              </tr>
            )))}
            {!row.buy.prices.length && !row.sell.prices.length && (
              <tr><td colSpan={4} className="fp-muted">{t('wxNoPrices')}</td></tr>
            )}
          </tbody>
        </table>
        <div className="wx-facts">
          {(['buy', 'sell'] as const).map(s => (
            <span key={s}>
              <span className={`wx-dot wx-${s}`} />
              {t(s === 'buy' ? 'wxFactsBuy' : 'wxFactsSell', {
                posts: row[s].posts, groups: row[s].groups, copies: row[s].exposures,
              })}
              {row[s].qty > 0 && ` · ${t('wxQty', { n: new Intl.NumberFormat(locale).format(row[s].qty) })}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function EvidenceItem({ p, locale }: { p: WechatEvidence; locale: string }) {
  const { t } = useT();
  const groups = p.groups.slice(0, 2).join('、') + (p.groups.length > 2 ? ` +${p.groups.length - 2}` : '');
  return (
    <li>
      <span className={`wx-dot wx-${p.direction}`} title={t(p.direction === 'buy' ? 'wxBid' : 'wxAsk')} />
      <div>
        <div className="wx-ev-head">
          <b>{p.senderName || p.senderId}</b>
          {p.price !== null && p.currency && (
            <span className={`mono wx-${p.direction}`}>
              {fmtPrice(p.price, p.currency === 'USD' ? 'USD' : 'RMB', locale)}
              {p.priceApprox ? '~' : ''}
              {p.tax ? ` ${p.tax}` : ''}
            </span>
          )}
          {p.qty !== null && <span className="fp-muted">×{p.qty}</span>}
          <time title={new Date(p.lastAt).toLocaleString(locale)}>{relTime(p.lastAt, locale)}</time>
        </div>
        <p className="wx-raw">{p.rawLine || '—'}</p>
        <small className="fp-muted" title={p.groups.join('\n')}>
          {groups}{p.messages > 1 ? ` · ${t('wxCopies', { n: p.messages })}` : ''}{p.source === 'rules' ? ` · ${t('wxByRules')}` : ''}
        </small>
      </div>
    </li>
  );
}

// Both sides' headline medians across report days, on one scale and so in one
// tax basis: the one most of them were quoted in, the latest on a tie. Prices
// in another basis, like a day nobody quoted the line, are a gap.
function chartBasis(history: WechatHistoryDay[]): WechatPriceBucket | null {
  const n = new Map<WechatPriceBucket, number>();
  for (const h of history) {
    for (const s of ['buy', 'sell'] as const) {
      const b = h[s].price?.bucket;
      if (b) n.set(b, (n.get(b) ?? 0) + 1);
    }
  }
  let best: WechatPriceBucket | null = null;
  for (const h of history) {
    for (const s of ['buy', 'sell'] as const) {
      const b = h[s].price?.bucket;
      if (b && (best === null || n.get(b)! >= n.get(best)!)) best = b;
    }
  }
  return best;
}

const HIST_H = 160;
const HIST_PAD = { t: 10, b: 24 };
// JetBrains Mono at the axis's 10.5–11px, close enough to size the gutters
// from a label's length.
const MONO_CH = 6.6;
const SIDES = ['buy', 'sell'] as const;
const inBasis = (h: WechatHistoryDay, s: WechatSide, basis: WechatPriceBucket) =>
  (h[s].price?.bucket === basis ? h[s].price : null);

function HistoryChart({ history, locale }: { history: WechatHistoryDay[] | null; locale: string }) {
  const { t } = useT();
  if (!history) return <Skeleton width="100%" height={HIST_H + 40} />;
  const basis = chartBasis(history);
  const priced = basis ? history.reduce((k, h) => k + SIDES.filter(s => inBasis(h, s, basis)).length, 0) : 0;
  if (!basis || priced < 2) return <p className="fp-muted wx-chart-empty">{t('wxHistoryThin')}</p>;
  return <HistoryPlot history={history} basis={basis} locale={locale} />;
}

// The board's ladder turned upright, one per report day: each side's quotes
// low to high in its own lane, bid left of the day and ask right of it, with
// the median on top and the medians joined. A dashed bridge crosses days the
// side wasn't quoted in this basis.
function HistoryPlot({ history, basis, locale }: { history: WechatHistoryDay[]; basis: WechatPriceBucket; locale: string }) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale]);
  const day = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));
  const fmt = (v: number) => fmtPrice(v, basis, locale);

  const pts = { buy: history.map(h => inBasis(h, 'buy', basis)), sell: history.map(h => inBasis(h, 'sell', basis)) };
  const all = SIDES.flatMap(s => pts[s].filter((p): p is WechatPrice => p !== null));
  const lo = Math.min(...all.map(p => p.min));
  const hi = Math.max(...all.map(p => p.max));
  const step = niceStep((hi - lo) / 3 || hi / 20 || 1);
  let yMin = Math.floor(lo / step) * step;
  let yMax = Math.ceil(hi / step) * step;
  if (yMin === yMax) { yMin = Math.max(0, yMin - step); yMax += step; }
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(v);

  const ends = SIDES.flatMap(s => {
    for (let i = history.length - 1; i >= 0; i--) {
      const p = pts[s][i];
      if (p) return [{ s, i, label: fmt(p.median) }];
    }
    return [];
  });
  const padL = 12 + Math.max(...ticks.map(v => fmt(v).length)) * MONO_CH;
  const padR = 14 + Math.max(0, ...ends.map(e => e.label.length)) * MONO_CH;
  const n = history.length;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = HIST_H - HIST_PAD.t - HIST_PAD.b;
  const slot = innerW / n;
  const lane = Math.min(4, slot * 0.18);
  const barW = Math.max(2, Math.min(6, slot * 0.25));
  const cx = (i: number) => padL + slot * (i + 0.5);
  const x = (i: number, s: WechatSide) => cx(i) + (s === 'buy' ? -lane : lane);
  const y = (v: number) => HIST_PAD.t + ((yMax - v) / (yMax - yMin)) * innerH;

  const lines = (s: WechatSide) => {
    let solid = '';
    let bridge = '';
    let last: { i: number; at: string } | null = null;
    pts[s].forEach((p, i) => {
      if (!p) return;
      const at = `${x(i, s).toFixed(1)},${y(p.median).toFixed(1)}`;
      if (!last) solid += `M${at}`;
      else if (i === last.i + 1) solid += ` L${at}`;
      else { bridge += `M${last.at} L${at} `; solid += ` M${at}`; }
      last = { i, at };
    });
    return { solid, bridge };
  };

  // Each side's latest median sits beside its dot; two that would touch are
  // pushed apart around their midpoint, the higher price staying on top.
  const endY = ends.map(e => y(pts[e.s][e.i]!.median));
  if (ends.length === 2 && Math.abs(cx(ends[0]!.i) - cx(ends[1]!.i)) < padR && Math.abs(endY[0]! - endY[1]!) < 13) {
    const mid = (endY[0]! + endY[1]!) / 2;
    const bidHigher = endY[0]! < endY[1]!;
    endY[0] = mid + (bidHigher ? -6.5 : 6.5);
    endY[1] = mid + (bidHigher ? 6.5 : -6.5);
  }

  const every = Math.ceil(n / Math.max(1, Math.floor(innerW / 64)));
  const idxAt = (clientX: number) => {
    const i = Math.floor((clientX - wrap.current!.getBoundingClientRect().left - padL) / slot);
    return Math.max(0, Math.min(n - 1, i));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { setHover(h => Math.max(0, (h ?? n) - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setHover(h => Math.min(n - 1, (h ?? -1) + 1)); e.preventDefault(); }
    else if (e.key === 'Escape') setHover(null);
  };
  const ranged = all.some(p => p.min < p.max);

  return (
    <div className="wx-chart">
      <div className="wx-hist-head">
        {SIDES.map(s => (
          <span key={s}><i className={`wx-hist-key wx-hist-${s}`} />{t(s === 'buy' ? 'wxBid' : 'wxAsk')}</span>
        ))}
        {ranged && <span><i className="wx-hist-key-range" />{t('wxHistoryRange')}</span>}
        <span className="wx-hist-basis">{t('wxHistoryBasis', { basis: t(BUCKET_LABEL_KEY[basis]) })}</span>
      </div>
      <div className="wx-hist" ref={wrap}>
        <svg width={Math.max(1, width)} height={HIST_H} role="img"
          aria-label={t('wxHistoryAria', { from: history[0]!.date, to: history.at(-1)!.date })}>
          {ticks.map(v => (
            <g key={v}>
              <line className="wx-hist-grid" x1={padL} x2={padL + innerW} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
              <text className="wx-hist-tick" x={padL - 8} y={y(v) + 3.5} textAnchor="end">{fmt(v)}</text>
            </g>
          ))}
          {SIDES.map(s => {
            const { solid, bridge } = lines(s);
            return (
              <g key={s} className={`wx-hist-${s}`}>
                {pts[s].map((p, i) => p && p.min < p.max && (
                  <rect key={i} className="wx-hist-bar" x={x(i, s) - barW / 2} y={y(p.max)}
                    width={barW} height={y(p.min) - y(p.max)} rx={barW / 2} />
                ))}
                <path className="wx-hist-bridge" d={bridge} />
                <path className="wx-hist-line" d={solid} />
                {pts[s].map((p, i) => p && (
                  <circle key={i} className="wx-hist-dot" cx={x(i, s)} cy={y(p.median)} r={hover === i ? 5 : 4} />
                ))}
              </g>
            );
          })}
          {ends.map((e, k) => (
            <text key={e.s} className="wx-hist-end" x={cx(e.i) + lane + 7} y={endY[k]! + 3.5}>{e.label}</text>
          ))}
          {history.map((h, i) => (n - 1 - i) % every === 0 && (
            <text key={h.date} className={`wx-hist-day${i === n - 1 ? ' is-current' : ''}`}
              x={cx(i)} y={HIST_H - 7} textAnchor="middle">{day(h.date)}</text>
          ))}
          {hover !== null && (
            <line className="wx-hist-cross" x1={cx(hover)} x2={cx(hover)} y1={HIST_PAD.t} y2={HIST_PAD.t + innerH} />
          )}
          <rect className="wx-hist-hit" tabIndex={0} x={padL} y={HIST_PAD.t} width={innerW} height={innerH}
            onPointerMove={e => setHover(idxAt(e.clientX))} onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(n - 1)} onBlur={() => setHover(null)} onKeyDown={onKey} />
        </svg>
        {hover !== null && (
          <HistoryTip day={history[hover]!} basis={basis} locale={locale} title={day(history[hover]!.date)}
            style={cx(hover) > width / 2 ? { right: width - cx(hover) + 14 } : { left: cx(hover) + 14 }} />
        )}
      </div>
    </div>
  );
}

function HistoryTip({ day, basis, locale, title, style }: {
  day: WechatHistoryDay; basis: WechatPriceBucket; locale: string; title: string; style: CSSProperties;
}) {
  const { t } = useT();
  const bid = inBasis(day, 'buy', basis);
  const ask = inBasis(day, 'sell', basis);
  const spread = bid && ask ? ask.median - bid.median : null;
  return (
    <div className="wx-hist-tip" style={style} role="status">
      <div className="wx-hist-tip-title">{title}</div>
      <div className="wx-hist-tip-rows">
        {SIDES.map(s => {
          const p = day[s].price;
          const other = p && p.bucket !== basis;
          const range = p && fmtRange(p, locale);
          return (
            <Fragment key={s}>
              <i className={`wx-hist-key wx-hist-${s}`} />
              <b className={!p || other ? 'fp-muted' : undefined}>{p ? fmtPrice(p.median, p.bucket, locale) : '—'}</b>
              <span>{t(s === 'buy' ? 'wxBid' : 'wxAsk')}</span>
              <small>
                {!p
                  ? (day[s].senders ? t(s === 'buy' ? 'wxBuyersN' : 'wxSellersN', { n: day[s].senders }) : t('wxNotQuoted'))
                  : `${other ? `${t(BUCKET_LABEL_KEY[p.bucket])} · ` : ''}${t('wxQuotes', { n: p.n })}${range ? ` · ${range}` : ''}`}
              </small>
            </Fragment>
          );
        })}
      </div>
      {spread !== null && (
        <div className={`wx-hist-tip-foot${spread < 0 ? ' fp-warn' : ''}`}>
          {t(spread < 0 ? 'wxCrossed' : 'wxSpread', { v: fmtPrice(Math.abs(spread), basis, locale) })}
        </div>
      )}
    </div>
  );
}

// ── Side panel ────────────────────────────────────────────────────────────────

function NotesCard({ day }: { day: WechatDay | null }) {
  const { t } = useT();
  const notes = parseNotes(day?.summary ?? null);
  return (
    <section className="card wx-notes" aria-label={t('wxNotes')}>
      <div className="card-head">
        <h2 className="card-title">{t('wxNotes')}</h2>
        <span className="card-sub">{t('wxNotesSub')}</span>
      </div>
      <ul>
        {!day && [0, 1, 2].map(i => <li key={i} aria-hidden><Skeleton width="100%" height={11} /><Skeleton width="70%" height={11} /></li>)}
        {notes.map((n, i) => (
          <li key={i}>{n.map((part, j) => part.bold ? <b key={j}>{part.text}</b> : <Fragment key={j}>{part.text}</Fragment>)}</li>
        ))}
        {day && notes.length === 0 && <li className="fp-muted">{t('wxNoNotes')}</li>}
      </ul>
    </section>
  );
}

function TopCard({ title, sub, rows, side, locale, onPick }: {
  title: string;
  sub: string;
  rows: WechatRow[] | null;
  side: WechatSide;
  locale: string;
  onPick: (row: WechatRow) => void;
}) {
  const { t } = useT();
  const top = useMemo(
    () => (rows ?? []).filter(r => r[side].senders > 0)
      .sort((a, b) => b[side].senders - a[side].senders || traders(b) - traders(a))
      .slice(0, TOP_N),
    [rows, side],
  );
  const most = top[0]?.[side].senders ?? 1;
  return (
    <section className="card wx-top" aria-label={title}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        <span className="card-sub">{sub}</span>
      </div>
      <ol>
        {!rows && [0, 1, 2, 3].map(i => <li key={i} aria-hidden><Skeleton width="100%" height={12} /></li>)}
        {top.map(r => {
          const p = headlinePrice(r[side]);
          return (
            <li key={r.key}>
              <button type="button" onClick={() => onPick(r)} title={t('wxShowOnBoard')}>
                <span className="wx-top-key">{lineKey(r.key, t)}</span>
                <span className="wx-top-n mono">{t(side === 'buy' ? 'wxBuyersN' : 'wxSellersN', { n: r[side].senders })}</span>
                <span className="wx-top-p mono">{p ? fmtPrice(p.median, p.bucket, locale) : '—'}</span>
                <i className={`wx-bar wx-${side}`} style={{ width: `${(r[side].senders / most) * 100}%` }} />
              </button>
            </li>
          );
        })}
        {rows && top.length === 0 && <li className="fp-muted">{t('wxNoLines')}</li>}
      </ol>
    </section>
  );
}

function GroupsCard({ day, locale }: { day: WechatDay | null; locale: string }) {
  const { t } = useT();
  const fmt = new Intl.NumberFormat(locale);
  if (!day) {
    return (
      <section className="card" aria-label={t('wxGroups')} aria-busy>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('wxGroups')}</h2>
            <span className="card-sub"><Skeleton width={140} height={11} /></span>
          </div>
        </div>
        <TableSkeleton rows={8} cols={4} />
      </section>
    );
  }
  const windowStart = Date.parse(day.windowStart);
  return (
    <section className="card" aria-label={t('wxGroups')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('wxGroups')}</h2>
          <span className="card-sub">{t('wxGroupsSub', { active: day.totals.groupsActive, total: day.totals.groupsTotal })}</span>
        </div>
      </div>
      <div className="fp-table-wrap">
        <table className="fp-table">
          <thead>
            <tr>
              <th>{t('wxColGroup')}</th>
              <th className="wx-num">{t('wxColMessages')}</th>
              <th className="wx-num">{t('wxColCandidates')}</th>
              <th>{t('wxColFirstSeen')}</th>
            </tr>
          </thead>
          <tbody>
            {day.groups.map(g => {
              const joined = g.firstSeen !== null && Date.parse(g.firstSeen) >= windowStart;
              return (
                <tr key={g.id} className={g.messages ? undefined : 'wx-quiet'}>
                  <td>{g.name || <span className="mono fp-muted">{g.id}</span>}</td>
                  <td className="wx-num mono">{fmt.format(g.messages)}</td>
                  <td className="wx-num mono">{fmt.format(g.candidates)}</td>
                  <td>
                    {g.firstSeen === null
                      ? <span className="fp-muted">{t('wxNoHistory')}</span>
                      : <>{new Date(g.firstSeen).toLocaleDateString(locale)}{joined && <span className="chip accent" style={{ marginLeft: 6 }}>{t('wxJoined')}</span>}</>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot">
        {t('wxWindow', {
          from: fmtWindow(day.windowStart, locale),
          to: fmtWindow(day.windowEnd, locale),
          age: relTime(day.pushedAt, locale),
        })}
      </div>
    </section>
  );
}
