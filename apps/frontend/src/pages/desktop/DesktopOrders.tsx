import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { fmtUSD0, fmtDateShort, fmt0 } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import type { OrderSummary, Order } from '../../lib/types';

type Stage = {
  id: string;
  label: string;
  short: string;
  tone: string;
  icon: string;
  description: string;
  position: number;
};

// Map a stage tone keyword to a usable CSS variable. Same lookup as the
// design's lifecycleTone helper.
const TONE_VAR: Record<string, string> = {
  muted:  'var(--fg-subtle)',
  info:   'var(--info)',
  warn:   'var(--warn)',
  accent: 'var(--accent)',
  pos:    'var(--pos)',
};

type Props = {
  onEdit: (o: Order) => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function DesktopOrders({ onEdit, onToast }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';

  const [scope, setScope] = useState<'team' | 'mine'>(isManager ? 'team' : 'mine');
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [stageFilter, setStageFilter] = useState<'all' | string>('all');
  const [search, setSearch] = useState('');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);

  // Workflow stages — drives the manager-only pipeline cards at the top.
  useEffect(() => {
    if (!isManager) return;
    api.get<{ stages: Stage[] }>('/api/workflow').then(r => setStages(r.stages)).catch(() => {/* keep empty */});
  }, [isManager]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    api.get<{ orders: OrderSummary[] }>(`/api/orders?${params}`)
      .then(r => setOrders(r.orders))
      .catch(console.error);
  }, [filter, statusFilter]);

  useEffect(() => {
    if (!openId) { setOpenLines(null); return; }
    api.get<{ order: Order }>(`/api/orders/${openId}`)
      .then(r => setOpenLines(r.order))
      .catch(console.error);
  }, [openId]);

  // Client-side scope + search filter (server already filters by user when
  // role is purchaser; manager can flip between team and own).
  const visible = useMemo(() => {
    let rows = orders;
    if (isManager && scope === 'mine' && user) rows = rows.filter(o => o.userId === user.id);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(o => o.id.toLowerCase().includes(q) || o.userName.toLowerCase().includes(q));
    }
    return rows;
  }, [orders, scope, search, user, isManager]);

  // Apply stage filter on top of category/status (server-side handles those).
  const stageFiltered = useMemo(
    () => stageFilter === 'all' ? visible : visible.filter(o => o.lifecycle === stageFilter),
    [visible, stageFilter],
  );

  // KPI totals across the visible scope — matches design/dashboard.jsx#HistoryView.
  const totals = useMemo(() => stageFiltered.reduce(
    (acc, o) => {
      acc.orders++;
      acc.revenue += o.revenue;
      acc.profit  += o.profit;
      acc.lines   += o.lineCount;
      return acc;
    },
    { orders: 0, revenue: 0, profit: 0, lines: 0 },
  ), [stageFiltered]);

  // Aggregate count + revenue per workflow stage for the pipeline cards.
  const stageAgg = useMemo(() => {
    const m: Record<string, { count: number; revenue: number }> = {};
    stages.forEach(s => { m[s.id] = { count: 0, revenue: 0 }; });
    visible.forEach(o => {
      const k = o.lifecycle || 'draft';
      if (!m[k]) m[k] = { count: 0, revenue: 0 };
      m[k].count++;
      m[k].revenue += o.revenue;
    });
    return m;
  }, [visible, stages]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('purchaseOrders')}</h1>
          <div className="page-sub">{isManager ? t('purchaseOrdersMgr') : t('purchaseOrdersPurch')}</div>
        </div>
        <div className="page-actions">
          {isManager && (
            <div className="seg" role="tablist">
              <button className={scope === 'team' ? 'active' : ''} onClick={() => setScope('team')}>{t('allOrders')}</button>
              <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>{t('mineOnly')}</button>
            </div>
          )}
        </div>
      </div>

      {/* Manager-only workflow pipeline — click a card to filter the table by stage */}
      {isManager && stages.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px 6px', gap: 12, flexWrap: 'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                fontSize: 11, color: 'var(--fg-subtle)',
                textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600,
              }}>{t('statusFilters')}</div>
              <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{t('clickToFilter')}</span>
            </div>
            {stageFilter !== 'all' && (
              <button
                className="btn sm ghost"
                onClick={() => setStageFilter('all')}
                style={{ fontSize: 11 }}
              >
                {t('clearFilter')}
              </button>
            )}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${stages.length}, 1fr)`,
            gap: 0, padding: '0 8px 12px',
          }}>
            {stages.map((s, i) => {
              const agg = stageAgg[s.id] ?? { count: 0, revenue: 0 };
              const active = stageFilter === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setStageFilter(active ? 'all' : s.id)}
                  className="row-hover"
                  style={{
                    textAlign: 'left',
                    background: active ? 'var(--bg-soft)' : 'transparent',
                    border: 'none',
                    borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                    padding: '10px 14px',
                    cursor: 'pointer',
                    minWidth: 0, fontFamily: 'inherit',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: TONE_VAR[s.tone] ?? 'var(--fg-subtle)',
                      flexShrink: 0,
                    }} />
                    <span style={{
                      fontSize: 11.5, fontWeight: 600, color: 'var(--fg)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{s.label}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 19, fontWeight: 600, lineHeight: 1, color: 'var(--fg)' }}>{agg.count}</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 4 }}>{fmtUSD0(agg.revenue)}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{scope === 'mine' ? t('ordersSubmitted', { n: totals.orders }) : t('totalOrders')}</div>
          <div className="kpi-value mono">{totals.orders}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('totalRevenue')}</div>
          <div className="kpi-value mono">{fmtUSD0(totals.revenue)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('grossProfit')}</div>
          <div className="kpi-value mono" style={{ color: 'var(--pos)' }}>{fmtUSD0(totals.profit)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('lines')}</div>
          <div className="kpi-value mono">{fmt0(totals.lines)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              placeholder={t('searchOrderPart')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 240 }}
            />
            <div className="seg">
              {(['all', 'RAM', 'SSD', 'Other'] as const).map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? t('all') : f}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              className={'chip ' + (statusFilter === 'all' ? 'accent' : 'muted')}
              onClick={() => setStatusFilter('all')}
              style={{ cursor: 'pointer', border: 'none' }}
            >
              {t('all')}
            </button>
            {ORDER_STATUSES.map(s => (
              <button
                key={s}
                className={'chip ' + (statusFilter === s ? statusTone(s) : 'muted')}
                onClick={() => setStatusFilter(s)}
                style={{ cursor: 'pointer', border: 'none' }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>{t('orderId')}</th>
                <th>{t('date')}</th>
                <th>{t('submitter')}</th>
                <th>{t('category')}</th>
                <th>{t('warehouse')}</th>
                <th className="num">{t('lines')}</th>
                <th className="num">{t('qty')}</th>
                <th className="num">{t('revenue')}</th>
                <th className="num">{t('profit')}</th>
                <th>{t('status')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {stageFiltered.length === 0 && (
                <tr><td colSpan={12} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                  {t('noOrdersMatch')}
                </td></tr>
              )}
              {stageFiltered.map(o => (
                <Fragment key={o.id}>
                <tr className="row-hover" onClick={() => setOpenId(openId === o.id ? null : o.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <Icon name="chevronDown" size={13} style={{ transition: 'transform 0.15s', transform: openId === o.id ? 'rotate(180deg)' : 'none', color: 'var(--fg-subtle)' }} />
                  </td>
                  <td className="mono" style={{ fontWeight: 600 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {o.id}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const url = `${location.origin}${location.pathname}#/orders/${o.id}`;
                          const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
                          if (typeof share === 'function') {
                            share.call(navigator, { url, title: t('shareOrder') }).catch((err: Error) => {
                              if (err.name !== 'AbortError') onToast?.(t('orderIdCopyFailed'), 'error');
                            });
                          } else if (navigator.clipboard?.writeText) {
                            navigator.clipboard.writeText(url)
                              .then(() => onToast?.(t('orderIdCopied')))
                              .catch(() => onToast?.(t('orderIdCopyFailed'), 'error'));
                          } else {
                            onToast?.(t('orderIdCopyFailed'), 'error');
                          }
                        }}
                        aria-label={t('shareOrder')}
                        title={t('shareOrder')}
                        style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, marginLeft: 2, lineHeight: 0, cursor: 'pointer', verticalAlign: 'middle' }}
                      >
                        <Icon name="paperclip" size={12} />
                      </button>
                    </span>
                  </td>
                  <td className="muted">{fmtDateShort(o.createdAt)}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="avatar">{o.userInitials}</div>
                      <span>{o.userName.split(' ')[0]}</span>
                    </div>
                  </td>
                  <td><span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : 'warn')}>{o.category}</span></td>
                  <td className="muted">{o.warehouse?.short ?? '—'}</td>
                  <td className="num">{o.lineCount}</td>
                  <td className="num">{o.qty}</td>
                  <td className="num mono">{fmtUSD0(o.revenue)}</td>
                  <td className="num mono pos">+{fmtUSD0(o.profit)}</td>
                  <td><span className={'chip dot ' + statusTone(o.status)}>{o.status}</span></td>
                  <td>
                    <button
                      className="btn sm"
                      disabled={isCompleted(o.status)}
                      title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                      onClick={(e) => { e.stopPropagation(); openLines && openLines.id === o.id ? onEdit(openLines) : api.get<{ order: Order }>(`/api/orders/${o.id}`).then(r => onEdit(r.order)); }}
                    >
                      <Icon name="edit" size={12} /> {t('edit')}
                    </button>
                  </td>
                </tr>
                {openId === o.id && openLines && openLines.id === o.id && (
                  <tr>
                    <td colSpan={12} style={{ background: 'var(--bg-soft)', padding: 16 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 8 }}>
                        {t('lineItemsIn')} {o.id}
                      </div>
                      <table className="table" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <thead>
                          <tr>
                            <th>{t('item')}</th>
                            <th>{t('partNumber')}</th>
                            <th>{t('condition')}</th>
                            <th className="num">{t('qty')}</th>
                            <th className="num">{t('unitCost')}</th>
                            <th className="num">{t('sellUnit')}</th>
                            <th>{t('status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {openLines.lines.map(l => (
                            <tr key={l.id}>
                              <td>
                                {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`}
                                {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`}
                                {l.category === 'Other' && (l.description ?? '')}
                              </td>
                              <td className="mono muted">{l.partNumber}</td>
                              <td className="muted">{l.condition}</td>
                              <td className="num">{l.qty}</td>
                              <td className="num mono">{fmtUSD0(l.unitCost)}</td>
                              <td className="num mono">{l.sellPrice != null ? fmtUSD0(l.sellPrice) : '—'}</td>
                              <td><span className={'chip dot ' + statusTone(l.status)}>{l.status}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
