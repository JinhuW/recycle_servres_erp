import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Skeleton, TableSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { matchWechatDay, navigate, useRoute, wechatDayPath } from '../../lib/route';
import {
  BUCKET_LABEL_KEY,
  BUCKET_TAX_KEY,
  SIGNAL_KEY,
  SIGNAL_TONE,
  UNBRANDED,
  fmtPrice,
  fmtRange,
  groupByBrand,
  hasPrice,
  ladder,
  matchesSearch,
  parseNotes,
  traders,
  wechatApi,
} from '../../lib/wechatMarket';
import '../../styles/facebookPool.css';

// ─── Monitors ▸ WeChat ────────────────────────────────────────────────────────
// The daily memory-module market memtrade reads out of the team's WeChat
// trading groups and pushes here after its 08:00 ET run. One report day at a
// time: what buyers bid and sellers ask for each module, how many traders
// stand behind each price, against the day before, and the posts themselves.

const KINDS: readonly WechatRowKind[] = ['quote', 'spec', 'code'];
const KIND_KEY: Record<WechatRowKind, string> = { quote: 'wxKindQuote', spec: 'wxKindSpec', code: 'wxKindCode' };
const TOP_N = 6;
const HISTORY_DAYS = 30;
// Report days are cut at 08:00 New York time, so their windows read in ET.
const REPORT_TZ = 'America/New_York';

type Loaded = { day: WechatDay; rows: WechatRow[] };

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

  // The top cards rank by traders, priced or not, so a pick the priced-only
  // filter would hide turns the filter off.
  const pickSpec = (row: WechatRow) => {
    setKind('spec');
    setSearch(row.key);
    if (!hasPrice(row)) setPricedOnly(false);
  };

  const day = loaded && loaded !== 'missing' ? loaded.day : null;
  const summary = days?.find(d => d.date === date) ?? null;
  const prevSummary = day?.prevDate ? days?.find(d => d.date === day.prevDate) ?? null : null;

  const head = (
    <div className="page-head">
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div className="page-sub" style={{ marginTop: 0, marginBottom: 2 }}>{t('nav_monitors')} / {t('nav_wechat')}</div>
        <h1 className="page-title">{t('wxTitle')}</h1>
        <div className="page-sub">
          {summary
            ? t('wxWindow', {
                from: fmtWindow(summary.windowStart, locale),
                to: fmtWindow(summary.windowEnd, locale),
                age: relTime(summary.pushedAt, locale),
              })
            : t('wxSub')}
        </div>
      </div>
      {days && days.length > 0 && date && (
        <DayNav days={days} date={date} prev={day?.prevDate ?? null} next={day?.nextDate ?? null} />
      )}
    </div>
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

  return (
    <>
      {head}
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

        {loaded !== 'missing' && <Kpis summary={summary} prev={prevSummary} locale={locale} />}

        {loaded !== 'missing' && (
          <div className="wx-overview">
            <NotesCard day={day} />
            <TopCard title={t('wxMostWanted')} sub={t('wxMostWantedSub')} rows={specRows} side="buy" locale={locale}
              onPick={pickSpec} />
            <TopCard title={t('wxMostOffered')} sub={t('wxMostOfferedSub')} rows={specRows} side="sell" locale={locale}
              onPick={pickSpec} />
          </div>
        )}

        {loaded !== 'missing' && (
          <BoardCard
            kind={kind}
            onKind={k => { setKind(k); setSearch(''); }}
            loaded={loaded}
            search={search}
            onSearch={setSearch}
            pricedOnly={pricedOnly}
            onPricedOnly={setPricedOnly}
            locale={locale}
          />
        )}

        {day && <GroupsCard day={day} locale={locale} />}
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

function Kpis({ summary, prev, locale }: { summary: WechatDaySummary | null; prev: WechatDaySummary | null; locale: string }) {
  const { t } = useT();
  const fmt = new Intl.NumberFormat(locale);
  const delta = (cur: number, before: number | undefined) => {
    if (before === undefined || before === 0) return null;
    const pct = (cur - before) / before;
    if (Math.abs(pct) < 0.005) return <div className="kpi-trend"><span className="fp-muted">{t('wxSameAsPrev')}</span></div>;
    return (
      <div className={`kpi-trend ${pct > 0 ? 'up' : 'down'}`}>
        <Icon name={pct > 0 ? 'arrowUp' : 'arrowDown'} size={11} />
        {(pct > 0 ? '+' : '−') + Math.abs(pct * 100).toFixed(0)}%
        <span className="fp-muted">{t('wxVsPrev')}</span>
      </div>
    );
  };
  if (!summary) {
    return (
      <div className="kpi-grid">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="kpi"><Skeleton width={90} height={12} /><Skeleton width={110} height={26} style={{ marginTop: 10 }} /></div>
        ))}
      </div>
    );
  }
  const s = summary.totals;
  return (
    <div className="kpi-grid">
      <div className="kpi">
        <div className="kpi-label"><span className="wx-dot wx-buy" />{t('wxKpiBuyers')}</div>
        <div className="kpi-value mono">{fmt.format(s.buyers)}</div>
        <div className="kpi-trend"><span className="fp-muted">{t('wxKpiPosts', { n: fmt.format(s.buyPosts) })}</span></div>
        {delta(s.buyers, prev?.totals.buyers)}
      </div>
      <div className="kpi">
        <div className="kpi-label"><span className="wx-dot wx-sell" />{t('wxKpiSellers')}</div>
        <div className="kpi-value mono">{fmt.format(s.sellers)}</div>
        <div className="kpi-trend"><span className="fp-muted">{t('wxKpiPosts', { n: fmt.format(s.sellPosts) })}</span></div>
        {delta(s.sellers, prev?.totals.sellers)}
      </div>
      <div className="kpi">
        <div className="kpi-label">{t('wxKpiPostsLabel')}</div>
        <div className="kpi-value mono">{fmt.format(s.posts)}</div>
        <div className="kpi-trend"><span className="fp-muted">{t('wxKpiCandidates', { n: fmt.format(s.candidates) })}</span></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">{t('wxKpiMessages')}</div>
        <div className="kpi-value mono">{fmt.format(s.messages)}</div>
        <div className="kpi-trend"><span className="fp-muted">{t('wxKpiGroups', { active: s.groupsActive, total: s.groupsTotal })}</span></div>
      </div>
    </div>
  );
}

