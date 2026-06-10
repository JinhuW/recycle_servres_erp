// Picker for adding more inventory to an existing sell order. Layered over the
// edit modal: lists currently-sellable lots (GET /api/sell-orders/sellable —
// status Reviewing/Done, not on an open order), grouped by product number, and
// returns the checked lots to the caller, which appends them as new lines.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useT } from '../lib/i18n';
import { fmtUSD } from '../lib/format';

export type SellableItem = {
  inventoryId: string;
  category: string;
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  condition: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  availableQty: number;
  sellPrice: number | null;
};

type Props = {
  // Inventory ids already on the in-progress draft (saved or just-added). The
  // server only excludes lots on *saved* open orders, so session-local adds must
  // be filtered client-side to avoid duplicates.
  excludeIds: Set<string>;
  locale: string;
  onClose: () => void;
  onAdd: (items: SellableItem[]) => void;
};

const groupKey = (it: SellableItem) =>
  it.partNumber?.trim() || `${it.label}__${it.condition ?? ''}`;

export function AddInventoryPicker({ excludeIds, locale, onClose, onAdd }: Props) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SellableItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEscapeKey(onClose);

  // Debounced fetch on query change.
  useEffect(() => {
    let alive = true;
    const handle = setTimeout(async () => {
      try {
        const r = await api.get<{ items: SellableItem[] }>(
          `/api/sell-orders/sellable${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`,
        );
        if (alive) setItems(r.items);
      } catch (e) {
        if (alive) { setItems([]); handleFetchError(e); }
      }
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(handle); };
  }, [q]);

  // Hide lots already on the draft, then group by product number.
  const groups = useMemo(() => {
    const visible = (items ?? []).filter(it => !excludeIds.has(it.inventoryId));
    const map = new Map<string, { label: string; partNumber: string | null; items: SellableItem[] }>();
    for (const it of visible) {
      const k = groupKey(it);
      if (!map.has(k)) map.set(k, { label: it.label, partNumber: it.partNumber, items: [] });
      map.get(k)!.items.push(it);
    }
    return [...map.values()];
  }, [items, excludeIds]);

  const toggle = (id: string) =>
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const confirm = () => {
    const picked = (items ?? []).filter(it => checked.has(it.inventoryId));
    if (picked.length > 0) onAdd(picked);
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ zIndex: 120 }}
    >
      <div className="modal-shell" style={{ maxWidth: 720, width: 'calc(100vw - 80px)', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 80px)' }}>
        {/* Header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name="inventory" size={18} />
          <div style={{ flex: 1, fontSize: 16, fontWeight: 600 }}>{t('soAddInventoryTitle')}</div>
          <button className="btn icon sm" onClick={onClose} title={t('cancel')}>
            <Icon name="x" size={13} />
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)' }}>
              <Icon name="search" size={14} />
            </span>
            <input
              className="input"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('soAddInventorySearch')}
              autoFocus
              style={{ paddingLeft: 32 }}
            />
          </div>
        </div>

        {/* Results */}
        <div style={{ padding: '8px 24px', overflowY: 'auto', flex: 1 }}>
          {items === null ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>{t('soAddInventoryLoading')}</div>
          ) : groups.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>{t('soAddInventoryEmpty')}</div>
          ) : (
            groups.map(g => (
              <div key={groupKey(g.items[0])} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                  <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{g.partNumber ?? g.label}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{g.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)' }}>{g.items.length}</span>
                </div>
                {g.items.map(it => {
                  const on = checked.has(it.inventoryId);
                  return (
                    <label
                      key={it.inventoryId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', borderRadius: 8,
                        cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent',
                      }}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggle(it.inventoryId)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{it.subLabel ?? it.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8, marginTop: 1 }}>
                          <span>{it.warehouseName ?? t('sodNoWarehouse')}</span>
                          {it.condition && (<><span>·</span><span>{it.condition}</span></>)}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div className="mono" style={{ fontSize: 12.5 }}>×{it.availableQty}</div>
                        {it.sellPrice != null && (
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{fmtUSD(it.sellPrice, locale)}</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {t('soAddInventorySelected', { n: checked.size })}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose}>{t('cancel')}</button>
            <button className="btn accent" disabled={checked.size === 0} onClick={confirm}>
              <Icon name="plus" size={14} /> {t('soAddInventoryBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
