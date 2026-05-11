import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isSellable } from '../../lib/status';
import type { Warehouse } from '../../lib/types';
import { DesktopSellOrderDraft, type DraftItem } from './DesktopSellOrderDraft';
import { DesktopActivityDrawer } from './DesktopActivityDrawer';

type InventoryRow = {
  id: string;
  category: 'RAM' | 'SSD' | 'Other';
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  part_number: string | null;
  condition: string;
  qty: number;
  unit_cost: number;
  sell_price: number | null;
  status: string;
  warehouse_id: string | null;
  warehouse_short: string | null;
  warehouse_region: string | null;
  user_initials: string;
  user_name: string;
  created_at: string;
  order_id: string;
};

type Props = {
  onEditItem: (id: string) => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
};

type ColId =
  | 'id' | 'date' | 'category' | 'partNumber' | 'warehouse' | 'condition'
  | 'qty' | 'unitCost' | 'sellPrice' | 'profit' | 'margin' | 'submitter';

export function DesktopInventory({ onEditItem, showToast }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';

  const [items, setItems] = useState<InventoryRow[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [warehouseFilter, setWarehouseFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Persisted column visibility
  const ALL_COLS: { id: ColId; label: string; managerOnly?: boolean }[] = useMemo(() => ([
    { id: 'id',         label: 'ID' },
    { id: 'date',       label: 'Date' },
    { id: 'category',   label: 'Category' },
    { id: 'partNumber', label: 'Part #' },
    { id: 'warehouse',  label: 'Warehouse' },
    { id: 'condition',  label: 'Condition' },
    { id: 'qty',        label: 'Qty' },
    { id: 'unitCost',   label: 'Unit cost', managerOnly: true },
    { id: 'sellPrice',  label: 'Sell price' },
    { id: 'profit',     label: 'Profit',    managerOnly: true },
    { id: 'margin',     label: 'Margin',    managerOnly: true },
    { id: 'submitter',  label: 'Submitted by' },
  ]), []);
  const TOGGLEABLE_COLS = useMemo(
    () => ALL_COLS.filter(c => !c.managerOnly || isManager),
    [ALL_COLS, isManager],
  );
  const COLS_KEY = isManager ? 'rs.inventory.cols.v1' : 'rs.inventory.cols.purchaser.v1';
  const [visibleCols, setVisibleCols] = useState<Set<ColId>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
      if (Array.isArray(saved)) return new Set(saved as ColId[]);
    } catch { /* ignore */ }
    return new Set(ALL_COLS.filter(c => !c.managerOnly || isManager).map(c => c.id));
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify([...visibleCols])); } catch { /* ignore */ }
  }, [visibleCols, COLS_KEY]);
  const isVis = (id: ColId) => visibleCols.has(id);
  const toggleCol = (id: ColId) => setVisibleCols(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!colsMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (colsMenuRef.current && !colsMenuRef.current.contains(e.target as Node)) {
        setColsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [colsMenuOpen]);

  // Data fetch (debounced on search/filters)
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (warehouseFilter !== 'all') params.set('warehouse', warehouseFilter);
    if (search.trim()) params.set('q', search.trim());
    const handle = setTimeout(() => {
      api.get<{ items: InventoryRow[] }>(`/api/inventory?${params}`)
        .then(r => setItems(r.items))
        .catch(console.error);
    }, 200);
    return () => clearTimeout(handle);
  }, [filter, statusFilter, warehouseFilter, search]);

  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses').then(r => setWhs(r.items));
  }, []);

  // Per-warehouse counts: derived from the currently loaded items.
  // (Server returns at most 200; the count is approximate for very large
  // result sets, but matches the design's at-a-glance feel.)
  const warehouseCounts = useMemo(() => {
    const m: Record<string, number> = {};
    items.forEach(r => { if (r.warehouse_id) m[r.warehouse_id] = (m[r.warehouse_id] ?? 0) + 1; });
    return m;
  }, [items]);

  // Selection helpers
  const selectableRows = useMemo(() => items.filter(r => isSellable(r.status)), [items]);
  const allSelectableChecked = selectableRows.length > 0 && selectableRows.every(r => selected.has(r.id));
  const someSelectableChecked = selectableRows.some(r => selected.has(r.id));
  const toggleAll = () => setSelected(prev => {
    if (allSelectableChecked) {
      const next = new Set(prev);
      selectableRows.forEach(r => next.delete(r.id));
      return next;
    }
    const next = new Set(prev);
    selectableRows.forEach(r => next.add(r.id));
    return next;
  });
  const toggleRow = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelection = () => setSelected(new Set());

  const selectedItems = useMemo(() => items.filter(r => selected.has(r.id)), [items, selected]);
  const selectedTotals = useMemo(() => {
    const lines = selectedItems.length;
    const qty   = selectedItems.reduce((a, r) => a + r.qty, 0);
    const value = selectedItems.reduce((a, r) => a + ((r.sell_price ?? 0) * r.qty), 0);
    return { lines, qty, value };
  }, [selectedItems]);

  // ── Render helpers ──────────────────────────────────────────────────────────
  const itemLabel = (r: InventoryRow) =>
      r.category === 'RAM' ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.type ?? ''}`.trim()
    : r.category === 'SSD' ? `${r.brand ?? ''} ${r.capacity ?? ''}`.trim()
    : (r.description ?? '');
  const itemSpec = (r: InventoryRow) =>
      r.category === 'RAM' ? [r.classification, r.rank, r.speed && `${r.speed}MHz`].filter(Boolean).join(' · ')
    : r.category === 'SSD' ? [r.interface, r.form_factor].filter(Boolean).join(' · ')
    : (r.condition ?? '');

  const qtyDotColor = (s: string) =>
      s === 'In Transit' ? 'var(--info)'
    : s === 'Done' ? 'var(--pos)'
    : s === 'Reviewing' ? 'var(--accent)'
    : 'var(--fg-subtle)';
  const qtyTextColor = (s: string) =>
      s === 'In Transit' ? 'var(--info)'
    : s === 'Done' ? 'var(--pos)'
    : s === 'Reviewing' ? 'var(--accent-strong)'
    : 'var(--fg)';

  // Draft-modal state: holds the items we hand off to the modal. Snapshotted
  // when the user clicks "Create sell order" so further selection changes on
  // the table don't mutate what's in the modal.
  const [draftItems, setDraftItems] = useState<DraftItem[] | null>(null);
  const [showActivity, setShowActivity] = useState(false);

  const buildDraftItems = (rows: InventoryRow[]): DraftItem[] => rows.map(r => ({
    id: r.id,
    category: r.category,
    label: itemLabel(r) || r.id.slice(0, 8),
    subLabel: itemSpec(r) || null,
    partNumber: r.part_number,
    qty: r.qty,
    unitCost: r.unit_cost,
    sellPrice: r.sell_price,
    warehouseId: r.warehouse_id,
    warehouseShort: r.warehouse_short,
    condition: r.condition,
  }));

  const openSellOrderDraft = () => {
    if (!selectedItems.length) return;
    setDraftItems(buildDraftItems(selectedItems));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            {t('inventoryTitle')}
            {!isManager && (
              <span className="chip" style={{ fontSize: 11, marginLeft: 8, verticalAlign: 4 }}>
                <Icon name="lock" size={11} /> {t('limitedView')}
              </span>
            )}
          </h1>
          <div className="page-sub">
            {isManager
              ? 'Pick items across warehouses to create a sell order. Select rows in Reviewing or Done status.'
              : 'Showing only items you submitted. Cost and margin are restricted by role.'}
          </div>
        </div>
        <div className="page-actions">
          {isManager && (
            <button className="btn" onClick={() => showToast?.('Export queued', 'success')}>
              <Icon name="download" size={14} /> Export
            </button>
          )}
          <button className="btn" onClick={() => setShowActivity(true)}>
            <Icon name="history" size={14} /> Activity log
          </button>
          {!isManager && (
            <button className="btn" onClick={() => showToast?.('Use the phone app to capture new parts', 'success')}>
              <Icon name="plus" size={14} /> New entry
            </button>
          )}
          {isManager && (
            <button
              className="btn accent"
              disabled={selectedItems.length === 0}
              onClick={openSellOrderDraft}
            >
              <Icon name="tag" size={14} /> Create sell order
              {selectedItems.length > 0 && (
                <span style={{
                  marginLeft: 4, padding: '1px 7px',
                  background: 'rgba(255,255,255,0.22)', borderRadius: 999,
                  fontSize: 11, fontWeight: 600,
                }}>{selectedItems.length}</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Warehouse filter pills (manager only) */}
      {isManager && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className={'wh-pill' + (warehouseFilter === 'all' ? ' active' : '')}
            onClick={() => setWarehouseFilter('all')}
          >
            <Icon name="globe" size={13} />
            <span>All warehouses</span>
            <span className="wh-count">{items.length}</span>
          </button>
          {whs.map(w => (
            <button
              key={w.id}
              className={'wh-pill' + (warehouseFilter === w.id ? ' active' : '')}
              onClick={() => setWarehouseFilter(w.id)}
            >
              <Icon name="warehouse" size={13} />
              <span>{w.short ?? w.id}</span>
              <span className="wh-count">{warehouseCounts[w.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {/* Read-only banner for purchasers */}
      {!isManager && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 14px',
          background: 'var(--info-soft)',
          border: '1px solid color-mix(in oklch, var(--info) 25%, transparent)',
          borderRadius: 10, fontSize: 13,
        }}>
          <Icon name="info" size={16} style={{ color: 'var(--info)', marginTop: 2 }} />
          <div>
            <strong>Read-only access.</strong> Purchasers can view their own orders only.
            Cost, profit and team data are visible to managers.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="seg">
              {(['all', 'RAM', 'SSD', 'Other'] as const).map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All categories' : f}
                </button>
              ))}
            </div>
            <select
              className="select"
              style={{ width: 160, height: 32, fontSize: 12.5 }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              {ORDER_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--fg-subtle)',
              }} />
              <input
                className="input"
                placeholder="Search part #, brand, ID…"
                style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 240 }}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div ref={colsMenuRef} style={{ position: 'relative' }}>
              <button
                className="btn"
                onClick={() => setColsMenuOpen(o => !o)}
                style={{ height: 32, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title="Choose columns to show"
              >
                <Icon name="settings" size={13} />
                Columns
                <span className="mono" style={{
                  fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                  background: 'var(--bg-soft)', color: 'var(--fg-subtle)', border: '1px solid var(--border)',
                }}>{visibleCols.size}/{TOGGLEABLE_COLS.length}</span>
              </button>
              {colsMenuOpen && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30,
                  width: 220, background: 'var(--bg-elev)',
                  border: '1px solid var(--border)', borderRadius: 10,
                  boxShadow: '0 12px 28px -8px rgba(0,0,0,0.18)', padding: 6,
                }}>
                  <div style={{
                    padding: '6px 10px 8px', borderBottom: '1px solid var(--border)', marginBottom: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <span style={{
                      fontSize: 11, color: 'var(--fg-subtle)',
                      textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600,
                    }}>Columns</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn sm ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => setVisibleCols(new Set(TOGGLEABLE_COLS.map(c => c.id)))}>All</button>
                      <button className="btn sm ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => setVisibleCols(new Set())}>None</button>
                    </div>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto', padding: 4 }}>
                    {TOGGLEABLE_COLS.map(c => {
                      const on = visibleCols.has(c.id);
                      return (
                        <button
                          key={c.id}
                          onClick={() => toggleCol(c.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                            padding: '7px 10px', borderRadius: 6, border: 'none',
                            background: 'transparent', cursor: 'pointer', fontSize: 12.5,
                            color: 'var(--fg)', textAlign: 'left', fontFamily: 'inherit',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-soft)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          <span style={{
                            width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                            border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                            background: on ? 'var(--accent)' : 'transparent',
                            display: 'grid', placeItems: 'center', color: 'white',
                          }}>
                            {on && <Icon name="check" size={9} />}
                          </span>
                          {c.label}
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
          <table className="table">
            <thead>
              <tr>
                {isManager && (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allSelectableChecked}
                      ref={el => { if (el) el.indeterminate = someSelectableChecked && !allSelectableChecked; }}
                      onChange={toggleAll}
                      title="Select all sellable items"
                    />
                  </th>
                )}
                {isVis('id')         && <th>ID</th>}
                {isVis('date')       && <th>Date</th>}
                {isVis('category')   && <th>Category</th>}
                <th>Item / Spec</th>
                {isVis('partNumber') && <th>Part #</th>}
                {isVis('warehouse')  && <th>Warehouse</th>}
                {isVis('condition')  && <th>Condition</th>}
                {isVis('qty')        && <th className="num">Qty</th>}
                {isManager && isVis('unitCost')  && <th className="num">Unit cost</th>}
                {isVis('sellPrice')  && <th className="num">Sell price</th>}
                {isManager && isVis('profit')    && <th className="num">Profit</th>}
                {isManager && isVis('margin')    && <th className="num">Margin</th>}
                {isVis('submitter')  && <th>Submitted by</th>}
                <th>Status</th>
                <th>{isManager ? '' : t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={20} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                    No matching inventory.
                  </td>
                </tr>
              )}
              {items.map(r => {
                const sellable = isSellable(r.status);
                const isSelected = selected.has(r.id);
                const profit = r.sell_price != null ? (r.sell_price - r.unit_cost) * r.qty : null;
                const margin = r.sell_price != null && r.sell_price > 0
                  ? ((r.sell_price - r.unit_cost) / r.sell_price) * 100
                  : null;
                return (
                  <tr key={r.id} className={'row-hover' + (isSelected ? ' row-selected' : '')}>
                    {isManager && (
                      <td>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(r.id)}
                          disabled={!sellable}
                          title={sellable ? 'Add to sell order' : `Cannot sell — status is ${r.status}`}
                        />
                      </td>
                    )}
                    {isVis('id')       && <td className="mono" style={{ fontSize: 11.5 }}>{r.id.slice(0, 8)}</td>}
                    {isVis('date')     && <td className="muted">{fmtDateShort(r.created_at)}</td>}
                    {isVis('category') && (
                      <td>
                        <span className={'chip ' + (r.category === 'RAM' ? 'info' : r.category === 'SSD' ? 'pos' : 'warn')}>
                          {r.category}
                        </span>
                      </td>
                    )}
                    <td>
                      <div style={{ fontWeight: 500 }}>{itemLabel(r)}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{itemSpec(r)}</div>
                    </td>
                    {isVis('partNumber') && <td className="mono muted" style={{ fontSize: 11 }}>{r.part_number}</td>}
                    {isVis('warehouse')  && (
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                          <Icon name="warehouse" size={11} style={{ color: 'var(--fg-subtle)' }} />
                          {r.warehouse_short ?? '—'}
                        </span>
                      </td>
                    )}
                    {isVis('condition')  && <td><span className="chip" style={{ fontSize: 11 }}>{r.condition}</span></td>}
                    {isVis('qty')        && (
                      <td className="num">
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end',
                        }}>
                          <span
                            title={r.status}
                            style={{
                              width: 7, height: 7, borderRadius: '50%',
                              background: qtyDotColor(r.status),
                              flexShrink: 0,
                              backgroundImage: r.status === 'In Transit'
                                ? 'repeating-linear-gradient(45deg, transparent 0 1.5px, color-mix(in oklch, var(--info) 60%, white) 1.5px 3px)'
                                : 'none',
                            }}
                          />
                          <span className="mono" style={{ fontWeight: 600, color: qtyTextColor(r.status) }}>{r.qty}</span>
                        </span>
                      </td>
                    )}
                    {isManager && isVis('unitCost')  && <td className="num mono muted">{fmtUSD(r.unit_cost)}</td>}
                    {isVis('sellPrice')  && (
                      <td className="num mono">{r.sell_price != null ? fmtUSD(r.sell_price) : '—'}</td>
                    )}
                    {isManager && isVis('profit')    && (
                      <td className="num mono pos">{profit != null ? fmtUSD(profit) : '—'}</td>
                    )}
                    {isManager && isVis('margin')    && (
                      <td className={'num mono ' + (margin == null ? 'muted' : margin >= 25 ? 'pos' : margin >= 10 ? '' : 'neg')}>
                        {margin == null ? '—' : margin.toFixed(1) + '%'}
                      </td>
                    )}
                    {isVis('submitter')  && (
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="avatar sm">{r.user_initials}</div>
                          <span style={{ fontSize: 12 }}>{r.user_name.split(' ')[0]}</span>
                        </div>
                      </td>
                    )}
                    <td><span className={'chip dot ' + statusTone(r.status)}>{r.status}</span></td>
                    <td>
                      <button className="btn sm" onClick={() => onEditItem(r.id)}>
                        <Icon name="edit" size={12} /> {t('edit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 12, color: 'var(--fg-subtle)',
        }}>
          <div>Showing {items.length} {items.length === 1 ? 'entry' : 'entries'}</div>
          <div style={{ fontSize: 11 }}>Server cap 200 · refine filters to narrow further</div>
        </div>
      </div>

      {/* Floating selection bar */}
      {isManager && selectedItems.length > 0 && (
        <div className="sel-bar">
          <div className="sel-bar-info">
            <div className="sel-bar-pill">
              {selectedTotals.lines} {selectedTotals.lines === 1 ? 'line' : 'lines'}
            </div>
            <span className="sel-bar-divider" />
            <div>
              <span className="sel-bar-num">{selectedTotals.qty}</span>{' '}
              <span className="sel-bar-label">units</span>
            </div>
            <span className="sel-bar-divider" />
            <div>
              <span className="sel-bar-num">{fmtUSD0(selectedTotals.value)}</span>{' '}
              <span className="sel-bar-label">est. revenue</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={clearSelection}>Clear</button>
            <button className="btn accent" onClick={openSellOrderDraft}>
              <Icon name="tag" size={14} /> Create sell order
            </button>
          </div>
        </div>
      )}

      {draftItems && (
        <DesktopSellOrderDraft
          items={draftItems}
          onClose={() => setDraftItems(null)}
          onSaved={(id) => {
            setDraftItems(null);
            clearSelection();
            showToast?.(`Sell order ${id} saved as draft`, 'success');
          }}
        />
      )}

      {showActivity && (
        <DesktopActivityDrawer onClose={() => setShowActivity(false)} />
      )}
    </>
  );
}
