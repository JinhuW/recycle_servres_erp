import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  StatusChangeDialog, type MetaStatus, type StatusAttachment,
} from '../../components/StatusChangeDialog';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, fmtDate, fmtDateShort } from '../../lib/format';
import { sellOrderStatuses } from '../../lib/lookups';
import { TableSkeleton, FormSkeleton } from '../../components/Skeleton';

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
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done';
  discountPct: number;
  notes: string | null;
  createdAt: string;
  customer: { id: string; name: string; short: string; terms: string; region: string };
  lineCount: number;
  qty: number;
  subtotal: number;
  discount: number;
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
  statusMeta: StatusMetaMap;
};

// Driven by sell_order_statuses; ids match sell_orders.status CHECK constraint.
type SellStatusId = SellOrderSummary['status'];
const toneFor  = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone  ?? 'muted';
const shortFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.short ?? s;

type SellOrdersProps = {
  onNewFromInventory?: () => void;
};

export function DesktopSellOrders({ onNewFromInventory }: SellOrdersProps = {}) {
  const { t } = useT();
  const [orders, setOrders] = useState<SellOrderSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | SellStatusId>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<{ id: string; mode: 'view' | 'edit' } | null>(null);

  const reload = () => {
    const p = new URLSearchParams();
    if (statusFilter !== 'all') p.set('status', statusFilter);
    api.get<{ items: SellOrderSummary[] }>(`/api/sell-orders?${p}`)
      .then(r => setOrders(r.items))
      .catch(console.error)
      .finally(() => setLoadedOnce(true));
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
    for (const o of sellOrderStatuses) m[o.id] = { count: 0, revenue: 0 };
    orders.forEach(o => { m[o.status].count++; m[o.status].revenue += o.total; });
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
              placeholder="Search order, customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 260 }}
            />
          </div>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={8} />
          ) : (
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
                  onClick={() => setOpen({ id: o.id, mode: 'view' })}
                >
                  <td className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>{o.id}</td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{o.customer.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{o.customer.region}</div>
                  </td>
                  <td className="muted">{fmtDateShort(o.createdAt)}</td>
                  <td className="num mono">{o.lineCount}</td>
                  <td className="num mono">{o.qty}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>{fmtUSD0(o.total)}</td>
                  <td><span className="chip">{o.customer.terms}</span></td>
                  <td><span className={'chip dot ' + toneFor(o.status)}>{o.status}</span></td>
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="btn icon sm"
                        title="View"
                        onClick={() => setOpen({ id: o.id, mode: 'view' })}
                      >
                        <Icon name="eye" size={12} />
                      </button>
                      {o.status !== 'Done' && (
                        <button
                          className="btn icon sm"
                          title={`Edit ${o.status.toLowerCase()} order`}
                          onClick={() => setOpen({ id: o.id, mode: 'edit' })}
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
                  <td colSpan={9} style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)' }}>
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
          onSwitchToEdit={() => setOpen({ id: open.id, mode: 'edit' })}
          onClose={() => setOpen(null)}
          onSaved={() => { reload(); setOpen(null); }}
        />
      )}
    </>
  );
}

// ─── Detail / edit modal ─────────────────────────────────────────────────────
// View mode is read-only; Edit mode lets the manager change status and
// internal notes (the only mutable fields exposed in the UI). Line items are
// always read-only — the backend doesn't yet expose a per-line edit endpoint.
function SellOrderDetail({
  id, mode, onClose, onSaved, onSwitchToEdit,
}: {
  id: string;
  mode: 'view' | 'edit';
  onClose: () => void;
  onSaved: () => void;
  onSwitchToEdit: () => void;
}) {
  const [order, setOrder] = useState<SellOrderDetailType | null>(null);
  const [draft, setDraft] = useState<{ status: SellOrderDetailType['status']; notes: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // Per-status evidence — loaded from the order, mutated live by the dialog,
  // and used to render paperclip badges on each step.
  const [statusMeta, setStatusMeta] = useState<StatusMetaMap | null>(null);
  // Pending transition into a meta-status. null = no dialog showing.
  const [pending, setPending] = useState<MetaStatus | null>(null);

  useEffect(() => {
    api.get<{ order: SellOrderDetailType }>(`/api/sell-orders/${id}`)
      .then(r => {
        setOrder(r.order);
        setStatusMeta(r.order.statusMeta);
        setDraft({
          status: r.order.status,
          notes: r.order.notes ?? '',
        });
      })
      .catch(console.error);
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = order && draft && (
    draft.status !== order.status
    || (draft.notes ?? '') !== (order.notes ?? '')
  );

  const save = async () => {
    if (!order || !draft) return;
    setSaving(true);
    try {
      await api.patch(`/api/sell-orders/${order.id}`, {
        status: draft.status,
        notes: draft.notes,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const editable = mode === 'edit';

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
                  {fmtDate(order.createdAt)} · {order.customer.region} · {order.customer.terms}
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
                                  title="Tracking info recorded"
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
              {editable && (
                <div className="help" style={{ marginTop: 8 }}>
                  Line items are read-only until a per-line edit endpoint lands.
                </div>
              )}

              <div style={{ marginTop: 20, marginLeft: 'auto', maxWidth: 280 }}>
                <div className="so-row"><span>Subtotal</span><span className="mono">{fmtUSD(order.subtotal)}</span></div>
                {order.discount > 0 && (
                  <div className="so-row">
                    <span>Discount{order.discountPct ? ` (${order.discountPct}%)` : ''}</span>
                    <span className="mono">−{fmtUSD(order.discount)}</span>
                  </div>
                )}
                <div className="so-row total">
                  <span>Total</span>
                  <span className="mono">{fmtUSD(order.total)}</span>
                </div>
              </div>

              {editable && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label className="label">Internal notes</label>
                  <textarea
                    className="input"
                    rows={3}
                    value={draft.notes}
                    onChange={e => setDraft({ ...draft, notes: e.target.value })}
                    placeholder="Tracking number, shipping carrier, payment reference…"
                  />
                </div>
              )}
            </>
          ) : null}
        </div>

        {order && draft && (
          <div className="so-footer">
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {!editable && (order.notes ? `Notes: ${order.notes}` : 'No internal notes')}
              {editable && (dirty ? 'Unsaved changes' : 'No changes')}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>{editable ? 'Cancel' : 'Close'}</button>
              {!editable && order.status !== 'Done' && (
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
      />
    )}
    </>
  );
}
