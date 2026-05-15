import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api, deleteOrder } from '../../lib/api';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import type { Order, OrderLine, Warehouse } from '../../lib/types';
import { LineDrawer, blankLine, type Line } from './DesktopSubmit';

type Props = {
  order: Order;
  onCancel: () => void;
  onSaved: (msg: string) => void;
};

// Internal line state — the shared `Line` plus the original DB id (when the
// line came from the server), the line's persisted status, and a dirty
// marker so we can scope the PATCH.
type EditLine = Line & { _id?: string; _status?: string; _dirty?: boolean };

// Edit-order page lifted from design/dashboard.jsx#EditOrderPage. Table is
// read-only summary rows; clicking a row opens the right-side LineDrawer
// (same component the new-order flow uses), passed `editing={true}` so the
// drawer adds sell-price + revenue/profit/margin. Meta row + status stepper
// + Cancel/Save sit in a sticky bottom card.
//
// Purchasers stay in control through Draft and In Transit, then hand the
// order off to the manager at Reviewing (where pricing happens). Managers may
// move it through any stage and edit prices/qty. Once an order reaches "Done"
// the whole page becomes read-only.
export function DesktopEditOrder({ order, onCancel, onSaved }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const isPurchaser = user?.role !== 'manager';
  const orderLocked = isCompleted(order.status);
  const purchaserCanEdit =
    !isPurchaser || order.status === 'Draft' || order.status === 'In Transit';
  const canEditOrder = purchaserCanEdit && !orderLocked;
  const allowedStatuses = isPurchaser
    ? order.status === 'Draft'      ? ['Draft', 'In Transit']
    : order.status === 'In Transit' ? ['In Transit', 'Reviewing']
    :                                 [order.status]
    : ORDER_STATUSES.slice();

  const [status, setStatus] = useState(order.status);
  const [lines, setLines] = useState<EditLine[]>(() => order.lines.map(orderLineToEditLine));
  const [notes, setNotes] = useState<string>(order.notes ?? '');
  const [warehouseId, setWarehouseId] = useState<string>(order.warehouse?.id ?? '');
  const [payment, setPayment] = useState<'company' | 'self'>(order.payment);
  const [totalCostInput, setTotalCostInput] = useState<string>(
    order.totalCost != null ? order.totalCost.toFixed(2) : '',
  );
  const [totalCostOverride, setTotalCostOverride] = useState(order.totalCost != null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canDelete = canEditOrder && order.status === 'Draft';

  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => setWarehouses(r.items))
      .catch(() => { /* non-fatal — keep existing warehouse pinned */ });
  }, []);

  // Escape closes the drawer; if none open, closes the page.
  // When the delete modal is open, Escape dismisses it (if not mid-delete)
  // and does NOT fall through to the page-close / drawer-close logic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showDelete) {
        if (!deleting) setShowDelete(false);
        return;
      }
      if (activeIdx !== null) setActiveIdx(null);
      else onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx, onCancel, showDelete, deleting]);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch, _dirty: true } : l)));

  const addLine = () => {
    setLines(ls => [...ls, { ...blankLine(order.category), _dirty: true }]);
    setActiveIdx(lines.length);
  };

  const removeLine = (i: number) => {
    setLines(ls => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));
    setActiveIdx(idx => {
      if (lines.length <= 1) return null;
      if (i === idx) return null;
      if (idx != null && i < idx) return idx - 1;
      return idx;
    });
  };

  const totals = useMemo(() => {
    let qty = 0, cost = 0, revenue = 0, profit = 0;
    for (const l of lines) {
      const q = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      const sp = l.sellPrice == null || l.sellPrice === '' ? 0 : Number(l.sellPrice);
      qty += q;
      cost += q * c;
      revenue += q * sp;
      profit += q * (sp - c);
    }
    return { qty, cost, revenue, profit };
  }, [lines]);

  const statusDirty = status !== order.status;
  const linesDirty = lines.some(l => l._dirty) || lines.length !== order.lines.length;
  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  const parsedTotalCost = totalCostInput.trim() === '' ? null : Number(totalCostInput);
  const totalCostDirty =
    totalCostOverride &&
    !Number.isNaN(parsedTotalCost as number) &&
    (parsedTotalCost ?? null) !== (order.totalCost ?? null);
  const dirty =
    statusDirty || linesDirty || notesDirty || warehouseDirty || paymentDirty || totalCostDirty;

  const canSave = dirty && !saving && !orderLocked && lines.every(l => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  });

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const presentIds = new Set(lines.filter(l => l._id).map(l => l._id!));
      const removeLineIds = order.lines
        .map(l => l.id)
        .filter(id => !presentIds.has(id));
      await api.patch(`/api/orders/${order.id}`, {
        notes:         notesDirty     ? notes                  : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)  : undefined,
        payment:       paymentDirty   ? payment                : undefined,
        totalCost:     totalCostDirty ? parsedTotalCost        : undefined,
        lines: lines
          .filter(l => l._id && (l._dirty || statusDirty))
          .map(l => editLineToPatch(l, statusDirty ? status : undefined)),
        addLines: lines
          .filter(l => !l._id)
          .map(l => editLineToInsert(l, status)),
        removeLineIds: removeLineIds.length ? removeLineIds : undefined,
      });
      onSaved('Saved ' + order.id);
    } catch (e) {
      // Keep the editor open and the user's edits intact on failure — calling
      // onSaved here would navigate away and discard unsaved work.
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const itemLabel = (l: EditLine) =>
      l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`.trim()
    : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
    : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
    : (l.description ?? '—');
  const itemSpec = (l: EditLine) =>
      l.category === 'RAM' ? [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')
    : l.category === 'SSD' ? [l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : l.category === 'HDD' ? [l.interface, l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : (l.condition ?? '');

  return (
    <>
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--fg-subtle)', fontSize: 12.5,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
              marginBottom: 6,
            }}
          >
            <Icon name="chevronLeft" size={12} /> {t('backToOrders')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0 }}>{t('editOrder')}</h1>
            <span className="mono" style={{
              fontSize: 13, fontWeight: 600, padding: '3px 9px',
              borderRadius: 5, background: 'var(--bg-soft)',
              border: '1px solid var(--border)', whiteSpace: 'nowrap',
            }}>{order.id}</span>
            <span className={'chip ' + (order.category === 'RAM' ? 'info' : order.category === 'SSD' ? 'pos' : order.category === 'HDD' ? 'cool' : 'warn')}>
              {order.category}
            </span>
          </div>
          <div className="page-sub" style={{ marginTop: 6 }}>
            {fmtDateShort(order.createdAt)} · {t('submittedBy')} {order.userName.split(' ')[0]} · {lines.length} line{lines.length === 1 ? '' : 's'} · {t('editOrderSub')}
          </div>
        </div>
        {canDelete && (
          <button
            className="btn"
            style={{ color: 'var(--neg)', borderColor: 'var(--neg)', alignSelf: 'flex-start' }}
            onClick={() => { setTypedId(''); setShowDelete(true); }}
          >
            <Icon name="trash" size={13} /> Delete order
          </button>
        )}
      </div>

      <div className={'card' + (!canEditOrder ? ' order-readonly' : '')}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">An order contains multiple line items of the same category ({order.category}).</div>
          </div>
          <span className="chip mono">{order.id} · Editing</span>
        </div>
        <div style={{
          borderTop: '1px solid var(--border)', padding: '14px 18px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Items in this order <span style={{ fontWeight: 500, color: 'var(--fg-subtle)', marginLeft: 4 }}>({lines.length})</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {canEditOrder
                ? `Click a row to edit. Use "Add ${order.category} line" to add another item.`
                : `${totals.qty} unit${totals.qty === 1 ? '' : 's'} · ${fmtUSD(totals.cost)}`}
            </div>
          </div>
          {canEditOrder && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="chip mono">{totals.qty} units · {fmtUSD(totals.cost)}</span>
              <button className="btn" onClick={addLine}>
                <Icon name="plus" size={13} /> Add {order.category} line
              </button>
            </div>
          )}
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>Item</th>
                <th>{t('partNumber')}</th>
                <th className="num">{t('qty')}</th>
                <th className="num">{t('unitCost')}</th>
                <th className="num">{t('sellUnit')}</th>
                <th className="num">{t('revenue')}</th>
                <th className="num">{t('profit')}</th>
                <th>{t('status')}</th>
                {canEditOrder && <th style={{ width: 40 }}></th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const qty = Number(l.qty) || 0;
                const lCost = Number(l.unitCost) || 0;
                const sp = l.sellPrice == null || l.sellPrice === '' ? 0 : Number(l.sellPrice);
                const profit = qty * (sp - lCost);
                const lossy = sp > 0 && sp < lCost;
                const filled = !!l.brand || !!l.description;
                const isActive = i === activeIdx;
                return (
                  <tr
                    key={l._id ?? `new-${i}`}
                    className={canEditOrder ? 'row-hover' : ''}
                    style={{
                      cursor: canEditOrder ? 'pointer' : 'default',
                      background: isActive ? 'var(--accent-soft)' : undefined,
                    }}
                    onClick={canEditOrder ? () => setActiveIdx(i) : undefined}
                  >
                    <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                    <td>
                      {filled ? (
                        <>
                          <div style={{ fontWeight: 500 }}>{itemLabel(l)}</div>
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{itemSpec(l)}</div>
                        </>
                      ) : (
                        <span className="muted" style={{ fontStyle: 'italic' }}>
                          {isActive ? 'Editing — fill in below' : 'Not filled in'}
                        </span>
                      )}
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                    <td className="num mono">{qty}</td>
                    <td className="num mono">{lCost ? fmtUSD(lCost) : '—'}</td>
                    <td className="num mono">{sp ? fmtUSD(sp) : '—'}</td>
                    <td className="num mono">{sp && qty ? fmtUSD(sp * qty) : '—'}</td>
                    <td className={'num mono ' + (sp ? (profit >= 0 ? 'pos' : 'neg') : 'muted')}>
                      {sp ? fmtUSD(profit) : '—'}
                      {lossy && <Icon name="alert" size={11} style={{ marginLeft: 4, color: 'var(--warn)' }} />}
                    </td>
                    <td>
                      {isActive && <span className="chip info"><Icon name="edit" size={10} /> Editing</span>}
                      {!isActive && (
                        <span className={'chip dot ' + statusTone(statusOf(l, status))}>{statusOf(l, status)}</span>
                      )}
                    </td>
                    {canEditOrder && (
                      <td>
                        <button
                          className="btn icon sm"
                          onClick={e => { e.stopPropagation(); removeLine(i); }}
                          title="Remove line"
                          disabled={lines.length <= 1}
                          style={lines.length <= 1 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'flex-end', gap: 24,
          fontSize: 13, background: 'var(--bg-soft)',
        }}>
          <span style={{ color: 'var(--fg-subtle)' }}>
            Revenue <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.revenue)}</span>
          </span>
          <span style={{ color: 'var(--fg-subtle)' }}>
            Cost <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.cost)}</span>
          </span>
          <span style={{ color: 'var(--fg-subtle)' }}>
            Profit <span className="mono pos" style={{ fontWeight: 600, marginLeft: 4 }}>{fmtUSD(totals.profit)}</span>
          </span>
        </div>
      </div>

      <div className="card" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: '0 12px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
          }}>
            <Icon name="flag" size={12} /> {t('orderStatus')}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {t('advanceAsProgresses')}
            </span>
          </div>
          <div className="so-stepper">
            {ORDER_STATUSES.map((s, i) => {
              const active = s === status;
              const currentIdx = ORDER_STATUSES.indexOf(status as typeof ORDER_STATUSES[number]);
              const reached = currentIdx >= 0 && i <= currentIdx;
              const locked = isPurchaser && !allowedStatuses.includes(s);
              return (
                <Fragment key={s}>
                  <button
                    type="button"
                    className={'so-step' + (active ? ' active' : '') + (reached ? ' reached' : '') + (locked ? ' locked' : '')}
                    onClick={() => { if (!locked && !orderLocked) setStatus(s); }}
                    disabled={locked || orderLocked}
                    title={locked
                      ? 'Manager-only — purchasers can only hand off Draft → In Transit'
                      : `Set status to ${s}`}
                  >
                    <span className="so-step-dot">
                      {locked ? <Icon name="lock" size={10} /> : (i + 1)}
                    </span>
                    <span className="so-step-label">{s}</span>
                  </button>
                  {i < ORDER_STATUSES.length - 1 && (
                    <span className={'so-step-bar' + (i < currentIdx ? ' reached' : '')} />
                  )}
                </Fragment>
              );
            })}
          </div>
          {isPurchaser && !purchaserCanEdit && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="lock" size={13} />
              This order is being reviewed by the manager — pricing happens during review. You can view but not edit.
            </div>
          )}
          {isPurchaser && purchaserCanEdit && order.status === 'Draft' && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              Advance to <strong>In Transit</strong> when you've shipped the order. You can keep editing line items until it moves to Reviewing.
            </div>
          )}
          {isPurchaser && purchaserCanEdit && order.status === 'In Transit' && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              Update line items as needed. Advance to <strong>Reviewing</strong> when you're ready to hand the order off to the manager for pricing.
            </div>
          )}
          {statusDirty && !isPurchaser && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              Status will change from <strong>{order.status}</strong> to <strong>{status}</strong> when you save.
            </div>
          )}
          {statusDirty && isPurchaser && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              Status will change from <strong>{order.status}</strong> to <strong>{status}</strong> when you save — this hands the order off to the manager.
            </div>
          )}
        </div>

        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('warehouse')}</label>
              <div style={{ position: 'relative' }}>
                <Icon name="warehouse" size={13} style={{
                  position: 'absolute', left: 10, top: '50%',
                  transform: 'translateY(-50%)', color: 'var(--fg-subtle)',
                  pointerEvents: 'none',
                }} />
                <select
                  className="select"
                  value={warehouseId}
                  onChange={e => setWarehouseId(e.target.value)}
                  disabled={!canEditOrder}
                  style={{ paddingLeft: 30, width: '100%' }}
                >
                  {warehouses.length === 0 && (
                    <option value={warehouseId}>{order.warehouse?.name ?? order.warehouse?.short ?? '—'}</option>
                  )}
                  {warehouses.map(w => (
                    <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('payment')}</label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  type="button"
                  className={payment === 'company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => canEditOrder && setPayment('company')}
                  disabled={!canEditOrder}
                >Company</button>
                <button
                  type="button"
                  className={payment === 'self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => canEditOrder && setPayment('self')}
                  disabled={!canEditOrder}
                >Self-paid</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>{t('totalCost')}</span>
                {totalCostOverride && canEditOrder && (
                  <button
                    onClick={() => {
                      setTotalCostOverride(false);
                      setTotalCostInput(totals.cost.toFixed(2));
                    }}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-strong)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                    title={`Auto-sum is ${fmtUSD(totals.cost)}`}
                  >reset</button>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{
                  position: 'absolute', left: 12, top: '50%',
                  transform: 'translateY(-50%)', color: 'var(--fg-subtle)',
                  pointerEvents: 'none',
                }}>$</span>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={totalCostOverride ? totalCostInput : totals.cost.toFixed(2)}
                  onChange={e => { setTotalCostOverride(true); setTotalCostInput(e.target.value); }}
                  onFocus={e => e.target.select()}
                  disabled={!canEditOrder}
                  style={{ paddingLeft: 24, fontWeight: 500 }}
                />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('orderNotes')}</label>
              <input
                className="input"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={t('orderNotesPh')}
                disabled={!canEditOrder}
              />
            </div>
          </div>
        </div>

        <div style={{
          padding: 16, display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr) auto',
          gap: 18, alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Lines</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Total units</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.qty}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              Total cost {totalCostOverride && Math.abs((parsedTotalCost ?? 0) - totals.cost) > 0.01 && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · override</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(totalCostOverride ? (parsedTotalCost ?? 0) : totals.cost)}
            </div>
          </div>
          {saveError && (
            <div className="form-error" role="alert" style={{ marginRight: 'auto', alignSelf: 'center', color: 'var(--neg, #c0392b)', fontSize: 13 }}>
              {saveError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            <button
              className="btn primary"
              disabled={!canSave}
              onClick={save}
            >
              <Icon name="check2" size={14} /> {saving ? '…' : t('save')}
            </button>
          </div>
        </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          line={lines[activeIdx]}
          idx={activeIdx}
          editing
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
        />
      )}

      {showDelete && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !deleting) setShowDelete(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--neg-soft)', color: 'var(--neg)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="trash" size={18} />
                </div>
                <div>
                  <div className="modal-title">Delete order {order.id}?</div>
                  <div className="modal-sub">
                    This permanently deletes the Draft and all its lines. Type the order ID to confirm.
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="label">
                  Type <span className="mono">{order.id}</span> to confirm
                </label>
                <input
                  className="input mono"
                  value={typedId}
                  onChange={e => setTypedId(e.target.value)}
                  placeholder={order.id}
                  autoFocus
                  disabled={deleting}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => setShowDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn"
                style={{
                  background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)',
                  opacity: deleting || typedId !== order.id ? 0.5 : 1,
                }}
                disabled={deleting || typedId !== order.id}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteOrder(order.id);
                    onCancel();
                  } catch (e) {
                    alert(e instanceof Error ? e.message : 'Delete failed');
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '…' : 'Delete order'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Conversion helpers ──────────────────────────────────────────────────────
function orderLineToEditLine(l: OrderLine): EditLine {
  return {
    _id:            l.id,
    _status:        l.status,
    category:       l.category,
    brand:          l.brand ?? undefined,
    capacity:       l.capacity ?? undefined,
    type:           l.type ?? undefined,
    classification: l.classification ?? undefined,
    rank:           l.rank ?? undefined,
    speed:          l.speed ?? undefined,
    interface:      l.interface ?? undefined,
    formFactor:     l.formFactor ?? undefined,
    description:    l.description ?? undefined,
    partNumber:     l.partNumber ?? undefined,
    condition:      l.condition,
    qty:            l.qty,
    unitCost:       l.unitCost,
    sellPrice:      l.sellPrice ?? undefined,
    health:         l.health,
    rpm:            l.rpm,
  };
}

function editLineToPatch(l: EditLine, status?: string) {
  const sp = l.sellPrice;
  return {
    id:             l._id!,
    status,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    partNumber:     l.partNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
  };
}

function editLineToInsert(l: EditLine, status: string) {
  const sp = l.sellPrice;
  return {
    category:       l.category,
    status,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    partNumber:     l.partNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
  };
}

// Per-line status display: while the user is changing the stepper but hasn't
// saved yet, the chip still shows each line's persisted status (the banner
// already explains the pending transition). Lines created in-session don't
// have a persisted status yet — they inherit the current stepper value.
function statusOf(l: EditLine, draftStatus: string) {
  return l._status ?? draftStatus;
}
