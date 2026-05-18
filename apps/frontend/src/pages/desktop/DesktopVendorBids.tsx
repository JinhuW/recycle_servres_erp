import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { useRoute, navigate, match } from '../../lib/route';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { fmtUSD, fmtUSD0, fmtDate, fmtDateShort } from '../../lib/format';
import { TableSkeleton, FormSkeleton } from '../../components/Skeleton';

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
  customer_name: string;
  customer_short: string | null;
  line_count: number;
  total_offered: number;
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
};

type VbDetail = {
  id: string;
  contact_name: string | null;
  note: string | null;
  status: VbStatus;
  created_at: string;
  customer_id: string;
  customer_name: string;
  lines: VbLine[];
};

const toneFor = (s: VbStatus) => STATUSES.find(o => o.id === s)?.tone ?? 'muted';

type VendorBidsProps = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
  onOpenSellOrder?: (sellOrderId: string) => void;
};

export function DesktopVendorBids({ onToast, onOpenSellOrder }: VendorBidsProps = {}) {
  const { t } = useT();
  const [bids, setBids] = useState<VbSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | VbStatus>('all');
  const { path } = useRoute();
  const openMatch = match('/vendor-bids/:id', path);
  const openId = openMatch?.id ?? null;

  const load = (alive?: { v: boolean }) => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    api.get<{ items: VbSummary[] }>(`/api/vendor-bids?${p}`)
      .then(r => { if (!alive || alive.v) setBids(r.items); })
      .catch(console.error)
      .finally(() => { if (!alive || alive.v) setLoadedOnce(true); });
  };

  useEffect(() => {
    const alive = { v: true };
    load(alive);
    return () => { alive.v = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const stats = useMemo(() => {
    const m: Record<string, { count: number; offered: number }> = {};
    for (const s of STATUSES) m[s.id] = { count: 0, offered: 0 };
    bids.forEach(b => { m[b.status].count++; m[b.status].offered += b.total_offered; });
    return m;
  }, [bids]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('vendorBids')}</h1>
          <div className="page-sub">{t('vendorBidsSub')}</div>
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
              <div className="so-stat-sub">{fmtUSD0(stats[s].offered)}</div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="select"
              style={{ width: 180, height: 32, fontSize: 12.5 }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">{t('vbColStatus')}</option>
              {STATUSES.map(s => <option key={s.id} value={s.id}>{t(s.tKey)}</option>)}
            </select>
          </div>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={6} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('vbColCustomer')}</th>
                <th>{t('vbColContact')}</th>
                <th className="num">{t('vbColLines')}</th>
                <th className="num">{t('vbColOffered')}</th>
                <th>{t('vbColSubmitted')}</th>
                <th>{t('vbColStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {bids.map(b => (
                <tr
                  key={b.id}
                  className="row-hover"
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate('/vendor-bids/' + b.id)}
                >
                  <td>
                    <div style={{ fontWeight: 500 }}>{b.customer_name}</div>
                    {b.customer_short && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{b.customer_short}</div>
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
                  <td className="num mono">{b.line_count}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>{fmtUSD0(b.total_offered)}</td>
                  <td className="muted">{fmtDateShort(b.created_at)}</td>
                  <td><span className={'chip dot ' + toneFor(b.status)}>{t(STATUSES.find(s => s.id === b.status)?.tKey ?? 'vbColStatus')}</span></td>
                </tr>
              ))}
              {bids.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
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
  const { t } = useT();
  const [bid, setBid] = useState<VbDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);

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
      .catch(console.error);
  };

  useEffect(() => {
    const alive = { v: true };
    fetchBid(alive);
    return () => { alive.v = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
      const r = await api.post<{ sellOrderId: string }>(`/api/vendor-bids/${bid.id}/promote`, {});
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
                </div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{bid.customer_name}</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {fmtDate(bid.created_at)}
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
                        <td className="num mono">{fmtUSD(l.offered_unit_price)}</td>
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
                disabled={promoting || dirty || persistedPromotable === 0}
                title={dirty ? t('vbSaveFirst') : persistedPromotable === 0 ? t('vbAllPromoted') : undefined}
              >
                <Icon name="invoice" size={14} />{' '}
                {promoting ? t('vbPromoting') : t('vbPromote', { n: persistedPromotable })}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
