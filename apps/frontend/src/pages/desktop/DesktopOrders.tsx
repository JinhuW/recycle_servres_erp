import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { usePreference } from '../../lib/preferences';
import { api } from '../../lib/api';
import { fmtUSD0, fmtUSD, fmtDateShort, fmt0 } from '../../lib/format';
import { statusTone, isCompleted } from '../../lib/status';
import type { OrderSummary, Order } from '../../lib/types';
import { TableSkeleton } from '../../components/Skeleton';

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

// Commission isn't stored on the order — derive it from profit using a flat
// 5% rate, matching design/dashboard.jsx (`o.profit * (o.commissionRate || 0.05)`).
const COMMISSION_RATE = 0.05;
const commissionFor = (o: OrderSummary) => +(o.profit * COMMISSION_RATE).toFixed(2);

// Toggleable columns (matches design's TOGGLEABLE_COLS). Order chevron,
// Submitter, and Actions are always shown — the rest can be hidden.
const TOGGLEABLE_COLS = [
  { id: 'id',         label: 'Order ID' },
  { id: 'date',       label: 'Date' },
  { id: 'category',   label: 'Category' },
  { id: 'warehouse',  label: 'Warehouse' },
  { id: 'lines',      label: 'Lines' },
  { id: 'qty',        label: 'Qty' },
  { id: 'revenue',    label: 'Revenue' },
  { id: 'profit',     label: 'Profit' },
  { id: 'commission', label: 'Commission' },
  { id: 'payment',    label: 'Payment' },
  { id: 'status',     label: 'Status' },
] as const;
type ColId = typeof TOGGLEABLE_COLS[number]['id'];
const DEFAULT_ORDERS_COLS: ColId[] = TOGGLEABLE_COLS.map(c => c.id);

const SORT_KEYS: Record<string, (o: OrderSummary) => string | number> = {
  id:         o => o.id,
  date:       o => o.createdAt,
  submitter:  o => o.userName,
  category:   o => o.category,
  warehouse:  o => o.warehouse?.short ?? '',
  lines:      o => o.lineCount,
  qty:        o => o.qty,
  revenue:    o => o.revenue,
  profit:     o => o.profit,
  commission: o => commissionFor(o),
  payment:    o => o.payment,
  status:     o => o.status,
};

type SortState = { col: string; dir: 'asc' | 'desc' | null };

function SortCaret({ active, dir }: { active: boolean; dir: 'asc' | 'desc' | null }) {
  return (
    <svg
      width="9" height="11" viewBox="0 0 9 11"
      style={{ flexShrink: 0, opacity: active ? 1 : 0.32 }}
      aria-hidden="true"
    >
      <path d="M4.5 1.5 L1.5 4.5 H7.5 Z" fill={active && dir === 'asc'  ? 'var(--accent-strong)' : 'currentColor'} />
      <path d="M4.5 9.5 L7.5 6.5 H1.5 Z" fill={active && dir === 'desc' ? 'var(--accent-strong)' : 'currentColor'} />
    </svg>
  );
}

function SortTh({ col, sort, onSort, align, children }: {
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
  align?: 'right';
  children: ReactNode;
}) {
  const active = sort.col === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={align === 'right' ? 'num' : undefined}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? 'var(--fg)' : undefined }}>
        {children}
        <SortCaret active={active} dir={sort.dir} />
      </span>
    </th>
  );
}

