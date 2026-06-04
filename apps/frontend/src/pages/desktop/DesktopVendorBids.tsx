import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { useRoute, navigate, match } from '../../lib/route';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { fmtUSD, fmtUSD0, fmtMoney, fmtDate, fmtDateShort, relTime } from '../../lib/format';
import { shareOrCopy } from '../../lib/shareOrCopy';
import { TableSkeleton, FormSkeleton } from '../../components/Skeleton';
import { CustomerPicker, type Customer } from './DesktopSellOrderDraft';

// Vendor-bid lifecycle. Mirrors the backend `status` column; drives the
// filter tiles and the row chip.
type VbStatus = 'new' | 'partly_decided' | 'decided';

const STATUSES: { id: VbStatus; tKey: string; tone: string }[] = [
  { id: 'new',            tKey: 'vbStatusNew',    tone: 'accent' },
  { id: 'partly_decided', tKey: 'vbStatusPartly', tone: 'warn' },
  { id: 'decided',        tKey: 'vbStatusDecided', tone: 'good' },
];

type VbSummary = {
  id: string;
  contact_name: string | null;
  note: string | null;
  status: VbStatus;
  created_at: string;
  customer_name: string | null;
  customer_short: string | null;
  line_count: number;
  total_offered: number;
  currency: 'USD' | 'CNY';
  fxRateToUsd: number;
  fxSource: 'frankfurter' | 'manual' | 'fixed';
  totalOfferedUsd: number;
};

type VbLine = {
  id: string;
  inventory_id: string | null;
  label: string;
  sub_label: string | null;
  category: string | null;
  offered_qty: number;
  offered_unit_price: number;
  line_status: 'pending' | 'accepted' | 'declined';
  accepted_qty: number | null;
  accepted_unit_price: number | null;
  sell_order_id: string | null;
  available: number;
  unitPriceUsd: number;
};

type VbDetail = {
  id: string;
  contact_name: string | null;
  note: string | null;
  status: VbStatus;
  created_at: string;
  customer_id: string | null;
  customer_name: string | null;
  currency: 'USD' | 'CNY';
  fxRateToUsd: number;
  fxSource: 'frankfurter' | 'manual' | 'fixed';
  lines: VbLine[];
};

const toneFor = (s: VbStatus) => STATUSES.find(o => o.id === s)?.tone ?? 'muted';

type VendorBidsProps = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
  onOpenSellOrder?: (sellOrderId: string) => void;
};

