import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, fmtDate, relTime } from '../../lib/format';
import { ORDER_STATUSES, statusTone } from '../../lib/status';
import { CONDITIONS } from '../../lib/catalog';
import { FormSkeleton } from '../../components/Skeleton';

type DetailRow = {
  id: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  brand: string | null; capacity: string | null; type: string | null; generation: string | null;
  classification: string | null; rank: string | null; speed: string | null;
  interface: string | null; form_factor: string | null; description: string | null;
  part_number: string | null; condition: string;
  qty: number; unit_cost: number; sell_price: number | null;
  status: string;
  health: number | null;
  rpm: number | null;
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
  health: string;
  rpm: string;
};

// Peer inventory row (other lines sharing the same part_number). The /api/inventory
// list endpoint returns more fields than this — pick only what the stock card uses.
type PeerRow = {
  id: string;
  part_number: string | null;
  qty: number;
  status: string;
  warehouse_id: string | null;
  warehouse_short: string | null;
  warehouse_region: string | null;
};

type StockRow = {
  whId: string;
  whShort: string;
  whRegion: string;
  onHand: number;
  inTransit: number;
  reviewing: number;
  lines: number;
};

// Sell order that references this inventory line — drives the
// "Linked sell orders" card.
type LinkedSellOrder = {
  id: string;
  status: 'Draft' | 'Shipped' | 'Awaiting payment' | 'Done';
  created_at: string;
  customer_name: string | null;
  qty: number;
  unit_price: number;
};

// Subset of the /api/market row (RefPrice). Just what we render in the
// Market reference card.
type RefMatch = {
  partNumber: string | null;
  label: string;
  sub: string | null;
  source: string | null;
  target: number;
  low: number;
  high: number;
  avgSell: number;
  samples: number;
  demand: 'high' | 'medium' | 'low';
  updated: string;
};

