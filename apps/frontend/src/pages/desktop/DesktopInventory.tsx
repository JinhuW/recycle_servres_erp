import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { usePreference } from '../../lib/preferences';
import { usePersisted, useScrollMemory } from '../../lib/listMemory';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { fmtUSD, fmtUSD0, fmtDateShort, relTime, canonicalPartNumber } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isSellable } from '../../lib/status';
import { categoryFilterOptions } from '../../lib/lookups';
import { wsNumber } from '../../lib/workspace';
import type { Warehouse } from '../../lib/types';
import { DesktopSellOrderDraft, type DraftItem } from './DesktopSellOrderDraft';
import { DesktopInventoryTransfer, type TransferItem } from './DesktopInventoryTransfer';
import { DesktopActivityDrawer } from './DesktopActivityDrawer';
import { TableSkeleton } from '../../components/Skeleton';
import { InventoryProductTable } from './InventoryProductTable';
import type { ProductGroup } from './InventoryProductTable';

type InventoryRow = {
  id: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  brand: string | null;
  capacity: string | null;
  generation: string | null;
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
  health: number | null;
  rpm: number | null;
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

// Columns the grouped view can actually honor. The rest (id/date/profit/
// margin/submitter) are lot-level only and have no grouped column, so the
// Columns menu hides them while in grouped view instead of listing dead toggles.
const GROUPED_COL_IDS = new Set<ColId>([
  'category', 'partNumber', 'warehouse', 'condition', 'qty', 'unitCost', 'sellPrice',
]);

// Sub-filter facets per category. `key` doubles as the facets-response key the
// backend returns; `param` is what the query string sends (the backend uses
// `form` as the param shortcut for the `form_factor` column).
type AttrSpec = { key: string; param: string; label: string; format?: (v: string) => string };
const ATTR_SCHEMA: Record<'RAM' | 'SSD' | 'HDD', AttrSpec[]> = {
  RAM: [
    { key: 'generation',     param: 'generation',     label: 'Generation' },
    { key: 'speed',          param: 'speed',          label: 'Speed', format: v => `${v} MHz` },
    { key: 'brand',          param: 'brand',          label: 'Brand' },
    { key: 'capacity',       param: 'capacity',       label: 'Capacity' },
    { key: 'type',           param: 'type',           label: 'Device' },
    { key: 'classification', param: 'classification', label: 'Form' },
    { key: 'rank',           param: 'rank',           label: 'Rank' },
  ],
  SSD: [
    { key: 'brand',       param: 'brand',     label: 'Brand' },
    { key: 'capacity',    param: 'capacity',  label: 'Capacity' },
    { key: 'interface',   param: 'interface', label: 'Interface' },
    { key: 'form_factor', param: 'form',      label: 'Form factor' },
  ],
  HDD: [
    { key: 'brand',       param: 'brand',     label: 'Brand' },
    { key: 'capacity',    param: 'capacity',  label: 'Capacity' },
    { key: 'interface',   param: 'interface', label: 'Interface' },
    { key: 'form_factor', param: 'form',      label: 'Form factor' },
    { key: 'rpm',         param: 'rpm',       label: 'RPM', format: v => `${v} RPM` },
  ],
};
// Numeric attrs need natural sort (2400 before 16000); the rest collate as
// strings so e.g. 4GB/8GB/16GB still go in catalog-natural order on chips.
const NUMERIC_ATTRS = new Set(['speed', 'rpm']);
function sortAttrValues(key: string, values: string[]): string[] {
  if (NUMERIC_ATTRS.has(key)) {
    return [...values].sort((a, b) => Number(a) - Number(b));
  }
  return [...values].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function DesktopInventory({ onEditItem, showToast }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const isManager = user?.role === 'manager';

  const [items, setItems] = useState<InventoryRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  // Persisted across the open-item → back round-trip (see lib/listMemory).
  const [filter, setFilter] = usePersisted<string>('desktop.inventory.filter', 'all');
  const [statusFilter, setStatusFilter] = usePersisted<string>('desktop.inventory.statusFilter', 'all');
  const [warehouseFilter, setWarehouseFilter] = usePersisted<string>('desktop.inventory.warehouseFilter', 'all');
  const [search, setSearch] = usePersisted<string>('desktop.inventory.search', '');
  const [selected, setSelected] = usePersisted<Set<string>>('desktop.inventory.selected', new Set());

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
  // Server-backed per-user column visibility. Manager vs purchaser have
  // separate keys because managers can toggle cost/profit/margin columns
  // that don't exist for purchasers.
  const colsKey = isManager ? 'inventory.cols.manager' : 'inventory.cols.purchaser';
  const defaultCols = useMemo(
    () => ALL_COLS.filter(c => !c.managerOnly || isManager).map(c => c.id) as string[],
    [ALL_COLS, isManager],
  );
  const [view, setView] = usePreference('inventory.view', 'grouped');
  const [products, setProducts] = useState<ProductGroup[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);

  // Sub-filter state. Persisted PER CATEGORY so toggling RAM → SSD → RAM keeps
  // your RAM chips, but new category lookups start fresh. Fold-open is sticky
  // across all categories; we auto-open it on first selection (see below).
  type AttrMap = Record<string, string[]>;
  const [attrFiltersByCat, setAttrFiltersByCat] =
    usePersisted<Record<string, AttrMap>>('desktop.inventory.attrs', {});
  const attrFilters: AttrMap = attrFiltersByCat[filter] ?? {};
  const setAttrFilters = (next: AttrMap) =>
    setAttrFiltersByCat({ ...attrFiltersByCat, [filter]: next });
  const [attrPanelOpen, setAttrPanelOpen] =
    usePersisted<boolean>('desktop.inventory.attrPanelOpen', false);
  const [facets, setFacets] =
    useState<Record<string, Record<string, number>>>({});
  const [whProductCounts, setWhProductCounts] =
    useState<Record<string, number>>({});
  const [whProductTotal, setWhProductTotal] = useState<number>(0);

  const attrSchema: AttrSpec[] =
    filter === 'RAM' || filter === 'SSD' || filter === 'HDD'
      ? ATTR_SCHEMA[filter as 'RAM' | 'SSD' | 'HDD']
      : [];
  const activeAttrCount = Object.values(attrFilters).reduce(
    (n, vs) => n + (vs?.length ?? 0), 0,
  );
  const toggleAttrValue = (key: string, value: string) => {
    const cur = attrFilters[key] ?? [];
    const next = cur.includes(value)
      ? cur.filter(v => v !== value)
      : [...cur, value];
    const merged = { ...attrFilters };
    if (next.length === 0) delete merged[key]; else merged[key] = next;
    setAttrFilters(merged);
  };
  const clearAttrFilters = () => setAttrFilters({});
  const [colsList, setColsList] = usePreference(colsKey, defaultCols);
  const visibleCols = useMemo(() => new Set(colsList as ColId[]), [colsList]);
  const isVis = (id: ColId) => visibleCols.has(id);
  // Menu only lists toggles the active view honors (grouped drops the
  // lot-level-only ones). All/None below scope to these and preserve the
  // other view's stored prefs.
  const menuCols = useMemo(
    () => view === 'grouped'
      ? TOGGLEABLE_COLS.filter(c => GROUPED_COL_IDS.has(c.id))
      : TOGGLEABLE_COLS,
    [view, TOGGLEABLE_COLS],
  );
  const menuOnCount = useMemo(
    () => menuCols.filter(c => visibleCols.has(c.id)).length,
    [menuCols, visibleCols],
  );
  const toggleCol = (id: ColId) => {
    const next = new Set(visibleCols);
    if (next.has(id)) next.delete(id); else next.add(id);
    setColsList([...next]);
  };
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

  // Auto-collapse the refine panel when the user clicks anywhere outside it.
  // Mirrors the cols-menu behaviour above so the panel doesn't linger over the
  // table after the user has dialed in their chips.
  const subfilterRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!attrPanelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (subfilterRef.current && !subfilterRef.current.contains(e.target as Node)) {
        setAttrPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [attrPanelOpen, setAttrPanelOpen]);

  // Shared query string for the flat list and the grouped product fetch, so
  // the two views always filter identically (was duplicated in both effects).
  // Attribute chips are flattened into multi-value params (`?generation=DDR4,DDR5`)
  // and only sent when the active category has them in its schema — keeps
  // stale RAM chips out of an SSD query.
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (warehouseFilter !== 'all') params.set('warehouse', warehouseFilter);
    if (search.trim()) params.set('q', search.trim());
    for (const spec of attrSchema) {
      const vals = attrFilters[spec.key];
      if (vals && vals.length) params.set(spec.param, vals.join(','));
    }
    return params.toString();
  }, [filter, statusFilter, warehouseFilter, search, attrSchema, attrFilters]);

  // Data fetch (debounced on search/filters)
  useEffect(() => {
    let alive = true;
    const handle = setTimeout(() => {
      api.get<{ items: InventoryRow[] }>(`/api/inventory?${filterQuery}`)
        .then(r => { if (alive) setItems(r.items); })
        .catch(handleFetchError)
        .finally(() => { if (alive) setLoadedOnce(true); });
    }, 200);
    return () => { alive = false; clearTimeout(handle); };
  }, [filterQuery]);

  useEffect(() => {
    // Products endpoint is also our source of facet + warehouse counts, so we
    // fire it even when the user is on the flat view — otherwise the chip-bar
    // counts and the warehouse pills would stale when toggling views.
    let alive = true;
    const h = setTimeout(() => {
      api.get<{
        products: ProductGroup[];
        facets?: Record<string, Record<string, number>>;
        warehouse_counts?: Record<string, number>;
        total?: number;
      }>(`/api/inventory/products?${filterQuery}`)
        .then(r => {
          if (!alive) return;
          setProducts(r.products);
          setProductsLoaded(true);
          setFacets(r.facets ?? {});
          setWhProductCounts(r.warehouse_counts ?? {});
          setWhProductTotal(r.total ?? r.products.length);
        })
        .catch(err => {
          if (alive) { setProducts([]); setProductsLoaded(true); }
          handleFetchError(err);
        });
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [view, filterQuery]);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => { if (alive) setWhs(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // Restore the list scroll position when returning from an item's edit page.
  // "Ready" = the rows for the active view have actually rendered.
  const tableScrollRef = useScrollMemory(
    'desktop.inventory',
    view === 'grouped' ? productsLoaded : loadedOnce,
  );

  // Per-warehouse counts come from /api/inventory/products which counts
  // distinct products with drop-self warehouse semantics — so a warehouse pill
  // shows its true product count even after another warehouse is selected.
  // Falls back to a flat-list approximation while the products call is in
  // flight (first paint only).
  const warehouseCounts = useMemo(() => {
    if (Object.keys(whProductCounts).length) return whProductCounts;
    const m: Record<string, number> = {};
    items.forEach(r => { if (r.warehouse_id) m[r.warehouse_id] = (m[r.warehouse_id] ?? 0) + 1; });
    return m;
  }, [whProductCounts, items]);
  const allWarehousesCount = whProductTotal || items.length;

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

  // Selected lot ids can originate in the grouped product view, whose lots
  // are NOT in the flat `items` list (different endpoint + caps). Synthesise
  // an InventoryRow-equivalent from each ProductGroup's spec + its ProductLot
  // so bulk actions (sell order / transfer) and the selection totals see
  // grouped-view selections too — not just the flat 200-row slice.
  const groupedRowsById = useMemo(() => {
    const m = new Map<string, InventoryRow>();
    for (const g of products) {
      for (const lot of g.lines) {
        m.set(lot.id, {
          id: lot.id,
          category: g.category as InventoryRow['category'],
          brand: g.brand, capacity: g.capacity, generation: g.generation,
          type: g.type, classification: g.classification, rank: g.rank,
          speed: g.speed, interface: g.interface, form_factor: g.form_factor,
          description: g.description, part_number: g.part_number,
          condition: lot.condition, qty: lot.qty,
          unit_cost: lot.unit_cost ?? 0, sell_price: lot.sell_price,
          status: lot.status, health: lot.health, rpm: g.rpm,
          warehouse_id: lot.warehouse_id, warehouse_short: lot.warehouse_short,
          warehouse_region: null,
          user_initials: lot.user_initials, user_name: lot.user_name,
          created_at: lot.created_at, order_id: lot.order_id,
        });
      }
    }
    return m;
  }, [products]);

  // Flat rows first (preserve existing behaviour); then any selected lot that
  // only exists in the grouped view.
  const selectedItems = useMemo(() => {
    const out: InventoryRow[] = [];
    const seen = new Set<string>();
    for (const r of items) {
      if (selected.has(r.id)) { out.push(r); seen.add(r.id); }
    }
    for (const id of selected) {
      if (seen.has(id)) continue;
      const g = groupedRowsById.get(id);
      if (g) out.push(g);
    }
    return out;
  }, [items, selected, groupedRowsById]);
  const selectedTotals = useMemo(() => {
    const lines = selectedItems.length;
    const qty   = selectedItems.reduce((a, r) => a + r.qty, 0);
    const value = selectedItems.reduce((a, r) => a + ((r.sell_price ?? 0) * r.qty), 0);
    return { lines, qty, value };
  }, [selectedItems]);

  // ── Render helpers ──────────────────────────────────────────────────────────
  const itemLabel = (r: InventoryRow) =>
      r.category === 'RAM' ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.generation ?? ''}`.trim()
    : r.category === 'SSD' ? `${r.brand ?? ''} ${r.capacity ?? ''}`.trim()
    : r.category === 'HDD' ? `${r.brand ?? ''} ${r.capacity ?? ''}`.trim()
    : (r.description ?? '');
  const itemSpec = (r: InventoryRow) =>
      r.category === 'RAM' ? [r.classification, r.rank, r.speed && `${r.speed}MHz`].filter(Boolean).join(' · ')
    : r.category === 'SSD' ? [r.interface, r.form_factor, r.health != null && `${r.health}%`].filter(Boolean).join(' · ')
    : r.category === 'HDD' ? [r.interface, r.form_factor, r.rpm && `${r.rpm}rpm`, r.health != null && `${r.health}%`].filter(Boolean).join(' · ')
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
  const [transferItems, setTransferItems] = useState<TransferItem[] | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [quickView, setQuickView] = useState<InventoryRow | null>(null);
  const [exporting, setExporting] = useState(false);

  // Export the FULL filtered set (the backend drops the 200-row list cap for
  // the xlsx). Reuses the live filterQuery so the file matches what's on screen,
  // and forwards the view so the grouped view exports one row per product while
  // the flat view keeps the per-line file.
  const runExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams(filterQuery);
      if (view === 'grouped') params.set('view', 'grouped');
      await api.download(`/api/inventory/export?${params.toString()}`, 'inventory.xlsx');
    } catch (e) {
      handleFetchError(e);
    } finally {
      setExporting(false);
    }
  };

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

  const buildTransferItems = (rows: InventoryRow[]): TransferItem[] => rows.map(r => ({
    id: r.id,
    category: r.category,
    label: itemLabel(r) || r.id.slice(0, 8),
    subLabel: itemSpec(r) || null,
    partNumber: r.part_number,
    qty: r.qty,
    warehouseId: r.warehouse_id,
    warehouseShort: r.warehouse_short,
  }));

  const openSellOrderDraft = () => {
    if (!selectedItems.length) return;
    setDraftItems(buildDraftItems(selectedItems));
  };

  const openTransferModal = () => {
    if (!selectedItems.length) return;
    setTransferItems(buildTransferItems(selectedItems));
  };

  const refetchInventory = () => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (warehouseFilter !== 'all') params.set('warehouse', warehouseFilter);
    if (search.trim()) params.set('q', search.trim());
    api.get<{ items: InventoryRow[] }>(`/api/inventory?${params}`)
      .then(r => setItems(r.items))
      .catch(handleFetchError);
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
            <button className="btn" onClick={runExport} disabled={exporting}>
              <Icon name="download" size={14} /> {exporting ? `${t('export')}…` : t('export')}
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
              className="btn"
              disabled={selectedItems.length === 0}
              onClick={openTransferModal}
            >
              <Icon name="truck" size={14} /> {t('transfer')}
              {selectedItems.length > 0 && (
                <span style={{
                  marginLeft: 4, padding: '1px 7px',
                  background: 'var(--bg-soft)', borderRadius: 999,
                  fontSize: 11, fontWeight: 600,
                }}>{selectedItems.length}</span>
              )}
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
            <span>{t('invAllWarehouses')}</span>
            <span className="wh-count">{allWarehousesCount}</span>
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
            <strong>{t('invReadOnlyAccess')}</strong> {t('invReadOnlyBody')}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="seg">
              {categoryFilterOptions().map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? t('filterAllCats') : f}
                </button>
              ))}
            </div>
            <select
              className="select"
              style={{ width: 160, height: 32, fontSize: 12.5, padding: '0 12px' }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">{t('invAllStatuses')}</option>
              {[...ORDER_STATUSES, 'Sold'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="seg inv-view-toggle" role="group" aria-label={t('invViewToggleAriaLabel')}>
              <button type="button" className={view === 'grouped' ? 'active' : ''} onClick={() => setView('grouped')}>{t('invGroupedView')}</button>
              <button type="button" className={view === 'flat' ? 'active' : ''} onClick={() => setView('flat')}>{t('invFlatView')}</button>
            </div>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--fg-subtle)',
              }} />
              <input
                className="input"
                placeholder={t('invSearchPlaceholder')}
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
                title={t('invChooseColumnsTooltip')}
              >
                <Icon name="settings" size={13} />
                {t('columns')}
                <span className="mono" style={{
                  fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                  background: 'var(--bg-soft)', color: 'var(--fg-subtle)', border: '1px solid var(--border)',
                }}>{menuOnCount}/{menuCols.length}</span>
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
                    }}>{t('columns')}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn sm ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => {
                          const next = new Set(visibleCols);
                          menuCols.forEach(c => next.add(c.id));
                          setColsList([...next]);
                        }}>{t('all')}</button>
                      <button className="btn sm ghost" style={{ fontSize: 11, padding: '2px 6px' }}
                        onClick={() => {
                          const next = new Set(visibleCols);
                          menuCols.forEach(c => next.delete(c.id));
                          setColsList([...next]);
                        }}>{t('none')}</button>
                    </div>
                  </div>
                  <div style={{ maxHeight: 320, overflowY: 'auto', padding: 4 }}>
                    {menuCols.map(c => {
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

        {attrSchema.length > 0 && (
          <div ref={subfilterRef} className="inv-subfilter" data-open={attrPanelOpen ? 'true' : 'false'}>
            <button
              type="button"
              className="inv-subfilter__head"
              onClick={() => setAttrPanelOpen(!attrPanelOpen)}
              aria-expanded={attrPanelOpen}
              aria-controls="inv-subfilter-body"
            >
              <span className="inv-subfilter__chevron">
                <Icon name="chevronDown" size={13} />
              </span>
              <span className="inv-subfilter__title">
                {t('invRefinePre')} <strong>{filter}</strong>
              </span>
              {activeAttrCount > 0 && (
                <span className="inv-subfilter__badge">
                  {t('invFiltersActive', { n: activeAttrCount })}
                </span>
              )}
              <span className="inv-subfilter__spacer" />
              {activeAttrCount > 0 && (
                <span
                  className="inv-subfilter__clear"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); clearAttrFilters(); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      clearAttrFilters();
                    }
                  }}
                >
                  {t('invClearAll')}
                </span>
              )}
              <span className="inv-subfilter__hint">
                {attrPanelOpen ? t('memSecHide') : t('memSecShow')}
              </span>
            </button>
            <div
              id="inv-subfilter-body"
              className="inv-subfilter__body"
            >
              {attrSchema.map((spec) => {
                const counts = facets[spec.key] ?? {};
                const selected = attrFilters[spec.key] ?? [];
                const values = sortAttrValues(spec.key, Object.keys(counts));
                // Also surface selected values that no longer have any matches
                // (count 0) so they remain visible & removable.
                for (const s of selected) if (!values.includes(s)) values.push(s);
                if (values.length === 0) return null;
                return (
                  <div className="inv-subfilter__row" key={spec.key}>
                    <div className="inv-subfilter__label">{spec.label}</div>
                    <div className="inv-subfilter__chips">
                      {values.map((v) => {
                        const isOn = selected.includes(v);
                        const count = counts[v] ?? 0;
                        return (
                          <button
                            key={v}
                            type="button"
                            className={'inv-chip' + (isOn ? ' on' : '') + (count === 0 && !isOn ? ' empty' : '')}
                            onClick={() => toggleAttrValue(spec.key, v)}
                            disabled={count === 0 && !isOn}
                          >
                            <span className="inv-chip__label">
                              {spec.format ? spec.format(v) : v}
                            </span>
                            <span className="inv-chip__count">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="table-scroll" ref={tableScrollRef}>
          {view === 'grouped' ? (
            <>
              {!productsLoaded ? (
                <TableSkeleton rows={10} cols={8} withCheckbox={isManager} />
              ) : (
                <InventoryProductTable
                  groups={products}
                  isManager={isManager}
                  cols={{
                    category:   isVis('category'),
                    partNumber: isVis('partNumber'),
                    qty:        isVis('qty'),
                    warehouse:  isVis('warehouse'),
                    unitCost:   isVis('unitCost'),
                    sellPrice:  isVis('sellPrice'),
                    condition:  isVis('condition'),
                  }}
                  selected={selected}
                  onToggleLot={(id) => {
                    setSelected(prev => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id); else next.add(id);
                      return next;
                    });
                  }}
                  onToggleGroup={(g) => {
                    const sellable = g.lines.filter(l => l.status === 'Reviewing' || l.status === 'Done').map(l => l.id);
                    setSelected(prev => {
                      const next = new Set(prev);
                      const allOn = sellable.length > 0 && sellable.every(id => next.has(id));
                      for (const id of sellable) { if (allOn) next.delete(id); else next.add(id); }
                      return next;
                    });
                  }}
                  onQuickView={(lotId) => {
                    const row = items.find(i => i.id === lotId) ?? groupedRowsById.get(lotId);
                    if (row) setQuickView(row); else onEditItem(lotId);
                  }}
                  onEditLot={(lotId) => onEditItem(lotId)}
                />
              )}
              {productsLoaded && products.length === 0 && (
                <div style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                  {t('invNoProductsMatch')}
                </div>
              )}
            </>
          ) : !loadedOnce ? (
            <TableSkeleton rows={10} cols={8} withCheckbox={isManager} />
          ) : (
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
                      title={t('invSelectAllSellableTitle')}
                    />
                  </th>
                )}
                {isVis('id')         && <th>{t('whFieldId')}</th>}
                {isVis('date')       && <th>{t('date')}</th>}
                {isVis('category')   && <th>{t('category')}</th>}
                <th>{t('mktColItemSpec')}</th>
                {isVis('partNumber') && <th>{t('partNumber')}</th>}
                {isVis('warehouse')  && <th>{t('warehouse')}</th>}
                {isVis('condition')  && <th>{t('condition')}</th>}
                {isVis('qty')        && <th className="num">{t('qty')}</th>}
                {isManager && isVis('unitCost')  && <th className="num">{t('unitCost')}</th>}
                {isVis('sellPrice')  && <th className="num">{t('sellPrice')}</th>}
                {isManager && isVis('profit')    && <th className="num">{t('profit')}</th>}
                {isManager && isVis('margin')    && <th className="num">{t('margin')}</th>}
                {isVis('submitter')  && <th>{t('submittedBy')}</th>}
                <th>{t('status')}</th>
                <th>{isManager ? '' : t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={20} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                    {t('invNoMatching')}
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
                    {isVis('date')     && <td className="muted">{fmtDateShort(r.created_at, locale)}</td>}
                    {isVis('category') && (
                      <td>
                        <span className={'chip ' + (r.category === 'RAM' ? 'info' : r.category === 'SSD' ? 'pos' : r.category === 'HDD' ? 'cool' : 'warn')}>
                          {r.category}
                        </span>
                      </td>
                    )}
                    <td>
                      <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {itemLabel(r)}
                        {r.health != null && r.health < wsNumber('low_health_pct', 50) && (
                          <span className="chip warn" style={{ fontSize: 10 }}>{r.health}%</span>
                        )}
                      </div>
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
                    {isManager && isVis('unitCost')  && <td className="num mono muted">{fmtUSD(r.unit_cost, locale)}</td>}
                    {isVis('sellPrice')  && (
                      <td className="num mono">{r.sell_price != null ? fmtUSD(r.sell_price, locale) : '—'}</td>
                    )}
                    {isManager && isVis('profit')    && (
                      <td className="num mono pos">{profit != null ? fmtUSD(profit, locale) : '—'}</td>
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
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button
                          className="btn icon sm"
                          title={t('invQuickViewTooltip')}
                          onClick={() => setQuickView(r)}
                        >
                          <Icon name="eye" size={12} />
                        </button>
                        <button
                          className="btn icon sm"
                          title={t('edit')}
                          onClick={() => onEditItem(r.id)}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>

        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 12, color: 'var(--fg-subtle)',
        }}>
          <div>{loadedOnce ? `Showing ${items.length} ${items.length === 1 ? 'entry' : 'entries'}` : 'Loading inventory…'}</div>
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
              <span className="sel-bar-num">{fmtUSD0(selectedTotals.value, locale)}</span>{' '}
              <span className="sel-bar-label">est. revenue</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={clearSelection}>Clear</button>
            <button className="btn" onClick={openTransferModal}>
              <Icon name="truck" size={14} /> {t('transfer')}
            </button>
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

      {transferItems && (
        <DesktopInventoryTransfer
          items={transferItems}
          warehouses={whs}
          onClose={() => setTransferItems(null)}
          onSaved={(n, destShort) => {
            setTransferItems(null);
            clearSelection();
            refetchInventory();
            showToast?.(t('transferredToast', { n, warehouse: destShort }), 'success');
          }}
        />
      )}

      {showActivity && (
        <DesktopActivityDrawer onClose={() => setShowActivity(false)} />
      )}

      {quickView && (
        <InventoryQuickView
          item={quickView}
          peers={(() => {
            const key = canonicalPartNumber(quickView.part_number);
            return key ? items.filter(p => canonicalPartNumber(p.part_number) === key) : [quickView];
          })()}
          onClose={() => setQuickView(null)}
          onEdit={() => { onEditItem(quickView.id); setQuickView(null); }}
        />
      )}
    </>
  );
}

// ─── Quick View modal ────────────────────────────────────────────────────────
// Read-only popover summarising one inventory item + its peer items sharing
// the same part_number. Mirrors design/inventory.jsx#QuickViewModal.
function InventoryQuickView({
  item, peers, onClose, onEdit,
}: {
  item: InventoryRow;
  peers: InventoryRow[];
  onClose: () => void;
  onEdit: () => void;
}) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  useEscapeKey(onClose);

  // Merged change log: union of inventory_events across every PO line sharing
  // this part number (backend canonicalises the match, same rule as peers).
  const [log, setLog] = useState<QvEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const pn = item.part_number;
    if (!pn) { setLog([]); return; }
    api.get<{ events: QvEvent[] }>(`/api/inventory/events/by-part?partNumber=${encodeURIComponent(pn)}`)
      .then(r => { if (alive) setLog(r.events); })
      .catch(err => {
        if (alive) setLog([]);
        handleFetchError(err);
      });
    return () => { alive = false; };
  }, [item.part_number]);

  const title =
    item.category === 'RAM' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.generation ?? ''}`.trim()
    : item.category === 'SSD' ? `${item.brand ?? ''} ${item.capacity ?? ''}`.trim()
    : item.category === 'HDD' ? `${item.brand ?? ''} ${item.capacity ?? ''}`.trim()
    : (item.description ?? item.part_number ?? '—');
  const sub =
    item.category === 'RAM' ? [item.classification, item.speed && `${item.speed}MHz`, item.rank].filter(Boolean).join(' · ')
    : item.category === 'SSD' ? [item.interface, item.form_factor, item.health != null && `${item.health}%`].filter(Boolean).join(' · ')
    : item.category === 'HDD' ? [item.interface, item.form_factor, item.rpm && `${item.rpm}rpm`, item.health != null && `${item.health}%`].filter(Boolean).join(' · ')
    : (item.part_number ?? '');

  const agg = peers.reduce((acc, p) => {
    if (p.status === 'In Transit') acc.inTransit += p.qty;
    else if (p.status === 'Reviewing' || p.status === 'Done') acc.inStock += p.qty;
    return acc;
  }, { inTransit: 0, inStock: 0 });
  const total = agg.inTransit + agg.inStock;
  const transitPct = total > 0 ? (agg.inTransit / total) * 100 : 0;
  const stockPct = total > 0 ? (agg.inStock / total) * 100 : 0;

  const catIcon = item.category === 'RAM' ? 'chip' : (item.category === 'SSD' || item.category === 'HDD') ? 'drive' : 'box';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)',
        display: 'grid', placeItems: 'center', zIndex: 80, padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderRadius: 14, width: 'min(520px, 100%)',
          boxShadow: '0 24px 60px rgba(15,23,42,0.18)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name={catIcon} size={20} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span className={'chip ' + (item.category === 'RAM' ? 'info' : item.category === 'SSD' ? 'pos' : item.category === 'HDD' ? 'cool' : 'warn')} style={{ fontSize: 10.5 }}>
                {item.category}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{item.id}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>
          </div>
          <button className="btn icon sm" onClick={onClose} title={t('closeBtn')}><Icon name="x" size={12} /></button>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Qty breakdown */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
                This line
              </div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>
                {item.qty}<span style={{ fontSize: 12, color: 'var(--fg-subtle)', marginLeft: 4 }}>units</span>
              </div>
            </div>
            {total > 0 && (
              <>
                <div style={{
                  display: 'flex', height: 7, borderRadius: 999, overflow: 'hidden',
                  background: 'var(--bg-soft)', border: '1px solid var(--border)',
                }}>
                  {agg.inTransit > 0 && (
                    <div style={{
                      width: transitPct + '%',
                      background: 'var(--info)',
                      backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in oklch, var(--info) 70%, white) 4px 8px)',
                    }} />
                  )}
                  {agg.inStock > 0 && (
                    <div style={{ width: stockPct + '%', background: 'var(--pos)' }} />
                  )}
                </div>
                <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                  {agg.inTransit > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="truck" size={11} style={{ color: 'var(--info)' }} />
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--info)' }}>{agg.inTransit}</span>
                      <span style={{ color: 'var(--fg-subtle)' }}>in transit</span>
                    </span>
                  )}
                  {agg.inStock > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Icon name="warehouse" size={11} style={{ color: 'var(--pos)' }} />
                      <span className="mono" style={{ fontWeight: 600, color: 'var(--pos)' }}>{agg.inStock}</span>
                      <span style={{ color: 'var(--fg-subtle)' }}>in stock</span>
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }}>across part number</span>
                </div>
              </>
            )}
          </div>

          {/* Key facts grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
            border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
          }}>
            <QVCell label="Warehouse" value={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Icon name="warehouse" size={11} style={{ color: 'var(--fg-subtle)' }} />
                {item.warehouse_short ?? '—'}
              </span>
            } />
            <QVCell label="Condition" value={item.condition} borderLeft />
            <QVCell label="Part number" value={<span className="mono" style={{ fontSize: 12 }}>{item.part_number ?? '—'}</span>} borderTop />
            <QVCell label="Sell price" value={
              <span className="mono" style={{ fontWeight: 600 }}>
                {item.sell_price != null ? fmtUSD(item.sell_price, locale) : '—'}
              </span>
            } borderLeft borderTop />
          </div>

          {/* Submitter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--fg-subtle)' }}>
            <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>{item.user_initials}</span>
            Submitted by <span style={{ color: 'var(--fg)', fontWeight: 500 }}>{item.user_name}</span> · {fmtDateShort(item.created_at, locale)}
          </div>

          {/* Change log — merged across every PO line with this part number */}
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
                Change log
              </div>
              <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>across part number</span>
            </div>
            <div style={{
              border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
              maxHeight: 220, overflowY: 'auto',
            }}>
              {log == null && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-subtle)' }}>Loading…</div>
              )}
              {log != null && log.length === 0 && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--fg-subtle)' }}>No changes logged yet.</div>
              )}
              {log != null && log.map((e, i) => (
                <div key={e.id} style={{
                  display: 'flex', gap: 10, padding: '10px 14px',
                  borderBottom: i < log.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--bg-soft)', color: 'var(--fg-muted)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <Icon name={QV_KIND_ICON[e.kind] ?? 'info'} size={12} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{summarizeQvEvent(e, locale)}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                      {e.actor_name ?? 'system'} · {relTime(e.created_at, locale)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{
          padding: '12px 20px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn accent" onClick={onEdit}>
            <Icon name="edit" size={13} /> Edit details
          </button>
        </div>
      </div>
    </div>
  );
}

// One row of the merged change log. Shape mirrors GET /api/inventory/events/by-part.
type QvEvent = {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  created_at: string;
  line_id: string;
  actor_name: string | null;
};

const QV_KIND_ICON: Record<string, IconName> = {
  created: 'plus',
  edited:  'edit',
  status:  'flag',
  priced:  'tag',
  transferred: 'truck',
  received: 'warehouse',
  reopened: 'history',
  sold: 'tag',
};

function summarizeQvEvent(e: QvEvent, locale = 'en-US'): string {
  const d = e.detail ?? {};
  switch (e.kind) {
    case 'created':     return 'Item created';
    case 'status':      return `Status → ${String(d.to ?? '?')}`;
    case 'priced':      return `Sell price → ${fmtUSD0(Number(d.to ?? 0), locale)}`;
    case 'edited':      return `${String(d.field ?? 'field')}: ${String(d.from ?? '?')} → ${String(d.to ?? '?')}`;
    case 'transferred': return `Transferred ${String(d.qty ?? '')} → ${String(d.to ?? '?')}`.replace('  ', ' ');
    case 'received':    return `Received at ${String(d.at ?? '?')}`;
    case 'reopened':    return 'Transfer re-opened';
    case 'sold':        return `Sold${d.qty != null ? ` ${String(d.qty)}` : ''}`;
    default:            return e.kind;
  }
}

function QVCell({ label, value, borderLeft, borderTop }: {
  label: string;
  value: ReactNode;
  borderLeft?: boolean;
  borderTop?: boolean;
}) {
  return (
    <div style={{
      padding: '10px 14px',
      borderLeft: borderLeft ? '1px solid var(--border)' : 'none',
      borderTop:  borderTop  ? '1px solid var(--border)' : 'none',
    }}>
      <div style={{
        fontSize: 10.5, color: 'var(--fg-subtle)',
        textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
      }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 3 }}>{value}</div>
    </div>
  );
}