// ── The board ─────────────────────────────────────────────────────────────────

const COLS = 7;

function BoardCard({ kind, onKind, loaded, search, onSearch, pricedOnly, onPricedOnly, locale }: {
  kind: WechatRowKind;
  onKind: (k: WechatRowKind) => void;
  loaded: Loaded | 'missing' | null;
  search: string;
  onSearch: (s: string) => void;
  pricedOnly: boolean;
  onPricedOnly: (v: boolean) => void;
  locale: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const data = loaded && loaded !== 'missing' ? loaded : null;

  useEffect(() => { setOpen(null); }, [kind, data?.day.date]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter(r => (!pricedOnly || hasPrice(r)) && matchesSearch(r, search)),
    [data, pricedOnly, search],
  );
  const groups = useMemo(
    () => (kind === 'quote' ? groupByBrand(rows) : [{ brand: null, rows }]),
    [kind, rows],
  );

  return (
    <section className="card wx-board" aria-label={t('wxBoard')}>
      <div className="fp-toolbar">
        <h2>{t('wxBoard')}</h2>
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
        <div className="toolbar-search wx-search">
          <Icon name="search" size={13} />
          <input className="input" placeholder={t('wxSearch')} aria-label={t('wxSearch')}
            value={search} onChange={e => onSearch(e.target.value)} />
        </div>
        <span className="ff-summary">
          {data ? t('wxBoardCount', { shown: rows.length, n: data.rows.length }) : <Skeleton width={90} height={11} />}
        </span>
      </div>

      {!data ? (
        <TableSkeleton rows={10} cols={6} />
      ) : (
        <div className="fp-table-wrap">
          <table className="fp-table wx-table">
            <thead>
              <tr>
                <th>{t(kind === 'quote' ? 'wxColModule' : kind === 'spec' ? 'wxColSpec' : 'wxColCode')}</th>
                <th className="wx-num" title={t('wxColBidHint')}>{t('wxColBid')}</th>
                <th className="wx-num" title={t('wxColAskHint')}>{t('wxColAsk')}</th>
                <th title={t('wxColSpreadHint')}>{t('wxColSpread')}</th>
                <th className="wx-num" title={t('wxColTradersHint')}>{t('wxColTraders')}</th>
                <th>{t('wxColSignal')}</th>
                <th className="wx-num" title={t('wxColChangeHint', { date: data.day.prevDate ?? '—' })}>{t('wxColChange')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g.brand ?? '·'}>
                  {kind === 'quote' && (
                    <tr className="wx-brand">
                      <td colSpan={COLS}>
                        {g.brand === UNBRANDED || !g.brand ? t('wxUnbranded') : g.brand}
                        <span>{t('wxLines', { n: g.rows.length })}</span>
                      </td>
                    </tr>
                  )}
                  {g.rows.map(r => {
                    const isOpen = open === r.key;
                    return (
                      <Fragment key={r.key}>
                        <BoardRow row={r} open={isOpen} locale={locale} onToggle={() => setOpen(isOpen ? null : r.key)} />
                        {isOpen && (
                          <tr className="wx-detail-row">
                            <td colSpan={COLS}><LineDetail date={data.day.date} row={r} locale={locale} /></td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={COLS} className="fp-empty">{data.rows.length ? t('wxNoMatch') : t('wxNoLines')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="fp-table-foot">{t('wxBoardFoot')}</div>
    </section>
  );
}

function LineName({ row }: { row: WechatRow }) {
  const { t } = useT();
  const spec = [row.ddr, row.ranks[0], row.formFactor === 'pc' ? t('wxFormPc') : null, row.partNumbers[0]].filter(Boolean);
  return (
    <span className="fp-holder">
      {row.kind === 'quote' ? (
        <span className="wx-line">
          <b>{row.capacityGb}G</b>
          <span>{row.speed ?? '—'}</span>
          {row.code ? <span className="wx-code">{row.code}</span> : <span className="fp-muted">{t('wxAnyCode')}</span>}
        </span>
      ) : (
        <span className="wx-line"><b>{lineKey(row.key, t)}</b></span>
      )}
      {spec.length > 0 && <small className="mono">{spec.join(' · ')}</small>}
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

function BoardRow({ row, open, locale, onToggle }: { row: WechatRow; open: boolean; locale: string; onToggle: () => void }) {
  const { t } = useT();
  const signal = row.signal ? SIGNAL_KEY[row.signal] : undefined;
  return (
    <tr className={`wx-row${open ? ' wx-open' : ''}`} onClick={onToggle} aria-expanded={open}
      tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
      <td><LineName row={row} /></td>
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

function HistoryChart({ history, locale }: { history: WechatHistoryDay[] | null; locale: string }) {
  const { t } = useT();
  if (!history) return <Skeleton width="100%" height={96} />;
  const shown = chartBasis(history);
  const series = (s: WechatSide) =>
    history.map(h => (h[s].price && h[s].price.bucket === shown ? h[s].price.median : null));
  const bid = series('buy');
  const ask = series('sell');
  const values = [...bid, ...ask].filter((v): v is number => v !== null);
  if (values.length < 2 || !shown) return <p className="fp-muted wx-chart-empty">{t('wxHistoryThin')}</p>;
  const W = 320;
  const H = 96;
  const pad = 6;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => pad + (history.length === 1 ? 0 : (i / (history.length - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - pad * 2);
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const dots = (vals: (number | null)[], s: WechatSide) => vals.map((v, i) => v === null ? null : (
    <circle key={`${s}${i}`} className={`wx-pt-${s}`} cx={x(i)} cy={y(v)} r={2.2}>
      <title>{`${history[i]!.date} · ${t(s === 'buy' ? 'wxBid' : 'wxAsk')} ${fmtPrice(v, shown, locale)} ${t(BUCKET_LABEL_KEY[shown])}`}</title>
    </circle>
  ));
  return (
    <div className="wx-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={t('wxHistoryAria', { from: history[0]!.date, to: history.at(-1)!.date })}>
        <path d={path(bid)} className="wx-line-buy" />
        <path d={path(ask)} className="wx-line-sell" />
        {dots(bid, 'buy')}
        {dots(ask, 'sell')}
      </svg>
      <div className="wx-chart-axis">
        <span>{history[0]!.date.slice(5)}</span>
        <span className="mono">
          {fmtPrice(lo, shown, locale)}–{fmtPrice(hi, shown, locale)} {t(BUCKET_LABEL_KEY[shown])}
        </span>
        <span>{history.at(-1)!.date.slice(5)}</span>
      </div>
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

function GroupsCard({ day, locale }: { day: WechatDay; locale: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const fmt = new Intl.NumberFormat(locale);
  const windowStart = Date.parse(day.windowStart);
  return (
    <section className="card" aria-label={t('wxGroups')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('wxGroups')}</h2>
          <span className="card-sub">{t('wxGroupsSub', { active: day.totals.groupsActive, total: day.totals.groupsTotal })}</span>
        </div>
        <button className="btn sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
          {t(open ? 'wxGroupsHide' : 'wxGroupsShow')}
        </button>
      </div>
      {open && (
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
      )}
    </section>
  );
}
