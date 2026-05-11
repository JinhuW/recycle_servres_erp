import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, fmtDate, fmtDateShort } from '../../lib/format';

type SellOrderSummary = {
  id: string;
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done';
  discountPct: number;
  notes: string | null;
  createdAt: string;
  customer: { id: string; name: string; short: string; terms: string };
  lineCount: number;
  qty: number;
  subtotal: number;
  discount: number;
  total: number;
};

type SellOrderLine = {
  id: string;
  category: 'RAM' | 'SSD' | 'Other';
  label: string;
  sub: string | null;
  partNumber: string | null;
  qty: number;
  unitPrice: number;
  condition: string | null;
  warehouse: string | null;
  lineTotal: number;
  position: number;
};

type SellOrderDetailType = {
  id: string;
  status: SellOrderSummary['status'];
  notes: string | null;
  createdAt: string;
  discountPct: number;
  customer: { id: string; name: string; short: string; terms: string; region: string };
  lines: SellOrderLine[];
  subtotal: number;
  discount: number;
  total: number;
};

const STATUSES = ['Draft', 'Shipped', 'Awaiting payment', 'Done'] as const;
const TONE: Record<string, string> = {
  'Draft': 'muted',
  'Shipped': 'info',
  'Awaiting payment': 'warn',
  'Done': 'pos',
};
const SHORT: Record<string, string> = {
  'Draft': 'Draft',
  'Shipped': 'Shipped',
  'Awaiting payment': 'Awaiting pay',
  'Done': 'Done',
};

type SellOrdersProps = {
  onNewFromInventory?: () => void;
};

export function DesktopSellOrders({ onNewFromInventory }: SellOrdersProps = {}) {
  const { t } = useT();
  const [orders, setOrders] = useState<SellOrderSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | typeof STATUSES[number]>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = () => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`).then(r => setOrders(r.items));
  };
  useEffect(reload, [statusFilter]);

  const visible = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(o =>
      o.id.toLowerCase().includes(q) || o.customer.name.toLowerCase().includes(q),
    );
  }, [orders, search]);

  const stats = useMemo(() => {
    const m: Record<string, { count: number; revenue: number }> = {};
    for (const s of STATUSES) m[s] = { count: 0, revenue: 0 };
    orders.forEach(o => { m[o.status].count++; m[o.status].revenue += o.total; });
    return m;
  }, [orders]);

  const advance = async (id: string, current: typeof STATUSES[number]) => {
    const idx = STATUSES.indexOf(current);
    if (idx === -1 || idx >= STATUSES.length - 1) return;
    await api.patch(`/api/sell-orders/${id}`, { status: STATUSES[idx + 1] });
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('sellOrders')}</h1>
          <div className="page-sub">{t('sellOrdersSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={14} /> {t('export')}</button>
          {onNewFromInventory && (
            <button className="btn accent" onClick={onNewFromInventory}>
              <Icon name="plus" size={14} /> New from inventory
            </button>
          )}
        </div>
      </div>

      {/* Status pipeline tiles — click to filter, matches design's so-stat */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {STATUSES.map(s => {
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
                <span className={'chip ' + TONE[s] + ' dot'} style={{ fontSize: 10.5 }}>{SHORT[s]}</span>
              </div>
              <div className="so-stat-num">{stats[s].count}</div>
              <div className="so-stat-sub">{fmtUSD0(stats[s].revenue)}</div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="select"
              style={{ width: 160, height: 32, fontSize: 12.5 }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ position: 'relative' }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              className="input"
              placeholder="Search order, customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 260 }}
            />
          </div>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Created</th>
                <th className="num">Lines</th>
                <th className="num">Units</th>
                <th className="num">Total</th>
                <th>Terms</th>
                <th>Status</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(o => (
                <tr
                  key={o.id}
                  className="row-hover"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setOpenId(o.id)}
                >
                  <td className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>{o.id}</td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{o.customer.short || o.customer.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{o.customer.name}</div>
                  </td>
                  <td className="muted">{fmtDateShort(o.createdAt)}</td>
                  <td className="num mono">{o.lineCount}</td>
                  <td className="num mono">{o.qty}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>{fmtUSD0(o.total)}</td>
                  <td><span className="chip">{o.customer.terms}</span></td>
                  <td><span className={'chip dot ' + TONE[o.status]}>{o.status}</span></td>
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn icon sm" title="View" onClick={() => setOpenId(o.id)}>
                        <Icon name="eye" size={12} />
                      </button>
                      {o.status !== 'Done' && (
                        <button
                          className="btn icon sm"
                          title="Advance status"
                          onClick={() => advance(o.id, o.status)}
                        >
                          <Icon name="arrow" size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
                    No orders match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {openId && (
        <SellOrderDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onAdvance={(o) => { advance(o.id, o.status); setOpenId(null); }}
        />
      )}
    </>
  );
}

// ─── Detail panel — read-only line items, totals, advance action ─────────────
function SellOrderDetail({
  id, onClose, onAdvance,
}: {
  id: string;
  onClose: () => void;
  onAdvance: (o: SellOrderDetailType) => void;
}) {
  const [order, setOrder] = useState<SellOrderDetailType | null>(null);

  useEffect(() => {
    api.get<{ order: SellOrderDetailType }>(`/api/sell-orders/${id}`)
      .then(r => setOrder(r.order))
      .catch(console.error);
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 760, width: 'calc(100vw - 80px)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            {order && (
              <>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono">{order.id}</span>
                  <span className={'chip dot ' + TONE[order.status]}>{order.status}</span>
                </div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{order.customer.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {fmtDate(order.createdAt)} · {order.customer.region} · {order.customer.terms}
                </div>
              </>
            )}
            {!order && <div style={{ fontSize: 14, color: 'var(--fg-subtle)' }}>Loading…</div>}
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: '18px 24px', overflowY: 'auto', flex: 1, maxHeight: '70vh' }}>
          {order ? (
            <>
              <table className="so-line-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Warehouse</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map(l => (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{l.label}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{l.partNumber}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{l.warehouse ?? '—'}</td>
                      <td className="num mono">{l.qty}</td>
                      <td className="num mono">{fmtUSD(l.unitPrice)}</td>
                      <td className="num mono" style={{ fontWeight: 500 }}>{fmtUSD(l.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 20, marginLeft: 'auto', maxWidth: 280 }}>
                <div className="so-row"><span>Subtotal</span><span className="mono">{fmtUSD(order.subtotal)}</span></div>
                {order.discount > 0 && (
                  <div className="so-row muted">
                    <span>Discount ({(order.discountPct * 100).toFixed(0)}%)</span>
                    <span className="mono">−{fmtUSD(order.discount)}</span>
                  </div>
                )}
                <div className="so-row total"><span>Total</span><span className="mono">{fmtUSD(order.total)}</span></div>
              </div>
            </>
          ) : null}
        </div>

        {order && (
          <div className="so-footer">
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {order.notes ? `Notes: ${order.notes}` : 'No internal notes'}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>Close</button>
              {order.status !== 'Done' && (
                <button className="btn accent" onClick={() => onAdvance(order)}>
                  <Icon name="arrow" size={14} /> Advance to {STATUSES[STATUSES.indexOf(order.status) + 1]}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
