import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD0 } from '../../lib/format';
import type { Warehouse } from '../../lib/types';

// ─── Types ────────────────────────────────────────────────────────────────────
type Member = {
  id: string; email: string; name: string; initials: string;
  role: 'manager' | 'purchaser';
  team: string | null; phone: string | null; title: string | null;
  active: boolean; commission_rate: number;
  order_count: number; lifetime_profit: number;
};

type Customer = {
  id: string; name: string; short_name: string | null; contact: string | null;
  region: string | null; terms: string; credit_limit: number | null;
  tags: string[]; notes: string | null; active: boolean;
  lifetime_revenue: number; order_count: number;
};

type Stage = { id: string; label: string; short: string; tone: string; icon: string; description: string; position: number };

// ─── Shell ────────────────────────────────────────────────────────────────────
type SectionId = 'members' | 'customers' | 'warehouses' | 'workflow';

const SECTIONS: { id: SectionId; label: string; sub: string; icon: IconName }[] = [
  { id: 'members',    label: 'Members',    sub: 'Roles & commissions',     icon: 'user' },
  { id: 'customers',  label: 'Customers',  sub: 'Sell-side accounts',      icon: 'tag' },
  { id: 'warehouses', label: 'Warehouses', sub: 'Stock locations',         icon: 'warehouse' },
  { id: 'workflow',   label: 'Workflow',   sub: 'Order lifecycle stages',  icon: 'flag' },
];

type ToastFn = ((msg: string, kind?: 'success' | 'error') => void) | undefined;

export function DesktopSettings({ showToast }: { showToast?: (msg: string, kind?: 'success' | 'error') => void }) {
  const { t } = useT();
  const [section, setSection] = useState<SectionId>('members');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('settings')}</h1>
          <div className="page-sub">{t('settingsSub')}</div>
        </div>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={'settings-nav-item ' + (section === s.id ? 'active' : '')}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon"><Icon name={s.icon} size={14} /></span>
              <span className="settings-nav-text">
                <span className="settings-nav-label">{s.label}</span>
                <span className="settings-nav-sub">{s.sub}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {section === 'members'    && <MembersPanel    showToast={showToast} />}
          {section === 'customers'  && <CustomersPanel  showToast={showToast} />}
          {section === 'warehouses' && <WarehousesPanel showToast={showToast} />}
          {section === 'workflow'   && <WorkflowPanel   showToast={showToast} />}
        </div>
      </div>
    </>
  );
}

// Mock pending invites — until the backend grows an `invites` table, we keep
// these inline so the UI tells a complete story. Delete + remind are toasts.
type PendingInvite = { id: string; email: string; role: 'manager' | 'purchaser'; sentAt: string };
const PENDING_INVITES: PendingInvite[] = [
  { id: 'iv-1', email: 'sam.lee@recycleservers.io', role: 'purchaser', sentAt: '2 days ago' },
  { id: 'iv-2', email: 'amelia@recycleservers.io',  role: 'manager',   sentAt: '5 days ago' },
];