export function DesktopInventoryEdit({ itemId, onCancel, onSaved }: Props) {
  const { t } = useT();
  const [item, setItem] = useState<DetailRow | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [tab, setTab] = useState<Tab>('details');
  const [draft, setDraft] = useState<Draft | null>(null);
  const initialRef = useRef<string>('');
  const [saving, setSaving] = useState(false);

  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [refMatch, setRefMatch] = useState<RefMatch | null>(null);
  const [linkedSellOrders, setLinkedSellOrders] = useState<LinkedSellOrder[]>([]);
  const [internalNotes, setInternalNotes] = useState('');

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
          health: r.item.health != null ? String(r.item.health) : '',
          rpm: r.item.rpm != null ? String(r.item.rpm) : '',
        };
        setDraft(d);
        initialRef.current = JSON.stringify(d);
      })
      .catch(console.error);
  }, [itemId]);

  // Peers: other inventory lines that share this part_number. Drives the
  // "Stock across warehouses" aggregation. /api/inventory?q= does a LIKE on
  // part_number — filter client-side for exact match.
  useEffect(() => {
    const pn = item?.part_number;
    if (!pn) { setPeers([]); return; }
    api.get<{ items: PeerRow[] }>(`/api/inventory?q=${encodeURIComponent(pn)}`)
      .then(r => setPeers(r.items.filter(p => p.part_number === pn)))
      .catch(() => setPeers([]));
  }, [item?.part_number]);

  // Market reference match: same part number wins; fall back to first row.
  useEffect(() => {
    const pn = item?.part_number;
    if (!pn) { setRefMatch(null); return; }
    api.get<{ items: RefMatch[] }>(`/api/market?q=${encodeURIComponent(pn)}`)
      .then(r => {
        const match = r.items.find(x => x.partNumber === pn) ?? r.items[0] ?? null;
        setRefMatch(match);
      })
      .catch(() => setRefMatch(null));
  }, [item?.part_number]);

  // Sell orders that drew from this inventory line.
  useEffect(() => {
    api.get<{ items: LinkedSellOrder[] }>(`/api/inventory/${itemId}/sell-orders`)
      .then(r => setLinkedSellOrders(r.items))
      .catch(() => setLinkedSellOrders([]));
  }, [itemId]);

  if (!item || !draft) {
    return (
      <div style={{ padding: '24px 28px', maxWidth: 720 }}>
        <FormSkeleton fields={8} />
      </div>
    );
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
  const itemTitle = cat === 'RAM' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.generation ?? ''}`.trim()
                  : cat === 'SSD' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.interface ?? ''}`.trim()
                  : cat === 'HDD' ? `${item.brand ?? ''} ${item.capacity ?? ''} ${item.rpm ? item.rpm + 'rpm' : ''}`.trim()
                  : (item.description ?? 'Inventory item');

  // Aggregate peers by warehouse for the Stock card.
  const stock = (() => {
    if (peers.length === 0) return null;
    const byWh = new Map<string, StockRow>();
    for (const p of peers) {
      const wid = p.warehouse_id ?? '_unknown';
      const row = byWh.get(wid) ?? {
        whId: wid, whShort: p.warehouse_short ?? '—', whRegion: p.warehouse_region ?? '',
        onHand: 0, inTransit: 0, reviewing: 0, lines: 0,
      };
      row.lines += 1;
      if (p.status === 'Done') row.onHand += p.qty;
      else if (p.status === 'Reviewing') { row.onHand += p.qty; row.reviewing += p.qty; }
      else if (p.status === 'In Transit') row.inTransit += p.qty;
      byWh.set(wid, row);
    }
    const rows = [...byWh.values()].sort((a, b) => (b.onHand + b.inTransit) - (a.onHand + a.inTransit));
    return {
      rows,
      peerCount: peers.length,
      onHandTotal:    rows.reduce((s, r) => s + r.onHand, 0),
      inTransitTotal: rows.reduce((s, r) => s + r.inTransit, 0),
    };
  })();
  const currentWhId = peers.find(p => p.id === item.id)?.warehouse_id ?? null;

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
        health: draft.health === '' ? null : Number(draft.health),
        rpm: draft.rpm === '' ? null : Number(draft.rpm),
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
            <Icon name={cat === 'RAM' ? 'chip' : (cat === 'SSD' || cat === 'HDD') ? 'drive' : 'box'} size={24} />
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
            <DetailsPanel
              item={item}
              draft={draft}
              set={set}
              stock={stock}
              currentWhId={currentWhId}
              linkedSellOrders={linkedSellOrders}
            />
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
              refMatch={refMatch}
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
          internalNotes={internalNotes}
          setInternalNotes={setInternalNotes}
        />
      </div>

      {dirty && (
        <div className="save-bar">
          <div className="save-bar-msg">
            <span className="chip warn" style={{ fontSize: 10.5 }}>Unsaved</span>
            <span>You have unsaved changes to <strong>{itemTitle || item.id.slice(0, 8)}</strong>.</span>
          </div>
          <div className="save-bar-actions">
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            <button className="btn accent" disabled={saving} onClick={save}>
              <Icon name="check" size={13} /> {saving ? '…' : t('save')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Details ─────────────────────────────────────────────────────────────────
function DetailsPanel({
  item, draft, set, stock, currentWhId, linkedSellOrders,
}: {
  item: DetailRow;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  stock: {
    rows: StockRow[]; peerCount: number;
    onHandTotal: number; inTransitTotal: number;
  } | null;
  currentWhId: string | null;
  linkedSellOrders: LinkedSellOrder[];
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
          <span className={'chip ' + (cat === 'RAM' ? 'info' : cat === 'SSD' ? 'pos' : cat === 'HDD' ? 'cool' : 'warn')}>{cat}</span>
        </div>
        <div className="card-body">
          {cat === 'RAM' && (
            <div className="grid-2">
              <Row label="Brand"          value={item.brand} />
              <Row label="Capacity"       value={item.capacity} />
              <Row label="Generation"      value={item.generation} />
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
          {cat === 'HDD' && (
            <div className="grid-2">
              <Row label="Brand"        value={item.brand} />
              <Row label="Capacity"     value={item.capacity} />
              <Row label="Interface"    value={item.interface} />
              <Row label="Form factor"  value={item.form_factor} />
              <Row label="RPM"          value={item.rpm != null ? String(item.rpm) : null} />
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
            {(cat === 'SSD' || cat === 'HDD') && (
              <div className="field">
                <label className="label">Health (%)</label>
                <input
                  type="number" min={0} max={100} step={0.1}
                  className="input"
                  value={draft.health}
                  onChange={e => set({ health: e.target.value })}
                  placeholder="—"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {stock && stock.peerCount > 1 && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Stock across warehouses
                <span className="chip muted" style={{ fontSize: 10.5 }}>
                  <span className="mono">{draft.partNumber || '—'}</span>
                </span>
              </div>
              <div className="card-sub">
                Aggregated by part number across {stock.peerCount} {stock.peerCount === 1 ? 'line' : 'lines'}.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <StockTotal label="On hand"    value={stock.onHandTotal}    tone="var(--pos)"  icon="warehouse" />
              <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)' }} />
              <StockTotal label="In transit" value={stock.inTransitTotal} tone="var(--info)" icon="truck" />
            </div>
          </div>
          <div style={{ padding: '6px 6px 12px' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Warehouse</th>
                  <th style={{ textAlign: 'right' }}>On hand</th>
                  <th style={{ textAlign: 'right' }}>In transit</th>
                  <th style={{ textAlign: 'right', width: 90 }}>Lines</th>
                </tr>
              </thead>
              <tbody>
                {stock.rows.map(r => {
                  const isCurrent = r.whId === currentWhId;
                  const empty = r.onHand === 0 && r.inTransit === 0;
                  return (
                    <tr key={r.whId} style={{ opacity: empty ? 0.55 : 1 }}>
                      <td>
                        <div style={{
                          width: 26, height: 26, borderRadius: 7,
                          background: isCurrent ? 'var(--accent-soft)' : 'var(--bg-soft)',
                          color: isCurrent ? 'var(--accent-strong)' : 'var(--fg-subtle)',
                          display: 'grid', placeItems: 'center',
                          border: '1px solid ' + (isCurrent ? 'color-mix(in oklch, var(--accent) 35%, transparent)' : 'var(--border)'),
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
                        }}>{r.whShort}</div>
                      </td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {r.whShort}
                          {isCurrent && (
                            <span className="chip" style={{
                              marginLeft: 8, fontSize: 10,
                              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                              borderColor: 'color-mix(in oklch, var(--accent) 35%, transparent)',
                            }}>This item</span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{r.whRegion}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono" style={{ fontWeight: r.onHand > 0 ? 600 : 400, color: r.onHand > 0 ? 'var(--fg)' : 'var(--fg-subtle)' }}>
                          {r.onHand || '—'}
                        </span>
                        {r.reviewing > 0 && (
                          <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
                            {r.reviewing} reviewing
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {r.inTransit > 0 ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="truck" size={11} style={{ color: 'var(--info)' }} />
                            <span className="mono" style={{ fontWeight: 600, color: 'var(--info)' }}>{r.inTransit}</span>
                          </span>
                        ) : <span className="mono" style={{ color: 'var(--fg-subtle)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{r.lines || '—'}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{
              padding: '10px 16px 4px', display: 'flex',
              justifyContent: 'space-between', alignItems: 'center', gap: 10,
              borderTop: '1px solid var(--border)', marginTop: 6,
            }}>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="info" size={11} />
                Counts include Done and Reviewing items. In-transit shipments are tracked separately.
              </div>
              <button className="btn sm" disabled title="Backend endpoint not yet wired">
                <Icon name="arrow" size={12} /> Request transfer
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Linked sell orders
              <span className="chip muted" style={{ fontSize: 10.5 }}>{linkedSellOrders.length}</span>
            </div>
            <div className="card-sub">Orders that include this inventory line.</div>
          </div>
        </div>
        {linkedSellOrders.length === 0 ? (
          <div className="card-body" style={{ padding: 24, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
            No sell orders reference this inventory line yet.
          </div>
        ) : (
          <div style={{ padding: '4px 6px 10px' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Sell order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Unit price</th>
                  <th style={{ textAlign: 'right' }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {linkedSellOrders.map(so => (
                  <tr key={so.id}>
                    <td><span className="mono" style={{ fontSize: 12.5 }}>{so.id}</span></td>
                    <td style={{ fontSize: 13 }}>{so.customer_name ?? '—'}</td>
                    <td>
                      <span className={'chip ' + (
                        so.status === 'Done' ? 'pos'
                        : so.status === 'Draft' ? 'muted'
                        : 'accent'
                      )} style={{ fontSize: 10.5 }}>{so.status}</span>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{so.qty}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD(so.unit_price)}</td>
                    <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--fg-muted)' }}>
                      {relTime(so.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function StockTotal({ label, value, tone, icon }: {
  label: string;
  value: number;
  tone: string;
  icon: IconName;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon name={icon} size={13} style={{ color: tone }} />
      <div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</div>
        <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: tone, marginTop: 1 }}>{value}</div>
      </div>
    </div>
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
  item, draft, set, revenue, profit, margin, lossy, refMatch,
}: {
  item: DetailRow;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  revenue: number;
  profit: number;
  margin: number;
  lossy: boolean;
  refMatch: RefMatch | null;
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

      {refMatch && (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Market reference
                {refMatch.source && (
                  <span className="chip muted" style={{ fontSize: 10.5 }}>{refMatch.source}</span>
                )}
              </div>
              <div className="card-sub">Recent benchmarks for {refMatch.label}.</div>
            </div>
            <span className="chip" style={{ fontSize: 11 }}>
              <Icon name={refMatch.demand === 'high' ? 'trending' : refMatch.demand === 'low' ? 'trendDown' : 'minus'} size={11} />
              {' '}{refMatch.demand} demand
            </span>
          </div>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Target cost</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{fmtUSD(refMatch.target)}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                Range {fmtUSD0(refMatch.low)}–{fmtUSD0(refMatch.high)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Avg sell</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4, color: 'var(--pos)' }}>{fmtUSD(refMatch.avgSell)}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{refMatch.samples} sample lines</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Suggested price</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{fmtUSD(refMatch.avgSell)}</span>
                <button
                  className="btn sm"
                  onClick={() => set({ sellPrice: refMatch.avgSell.toFixed(2) })}
                  title="Apply suggested sell price"
                >Apply</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                Updated {fmtDate(refMatch.updated)}
              </div>
            </div>
          </div>
        </div>
      )}

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
  item, draft, revenue, profit, margin, internalNotes, setInternalNotes,
}: {
  item: DetailRow;
  draft: Draft;
  revenue: number;
  profit: number;
  margin: number;
  internalNotes: string;
  setInternalNotes: (v: string) => void;
}) {
  const sellable = draft.status === 'Reviewing' || draft.status === 'Done';
  return (
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
          <div className="card-title">Internal notes</div>
        </div>
        <div className="card-body">
          <textarea
            className="textarea"
            placeholder="Notes only visible to managers (RMA codes, defect details, etc.)…"
            value={internalNotes}
            onChange={(e) => setInternalNotes(e.target.value)}
            rows={4}
            style={{ resize: 'vertical', width: '100%', fontSize: 12.5 }}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Submitted by</div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SummaryRow label="Order" value={<span className="mono">{item.order_id}</span>} />
          <SummaryRow label="Warehouse" value={item.warehouse_short ?? '—'} />
          <SummaryRow label="Submitter" value={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="avatar sm">{item.user_initials}</span>
              {item.user_name.split(' ')[0]}
            </span>
          } />
          <SummaryRow label="Submitted" value={fmtDate(item.created_at)} />
        </div>
      </div>

      <div className="card danger-card">
        <div className="card-head">
          <div className="card-title" style={{ color: 'var(--neg)' }}>Danger zone</div>
        </div>
        <div className="card-body">
          <div className="danger-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>Archive item</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                Hidden from inventory; preserved in history.
              </div>
            </div>
            <button
              className="btn"
              style={{ color: 'var(--neg)', borderColor: 'color-mix(in oklch, var(--neg) 30%, var(--border))' }}
              onClick={() => alert('Archive flow not yet implemented')}
            >
              Archive
            </button>
          </div>
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
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
      <span style={{ color: 'var(--fg-subtle)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
