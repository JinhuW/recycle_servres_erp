import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { fmtUSD0 } from '../../../lib/format';
import { TableSkeleton } from '../../../components/Skeleton';
import { SettingsHeader, StatTile, type Customer, type ToastFn } from './_shared';
import { ConfirmDialog } from './dialogs';
import { useT } from '../../../lib/i18n';

// ─── Customers ────────────────────────────────────────────────────────────────
// Customer status is real now (the `active` flag → Active/Archived). Outstanding
type CustomerStatus = 'Active' | 'Archived';
const STATUS_CHIP: Record<CustomerStatus, 'pos' | 'muted'> = {
  Active: 'pos', Archived: 'muted',
};
// All real now: status from the `active` flag, outstanding A/R and last-order
// date from the customers endpoint (sell-order rollups).
function deriveCustomerSeed(c: Customer) {
  const status: CustomerStatus = c.active ? 'Active' : 'Archived';
  const lastDays = c.last_order
    ? Math.max(0, Math.round((Date.now() - new Date(c.last_order).getTime()) / 86_400_000))
    : null;
  return { status, lastDays };
}

export function CustomersPanel({ showToast }: { showToast: ToastFn }) {
  const { lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CustomerStatus>('Active');
  const [archiving, setArchiving] = useState<Customer | null>(null);

  const reload = () => api.get<{ items: Customer[] }>('/api/customers')
    .then(r => setCustomers(r.items))
    .catch(handleFetchError)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const archive = async (c: Customer) => {
    try {
      await api.patch(`/api/customers/${c.id}`, { active: !c.active });
      setArchiving(null);
      reload();
      showToast?.(c.active ? `Archived ${c.name}` : `Restored ${c.name}`);
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : 'Failed to update customer', 'error');
    }
  };

  const enriched = useMemo(
    () => customers.map(c => ({ ...c, ...deriveCustomerSeed(c) })),
    [customers],
  );

  const filtered = useMemo(() => enriched.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.name.toLowerCase().includes(q)
        && !(c.short_name ?? '').toLowerCase().includes(q)
        && !(c.contact_name ?? '').toLowerCase().includes(q)
        && !(c.contact_email ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  }), [enriched, search, statusFilter]);

  const counts = {
    all: enriched.length,
    Active: enriched.filter(c => c.status === 'Active').length,
    Archived: enriched.filter(c => c.status === 'Archived').length,
  };
  const totalLtv = enriched.reduce((s, c) => s + (c.lifetime_revenue || 0), 0);
  const totalOutstanding = enriched.reduce((s, c) => s + (c.outstanding || 0), 0);

  return (
    <>
      <SettingsHeader
        title="Customers"
        sub={`${counts.Active} active · ${enriched.length} total · $${totalLtv.toLocaleString()} lifetime revenue`}
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> Add customer
          </button>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 'var(--gap)' }}>
        <StatTile
          label="Active accounts"
          value={counts.Active}
          sub={`${counts.Archived} archived · ${enriched.length} total`}
          icon="user"
        />
        <StatTile
          label="Lifetime revenue"
          value={`$${(totalLtv / 1000).toFixed(0)}k`}
          sub="All customers"
          icon="dollar"
          tone="pos"
        />
        <StatTile
          label="Outstanding A/R"
          value={`$${totalOutstanding.toLocaleString()}`}
          sub={`${enriched.filter(c => c.outstanding > 0).length} accounts with balance`}
          icon="cash"
          tone={totalOutstanding > 20000 ? 'warn' : 'muted'}
        />
      </div>

      <div className="settings-row">
        <div className="seg">
          {([
            { v: 'Active',   label: 'Active',   count: counts.Active },
            { v: 'Archived', label: 'Archived', count: counts.Archived },
            { v: 'all',      label: 'All',      count: counts.all },
          ] as const).map(o => (
            <button key={o.v} className={statusFilter === o.v ? 'active' : ''} onClick={() => setStatusFilter(o.v)}>
              {o.label} <span style={{ opacity: 0.55, marginLeft: 4 }}>{o.count}</span>
            </button>
          ))}
        </div>
        <div className="settings-search">
          <Icon name="search" size={13} />
          <input
            type="text"
            placeholder="Search company or contact…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        {!loadedOnce ? (
          <TableSkeleton rows={6} cols={7} />
        ) : (
        <table className="data-table members-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Region</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Lifetime</th>
              <th style={{ textAlign: 'right' }}>Outstanding</th>
              <th>Last order</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const tags = c.tags ?? [];
              const headlineTag =
                tags.includes('VIP') ? { label: 'VIP', tone: 'pos' as const }
                : tags.includes('At risk') ? { label: 'At risk', tone: 'warn' as const }
                : tags.includes('New') ? { label: 'New', tone: 'info' as const }
                : null;
              return (
                <tr key={c.id}>
                  <td>
                    <div className="member-cell">
                      <div className="avatar md" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
                        {(c.short_name ?? c.name).slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {c.name}
                          {headlineTag && (
                            <span className={'chip ' + headlineTag.tone} style={{ fontSize: 10 }}>{headlineTag.label}</span>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{c.contact_name ?? c.contact_email ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td><span className="chip muted">{c.region ?? '—'}</span></td>
                  <td><span className={'chip ' + STATUS_CHIP[c.status]}>{c.status}</span></td>
                  <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD0(c.lifetime_revenue || 0, locale)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {c.outstanding > 0
                      ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>${c.outstanding.toLocaleString()}</span>
                      : <span style={{ color: 'var(--fg-subtle)' }}>—</span>}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                    {c.order_count > 0
                      ? `${c.lastDays != null ? `${c.lastDays}d ago · ` : ''}${c.order_count} orders`
                      : <span style={{ color: 'var(--fg-subtle)' }}>No orders</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      <button className="btn icon sm ghost" title="Edit" onClick={() => setEditing(c)}>
                        <Icon name="edit" size={13} />
                      </button>
                      <button
                        className="btn icon sm ghost"
                        title={c.active ? 'Archive' : 'Restore'}
                        style={{ color: c.active ? 'var(--neg)' : 'var(--fg-muted)' }}
                        onClick={() => setArchiving(c)}
                      >
                        <Icon name={c.active ? 'trash' : 'refresh'} size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
        {loadedOnce && filtered.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
            No customers match your filters.
          </div>
        )}
      </div>

      {(editing || creating) && (
        <CustomerEditModal
          customer={editing}
          showToast={showToast}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); showToast?.('Customer saved'); }}
        />
      )}

      {archiving && (
        <ConfirmDialog
          title={archiving.active ? `Archive ${archiving.name}?` : `Restore ${archiving.name}?`}
          message={archiving.active
            ? 'They will be hidden from new sell-order pickers but their history is preserved.'
            : 'They will appear in the customer picker again.'}
          confirmLabel={archiving.active ? 'Archive' : 'Restore'}
          danger={archiving.active}
          onCancel={() => setArchiving(null)}
          onConfirm={() => archive(archiving)}
        />
      )}
    </>
  );
}

function CustomerEditModal({ customer, showToast, onClose, onSaved }: { customer: Customer | null; showToast: ToastFn; onClose: () => void; onSaved: () => void }) {
  const isNew = !customer;
  const [draft, setDraft] = useState<Partial<Customer>>(customer ?? { active: true, tags: [] });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Customer>(k: K, value: Customer[K]) =>
    setDraft(prev => ({ ...prev, [k]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name, shortName: draft.short_name,
        contactName: draft.contact_name, contactEmail: draft.contact_email,
        contactPhone: draft.contact_phone, address: draft.address,
        country: draft.country, region: draft.region,
        tags: draft.tags, notes: draft.notes, active: draft.active,
      };
      if (isNew) await api.post('/api/customers', body);
      else       await api.patch(`/api/customers/${customer!.id}`, body);
      onSaved();
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : 'Failed to save customer', 'error');
    } finally { setSaving(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 580 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{isNew ? 'New customer' : 'Edit customer'}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={String(draft.name ?? '')} onChange={e => set('name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Short name</label>
              <input className="input" value={String(draft.short_name ?? '')} onChange={e => set('short_name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Region</label>
              <input className="input" value={String(draft.region ?? '')} onChange={e => set('region', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Country</label>
              <input className="input" value={String(draft.country ?? '')} onChange={e => set('country', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact name</label>
              <input className="input" value={String(draft.contact_name ?? '')} onChange={e => set('contact_name', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact email</label>
              <input className="input" value={String(draft.contact_email ?? '')} onChange={e => set('contact_email', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Contact phone</label>
              <input className="input" value={String(draft.contact_phone ?? '')} onChange={e => set('contact_phone', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label">Address</label>
            <textarea className="input" rows={2} value={String(draft.address ?? '')} onChange={e => set('address', e.target.value)} />
          </div>
          <div className="field">
            <label className="label">Notes</label>
            <textarea className="input" rows={3} value={String(draft.notes ?? '')} onChange={e => set('notes', e.target.value)} />
          </div>
          <div className="toggle-row">
            <span>Active</span>
            <label className="toggle">
              <input type="checkbox" checked={Boolean(draft.active ?? true)} onChange={e => set('active', e.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving || !draft.name}>{saving ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
