import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { ListSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, fmtDateShort, fmtMoney, fmtUSD, relTime } from '../../lib/format';
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
  settleStatus?: SettleStatus;
};

// Did the money move? 'failed' never will, 'reversed' did and came back —
// both are records rather than tasks, and the backend keeps them out of the
// queue, the tiles and every action. 'pending' is a real payment that has not
// posted yet: it groups, links and counts like a settled one, badged.
type SettleStatus = 'settled' | 'pending' | 'failed' | 'reversed';

const SETTLE_CHIP: Record<Exclude<SettleStatus, 'settled'>, { tone: string; key: string }> = {
  pending: { tone: 'warn', key: 'paySettlePending' },
  failed: { tone: 'muted', key: 'paySettleFailed' },
  reversed: { tone: 'neg', key: 'paySettleReversed' },
};

// A row from a backend that predates v1.127.0 says nothing, and everything it
// could have sent had settled — that was the only kind that was ingested.
const settleOf = (r: { settleStatus?: SettleStatus }): SettleStatus => r.settleStatus ?? 'settled';
// No money moved, so there is nothing to link, group, own or file.
const settleDead = (r: { settleStatus?: SettleStatus }) =>
  settleOf(r) === 'failed' || settleOf(r) === 'reversed';
const settleChipOf = (r: { settleStatus?: SettleStatus }) => {
  const s = settleOf(r);
  return s === 'settled' ? null : SETTLE_CHIP[s];
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

// A leg this one can be grouped with into a single logical payment. The server
// sends it only when it is certain on both sides; anything less certain is left
// to the picker.
type PairCandidate = {
  id: string;
  source: string;
  postedAt: string;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypalTxnId: string | null;
  dayGap: number;
};

// One dated thing that happened to a case. `code` is PayPal's own enum value,
// translated here rather than on the wire.
type DisputeEvent = {
  at: string;
  kind: 'opened' | 'adjudication' | 'money' | 'outcome';
  code: string | null;
  stage: string | null;
  party: string | null;
  amount: number | null;
};

type Dispute = {
  disputeId: string;
  reason: string | null;
  status: string | null;
  disputeState: string | null;
  lifeCycleStage: string | null;
  channel: string | null;
  amount: number | null;
  currency: string | null;
  outcomeCode: string | null;
  refundedAmount: number | null;
  openedAt: string | null;
  updatedAt: string | null;
  buyerResponseDueAt: string | null;
  sellerResponseDueAt: string | null;
  timeline: DisputeEvent[];
};

// PayPal's own ladder. A case enters at INQUIRY and only climbs.
const DISPUTE_STAGES = ['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'] as const;

// The missing app permission is one cause of a dispute-sync failure, and it is
// the only one an admin can act on — but a timeout or a 502 stored the same way
// would have sent them to developer.paypal.com to fix a setting that was already
// correct. Matched against the shape the provider stores
// ("… failed: HTTP 403 {json}"), because a bare /403/ hits any request id
// carrying those digits.
const DISPUTE_FORBIDDEN = /HTTP 403|NOT_AUTHORIZED/;

// A case still in play is red; once PayPal has decided, it is history and reads
// as history.
const disputeLive = (d: Dispute) => d.status !== 'RESOLVED';

// PayPal's enums, mapped to keys once. Covers the closed sets a purchaser's
// case actually moves through — stage, status, reason, adjudication type, fund
// movement, outcome. A code with no entry renders as itself rather than blank:
// the adjudication-reason list alone runs past a hundred values and is not
// worth a key each.
const DISPUTE_LABEL: Record<string, string> = {
  INQUIRY: 'payDisputeStageInquiry',
  CHARGEBACK: 'payDisputeStageChargeback',
  PRE_ARBITRATION: 'payDisputeStagePreArbitration',
  ARBITRATION: 'payDisputeStageArbitration',
  OPEN: 'payDisputeStatusOpen',
  WAITING_FOR_BUYER_RESPONSE: 'payDisputeStatusWaitingBuyer',
  WAITING_FOR_SELLER_RESPONSE: 'payDisputeStatusWaitingSeller',
  UNDER_REVIEW: 'payDisputeStatusUnderReview',
  RESOLVED: 'payDisputeStatusResolved',
  OTHER: 'payDisputeStatusOther',
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'payDisputeReasonNotReceived',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'payDisputeReasonNotAsDescribed',
  UNAUTHORISED: 'payDisputeReasonUnauthorised',
  CREDIT_NOT_PROCESSED: 'payDisputeReasonCreditNotProcessed',
  DUPLICATE_TRANSACTION: 'payDisputeReasonDuplicate',
  INCORRECT_AMOUNT: 'payDisputeReasonIncorrectAmount',
  PAYMENT_BY_OTHER_MEANS: 'payDisputeReasonOtherMeans',
  CANCELED_RECURRING_BILLING: 'payDisputeReasonCanceledBilling',
  PROBLEM_WITH_REMITTANCE: 'payDisputeReasonRemittance',
  DENY_BUYER: 'payDisputeAdjDenyBuyer',
  PAYOUT_TO_BUYER: 'payDisputeAdjPayoutBuyer',
  PAYOUT_TO_SELLER: 'payDisputeAdjPayoutSeller',
  RECOVER_FROM_SELLER: 'payDisputeAdjRecoverSeller',
  DEBIT: 'payDisputeMoneyDebit',
  CREDIT: 'payDisputeMoneyCredit',
  RESOLVED_BUYER_FAVOUR: 'payDisputeOutcomeBuyer',
  RESOLVED_SELLER_FAVOUR: 'payDisputeOutcomeSeller',
  RESOLVED_WITH_PAYOUT: 'payDisputeOutcomePayout',
  CANCELED_BY_BUYER: 'payDisputeOutcomeCanceled',
};

const disputeLabel = (t: (k: string) => string, code: string | null): string =>
  !code ? '\u2014' : DISPUTE_LABEL[code] ? t(DISPUTE_LABEL[code]) : code;

type PaymentRow = Omit<Leg, 'source'> & {
  source: 'mercury' | 'paypal' | 'paired';
  legs: Leg[];
  // Server-ranked PO candidates. Present only on rows still in the queue —
  // a linked, ignored or transfer row carries null.
  match: MatchSummary | null;
  // Added in v1.103.0 — optional for the same deploy-skew reason as
  // Stats.suggested below.
  pairCandidate?: PairCandidate | null;
  orderId: string | null;
  // The linked PO's cost — goods plus other fees, what the bank was asked to
  // pay. Added in v1.117.0, so optional for the same deploy-skew reason as
  // Stats.suggested below.
  orderCost?: number | null;
  linkKind: 'payment' | 'refund' | null;
  linkAuto: boolean;
  linkedAt: string | null;
  linkedByName: string | null;
  ignored: boolean;
  category: 'external' | 'transfer';
  // The PayPal case(s) opened on this payment, newest first. A list because one
  // payment can carry a claim and a card chargeback at once. Added in v1.124.0,
  // optional for the same deploy-skew reason as Stats.suggested below.
  disputes?: Dispute[] | null;
  // Whether the money actually moved. Added in v1.127.0, optional for the same
  // deploy-skew reason as Stats.suggested below — a row from an older backend
  // has no opinion, and an absent value reads as settled because until this
  // version nothing else was ever ingested.
  settleStatus?: SettleStatus;
  // Both added in v1.117.0 — optional for the same deploy-skew reason as
  // Stats.suggested below: the SPA and the API ship on independent pipelines.
  internalTxn?: { id: string; title: string | null } | null;
  // `initials` arrived with the Owner column and is optional for the same
  // deploy-skew reason.
  assignee?: { id: string; name: string; initials?: string } | null;
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
  // Added in v1.124.0 — optional for the same reason as suggested above.
  disputes?: { count: number; amount: number };
  // `disputeError` is set when PayPal refuses the disputes API while the
  // transaction sync is fine, which is its own state and not a sync failure.
  sources: { source: string; lastSyncedAt: string | null; disputeError?: string | null }[];
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

type Member = { id: string; name: string; active?: boolean };

type InternalRecord = { id: string; title: string | null; memberCount: number };

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
  orderTxnFilled?: boolean;
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
  const [disputed, setDisputed] = usePersisted('desktop.payments.disputed', false);
  const [settle, setSettle] = usePersisted('desktop.payments.settle', 'all');
  const [assignee, setAssignee] = usePersisted('desktop.payments.assignee', 'all');
  const [members, setMembers] = useState<Member[]>([]);
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
    if (disputed) p.set('dispute', '1');
    if (settle !== 'all') p.set('settle', settle);
    if (assignee !== 'all') p.set('assignee', assignee);
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  }, [status, source, direction, q, hasMatch, disputed, settle, assignee]);

  // The owner picker and the filter share one list; the page is manager-only,
  // so /api/members is readable here.
  useEffect(() => {
    api.get<{ items: Member[] }>('/api/members')
      .then(r => setMembers(r.items))
      .catch(handleFetchError);
  }, []);

  // The unlinked and suggested tiles are scoped to the same direction as the
  // list, so the number on the tile and the rows under it can never disagree —
  // the page defaults to money out, and a direction-blind count claimed rows the
  // list was hiding.
  const refreshStats = useCallback(() => {
    const p = direction !== 'all' ? `?direction=${direction}` : '';
    api.get<Stats>(`/api/bank-transactions/stats${p}`).then(setStats).catch(handleFetchError);
  }, [direction]);

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

  const disputeError = (stats?.sources ?? []).find(s => s.disputeError)?.disputeError ?? null;

  type TileKey = StatusFilter | 'refunds' | 'suggested' | 'disputed';
  const tiles: { key: TileKey; label: string; count: number; sub: string; tone: string }[] = stats ? [
    { key: 'unlinked', label: t('payTileUnlinked'), count: stats.unlinked.count, sub: fmtUSD(stats.unlinked.amount, locale), tone: 'warn' },
    { key: 'suggested', label: t('payTileSuggested'), count: stats.suggested?.count ?? 0, sub: t('payTileSuggestedSub'), tone: 'accent' },
    { key: 'linked', label: t('payTileLinked'), count: stats.linked.count, sub: t('payTileLinkedSub'), tone: 'pos' },
    { key: 'refunds', label: t('payTileRefunds'), count: stats.refunds.count, sub: fmtUSD(stats.refunds.amount, locale), tone: 'cool' },
    { key: 'transfer', label: t('payTileTransfers'), count: stats.transfers.count, sub: t('payTileTransfersSub'), tone: 'info' },
    { key: 'ignored', label: t('payTileIgnored'), count: stats.ignored.count, sub: t('payTileIgnoredSub'), tone: 'muted' },
    { key: 'disputed', label: t('payTileDisputed'), count: stats.disputes?.count ?? 0, sub: fmtUSD(stats.disputes?.amount ?? 0, locale), tone: 'neg' },
  ] : [];

  // Every tile but Refunds sits at the page's default direction, so that — not
  // 'all' — is what counts as "no direction lens" here.
  const tileActive = (key: TileKey) =>
    key === 'refunds' ? status === 'linked' && direction === 'in'
    : key === 'suggested' ? status === 'unlinked' && hasMatch
    // Disputes cut across the queue rather than sitting inside it: a disputed
    // payment is usually already linked to its PO, so nesting this under
    // 'unlinked' the way Suggested is nested would show an empty list beside a
    // count that isn't zero.
    : key === 'disputed' ? status === 'all' && disputed && settle === 'all'
    // Unlinked and Suggested are nested, so only the narrower one lights up.
    : status === key && direction === DEFAULT_DIRECTION && !hasMatch && !disputed && settle === 'all';

  // Every tile clears the other lenses. Leaving one on would filter the list
  // past what the clicked tile counted, and the count and the rows beneath it
  // would disagree — the settlement select most sharply of all, since no tile
  // counts a failed row.
  const clearLenses = () => { setHasMatch(false); setDisputed(false); setSettle('all'); };
  const clickTile = (key: TileKey) => {
    if (tileActive(key)) { setStatus('all'); setDirection(DEFAULT_DIRECTION); clearLenses(); return; }
    if (key === 'refunds') { setStatus('linked'); setDirection('in'); clearLenses(); return; }
    if (key === 'suggested') { setStatus('unlinked'); setDirection(DEFAULT_DIRECTION); clearLenses(); setHasMatch(true); return; }
    if (key === 'disputed') { setStatus('all'); setDirection(DEFAULT_DIRECTION); clearLenses(); setDisputed(true); return; }
    setStatus(key);
    setDirection(DEFAULT_DIRECTION);
    clearLenses();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('payTitle')}</h1>
          <div className="page-sub">{t('paySub')}</div>
        </div>
        <div className="page-actions" style={{ alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn ghost" onClick={() => navigate('/payments/internal')}>
            <Icon name="book" size={13} />
            {t('payIntOpen')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {lastSynced ? t('payLastSynced', { when: relTime(lastSynced, locale) }) : t('payNeverSynced')}
          </span>
          {/* Its own state, not a sync failure: the money keeps arriving while
              PayPal refuses the disputes API. Said out loud because the
              alternative — a dispute list that is permanently empty — reads as
              "no cases", which is how a feature quietly ships dark. */}
          {disputeError && (
            <span className="chip dot neg" style={{ fontSize: 11 }} title={disputeError}>
              {DISPUTE_FORBIDDEN.test(disputeError) ? t('payDisputeUnauthorised') : t('payDisputeSyncFailed')}
            </span>
          )}
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
                onClick={() => { setStatus(s); clearLenses(); }}
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
            {/* The only way to reach a failed or reversed row: no tile counts
                one, and the queue deliberately does not carry them. */}
            <select
              className="select"
              value={settle}
              // Picking a state widens the tab to All, for the reason the
              // Disputed tile does: failed and reversed rows are deliberately
              // not in the queue, so asking for them from inside it would
              // always answer with an empty list.
              onChange={e => {
                setSettle(e.target.value);
                if (e.target.value !== 'all') setStatus('all');
              }}
              style={FILTER_SELECT}
            >
              <option value="all">{t('paySettleAll')}</option>
              <option value="settled">{t('paySettleSettled')}</option>
              <option value="pending">{t('paySettlePending')}</option>
              <option value="failed">{t('paySettleFailed')}</option>
              <option value="reversed">{t('paySettleReversed')}</option>
            </select>
            <select
              className="select"
              value={assignee}
              onChange={e => setAssignee(e.target.value)}
              style={FILTER_SELECT}
            >
              <option value="all">{t('payAssignFilter')}</option>
              <option value="unassigned">{t('payAssignUnassigned')}</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
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
            <button
              type="button"
              className="btn sm"
              aria-pressed={disputed}
              onClick={() => setDisputed(v => !v)}
              style={{
                height: 32, fontSize: 12.5,
                ...(disputed
                  ? { background: 'var(--neg-soft)', borderColor: 'var(--neg)', color: 'var(--neg)' }
                  : { color: 'var(--fg-muted)' }),
              }}
            >
              <Icon name="alert" size={12} />
              {t('payFilterDisputed')}
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
            <table className="table pay-table">
              <thead>
                <tr>
                  <th style={{ width: 26 }} />
                  <th>{t('payColDate')}</th>
                  <th>{t('payColSource')}</th>
                  <th>{t('payColCounterparty')}</th>
                  <th className="num">{t('payColAmount')}</th>
                  <th>{t('payColOwner')}</th>
                  <th>{t('payColStatus')}</th>
                  {/* The rail's contents name themselves; a visible heading
                      over two buttons is a label nobody reads. */}
                  <th className="pay-actions" aria-label={t('payColActions')} />
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
                    members={members}
                    refresh={afterMutation}
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

function PaymentTr({ row, open, onToggle, locale, act, onToast, members, refresh }: {
  row: PaymentRow;
  open: boolean;
  members: Member[];
  refresh: () => void;
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
  const [pairDismissed, setPairDismissed] = useState(false);

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const link = async (orderId: string) => {
    const r = await act(`${row.id}/link`, { orderId });
    if (r) {
      // The link filled the PO's empty transaction field, which is a second
      // thing that happened to a screen the manager isn't looking at.
      onToast(t(r.orderTxnFilled ? 'payLinkedFilledToast' : 'payLinkedToast', { id: orderId }));
      setPicking(false);
    }
  };

  // One-click only when the server found exactly one candidate and is sure of
  // it; anything else has to be looked at before it is linked.
  const likely = !dismissed && row.match?.count === 1 && row.match.confidence === 'high'
    ? row.match : null;
  const ambiguous = !likely && (row.match?.count ?? 0) > 0 ? row.match : null;

  // Grouping outranks linking: while two rows may be one payment, linking
  // either of them to a PO is premature — and linking both is how one PO ends
  // up carrying the payment twice.
  const grouping = !pairDismissed ? row.pairCandidate ?? null : null;
  const group = async (otherId: string) => {
    if (await act(`${row.id}/pair`, { otherId })) onToast(t('payGroupedToast'));
  };

  // The row badges one case — the newest, which the server sorted to the front.
  // The rest are in the expansion; a second chip here would say the same thing
  // twice.
  const lead = row.disputes?.[0] ?? null;

  const settled = settleOf(row);
  const settleChip = settled === 'settled' ? null : SETTLE_CHIP[settled];
  // No money moved, so every verdict this rail offers is meaningless — and the
  // endpoints behind them refuse it anyway.
  const dead = settleDead(row);

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
        <td style={{ whiteSpace: 'nowrap' }}>
          <span className={'chip ' + (row.source === 'paired' ? 'accent' : row.source === 'mercury' ? 'info' : '')} style={{ fontSize: 11 }}>
            {SOURCE_LABEL[row.source]}
          </span>
          {/* Before the case chip, because it qualifies the payment itself: a
              disputed payment that never settled is first of all one that
              never settled. Settled rows show nothing — that is every row. */}
          {settleChip && (
            <span className={'chip dot ' + settleChip.tone} style={{ fontSize: 10.5, marginLeft: 6 }}>
              {t(settleChip.key)}
            </span>
          )}
          {/* Here rather than in the Status cell: that cell states one verdict
              about what the money was, and a case is not a competing answer to
              it — it is a fact about the transaction, which is what this column
              already carries. */}
          {lead && (
            <span
              className={'chip dot ' + (disputeLive(lead) ? 'neg' : 'muted')}
              style={{ fontSize: 10.5, marginLeft: 6 }}
            >
              {t(disputeLive(lead) ? 'payDisputeOpen' : 'payDisputeClosed')}
            </span>
          )}
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
        {/* Owner and PO are mutually exclusive by constraint (migration 0116),
            so this column is all dashes on the Linked tab by design. */}
        <td className="pay-owner">
          {row.assignee ? (
            <span className="pay-owner-in" title={row.assignee.name}>
              <span className="avatar sm">
                {row.assignee.initials ?? row.assignee.name.slice(0, 1).toUpperCase()}
              </span>
              {row.assignee.name.split(' ')[0]}
            </span>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        {/* What this money is attached to. One line, one register: a chip only
            where attention is earned — a candidate worth acting on — and muted
            prose everywhere else. */}
        <td className="pay-link">
          <span className="pay-link-in">
            {row.orderId ? (
              <>
                <button className="ship-po-pill" onClick={(e) => { stop(e); navigate(`/purchase-orders/${row.orderId}`); }}>
                  {row.orderId}
                </button>
                {/* What the PO cost, beside what was paid for it — the row is
                    otherwise unreadable against its own amount. */}
                {row.orderCost != null && (
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {fmtUSD(row.orderCost, locale)}
                  </span>
                )}
                <span className={'chip dot ' + (row.linkKind === 'refund' ? 'cool' : 'pos')}>
                  {t(row.linkKind === 'refund' ? 'payKindRefund' : 'payKindPayment')}
                </span>
                {row.linkAuto && <span className="chip info" style={{ fontSize: 10.5 }}>{t('payAuto')}</span>}
              </>
            ) : row.ignored ? (
              <span className="muted">{t('payStatusIgnored')}</span>
            ) : (
              <>
                {/* A transfer can still carry a candidate, so the classification
                    and the suggestion sit side by side rather than one hiding
                    the other. */}
                {row.category === 'transfer' && <span className="muted">{t('payStatusTransfer')}</span>}
                {grouping ? (
                  <span className="chip dot accent" style={{ fontSize: 10.5 }}>
                    {t('paySamePaymentAs', {
                      source: grouping.source === 'mercury' ? 'Mercury' : 'PayPal',
                      when: fmtDateShort(grouping.postedAt, locale),
                    })}
                  </span>
                ) : likely ? (
                  <>
                    <span className="chip dot pos" style={{ fontSize: 10.5 }}>{likely.best.id}</span>
                    {likely.best.dayGap !== null && (
                      <span className="muted" style={{ fontSize: 12 }}>{gapLabel(likely.best.dayGap, t)}</span>
                    )}
                  </>
                ) : ambiguous ? (
                  // Plain text, not a button: the row itself opens on click, so
                  // a control here would only be a second way to do that and an
                  // extra tab stop.
                  <span className="muted">
                    {row.match!.count === 1
                      ? t('payMatchCountOne')
                      : t('payMatchCount', { n: row.match!.count })}
                  </span>
                ) : row.category !== 'transfer' && (
                  <span className="muted">{t('payStatusUnlinked')}</span>
                )}
              </>
            )}
            {/* The record rides in this cell — unlike the owner, which now has
                a column, it says what the money *was*, which is what the rest of
                this cell answers. */}
            {row.internalTxn && (
              <span className="chip accent" style={{ fontSize: 10.5 }}>
                {t('payIntPartOf', { name: row.internalTxn.title || t('payIntUntitled') })}
              </span>
            )}
          </span>
        </td>
        {/* The rail. The primary action renders last so it lands flush right on
            every row shape — right-alignment pins only the right-most item, and
            rows carry two, three or no secondary buttons. */}
        <td className="pay-actions">
          <span ref={actionsRef} className="pay-rail" onClick={stop}>
            {row.orderId || dead ? null : row.ignored ? (
              <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/unignore`)}>
                {t('payUnignore')}
              </button>
            ) : grouping ? (
              <>
                <span className="pay-sec">
                  <button type="button" className="btn sm ghost" onClick={() => setPairDismissed(true)}>
                    {t('payNotSame')}
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/ignore`)}>
                    {t('payIgnore')}
                  </button>
                </span>
                <button type="button" className="btn sm primary" onClick={() => void group(grouping.id)}>
                  {t('payGroup')}
                </button>
              </>
            ) : (
              <>
                <span className="pay-sec">
                  {likely && (
                    <button
                      type="button" className="btn sm ghost"
                      onClick={() => { setDismissed(true); setPicking(true); }}
                    >
                      {t('payMatchNotIt')}
                    </button>
                  )}
                  <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/ignore`)}>
                    {t('payIgnore')}
                  </button>
                </span>
                {likely ? (
                  <button type="button" className="btn sm primary" onClick={() => void link(likely.best.id)}>
                    {t('payLink')}
                  </button>
                ) : (
                  <button type="button" className="btn sm" onClick={() => setPicking(p => !p)}>
                    {t('payLink')}
                  </button>
                )}
              </>
            )}
          </span>
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
          <td colSpan={8} style={{ background: 'var(--bg-soft)', padding: '10px 16px 12px' }}>
            <ExpandedDetail
              row={row} locale={locale} act={act} onToast={onToast}
              onLink={link} onGroup={group} members={members} refresh={refresh}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedDetail({ row, locale, act, onToast, onLink, onGroup, members, refresh }: {
  row: PaymentRow;
  locale: string;
  members: Member[];
  refresh: () => void;
  act: (path: string, body?: unknown) => Promise<ActResult | null>;
  onToast: (msg: string) => void;
  onLink: (orderId: string) => void;
  onGroup: (otherId: string) => void;
}) {
  const { t } = useT();
  const [pickingPair, setPickingPair] = useState(false);
  const [pickingRecord, setPickingRecord] = useState(false);
  const recordAnchorRef = useRef<HTMLSpanElement>(null);
  const settled = settleOf(row);
  const dead = settleDead(row);
  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 12.5 }}>
      {settled !== 'settled' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className={'chip dot ' + SETTLE_CHIP[settled].tone} style={{ fontSize: 10.5 }}>
            {t(SETTLE_CHIP[settled].key)}
          </span>
          {/* The date the row already carries is the one that matters here:
              for a pending PayPal charge it is when the payment was started,
              so "pending since" is a number of days a reader can act on. */}
          <span className="muted">
            {settled === 'pending'
              ? t('paySettlePendingSince', { when: fmtDate(row.postedAt, locale) })
              : t(settled === 'reversed' ? 'paySettleReversedHint' : 'paySettleFailedHint')}
          </span>
        </div>
      )}
      {(row.disputes ?? []).map(d => (
        <DisputeDetail key={d.disputeId} dispute={d} locale={locale} />
      ))}
      {row.match && !row.orderId && !row.ignored && !dead && (
        <MatchList txnId={row.id} locale={locale} onLink={onLink} />
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        {row.legs.map(leg => (
          <div key={leg.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className={'chip ' + (leg.source === 'mercury' ? 'info' : '')} style={{ fontSize: 10.5 }}>
              {leg.source === 'mercury' ? 'Mercury' : 'PayPal'}
            </span>
            {/* The group's chip says the worst of its legs; this says which. */}
            {settleChipOf(leg) && (
              <span className={'chip dot ' + settleChipOf(leg)!.tone} style={{ fontSize: 10.5 }}>
                {t(settleChipOf(leg)!.key)}
              </span>
            )}
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
        {row.source === 'paired' ? (
          <button type="button" className="btn sm ghost" onClick={() => void act(`${row.id}/unpair`)}>
            {t('payUnpair')}
          </button>
        ) : !row.ignored && row.category === 'external' && !dead && (
          // A pending leg groups like a settled one; only failed and reversed
          // are refused by POST /:id/pair.
          // PoPicker anchors to its offset parent, and this row is a plain
          // <td colSpan>, so the wrapper is what keeps the popover on the
          // button instead of the page.
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <button type="button" className="btn sm ghost" onClick={() => setPickingPair(p => !p)}>
              {t('payGroupWith')}
            </button>
            {pickingPair && (
              <PairPicker
                txnId={row.id}
                locale={locale}
                onPick={id => { onGroup(id); setPickingPair(false); }}
                onClose={() => setPickingPair(false)}
              />
            )}
          </span>
        )}
        {!row.orderId && !row.internalTxn && !dead && (
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

      {/* What this money was, and — while no PO answers that — whose it is. */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {row.internalTxn ? (
          <>
            <button type="button" className="btn sm ghost" onClick={() => navigate('/payments/internal')}>
              {t('payIntOpen')}
            </button>
            <button
              type="button" className="btn sm ghost"
              onClick={() => {
                const recordId = row.internalTxn!.id;
                api.delete(`/api/internal-transactions/${recordId}/members/${row.id}`)
                  .then(() => { onToast(t('payIntRemovedToast')); refresh(); })
                  .catch(handleFetchError);
              }}
            >
              {t('payIntRemove')}
            </button>
          </>
        ) : !row.orderId && !dead && (
          <span ref={recordAnchorRef} style={{ display: 'inline-flex' }}>
            <button type="button" className="btn sm ghost" onClick={() => setPickingRecord(p => !p)}>
              {t('payIntAdd')}
            </button>
            {pickingRecord && (
              <RecordPicker
                txnId={row.id}
                anchor={recordAnchorRef}
                onDone={(msg) => { setPickingRecord(false); onToast(msg); refresh(); }}
                onClose={() => setPickingRecord(false)}
              />
            )}
          </span>
        )}
        {!row.orderId && !dead && (
          row.assignee ? (
            <button
              type="button" className="btn sm ghost"
              onClick={() => void act(`${row.id}/unassign`).then(ok => {
                if (ok) onToast(t('payUnassignedToast'));
              })}
            >
              {t('payUnassign')}
            </button>
          ) : (
            <select
              className="select"
              value=""
              onChange={e => {
                const m = members.find(x => x.id === e.target.value);
                if (!m) return;
                void act(`${row.id}/assign`, { userId: m.id })
                  .then(ok => { if (ok) onToast(t('payAssignedToast', { name: m.name })); });
              }}
              style={{ ...FILTER_SELECT, minWidth: 150 }}
            >
              <option value="">{t('payAssignTo')}</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )
        )}
      </div>
    </div>
  );
}

// The ranked candidate list behind the row's "{n} matches" badge. Fetched when
// the row opens rather than with the feed: the badge only needs the count, and
// most rows are never expanded.
// The case, as PayPal tells it: where it has got to, and what has happened.
// Rendered from the row — the whole case rides along with the feed, so
// expanding a transaction costs no round trip.
function DisputeDetail({ dispute: d, locale }: { dispute: Dispute; locale: string }) {
  const { t } = useT();
  const stageIdx = DISPUTE_STAGES.indexOf(d.lifeCycleStage as (typeof DISPUTE_STAGES)[number]);
  // Ours is the buyer clock; the seller's shows when it is the one running,
  // because "waiting on them" is as much of an answer as "waiting on us".
  const due = d.buyerResponseDueAt ?? d.sellerResponseDueAt;
  const live = disputeLive(d);
  // Every amount in this card is the case's currency, not ours — a EUR claim
  // rendered with a '$' misstates money we are trying to recover. The timeline
  // borrows it: a fund movement carries its own currency_code on the wire, but
  // the normaliser keeps only the number, and a case settles in one currency.
  const cur = d.currency ?? 'USD';

  return (
    <div
      style={{
        display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 10,
        background: 'var(--bg-elev)',
        border: '1px solid ' + (live ? 'color-mix(in oklch, var(--neg) 30%, var(--border))' : 'var(--border)'),
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className={'chip dot ' + (live ? 'neg' : 'muted')} style={{ fontSize: 10.5 }}>
          {disputeLabel(t, d.status)}
        </span>
        <span className="mono muted">{d.disputeId}</span>
        {d.amount != null && <span className="mono">{fmtMoney(d.amount, cur, locale)}</span>}
        <span className="muted">{disputeLabel(t, d.reason)}</span>
        {live && due && (
          <span className="chip dot neg" style={{ fontSize: 10.5 }}>
            {t('payDisputeDue', { when: fmtDateShort(due, locale) })}
          </span>
        )}
      </div>

      {/* The stage ladder. Divs, not buttons: .so-step is written for a stepper
          you click through, and there is nothing here to click. */}
      {stageIdx >= 0 && (
        <div className="so-stepper">
          {DISPUTE_STAGES.map((stage, i) => (
            <Fragment key={stage}>
              {i > 0 && <span className={'so-step-bar' + (i <= stageIdx ? ' reached' : '')} />}
              <div
                className={'so-step' + (i < stageIdx ? ' reached' : i === stageIdx ? ' active' : '')}
                style={{ cursor: 'default' }}
              >
                <span className="so-step-dot">{i + 1}</span>
                <span className="so-step-label">{disputeLabel(t, stage)}</span>
              </div>
            </Fragment>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 3 }}>
        {d.timeline.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span className="mono muted" style={{ minWidth: 96 }}>{fmtDate(e.at, locale)}</span>
            <span>
              {e.kind === 'opened' ? t('payDisputeEvtOpened', { reason: disputeLabel(t, e.code) })
                : e.kind === 'money' ? t('payDisputeEvtMoney', { what: disputeLabel(t, e.code) })
                : disputeLabel(t, e.code)}
            </span>
            {e.amount != null && <span className="mono">{fmtMoney(e.amount, cur, locale)}</span>}
          </div>
        ))}
      </div>

      {d.outcomeCode && d.outcomeCode !== 'NONE' && (
        <div className="muted">
          {t('payDisputeOutcome', { outcome: disputeLabel(t, d.outcomeCode) })}
          {d.refundedAmount != null && ` \u00b7 ${fmtMoney(d.refundedAmount, cur, locale)}`}
        </div>
      )}
    </div>
  );
}

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

// The internal transactions this payment can be filed under, plus the option to
// start a new one. Fixed-position like PoPicker rather than absolute like
// PairPicker: the list grows with the number of records, and `.table-scroll`'s
// `overflow-y: hidden` shears a tall absolute popover off at the table's edge.
function RecordPicker({ txnId, anchor, onDone, onClose }: {
  txnId: string;
  anchor: React.RefObject<HTMLElement | null>;
  onDone: (toast: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<InternalRecord[] | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const room = window.innerHeight - r.bottom;
      setPos({
        top: room < PICKER_H + GAP ? Math.max(GAP, r.top - PICKER_H - GAP) : r.bottom + GAP,
        left: Math.max(GAP, Math.min(r.left, window.innerWidth - PICKER_W - GAP)),
      });
    };
    place();
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
    api.get<{ rows: InternalRecord[] }>('/api/internal-transactions?limit=20')
      .then(r => setRows(r.rows))
      .catch(handleFetchError);
  }, []);

  const file = (record: InternalRecord) => {
    api.post(`/api/internal-transactions/${record.id}/members`, { txnIds: [txnId] })
      .then(() => onDone(t('payIntAddedToast', { name: record.title || t('payIntUntitled') })))
      .catch(handleFetchError);
  };

  const createWith = () => {
    api.post('/api/internal-transactions', { txnIds: [txnId] })
      .then(() => onDone(t('payIntCreatedToast')))
      .catch(handleFetchError);
  };

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
      <button
        type="button"
        onClick={createWith}
        style={{
          width: '100%', textAlign: 'left', padding: '9px 12px', fontFamily: 'inherit',
          border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600,
        }}
      >
        <Icon name="plus" size={12} />
        {t('payIntNew')}
      </button>
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {rows === null ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payMoreLoading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payIntPickNone')}</div>
        ) : rows.map(r => (
          <button
            key={r.id}
            type="button"
            onClick={() => file(r)}
            style={{
              width: '100%', textAlign: 'left', padding: '9px 12px', fontFamily: 'inherit',
              border: 'none', background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <span style={{ fontWeight: 500 }}>{r.title || t('payIntUntitled')}</span>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
              {r.memberCount === 1 ? t('payIntMembersOne') : t('payIntMembers', { n: r.memberCount })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// The counterparts this transaction may be grouped with. Same popover shape as
// PoPicker, without the search box: the server's rules — opposite source, the
// same amount to the cent, neither leg already grouped — leave a set small
// enough to read, and nothing about it is searchable anyway.
function PairPicker({ txnId, locale, onPick, onClose }: {
  txnId: string;
  locale: string;
  onPick: (otherId: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<PairCandidate[] | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    api.get<{ candidates: PairCandidate[] }>(`/api/bank-transactions/${txnId}/pair-candidates`)
      .then(r => { if (live) setRows(r.candidates); })
      .catch(e => { if (live) setRows([]); handleFetchError(e); });
    return () => { live = false; };
  }, [txnId]);

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, width: 380,
        background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
        boxShadow: '0 12px 28px rgba(15,23,42,0.14)', zIndex: 30, overflow: 'hidden',
        cursor: 'default', textAlign: 'left',
      }}
    >
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {rows === null ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payMoreLoading')}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--fg-subtle)', fontSize: 12.5 }}>{t('payPairPickNone')}</div>
        ) : rows.map(cand => (
          <button
            key={cand.id}
            type="button"
            onClick={() => onPick(cand.id)}
            style={{
              width: '100%', textAlign: 'left', padding: '9px 12px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <span className={'chip ' + (cand.source === 'mercury' ? 'info' : '')} style={{ fontSize: 10.5 }}>
              {cand.source === 'mercury' ? 'Mercury' : 'PayPal'}
            </span>
            <span className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtSigned(cand.amount, locale)}</span>
            {/* The counterparty is the only elastic part, so it is the only
                thing allowed to run out of room. */}
            <span
              className="muted"
              style={{
                fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {fmtDateShort(cand.postedAt, locale)}
              {cand.counterparty ? ` · ${cand.counterparty}` : ''}
            </span>
            <span className="chip" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
              {gapLabel(cand.dayGap, t)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
