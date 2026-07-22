import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  StatusChangeDialog, type MetaStatus, type StatusAttachment,
} from '../../components/StatusChangeDialog';
import {
  CloseSellOrderDialog, ReopenSellOrderDialog,
} from '../../components/CloseSellOrderDialog';
import { useT } from '../../lib/i18n';
import { api, archiveSellOrder, unarchiveSellOrder } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { useRoute, navigate, match } from '../../lib/route';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { shareOrCopy } from '../../lib/shareOrCopy';
import { fmtUSD, fmtUSD0, fmtMoney, fmtDate, fmtDateShort } from '../../lib/format';
import { fetchRateToUsd, type FxInfo } from '../../lib/fxRate';
import { sellOrderStatuses } from '../../lib/lookups';
import { closeReasonLabelKey } from '../../lib/closeReasons';
import { usePersisted } from '../../lib/listMemory';
import { TableSkeleton, FormSkeleton } from '../../components/Skeleton';
import { SellOrderHistory } from '../../components/SellOrderHistory';
import { CustomerPicker, CurrencyPicker, type Customer, type MemberOption } from './DesktopSellOrderDraft';
import { useAuth } from '../../lib/auth';
import { AddInventoryPicker, type SellableItem } from '../../components/AddInventoryPicker';
import { AttachmentChip } from '../../components/AttachmentChip';
import { PriceImportSection } from './SellOrderPriceImportDialog';
import { applyPriceRows } from '../../lib/priceImport';

type Currency = 'USD' | 'CNY';

// Statuses that capture per-status evidence (text note + attachments). The
// `needs_meta` flag lives on the sell_order_statuses row.
const needsDialog = (s: string): s is MetaStatus =>
  sellOrderStatuses.some(o => o.id === s && o.needsMeta);

type StatusMetaEntry = {
  note: string | null;
  when: string | null;
  attachments: StatusAttachment[];
};
type StatusMetaMap = Record<MetaStatus, StatusMetaEntry>;

// The per-status evidence (note + attachments) captured at Shipped / Awaiting
// payment / Done. Edit mode surfaces it through the stepper + StatusChangeDialog;
// view mode has no stepper, so without this the attachments are unreachable.
function evidenceEntries(meta: StatusMetaMap | null) {
  if (!meta) return [];
  return sellOrderStatuses
    .filter(o => o.needsMeta)
    .map(o => [o.id as MetaStatus, (meta as Record<string, StatusMetaEntry>)[o.id]] as const)
    .filter(([, m]) => m && (!!m.note || m.attachments.length > 0));
}

type SellOrderSummary = {
  id: string;
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done' | 'Closed';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  currency: Currency;
  customer: { id: string; name: string; short: string; region: string };
  paymentReceiverName: string | null;
  lineCount: number;
  qty: number;
  subtotal: number;
  total: number;
  adjusted: boolean;
};

type SellOrderLine = {
  id: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  label: string;
  sub: string | null;
  partNumber: string | null;
  qty: number;
  unitPrice: number;        // USD
  nativeUnitPrice: number;  // order-currency price (== unitPrice for USD)
  condition: string | null;
  warehouse: string | null;
  lineTotal: number;        // USD
  position: number;
  inventoryId: string | null;
  warehouseId: string | null;
  maxQty: number;
};

// Group saved-order lines by warehouse so the picking/shipping view lists
// everything that ships from one place together — mirrors the draft builder's
// warehouse rhythm. Lines keep their order; groups appear first-seen.
function groupLinesByWarehouse(lines: SellOrderLine[]) {
  const map = new Map<string, { warehouse: string | null; lines: SellOrderLine[] }>();
  for (const l of lines) {
    const key = l.warehouseId ?? '__none';
    if (!map.has(key)) map.set(key, { warehouse: l.warehouse, lines: [] });
    map.get(key)!.lines.push(l);
  }
  return [...map.values()];
}

// Editable line shape used by the edit modal (mirrors the new-order builder).
type EditLine = {
  _cid: string;                 // stable client id for React keys (never sent to the API)
  inventoryId: string | null;
  category: SellOrderLine['category'];
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  qty: number;
  maxQty: number;
  unitPrice: number;        // native (order-currency) price — sent to the API
  warehouseId: string | null;
  warehouse: string | null;
  condition: string | null;
};

const toEditLine = (l: SellOrderLine): EditLine => ({
  _cid:        crypto.randomUUID(),
  inventoryId: l.inventoryId,
  category:    l.category,
  label:       l.label,
  subLabel:    l.sub,
  partNumber:  l.partNumber,
  qty:         l.qty,
  maxQty:      l.maxQty,
  unitPrice:   l.nativeUnitPrice,
  warehouseId: l.warehouseId,
  warehouse:   l.warehouse,
  condition:   l.condition,
});

// Stable signature for change detection — order matters (position = index).
const linesSig = (ls: EditLine[]) =>
  JSON.stringify(ls.map(l => [l.inventoryId, l.qty, l.unitPrice, l.label, l.partNumber, l.warehouseId, l.condition]));

type SellOrderDetailType = {
  id: string;
  status: SellOrderSummary['status'];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  closeReasonId: string | null;
  createdBy: string | null;
  paymentReceivedBy: { id: string; name: string } | null;
  currency: Currency;
  fxRateToUsd: number;
  fxSource: string;
  customer: { id: string; name: string; short: string; region: string };
  lines: SellOrderLine[];
  subtotal: number;        // USD
  total: number;           // USD
  nativeSubtotal: number;  // order currency
  nativeTotal: number;
  // Set once the final total was negotiated down (or up) via adjust-price.
  // preAdjustNativeTotal is the first pre-negotiation total (badge baseline).
  priceAdjustment: {
    preAdjustNativeTotal: number;
    adjustedAt: string;
    adjustedBy: { id: string; name: string } | null;
  } | null;
  statusMeta: StatusMetaMap;
};

// Driven by sell_order_statuses; ids match sell_orders.status CHECK constraint.
type SellStatusId = SellOrderSummary['status'];
const toneFor  = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone  ?? 'muted';
const shortFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.short ?? s;

// Closed & Done are the terminal statuses — orders that have left the working
// pipeline. They're hidden from the default list (which shows only orders still
// in flight: Draft / Shipped / Awaiting payment); the "Show closed & done"
// toggle reveals them.
const CLOSED_DONE_STATUSES = new Set<SellStatusId>(['Done', 'Closed']);

