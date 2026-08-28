import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { ListSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, fmtDateShort, fmtUSD, relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { navigate } from '../../lib/route';

// Manager-only reconciliation of Mercury/PayPal transactions against POs.
// The list serves logical payments: a PayPal charge and its Mercury
// settlement arrive as one row (source 'paired') with both legs inside. The
// page's job is draining the unlinked queue, so that filter is the default.

type Leg = {
  id: string;
  source: string;
  externalId: string;
  postedAt: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypalTxnId: string | null;
};

type MatchConfidence = 'high' | 'medium' | 'low';

type MatchSummary = {
  // The whole pool. `shown` is what survived the server's cap — they differ
  // when a round-number payment matches more POs than the list can carry.
  count: number;
  shown: number;
  confidence: MatchConfidence;
  best: {
    id: string;
    totalCost: number | null;
    createdAt: string;
    dayGap: number | null;
    createdByName: string | null;
  };
};

type PaymentRow = Omit<Leg, 'source'> & {
  source: 'mercury' | 'paypal' | 'paired';
  legs: Leg[];
  // Server-ranked PO candidates. Present only on rows still in the queue —
  // a linked, ignored or transfer row carries null.
  match: MatchSummary | null;
  orderId: string | null;
  linkKind: 'payment' | 'refund' | null;
  linkAuto: boolean;
  linkedAt: string | null;
  linkedByName: string | null;
  ignored: boolean;
  category: 'external' | 'transfer';
};

type Feed = { rows: PaymentRow[]; nextCursor: string | null };

type Stats = {
  unlinked: { count: number; amount: number };
  // Added in v1.99.0. The SPA and the API deploy on independent pipelines, so
  // a freshly deployed page runs for minutes against a backend that has never
  // heard of this key — optional here so every read has to survive it.
  suggested?: { count: number };
  linked: { count: number };
  refunds: { count: number; amount: number };
  ignored: { count: number };
  transfers: { count: number };
  sources: { source: string; lastSyncedAt: string | null }[];
};

type SyncResult = {
  perSource: Partial<Record<string, { inserted: number; error?: string }>>;
  notConfigured: string[];
};

type Suggestion = {
  id: string;
  totalCost: number | null;
  createdAt: string;
  lifecycle: string;
  createdByName: string | null;
  reason: 'txn' | 'exact' | 'near' | 'search';
  dayGap: number | null;
  amountDiff: number | null;
  confidence: MatchConfidence;
  linkedTotal: number;
  sellerName: string | null;
  affinity: boolean;
  covered: boolean;
};

type StatusFilter = 'all' | 'unlinked' | 'linked' | 'ignored' | 'transfer';

type Direction = 'all' | 'out' | 'in';

// The queue is money the company paid out; incoming refunds are a side view.
const DEFAULT_DIRECTION: Direction = 'out';

// Union of the mutation responses; only mark/unmark-transfer read past `ok`.
type ActResult = {
  ok: boolean;
  ruleCounterparty?: string | null;
  alsoMarked?: number;
  ruleRemoved?: boolean;
};

// Vertical padding is zeroed because the 32px height is smaller than
// `.select`'s own 9px-padded box: left alone it clips descenders ("Money out"
// reads "Monev out").
const FILTER_SELECT: CSSProperties = {
  width: 'auto', minWidth: 132, height: 32, fontSize: 12.5,
  paddingTop: 0, paddingBottom: 0,
};

// PO picker box: 320 wide, and roughly its search field plus the capped list —
// only used to decide whether it still fits below the row it belongs to.
const PICKER_W = 320;
const PICKER_H = 312;
const GAP = 4;

const SOURCE_LABEL: Record<PaymentRow['source'], string> = {
  mercury: 'Mercury',
  paypal: 'PayPal',
  paired: 'PayPal + Mercury',
};

// Signed money: the sign carries meaning here (out vs back in), so it is
// always rendered explicitly instead of fmtUSD's "$-1,240.00".
function fmtSigned(n: number, locale: string): string {
  return (n < 0 ? '−' : '+') + fmtUSD(Math.abs(n), locale);
}

type T = (k: string, vars?: Record<string, string | number>) => string;

// How far the PO sits from the payment date — the tie-breaker a manager reads
// first, so it is spelled out rather than shown as a raw number.
function gapLabel(dayGap: number | null, t: T): string {
  if (dayGap === null) return '';
  return dayGap === 0 ? t('payMatchSameDay') : t('payMatchDayGap', { n: dayGap });
}

const CONFIDENCE_TONE: Record<MatchConfidence, string> = {
  high: 'pos', medium: 'warn', low: 'muted',
};

const REASON_TKEY: Record<Suggestion['reason'], string | null> = {
  txn: 'payReasonTxn', exact: 'payReasonExact', near: 'payReasonNear', search: null,
};

export function DesktopPayments({ onToast }: { onToast: (msg: string) => void }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [status, setStatus] = usePersisted<StatusFilter>('desktop.payments.status', 'unlinked');
  const [source, setSource] = usePersisted('desktop.payments.source', 'all');
  const [direction, setDirection] = usePersisted<Direction>('desktop.payments.direction', DEFAULT_DIRECTION);
  const [q, setQ] = usePersisted('desktop.payments.q', '');
  const [hasMatch, setHasMatch] = usePersisted('desktop.payments.hasMatch', false);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const reqId = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const params = useCallback((cursor?: string) => {
    const p = new URLSearchParams();
    if (status !== 'all') p.set('status', status);
    if (source !== 'all') p.set('source', source);
    if (direction !== 'all') p.set('direction', direction);
    if (q.trim()) p.set('q', q.trim());
    if (hasMatch) p.set('hasMatch', '1');
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  }, [status, source, direction, q, hasMatch]);

  const refreshStats = useCallback(() => {
    api.get<Stats>('/api/bank-transactions/stats').then(setStats).catch(handleFetchError);
  }, []);

  const reload = useCallback(() => {
    const id = ++reqId.current;
    api.get<Feed>(`/api/bank-transactions?${params()}`)
      .then(r => { if (id === reqId.current) setFeed(r); })
      .catch(handleFetchError);
  }, [params]);

  useEffect(() => { setFeed(null); reload(); }, [reload]);
  useEffect(() => { refreshStats(); }, [refreshStats]);

  const loadMore = useCallback(() => {
    if (!feed?.nextCursor || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    api.get<Feed>(`/api/bank-transactions?${params(feed.nextCursor)}`)
      // A filter change mid-flight bumps reqId and resets the feed; dropping
      // the response here stops an older page appending under new filters.
      .then(r => { if (id === reqId.current) setFeed(prev => prev && ({
        ...r, rows: [...prev.rows, ...r.rows],
      })); })
      .catch(handleFetchError)
      .finally(() => setLoadingMore(false));
  }, [feed?.nextCursor, loadingMore, params]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !feed?.nextCursor) return;
    const io = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, feed?.nextCursor]);

  // Mutations refetch both the feed and the tiles — the row's group may span
  // legs the current page doesn't show, so local patching would drift.
  const afterMutation = useCallback(() => { reload(); refreshStats(); }, [reload, refreshStats]);

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await api.post<SyncResult>('/api/bank-transactions/sync', {});
      const inserted = Object.values(r.perSource).reduce((sum, s) => sum + (s?.inserted ?? 0), 0);
      const failed = Object.entries(r.perSource).filter(([, s]) => s?.error).map(([k]) => k);
      if (failed.length) onToast(t('paySyncFailed', { source: failed.join(', ') }));
      else if (r.notConfigured.length === 2) onToast(t('payNotConfigured'));
      else onToast(t('paySyncDone', { n: inserted }));
      afterMutation();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSyncing(false);
    }
  };

  const act = async (path: string, body?: unknown): Promise<ActResult | null> => {
    try {
      const r = await api.post<ActResult>(`/api/bank-transactions/${path}`, body ?? {});
      afterMutation();
      return r;
    } catch (e) {
      handleFetchError(e);
      return null;
    }
  };

  const lastSynced = useMemo(() => {
    const times = (stats?.sources ?? [])
      .map(s => s.lastSyncedAt).filter((x): x is string => !!x)
      .map(x => new Date(x).getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }, [stats]);

  type TileKey = StatusFilter | 'refunds' | 'suggested';
  const tiles: { key: TileKey; label: string; count: number; sub: string; tone: string }[] = stats ? [
    { key: 'unlinked', label: t('payTileUnlinked'), count: stats.unlinked.count, sub: fmtUSD(stats.unlinked.amount, locale), tone: 'warn' },
    { key: 'suggested', label: t('payTileSuggested'), count: stats.suggested?.count ?? 0, sub: t('payTileSuggestedSub'), tone: 'accent' },
    { key: 'linked', label: t('payTileLinked'), count: stats.linked.count, sub: t('payTileLinkedSub'), tone: 'pos' },
    { key: 'refunds', label: t('payTileRefunds'), count: stats.refunds.count, sub: fmtUSD(stats.refunds.amount, locale), tone: 'cool' },
    { key: 'transfer', label: t('payTileTransfers'), count: stats.transfers.count, sub: t('payTileTransfersSub'), tone: 'info' },
    { key: 'ignored', label: t('payTileIgnored'), count: stats.ignored.count, sub: t('payTileIgnoredSub'), tone: 'muted' },
  ] : [];

  // Every tile but Refunds sits at the page's default direction, so that — not
  // 'all' — is what counts as "no direction lens" here.
  const tileActive = (key: TileKey) =>
    key === 'refunds' ? status === 'linked' && direction === 'in'
    : key === 'suggested' ? status === 'unlinked' && hasMatch
    // Unlinked and Suggested are nested, so only the narrower one lights up.
    : status === key && direction === DEFAULT_DIRECTION && !hasMatch;

  const clickTile = (key: TileKey) => {
    if (tileActive(key)) { setStatus('all'); setDirection(DEFAULT_DIRECTION); setHasMatch(false); return; }
    if (key === 'refunds') { setStatus('linked'); setDirection('in'); setHasMatch(false); return; }
    if (key === 'suggested') { setStatus('unlinked'); setDirection(DEFAULT_DIRECTION); setHasMatch(true); return; }
    setStatus(key);
    setDirection(DEFAULT_DIRECTION);
    setHasMatch(false);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('payTitle')}</h1>
          <div className="page-sub">{t('paySub')}</div>
        </div>
        <div className="page-actions" style={{ alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {lastSynced ? t('payLastSynced', { when: relTime(lastSynced, locale) }) : t('payNeverSynced')}
          </span>
          <button type="button" className="btn primary" onClick={syncNow} disabled={syncing}>
            <Icon name="rotate" size={13} />
            {syncing ? t('paySyncing') : t('paySyncNow')}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {tiles.map(tile => (
          <button
            key={tile.key}
            type="button"
            className={'so-stat' + (tileActive(tile.key) ? ' active' : '')}
            aria-pressed={tileActive(tile.key)}
            onClick={() => clickTile(tile.key)}
          >
            <div className="so-stat-head">
              <span className={'chip dot ' + tile.tone} style={{ fontSize: 10.5 }}>{tile.label}</span>
            </div>
            <div className="so-stat-num">{tile.count}</div>
            <div className="so-stat-sub">{tile.sub}</div>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="seg" role="tablist">
            {(['all', 'unlinked', 'linked', 'transfer', 'ignored'] as const).map(s => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                className={status === s ? 'active' : ''}
                onClick={() => { setStatus(s); setHasMatch(false); }}
              >
                {t(`payFilter_${s}`)}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* .select is width:100% in tokens.css — left alone each dropdown
                claims a full row and the strip stacks under the tabs. */}
            <select className="select" value={source} onChange={e => setSource(e.target.value)} style={FILTER_SELECT}>
              <option value="all">{t('paySourceAll')}</option>
              <option value="mercury">Mercury</option>
              <option value="paypal">PayPal</option>
            </select>
            <select
              className="select"
              value={direction}
              onChange={e => setDirection(e.target.value as Direction)}
              style={FILTER_SELECT}
            >
              <option value="all">{t('payDirAll')}</option>
              <option value="out">{t('payDirOut')}</option>
              <option value="in">{t('payDirIn')}</option>
            </select>
            <button
              type="button"
              className="btn sm"
              aria-pressed={hasMatch}
              onClick={() => setHasMatch(v => !v)}
              style={{
                height: 32, fontSize: 12.5,
                ...(hasMatch
                  ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent-strong)' }
                  : { color: 'var(--fg-muted)' }),
              }}
            >
              <Icon name="zap" size={12} />
              {t('payFilterHasMatch')}
            </button>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--fg-subtle)',
              }} />
              <input
                className="input"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={t('paySearch')}
                style={{ paddingLeft: 30, paddingTop: 0, paddingBottom: 0, height: 32, fontSize: 12.5, width: 230 }}
              />
            </div>
          </div>
        </div>

        {!feed ? (
          <ListSkeleton rows={6} />
        ) : feed.rows.length === 0 ? (
          <div style={{ padding: '36px 16px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {/* An empty money-out queue IS the drained queue; only the
                money-in lens makes "nothing left to reconcile" a lie. */}
            {status === 'unlinked' && direction !== 'in' ? t('payEmptyUnlinked') : t('payEmpty')}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th>{t('payColDate')}</th>
                  <th>{t('payColSource')}</th>
                  <th>{t('payColCounterparty')}</th>
                  <th className="num">{t('payColAmount')}</th>
                  <th>{t('payColStatus')}</th>
                  <th>{t('payColOrder')}</th>
                </tr>
              </thead>
              <tbody>
                {feed.rows.map(row => (
                  <PaymentTr
                    key={row.id}
                    row={row}
                    open={openId === row.id}
                    onToggle={() => setOpenId(openId === row.id ? null : row.id)}
                    locale={locale}
                    act={act}
                    onToast={onToast}
                  />
                ))}
              </tbody>
            </table>
            {feed.nextCursor && (
              <div className="ac-more-row" aria-live="polite">
                {loadingMore ? t('payMoreLoading') : t('payMoreScroll')}
              </div>
            )}
            <div ref={sentinelRef} className="ac-sentinel" aria-hidden="true" />
          </div>
        )}
      </div>
    </>
  );
}

function StatusChip({ row, t }: { row: PaymentRow; t: (k: string) => string }) {
  if (row.ignored) return <span className="chip muted">{t('payStatusIgnored')}</span>;
  if (!row.orderId && row.category === 'transfer') {
    return <span className="chip info">{t('payStatusTransfer')}</span>;
  }
  if (!row.orderId) return <span className="chip dot warn">{t('payStatusUnlinked')}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <span className={'chip dot ' + (row.linkKind === 'refund' ? 'cool' : 'pos')}>
        {t(row.linkKind === 'refund' ? 'payKindRefund' : 'payKindPayment')}
      </span>
      {row.linkAuto && <span className="chip info" style={{ fontSize: 10.5 }}>{t('payAuto')}</span>}
    </span>
  );
}

function PaymentTr({ row, open, onToggle, locale, act, onToast }: {
  row: PaymentRow;
  open: boolean;
  onToggle: () => void;
  locale: string;
  act: (path: string, body?: unknown) => Promise<ActResult | null>;
  onToast: (msg: string) => void;
}) {
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  // Dismissal is per page load on purpose: suggestions are read-time only, so
  // persisting a "not it" would be the same mistake as persisting a match.
  const [dismissed, setDismissed] = useState(false);
  const actionsRef = useRef<HTMLSpanElement>(null);

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const link = async (orderId: string) => {
    if (await act(`${row.id}/link`, { orderId })) {
      onToast(t('payLinkedToast', { id: orderId }));
      setPicking(false);
    }
  };

  // One-click only when the server found exactly one candidate and is sure of
  // it; anything else has to be looked at before it is linked.
  const likely = !dismissed && row.match?.count === 1 && row.match.confidence === 'high'
    ? row.match : null;
  const ambiguous = !likely && (row.match?.count ?? 0) > 0 ? row.match : null;

  return (
    <>
      <tr className="row-hover" style={{ cursor: 'pointer' }} onClick={onToggle}>
        <td style={{ paddingRight: 0 }}>
          <Icon
            name="chevronRight" size={13}
            style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms', color: 'var(--fg-subtle)' }}
          />
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>{fmtDateShort(row.postedAt, locale)}</td>
        <td>
          <span className={'chip ' + (row.source === 'paired' ? 'accent' : row.source === 'mercury' ? 'info' : '')} style={{ fontSize: 11 }}>
            {SOURCE_LABEL[row.source]}
          </span>
        </td>
        <td>
          <span style={{ fontWeight: 500 }}>{row.counterparty ?? '—'}</span>
          {row.description && (
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{row.description}</span>
          )}
        </td>
        <td className="num mono" style={{ color: row.amount > 0 ? 'var(--pos)' : undefined, whiteSpace: 'nowrap' }}>
          {fmtSigned(row.amount, locale)}
        </td>
        <td><StatusChip row={row} t={t} /></td>
        <td style={{ whiteSpace: 'nowrap', position: 'relative' }}>
          {row.orderId ? (
            <button className="ship-po-pill" onClick={(e) => { stop(e); navigate(`/purchase-orders/${row.orderId}`); }}>
              {row.orderId}
            </button>
          ) : row.ignored ? (
            <button type="button" className="btn sm ghost" onClick={(e) => { stop(e); void act(`${row.id}/unignore`); }}>
              {t('payUnignore')}
            </button>
          ) : (
            // Badge and buttons share one line: stacked, a row carrying a match
            // badge stood a line taller than its neighbours and the table stepped.
            <span
              ref={actionsRef}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
              onClick={stop}
            >
              {likely && (
                <span className="chip dot pos" style={{ fontSize: 10.5 }}>
                  {t('payMatchLikely', {
                    id: likely.best.id,
                    when: gapLabel(likely.best.dayGap, t),
                  })}
                </span>
              )}
              {ambiguous && (
                <button
                  type="button"
                  className="chip warn"
                  style={{ fontSize: 10.5, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                  onClick={onToggle}
                >
                  {row.match!.count === 1
                    ? t('payMatchCountOne')
                    : t('payMatchCount', { n: row.match!.count })}
                </button>
              )}
              {likely ? (
                <>
                  <button type="button" className="btn sm primary" onClick={() => void link(likely.best.id)}>
                    {t('payLink')}
                  </button>
                  <button
                    type="button" className="btn sm ghost"
                    onClick={() => { setDismissed(true); setPicking(true); }}
                  >
                    {t('payMatchNotIt')}
                  </button>
                </>
              ) : (
                <button type="button" className="btn sm" onClick={() => setPicking(p => !p)}>
                  {t('payLink')}
                </button>
              )}
              <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/ignore`)}>
                {t('payIgnore')}
              </button>
            </span>
          )}
          {picking && !row.orderId && (
            <PoPicker
              txnId={row.id}
              anchor={actionsRef}
              onPick={link}
              onClose={() => setPicking(false)}
              locale={locale}
            />
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--bg-soft)', padding: '10px 16px 12px' }}>
            <ExpandedDetail row={row} locale={locale} act={act} onToast={onToast} onLink={link} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedDetail({ row, locale, act, onToast, onLink }: {
  row: PaymentRow;
  locale: string;
  act: (path: string, body?: unknown) => Promise<ActResult | null>;
  onToast: (msg: string) => void;
  onLink: (orderId: string) => void;
}) {
  const { t } = useT();
  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 12.5 }}>
      {row.match && !row.orderId && !row.ignored && (
        <MatchList txnId={row.id} locale={locale} onLink={onLink} />
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        {row.legs.map(leg => (
          <div key={leg.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className={'chip ' + (leg.source === 'mercury' ? 'info' : '')} style={{ fontSize: 10.5 }}>
              {leg.source === 'mercury' ? 'Mercury' : 'PayPal'}
            </span>
            <span className="mono muted">{fmtDate(leg.postedAt, locale)}</span>
            <span className="mono">{fmtSigned(leg.amount, locale)}</span>
            <span className="muted">{t('payTxnId')}: <span className="mono">{leg.paypalTxnId ?? leg.externalId}</span></span>
            {leg.description && <span className="muted">{leg.description}</span>}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {row.orderId && (
          <>
            <span className="muted">
              {row.linkAuto
                ? t('payLinkedAuto')
                : t('payLinkedBy', { name: row.linkedByName ?? '—' })}
              {row.linkedAt ? ` · ${fmtDate(row.linkedAt, locale)}` : ''}
            </span>
            <button
              type="button" className="btn sm ghost"
              onClick={() => { void act(`${row.id}/unlink`).then(ok => { if (ok) onToast(t('payUnlinkedToast')); }); }}
            >
              {t('payUnlink')}
            </button>
          </>
        )}
        {row.source === 'paired' && (
          <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/unpair`)}>
            {t('payUnpair')}
          </button>
        )}
        {!row.orderId && (
          row.category === 'transfer' ? (
            <button
              type="button" className="btn sm ghost"
              onClick={() => void act(`${row.id}/unmark-transfer`).then(r => {
                if (r?.ruleRemoved && row.counterparty) {
                  onToast(t('payTransferRuleRemovedToast', { name: row.counterparty }));
                }
              })}
            >
              {t('payNotTransfer')}
            </button>
          ) : !row.ignored && (
            <button
              type="button" className="btn sm ghost"
              onClick={() => void act(`${row.id}/mark-transfer`).then(r => {
                if (r?.ruleCounterparty) {
                  onToast(t('payTransferRuleToast', { name: r.ruleCounterparty, n: r.alsoMarked ?? 0 }));
                }
              })}
            >
              {t('payMarkTransfer')}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// The ranked candidate list behind the row's "{n} matches" badge. Fetched when
// the row opens rather than with the feed: the badge only needs the count, and
// most rows are never expanded.
function MatchList({ txnId, locale, onLink }: {
  txnId: string;
  locale: string;
  onLink: (orderId: string) => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let live = true;
    api.get<{ suggestions: Suggestion[]; total: number }>(`/api/bank-transactions/${txnId}/suggestions`)
      .then(r => { if (live) { setRows(r.suggestions); setTotal(r.total); } })
      .catch(e => { if (live) setRows([]); handleFetchError(e); });
    return () => { live = false; };
  }, [txnId]);

  if (rows === null) return <div className="muted">{t('payMoreLoading')}</div>;
  if (rows.length === 0) return null;

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="muted" style={{ fontWeight: 600 }}>
        {t('payMatchSuggested')}
        {total > rows.length && (
          <span style={{ fontWeight: 400, marginLeft: 6 }}>
            ({t('payMatchShowing', { shown: rows.length, total })})
          </span>
        )}
      </div>
      {rows.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '6px 8px', borderRadius: 8,
            background: 'var(--bg-elev)', border: '1px solid var(--border)',
          }}
        >
          <span className="mono" style={{ fontWeight: 600 }}>{s.id}</span>
          <span className="mono">{fmtUSD(s.totalCost, locale)}</span>
          <span className="muted">{fmtDateShort(s.createdAt, locale)}</span>
          {s.dayGap !== null && (
            <span className={'chip ' + CONFIDENCE_TONE[s.confidence]} style={{ fontSize: 10.5 }}>
              {gapLabel(s.dayGap, t)}
            </span>
          )}
          {/* Ranked first overall, which is not always the closest in time —
              a seller-name or txn-id hit outweighs the date gap. */}
          {i === 0 && rows.length > 1 && (
            <span className="chip info" style={{ fontSize: 10.5 }}>{t('payMatchBest')}</span>
          )}
          {s.createdByName && <span className="muted">{s.createdByName}</span>}
          {s.reason === 'near' && s.amountDiff !== null && (
            <span className="chip muted" style={{ fontSize: 10.5 }}>
              {t('payMatchAmountOff', { amt: fmtUSD(Math.abs(s.amountDiff), locale) })}
            </span>
          )}
          {s.reason === 'txn' && (
            <span className="chip accent" style={{ fontSize: 10.5 }}>{t('payReasonTxn')}</span>
          )}
          {s.sellerName && (
            <span className="chip pos" style={{ fontSize: 10.5 }}>
              {t('payMatchSeller', { name: s.sellerName })}
            </span>
          )}
          {s.affinity && !s.sellerName && (
            <span className="chip info" style={{ fontSize: 10.5 }}>{t('payMatchAffinity')}</span>
          )}
          {s.covered && (
            <span className="chip warn" style={{ fontSize: 10.5 }}>
              {t('payMatchAlreadyPaid', { amt: fmtUSD(Math.max(0, s.linkedTotal), locale) })}
            </span>
          )}
          <button
            type="button" className="btn sm" style={{ marginLeft: 'auto' }}
            onClick={() => onLink(s.id)}
          >
            {t('payLink')}
          </button>
        </div>
      ))}
    </div>
  );
}

