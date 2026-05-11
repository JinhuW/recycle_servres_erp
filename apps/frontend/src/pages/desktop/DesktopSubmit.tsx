import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD } from '../../lib/format';
import type { Category, Warehouse } from '../../lib/types';
import {
  RAM_BRANDS, RAM_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP, RAM_SPEED,
  SSD_BRANDS, SSD_INTERFACE, SSD_FORM, SSD_CAP,
  CONDITIONS,
} from '../../lib/catalog';

// ─── Public component ────────────────────────────────────────────────────────
// Two-step submit flow lifted from design/submit.jsx + design/app.jsx#SubmitView:
//   1. Category picker (RAM / SSD / Other) — chunky cards, AI-capture tag on RAM
//   2. OrderForm — line-item table + right-side drawer for editing one line,
//      plus a sticky bottom card with order meta + totals + submit action.
//
// Camera capture is intentionally omitted on desktop — purchasers should use
// the phone app for AI label scans. Manual entry covers the rest.

type Props = {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
};

export function DesktopSubmit({ onDone }: Props) {
  const { t } = useT();
  const [cat, setCat] = useState<Category | null>(null);

  if (!cat) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('submitNewOrder')}</h1>
            <div className="page-sub">{t('submitNewOrderSub')}</div>
          </div>
        </div>

        <div style={{ maxWidth: 720, margin: '24px auto 0' }}>
          <div style={{
            fontSize: 11, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
          }}>
            {t('chooseItemType')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {([
              { id: 'RAM',   icon: 'chip',  sub: t('ramSub'),   tag: t('aiLabelCapture') },
              { id: 'SSD',   icon: 'drive', sub: t('ssdSub'),   tag: t('manualEntry') },
              { id: 'Other', icon: 'box',   sub: t('otherSub'), tag: t('manualEntry') },
            ] as const).map(c => (
              <button
                key={c.id}
                onClick={() => setCat(c.id as Category)}
                className="card"
                style={{
                  padding: 22, display: 'flex', flexDirection: 'column',
                  alignItems: 'flex-start', gap: 14,
                  background: 'var(--bg-elev)', cursor: 'pointer',
                  textAlign: 'left', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  transition: 'transform 0.12s, border-color 0.12s, box-shadow 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(15,23,42,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                  display: 'grid', placeItems: 'center',
                }}>
                  <Icon name={c.icon} size={22} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }}>{c.id}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{c.sub}</div>
                </div>
                <span className={'chip ' + (c.id === 'RAM' ? 'pos' : '')} style={{ fontSize: 10 }}>
                  {c.id === 'RAM' && <Icon name="sparkles" size={9} />} {c.tag}
                </span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 18, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'center' }}>
            {t('multipleLineItems')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('submitNewCatOrder', { cat })}</h1>
          <div className="page-sub">
            {t('submitNewCatOrderSub', { cat })}{' '}
            <button
              onClick={() => setCat(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--accent-strong)', padding: 0,
                fontSize: 'inherit', textDecoration: 'underline',
                fontFamily: 'inherit',
              }}
            >
              {t('changeItemType')}
            </button>
          </div>
        </div>
      </div>

      <OrderForm
        key={cat}
        category={cat}
        onCancel={() => setCat(null)}
        onSubmit={async (payload) => {
          try {
            await api.post('/api/orders', payload);
            onDone({ msg: 'Order submitted — added to inventory', kind: 'success' });
          } catch (e) {
            onDone({ msg: e instanceof Error ? e.message : 'Submit failed', kind: 'error' });
          }
        }}
      />
    </>
  );
}

// ─── OrderForm ───────────────────────────────────────────────────────────────
type Line = {
  category: Category;
  brand?: string;
  capacity?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
  interface?: string;
  formFactor?: string;
  description?: string;
  partNumber?: string;
  condition: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
};

type OrderMeta = {
  warehouseId: string;
  payment: 'Company' | 'Self';
  notes: string;
  totalCostOverride: string | null;
};

type Payload = {
  category: Category;
  warehouseId: string;
  payment: 'company' | 'self';
  notes: string;
  totalCost: number;
  lines: Array<{
    category: Category;
    brand: string | null;
    capacity: string | null;
    type: string | null;
    classification: string | null;
    rank: string | null;
    speed: string | null;
    interface: string | null;
    formFactor: string | null;
    description: string | null;
    partNumber: string | null;
    condition: string;
    qty: number;
    unitCost: number;
    sellPrice: number | null;
  }>;
};

