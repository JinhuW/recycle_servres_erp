import { Fragment, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../../lib/format';
import { statusTone } from '../../lib/status';
import { useT } from '../../lib/i18n';

export type ProductLot = {
  id: string;
  order_id: string;
  created_at: string;
  user_name: string;
  user_initials: string;
  unit_cost?: number;
  sell_price: number | null;
  condition: string;
  health: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
  qty: number;
  status: string;
  image_url: string | null;
};

export type ProductGroup = {
  key: string;
  part_number: string | null;
  category: string;
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
  rpm: number | null;
  mixed_spec: boolean;
  qty: number;
  qty_in_transit: number;
  qty_in_stock: number;
  qty_reviewing: number;
  lot_count: number;
  po_count: number;
  unit_cost_min?: number;
  unit_cost_max?: number;
  unit_cost_avg?: number;
  sell_price: number | null;
  warehouses: string[];
  created_at: string;
  submitters: string[];
  lines: ProductLot[];
};

// Subset of the flat-view column toggles that have a grouped-view analogue.
// Columns with no analogue (id/date/profit/margin/submitter) are lot-level
// only and simply aren't part of the grouped table.
export type GroupedColVis = {
  category: boolean;
  partNumber: boolean;
  qty: boolean;
  warehouse: boolean;
  unitCost: boolean;
  sellPrice: boolean;
  condition: boolean;
};

type Props = {
  groups: ProductGroup[];
  isManager: boolean;
  cols: GroupedColVis;
  selected: Set<string>;
  onToggleLot: (id: string) => void;
  onToggleGroup: (g: ProductGroup) => void;
  onQuickView: (lotId: string) => void;
  onEditLot: (lotId: string) => void;
};

const SELLABLE = new Set(['Reviewing', 'Done']);

const categoryChip = (c: string) =>
  c === 'RAM' ? 'info' : c === 'SSD' ? 'pos' : c === 'HDD' ? 'cool' : 'warn';

function productLabel(g: ProductGroup): string {
  // RAM surfaces type in the subtitle, so keep it out of the title to avoid
  // repeating it; other categories keep the existing label shape.
  const bits = (g.category === 'RAM'
    ? [g.brand, g.capacity, g.generation]
    : [g.brand, g.capacity, g.type, g.generation]
  ).filter(Boolean);
  return bits.length ? bits.join(' ') : (g.description || g.category);
}

function productSpec(g: ProductGroup): string {
  if (g.category === 'RAM') {
    return [g.type, g.classification, g.rank, g.speed ? `${g.speed} MHz` : null]
      .filter(Boolean).join(' · ');
  }
  return [g.interface, g.form_factor, g.speed, g.rpm ? `${g.rpm} RPM` : null]
    .filter(Boolean).join(' · ');
}

export function InventoryProductTable({
  groups, isManager, cols, selected, onToggleLot, onToggleGroup, onQuickView, onEditLot,
}: Props) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const showCost = isManager && cols.unitCost;
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const toggleOpen = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // toggle(chevron+checkbox) + product + lots are always shown; the rest follow
  // the Columns menu toggles so the menu actually affects the grouped view.
  const totalCols = 3
    + (cols.partNumber ? 1 : 0)
    + (cols.qty ? 1 : 0)
    + (cols.warehouse ? 1 : 0)
    + (showCost ? 1 : 0)
    + (cols.sellPrice ? 1 : 0);

  return (
    <>
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 56 }} />
          <th>{t('iptProduct')}</th>
          {cols.partNumber && <th>{t('partNumber')}</th>}
          {cols.qty && <th className="num">{t('qty')}</th>}
          <th>{t('iptLots')}</th>
          {cols.warehouse && <th>{t('iptWarehouses')}</th>}
          {showCost && <th className="num">{t('eoCost')}</th>}
          {cols.sellPrice && <th className="num">{t('mktLegendSell')}</th>}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const isOpen = open.has(g.key);
          const sellableLots = g.lines.filter((l) => SELLABLE.has(l.status));
          const allSelected = sellableLots.length > 0 && sellableLots.every((l) => selected.has(l.id));
          return (
            <Fragment key={g.key}>
              <tr
                className={'row-hover' + (allSelected ? ' row-selected' : '')}
                style={{ cursor: 'pointer' }}
                onClick={() => toggleOpen(g.key)}
              >
                <td>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="chevronDown" size={13} style={{
                      transition: 'transform 0.15s',
                      transform: isOpen ? 'rotate(180deg)' : 'none',
                      color: 'var(--fg-subtle)',
                    }} />
                    <input
                      type="checkbox"
                      aria-label={t('iptSelectAllLots')}
                      checked={allSelected}
                      disabled={sellableLots.length === 0}
                      title={sellableLots.length === 0 ? t('iptNoSellableLots') : t('iptSelectAllSellable')}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleGroup(g)}
                    />
                  </div>
                </td>
                <td>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {cols.category && (
                      <span className={'chip ' + categoryChip(g.category)} style={{ fontSize: 10.5 }}>
                        {g.category}
                      </span>
                    )}
                    {productLabel(g)}
                    {g.mixed_spec && (
                      <span className="chip warn" title={t('iptSpecsVary')} style={{ fontSize: 10 }}>
                        {t('iptMixed')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
                    {productSpec(g)}
                  </div>
                </td>
                {cols.partNumber && (
                  <td className="mono muted" style={{ fontSize: 11.5 }}>
                    {g.part_number ?? '—'}
                  </td>
                )}
                {cols.qty && (
                  <td className="num">
                    <div className="mono" style={{ fontWeight: 600 }}>{g.qty}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
                      {t('iptQtyBreakdown', { stock: g.qty_in_stock, transit: g.qty_in_transit })}
                      {g.qty_reviewing ? ` · ${t('iptReviewingN', { n: g.qty_reviewing })}` : ''}
                    </div>
                  </td>
                )}
                <td className="muted" style={{ fontSize: 12 }}>
                  {t('iptLotPoSummary', { lots: g.lot_count, pos: g.po_count })}
                </td>
                {cols.warehouse && (
                  <td className="muted" style={{ fontSize: 12 }}>
                    {g.warehouses.length ? g.warehouses.join(', ') : '—'}
                  </td>
                )}
                {showCost && (
                  <td className="num mono muted">
                    {g.unit_cost_min === g.unit_cost_max
                      ? fmtUSD(g.unit_cost_avg ?? 0, locale)
                      : `${fmtUSD0(g.unit_cost_min ?? 0, locale)}–${fmtUSD0(g.unit_cost_max ?? 0, locale)}`}
                  </td>
                )}
                {cols.sellPrice && (
                  <td className="num mono">
                    {g.sell_price == null ? <span className="muted">—</span> : fmtUSD(g.sell_price, locale)}
                  </td>
                )}
              </tr>

              {isOpen && (
                <tr>
                  <td colSpan={totalCols} style={{ background: 'var(--bg-soft)', padding: 16 }}>
                    <div style={{
                      fontSize: 11.5, color: 'var(--fg-subtle)', textTransform: 'uppercase',
                      letterSpacing: '0.06em', fontWeight: 600, marginBottom: 8,
                    }}>
                      {t('iptLotsIn', { name: productLabel(g) })}
                    </div>
                    <table className="table" style={{
                      background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
                    }}>
                      <thead>
                        <tr>
                          <th style={{ width: 36 }} />
                          <th>{t('iptPO')}</th>
                          <th>{t('date')}</th>
                          <th>{t('iptBy')}</th>
                          {showCost && <th className="num">{t('eoCost')}</th>}
                          {cols.condition && <th>{t('condition')}</th>}
                          {cols.warehouse && <th>{t('warehouse')}</th>}
                          {cols.qty && <th className="num">{t('qty')}</th>}
                          <th>{t('status')}</th>
                          <th style={{ width: 90 }}>{t('actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => {
                          const lotSellable = SELLABLE.has(l.status);
                          const lotSelected = selected.has(l.id);
                          return (
                            <tr key={l.id} className={lotSelected ? 'row-selected' : undefined}>
                              <td>
                                <input
                                  type="checkbox"
                                  aria-label={t('iptSelectLot')}
                                  checked={lotSelected}
                                  disabled={!lotSellable}
                                  title={lotSellable ? t('iptAddToSellOrder') : t('iptCannotSell', { status: l.status })}
                                  onChange={() => onToggleLot(l.id)}
                                />
                              </td>
                              <td className="mono" style={{ fontSize: 11.5 }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                  {l.image_url && (
                                    <img
                                      src={l.image_url}
                                      alt={productLabel(g)}
                                      title={t('invQuickViewTooltip')}
                                      onClick={() => setLightbox(l.image_url)}
                                      style={{
                                        width: 32, height: 32, borderRadius: 6, objectFit: 'cover',
                                        border: '1px solid var(--border)', cursor: 'zoom-in', flexShrink: 0,
                                      }}
                                    />
                                  )}
                                  {l.order_id}
                                </span>
                              </td>
                              <td className="muted">{fmtDateShort(l.created_at, locale)}</td>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div className="avatar sm" title={l.user_name}>{l.user_initials}</div>
                                  <span style={{ fontSize: 12 }}>{l.user_name.split(' ')[0]}</span>
                                </div>
                              </td>
                              {showCost && (
                                <td className="num mono muted">{fmtUSD(l.unit_cost ?? 0, locale)}</td>
                              )}
                              {cols.condition && (
                                <td>
                                  <span className="chip" style={{ fontSize: 11 }}>{l.condition}</span>
                                  {l.health != null && (
                                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                                      {l.health}%
                                    </span>
                                  )}
                                </td>
                              )}
                              {cols.warehouse && (
                                <td>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                                    <Icon name="warehouse" size={11} style={{ color: 'var(--fg-subtle)' }} />
                                    {l.warehouse_short ?? '—'}
                                  </span>
                                </td>
                              )}
                              {cols.qty && (
                                <td className="num mono" style={{ fontWeight: 600 }}>{l.qty}</td>
                              )}
                              <td><span className={'chip dot ' + statusTone(l.status)}>{l.status}</span></td>
                              <td>
                                <div style={{ display: 'inline-flex', gap: 4 }}>
                                  <button
                                    className="btn icon sm"
                                    title={t('invQuickViewTooltip')}
                                    onClick={() => onQuickView(l.id)}
                                  >
                                    <Icon name="eye" size={12} />
                                  </button>
                                  <button
                                    className="btn icon sm"
                                    title={t('edit')}
                                    onClick={() => onEditLot(l.id)}
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
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    {lightbox && <ImageLightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}