// Searchable PO dropdown (CustomerPicker shape). Opens with the server's
// ranked suggestions — txn-id match first, then same-amount orders — and
// switches to free search as the manager types.
function PoPicker({ txnId, anchor, onPick, onClose, locale }: {
  txnId: string;
  anchor: React.RefObject<HTMLElement | null>;
  onPick: (orderId: string) => void;
  onClose: () => void;
  locale: string;
}) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const reqId = useRef(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Fixed, not absolute: the row lives inside `.table-scroll`, whose
  // `overflow-y: hidden` sheared the dropdown off at the table's bottom edge.
  // `overflow-y: visible` can't fix it — next to `overflow-x: auto` it computes
  // back to `auto` — so the popover has to leave the scroll container instead.
  useLayoutEffect(() => {
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const room = window.innerHeight - r.bottom;
      setPos({
        top: room < PICKER_H + GAP ? Math.max(GAP, r.top - PICKER_H - GAP) : r.bottom + GAP,
        left: Math.max(GAP, Math.min(r.right - PICKER_W, window.innerWidth - PICKER_W - GAP)),
      });
    };
    place();
    // Capture phase so the inner table scroller is heard, not just the page.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  useEffect(() => {
    const id = ++reqId.current;
    const timer = setTimeout(() => {
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      api.get<{ suggestions: Suggestion[] }>(`/api/bank-transactions/${txnId}/suggestions${qs}`)
        .then(r => { if (id === reqId.current) setRows(r.suggestions); })
        .catch(handleFetchError);
    }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [txnId, query]);

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, width: PICKER_W,
        visibility: pos ? 'visible' : 'hidden',
        background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 12px 28px rgba(15,23,42,0.14)', zIndex: 90, overflow: 'hidden',
        cursor: 'default', textAlign: 'left',
      }}
    >
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)', position: 'relative' }}>
        <Icon name="search" size={13} style={{
          position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--fg-subtle)',
        }} />
        <input
          autoFocus
          className="input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('payPickSearch')}
          style={{ paddingLeft: 30, height: 32, fontSize: 13 }}
        />
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {rows === null ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payMoreLoading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payPickNone')}</div>
        ) : rows.map(s => {
          const reasonKey = REASON_TKEY[s.reason];
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              style={{
                width: '100%', textAlign: 'left', padding: '9px 12px',
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <span className="mono" style={{ fontWeight: 600 }}>{s.id}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {fmtUSD(s.totalCost, locale)} · {fmtDateShort(s.createdAt, locale)}
                {s.dayGap !== null ? ` · ${gapLabel(s.dayGap, t)}` : ''}
                {s.createdByName ? ` · ${s.createdByName}` : ''}
              </span>
              {reasonKey && (
                <span className="chip info" style={{ marginLeft: 'auto', fontSize: 10.5 }}>{t(reasonKey)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