function blankLine(cat: Category): Line {
  return {
    category: cat, qty: 1, unitCost: '',
    condition: 'Pulled — Tested',
  };
}

function OrderForm({
  category,
  onCancel,
  onSubmit,
}: {
  category: Category;
  onCancel: () => void;
  onSubmit: (payload: Payload) => void;
}) {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => setWarehouses(r.items))
      .catch(() => {/* keep empty list — UI shows a hint */});
  }, []);

  const [lines, setLines] = useState<Line[]>([blankLine(category)]);
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [meta, setMeta] = useState<OrderMeta>({
    warehouseId: '',
    payment: 'Company',
    notes: '',
    totalCostOverride: null,
  });

  // Default the warehouse to the first one once they load.
  useEffect(() => {
    if (warehouses.length && !meta.warehouseId) {
      setMeta(m => ({ ...m, warehouseId: warehouses[0].id }));
    }
  }, [warehouses, meta.warehouseId]);

  const totals = useMemo(() => {
    let units = 0, cost = 0;
    lines.forEach(l => {
      const qty = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      units += qty;
      cost += qty * c;
    });
    return { units, cost };
  }, [lines]);

  const updateLine = (i: number, patch: Partial<Line>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const addLine = () => {
    setLines(ls => [...ls, blankLine(category)]);
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

  const canSubmit = lines.every(l => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  });

  const buildPayload = (): Payload => {
    const totalCost = meta.totalCostOverride != null
      ? (Number(meta.totalCostOverride) || 0)
      : totals.cost;
    return {
      category,
      warehouseId: meta.warehouseId,
      payment: meta.payment === 'Company' ? 'company' : 'self',
      notes: meta.notes,
      totalCost,
      lines: lines.map(l => ({
        category: l.category,
        brand: l.brand ?? null,
        capacity: l.capacity ?? null,
        type: l.type ?? null,
        classification: l.classification ?? null,
        rank: l.rank ?? null,
        speed: l.speed ?? null,
        interface: l.interface ?? null,
        formFactor: l.formFactor ?? null,
        description: l.description ?? null,
        partNumber: l.partNumber ?? null,
        condition: l.condition,
        qty: Number(l.qty) || 0,
        unitCost: Number(l.unitCost) || 0,
        sellPrice: l.sellPrice == null || l.sellPrice === '' ? null : Number(l.sellPrice),
      })),
    };
  };

  // Escape closes the drawer.
  useEffect(() => {
    if (activeIdx === null) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveIdx(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx]);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Order details</div>
            <div className="card-sub">An order contains multiple line items of the same category ({category}).</div>
          </div>
          <span className="chip mono">
            {'SO-' + Math.floor(Math.random() * 9000 + 1000)} · Draft
          </span>
        </div>

        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 18px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Items in this order <span style={{ fontWeight: 500, color: 'var(--fg-subtle)', marginLeft: 4 }}>({lines.length})</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              Click a row to edit it. Use "Add {category} line" to add another item.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="chip mono">{totals.units} units · {fmtUSD(totals.cost)}</span>
            <button className="btn" onClick={addLine}>
              <Icon name="plus" size={13} /> Add {category} line
            </button>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Item</th>
              <th>Part #</th>
              <th className="num">Qty</th>
              <th className="num">Unit cost</th>
              <th className="num">Total cost</th>
              <th>Status</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lQty = Number(l.qty) || 0;
              const lCost = Number(l.unitCost) || 0;
              const filled = !!l.brand || !!l.description;
              const isActive = i === activeIdx;
              return (
                <tr
                  key={i}
                  className="row-hover"
                  style={{ cursor: 'pointer', background: isActive ? 'var(--accent-soft)' : undefined }}
                  onClick={() => setActiveIdx(i)}
                >
                  <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                  <td>
                    {filled ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.type ?? ''}`.trim()}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()}
                          {l.category === 'Other' && (l.description ?? '—')}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                          {l.category === 'RAM' && [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')}
                          {l.category === 'SSD' && [l.formFactor, l.condition].filter(Boolean).join(' · ')}
                          {l.category === 'Other' && l.condition}
                        </div>
                      </div>
                    ) : <span className="muted" style={{ fontStyle: 'italic' }}>{isActive ? 'Editing — fill in below' : 'Not filled in'}</span>}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                  <td className="num mono">{lQty}</td>
                  <td className="num mono">{lCost ? fmtUSD(lCost) : '—'}</td>
                  <td className="num mono">{lQty && lCost ? fmtUSD(lQty * lCost) : '—'}</td>
                  <td>
                    {isActive && <span className="chip info"><Icon name="edit" size={10} /> Editing</span>}
                    {!isActive && filled && <span className="chip pos">Ready</span>}
                    {!isActive && !filled && <span className="chip warn">Needs info</span>}
                  </td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sticky bottom: meta + totals + submit */}
      <div className="card" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: '0 12px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Warehouse <span className="req">*</span></label>
              <select
                className="select"
                value={meta.warehouseId}
                onChange={e => setMeta(m => ({ ...m, warehouseId: e.target.value }))}
              >
                {warehouses.length === 0 && <option value="">Loading…</option>}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Payment <span className="req">*</span></label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  className={meta.payment === 'Company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Company' }))}
                >Company</button>
                <button
                  className={meta.payment === 'Self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Self' }))}
                >Self-paid</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>Total cost</span>
                {meta.totalCostOverride !== null && (
                  <button
                    onClick={() => setMeta(m => ({ ...m, totalCostOverride: null }))}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-strong)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                    title={`Auto-sum is ${fmtUSD(totals.cost)}`}
                  >reset</button>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}>$</span>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={meta.totalCostOverride !== null ? meta.totalCostOverride : totals.cost.toFixed(2)}
                  onChange={e => setMeta(m => ({ ...m, totalCostOverride: e.target.value }))}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 24, fontWeight: 500 }}
                />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">Notes</label>
              <input
                className="input"
                value={meta.notes}
                onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </div>
        </div>

        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 18, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Lines</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Total units</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.units}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              Total cost
              {meta.totalCostOverride !== null && Math.abs((Number(meta.totalCostOverride) || 0) - totals.cost) > 0.01 && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · override</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(meta.totalCostOverride !== null ? (Number(meta.totalCostOverride) || 0) : totals.cost)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>Cancel</button>
            <button
              className="btn accent"
              disabled={!canSubmit || !meta.warehouseId}
              onClick={() => onSubmit(buildPayload())}
            >
              Submit order <Icon name="check" size={14} />
            </button>
          </div>
        </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          line={lines[activeIdx]}
          idx={activeIdx}
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
        />
      )}
    </>
  );
}

// ─── LineDrawer ──────────────────────────────────────────────────────────────
function LineDrawer({
  line, idx, onChange, onClose, onRemove, canRemove,
}: {
  line: Line;
  idx: number;
  onChange: (patch: Partial<Line>) => void;
  onClose: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const cat = line.category;
  const set = (patch: Partial<Line>) => onChange(patch);

  const qty = Number(line.qty) || 0;
  const cost = Number(line.unitCost) || 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 80 }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: '100%', maxWidth: 620,
          background: 'var(--bg)',
          boxShadow: '-12px 0 40px rgba(15,23,42,0.18)',
          overflowY: 'auto',
          animation: 'drawer-in 0.2s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="card" style={{ overflow: 'hidden', borderRadius: 0, border: 'none', boxShadow: 'none' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 18px', background: 'var(--bg-soft)',
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              display: 'grid', placeItems: 'center',
              fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)',
              flexShrink: 0,
            }}>{idx + 1}</div>
            <div style={{
              width: 56, height: 56, borderRadius: 8,
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)',
              flexShrink: 0,
            }}>
              <Icon name={cat === 'RAM' ? 'chip' : cat === 'SSD' ? 'drive' : 'box'} size={20} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={'chip ' + (cat === 'RAM' ? 'info' : cat === 'SSD' ? 'pos' : 'warn')}>{cat}</span>
                <span>
                  {cat === 'RAM' && `${line.brand ?? '—'} ${line.capacity ?? ''} ${line.type ?? ''}`.trim()}
                  {cat === 'SSD' && `${line.brand ?? '—'} ${line.capacity ?? ''} ${line.interface ?? ''}`.trim()}
                  {cat === 'Other' && (line.description ?? 'Untitled item')}
                </span>
              </div>
              {(line.brand || line.description) && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
                  {line.partNumber || '—'} · qty {line.qty} · cost {fmtUSD(qty * cost)}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn icon sm" onClick={onClose} title="Close edit">
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>

          <div style={{ padding: 16, display: 'grid', gap: 14 }}>
            {cat === 'RAM' && <RamFields line={line} set={set} />}
            {cat === 'SSD' && <SsdFields line={line} set={set} />}
            {cat === 'Other' && <OtherFields line={line} set={set} />}

            <div style={{
              display: 'grid', gridTemplateColumns: '120px 1fr 1fr',
              gap: 14, alignItems: 'end',
              padding: 14, background: 'var(--bg-soft)', borderRadius: 10,
            }}>
              <div className="field">
                <label className="label">Qty <span className="req">*</span></label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={line.qty}
                  onChange={e => set({ qty: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">Unit cost <span className="req">*</span></label>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={line.unitCost}
                  onChange={e => set({ unitCost: e.target.value, totalCost: undefined })}
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label className="label">Total cost</label>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={line.totalCost !== undefined ? line.totalCost : (qty * cost ? (qty * cost).toFixed(2) : '')}
                  onChange={e => {
                    const v = e.target.value;
                    const newTotal = Number(v);
                    const newUnit = qty > 0 && newTotal > 0 ? +(newTotal / qty).toFixed(2) : line.unitCost;
                    set({ totalCost: v, unitCost: String(newUnit) });
                  }}
                  placeholder="0.00"
                />
              </div>
            </div>
          </div>

          <div style={{
            display: 'flex', justifyContent: 'space-between', gap: 8,
            padding: '12px 18px',
            borderTop: '1px solid var(--border)', background: 'var(--bg-soft)',
          }}>
            <button
              className="btn"
              onClick={() => { onRemove(); onClose(); }}
              disabled={!canRemove}
              style={canRemove ? { color: 'var(--neg)' } : undefined}
            >
              <Icon name="trash" size={13} /> Remove line
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn accent" onClick={onClose}>
                <Icon name="check" size={13} /> Confirm line
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Field groups ────────────────────────────────────────────────────────────
type FieldsProps = { line: Line; set: (patch: Partial<Line>) => void };

function CatSelect({ value, options, onChange }: { value: string | undefined; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <select className="select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">Select…</option>
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

function RamFields({ line, set }: FieldsProps) {
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">Brand <span className="req">*</span></label>
        <CatSelect value={line.brand} options={RAM_BRANDS} onChange={v => set({ brand: v })} />
      </div>
      <div className="field">
        <label className="label">Capacity <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={RAM_CAP} onChange={v => set({ capacity: v })} />
      </div>
      <div className="field">
        <label className="label">Type <span className="req">*</span></label>
        <CatSelect value={line.type} options={RAM_TYPES} onChange={v => set({ type: v })} />
      </div>
      <div className="field">
        <label className="label">Classification</label>
        <CatSelect value={line.classification} options={RAM_CLASS} onChange={v => set({ classification: v })} />
      </div>
      <div className="field">
        <label className="label">Rank</label>
        <CatSelect value={line.rank} options={RAM_RANK} onChange={v => set({ rank: v })} />
      </div>
      <div className="field">
        <label className="label">Speed (MHz)</label>
        <CatSelect value={line.speed} options={RAM_SPEED} onChange={v => set({ speed: v })} />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">Part number</label>
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
          placeholder="M393A4K40DB3-CWE"
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">Condition <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}

function SsdFields({ line, set }: FieldsProps) {
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">Brand <span className="req">*</span></label>
        <CatSelect value={line.brand} options={SSD_BRANDS} onChange={v => set({ brand: v })} />
      </div>
      <div className="field">
        <label className="label">Capacity <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={SSD_CAP} onChange={v => set({ capacity: v })} />
      </div>
      <div className="field">
        <label className="label">Interface <span className="req">*</span></label>
        <CatSelect value={line.interface} options={SSD_INTERFACE} onChange={v => set({ interface: v })} />
      </div>
      <div className="field">
        <label className="label">Form factor</label>
        <CatSelect value={line.formFactor} options={SSD_FORM} onChange={v => set({ formFactor: v })} />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">Part number</label>
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">Condition <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}

function OtherFields({ line, set }: FieldsProps) {
  return (
    <div className="grid-2">
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">Item description <span className="req">*</span></label>
        <input
          className="input"
          value={line.description ?? ''}
          onChange={e => set({ description: e.target.value })}
          placeholder="e.g. Xeon Gold 6248"
        />
      </div>
      <div className="field">
        <label className="label">Part / SKU</label>
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="label">Condition <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}