export function DesktopVendorBids({ onToast, onOpenSellOrder }: VendorBidsProps = {}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [bids, setBids] = useState<VbSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | VbStatus>('all');
  const [currencyFilter, setCurrencyFilter] = useState<'All' | 'USD' | 'CNY'>('All');
  const [linksOpen, setLinksOpen] = useState(false);
  const { path } = useRoute();
  const openMatch = match('/vendor-bids/:id', path);
  const openId = openMatch?.id ?? null;

  const load = (alive?: { v: boolean }) => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    api.get<{ items: VbSummary[] }>(`/api/vendor-bids?${p}`)
      .then(r => { if (!alive || alive.v) setBids(r.items); })
      .catch(handleFetchError)
      .finally(() => { if (!alive || alive.v) setLoadedOnce(true); });
  };

  useEffect(() => {
    const alive = { v: true };
    load(alive);
    return () => { alive.v = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const visibleBids = useMemo(
    () => currencyFilter === 'All' ? bids : bids.filter(b => b.currency === currencyFilter),
    [bids, currencyFilter],
  );

  // Stats aggregate per-status — switch to USD-equivalent so mixed-currency
  // pipelines roll up apples-to-apples (matches the column swap below).
  const stats = useMemo(() => {
    const m: Record<string, { count: number; offered: number }> = {};
    for (const s of STATUSES) m[s.id] = { count: 0, offered: 0 };
    bids.forEach(b => { m[b.status].count++; m[b.status].offered += b.totalOfferedUsd; });
    return m;
  }, [bids]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('vendorBids')}</h1>
          <div className="page-sub">{t('vendorBidsSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setLinksOpen(true)}>
            <Icon name="globe" size={14} /> {t('vendorLinksManage')}
          </button>
        </div>
      </div>

      {/* Status pipeline tiles — click to filter (matches sell-orders so-stat). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {STATUSES.map(({ id: s, tKey, tone }) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              className="so-stat"
              onClick={() => setStatusFilter(active ? 'all' : s)}
              style={{
                ...(active ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-soft)' } : {}),
                fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              <div className="so-stat-head">
                <span className={'chip ' + tone + ' dot'} style={{ fontSize: 10.5 }}>{t(tKey)}</span>
              </div>
              <div className="so-stat-num">{stats[s].count}</div>
              <div className="so-stat-sub">{fmtUSD0(stats[s].offered, locale)}</div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="select"
              style={{ width: 180, height: 32, fontSize: 12.5, padding: '0 12px' }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">{t('vbColStatus')}</option>
              {STATUSES.map(s => <option key={s.id} value={s.id}>{t(s.tKey)}</option>)}
            </select>
            <select
              className="select"
              style={{ width: 140, height: 32, fontSize: 12.5, padding: '0 12px' }}
              value={currencyFilter}
              onChange={e => setCurrencyFilter(e.target.value as 'All' | 'USD' | 'CNY')}
            >
              <option value="All">{t('vb.filter.currency_all')}</option>
              <option value="USD">USD</option>
              <option value="CNY">CNY</option>
            </select>
          </div>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={7} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('vbColCustomer')}</th>
                <th>{t('vbColContact')}</th>
                <th>{t('vb.col.currency')}</th>
                <th className="num">{t('vbColLines')}</th>
                <th className="num">{t('vbColOffered')}</th>
                <th>{t('vbColSubmitted')}</th>
                <th>{t('vbColStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleBids.map(b => (
                <tr
                  key={b.id}
                  className="row-hover"
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate('/vendor-bids/' + b.id)}
                >
                  <td>
                    {b.customer_name ? (
                      <>
                        <div style={{ fontWeight: 500 }}>{b.customer_name}</div>
                        {b.customer_short && (
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{b.customer_short}</div>
                        )}
                      </>
                    ) : (
                      <span className="chip dot muted">{t('vbGeneralLink')}</span>
                    )}
                  </td>
                  <td>
                    <div>{b.contact_name || '—'}</div>
                    {b.note && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {b.note}
                      </div>
                    )}
                  </td>
                  <td>{b.currency}</td>
                  <td className="num mono">{b.line_count}</td>
                  <td className="num">
                    <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(b.totalOfferedUsd, locale)}</span>
                    {b.currency !== 'USD' && (
                      <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                        {fmtMoney(b.total_offered, b.currency, locale)}
                      </div>
                    )}
                  </td>
                  <td className="muted">{fmtDateShort(b.created_at, locale)}</td>
                  <td><span className={'chip dot ' + toneFor(b.status)}>{t(STATUSES.find(s => s.id === b.status)?.tKey ?? 'vbColStatus')}</span></td>
                </tr>
              ))}
              {visibleBids.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
                    {t('vbEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {openId && (
        <VendorBidDetail
          id={openId}
          onClose={() => navigate('/vendor-bids')}
          onToast={onToast}
          onOpenSellOrder={onOpenSellOrder}
          onChanged={() => load()}
        />
      )}

      {linksOpen && (
        <VendorLinksManager
          onClose={() => setLinksOpen(false)}
          onToast={onToast}
        />
      )}
    </>
  );
}

// ─── Detail / decide / promote modal ─────────────────────────────────────────
// Per-line accept/decline with editable accepted qty + unit price. Save posts
// the decision array; promote turns the accepted-and-not-yet-promoted lines
// into a draft sell order.
type DraftLine = {
  decision: 'accepted' | 'declined';
  acceptedQty: number;
  acceptedUnitPrice: number;
};

function VendorBidDetail({
  id, onClose, onToast, onOpenSellOrder, onChanged,
}: {
  id: string;
  onClose: () => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
  onOpenSellOrder?: (sellOrderId: string) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [bid, setBid] = useState<VbDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [promoteCustomerId, setPromoteCustomerId] = useState('');
  const needsCustomer = !!bid && !bid.customer_id;

  const fetchBid = (alive?: { v: boolean }) => {
    api.get<{ bid: VbDetail }>(`/api/vendor-bids/${id}`)
      .then(r => {
        if (alive && !alive.v) return;
        setBid(r.bid);
        const d: Record<string, DraftLine> = {};
        for (const l of r.bid.lines) {
          d[l.id] = {
            decision: l.line_status === 'declined' ? 'declined' : 'accepted',
            acceptedQty: l.accepted_qty ?? l.offered_qty,
            acceptedUnitPrice: l.accepted_unit_price ?? l.offered_unit_price,
          };
        }
        setDraft(d);
      })
      .catch(handleFetchError);
  };

  useEffect(() => {
    const alive = { v: true };
    fetchBid(alive);
    return () => { alive.v = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!needsCustomer) return;
    let alive = true;
    api.get<{ items: Customer[] }>('/api/customers')
      .then(r => { if (alive) setCustomers(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [needsCustomer]);

  useEscapeKey(onClose);

  const setLine = (lineId: string, patch: Partial<DraftLine>) =>
    setDraft(d => ({ ...d, [lineId]: { ...d[lineId]!, ...patch } }));

  // True when the local draft diverges from the persisted line state for ANY
  // line. A fresh bid defaults every non-declined line to 'accepted' while the
  // persisted line_status is still 'pending' → dirty, which is exactly the
  // case that must block Promote until the manager Saves.
  const dirty = useMemo(() => {
    if (!bid) return false;
    return bid.lines.some(l => {
      const d = draft[l.id];
      if (!d) return false;
      if (d.decision !== l.line_status) return true;
      if (d.decision === 'accepted') {
        if (d.acceptedQty !== (l.accepted_qty ?? l.offered_qty)) return true;
        if (d.acceptedUnitPrice !== (l.accepted_unit_price ?? l.offered_unit_price)) return true;
      }
      return false;
    });
  }, [bid, draft]);

  // Lines the backend will actually consume on promote: PERSISTED accepted and
  // not yet promoted (sell_order_id null). Derived from persisted state only,
  // never from the unsaved draft.
  const persistedPromotable = useMemo(() => {
    if (!bid) return 0;
    return bid.lines.filter(l => l.line_status === 'accepted' && !l.sell_order_id).length;
  }, [bid]);

  // All-accepted-but-already-promoted: nothing left to promote because the
  // accepted lines already carry a sell_order_id. Derived from lines, not the
  // ambiguous 400 message.
  const allPromoted = useMemo(() => {
    if (!bid) return false;
    const accepted = bid.lines.filter(l => l.line_status === 'accepted');
    return accepted.length > 0 && accepted.every(l => l.sell_order_id != null);
  }, [bid]);

  // USD-equivalent of what the Promote click will actually consume: persisted
  // accepted lines not yet promoted, valued at this bid's frozen FX rate.
  const promoteTotalUsd = useMemo(() => {
    if (!bid) return 0;
    return bid.lines
      .filter(l => l.line_status === 'accepted' && !l.sell_order_id)
      .reduce((s, l) => s + (l.accepted_unit_price ?? 0) * (l.accepted_qty ?? 0) * bid.fxRateToUsd, 0);
  }, [bid]);

  const save = async () => {
    if (!bid) return;
    setSaving(true);
    try {
      await api.post(`/api/vendor-bids/${bid.id}/decide`, {
        lines: bid.lines.map(l => {
          const d = draft[l.id]!;
          return d.decision === 'accepted'
            ? {
                lineId: l.id,
                decision: 'accepted' as const,
                acceptedQty: d.acceptedQty,
                acceptedUnitPrice: d.acceptedUnitPrice,
              }
            : { lineId: l.id, decision: 'declined' as const };
        }),
      });
      onToast?.(t('vbDecisionsSaved'), 'success');
      fetchBid();
      onChanged();
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const promote = async () => {
    if (!bid) return;
    // Belt-and-suspenders: never fire the endpoint with unsaved decisions —
    // the backend filters on persisted state and would 400 with a raw error.
    if (dirty) {
      onToast?.(t('vbSaveFirst'), 'error');
      return;
    }
    setPromoting(true);
    try {
      const r = await api.post<{ sellOrderId: string }>(
        `/api/vendor-bids/${bid.id}/promote`,
        needsCustomer ? { customerId: promoteCustomerId } : {},
      );
      onToast?.(t('vbPromoted', { id: r.sellOrderId }), 'success');
      onChanged();
      onClose();
      onOpenSellOrder?.(r.sellOrderId);
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 1000, width: 'calc(100vw - 80px)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            {bid ? (
              <>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono">{bid.id}</span>
                  <span className={'chip dot ' + toneFor(bid.status)}>
                    {t(STATUSES.find(s => s.id === bid.status)?.tKey ?? 'vbColStatus')}
                  </span>
                  {bid.currency !== 'USD' && (
                    <span className="chip dot muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                      {t('vb.detail.fx_badge', {
                        currency: bid.currency,
                        rate: (1 / bid.fxRateToUsd).toFixed(4),
                        date: bid.created_at.slice(0, 10),
                        source: bid.fxSource === 'frankfurter'
                          ? t('fx.source.frankfurter')
                          : bid.fxSource === 'manual'
                            ? t('fx.source.manual')
                            : bid.fxSource,
                      })}
                    </span>
                  )}
                </div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>
                  {bid.customer_name ?? t('vbGeneralLink')}
                </h2>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {fmtDate(bid.created_at, locale)}
                  {bid.contact_name ? ` · ${bid.contact_name}` : ''}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, minWidth: 280 }}>
                <span className="skeleton" style={{ width: 220, height: 22, borderRadius: 6, display: 'inline-block' }} aria-hidden />
              </div>
            )}
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: '18px 24px', overflowY: 'auto', flex: 1, maxHeight: '70vh' }}>
          {!bid ? (
            <FormSkeleton fields={6} withHeader={false} />
          ) : (
            <>
              {bid.note && (
                <div style={{
                  marginBottom: 16, padding: '8px 12px', borderRadius: 8,
                  background: 'var(--bg-subtle)', fontSize: 12.5, color: 'var(--fg)',
                }}>
                  <strong style={{ color: 'var(--fg-subtle)' }}>{t('vbNote')}:</strong> {bid.note}
                </div>
              )}
              <table className="so-line-table">
                <thead>
                  <tr>
                    <th>{t('vbColItem')}</th>
                    <th className="num">{t('vbColOfferedQty')}</th>
                    <th className="num">{t('vbColOfferedPrice')}</th>
                    <th className="num">USD</th>
                    <th className="num">{t('vbColAvailable')}</th>
                    <th>{t('vbColDecision')}</th>
                    <th className="num">{t('vbColAcceptQty')}</th>
                    <th className="num">{t('vbColAcceptPrice')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bid.lines.map(l => {
                    const d = draft[l.id];
                    if (!d) return null;
                    const over = l.available < l.offered_qty;
                    const accepted = d.decision === 'accepted';
                    const promoted = l.sell_order_id != null;
                    return (
                      <tr key={l.id} style={promoted ? { opacity: 0.6 } : undefined}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{l.label}</div>
                          {l.sub_label && (
                            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{l.sub_label}</div>
                          )}
                          {promoted && (
                            <div style={{ fontSize: 11, color: 'var(--accent-strong)' }}>
                              {t('vbAlreadyPromoted', { id: l.sell_order_id! })}
                            </div>
                          )}
                        </td>
                        <td className="num mono">{l.offered_qty}</td>
                        <td className="num mono">{fmtMoney(l.offered_unit_price, bid.currency, locale)}</td>
                        <td className="num mono" style={{ color: 'var(--fg-subtle)' }}>
                          {bid.currency === 'USD' ? '' : fmtUSD(l.unitPriceUsd, locale)}
                        </td>
                        <td
                          className="num mono"
                          style={over ? { color: 'var(--warn-strong, var(--danger))', fontWeight: 600 } : undefined}
                          title={over ? t('vbOverAvailable', { n: l.available }) : undefined}
                        >
                          {l.available}{over ? ' ⚠' : ''}
                        </td>
                        <td>
                          <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
                            <button
                              type="button"
                              className={'btn sm' + (accepted ? ' accent' : '')}
                              disabled={promoted}
                              onClick={() => setLine(l.id, { decision: 'accepted' })}
                              style={{ borderRadius: 0, border: 'none' }}
                            >
                              {t('vbAccept')}
                            </button>
                            <button
                              type="button"
                              className={'btn sm' + (!accepted ? ' accent' : '')}
                              disabled={promoted}
                              onClick={() => setLine(l.id, { decision: 'declined' })}
                              style={{ borderRadius: 0, border: 'none' }}
                            >
                              {t('vbDecline')}
                            </button>
                          </div>
                        </td>
                        <td className="num">
                          <input
                            className="so-mini-input"
                            type="number"
                            min={0}
                            max={l.available}
                            step={1}
                            value={d.acceptedQty}
                            disabled={!accepted || promoted}
                            onChange={e => setLine(l.id, { acceptedQty: Math.min(l.available, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                            style={{ width: 72 }}
                          />
                        </td>
                        <td className="num">
                          <input
                            className="so-mini-input"
                            type="number"
                            step="0.01"
                            min={0}
                            value={d.acceptedUnitPrice}
                            disabled={!accepted || promoted}
                            onChange={e => setLine(l.id, { acceptedUnitPrice: Math.max(0, Number(e.target.value) || 0) })}
                            style={{ width: 90 }}
                          />
                          {bid.currency !== 'USD' && d.acceptedUnitPrice > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                              {t('vb.detail.accepted_usd_hint', { usd: fmtUSD(d.acceptedUnitPrice * bid.fxRateToUsd, locale) })}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        {bid && (
          <div className="so-footer">
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {allPromoted ? t('vbAllPromoted') : ''}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {needsCustomer && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {t('vbPromotePickCustomer')}
                  </span>
                  <CustomerPicker
                    customers={customers}
                    value={promoteCustomerId}
                    onChange={setPromoteCustomerId}
                    onCreated={c => setCustomers(prev => [...prev, c])}
                  />
                </div>
              )}
              {dirty && (
                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  {t('vbSaveFirst')}
                </span>
              )}
              <button className="btn" onClick={onClose}>{t('vbClose')}</button>
              <button className="btn" onClick={save} disabled={saving}>
                <Icon name="check2" size={14} /> {saving ? t('vbSaving') : t('vbSaveDecisions')}
              </button>
              <button
                className="btn accent"
                onClick={promote}
                disabled={promoting || dirty || persistedPromotable === 0 || (needsCustomer && !promoteCustomerId)}
                title={dirty ? t('vbSaveFirst') : persistedPromotable === 0 ? t('vbAllPromoted') : undefined}
              >
                <Icon name="invoice" size={14} />{' '}
                {promoting
                  ? t('vbPromoting')
                  : bid.currency !== 'USD'
                    ? t('vb.detail.promote_with_usd', { usd: fmtUSD(promoteTotalUsd, locale) })
                    : t('vbPromote', { n: persistedPromotable })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vendor-links manager ────────────────────────────────────────────────────
// Single surface for the manager to mint/copy/revoke per-customer public bid
// tokens. Replaces the old per-customer panel that was buried inside the
// Settings → Customers edit modal. Sorted with link-less customers last so the
// active links (copy/revoke surface) sit at the top.
type VendorLinkRow = {
  customerId: string;
  customerName: string;
  customerShort: string | null;
  region: string | null;
  active: boolean;
  link: {
    id: string;
    token: string;
    createdAt: string | null;
    lastSeenAt: string | null;
    bidCount: number;
  } | null;
};

type GeneralLink = {
  id: string;
  token: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  bidCount: number;
};

function VendorLinksManager({
  onClose, onToast,
}: {
  onClose: () => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [rows, setRows] = useState<VendorLinkRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Row IDs that just got a fresh link this session — used to drive the
  // reveal animation so the manager visually confirms the generate action.
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

  const [general, setGeneral] = useState<GeneralLink | null>(null);
  const reload = () => api.get<{ items: VendorLinkRow[]; general: GeneralLink | null }>('/api/customers/vendor-links')
    .then(r => { setRows(r.items); setGeneral(r.general); })
    .catch(e => onToast?.(e instanceof Error ? e.message : 'Failed to load vendor links', 'error'))
    .finally(() => setLoaded(true));
  useEffect(() => { reload(); }, []);

  useEscapeKey(onClose);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.customerName.toLowerCase().includes(q)
      || (r.customerShort ?? '').toLowerCase().includes(q)
      || (r.region ?? '').toLowerCase().includes(q));
  }, [rows, search]);

  const stats = useMemo(() => {
    const active = rows.filter(r => r.link).length;
    const bids = rows.reduce((s, r) => s + (r.link?.bidCount ?? 0), 0);
    const missing = rows.length - active;
    return { active, bids, missing };
  }, [rows]);

  const urlFor = (token: string) => `${location.origin}/v/${token}`;

  const generate = async (row: VendorLinkRow) => {
    setBusyId(row.customerId);
    try {
      await api.post(`/api/customers/${row.customerId}/vendor-link`, {});
      // Mark this row "fresh" so the new URL chip animates in.
      setFlashIds(prev => {
        const next = new Set(prev);
        next.add(row.customerId);
        return next;
      });
      window.setTimeout(() => {
        setFlashIds(prev => {
          const next = new Set(prev);
          next.delete(row.customerId);
          return next;
        });
      }, 1400);
      await reload();
      onToast?.(t('vendorLinkGenerated', { name: row.customerName }), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to generate vendor link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (row: VendorLinkRow) => {
    if (!row.link) return;
    if (!window.confirm(t('vendorLinkRevokeConfirm', { name: row.customerName }))) return;
    setBusyId(row.customerId);
    try {
      await api.patch(`/api/customers/vendor-link/${row.link.id}`, { active: false });
      await reload();
      onToast?.(t('vendorLinkRevoked', { name: row.customerName }), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to revoke vendor link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const copy = (row: VendorLinkRow) => {
    if (!row.link) return;
    shareOrCopy({
      url: urlFor(row.link.token),
      title: t('vendorLink'),
      copiedMsg: t('vendorLinkCopied'),
      failedMsg: t('orderIdCopyFailed'),
      onToast,
    });
  };

  const generateGeneral = async () => {
    setBusyId('__general__');
    try {
      await api.post('/api/customers/vendor-links', {});
      await reload();
      onToast?.(t('vendorLinksGeneralGenerated'), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to generate general link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const revokeGeneral = async () => {
    if (!general) return;
    if (!window.confirm(t('vendorLinksGeneralRevokeConfirm'))) return;
    setBusyId('__general__');
    try {
      await api.patch(`/api/customers/vendor-link/${general.id}`, { active: false });
      await reload();
      onToast?.(t('vendorLinksGeneralRevoked'), 'success');
    } catch (e) {
      onToast?.(e instanceof Error ? e.message : 'Failed to revoke general link', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const copyGeneral = () => {
    if (!general) return;
    shareOrCopy({
      url: urlFor(general.token),
      title: t('vendorLink'),
      copiedMsg: t('vendorLinkCopied'),
      failedMsg: t('orderIdCopyFailed'),
      onToast,
    });
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 980, width: 'calc(100vw - 80px)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {t('vendorLinksOverline')}
            </div>
            <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{t('vendorLinksTitle')}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 4, maxWidth: 640 }}>
              {t('vendorLinksSub')}
            </div>
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <VlStat label={t('vendorLinksStatActive')} value={stats.active} tone="pos" />
          <VlStat label={t('vendorLinksStatBids')} value={stats.bids} />
          <VlStat label={t('vendorLinksStatMissing')} value={stats.missing} tone={stats.missing > 0 ? 'warn' : 'muted'} />
          <div style={{ flex: 1 }} />
          <div className="settings-search" style={{ minWidth: 240 }}>
            <Icon name="search" size={13} />
            <input
              type="text"
              placeholder={t('vendorLinksSearchPh')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('vendorLinksGeneralTitle')}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2, maxWidth: 560 }}>
                {t('vendorLinksGeneralSub')}
              </div>
              {general && (
                <div className="vl-url" title={urlFor(general.token)} style={{ marginTop: 10 }}>
                  <span className="vl-dot" aria-hidden />
                  <span className="vl-url-text mono">{urlFor(general.token)}</span>
                </div>
              )}
              {general && (
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 6, display: 'flex', gap: 12 }}>
                  <span>{t('vendorLinksColBids')}: {general.bidCount}</span>
                  <span>
                    {t('vendorLinksColLastSeen')}: {general.lastSeenAt
                      ? relTime(general.lastSeenAt, locale)
                      : t('vendorLinksNeverSeen')}
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
              {general ? (
                <>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={copyGeneral}>
                    <Icon name="paperclip" size={12} /> {t('vendorLinkCopy')}
                  </button>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={generateGeneral}>
                    {t('vendorLinksGeneralRegenerate')}
                  </button>
                  <button className="btn sm" disabled={busyId === '__general__'} onClick={revokeGeneral} style={{ color: 'var(--neg)' }}>
                    {t('vendorLinkRevoke')}
                  </button>
                </>
              ) : (
                <button className="btn sm accent" disabled={busyId === '__general__'} onClick={generateGeneral}>
                  <Icon name="globe" size={12} /> {t('vendorLinksGeneralGenerate')}
                </button>
              )}
            </div>
          </div>
        </div>

        <div style={{ padding: '8px 0 0', overflowY: 'auto', flex: 1, maxHeight: '64vh' }}>
          {!loaded ? (
            <div style={{ padding: '0 24px 16px' }}>
              <TableSkeleton rows={6} cols={4} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
              {rows.length === 0 ? t('vendorLinksEmpty') : t('vendorLinksNoMatch')}
            </div>
          ) : (
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 24 }}>{t('vbColCustomer')}</th>
                  <th>{t('vendorLinksColLink')}</th>
                  <th className="num">{t('vendorLinksColBids')}</th>
                  <th>{t('vendorLinksColLastSeen')}</th>
                  <th style={{ paddingRight: 24, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const isBusy = busyId === row.customerId;
                  const fresh = flashIds.has(row.customerId);
                  return (
                    <tr key={row.customerId} className="row-hover">
                      <td style={{ paddingLeft: 24 }}>
                        <div style={{ fontWeight: 500 }}>{row.customerName}</div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8 }}>
                          {row.customerShort && <span>{row.customerShort}</span>}
                          {row.region && <span>· {row.region}</span>}
                        </div>
                      </td>
                      <td style={{ minWidth: 360 }}>
                        {row.link ? (
                          <div
                            className={fresh ? 'vl-url vl-url-fresh' : 'vl-url'}
                            title={urlFor(row.link.token)}
                          >
                            <span className="vl-dot" aria-hidden />
                            <span className="vl-url-text mono">{urlFor(row.link.token)}</span>
                          </div>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                            {t('vendorLinksNone')}
                          </span>
                        )}
                      </td>
                      <td className="num mono">{row.link?.bidCount ?? 0}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {row.link?.lastSeenAt
                          ? relTime(row.link.lastSeenAt, locale)
                          : row.link
                            ? <span style={{ color: 'var(--fg-subtle)' }}>{t('vendorLinksNeverSeen')}</span>
                            : '—'}
                      </td>
                      <td style={{ paddingRight: 24, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {row.link ? (
                          <div style={{ display: 'inline-flex', gap: 4 }}>
                            <button
                              className="btn sm"
                              disabled={isBusy}
                              onClick={() => copy(row)}
                              title={t('vendorLinkCopy')}
                            >
                              <Icon name="paperclip" size={12} /> {t('vendorLinkCopy')}
                            </button>
                            <button
                              className="btn sm"
                              disabled={isBusy}
                              onClick={() => revoke(row)}
                              style={{ color: 'var(--neg)' }}
                              title={t('vendorLinkRevoke')}
                            >
                              {t('vendorLinkRevoke')}
                            </button>
                          </div>
                        ) : (
                          <button
                            className="btn sm accent"
                            disabled={isBusy}
                            onClick={() => generate(row)}
                          >
                            <Icon name="globe" size={12} /> {isBusy ? t('vendorLinkGenerating') : t('vendorLinkGenerate')}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="so-footer">
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {t('vendorLinksHint')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>{t('vbClose')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function VlStat({ label, value, tone }: { label: string; value: number; tone?: 'pos' | 'warn' | 'muted' }) {
  const color =
    tone === 'pos' ? 'var(--pos, var(--accent-strong))'
    : tone === 'warn' ? 'var(--warn, var(--neg))'
    : 'var(--fg)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 88 }}>
      <span style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span style={{ fontSize: 20, fontWeight: 600, color, lineHeight: 1, fontFeatureSettings: "'tnum'" }}>
        {value}
      </span>
    </div>
  );
}