// ─── Members ──────────────────────────────────────────────────────────────────
function MembersPanel({ showToast }: { showToast: ToastFn }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [editing, setEditing] = useState<Member | null>(null);
  const [pending, setPending] = useState<PendingInvite[]>(PENDING_INVITES);
  const [showDangerConfirm, setShowDangerConfirm] = useState<null | 'transfer' | 'delete'>(null);

  const reload = () => api.get<{ items: Member[] }>('/api/members').then(r => setMembers(r.items));
  useEffect(() => { reload(); }, []);

  return (
    <>
      {/* Pending invites — UI mock; backend invites table is a follow-up */}
      {pending.length > 0 && (
        <div className="card pending-card">
          <div className="card-head">
            <div>
              <div className="card-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <Icon name="mail" size={14} /> Pending invites
                </span>
              </div>
              <div className="card-sub">{pending.length} invitation{pending.length === 1 ? '' : 's'} awaiting acceptance.</div>
            </div>
          </div>
          <div className="invite-list">
            {pending.map(inv => (
              <div key={inv.id} className="invite-row">
                <div className="invite-avatar muted"><Icon name="mail" size={14} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{inv.email}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                    {inv.role === 'manager' ? 'Manager' : 'Purchaser'} · invited {inv.sentAt}
                  </div>
                </div>
                <button
                  className="btn sm ghost"
                  onClick={() => showToast?.(`Reminder sent to ${inv.email}`)}
                >
                  Remind
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    setPending(p => p.filter(x => x.id !== inv.id));
                    showToast?.(`Invite to ${inv.email} revoked`);
                  }}
                >
                  <Icon name="x" size={11} /> Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Members</div>
          <div className="card-sub">{members.length} accounts in the workspace.</div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Team</th>
              <th className="num">Orders</th>
              <th className="num">Lifetime profit</th>
              <th className="num">Commission</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>
                  <div className="member-cell">
                    <div className="avatar md">{m.initials}</div>
                    <div>
                      <div style={{ fontWeight: 500 }}>{m.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{m.email}</div>
                    </div>
                  </div>
                </td>
                <td><span className={'chip ' + (m.role === 'manager' ? 'accent' : 'muted')}>{m.role}</span></td>
                <td className="muted">{m.team ?? '—'}</td>
                <td className="num mono">{m.order_count}</td>
                <td className="num mono pos">{fmtUSD0(m.lifetime_profit)}</td>
                <td className="num mono">{(m.commission_rate * 100).toFixed(1)}%</td>
                <td><span className={'chip dot ' + (m.active ? 'pos' : 'muted')}>{m.active ? 'Active' : 'Disabled'}</span></td>
                <td>
                  <button className="btn sm" onClick={() => setEditing(m)}>
                    <Icon name="edit" size={12} /> Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <MemberEditModal
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); showToast?.('Member updated'); }}
        />
      )}
    </div>

    {/* Danger zone — destructive workspace actions, gated by a confirm dialog */}
    <div className="card danger-card">
      <div className="card-head">
        <div>
          <div className="card-title" style={{ color: 'var(--neg)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Icon name="alert" size={14} /> Danger zone
            </span>
          </div>
          <div className="card-sub">Irreversible actions. Confirm carefully — these affect every workspace member.</div>
        </div>
      </div>
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="danger-row">
          <div>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Transfer workspace ownership</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              Hand off the manager role to another member. You will be demoted to purchaser.
            </div>
          </div>
          <button className="btn" onClick={() => setShowDangerConfirm('transfer')}>
            Transfer…
          </button>
        </div>
        <div className="danger-row">
          <div>
            <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--neg)' }}>Delete workspace</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              Permanently delete this workspace, all orders, inventory, and audit logs. This cannot be undone.
            </div>
          </div>
          <button
            className="btn"
            style={{ background: 'var(--neg-soft)', color: 'var(--neg)', borderColor: 'color-mix(in oklch, var(--neg) 30%, transparent)' }}
            onClick={() => setShowDangerConfirm('delete')}
          >
            Delete workspace…
          </button>
        </div>
      </div>
    </div>

    {showDangerConfirm && (
      <DangerConfirmDialog
        kind={showDangerConfirm}
        onCancel={() => setShowDangerConfirm(null)}
        onConfirm={() => {
          showToast?.(
            showDangerConfirm === 'transfer'
              ? 'Ownership transfer requires a backend endpoint — UI ready, follow-up.'
              : 'Workspace delete requires a backend endpoint — UI ready, follow-up.',
            'error',
          );
          setShowDangerConfirm(null);
        }}
      />
    )}
    </>
  );
}

