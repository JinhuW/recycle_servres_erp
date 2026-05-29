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
import { fmtUSD, fmtUSD0, fmtDate, fmtDateShort } from '../../lib/format';
import { sellOrderStatuses } from '../../lib/lookups';
import { closeReasonLabelKey } from '../../lib/closeReasons';
import { usePersisted } from '../../lib/listMemory';
import { TableSkeleton, FormSkeleton } from '../../components/Skeleton';
import { SellOrderHistory } from '../../components/SellOrderHistory';
import { CustomerPicker, type Customer } from './DesktopSellOrderDraft';

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

type SellOrderSummary = {
  id: string;
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done' | 'Closed';
  notes: string | null;
  createdAt: string;
  archivedAt: string | null;
  customer: { id: string; name: string; short: string; region: string };
  lineCount: number;
  qty: number;
  subtotal: number;
  total: number;
};

type SellOrderLine = {
  id: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  label: string;
  sub: string | null;
  partNumber: string | null;
  qty: number;
  unitPrice: number;
  condition: string | null;
  warehouse: string | null;
  lineTotal: number;
  position: number;
  inventoryId: string | null;
  warehouseId: string | null;
  maxQty: number;
};

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
  unitPrice: number;
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
  unitPrice:   l.unitPrice,
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
  archivedAt: string | null;
  closeReasonId: string | null;
  customer: { id: string; name: string; short: string; region: string };
  lines: SellOrderLine[];
  subtotal: number;
  total: number;
  statusMeta: StatusMetaMap;
};

// Driven by sell_order_statuses; ids match sell_orders.status CHECK constraint.
type SellStatusId = SellOrderSummary['status'];
const toneFor  = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone  ?? 'muted';
const shortFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.short ?? s;

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
  const [showArchived, setShowArchived] = usePersisted<boolean>('desktop.sellOrders.showArchived', false);
  const [exporting, setExporting] = useState(false);
  const { path } = useRoute();

  const runExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const p = new URLSearchParams();
      if (statusFilter !== 'all') p.set('status', statusFilter);
      if (showArchived) p.set('includeArchived', 'true');
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
    if (showArchived) p.set('includeArchived', 'true');
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`)
      .then(r => setOrders(r.items))
      .catch(handleFetchError)
      .finally(() => setLoadedOnce(true));
  };
  useEffect(() => {
    let alive = true;
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    if (showArchived) p.set('includeArchived', 'true');
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`)
      .then(r => { if (alive) setOrders(r.items); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoadedOnce(true); });
    return () => { alive = false; };
  }, [statusFilter, showArchived]);

  const visible = useMemo(() => {
    if (!search.trim()) return orders;
    const q = search.toLowerCase();
    return orders.filter(o =>
      o.id.toLowerCase().includes(q) || o.customer.name.toLowerCase().includes(q),
    );
  }, [orders, search]);

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
            onClick={() => setShowArchived(v => !v)}
            title={showArchived ? t('hideArchivedSOs') : t('showArchivedSOs')}
            style={{
              height: 32, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6,
              background: showArchived ? 'var(--bg-soft)' : undefined,
              borderColor: showArchived ? 'var(--border-strong)' : undefined,
              color: showArchived ? 'var(--fg)' : 'var(--fg-muted)',
            }}
          >
            <Icon name="box" size={12} />
            {showArchived ? t('hideArchivedBtn') : t('showArchivedBtn')}
          </button>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={8} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('soColOrder')}</th>
                <th>{t('fieldCustomer')}</th>
                <th>{t('soColCreated')}</th>
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
                  <td className="muted">{fmtDateShort(o.createdAt, locale)}</td>
                  <td className="num mono">{o.lineCount}</td>
                  <td className="num mono">{o.qty}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>{fmtUSD0(o.total, locale)}</td>
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
                  <td colSpan={8} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
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
        />
      )}
    </>
  );
}