type SellOrdersProps = {
  onNewFromInventory?: () => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function DesktopSellOrders({ onNewFromInventory, onToast }: SellOrdersProps = {}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [orders, setOrders] = useState<SellOrderSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | SellStatusId>('all');
  const [search, setSearch] = useState('');
  // Off by default: the list opens on active orders only. Turning it on reveals
  // the terminal ones (Done / Closed) and also pulls in archived orders, so the
  // detail-modal Archive action never strands an order out of reach.
  const [showClosedDone, setShowClosedDone] = usePersisted<boolean>('desktop.sellOrders.showClosedDone', false);
  const [exporting, setExporting] = useState(false);
  const { path } = useRoute();

  const runExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const p = new URLSearchParams();
      if (statusFilter !== 'all') p.set('status', statusFilter);
      if (showClosedDone) p.set('includeArchived', 'true');
      await api.download(`/api/sell-orders/export?${p}`, 'sell-orders.xlsx');
    } catch (e) {
      handleFetchError(e);
    } finally {
      setExporting(false);
    }
  };
  const editMatch = match('/sell-orders/:id/edit', path);
  const viewMatch = match('/sell-orders/:id', path);
  const open: { id: string; mode: 'view' | 'edit' } | null =
    editMatch ? { id: editMatch.id, mode: 'edit' }
    : viewMatch ? { id: viewMatch.id, mode: 'view' }
    : null;

  const reload = () => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    if (showClosedDone) p.set('includeArchived', 'true');
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`)
      .then(r => setOrders(r.items))
      .catch(handleFetchError)
      .finally(() => setLoadedOnce(true));
  };
  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    if (showClosedDone) p.set('includeArchived', 'true');
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`)
      .then(r => { if (alive) setOrders(r.items); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoadedOnce(true); });
    return () => { alive = false; };
  }, [statusFilter, showClosedDone]);

  const visible = useMemo(() => {
    let list = orders;
    // Hide terminal orders from the default all-status view unless the toggle
    // is on. A specific status pick is an explicit request, so don't prune it.
    if (!showClosedDone && statusFilter === 'all') {
      list = list.filter(o => !CLOSED_DONE_STATUSES.has(o.status));
    }
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(o =>
      o.id.toLowerCase().includes(q) || o.customer.name.toLowerCase().includes(q),
    );
  }, [orders, search, showClosedDone, statusFilter]);

  const stats = useMemo(() => {
    const m: Record<string, { count: number; revenue: number }> = {};
    for (const o of sellOrderStatuses) m[o.id] = { count: 0, revenue: 0 };
    // Guard: if lookups didn't load, or an order carries an unknown status,
    // skip it rather than crashing the page.
    orders.forEach(o => {
      const entry = m[o.status];
      if (!entry) return;
      entry.count++;
      entry.revenue += o.total;
    });
    return m;
  }, [orders]);


  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('sellOrders')}</h1>
          <div className="page-sub">{t('sellOrdersSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={runExport} disabled={exporting}>
            <Icon name="download" size={14} /> {exporting ? `${t('export')}…` : t('export')}
          </button>
          {onNewFromInventory && (
            <button className="btn accent" onClick={onNewFromInventory}>
              <Icon name="plus" size={14} /> New from inventory
            </button>
          )}
        </div>
      </div>

      {/* Status pipeline tiles — click to filter, matches design's so-stat */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${sellOrderStatuses.length || 4}, 1fr)`, gap: 12 }}>
        {sellOrderStatuses.map(({ id: s }) => {
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
                <span className={'chip ' + toneFor(s) + ' dot'} style={{ fontSize: 10.5 }}>{shortFor(s)}</span>
              </div>
              <div className="so-stat-num">{stats[s].count}</div>
              <div className="so-stat-sub">{fmtUSD0(stats[s].revenue, locale)}</div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="select"
              style={{ width: 160, height: 32, fontSize: 12.5, padding: '0 12px' }}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">{t('invAllStatuses')}</option>
              {sellOrderStatuses.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ position: 'relative' }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              className="input"
              placeholder={t('soSearchPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 260 }}
            />
          </div>
          <button
            className="btn"
            onClick={() => setShowClosedDone(v => !v)}
            aria-pressed={showClosedDone}
            disabled={statusFilter !== 'all'}
            title={statusFilter !== 'all'
              ? t('closedDoneToggleAllOnly')
              : showClosedDone ? t('hideClosedDoneSOs') : t('showClosedDoneSOs')}
            style={{
              marginLeft: 'auto',
              height: 32, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6,
              background: showClosedDone ? 'var(--bg-soft)' : undefined,
              borderColor: showClosedDone ? 'var(--border-strong)' : undefined,
              color: showClosedDone ? 'var(--fg)' : 'var(--fg-muted)',
            }}
          >
            <Icon name="check2" size={12} />
            {showClosedDone ? t('hideClosedDoneBtn') : t('showClosedDoneBtn')}
          </button>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={10} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('soColOrder')}</th>
                <th>{t('fieldCustomer')}</th>
                <th>{t('paymentReceiverLabel')}</th>
                <th>{t('soColCreated')}</th>
                <th>{t('soColUpdated')}</th>
                <th className="num">{t('lines')}</th>
                <th className="num">{t('sodUnits')}</th>
                <th className="num">{t('eoTotal')}</th>
                <th>{t('status')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(o => (
                <tr
                  key={o.id}
                  className="row-hover"
                  style={{ cursor: 'pointer', opacity: o.archivedAt ? 0.55 : 1 }}
                  onClick={() => navigate('/sell-orders/' + o.id)}
                >
                  <td className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {o.id}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          shareOrCopy({
                            url: `${location.origin}${location.pathname}#/sell-orders/${o.id}`,
                            title: t('shareOrder'),
                            copiedMsg: t('orderIdCopied'),
                            failedMsg: t('orderIdCopyFailed'),
                            onToast,
                          });
                        }}
                        aria-label={t('shareOrder')}
                        title={t('shareOrder')}
                        style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, marginLeft: 2, lineHeight: 0, cursor: 'pointer', verticalAlign: 'middle' }}
                      >
                        <Icon name="paperclip" size={12} />
                      </button>
                      {o.archivedAt && (
                        <span className="chip muted" style={{ fontSize: 10, padding: '1px 6px', marginLeft: 6 }}>
                          <Icon name="box" size={9} style={{ marginRight: 3 }} />
                          archived
                        </span>
                      )}
                    </span>
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{o.customer.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{o.customer.region}</div>
                  </td>
                  <td className={o.paymentReceiverName ? undefined : 'muted'}>
                    {o.paymentReceiverName ?? '—'}
                  </td>
                  <td className="muted">{fmtDateShort(o.createdAt, locale)}</td>
                  <td className="muted">{fmtDateShort(o.updatedAt, locale)}</td>
                  <td className="num mono">{o.lineCount}</td>
                  <td className="num mono">{o.qty}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>
                    {o.adjusted && (
                      <span
                        className="chip warn"
                        title={t('soAdjustedListTooltip')}
                        style={{ fontSize: 9.5, padding: '1px 5px', marginRight: 6, verticalAlign: 'middle' }}
                      >
                        {t('soAdjustedShort')}
                      </span>
                    )}
                    {fmtUSD0(o.total, locale)}
                  </td>
                  <td><span className={'chip dot ' + toneFor(o.status)}>{o.status}</span></td>
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn icon sm"
                        title={t('soViewTooltip')}
                        onClick={() => navigate('/sell-orders/' + o.id)}
                      >
                        <Icon name="eye" size={12} />
                      </button>
                      {o.status !== 'Done' && o.status !== 'Closed' && (
                        <button
                          className="btn icon sm"
                          title={`Edit ${o.status.toLowerCase()} order`}
                          onClick={() => navigate('/sell-orders/' + o.id + '/edit')}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
                    No orders match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {open && (
        <SellOrderDetail
          id={open.id}
          mode={open.mode}
          onSwitchToEdit={() => navigate('/sell-orders/' + open.id + '/edit')}
          onClose={() => navigate('/sell-orders')}
          onSaved={() => { reload(); navigate('/sell-orders'); }}
          onAdjusted={reload}
        />
      )}
    </>
  );
}

// ─── Download split menu ─────────────────────────────────────────────────────
// One trigger, two file types: the printable packing list (PDF) and the
// per-warehouse spreadsheet (XLSX). Opens upward — it lives in the modal footer
// pinned to the screen bottom. A transparent backdrop captures the outside
// click; Escape closes the menu without bubbling up to close the whole modal.
function DownloadMenu({ orderId }: { orderId: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const download = async (path: string, name: string) => {
    setOpen(false);
    try {
      await api.download(path, name);
    } catch (e) {
      handleFetchError(e);
    }
  };

  return (
    <div className="popmenu-wrap">
      <button
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('soDownloadTooltip')}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="download" size={14} /> {t('soDownload')}
        <Icon name="chevronDown" size={13} className="caret" />
      </button>
      {open && (
        <>
          <div className="popmenu-backdrop" onClick={() => setOpen(false)} />
          <div className="popmenu up" role="menu">
            <button
              type="button"
              className="popmenu-item"
              role="menuitem"
              onClick={() => download(`/api/sell-orders/${orderId}/packing-list`, `${orderId}-packing-list.pdf`)}
            >
              <span className="ico"><Icon name="invoice" size={17} /></span>
              <span className="txt">
                <b>{t('soDownloadPackingPdf')}</b>
                <small>{t('soPackingListTooltip')}</small>
              </span>
            </button>
            <button
              type="button"
              className="popmenu-item"
              role="menuitem"
              onClick={() => download(`/api/sell-orders/${orderId}/spreadsheet`, `${orderId}.xlsx`)}
            >
              <span className="ico"><Icon name="analytics" size={17} /></span>
              <span className="txt">
                <b>{t('soDownloadSpreadsheet')}</b>
                <small>{t('soDownloadSpreadsheetHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className="popmenu-item"
              role="menuitem"
              onClick={() => download(`/api/sell-orders/${orderId}/price-template`, `${orderId}-price-template.xlsx`)}
            >
              <span className="ico"><Icon name="dollar" size={17} /></span>
              <span className="txt">
                <b>{t('soDownloadPriceTemplate')}</b>
                <small>{t('soDownloadPriceTemplateHint')}</small>
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Detail / edit modal ─────────────────────────────────────────────────────
// View mode is read-only. Edit mode is the full builder (same as a new sell
// order): re-pick the customer, edit line qty / unit price, drop lines, plus
// advance the status and edit internal notes. Saved via PATCH /sell-orders/:id.
function SellOrderDetail({
  id, mode, onClose, onSaved, onSwitchToEdit, onAdjusted,
}: {
  id: string;
  mode: 'view' | 'edit';
  onClose: () => void;
  onSaved: () => void;
  onSwitchToEdit: () => void;
  // Price adjustment keeps the modal open (unlike onSaved, which navigates
  // away); this only refreshes the list behind it.
  onAdjusted?: () => void;
}) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const [order, setOrder] = useState<SellOrderDetailType | null>(null);
  const [draft, setDraft] = useState<{
    status: SellOrderDetailType['status'];
    notes: string;
    customerId: string;
    paymentReceivedBy: string;   // '' = not assigned
    currency: Currency;
    lines: EditLine[];
  } | null>(null);
  // FX snapshot for the draft's currency (null for USD or until it loads).
  const [fx, setFx] = useState<FxInfo | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-status evidence — loaded from the order, mutated live by the dialog,
  // and used to render paperclip badges on each step.
  const [statusMeta, setStatusMeta] = useState<StatusMetaMap | null>(null);
  // Pending transition into a meta-status. null = no dialog showing.
  const [pending, setPending] = useState<MetaStatus | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [unarchiving, setUnarchiving] = useState(false);
  // Close (Draft/Shipped/Awaiting → Closed) and Reopen (Closed → Draft).
  // Both go through dedicated dialogs because the backend gates differ from
  // the standard meta-status dialog: Close needs a structured reason +
  // freeform note; Reopen needs a freeform note (and clears the reason).
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showReopenDialog, setShowReopenDialog] = useState(false);
  // Bumped after a Close/Reopen succeeds so the order effect re-fetches —
  // simpler than pulling a stale callback through the dialog props.
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped after every successful mutation so <SellOrderHistory> re-fetches.
  const [historyKey, setHistoryKey] = useState(0);
  // Inline negotiated-total editor in the view modal. Available while the
  // order is still adjustable (pre-Done) even though the rest of the view is
  // read-only — buyers counter-offer right before paying.
  const [adjusting, setAdjusting] = useState(false);
  const [adjustInput, setAdjustInput] = useState('');
  const [adjustSaving, setAdjustSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<{ order: SellOrderDetailType }>(`/api/sell-orders/${id}`)
      .then(r => {
        if (!alive) return;
        setOrder(r.order);
        setStatusMeta(r.order.statusMeta);
        setDraft({
          status: r.order.status,
          notes: r.order.notes ?? '',
          customerId: r.order.customer.id,
          paymentReceivedBy: r.order.paymentReceivedBy?.id ?? '',
          currency: r.order.currency,
          lines: r.order.lines.map(toEditLine),
        });
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [id, refreshKey]);

  // Keep an FX snapshot for whatever currency the draft is in, so totals can
  // show a USD-equivalent and saves re-price against a fresh rate.
  const draftCurrency = draft?.currency ?? 'USD';
  useEffect(() => {
    if (draftCurrency === 'USD') { setFx(null); return; }
    let alive = true;
    fetchRateToUsd(draftCurrency)
      .then(info => { if (alive) setFx(info); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [draftCurrency]);

  // Customer + member lists — only needed when editing (re-pick either).
  useEffect(() => {
    if (mode !== 'edit') return;
    let alive = true;
    api.get<{ items: Customer[] }>('/api/customers')
      .then(r => { if (alive) setCustomers(r.items); })
      .catch(handleFetchError);
    api.get<{ items: (MemberOption & { role: string })[] }>('/api/members')
      .then(r => { if (alive) setMembers(r.items.filter(m => m.role === 'manager')); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [mode]);

  useEscapeKey(onClose);

  const customerChanged = !!order && !!draft && draft.customerId !== order.customer.id;
  const currencyChanged = !!order && !!draft && draft.currency !== order.currency;
  const receiverChanged = !!order && !!draft
    && (draft.paymentReceivedBy || null) !== (order.paymentReceivedBy?.id ?? null);
  const linesChanged = !!order && !!draft
    && linesSig(draft.lines) !== linesSig(order.lines.map(toEditLine));
  const dirty = order && draft && (
    draft.status !== order.status
    || (draft.notes ?? '') !== (order.notes ?? '')
    || customerChanged
    || receiverChanged
    || currencyChanged
    || linesChanged
  );

  // The stepper shows only the forward lifecycle. Closed is an off-ramp
  // reached via the Discard button (CloseSellOrderDialog needs a reason the
  // stepper can't supply), so it's omitted here — the status still exists in
  // the backend, the list filter, and the stat cards.
  const stepperStatuses = sellOrderStatuses.filter(o => o.id !== 'Closed');

  // draft.lines hold native prices. rateToUsd is null for CNY until fx loads.
  const draftRateToUsd = draftCurrency === 'USD' ? 1 : (fx?.rateToUsd ?? null);
  const editTotals = useMemo(() => {
    if (!draft || !order) return null;
    const subtotalNative = draft.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
    const subtotalUsd = draftRateToUsd == null ? null : +(subtotalNative * draftRateToUsd).toFixed(2);
    return {
      subtotalNative: +subtotalNative.toFixed(2),
      subtotalUsd,
    };
  }, [draft, order, draftRateToUsd]);

  // Sign-aware delta chip label: "−5%" for the usual talk-down, "+3%" when the
  // final price moved up. Baseline is the first pre-negotiation total.
  const adjustPctLabel = useMemo(() => {
    if (!order?.priceAdjustment) return '';
    const from = order.priceAdjustment.preAdjustNativeTotal;
    if (from <= 0) return '';
    const pct = (order.nativeTotal / from - 1) * 100;
    const rounded = Math.abs(pct) < 0.1 ? pct.toFixed(2) : pct.toFixed(1);
    return `${pct >= 0 ? '+' : '−'}${Math.abs(Number(rounded))}%`;
  }, [order]);

  const submitAdjust = async () => {
    if (!order) return;
    const target = Number(adjustInput);
    if (!Number.isFinite(target) || target <= 0) return;
    setAdjustSaving(true);
    try {
      // The server prorates line prices and returns the achieved total (the
      // typed value may be unreachable at 2dp granularity) — re-fetch instead
      // of trusting the input.
      await api.post(`/api/sell-orders/${order.id}/adjust-price`, {
        targetTotal: +target.toFixed(2),
      });
      setAdjusting(false);
      setRefreshKey(k => k + 1);
      setHistoryKey(k => k + 1);
      onAdjusted?.();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setAdjustSaving(false);
    }
  };

  // Warehouse-grouped views of the line set — one card per warehouse, mirroring
  // the draft builder's rhythm.
  const viewGroups = useMemo(
    () => (order ? groupLinesByWarehouse(order.lines) : []),
    [order],
  );
  // Edit-mode groups keep each line's original index so qty / price / remove
  // mutations still address the flat draft.lines array.
  const editGroups = useMemo(() => {
    if (!draft) return [];
    const map = new Map<string, { warehouse: string | null; items: { l: EditLine; idx: number }[] }>();
    draft.lines.forEach((l, idx) => {
      const key = l.warehouseId ?? '__none';
      if (!map.has(key)) map.set(key, { warehouse: l.warehouse, items: [] });
      map.get(key)!.items.push({ l, idx });
    });
    return [...map.values()];
  }, [draft]);

  const setLine = (idx: number, patch: Partial<EditLine>) =>
    setDraft(d => d && { ...d, lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) });
  // The same product can sit in several warehouses; price is a per-product
  // figure, so a unit-price edit applies to every line of that product at once
  // — the user shouldn't have to retype it per warehouse.
  const productKey = (l: EditLine) => `${l.partNumber ?? ''}|${l.label}|${l.condition ?? ''}`;
  const setPrice = (key: string, unitPrice: number) =>
    setDraft(d => d && { ...d, lines: d.lines.map(l => (productKey(l) === key ? { ...l, unitPrice } : l)) });
  const removeLine = (idx: number) =>
    setDraft(d => d && { ...d, lines: d.lines.filter((_, i) => i !== idx) });

  // Append picked sellable lots as new lines. Price follows the per-product rule:
  // if the order already carries that product, reuse its unit price; else 0 for
  // the user to fill in. Dedupe against lots already on the draft (the server
  // only excludes lots on *saved* open orders, not session-local adds).
  const addLines = (picked: SellableItem[]) =>
    setDraft(d => {
      if (!d) return d;
      const have = new Set(d.lines.map(l => l.inventoryId).filter(Boolean));
      const priceFor = (it: SellableItem) => {
        const key = `${it.partNumber ?? ''}|${it.label}|${it.condition ?? ''}`;
        return d.lines.find(l => productKey(l) === key)?.unitPrice ?? 0;
      };
      const fresh: EditLine[] = picked
        .filter(it => !have.has(it.inventoryId))
        .map(it => ({
          _cid:        crypto.randomUUID(),
          inventoryId: it.inventoryId,
          category:    it.category as EditLine['category'],
          label:       it.label,
          subLabel:    it.subLabel,
          partNumber:  it.partNumber,
          qty:         it.availableQty,
          maxQty:      it.availableQty,
          unitPrice:   priceFor(it),
          warehouseId: it.warehouseId,
          warehouse:   it.warehouseName,
          condition:   it.condition,
        }));
      return { ...d, lines: [...d.lines, ...fresh] };
    });

  const save = async () => {
    if (!order || !draft) return;
    if (draft.lines.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Status transitions live on the dedicated endpoint — it takes a row
      // lock + an idempotency guard so a Done order can't be reverted, and so
      // a double-submit can't fire the consume-stock side-effects twice. PATCH
      // refuses to touch status outright.
      const statusChanged = draft.status !== order.status;
      if (statusChanged) {
        await api.post(`/api/sell-orders/${order.id}/status`, {
          to: draft.status,
          // Evidence (note + attachments) is uploaded live by
          // StatusChangeDialog into status-meta tables, so we just announce
          // the transition here. Re-send the note so the /status upsert
          // preserves the dialog's note instead of nulling it out — evidence
          // itself is optional, but a captured note shouldn't be lost.
          note: (statusMeta as Record<string, { note: string | null } | undefined> | null)
            ?.[draft.status]?.note ?? undefined,
        });
        setHistoryKey(k => k + 1);
      }
      // Structural / notes edits go through PATCH. Skip the call entirely if
      // only status changed — saves a round trip and avoids touching
      // updated_at when nothing else moved.
      const patchBody: Record<string, unknown> = {};
      if ((draft.notes ?? '') !== (order.notes ?? '')) patchBody.notes = draft.notes;
      if (customerChanged) patchBody.customerId = draft.customerId;
      if (receiverChanged) patchBody.paymentReceivedBy = draft.paymentReceivedBy || null;
      // A currency change re-prices every line at the new rate, so the backend
      // requires the full line set alongside it — resend lines whenever either
      // the currency or the lines themselves changed.
      if (currencyChanged) patchBody.currency = draft.currency;
      if (linesChanged || currencyChanged) {
        patchBody.lines = draft.lines.map(l => ({
          inventoryId: l.inventoryId,
          category:    l.category,
          label:       l.label,
          subLabel:    l.subLabel,
          partNumber:  l.partNumber,
          qty:         l.qty,
          unitPrice:   l.unitPrice,
          warehouseId: l.warehouseId,
          condition:   l.condition,
        }));
      }
      if (Object.keys(patchBody).length > 0) {
        await api.patch(`/api/sell-orders/${order.id}`, patchBody);
        setHistoryKey(k => k + 1);
      }
      onSaved();
    } catch (e) {
      // Keep the editor open with the user's edits intact — calling onSaved
      // here would navigate away and discard unsaved work.
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // "locked" = no structural edits or status moves allowed. Done is the
  // terminal happy path; Closed is the off-ramp (line set + customer + status
  // are all frozen until the order is Reopened). Both the list-page edit
  // pencil and the in-page status stepper / line inputs respect this guard.
  const locked = !!order && (order.status === 'Done' || order.status === 'Closed');
  const editable = mode === 'edit' && !locked;
  const closeReasonLabel = order?.closeReasonId
    ? t(closeReasonLabelKey(order.closeReasonId))
    : null;
  // statusMeta is typed as Record<MetaStatus,…> (Shipped/Awaiting/Done) but
  // the backend now also emits a 'Closed' entry (needs_meta=TRUE on the row);
  // read it through a widened lens so TS doesn't complain.
  const closedNote = order?.status === 'Closed'
    ? ((statusMeta as Record<string, StatusMetaEntry> | null)?.Closed?.note ?? null)
    : null;

  return (
    <>
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: editable ? 1100 : 760, width: 'calc(100vw - 80px)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            {order && (
              <>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono">{order.id}</span>
                  <span className={'chip dot ' + toneFor(order.status)}>{order.status}</span>
                  {order.currency !== 'USD' && (
                    <span
                      className="chip muted"
                      style={{ fontSize: 10 }}
                      title={t('soFxRateNote', { rate: (1 / order.fxRateToUsd).toFixed(4), currency: order.currency, source: order.fxSource })}
                    >
                      {order.currency}
                    </span>
                  )}
                  {editable && <span className="chip accent" style={{ fontSize: 10 }}>Editing</span>}
                </div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{order.customer.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {t('soColCreated')} {fmtDate(order.createdAt, locale)} · {t('soColUpdated')} {fmtDate(order.updatedAt, locale)} · {order.customer.region}
                </div>
              </>
            )}
            {!order && (
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ marginBottom: 6 }}>
                <span className="skeleton" style={{ width: 90, height: 10, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              </div>
              <span className="skeleton" style={{ width: 220, height: 22, borderRadius: 6, display: 'inline-block', marginBottom: 6 }} aria-hidden />
              <div>
                <span className="skeleton" style={{ width: 180, height: 11, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              </div>
            </div>
          )}
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div style={{ padding: '18px 24px', overflowY: 'auto', flex: 1, maxHeight: '70vh' }}>
          {!order ? (
            <FormSkeleton fields={6} withHeader={false} />
          ) : order && draft ? (
            <>
              {order.status === 'Closed' && (
                <div style={{
                  marginBottom: 18, padding: '10px 14px', borderRadius: 8,
                  background: 'var(--bg-soft)', border: '1px solid var(--border)',
                  fontSize: 12.5, color: 'var(--fg-muted)',
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                }}>
                  <Icon name="x" size={13} style={{ marginTop: 2, color: 'var(--fg-subtle)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--fg)' }}>
                      Closed{closeReasonLabel ? ` — ${closeReasonLabel}` : ''}
                    </div>
                    {closedNote && (
                      <div style={{ marginTop: 2, color: 'var(--fg-subtle)' }}>{closedNote}</div>
                    )}
                  </div>
                </div>
              )}
              {editable && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
                  }}>
                    <Icon name="flag" size={12} /> Order status
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                      Manually advance as the deal progresses
                    </span>
                  </div>
                  <div className="so-stepper">
                    {stepperStatuses.map(({ id: s }, i) => {
                      const currentIdx = stepperStatuses.findIndex(o => o.id === draft.status);
                      const active = s === draft.status;
                      const reached = currentIdx >= 0 && i <= currentIdx;
                      const meta = needsDialog(s) ? statusMeta?.[s] : null;
                      const hasMeta = !!meta && (!!meta.note || meta.attachments.length > 0);
                      const dialog = needsDialog(s);
                      return (
                        <Fragment key={s}>
                          <button
                            type="button"
                            className={'so-step' + (active ? ' active' : '') + (reached ? ' reached' : '')}
                            onClick={() => {
                              // Re-open the dialog even on the current status so the
                              // user can come back and add more notes / attachments.
                              if (dialog) setPending(s);
                              else setDraft({ ...draft, status: s });
                            }}
                            title={dialog
                              ? (s === draft.status
                                  ? `Edit tracking note / attachments for ${s}`
                                  : `Advance to ${s} (add tracking note / attachments)`)
                              : `Set status to ${s}`}
                          >
                            <span className="so-step-dot">{i + 1}</span>
                            <span className="so-step-label">
                              {s}
                              {hasMeta && (
                                <span
                                  title={t('soTrackingRecorded')}
                                  style={{
                                    marginLeft: 6, display: 'inline-flex',
                                    alignItems: 'center', color: 'var(--accent-strong)',
                                  }}
                                >
                                  <Icon name="paperclip" size={11} />
                                </span>
                              )}
                            </span>
                          </button>
                          {i < stepperStatuses.length - 1 && (
                            <span className={'so-step-bar' + (i < currentIdx ? ' reached' : '')} />
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                  {draft.status !== order.status && (
                    <div style={{
                      marginTop: 10, padding: '8px 12px', borderRadius: 8,
                      background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                      fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <Icon name="info" size={13} />
                      Status will change from <strong>{order.status}</strong> to <strong>{draft.status}</strong> when you save.
                    </div>
                  )}
                </div>
              )}

              {editable && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
                  }}>
                    <Icon name="user" size={12} /> Customer
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                    <div style={{ flex: '0 1 340px', minWidth: 240 }}>
                      <CustomerPicker
                        customers={customers.length ? customers : [{
                          id: order.customer.id, name: order.customer.name,
                          short_name: order.customer.short, region: order.customer.region,
                        }]}
                        value={draft.customerId}
                        onChange={id => setDraft({ ...draft, customerId: id })}
                        onCreated={c => { setCustomers(prev => [...prev, c]); setDraft({ ...draft, customerId: c.id }); }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('currency.label')}</span>
                      <CurrencyPicker
                        value={draft.currency}
                        onChange={cur => setDraft({ ...draft, currency: cur })}
                        t={t}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{t('paymentReceiverLabel')}</span>
                      <select
                        className="select"
                        style={{ maxWidth: 260 }}
                        value={draft.paymentReceivedBy}
                        onChange={e => setDraft({ ...draft, paymentReceivedBy: e.target.value })}
                      >
                        <option value="">{t('paymentReceiverNone')}</option>
                        {/* A deactivated receiver isn't in the active-members list —
                            keep them selectable so opening the editor doesn't
                            silently clear the assignment. */}
                        {order.paymentReceivedBy
                          && !members.some(m => m.id === order.paymentReceivedBy!.id) && (
                          <option value={order.paymentReceivedBy.id}>{order.paymentReceivedBy.name}</option>
                        )}
                        {members.map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {currencyChanged && (
                    <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                      {t('soFxRateNote', { rate: fx ? fx.oneUsdInQuote.toFixed(4) : '…', currency: draft.currency, source: fx?.source ?? '…' })}
                    </div>
                  )}
                </div>
              )}

              {/* Line items — warehouse-grouped cards, mirrors the draft builder */}
              <div className="so-section">
                <div className="so-section-head">
                  <Icon name="inventory" size={14} /> {t('sodLineItems')}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>
                    {t('sodLineSummary', {
                      units: (editable ? draft.lines : order.lines).reduce((a, l) => a + l.qty, 0),
                      lines: (editable ? draft.lines : order.lines).length,
                      whs: editable ? editGroups.length : viewGroups.length,
                    })}
                  </span>
                </div>

                {!editable && viewGroups.map((g, gi) => (
                  <div key={(g.warehouse ?? '__none') + gi} style={{ marginBottom: 14 }}>
                    <div className="so-wh-head">
                      <Icon name="warehouse" size={12} />
                      <span>{g.warehouse ?? t('sodNoWarehouse')}</span>
                      <span className="so-wh-count">{g.lines.length}</span>
                    </div>
                    <table className="so-line-table">
                      <thead>
                        <tr>
                          <th style={{ width: '44%' }}>{t('item')}</th>
                          <th className="num" style={{ width: 110 }}>{t('qty')}</th>
                          <th className="num" style={{ width: 140 }}>{t('fieldUnitPrice')}</th>
                          <th className="num" style={{ width: 120 }}>{t('sodLineTotal')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map(l => (
                          <tr key={l.id}>
                            <td>
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{l.label}</div>
                              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                                <span className="mono">{l.partNumber ?? '—'}</span>
                                {l.condition && (<><span>·</span><span>{l.condition}</span></>)}
                              </div>
                            </td>
                            <td className="num mono">{l.qty}</td>
                            <td className="num mono">{fmtMoney(l.nativeUnitPrice, order.currency, locale)}</td>
                            <td className="num mono" style={{ fontWeight: 500 }}>
                              {fmtMoney(l.qty * l.nativeUnitPrice, order.currency, locale)}
                              {order.currency !== 'USD' && (
                                <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 400 }}>
                                  {t('soUsdEquiv', { usd: fmtUSD(l.lineTotal, locale) })}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

                {editable && (
                  <table className="so-line-table">
                    <thead>
                      <tr>
                        <th style={{ width: '34%' }}>{t('item')}</th>
                        <th>{t('warehouse')}</th>
                        <th className="num" style={{ width: 110 }}>{t('qty')}</th>
                        <th className="num" style={{ width: 130 }}>{t('fieldUnitPrice')}</th>
                        <th className="num" style={{ width: 110 }}>{t('sodLineTotal')}</th>
                        <th style={{ width: 36 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.lines.map((l, idx) => (
                        <tr key={l._cid}>
                          <td>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>{l.label}</div>
                            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                              <span className="mono">{l.partNumber ?? '—'}</span>
                              {l.condition && (<><span>·</span><span>{l.condition}</span></>)}
                            </div>
                          </td>
                          <td style={{ fontSize: 12 }}>{l.warehouse ?? t('sodNoWarehouse')}</td>
                          <td className="num">
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                              <input
                                className="so-mini-input"
                                type="number"
                                min={1}
                                max={l.maxQty}
                                value={l.qty}
                                onChange={e => setLine(idx, {
                                  qty: Math.max(1, Math.min(l.maxQty, Number(e.target.value) || 0)),
                                })}
                                style={{ width: 64 }}
                              />
                              <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>
                                / {l.maxQty}
                              </span>
                            </div>
                          </td>
                          <td className="num">
                            <input
                              className="so-mini-input"
                              type="number"
                              step="0.01"
                              value={l.unitPrice}
                              onChange={e => setPrice(productKey(l), Number(e.target.value) || 0)}
                              style={{ width: 90 }}
                            />
                          </td>
                          <td className="num mono" style={{ fontWeight: 500 }}>{fmtMoney(l.qty * l.unitPrice, draft.currency, locale)}</td>
                          <td>
                            <button
                              className="btn icon sm"
                              title={t('soRemoveLineTooltip')}
                              disabled={draft.lines.length === 1}
                              onClick={() => removeLine(idx)}
                            >
                              <Icon name="x" size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {editable && (
                  <button
                    className="btn sm"
                    onClick={() => setAdding(true)}
                    style={{ marginTop: 10 }}
                  >
                    <Icon name="plus" size={13} /> {t('soAddInventory')}
                  </button>
                )}
              </div>

              {editable && (
                <div className="help" style={{ marginTop: 8 }}>
                  {t('soEditReplacesHint')}
                </div>
              )}

              {editable && (
                <PriceImportSection
                  orderId={order.id}
                  currency={draft.currency}
                  locale={locale}
                  onApply={rows =>
                    setDraft(d => d && { ...d, lines: applyPriceRows(d.lines, rows) })}
                />
              )}

              <div style={{ marginTop: 20, marginLeft: 'auto', maxWidth: 320 }}>
                <div className="so-row total">
                  <span>
                    {t('eoTotal')}
                    {/* Negotiated-total pencil — view mode only. Edit mode
                        already lets the user retype line prices, and mixing
                        the two would race unsaved edits against the saved-line
                        proration. */}
                    {!editable && !locked && !adjusting && (
                      <button
                        className="btn icon sm"
                        title={t('soAdjustTotal')}
                        aria-label={t('soAdjustTotal')}
                        style={{ marginLeft: 6, verticalAlign: 'middle' }}
                        onClick={() => {
                          setAdjustInput(String(order.nativeTotal));
                          setAdjusting(true);
                        }}
                      >
                        <Icon name="edit" size={12} />
                      </button>
                    )}
                  </span>
                  {adjusting ? (
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                      <input
                        className="mono"
                        type="number"
                        min={0.01}
                        step={0.01}
                        autoFocus
                        value={adjustInput}
                        disabled={adjustSaving}
                        onChange={e => setAdjustInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void submitAdjust();
                          if (e.key === 'Escape') { e.stopPropagation(); setAdjusting(false); }
                        }}
                        style={{ width: 110, textAlign: 'right' }}
                      />
                      <button
                        className="btn icon sm"
                        title={t('soAdjustApply')}
                        disabled={adjustSaving}
                        onClick={() => void submitAdjust()}
                      >
                        <Icon name="check" size={12} />
                      </button>
                      <button
                        className="btn icon sm"
                        title={t('cancel')}
                        disabled={adjustSaving}
                        onClick={() => setAdjusting(false)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ) : (
                    <span className="mono">
                      {!editable && order.priceAdjustment && (
                        <s style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginRight: 8 }}>
                          {fmtMoney(order.priceAdjustment.preAdjustNativeTotal, draftCurrency, locale)}
                        </s>
                      )}
                      {fmtMoney(
                        editable && editTotals ? editTotals.subtotalNative : order.nativeTotal,
                        draftCurrency, locale,
                      )}
                    </span>
                  )}
                </div>
                {!editable && order.priceAdjustment && !adjusting && (
                  <div className="so-row" style={{ fontSize: 11.5 }}>
                    <span />
                    <span
                      className="chip warn"
                      style={{ fontSize: 10.5 }}
                      title={t('soAdjustedTooltip', {
                        name: order.priceAdjustment.adjustedBy?.name ?? '—',
                        when: fmtDate(order.priceAdjustment.adjustedAt, locale),
                      })}
                    >
                      {t('soAdjustedChip', { pct: adjustPctLabel })}
                    </span>
                  </div>
                )}
                {draftCurrency !== 'USD' && (
                  <div className="so-row muted" style={{ fontSize: 11.5 }}>
                    <span />
                    <span className="mono">
                      {t('soUsdEquiv', {
                        usd: fmtUSD(editable && editTotals ? editTotals.subtotalUsd : order.total, locale),
                      })}
                    </span>
                  </div>
                )}
              </div>

              {/* Tracking & evidence — read-only view of the per-status notes and
                  attachments. Edit mode reaches these via the stepper dialog; view
                  mode has no stepper, so this is the only place to open the files. */}
              {!editable && evidenceEntries(statusMeta).length > 0 && (
                <div className="so-section" style={{ marginTop: 24 }}>
                  <div className="so-section-head"><Icon name="paperclip" size={14} /> {t('soEvidenceSection')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {evidenceEntries(statusMeta).map(([status, m]) => (
                      <div key={status}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-subtle)', marginBottom: 6 }}>{status}</div>
                        {m.note && (
                          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: m.attachments.length ? 8 : 0 }}>
                            {m.note}
                          </div>
                        )}
                        {m.attachments.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {m.attachments.map(a => (
                              <AttachmentChip key={a.id} a={a} />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Payment receiver — read-only in view mode (edit mode has the
                  select up in the Customer block) */}
              {!editable && (
                <div className="so-section" style={{ marginTop: 24 }}>
                  <div className="so-section-head"><Icon name="user" size={14} /> {t('paymentReceiverLabel')}</div>
                  <div style={{ fontSize: 13, color: order.paymentReceivedBy ? 'var(--fg)' : 'var(--fg-subtle)' }}>
                    {order.paymentReceivedBy?.name ?? t('paymentReceiverNone')}
                  </div>
                </div>
              )}

              {/* Internal notes — section in both modes; read-only text when viewing */}
              <div className="so-section" style={{ marginTop: 24 }}>
                <div className="so-section-head"><Icon name="edit" size={14} /> {t('ieInternalNotes')}</div>
                {editable ? (
                  <textarea
                    className="input"
                    rows={3}
                    value={draft.notes}
                    onChange={e => setDraft({ ...draft, notes: e.target.value })}
                    placeholder={t('soTrackingPlaceholder')}
                    style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
                  />
                ) : (
                  <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: order.notes ? 'var(--fg)' : 'var(--fg-subtle)' }}>
                    {order.notes || t('none')}
                  </div>
                )}
              </div>

              <details open style={{ marginTop: 24 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '8px 0' }}>
                  History
                </summary>
                <div style={{ marginTop: 12 }}>
                  <SellOrderHistory sellOrderId={order.id} refreshKey={historyKey} />
                </div>
              </details>
            </>
          ) : null}
        </div>

        {order && draft && (
          <div className="so-footer">
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {editable && (dirty ? 'Unsaved changes' : 'No changes')}
            </span>
            {saveError && (
              <div role="alert" style={{ marginRight: 'auto', alignSelf: 'center', color: 'var(--neg, #c0392b)', fontSize: 13 }}>
                {saveError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <DownloadMenu orderId={order.id} />
              {editable && order.status !== 'Draft' && order.archivedAt === null && (
                <button
                  className="btn"
                  onClick={() => setConfirmArchive(true)}
                  title={t('soArchiveTooltip')}
                  style={{ color: 'var(--neg, #c0392b)', borderColor: 'var(--neg, #c0392b)' }}
                >
                  <Icon name="box" size={14} /> Archive
                </button>
              )}
              {editable && order.archivedAt !== null && (
                <button
                  className="btn"
                  disabled={unarchiving}
                  onClick={async () => {
                    setUnarchiving(true);
                    try {
                      await unarchiveSellOrder(order.id);
                      setHistoryKey(k => k + 1);
                      onSaved();
                      onClose();
                    } catch (e) {
                      handleFetchError(e);
                      setUnarchiving(false);
                    }
                  }}
                >
                  <Icon name="box" size={14} /> {unarchiving ? 'Unarchiving…' : 'Unarchive'}
                </button>
              )}
              {/* Close as off-ramp: available in edit mode, everywhere except
                  Done (terminal) and Closed (already closed → use Reopen
                  instead). Manager-only surface is enforced at the page level
                  so no extra role check. */}
              {editable && order.status !== 'Done' && (
                <button
                  className="btn"
                  onClick={() => setShowCloseDialog(true)}
                  title={t('soDiscardTooltip')}
                  style={{ color: 'var(--neg, #c0392b)', borderColor: 'var(--border-strong)' }}
                >
                  Discard
                </button>
              )}
              {/* Reopen is creator-only (backend 403s anyone else). Orders with
                  no creator (MCP-created) stay reopenable by any manager. */}
              {order.status === 'Closed'
                && (order.createdBy === null || order.createdBy === user?.id) && (
                <button
                  className="btn accent"
                  onClick={() => setShowReopenDialog(true)}
                  title={t('soReopenTooltip')}
                >
                  <Icon name="edit" size={14} /> Reopen
                </button>
              )}
              {!editable && !locked && (
                <button className="btn accent" onClick={onSwitchToEdit}>
                  <Icon name="edit" size={14} /> Edit order
                </button>
              )}
              {editable && (
                <button
                  className="btn accent"
                  onClick={save}
                  disabled={!dirty || saving || (draftCurrency !== 'USD' && draftRateToUsd == null)}
                >
                  <Icon name="check2" size={14} /> {saving ? 'Saving…' : 'Save changes'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    {pending && order && draft && statusMeta && (
      <StatusChangeDialog
        orderId={order.id}
        to={pending}
        currentStatus={draft.status}
        initialNote={statusMeta[pending].note ?? ''}
        initialAttachments={statusMeta[pending].attachments}
        onCancel={() => setPending(null)}
        onConfirm={({ note, attachments }) => {
          setStatusMeta(prev => prev && {
            ...prev,
            [pending]: { note, attachments, when: new Date().toISOString() },
          });
          setDraft({ ...draft, status: pending });
          setPending(null);
        }}
        onMutated={() => setHistoryKey(k => k + 1)}
      />
    )}
    {adding && draft && (
      <AddInventoryPicker
        excludeIds={new Set(draft.lines.map(l => l.inventoryId).filter((x): x is string => !!x))}
        locale={locale}
        onClose={() => setAdding(false)}
        onAdd={addLines}
      />
    )}
    {confirmArchive && order && (
      <ArchiveSellOrderDialog
        orderId={order.id}
        onCancel={() => setConfirmArchive(false)}
        onConfirmed={() => { setConfirmArchive(false); onSaved(); onClose(); }}
      />
    )}
    {showCloseDialog && order && (
      <CloseSellOrderDialog
        orderId={order.id}
        currentStatus={order.status}
        onCancel={() => setShowCloseDialog(false)}
        onClosed={() => {
          setShowCloseDialog(false);
          // Close is the off-ramp — same pattern as Archive: re-load list +
          // navigate away. The list chip flips to Closed; the user can
          // re-open the order from there if they need to Reopen.
          onSaved();
        }}
      />
    )}
    {showReopenDialog && order && (
      <ReopenSellOrderDialog
        orderId={order.id}
        onCancel={() => setShowReopenDialog(false)}
        onReopened={() => {
          setShowReopenDialog(false);
          // Stay on the order so the user can continue editing the now-Draft
          // SO. refreshKey re-runs the GET so status/locked/header-strip flip.
          setRefreshKey(k => k + 1);
          setHistoryKey(k => k + 1);
        }}
      />
    )}
    </>
  );
}

// Type-the-SO-id confirm dialog. Local to DesktopSellOrders — the only
// caller. Disabled "Archive" button until the typed text exactly matches
// the order id (case-sensitive). Errors render inline; dialog stays open
// so the user can retry.
function ArchiveSellOrderDialog({
  orderId, onCancel, onConfirmed,
}: {
  orderId: string;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onCancel);

  const matches = typed.trim() === orderId;

  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await archiveSellOrder(orderId);
      onConfirmed();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Archive failed';
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 460, width: 'calc(100vw - 80px)' }}>
        <div className="modal-head">
          <div className="modal-title">Archive sell order</div>
        </div>
        <div className="modal-body" style={{ padding: 20 }}>
          <p style={{ marginTop: 0, fontSize: 13.5 }}>
            Archiving hides this sell order from the default list. It stays in the
            database with its lines, commissions, and audit history intact, and can
            be unarchived later.
          </p>
          <label className="label" style={{ marginTop: 12 }}>
            Type <span className="mono" style={{ fontWeight: 600 }}>{orderId}</span> to confirm
          </label>
          <input
            className="input mono"
            autoFocus
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && matches) submit(); }}
            placeholder={orderId}
          />
          {error && (
            <div role="alert" style={{ marginTop: 10, color: 'var(--neg, #c0392b)', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn danger"
            onClick={submit}
            disabled={!matches || busy}
            style={{ background: 'var(--neg, #c0392b)', color: '#fff', borderColor: 'transparent' }}
          >
            {busy ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </div>
    </div>
  );
}
