import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../lib/format';
import { ORDER_STATUSES, isCompleted, statusTone } from '../lib/status';
import type { OrderSummary, Order } from '../lib/types';

type Props = {
  onEdit: (o: Order) => void;
};

export function Orders({ onEdit }: Props) {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    api.get<{ orders: OrderSummary[] }>(`/api/orders?${params}`)
      .then(r => setOrders(r.orders))
      .catch(console.error);
  }, [filter, statusFilter]);

  // When a row is expanded, fetch its lines lazily.
  useEffect(() => {
    if (!openId) { setOpenLines(null); return; }
    api.get<{ order: Order }>(`/api/orders/${openId}`)
      .then(r => setOpenLines(r.order))
      .catch(console.error);
  }, [openId]);

  return (
    <>
      <PhHeader
        title={t('ordersHeading')}
        sub={t('ordersSubmitted', { n: orders.length })}
        trailing={<button className="ph-icon-btn"><Icon name="search" size={16} /></button>}
      />
      <div className="ph-scroll">
        <div className="ph-chip-scroller">
          {(['all', 'RAM', 'SSD', 'Other'] as const).map(f => (
            <button key={f} className={'ph-chip-btn ' + (filter === f ? 'active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('filterAll') : f}
            </button>
          ))}
        </div>
        <div className="ph-chip-scroller" style={{ marginTop: -2 }}>
          <button className={'ph-chip-btn ' + (statusFilter === 'all' ? 'active' : '')} onClick={() => setStatusFilter('all')}>
            {t('anyStatus')}
          </button>
          {ORDER_STATUSES.map(s => (
            <button key={s} className={'ph-chip-btn ' + (statusFilter === s ? 'active' : '')} onClick={() => setStatusFilter(s)}>
              {s}
            </button>
          ))}
        </div>

        {orders.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('noOrdersMatch')}
          </div>
        )}

        {orders.slice(0, 30).map(o => {
          const isOpen = openId === o.id;
          return (
            <div key={o.id} className="ph-order">
              <div className="ph-order-head" onClick={() => setOpenId(isOpen ? null : o.id)} style={{ cursor: 'pointer' }}>
                <span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : 'warn')} style={{ minWidth: 42, justifyContent: 'center' }}>
                  {o.category}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{o.id}</span>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {o.lineCount} {o.lineCount === 1 ? t('item') : t('items')}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmtDateShort(o.createdAt)}{o.warehouse ? ' · ' + o.warehouse.short : ''} · <span style={{ color: 'var(--fg-muted)' }}>{o.status}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pos)' }}>+{fmtUSD0(o.profit)}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 1 }}>{fmtUSD0(o.revenue)}</div>
                </div>
                <Icon name="chevronDown" size={16} style={{ color: 'var(--fg-subtle)', transition: 'transform 0.18s', transform: isOpen ? 'rotate(180deg)' : 'none' }} />
              </div>
              {isOpen && openLines && openLines.id === o.id && (
                <div className="ph-order-body">
                  {openLines.lines.map(l => (
                    <div key={l.id} className="ph-line">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`}
                          {l.category === 'Other' && (l.description ?? '')}
                        </div>
                        <span className={'chip ' + statusTone(l.status) + ' dot'} style={{ fontSize: 10 }}>{l.status}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>{l.partNumber}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5 }}>
                        <span style={{ color: 'var(--fg-subtle)' }}>
                          Qty {l.qty} · {fmtUSD(l.unitCost)} {l.sellPrice != null && <>→ {fmtUSD(l.sellPrice)}</>}
                        </span>
                        {l.sellPrice != null && (
                          <span className="mono pos" style={{ fontWeight: 600, color: 'var(--pos)' }}>
                            +{fmtUSD0((l.sellPrice - l.unitCost) * l.qty)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={isCompleted(o.status)}
                      title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                      onClick={(e) => { e.stopPropagation(); if (!isCompleted(o.status)) onEdit(openLines); }}
                    >
                      <Icon name="edit" size={11} /> {t('edit')}
                    </button>
                  </div>
                </div>
              )}
              {isOpen && (!openLines || openLines.id !== o.id) && (
                <div className="ph-order-body" style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Loading…</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
