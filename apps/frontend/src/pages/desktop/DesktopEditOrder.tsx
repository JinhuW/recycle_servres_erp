import { Fragment, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../../lib/status';
import type { Order, OrderLine } from '../../lib/types';

type Props = {
  order: Order;
  onCancel: () => void;
  onSaved: (msg: string) => void;
};

type DraftLine = OrderLine & { _dirty?: boolean };

// Edit-order page lifted from design/dashboard.jsx#EditOrderPage. Status
// stepper at the top, line-item table with editable sell price (and qty/cost
// for managers), order meta below, sticky save action at the bottom.
//
// Purchasers can only walk an order from Draft → In Transit. Managers may move
// it through any stage and edit prices/qty.
export function DesktopEditOrder({ order, onCancel, onSaved }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const isPurchaser = user?.role !== 'manager';
  const orderLocked = isCompleted(order.status);
  const purchaserCanEdit = !isPurchaser || order.status === 'Draft';
  const allowedStatuses = isPurchaser
    ? (order.status === 'Draft' ? ['Draft', 'In Transit'] : [order.status])
    : ORDER_STATUSES.slice();

  const [status, setStatus] = useState(order.status);
  const [lines, setLines] = useState<DraftLine[]>(() => order.lines.map(l => ({ ...l })));
  const [notes, setNotes] = useState<string>(order.notes ?? '');
  const [saving, setSaving] = useState(false);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const setLine = (id: string, patch: Partial<DraftLine>) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch, _dirty: true } : l));

  const totals = lines.reduce((acc, l) => {
    const sp = l.sellPrice ?? 0;
    acc.qty     += l.qty;
    acc.revenue += sp * l.qty;
    acc.cost    += l.unitCost * l.qty;
    acc.profit  += (sp - l.unitCost) * l.qty;
    return acc;
  }, { qty: 0, revenue: 0, cost: 0, profit: 0 });

  const statusDirty = status !== order.status;
  const linesDirty = lines.some(l => l._dirty);
  const notesDirty = (notes || '') !== (order.notes || '');
  const dirty = statusDirty || linesDirty || notesDirty;

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/orders/${order.id}`, {
        notes: notesDirty ? notes : undefined,
        lines: lines
          .filter(l => l._dirty || statusDirty)
          .map(l => ({
            id: l.id,
            // Push the new status onto every line so per-line state stays in
            // sync with the order-level stepper (the backend stores status on
            // each line).
            status: statusDirty ? status : undefined,
            sellPrice: l.sellPrice ?? undefined,
            qty: l.qty,
            unitCost: l.unitCost,
          })),
      });
      onSaved('Saved ' + order.id);
    } catch (e) {
      onSaved(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const itemLabel = (l: OrderLine) =>
      l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`.trim()
    : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
    : (l.description ?? '—');
  const itemSpec = (l: OrderLine) =>
      l.category === 'RAM' ? [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')
    : l.category === 'SSD' ? [l.formFactor, l.condition].filter(Boolean).join(' · ')
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
            <span className={'chip ' + (order.category === 'RAM' ? 'info' : order.category === 'SSD' ? 'pos' : 'warn')}>
              {order.category}
            </span>
          </div>
          <div className="page-sub" style={{ marginTop: 6 }}>
            {fmtDateShort(order.createdAt)} · {t('submittedBy')} {order.userName.split(' ')[0]} · {order.lineCount} line{order.lineCount === 1 ? '' : 's'} · {t('editOrderSub')}
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button
            className="btn primary"
            disabled={!dirty || saving || orderLocked}
            onClick={save}
          >
            {saving ? '…' : t('save')}
          </button>
        </div>
      </div>

      {/* Status stepper */}
      <div className="card">
        <div style={{ padding: '14px 16px' }}>
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
              This order has shipped — pricing and review are handled by the manager. You can view but not edit.
            </div>
          )}
          {isPurchaser && purchaserCanEdit && (
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icon name="info" size={13} />
              Advance to <strong>In Transit</strong> when you've shipped the order — after that, the manager takes over.
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
        </div>
      </div>

      {/* Line items */}
      <div className={'card' + ((isPurchaser && !purchaserCanEdit) ? ' order-readonly' : '')}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('lineItemsIn')} {order.id}</div>
            <div className="card-sub">{order.lineCount} line{order.lineCount === 1 ? '' : 's'} · {totals.qty} units</div>
          </div>
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
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const sp = l.sellPrice ?? 0;
                const profit = (sp - l.unitCost) * l.qty;
                const lossy = sp > 0 && sp < l.unitCost;
                return (
                  <tr key={l.id}>
                    <td className="mono muted">{i + 1}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{itemLabel(l)}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{itemSpec(l)}</div>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber}</td>
                    <td className="num mono">
                      {(isPurchaser && !purchaserCanEdit) ? l.qty : (
                        <input
                          className="so-mini-input"
                          type="number"
                          min={1}
                          value={l.qty}
                          onChange={e => setLine(l.id, { qty: parseInt(e.target.value, 10) || 0 })}
                        />
                      )}
                    </td>
                    <td className="num mono">
                      {isPurchaser ? fmtUSD(l.unitCost) : (
                        <input
                          className="so-mini-input"
                          type="number"
                          step="0.01"
                          min={0}
                          value={l.unitCost}
                          onChange={e => setLine(l.id, { unitCost: parseFloat(e.target.value) || 0 })}
                        />
                      )}
                    </td>
                    <td className="num mono">
                      {isPurchaser ? (l.sellPrice != null ? fmtUSD(l.sellPrice) : '—') : (
                        <input
                          className="so-mini-input"
                          type="number"
                          step="0.01"
                          min={0}
                          value={l.sellPrice ?? ''}
                          placeholder="—"
                          onChange={e => setLine(l.id, { sellPrice: e.target.value === '' ? null : (parseFloat(e.target.value) || 0) })}
                        />
                      )}
                    </td>
                    <td className="num mono">{sp ? fmtUSD(sp * l.qty) : '—'}</td>
                    <td className={'num mono ' + (sp ? (profit >= 0 ? 'pos' : 'neg') : 'muted')}>
                      {sp ? fmtUSD(profit) : '—'}
                      {lossy && <Icon name="alert" size={11} style={{ marginLeft: 4, color: 'var(--warn)' }} />}
                    </td>
                    <td>
                      <span className={'chip dot ' + statusTone(l.status)}>{l.status}</span>
                    </td>
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

      {/* Order meta */}
      <div className="card">
        <div className="card-head">
          <div className="card-title">{t('orderDetails')}</div>
        </div>
        <div className="card-body">
          <div className="field-row">
            <div className="field">
              <label className="label">{t('warehouse')}</label>
              <input
                className="input mono"
                value={order.warehouse?.name ?? order.warehouse?.short ?? '—'}
                readOnly
              />
            </div>
            <div className="field">
              <label className="label">{t('payment')}</label>
              <input
                className="input"
                value={order.payment === 'company' ? t('payCompany') : t('paySelf')}
                readOnly
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label className="label">{t('orderNotes')}</label>
              <input
                className="input"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={t('orderNotesPh')}
                disabled={isPurchaser && !purchaserCanEdit}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