type Props = {
  onEdit: (o: Order) => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function DesktopOrders({ onEdit, onToast }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';

  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'HDD' | 'Other'>('all');
  const [stageFilter, setStageFilter] = useState<'all' | string>('all');
  const [search, setSearch] = useState('');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);

  // Column-visibility — server-backed per-user preference. The hook returns
  // the canonical array; we project it to a Set for cheap membership checks.
  const [colsList, setColsList] = usePreference('orders.cols', DEFAULT_ORDERS_COLS);
  const visibleCols = useMemo(() => new Set(colsList as ColId[]), [colsList]);
  const isVis = (id: ColId) => visibleCols.has(id);
  const toggleCol = (id: ColId) => {
    const next = new Set(visibleCols);
    if (next.has(id)) next.delete(id); else next.add(id);
    setColsList([...next]);
  };

  // Columns dropdown menu open state + click-outside-to-close.
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colsMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (colsMenuRef.current && !colsMenuRef.current.contains(e.target as Node)) setColsMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [colsMenuOpen]);

  // Sortable columns: click cycles desc → asc → reset to default (date desc).
  const [sort, setSort] = useState<SortState>({ col: 'date', dir: 'desc' });
  const cycleSort = (col: string) => setSort(s => {
    if (s.col !== col) return { col, dir: 'desc' };
    if (s.dir === 'desc') return { col, dir: 'asc' };
    return { col: 'date', dir: 'desc' };
  });

  // Workflow stages — drives the manager-only pipeline cards at the top.
  useEffect(() => {
    if (!isManager) return;
    api.get<{ stages: Stage[] }>('/api/workflow').then(r => setStages(r.stages)).catch(() => {/* keep empty */});
  }, [isManager]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    api.get<{ orders: OrderSummary[] }>(`/api/orders?${params}`)
      .then(r => setOrders(r.orders))
      .catch(console.error)
      .finally(() => setLoadedOnce(true));
  }, [filter]);

  useEffect(() => {
    if (!openId) { setOpenLines(null); return; }
    api.get<{ order: Order }>(`/api/orders/${openId}`)
      .then(r => setOpenLines(r.order))
      .catch(console.error);
  }, [openId]);

  // Search filter — server already scopes by user (managers see all, others
  // see only their own).
  const visible = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(o => o.id.toLowerCase().includes(q) || o.userName.toLowerCase().includes(q));
  }, [orders, search]);

  // Apply stage filter on top of scope/search.
  const stageFiltered = useMemo(
    () => stageFilter === 'all' ? visible : visible.filter(o => o.lifecycle === stageFilter),
    [visible, stageFilter],
  );

  // Sort comes last — after all filters.
  const sorted = useMemo(() => {
    if (!sort.dir) return stageFiltered;
    const get = SORT_KEYS[sort.col];
    if (!get) return stageFiltered;
    return [...stageFiltered].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va < vb) return sort.dir === 'asc' ? -1 : 1;
      if (va > vb) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [stageFiltered, sort]);

  // KPI totals across the visible scope — matches design/dashboard.jsx#HistoryView.
  const totals = useMemo(() => stageFiltered.reduce(
    (acc, o) => {
      acc.orders++;
      acc.revenue += o.revenue;
      acc.profit  += o.profit;
      acc.commission += commissionFor(o);
      acc.lines   += o.lineCount;
      return acc;
    },
    { orders: 0, revenue: 0, profit: 0, commission: 0, lines: 0 },
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

  // colSpan for the expanded row — covers chevron + every toggleable col + actions,
  // regardless of which are currently hidden via display:none.
  const totalCols = 1 + TOGGLEABLE_COLS.length + 1 + 1; // chevron + toggleable + submitter + actions

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('purchaseOrders')}</h1>
          <div className="page-sub">{isManager ? t('purchaseOrdersMgr') : t('purchaseOrdersPurch')}</div>
        </div>
        <div className="page-actions" />
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
          <div className="kpi-label">{isManager ? t('totalOrders') : t('ordersSubmitted', { n: totals.orders })}</div>
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
          <div className="kpi-label">{isManager ? t('commissionPaid') : t('commissionEarned')}</div>
          <div className="kpi-value mono">{fmtUSD0(totals.commission)}</div>
        </div>
      </div>

      <div className="card orders-card">
        <div className="card-head" style={{ gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="card-title">{t('allOrders')}</div>
            <div className="seg">
              {(['all', 'RAM', 'SSD', 'HDD', 'Other'] as const).map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? t('all') : f}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{fmt0(totals.lines)} {t('lines').toLowerCase()}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--fg-subtle)',
              }} />
              <input
                className="input"
                placeholder={t('searchOrderPart')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 220 }}
              />
            </div>
            <div ref={colsMenuRef} style={{ position: 'relative' }}>
              <button
                className="btn"
                onClick={() => setColsMenuOpen(o => !o)}
                style={{ height: 32, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title={t('showColumns')}
              >
                <Icon name="settings" size={12} />
                {t('columns')}
                <span className="mono" style={{
                  fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                  background: 'var(--bg-soft)', color: 'var(--fg-subtle)', border: '1px solid var(--border)',
                }}>{visibleCols.size}/{TOGGLEABLE_COLS.length}</span>
              </button>
              {colsMenuOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30,
                  width: 240, background: 'var(--bg-elev)',
                  border: '1px solid var(--border)', borderRadius: 10,
                  boxShadow: '0 12px 28px rgba(15,23,42,0.14)', overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '10px 12px', borderBottom: '1px solid var(--border)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                      {t('showColumns')}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn sm ghost"
                        style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => setColsList([...TOGGLEABLE_COLS.map(c => c.id)] as string[])}
                      >{t('all')}</button>
                      <button
                        className="btn sm ghost"
                        style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => setColsList([])}
                      >{t('none')}</button>
                    </div>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto', padding: 4 }}>
                    {TOGGLEABLE_COLS.map(c => {
                      const on = visibleCols.has(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleCol(c.id)}
                          style={{
                            width: '100%', textAlign: 'left',
                            padding: '7px 10px', borderRadius: 6,
                            border: 'none', background: 'transparent',
                            cursor: 'pointer', fontFamily: 'inherit',
                            display: 'flex', alignItems: 'center', gap: 10,
                            color: 'var(--fg)', fontSize: 13,
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-soft)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: 4,
                            border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                            background: on ? 'var(--accent)' : 'var(--bg-elev)',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                          }}>
                            {on && <Icon name="check" size={10} style={{ color: 'white' }} />}
                          </span>
                          <span>{c.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={10} cols={9} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                {isVis('id') && <SortTh col="id" sort={sort} onSort={cycleSort}>{t('orderId')}</SortTh>}
                {isVis('date') && <SortTh col="date" sort={sort} onSort={cycleSort}>{t('date')}</SortTh>}
                <SortTh col="submitter" sort={sort} onSort={cycleSort}>{t('submitter')}</SortTh>
                {isVis('category') && <SortTh col="category" sort={sort} onSort={cycleSort}>{t('category')}</SortTh>}
                {isVis('warehouse') && <SortTh col="warehouse" sort={sort} onSort={cycleSort}>{t('warehouse')}</SortTh>}
                {isVis('lines') && <SortTh col="lines" sort={sort} onSort={cycleSort} align="right">{t('lines')}</SortTh>}
                {isVis('qty') && <SortTh col="qty" sort={sort} onSort={cycleSort} align="right">{t('qty')}</SortTh>}
                {isVis('revenue') && <SortTh col="revenue" sort={sort} onSort={cycleSort} align="right">{t('revenue')}</SortTh>}
                {isVis('profit') && <SortTh col="profit" sort={sort} onSort={cycleSort} align="right">{t('profit')}</SortTh>}
                {isVis('commission') && <SortTh col="commission" sort={sort} onSort={cycleSort} align="right">{t('commission')}</SortTh>}
                {isVis('payment') && <SortTh col="payment" sort={sort} onSort={cycleSort}>{t('payment')}</SortTh>}
                {isVis('status') && <SortTh col="status" sort={sort} onSort={cycleSort}>{t('status')}</SortTh>}
                <th style={{ width: 90 }}>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr><td colSpan={totalCols} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                  {t('noOrdersMatch')}
                </td></tr>
              )}
              {sorted.map(o => {
                const commission = commissionFor(o);
                const isOpen = openId === o.id;
                return (
                  <Fragment key={o.id}>
                    <tr className="row-hover" onClick={() => setOpenId(isOpen ? null : o.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <Icon name="chevronDown" size={13} style={{
                          transition: 'transform 0.15s',
                          transform: isOpen ? 'rotate(180deg)' : 'none',
                          color: 'var(--fg-subtle)',
                        }} />
                      </td>
                      <td className="mono" style={{ fontWeight: 600, display: isVis('id') ? undefined : 'none' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {o.id}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const url = `${location.origin}${location.pathname}#/purchase-orders/${o.id}`;
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
                      <td className="muted" style={{ display: isVis('date') ? undefined : 'none' }}>{fmtDateShort(o.createdAt)}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="avatar">{o.userInitials}</div>
                          <span>{o.userName.split(' ')[0]}</span>
                        </div>
                      </td>
                      <td style={{ display: isVis('category') ? undefined : 'none' }}>
                        <span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : o.category === 'HDD' ? 'cool' : 'warn')}>{o.category}</span>
                      </td>
                      <td className="muted" style={{ display: isVis('warehouse') ? undefined : 'none' }}>
                        {o.warehouse ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                            <span className="mono" style={{
                              fontSize: 10.5, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                              background: 'var(--bg-soft)', border: '1px solid var(--border)', color: 'var(--fg)',
                            }}>{o.warehouse.short}</span>
                            <span className="muted" style={{ fontSize: 11.5 }}>{o.warehouse.region}</span>
                          </span>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="num mono" style={{ display: isVis('lines') ? undefined : 'none' }}>{o.lineCount}</td>
                      <td className="num mono" style={{ display: isVis('qty') ? undefined : 'none' }}>{o.qty}</td>
                      <td className="num mono" style={{ display: isVis('revenue') ? undefined : 'none' }}>{fmtUSD0(o.revenue)}</td>
                      <td className="num mono pos" style={{ display: isVis('profit') ? undefined : 'none' }}>{fmtUSD0(o.profit)}</td>
                      <td className="num mono" style={{ display: isVis('commission') ? undefined : 'none' }}>{fmtUSD(commission)}</td>
                      <td style={{ display: isVis('payment') ? undefined : 'none' }}>
                        <span className="chip">{o.payment === 'company' ? 'Company' : 'Self'}</span>
                      </td>
                      <td style={{ display: isVis('status') ? undefined : 'none' }}>
                        <span className={'chip dot ' + statusTone(o.status)}>{o.status}</span>
                      </td>
                      <td>
                        <button
                          className="btn icon sm"
                          disabled={isCompleted(o.status)}
                          title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                          style={isCompleted(o.status) ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (openLines && openLines.id === o.id) onEdit(openLines);
                            else api.get<{ order: Order }>(`/api/orders/${o.id}`).then(r => onEdit(r.order));
                          }}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      </td>
                    </tr>
                    {isOpen && openLines && openLines.id === o.id && (
                      <tr>
                        <td colSpan={totalCols} style={{ background: 'var(--bg-soft)', padding: 16 }}>
                          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 8 }}>
                            {t('lineItemsIn')} {o.id}
                          </div>
                          <table className="table" style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8 }}>
                            <thead>
                              <tr>
                                <th style={{ width: 28 }}>#</th>
                                <th>{t('item')}</th>
                                <th>{t('partNumber')}</th>
                                <th className="num">{t('qty')}</th>
                                <th className="num">{t('unitCost')}</th>
                                <th className="num">{t('sellUnit')}</th>
                                <th className="num">{t('revenue')}</th>
                                <th className="num">{t('profit')}</th>
                                <th>{t('status')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {openLines.lines.map((l, i) => {
                                const name =
                                  l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`.trim()
                                  : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
                                  : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
                                  : (l.description ?? '');
                                const sub =
                                  l.category === 'RAM' ? [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')
                                  : l.category === 'SSD' ? [l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
                                  : l.category === 'HDD' ? [l.interface, l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
                                  : l.condition;
                                const revenue = l.sellPrice != null ? l.qty * l.sellPrice : null;
                                const profit = l.sellPrice != null ? l.qty * (l.sellPrice - l.unitCost) : null;
                                return (
                                  <tr key={l.id}>
                                    <td className="muted mono">{i + 1}</td>
                                    <td>
                                      <div>{name}</div>
                                      {sub && <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{sub}</div>}
                                    </td>
                                    <td className="mono muted">{l.partNumber}</td>
                                    <td className="num">{l.qty}</td>
                                    <td className="num mono">{fmtUSD0(l.unitCost)}</td>
                                    <td className="num mono">{l.sellPrice != null ? fmtUSD0(l.sellPrice) : '—'}</td>
                                    <td className="num mono">{revenue != null ? fmtUSD0(revenue) : '—'}</td>
                                    <td className={'num mono' + (profit != null && profit >= 0 ? ' pos' : profit != null ? ' neg' : '')}>
                                      {profit != null ? fmtUSD0(profit) : '—'}
                                    </td>
                                    <td><span className={'chip dot ' + statusTone(l.status)}>{l.status}</span></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
      </div>
    </>
  );
}
