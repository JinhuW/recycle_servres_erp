import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmtUSD0 } from '../lib/format';
import { isCompleted, statusTone } from '../lib/status';
import { usePhScrolled } from '../lib/usePhScrolled';
import type { Category } from '../lib/types';

type InventoryItem = {
  id: string;
  category: Category;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  interface: string | null;
  description: string | null;
  part_number: string | null;
  qty: number;
  unit_cost: number;
  sell_price: number | null;
  status: string;
};

type Props = {
  onNewEntry: () => void;
};

export function Inventory({ onNewEntry }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    api.get<{ items: InventoryItem[] }>(`/api/inventory?${params}`)
      .then(r => setItems(r.items))
      .catch(console.error);
  }, [filter]);

  const isManager = user?.role === 'manager';
  const { activeItems, activeUnits } = useMemo(() => {
    const inStock = items.filter(r => !isCompleted(r.status));
    return {
      activeItems: inStock.length,
      activeUnits: inStock.reduce((a, r) => a + r.qty, 0),
    };
  }, [items]);

  if (!user) return null;

  return (
    <>
      <PhHeader
        title={t('inventoryTitle')}
        sub={isManager ? t('invAcrossTeams') : t('invItemsYou')}
        scrolled={scrolled}
        trailing={<button className="ph-icon-btn" onClick={onNewEntry}><Icon name="plus" size={16} /></button>}
      />
      <div className="ph-scroll" ref={scrollRef}>
        {!isManager && (
          <div className="ph-info-banner" style={{ marginTop: 4 }}>
            <Icon name="lock" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <div>{t('readonlyMgr')}</div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{t('activeItems')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 22 }}>{activeItems}</div>
          </div>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{t('activeUnits')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 22 }}>{activeUnits}</div>
          </div>
        </div>

        <div className="ph-chip-scroller">
          {(['all', 'RAM', 'SSD', 'Other'] as const).map(f => (
            <button key={f} className={'ph-chip-btn ' + (filter === f ? 'active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('filterAllCats') : f}
            </button>
          ))}
        </div>

        {items.slice(0, 30).map(r => {
          const label = r.category === 'RAM' ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.type ?? ''}`.trim()
                      : r.category === 'SSD' ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.interface ?? ''}`.trim()
                      : (r.description ?? '');
          return (
            <div key={r.id} className="ph-inv-card">
              <div className="ph-inv-thumb">
                <Icon name={r.category === 'RAM' ? 'chip' : r.category === 'SSD' ? 'drive' : 'box'} size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>
                  {r.part_number ?? '—'} · qty {r.qty}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className={'chip ' + statusTone(r.status) + ' dot'} style={{ fontSize: 10 }}>{r.status}</span>
                {isManager && r.sell_price != null && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>{fmtUSD0(r.sell_price)}</div>
                )}
              </div>
            </div>
          );
        })}

        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('noOrdersMatch')}
          </div>
        )}
      </div>
    </>
  );
}