// ─── Detail / edit modal ─────────────────────────────────────────────────────
// View mode is read-only. Edit mode is the full builder (same as a new sell
// order): re-pick the customer, edit line qty / unit price, drop lines, plus
// advance the status and edit internal notes. Saved via PATCH /sell-orders/:id.
function SellOrderDetail({
  id, mode, onClose, onSaved, onSwitchToEdit,
}: {
  id: string;
  mode: 'view' | 'edit';
  onClose: () => void;
  onSaved: () => void;
  onSwitchToEdit: () => void;
}) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [order, setOrder] = useState<SellOrderDetailType | null>(null);
  const [draft, setDraft] = useState<{
    status: SellOrderDetailType['status'];
    notes: string;
    customerId: string;
    lines: EditLine[];
  } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Per-status evidence — loaded from the order, mutated live by the dialog,
  // and used to render paperclip badges on each step.
  const [statusMeta, setStatusMeta] = useState<StatusMetaMap | null>(null);
  // Pending transition into a meta-status. null = no dialog showing.
  const [pending, setPending] = useState<MetaStatus | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
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
          lines: r.order.lines.map(toEditLine),
        });
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [id, refreshKey]);

  // Customer list — only needed when editing (re-pick customer).
  useEffect(() => {
    if (mode !== 'edit') return;
    let alive = true;
    api.get<{ items: Customer[] }>('/api/customers')
      .then(r => { if (alive) setCustomers(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [mode]);

  useEscapeKey(onClose);

  const customerChanged = !!order && !!draft && draft.customerId !== order.customer.id;
  const linesChanged = !!order && !!draft
    && linesSig(draft.lines) !== linesSig(order.lines.map(toEditLine));
  const dirty = order && draft && (
    draft.status !== order.status
    || (draft.notes ?? '') !== (order.notes ?? '')
    || customerChanged
    || linesChanged
  );

  const editTotals = useMemo(() => {
    if (!draft || !order) return null;
    const subtotal = draft.lines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
    return {
      subtotal: +subtotal.toFixed(2),
      total: +subtotal.toFixed(2),
    };
  }, [draft, order]);

  const setLine = (idx: number, patch: Partial<EditLine>) =>
    setDraft(d => d && { ...d, lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) });
  const removeLine = (idx: number) =>
    setDraft(d => d && { ...d, lines: d.lines.filter((_, i) => i !== idx) });

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
          // the transition here. Re-send the note so the POST passes the
          // "note or attachments" evidence gate even if nothing was uploaded
          // through the attachments path.
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
      if (linesChanged) {
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
                  {editable && <span className="chip accent" style={{ fontSize: 10 }}>Editing</span>}
                </div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{order.customer.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  {fmtDate(order.createdAt, locale)} · {order.customer.region}
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
                    {sellOrderStatuses.map(({ id: s }, i) => {
                      const currentIdx = sellOrderStatuses.findIndex(o => o.id === draft.status);
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
                              if (dialog && s !== draft.status) setPending(s);
                              else setDraft({ ...draft, status: s });
                            }}
                            title={dialog
                              ? `Advance to ${s} (add tracking note / attachments)`
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
                          {i < sellOrderStatuses.length - 1 && (
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
                  <div style={{ maxWidth: 360 }}>
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
                </div>
              )}

              <table className="so-line-table">
                <thead>
                  <tr>
                    <th>{t('item')}</th>
                    <th>{t('warehouse')}</th>
                    <th className="num">{t('qty')}</th>
                    <th className="num">{t('vendorTableUnit')}</th>
                    <th className="num">{t('eoTotal')}</th>
                    {editable && <th style={{ width: 36 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {!editable && order.lines.map(l => (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{l.label}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{l.partNumber}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{l.warehouse ?? '—'}</td>
                      <td className="num mono">{l.qty}</td>
                      <td className="num mono">{fmtUSD(l.unitPrice, locale)}</td>
                      <td className="num mono" style={{ fontWeight: 500 }}>{fmtUSD(l.lineTotal, locale)}</td>
                    </tr>
                  ))}
                  {editable && draft.lines.map((l, idx) => (
                    <tr key={l._cid}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{l.label}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{l.partNumber}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{l.warehouse ?? '—'}</td>
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
                          onChange={e => setLine(idx, { unitPrice: Number(e.target.value) || 0 })}
                          style={{ width: 90 }}
                        />
                      </td>
                      <td className="num mono" style={{ fontWeight: 500 }}>{fmtUSD(l.qty * l.unitPrice, locale)}</td>
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
              {editable && (
                <div className="help" style={{ marginTop: 8 }}>
                  {t('soEditReplacesHint')}
                </div>
              )}

              <div style={{ marginTop: 20, marginLeft: 'auto', maxWidth: 280 }}>
                <div className="so-row total">
                  <span>{t('eoTotal')}</span>
                  <span className="mono">{fmtUSD(editable && editTotals ? editTotals.total : order.total, locale)}</span>
                </div>
              </div>

              {editable && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label className="label">{t('ieInternalNotes')}</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={draft.notes}
                    onChange={e => setDraft({ ...draft, notes: e.target.value })}
                    placeholder={t('soTrackingPlaceholder')}
                  />
                </div>
              )}

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
              {!editable && (order.notes ? `Notes: ${order.notes}` : 'No internal notes')}
              {editable && (dirty ? 'Unsaved changes' : 'No changes')}
            </span>
            {saveError && (
              <div role="alert" style={{ marginRight: 'auto', alignSelf: 'center', color: 'var(--neg, #c0392b)', fontSize: 13 }}>
                {saveError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
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
              {order.status === 'Closed' && (
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
                  disabled={!dirty || saving}
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
