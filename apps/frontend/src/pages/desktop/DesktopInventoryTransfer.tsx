import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { Warehouse } from '../../lib/types';
import { useT } from '../../lib/i18n';

// Bulk warehouse-to-warehouse transfer modal. Manager picks a single
// destination, optionally trims the qty per line, and POSTs to
// /api/inventory/transfer. Mirrors the layout pattern of
// DesktopSellOrderDraft so the page feels consistent.

export type TransferItem = {
  id: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  qty: number;                           // max qty on the source line
  warehouseId: string | null;            // effective source warehouse
  warehouseShort: string | null;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
};

type Props = {
  items: TransferItem[];
  warehouses: Warehouse[];
  onClose: () => void;
  onSaved: (count: number, destShort: string) => void;
};

const NOTE_MAX = 200;

export function DesktopInventoryTransfer({ items, warehouses, onClose, onSaved }: Props) {
  const { t } = useT();
  const [toWarehouseId, setToWarehouseId] = useState<string>('');
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(items.map(it => [it.id, it.qty])),
  );
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  // Destination picker excludes any warehouse that is already a source on at
  // least one of the selected lines — moving to "self" is a no-op.
  const sourceWhIds = useMemo(() => {
    const s = new Set<string>();
    items.forEach(it => { if (it.warehouseId) s.add(it.warehouseId); });
    return s;
  }, [items]);
  const destinations = useMemo(
    () => warehouses.filter(w => !sourceWhIds.has(w.id)),
    [warehouses, sourceWhIds],
  );

  const destShort = destinations.find(w => w.id === toWarehouseId)?.short ?? '';
  const anyInvalidQty = items.some(it => {
    const n = qty[it.id];
    return !Number.isInteger(n) || n < 1 || n > it.qty;
  });
  const canSubmit = !!toWarehouseId && !anyInvalidQty && !submitting;

  const setLineQty = (id: string, raw: string) => {
    const n = Number(raw);
    setQty(prev => ({ ...prev, [id]: Number.isFinite(n) ? Math.floor(n) : 0 }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ ok: true; lines: { sourceId: string; destId: string; qty: number }[] }>(
        '/api/inventory/transfer',
        {
          toWarehouseId,
          note: note.trim() || undefined,
          lines: items.map(it => ({ id: it.id, qty: qty[it.id] })),
        },
      );
      onSaved(res.lines.length, destShort);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? 'Transfer failed';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={() => { if (!submitting) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.42)',
        display: 'grid', placeItems: 'center', zIndex: 90, padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderRadius: 14, width: 'min(640px, 100%)',
          maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(15,23,42,0.18)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'grid', placeItems: 'center',
          }}>
            <Icon name="truck" size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {t('transferTitle', { n: items.length })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {t('transferSubtitle')}
            </div>
          </div>
          <button className="btn icon sm" onClick={onClose} disabled={submitting} title="Close">
            <Icon name="x" size={12} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Destination picker */}
          <div>
            <label style={{
              display: 'block', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
            }}>
              {t('transferDestination')}
            </label>
            {destinations.length === 0 ? (
              <div style={{
                padding: '10px 12px', borderRadius: 8,
                background: 'var(--warn-soft)', border: '1px solid color-mix(in oklch, var(--warn) 25%, transparent)',
                color: 'var(--warn-strong)', fontSize: 12.5,
              }}>
                {t('transferNoDestination')}
              </div>
            ) : (
              <select
                className="select"
                value={toWarehouseId}
                onChange={e => setToWarehouseId(e.target.value)}
                disabled={submitting}
                style={{ width: '100%' }}
              >
                <option value="">{t('transferDestinationPlaceholder')}</option>
                {destinations.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.short} — {w.region}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Lines */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 120px',
              padding: '8px 12px',
              background: 'var(--bg-soft)', borderBottom: '1px solid var(--border)',
              fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>
              <div>{t('transferItem')}</div>
              <div>{t('transferFrom')}</div>
              <div style={{ textAlign: 'right' }}>{t('transferQty')}</div>
            </div>
            {items.map(it => {
              const n = qty[it.id];
              const invalid = !Number.isInteger(n) || n < 1 || n > it.qty;
              return (
                <div
                  key={it.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '1fr 80px 120px',
                    gap: 12, alignItems: 'center',
                    padding: '10px 12px', borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {it.label || it.partNumber || it.id.slice(0, 8)}
                    </div>
                    {it.subLabel && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{it.subLabel}</div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="warehouse" size={11} />
                    {it.warehouseShort ?? '—'}
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <input
                      type="number"
                      className="input"
                      min={1}
                      max={it.qty}
                      step={1}
                      value={Number.isFinite(n) ? n : ''}
                      onChange={e => setLineQty(it.id, e.target.value)}
                      disabled={submitting}
                      style={{
                        width: 60, textAlign: 'right', padding: '4px 8px', height: 28,
                        fontSize: 12.5,
                        borderColor: invalid ? 'var(--neg)' : undefined,
                      }}
                    />
                    <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', minWidth: 26 }}>/{it.qty}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Note */}
          <div>
            <label style={{
              display: 'block', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
            }}>
              {t('transferNote')}
            </label>
            <input
              type="text"
              className="input"
              value={note}
              maxLength={NOTE_MAX}
              onChange={e => setNote(e.target.value)}
              disabled={submitting}
              placeholder={t('transferNotePlaceholder')}
              style={{ width: '100%' }}
            />
          </div>

          {error && (
            <div style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'var(--neg-soft)', border: '1px solid color-mix(in oklch, var(--neg) 25%, transparent)',
              color: 'var(--neg-strong)', fontSize: 12.5,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-soft)', display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          <button className="btn" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </button>
          <button
            className="btn accent"
            onClick={submit}
            disabled={!canSubmit}
          >
            <Icon name="truck" size={13} />
            {submitting ? t('transferring') : t('transferSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
