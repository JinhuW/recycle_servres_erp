import { Fragment, useState } from 'react';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../../lib/format';

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

type Props = {
  groups: ProductGroup[];
  isManager: boolean;
  selected: Set<string>;
  onToggleLot: (id: string) => void;
  onToggleGroup: (g: ProductGroup) => void;
  onQuickView: (lotId: string) => void;
  onEditLot: (lotId: string) => void;
};

const SELLABLE = new Set(['Reviewing', 'Done']);

function productLabel(g: ProductGroup): string {
  const bits = [g.brand, g.capacity, g.type, g.generation].filter(Boolean);
  return bits.length ? bits.join(' ') : (g.description || g.category);
}

function productSpec(g: ProductGroup): string {
  return [g.interface, g.form_factor, g.speed, g.rpm ? `${g.rpm} RPM` : null]
    .filter(Boolean).join(' · ');
}

export function InventoryProductTable({
  groups, isManager, selected, onToggleLot, onToggleGroup, onQuickView, onEditLot,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggleOpen = (key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <table className="inv-product-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th style={{ width: 28 }} />
          <th style={{ textAlign: 'left' }}>Product</th>
          <th style={{ textAlign: 'left' }}>Part #</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'left' }}>Lots</th>
          <th style={{ textAlign: 'left' }}>Warehouses</th>
          {isManager && <th style={{ textAlign: 'right' }}>Cost</th>}
          <th style={{ textAlign: 'right' }}>Sell</th>
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
                className="inv-product-row"
                style={{ cursor: 'pointer', borderTop: '1px solid var(--border, #eee)' }}
                onClick={() => toggleOpen(g.key)}
              >
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    aria-label="Select all sellable lots in this product"
                    checked={allSelected}
                    disabled={sellableLots.length === 0}
                    onChange={() => onToggleGroup(g)}
                  />
                </td>
                <td style={{ textAlign: 'center' }} aria-hidden>{isOpen ? '▾' : '▸'}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>
                    {productLabel(g)}
                    {g.mixed_spec && (
                      <span title="Specs vary across lots" style={{ marginLeft: 6, fontSize: 11, opacity: 0.6 }}>
                        mixed
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65 }}>{productSpec(g)}</div>
                </td>
                <td>{g.part_number ?? <span style={{ opacity: 0.4 }}>—</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  <strong>{g.qty}</strong>
                  <div style={{ fontSize: 11, opacity: 0.6 }}>
                    {g.qty_in_stock} in stock · {g.qty_in_transit} in transit
                    {g.qty_reviewing ? ` · ${g.qty_reviewing} reviewing` : ''}
                  </div>
                </td>
                <td>{g.lot_count} lot{g.lot_count === 1 ? '' : 's'} · {g.po_count} PO{g.po_count === 1 ? '' : 's'}</td>
                <td>{g.warehouses.length ? g.warehouses.join(', ') : <span style={{ opacity: 0.4 }}>—</span>}</td>
                {isManager && (
                  <td style={{ textAlign: 'right' }}>
                    {g.unit_cost_min === g.unit_cost_max
                      ? fmtUSD(g.unit_cost_avg ?? 0)
                      : `${fmtUSD0(g.unit_cost_min ?? 0)}–${fmtUSD0(g.unit_cost_max ?? 0)}`}
                  </td>
                )}
                <td style={{ textAlign: 'right' }}>
                  {g.sell_price == null ? <span style={{ opacity: 0.4 }}>—</span> : fmtUSD(g.sell_price)}
                </td>
              </tr>

              {isOpen && (
                <tr>
                  <td />
                  <td colSpan={isManager ? 8 : 7} style={{ padding: 0 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--subtle, #fafafa)' }}>
                      <thead>
                        <tr style={{ fontSize: 11, opacity: 0.6 }}>
                          <th style={{ width: 28 }} />
                          <th style={{ textAlign: 'left' }}>PO</th>
                          <th style={{ textAlign: 'left' }}>Date</th>
                          <th style={{ textAlign: 'left' }}>By</th>
                          {isManager && <th style={{ textAlign: 'right' }}>Cost</th>}
                          <th style={{ textAlign: 'left' }}>Condition</th>
                          <th style={{ textAlign: 'left' }}>Warehouse</th>
                          <th style={{ textAlign: 'right' }}>Qty</th>
                          <th style={{ textAlign: 'left' }}>Status</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.id} style={{ borderTop: '1px solid var(--border, #eee)' }}>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                aria-label="Select lot"
                                checked={selected.has(l.id)}
                                disabled={!SELLABLE.has(l.status)}
                                onChange={() => onToggleLot(l.id)}
                              />
                            </td>
                            <td>{l.order_id}</td>
                            <td>{fmtDateShort(l.created_at)}</td>
                            <td title={l.user_name}>{l.user_initials}</td>
                            {isManager && <td style={{ textAlign: 'right' }}>{fmtUSD(l.unit_cost ?? 0)}</td>}
                            <td>
                              {l.condition}
                              {l.health != null ? ` · ${l.health}%` : ''}
                            </td>
                            <td>{l.warehouse_short ?? '—'}</td>
                            <td style={{ textAlign: 'right' }}>{l.qty}</td>
                            <td>{l.status}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button type="button" title="Quick view" onClick={() => onQuickView(l.id)}>👁</button>
                              <button type="button" title="Edit" onClick={() => onEditLot(l.id)}>✎</button>
                            </td>
                          </tr>
                        ))}
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
  );
}