// ─── Danger zone confirm dialog ──────────────────────────────────────────────
function DangerConfirmDialog({
  kind, onCancel, onConfirm,
}: {
  kind: 'transfer' | 'delete';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const PHRASE = kind === 'delete' ? 'DELETE WORKSPACE' : 'TRANSFER';
  const [phrase, setPhrase] = useState('');
  const matches = phrase.trim() === PHRASE;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="alert" size={18} />
            </div>
            <div>
              <div className="modal-title">
                {kind === 'delete' ? 'Delete this workspace?' : 'Transfer workspace ownership?'}
              </div>
              <div className="modal-sub">
                {kind === 'delete'
                  ? 'All orders, inventory, sell orders and audit logs will be permanently deleted. This cannot be undone.'
                  : 'You will be demoted to purchaser. Only the new owner can change roles, billing, or workspace settings.'}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="label">
              Type <span className="mono">{PHRASE}</span> to confirm
            </label>
            <input
              className="input mono"
              value={phrase}
              onChange={e => setPhrase(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn"
            style={{
              background: 'var(--neg)', color: 'white',
              borderColor: 'var(--neg)',
              opacity: matches ? 1 : 0.5,
            }}
            disabled={!matches}
            onClick={onConfirm}
          >
            {kind === 'delete' ? 'Delete workspace' : 'Transfer ownership'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberEditModal({ member, onClose, onSaved }: { member: Member; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Partial<Member>>({});
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'profile' | 'role' | 'security'>('profile');

  const v = <K extends keyof Member>(k: K): Member[K] =>
    (k in draft ? (draft as Member)[k] : member[k]);
  const set = <K extends keyof Member>(k: K, value: Member[K]) =>
    setDraft(prev => ({ ...prev, [k]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/members/${member.id}`, {
        name: draft.name, team: draft.team, phone: draft.phone, title: draft.title,
        role: draft.role, commissionRate: draft.commission_rate, active: draft.active,
        password: password || undefined,
      });
      onSaved();
    } finally { setSaving(false); }
  };

  const role = String(v('role'));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell member-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head member-edit-head">
          <div>
            <div className="modal-title">Edit member</div>
            <div className="modal-sub">{member.email}</div>
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        <div className="member-edit-tabs">
          <button className={'member-edit-tab ' + (tab === 'profile' ? 'active' : '')} onClick={() => setTab('profile')}>
            <Icon name="user" size={12} /> Profile
          </button>
          <button className={'member-edit-tab ' + (tab === 'role' ? 'active' : '')} onClick={() => setTab('role')}>
            <Icon name="shield" size={12} /> Role
          </button>
          <button className={'member-edit-tab ' + (tab === 'security' ? 'active' : '')} onClick={() => setTab('security')}>
            <Icon name="lock" size={12} /> Security
          </button>
        </div>

        <div className="modal-body member-edit-body">
          {tab === 'profile' && (
            <>
              <div className="field-row">
                <div className="field">
                  <label className="label">Name</label>
                  <input className="input" value={String(v('name'))} onChange={e => set('name', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Title</label>
                  <input className="input" value={String(v('title') ?? '')} onChange={e => set('title', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Team</label>
                  <input className="input" value={String(v('team') ?? '')} onChange={e => set('team', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Phone</label>
                  <input className="input" value={String(v('phone') ?? '')} onChange={e => set('phone', e.target.value)} />
                </div>
              </div>
              <div className="toggle-row">
                <span>Account active</span>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(v('active'))} onChange={e => set('active', e.target.checked)} />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </div>
            </>
          )}

          {tab === 'role' && (
            <>
              <div className="role-picker">
                {(['manager', 'purchaser'] as const).map(r => (
                  <label key={r} className={'role-card ' + (role === r ? 'active' : '')}>
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={role === r}
                      onChange={() => set('role', r)}
                    />
                    <div className="role-card-body">
                      <div className="role-card-title">
                        {r === 'manager' ? 'Manager' : 'Purchaser'}
                        {role === r && <span className="chip accent" style={{ fontSize: 10 }}>Current</span>}
                      </div>
                      <div className="role-card-desc">
                        {r === 'manager'
                          ? 'Full access — manages team, prices items, edits any order.'
                          : 'Submits new buy orders; sees own activity only. No cost/profit visibility.'}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="field">
                <label className="label">Commission rate</label>
                <input
                  className="input mono"
                  type="number"
                  step="0.005"
                  min={0}
                  max={1}
                  value={Number(v('commission_rate'))}
                  onChange={e => set('commission_rate', parseFloat(e.target.value) || 0)}
                />
                <div className="help">Decimal share of gross profit ({(Number(v('commission_rate')) * 100).toFixed(1)}%).</div>
              </div>
            </>
          )}

          {tab === 'security' && (
            <>
              <div className="security-card">
                <div className="security-card-head">
                  <div>
                    <div className="security-card-title">Password reset</div>
                    <div className="security-card-sub">Enter a new password to force re-authentication on next sign-in.</div>
                  </div>
                </div>
                <div className="field">
                  <label className="label">New password</label>
                  <div className="pw-input">
                    <input
                      className="input"
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      placeholder="Leave blank to keep current"
                      onChange={e => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="pw-toggle"
                      onClick={() => setShowPw(s => !s)}
                      tabIndex={-1}
                    >
                      <Icon name={showPw ? 'eye' : 'eye'} size={12} />
                      {showPw ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <PasswordMeter password={password} />
                  <div className="help">Leave empty to skip — saving without a value will not touch the password.</div>
                </div>
              </div>

              <div className="security-card">
                <div className="security-card-head">
                  <div>
                    <div className="security-card-title">Active sessions</div>
                    <div className="security-card-sub">Devices currently signed in as this member.</div>
                  </div>
                </div>
                <div className="security-detail">
                  <Icon name="check" size={13} />
                  <span>Last seen <strong>{member.name.split(' ')[0]}</strong> from a Chrome browser on macOS — 14 minutes ago.</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot member-edit-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Customers ────────────────────────────────────────────────────────────────
function CustomersPanel({ showToast }: { showToast: ToastFn }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => api.get<{ items: Customer[] }>('/api/customers').then(r => setCustomers(r.items));
  useEffect(() => { reload(); }, []);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Customers</div>
          <div className="card-sub">{customers.length} accounts.</div>
        </div>
        <button className="btn primary sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={12} /> New customer
        </button>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Region</th>
              <th>Terms</th>
              <th className="num">Lifetime revenue</th>
              <th className="num">Orders</th>
              <th>Tags</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {customers.map(c => (
              <tr key={c.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{c.contact ?? '—'}</div>
                </td>
                <td className="muted">{c.region ?? '—'}</td>
                <td className="muted">{c.terms}</td>
                <td className="num mono">{fmtUSD0(c.lifetime_revenue)}</td>
                <td className="num mono">{c.order_count}</td>
                <td>
                  {(c.tags ?? []).map(tag => (
                    <span key={tag} className="chip muted" style={{ marginRight: 4, fontSize: 10 }}>{tag}</span>
                  ))}
                </td>
                <td><span className={'chip dot ' + (c.active ? 'pos' : 'muted')}>{c.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button className="btn sm" onClick={() => setEditing(c)}>
                    <Icon name="edit" size={12} /> Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <CustomerEditModal
          customer={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); showToast?.('Customer saved'); }}
        />
      )}
    </div>
  );
}

function CustomerEditModal({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !customer;
  const [draft, setDraft] = useState<Partial<Customer>>(customer ?? { terms: 'Net 30', active: true, tags: [] });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Customer>(k: K, value: Customer[K]) =>
    setDraft(prev => ({ ...prev, [k]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name, shortName: draft.short_name, contact: draft.contact,
        region: draft.region, terms: draft.terms, creditLimit: draft.credit_limit,
        tags: draft.tags, notes: draft.notes, active: draft.active,
      };
      if (isNew) await api.post('/api/customers', body);
      else       await api.patch(`/api/customers/${customer!.id}`, body);
      onSaved();
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
              <label className="label">Contact</label>
              <input className="input" value={String(draft.contact ?? '')} onChange={e => set('contact', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Region</label>
              <input className="input" value={String(draft.region ?? '')} onChange={e => set('region', e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Terms</label>
              <select className="select" value={String(draft.terms ?? 'Net 30')} onChange={e => set('terms', e.target.value)}>
                <option>Prepay</option><option>Net 7</option><option>Net 15</option><option>Net 30</option><option>Net 60</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Credit limit (USD)</label>
              <input
                className="input mono"
                type="number"
                min={0}
                value={Number(draft.credit_limit ?? 0)}
                onChange={e => set('credit_limit', parseFloat(e.target.value) || 0)}
              />
            </div>
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

// ─── Warehouses ───────────────────────────────────────────────────────────────
function WarehousesPanel({ showToast: _showToast }: { showToast: ToastFn }) {
  const [whs, setWhs] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses').then(r => setWhs(r.items));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap)' }}>
      <div className="settings-header">
        <div>
          <div className="card-title" style={{ fontSize: 14 }}>Warehouses</div>
          <div className="card-sub">{whs.length} stock locations. Editing is read-only for now.</div>
        </div>
      </div>

      <div className="wh-grid">
        {whs.map(w => (
          <div key={w.id} className="card wh-card">
            <div className="wh-card-head">
              <div className="wh-card-id">
                <div className="wh-icon"><Icon name="warehouse" size={16} /></div>
                <div>
                  <div className="wh-card-name">{w.name ?? w.short}</div>
                  <div className="wh-card-region">{w.region}</div>
                </div>
              </div>
              <span className="chip muted" style={{ fontSize: 10.5 }}>
                <span className="mono">{w.short}</span>
              </span>
            </div>
            <div className="wh-card-body">
              <div className="wh-row">
                <span className="wh-row-label">Short code</span>
                <span className="wh-row-val mono">{w.short}</span>
              </div>
              <div className="wh-row">
                <span className="wh-row-label">Region</span>
                <span className="wh-row-val">{w.region}</span>
              </div>
              <div className="wh-row">
                <span className="wh-row-label">ID</span>
                <span className="wh-row-val mono" style={{ fontSize: 11 }}>{w.id}</span>
              </div>
            </div>
            <div className="wh-card-foot">
              <div className="toggle-row" title="Editing warehouses requires a PATCH /api/warehouses endpoint (not yet implemented).">
                <span style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>Read-only — wire up backend to enable</span>
                <label className="toggle">
                  <input type="checkbox" disabled />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                </label>
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          className="card wh-add"
          onClick={() => _showToast?.('New warehouse — endpoint not yet implemented', 'success')}
        >
          <div className="wh-add-icon"><Icon name="plus" size={18} /></div>
          <div className="wh-add-text">
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>Add warehouse</div>
            <div className="help">Requires POST /api/warehouses</div>
          </div>
        </button>
      </div>
    </div>
  );
}

// ─── Workflow ─────────────────────────────────────────────────────────────────
function WorkflowPanel({ showToast }: { showToast: ToastFn }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [draft, setDraft] = useState<Stage[] | null>(null);

  useEffect(() => {
    api.get<{ stages: Stage[] }>('/api/workflow').then(r => setStages(r.stages));
  }, []);

  const editing = draft ?? stages;
  const setOne = (i: number, patch: Partial<Stage>) =>
    setDraft(prev => (prev ?? stages).map((s, idx) => idx === i ? { ...s, ...patch } : s));

  const save = async () => {
    if (!draft) return;
    await api.patch('/api/workflow', { stages: draft });
    setStages(draft);
    setDraft(null);
    showToast?.('Workflow saved');
  };

  const TONE_HEX: Record<string, string> = {
    muted:  'var(--fg-subtle)',
    info:   'var(--info)',
    warn:   'var(--warn)',
    accent: 'var(--accent)',
    pos:    'var(--pos)',
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Workflow stages</div>
          <div className="card-sub">Edit the lifecycle stages an order moves through.</div>
        </div>
        {draft && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => setDraft(null)}>Discard</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        )}
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 8 }}>
        {editing.map((s, i) => {
          const dotStyle: CSSProperties = {
            width: 10, height: 10, borderRadius: '50%',
            background: TONE_HEX[s.tone] ?? 'var(--fg-subtle)',
          };
          return (
            <div
              key={s.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr 1fr 120px 1.4fr',
                gap: 10, alignItems: 'center',
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-elev)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="lb-rank">{i + 1}</span>
              </div>
              <div className="field">
                <label className="label">Label</label>
                <input className="input" value={s.label} onChange={e => setOne(i, { label: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Short</label>
                <input className="input mono" value={s.short} onChange={e => setOne(i, { short: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Tone</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={dotStyle} />
                  <select className="select" value={s.tone} onChange={e => setOne(i, { tone: e.target.value })}>
                    {['muted', 'info', 'warn', 'accent', 'pos'].map(x => <option key={x}>{x}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="label">Description</label>
                <input className="input" value={s.description} onChange={e => setOne(i, { description: e.target.value })} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Password meter ──────────────────────────────────────────────────────────
// Lightweight strength heuristic: counts length, mixed case, digits, symbols.
// Renders 4 segments + a label that lights up as the password grows stronger.
function PasswordMeter({ password }: { password: string }) {
  if (!password) return null;
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const score = checks.filter(Boolean).length;
  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'];
  const colors = ['var(--neg)', 'var(--neg)', 'var(--warn)', 'var(--accent)', 'var(--pos)'];
  const label = password.length < 6 ? labels[0] : labels[score];
  const color = password.length < 6 ? colors[0] : colors[score];

  return (
    <div className="pw-meter">
      <div className="pw-meter-track">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className="pw-meter-seg"
            style={{ background: i < score ? color : 'var(--border)' }}
          />
        ))}
      </div>
      <span className="pw-meter-label" style={{ color }}>{label}</span>
    </div>
  );
}
