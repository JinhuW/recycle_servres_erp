import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, fmtDate, relTime } from '../../lib/format';
import { ORDER_STATUSES, statusTone } from '../../lib/status';
import { CONDITIONS } from '../../lib/catalog';

type DetailRow = {
  id: string;
  category: 'RAM' | 'SSD' | 'Other';
  brand: string | null; capacity: string | null; type: string | null;
  classification: string | null; rank: string | null; speed: string | null;
  interface: string | null; form_factor: string | null; description: string | null;
  part_number: string | null; condition: string;
  qty: number; unit_cost: number; sell_price: number | null;
  status: string;
  warehouse_short: string | null; warehouse_region: string | null;
  user_initials: string; user_name: string;
  created_at: string; order_id: string;
};

type Event = {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_initials: string | null;
};

type Props = {
  itemId: string;
  onCancel: () => void;
  onSaved: () => void;
};

const KIND_ICON: Record<string, IconName> = {
  created: 'plus',
  edited:  'edit',
  status:  'flag',
  priced:  'tag',
};

type Tab = 'details' | 'pricing' | 'history';
type Draft = {
  partNumber: string;
  condition: string;
  qty: string;
  unitCost: string;
  sellPrice: string;
  status: string;
};

export function DesktopInventoryEdit({ itemId, onCancel, onSaved }: Props) {
  const { t } = useT();
  const [item, setItem] = useState<DetailRow | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [tab, setTab] = useState<Tab>('details');
  const [draft, setDraft] = useState<Draft | null>(null);
  const initialRef = useRef<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ item: DetailRow; events: Event[] }>(`/api/inventory/${itemId}`)
      .then(r => {
        setItem(r.item);
        setEvents(r.events);
        const d: Draft = {
          partNumber: r.item.part_number ?? '',
          condition: r.item.condition,
          qty: String(r.item.qty),
          unitCost: String(r.item.unit_cost),
          sellPrice: r.item.sell_price != null ? String(r.item.sell_price) : '',
          status: r.item.status,
        };
        setDraft(d);
        initialRef.current = JSON.stringify(d);
      })
      .catch(console.error);
  }, [itemId]);

  if (!item || !draft) {
    return <div style={{ padding: 40, color: 'var(--fg-subtle)' }}>Loading…</div>;
  }

  const dirty = JSON.stringify(draft) !== initialRef.current;
  const set = (patch: Partial<Draft>) => setDraft(prev => ({ ...prev!, ...patch }));

  const qty = Number(draft.qty) || 0;
  const unitCost = Number(draft.unitCost) || 0;
  const sellPrice = Number(draft.sellPrice) || 0;
  const revenue = qty * sellPrice;
  const cost    = qty * unitCost;
  const profit  = revenue - cost;
  const margin  = revenue > 0 ? (profit / revenue) * 100 : 0;
  const lossy   = sellPrice > 0 && sellPrice < unitCost;

  const cat = item.category;
  const itemTitle = cat === 'RAM' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.type ?? ''}`.trim()
                  : cat === 'SSD' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.interface ?? ''}`.trim()
                  : (item.description ?? 'Inventory item');

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/inventory/${itemId}`, {
        status: draft.status,
        sellPrice: draft.sellPrice === '' ? null : Number(draft.sellPrice),
        unitCost: Number(draft.unitCost) || 0,
        qty: Number(draft.qty) || 0,
        condition: draft.condition,
        partNumber: draft.partNumber || null,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const TABS: { id: Tab; label: string; icon: IconName; count?: number }[] = [
    { id: 'details', label: 'Details',            icon: 'edit' },
    { id: 'pricing', label: 'Pricing & quantity', icon: 'dollar' },
    { id: 'history', label: 'Activity log',       icon: 'history', count: events.length },
  ];

  return (
    <>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-subtle)', marginBottom: 10 }}>
        <button onClick={onCancel} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--fg-subtle)', cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit' }}>{t('inventoryTitle')}</button>
        <Icon name="chevronRight" size={12} />
        <span className="mono">{item.id.slice(0, 8)}</span>
        <Icon name="chevronRight" size={12} />
        <span style={{ color: 'var(--fg)' }}>{t('edit')}</span>
      </div>

      {/* Header */}
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, minWidth: 0 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 12,
            background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name={cat === 'RAM' ? 'chip' : cat === 'SSD' ? 'drive' : 'box'} size={24} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>{itemTitle}</span>
              {dirty && <span className="chip warn" style={{ fontSize: 10.5 }}>Unsaved</span>}
            </h1>
            <div className="page-sub" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="mono">{item.id.slice(0, 8)}</span>
              <span style={{ color: 'var(--border-strong)' }}>·</span>
              <span className="mono" style={{ color: 'var(--fg-muted)' }}>{draft.partNumber || '—'}</span>
              <span style={{ color: 'var(--border-strong)' }}>·</span>
              <span>{t('submittedBy')} {item.user_name.split(' ')[0]} · {fmtDate(item.created_at)}</span>
            </div>
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn accent" disabled={!dirty || saving} onClick={save}>
            <Icon name="check" size={13} /> {saving ? '…' : t('save')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(tt => (
          <button
            key={tt.id}
            className={'tab ' + (tab === tt.id ? 'active' : '')}
            onClick={() => setTab(tt.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          >
            <Icon name={tt.icon} size={13} />
            {tt.label}
            {tt.count !== undefined && (
              <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 999, background: 'var(--bg-soft)', color: 'var(--fg-subtle)', fontWeight: 600 }}>
                {tt.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {tab === 'details' && (
            <DetailsPanel item={item} draft={draft} set={set} />
          )}
          {tab === 'pricing' && (
            <PricingPanel
              item={item}
              draft={draft}
              set={set}
              revenue={revenue}
              profit={profit}
              margin={margin}
              lossy={lossy}
            />
          )}
          {tab === 'history' && (
            <HistoryPanel events={events} />
          )}
        </div>

        {/* Right column — summary */}
        <SummaryColumn
          item={item}
          draft={draft}
          revenue={revenue}
          profit={profit}
          margin={margin}
        />
      </div>
    </>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────
function DetailsPanel({
  item, draft, set,
}: {
  item: DetailRow;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
}) {
  const cat = item.category;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{cat} specifications</div>
            <div className="card-sub">
              Captured by the submitter when this item entered the warehouse.
              Spec fields are immutable — adjust qty, cost or status on the Pricing tab.
            </div>
          </div>
          <span className={'chip ' + (cat === 'RAM' ? 'info' : cat === 'SSD' ? 'pos' : 'warn')}>{cat}</span>
        </div>
        <div className="card-body">
          {cat === 'RAM' && (
            <div className="grid-2">
              <Row label="Brand"          value={item.brand} />
              <Row label="Capacity"       value={item.capacity} />
              <Row label="Type"           value={item.type} />
              <Row label="Classification" value={item.classification} />
              <Row label="Rank"           value={item.rank} />
              <Row label="Speed"          value={item.speed ? `${item.speed} MHz` : null} />
            </div>
          )}
          {cat === 'SSD' && (
            <div className="grid-2">
              <Row label="Brand"        value={item.brand} />
              <Row label="Capacity"     value={item.capacity} />
              <Row label="Interface"    value={item.interface} />
              <Row label="Form factor"  value={item.form_factor} />
            </div>
          )}
          {cat === 'Other' && (
            <Row label="Description" value={item.description} />
          )}

          <div className="divider" />

          <div className="grid-2">
            <div className="field">
              <label className="label">Part number</label>
              <input
                className="input mono"
                value={draft.partNumber}
                onChange={e => set({ partNumber: e.target.value })}
                placeholder="—"
              />
            </div>
            <div className="field">
              <label className="label">Condition</label>
              <select
                className="select"
                value={draft.condition}
                onChange={e => set({ condition: e.target.value })}
              >
                {CONDITIONS.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      <div
        className="input"
        style={{
          background: 'var(--bg-soft)', color: value ? 'var(--fg)' : 'var(--fg-subtle)',
          pointerEvents: 'none', userSelect: 'text',
        }}
      >
        {value ?? '—'}
      </div>
    </div>
  );
}

// ─── Pricing & Quantity ──────────────────────────────────────────────────────
function PricingPanel({
  item, draft, set, revenue, profit, margin, lossy,
}: {
  item: DetailRow;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  revenue: number;
  profit: number;
  margin: number;
  lossy: boolean;
}) {
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Pricing & quantity</div>
            <div className="card-sub">Quantity and unit cost stay editable while the line is open. Sell price drives margin once the item is reviewed.</div>
          </div>
          <span className={'chip dot ' + statusTone(draft.status)}>{draft.status}</span>
        </div>
        <div className="card-body">
          <div className="grid-2">
            <div className="field">
              <label className="label">Quantity</label>
              <input
                className="input mono"
                type="number"
                min={0}
                value={draft.qty}
                onChange={e => set({ qty: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="label">Status</label>
              <select className="select" value={draft.status} onChange={e => set({ status: e.target.value })}>
                {ORDER_STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Unit cost</label>
              <input
                className="input mono"
                type="number"
                step="0.01"
                min={0}
                value={draft.unitCost}
                onChange={e => set({ unitCost: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="label">Sell price <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>(unit)</span></label>
              <input
                className="input mono"
                type="number"
                step="0.01"
                min={0}
                value={draft.sellPrice}
                onChange={e => set({ sellPrice: e.target.value })}
                placeholder="—"
              />
            </div>
          </div>

          {lossy && (
            <div style={{
              marginTop: 14, padding: '10px 12px', borderRadius: 8,
              background: 'var(--warn-soft)', color: 'oklch(0.45 0.13 75)',
              fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid color-mix(in oklch, var(--warn) 30%, transparent)',
            }}>
              <Icon name="alert" size={13} />
              Sell price is below unit cost — this line would book at a loss.
            </div>
          )}

          <div className="divider" />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <Stat label="Revenue" value={fmtUSD(revenue)} />
            <Stat label="Profit"  value={fmtUSD(profit)}  tone={profit >= 0 ? 'pos' : 'neg'} />
            <Stat label="Margin"  value={margin.toFixed(1) + '%'} tone={margin >= 25 ? 'pos' : margin >= 10 ? 'muted' : 'neg'} />
          </div>
        </div>
      </div>

      {/* Warehouse / origin (read-only — backend doesn't expose move-warehouse yet) */}
      <div className="card">
        <div className="card-head">
          <div className="card-title">Location</div>
        </div>
        <div className="card-body">
          <div className="grid-2">
            <Row label="Warehouse" value={item.warehouse_short ? `${item.warehouse_short} · ${item.warehouse_region ?? ''}` : null} />
            <Row label="Order"     value={item.order_id} />
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' | 'muted' }) {
  const color = tone === 'pos' ? 'var(--pos)' : tone === 'neg' ? 'var(--neg)' : tone === 'muted' ? 'var(--fg-subtle)' : 'var(--fg)';
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: 'var(--bg-soft)', border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, marginTop: 4, color }}>{value}</div>
    </div>
  );
}

// ─── Activity log ────────────────────────────────────────────────────────────
function HistoryPanel({ events }: { events: Event[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Activity log</div>
          <div className="card-sub">Append-only — every status change and edit is logged with the actor and timestamp.</div>
        </div>
        <span className="chip muted">{events.length} {events.length === 1 ? 'event' : 'events'}</span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {events.length === 0 && (
            <div style={{ padding: 18, color: 'var(--fg-subtle)', fontSize: 12 }}>No history yet.</div>
          )}
          {events.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', gap: 12, padding: '12px 18px', borderBottom: i < events.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--bg-soft)', color: 'var(--fg-muted)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Icon name={KIND_ICON[e.kind] ?? 'info'} size={13} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {summarizeEvent(e)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                  {e.actor_name ?? 'system'} · {relTime(e.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function summarizeEvent(e: Event): string {
  const d = e.detail as Record<string, unknown>;
  if (e.kind === 'created') return 'Item created';
  if (e.kind === 'status')  return `Status → ${String(d.to ?? '?')}`;
  if (e.kind === 'priced')  return `Sell price → ${fmtUSD0(Number(d.to ?? 0))}`;
  if (e.kind === 'edited')  return `${String(d.field ?? 'field')}: ${String(d.from ?? '?')} → ${String(d.to ?? '?')}`;
  return e.kind;
}

// ─── Right summary column ────────────────────────────────────────────────────
function SummaryColumn({
  item, draft, revenue, profit, margin,
}: {
  item: DetailRow;
  draft: Draft;
  revenue: number;
  profit: number;
  margin: number;
}) {
  const sellable = draft.status === 'Reviewing' || draft.status === 'Done';
  return useMemo(() => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 16 }}>
      <div className="card">
        <div className="card-head">
          <div className="card-title">At a glance</div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SummaryRow label="Status" value={<span className={'chip dot ' + statusTone(draft.status)}>{draft.status}</span>} />
          <SummaryRow label="Quantity" value={<span className="mono">{draft.qty}</span>} />
          <SummaryRow label="Unit cost" value={<span className="mono">{fmtUSD(Number(draft.unitCost) || 0)}</span>} />
          <SummaryRow label="Sell price" value={
            <span className="mono">{draft.sellPrice ? fmtUSD(Number(draft.sellPrice)) : '—'}</span>
          } />
          <div className="divider" style={{ margin: '4px 0' }} />
          <SummaryRow label="Revenue" value={<span className="mono">{fmtUSD(revenue)}</span>} />
          <SummaryRow label="Profit" value={<span className={'mono ' + (profit >= 0 ? 'pos' : 'neg')} style={{ fontWeight: 600 }}>{fmtUSD(profit)}</span>} />
          <SummaryRow label="Margin" value={<span className="mono">{margin.toFixed(1)}%</span>} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Origin</div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SummaryRow label="Order" value={<span className="mono">{item.order_id}</span>} />
          <SummaryRow label="Warehouse" value={item.warehouse_short ?? '—'} />
          <SummaryRow label="Submitted by" value={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="avatar sm">{item.user_initials}</span>
              {item.user_name.split(' ')[0]}
            </span>
          } />
          <SummaryRow label="Submitted" value={fmtDate(item.created_at)} />
        </div>
      </div>

      {sellable && (
        <div className="so-tip">
          <Icon name="info" size={13} />
          <div>
            This item is <strong>{draft.status === 'Reviewing' ? 'ready to sell' : 'closed'}</strong> —
            select it from Inventory to add to a sell order.
          </div>
        </div>
      )}
    </div>
  ), [item, draft.status, draft.qty, draft.unitCost, draft.sellPrice, revenue, profit, margin, sellable]);
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
      <span style={{ color: 'var(--fg-subtle)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
