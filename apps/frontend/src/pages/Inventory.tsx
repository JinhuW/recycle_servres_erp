import { useEffect, useMemo, useRef, useState } from 'react';
import { sortSheetRows } from '@recycle-erp/shared';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { forEachKeysetPage } from '../lib/keysetPages';
import { handleFetchError } from '../lib/errorToast';
import { fmtUSD0 } from '../lib/format';
import { lineSpecLabel } from '../lib/lineGroups';
import { categoryFilterOptions } from '../lib/lookups';
import { wsNumber } from '../lib/workspace';
import { statusTone } from '../lib/status';
import { usePhScrolled } from '../lib/usePhScrolled';
import type { Category } from '../lib/types';
import { PhoneListSkeleton } from '../components/Skeleton';
import { SerialNumbers } from '../components/SerialNumbers';

type InventoryItem = {
  id: string;
  category: Category;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  speed: string | null;
  type: string | null;
  interface: string | null;
  description: string | null;
  part_number: string | null;
  short_code?: string | null;
  serial_number: string | null;
  qty: number;
  unit_cost: number;
  sell_price: number | null;
  status: string;
  health: number | null;
  rpm: number | null;
};

type Props = {
  onNewEntry: () => void;
};

// The server sorts each page on its own, so the pages laid end to end restart
// the category → brand → capacity order at every boundary. The list is sorted
// again as a whole, with the same comparator.
const sortStock = (rows: InventoryItem[]) => sortSheetRows(rows, (r) => ({
  category: r.category, specs: r, label: r.part_number ?? r.description ?? '',
}));

export function Inventory({ onNewEntry }: Props) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const [filter, setFilter] = useState<string>('all');
  // Sold lots are terminal; the backend hides them unless includeSold is set.
  const [showSold, setShowSold] = useState(false);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  // Pages still arriving: the totals above the list cover what has landed.
  const [walking, setWalking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (showSold) params.set('includeSold', '1');
    params.set('limit', '200');
    // Every page, not the first 200: a book past that used to end there
    // silently, totals included.
    setWalking(true);
    forEachKeysetPage<InventoryItem>(
      (cursor) => api.get<{ items: InventoryItem[]; nextCursor: string | null }>(
        `/api/inventory?${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      (page, meta) => {
        if (!alive) return false;
        setItems(prev => sortStock(meta.first ? page : [...prev, ...page]));
        setLoadedOnce(true);
        if (meta.done) setWalking(false);
      },
    )
      .catch((e) => { if (alive) handleFetchError(e); })
      // A first page that never lands still ends the loading state: the
      // skeleton otherwise stays up claiming work that has already failed.
      .finally(() => { if (alive) { setLoadedOnce(true); setWalking(false); } });
    return () => { alive = false; };
  }, [filter, showSold]);

  const isManager = user?.role === 'manager';
  const { activeItems, activeUnits } = useMemo(() => {
    // Line statuses, not PO stages: a Sold lot left with its sale, so it
    // counts no more than a Done one does.
    const inStock = items.filter(r => r.status !== 'Done' && r.status !== 'Sold');
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
          {categoryFilterOptions().map(f => (
            <button key={f} className={'ph-chip-btn ' + (filter === f ? 'active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('filterAllCats') : f}
            </button>
          ))}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '4px 2px', marginTop: 2, fontSize: 13.5,
        }}>
          <span style={{ color: 'var(--fg-subtle)' }}>{t('invShowSold')}</span>
          <button
            type="button"
            className={'ph-switch ' + (showSold ? 'on' : '')}
            onClick={() => setShowSold(s => !s)}
            aria-pressed={showSold}
            aria-label={t('invShowSold')}
          >
            <span className="ph-switch-knob" />
          </button>
        </div>

        {!loadedOnce && <PhoneListSkeleton rows={6} />}
        {loadedOnce && walking && <PhoneListSkeleton rows={2} />}
        {loadedOnce && items.map(r => {
          const label = lineSpecLabel(r) ?? (r.description ?? '');
          const lowHealth = r.health != null && r.health < wsNumber('low_health_pct', 50);
          return (
            <div key={r.id} className="ph-inv-card">
              <div className="ph-inv-thumb">
                <Icon name={r.category === 'RAM' ? 'chip' : (r.category === 'SSD' || r.category === 'HDD') ? 'drive' : 'box'} size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{r.part_number ?? '—'} · qty {r.qty}</span>
                  {lowHealth && <span className="chip warn" style={{ fontSize: 10 }}>{r.health}%</span>}
                </div>
                {r.category === 'RAM' && (
                  <div style={{ fontSize: 11, marginTop: 3 }}>{t('ramShortCode')}: <span className="mono">{r.short_code ?? t('ramShortCodeUnknown')}</span></div>
                )}
                {r.serial_number && (
                  <div style={{ marginTop: 4 }}>
                    <SerialNumbers raw={r.serial_number} max={3} size={10} />
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className={'chip ' + statusTone(r.status) + ' dot'} style={{ fontSize: 10 }}>{r.status}</span>
                {r.sell_price != null && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>{fmtUSD0(r.sell_price, locale)}</div>
                )}
              </div>
            </div>
          );
        })}

        {loadedOnce && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('noOrdersMatch')}
          </div>
        )}
      </div>
    </>
  );
}
