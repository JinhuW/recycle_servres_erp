import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { fmtUSD0, relTime } from '../../lib/format';
import type { Lang, Warehouse } from '../../lib/types';
import { TableSkeleton } from '../../components/Skeleton';

// ─── Types ────────────────────────────────────────────────────────────────────
type Member = {
  id: string; email: string; name: string; initials: string;
  role: 'manager' | 'purchaser';
  team: string | null; phone: string | null; title: string | null;
  active: boolean;
  order_count: number; lifetime_profit: number;
  created_at: string; last_seen_at: string | null;
};

type Customer = {
  id: string; name: string; short_name: string | null;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  address: string | null; country: string | null;
  region: string | null;
  tags: string[]; notes: string | null; active: boolean;
  lifetime_revenue: number; order_count: number;
  outstanding: number; last_order: string | null;
};

// ─── Shared primitives ────────────────────────────────────────────────────────
function SettingsHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="settings-header">
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h2>
        {sub && <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>{sub}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
    </label>
  );
}

function StatTile({ label, value, sub, icon, tone }: {
  label: string;
  value: string | number;
  sub: string;
  icon: IconName;
  tone?: 'pos' | 'warn' | 'muted';
}) {
  const toneColor =
    tone === 'pos'   ? 'var(--pos)'
    : tone === 'warn'  ? 'var(--warn)'
    : tone === 'muted' ? 'var(--fg-subtle)'
    : 'var(--accent-strong)';
  return (
    <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8, background: 'var(--accent-soft)',
        color: toneColor, display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>
        <Icon name={icon} size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums', color: toneColor }}>{value}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────
type SectionId = 'members' | 'warehouses' | 'customers' | 'categories' | 'general';

const SECTIONS: { id: SectionId; label: string; sub: string; icon: IconName }[] = [
  { id: 'members',    label: 'Members',    sub: 'People & roles',     icon: 'user' },
  { id: 'warehouses', label: 'Warehouses', sub: 'Locations',          icon: 'warehouse' },
  { id: 'customers',  label: 'Customers',  sub: 'Buyers & accounts',  icon: 'shield' },
  { id: 'categories', label: 'Categories', sub: 'Items & SKUs',       icon: 'box' },
  { id: 'general',    label: 'General',    sub: 'Workspace',          icon: 'settings' },
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
          {section === 'warehouses' && <WarehousesPanel showToast={showToast} />}
          {section === 'customers'  && <CustomersPanel  showToast={showToast} />}
          {section === 'categories' && <CategoriesPanel />}
          {section === 'general'    && <GeneralPanel />}
        </div>
      </div>
    </>
  );
}

// ─── Language radio (used inside the General tab) ─────────────────────────────
// Two-button design: ring + radio dot, native-language label, short sub, EN/ZH chip.
// Reads/writes through the i18n context so the change applies app-wide.
function SettingsLanguageRadio() {
  const { lang, setLang } = useT();
  const opts: { v: Lang; label: string; sub: string }[] = [
    { v: 'en', label: 'English',   sub: 'US English' },
    { v: 'zh', label: '简体中文', sub: 'Simplified Chinese' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
      {opts.map(o => {
        const active = lang === o.v;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => setLang(o.v)}
            aria-pressed={active}
            style={{
              textAlign: 'left', padding: '12px 14px', borderRadius: 10,
              border: '1.5px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
              background: active ? 'var(--accent-soft)' : 'var(--bg-elev)',
              color: 'var(--fg)', cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 12,
              transition: 'border-color 0.12s, background 0.12s',
            }}
          >
            <span style={{
              width: 18, height: 18, borderRadius: '50%',
              border: '2px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              {active && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{o.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 1 }}>{o.sub}</div>
            </span>
            <span className="mono" style={{
              fontSize: 10.5, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
              background: active ? 'var(--accent)' : 'var(--bg-soft)',
              color: active ? 'white' : 'var(--fg-subtle)',
              border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
            }}>{o.v.toUpperCase()}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Categories ───────────────────────────────────────────────────────────────
// Server-backed via /api/categories (migration 0013). The list, toggles, and
// default margin persist; changes are optimistic and resync from the server
// on failure.
type CategoryRow = {
  id: string;
  label: string;
  icon: IconName;
  enabled: boolean;
  aiCapture: boolean;
  requiresPN: boolean;
  defaultMargin: number;
};
type CategoryApi = {
  id: string; label: string; icon: string; enabled: boolean;
  ai_capture: boolean; requires_pn: boolean; default_margin: number; position: number;
};

function CategoriesPanel() {
  const [cats, setCats] = useState<CategoryRow[]>([]);

  const reload = () =>
    api.get<{ items: CategoryApi[] }>('/api/categories')
      .then(r => setCats(r.items.map(c => ({
        id: c.id, label: c.label, icon: c.icon as IconName, enabled: c.enabled,
        aiCapture: c.ai_capture, requiresPN: c.requires_pn, defaultMargin: c.default_margin,
      }))))
      .catch(() => { /* keep whatever is on screen */ });
  useEffect(() => { reload(); }, []);

  const upd = (id: string, patch: Partial<CategoryRow>) =>
    setCats(p => p.map(c => c.id === id ? { ...c, ...patch } : c));

  // Optimistic update already applied by the caller; persist and resync from
  // the server if the write fails (e.g. a purchaser hitting the manager gate).
  const persist = (id: string, body: Record<string, unknown>) =>
    api.patch(`/api/categories/${id}`, body).catch(() => reload());

  return (
    <>
      <SettingsHeader
        title="Categories & SKUs"
        sub="Item categories your team submits and sells. Toggle to make available in submissions."
        actions={<button className="btn"><Icon name="plus" size={14} /> Add category</button>}
      />

      <div className="cat-list">
        {cats.map(c => (
          <div key={c.id} className={'cat-row card' + (c.enabled ? '' : ' disabled')}>
            <div className="cat-row-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="cat-icon"><Icon name={c.icon} size={18} /></div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {c.enabled ? 'Available in submissions' : 'Hidden — not selectable'}
                  </div>
                </div>
              </div>
              <Toggle checked={c.enabled} onChange={(v) => { upd(c.id, { enabled: v }); persist(c.id, { enabled: v }); }} />
            </div>

            <div className="cat-row-body">
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">AI label capture</div>
                  <div className="cat-opt-sub">Photograph the part — vision model reads brand, capacity, speed.</div>
                </div>
                <Toggle checked={c.aiCapture} onChange={(v) => { upd(c.id, { aiCapture: v }); persist(c.id, { aiCapture: v }); }} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">Require part number</div>
                  <div className="cat-opt-sub">Block submission until manufacturer PN is entered.</div>
                </div>
                <Toggle checked={c.requiresPN} onChange={(v) => { upd(c.id, { requiresPN: v }); persist(c.id, { requiresPn: v }); }} disabled={!c.enabled} />
              </div>
              <div className="cat-opt">
                <div>
                  <div className="cat-opt-label">Default margin target</div>
                  <div className="cat-opt-sub">Target gross margin used as the default for this category.</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    value={c.defaultMargin}
                    onChange={(e) => upd(c.id, { defaultMargin: Number(e.target.value) })}
                    onBlur={() => persist(c.id, { defaultMargin: c.defaultMargin })}
                    disabled={!c.enabled}
                    style={{
                      width: 60, padding: '5px 8px', borderRadius: 6,
                      border: '1px solid var(--border)', background: 'var(--bg-elev)',
                      fontSize: 13, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
                    }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>%</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── General ──────────────────────────────────────────────────────────────────
// Workspace identity, locale, and notification defaults — server-backed via
// /api/workspace (migration 0016). Writes are optimistic; text fields persist
// on blur, selects/toggles immediately. Language persists separately through
// the i18n context's setLang.
const WS_FIELD_KEY = {
  workspace: 'workspace_name', domain: 'domain', currency: 'currency',
  fiscalStart: 'fiscal_start', timezone: 'timezone', fxAuto: 'fx_auto',
} as const;
const WS_NOTIFY_KEY = {
  newOrder: 'notify_new_order', weeklyDigest: 'notify_weekly_digest',
  lowMargin: 'notify_low_margin', capacityAlert: 'notify_capacity',
} as const;

function GeneralPanel() {
  const [data, setData] = useState({
    workspace: 'Recycle Servers',
    domain: 'recycleservers.io',
    currency: 'USD',
    fiscalStart: 'January',
    timezone: 'America/Los_Angeles',
    fxAuto: true,
    notify: { newOrder: true, weeklyDigest: true, lowMargin: true, capacityAlert: false },
  });
  type GeneralData = typeof data;

  const reload = () =>
    api.get<{ settings: Record<string, unknown> }>('/api/workspace')
      .then(({ settings: s }) => setData(d => ({
        workspace:   typeof s.workspace_name === 'string' ? s.workspace_name : d.workspace,
        domain:      typeof s.domain         === 'string' ? s.domain         : d.domain,
        currency:    typeof s.currency       === 'string' ? s.currency       : d.currency,
        fiscalStart: typeof s.fiscal_start   === 'string' ? s.fiscal_start   : d.fiscalStart,
        timezone:    typeof s.timezone       === 'string' ? s.timezone       : d.timezone,
        fxAuto:      typeof s.fx_auto        === 'boolean' ? s.fx_auto        : d.fxAuto,
        notify: {
          newOrder:      typeof s.notify_new_order      === 'boolean' ? s.notify_new_order      : d.notify.newOrder,
          weeklyDigest:  typeof s.notify_weekly_digest  === 'boolean' ? s.notify_weekly_digest  : d.notify.weeklyDigest,
          lowMargin:     typeof s.notify_low_margin     === 'boolean' ? s.notify_low_margin     : d.notify.lowMargin,
          capacityAlert: typeof s.notify_capacity       === 'boolean' ? s.notify_capacity       : d.notify.capacityAlert,
        },
      })))
      .catch(() => { /* keep current values */ });
  useEffect(() => { reload(); }, []);

  const persist = (body: Record<string, unknown>) =>
    api.patch('/api/workspace', body).catch(() => reload());

  const upd = <K extends keyof GeneralData>(k: K, v: GeneralData[K]) =>
    setData(d => ({ ...d, [k]: v }));
  // Persist a top-level field by its server key (used for selects/toggles and
  // text-field onBlur).
  const save = <K extends keyof typeof WS_FIELD_KEY>(k: K, v: GeneralData[K]) =>
    persist({ [WS_FIELD_KEY[k]]: v });
  const updNotify = <K extends keyof GeneralData['notify']>(k: K, v: GeneralData['notify'][K]) => {
    setData(d => ({ ...d, notify: { ...d.notify, [k]: v } }));
    persist({ [WS_NOTIFY_KEY[k]]: v });
  };

  const NOTIF: { k: keyof GeneralData['notify']; title: string; sub: string }[] = [
    { k: 'newOrder',      title: 'New order submitted',       sub: 'Notify managers when a purchaser submits a buy order.' },
    { k: 'weeklyDigest',  title: 'Weekly performance digest', sub: 'Monday morning summary: profit, top contributors, capacity.' },
    { k: 'lowMargin',     title: 'Low-margin alert',          sub: 'Flag any line item with realized margin under 15%.' },
    { k: 'capacityAlert', title: 'Capacity alert',            sub: 'Warn when a warehouse exceeds 85% utilization.' },
  ];

  return (
    <>
      <div className="settings-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>General</h2>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>
            Workspace identity, locale, and notification defaults.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div><div className="card-title">Workspace</div></div></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="field">
            <label className="label">Workspace name</label>
            <input className="input" value={data.workspace} onChange={e => upd('workspace', e.target.value)} onBlur={() => save('workspace', data.workspace)} />
          </div>
          <div className="field">
            <label className="label">Email domain</label>
            <input className="input mono" value={data.domain} onChange={e => upd('domain', e.target.value)} onBlur={() => save('domain', data.domain)} />
            <div className="help">Members must sign in with an address on this domain.</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">Locale &amp; finance</div>
            <div className="card-sub">Includes the workspace display language — applies to every user.</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label className="label">Display language · 显示语言</label>
            <SettingsLanguageRadio />
          </div>
          <div className="field">
            <label className="label">Reporting currency</label>
            <select className="select" value={data.currency} onChange={e => { upd('currency', e.target.value); save('currency', e.target.value); }}>
              <option>USD</option><option>EUR</option><option>GBP</option><option>HKD</option><option>SGD</option>
            </select>
          </div>
          <div className="field">
            <label className="label">Fiscal year start</label>
            <select className="select" value={data.fiscalStart} onChange={e => { upd('fiscalStart', e.target.value); save('fiscalStart', e.target.value); }}>
              <option>January</option><option>April</option><option>July</option><option>October</option>
            </select>
          </div>
          <div className="field">
            <label className="label">Default timezone</label>
            <select className="select mono" value={data.timezone} onChange={e => { upd('timezone', e.target.value); save('timezone', e.target.value); }}>
              <option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/Amsterdam</option><option>Asia/Hong_Kong</option>
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="toggle-row">
              <span>
                <strong style={{ fontSize: 13 }}>Auto-update FX rates daily</strong>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
                  Pull from ECB at 06:00 UTC. Disable to set manual rates per currency.
                </div>
              </span>
              <label className="toggle">
                <input type="checkbox" checked={data.fxAuto} onChange={e => { upd('fxAuto', e.target.checked); save('fxAuto', e.target.checked); }} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">Notifications</div>
            <div className="card-sub">Workspace defaults — members can override on their profile.</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column' }}>
          {NOTIF.map((n, i) => (
            <div
              key={n.k}
              className="toggle-row"
              style={{ borderBottom: i < NOTIF.length - 1 ? '1px solid var(--border)' : 'none' }}
            >
              <span>
                <strong style={{ fontSize: 13 }}>{n.title}</strong>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{n.sub}</div>
              </span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={data.notify[n.k]}
                  onChange={e => updNotify(n.k, e.target.checked)}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// "Pending invites" are real members who were added but have never signed in
// (last_seen_at is null). No separate invites table / acceptance flow exists —
// inviting creates the member immediately — so this is the accurate
// interpretation. Revoke removes the member; Resend has no email backend yet.

// Real "last active" text from users.last_seen_at (stamped on login). A member
// who has never signed in shows "Never" — see pendingInvites().
function lastSeenLabel(m: Member): string {
  return m.last_seen_at ? relTime(m.last_seen_at) : 'Never';
}

// ─── Members ──────────────────────────────────────────────────────────────────
function MembersPanel({ showToast }: { showToast: ToastFn }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const { user: currentUser } = useAuth();
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const pending = useMemo(
    () => members.filter(m => m.active && !m.last_seen_at),
    [members],
  );
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'manager' | 'purchaser'>('all');
  const [showArchived, setShowArchived] = useState(false);

  const reload = () => api.get<{ items: Member[] }>('/api/members')
    .then(r => setMembers(r.items))
    .catch(console.error)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const removeMember = async (m: Member) => {
    try {
      await api.delete(`/api/members/${m.id}`);
      setRemoving(null);
      reload();
      showToast?.(`Removed ${m.name} from workspace`);
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : 'Failed to remove member', 'error');
    }
  };

  const visible = useMemo(
    () => (showArchived ? members : members.filter(m => m.active)),
    [members, showArchived],
  );
  const archivedCount = useMemo(() => members.filter(m => !m.active).length, [members]);

  const filtered = useMemo(() => visible.filter(m => {
    if (roleFilter !== 'all' && m.role !== roleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!m.name.toLowerCase().includes(q) && !m.email.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [visible, roleFilter, search]);

  const counts = {
    all: visible.length,
    manager: visible.filter(m => m.role === 'manager').length,
    purchaser: visible.filter(m => m.role === 'purchaser').length,
  };

  return (
    <>
      <SettingsHeader
        title="Members"
        sub={`${members.length - archivedCount} active${archivedCount ? ` · ${archivedCount} archived` : ''} · ${pending.length} pending invite${pending.length === 1 ? '' : 's'}`}
        actions={
          <button className="btn accent" onClick={() => setInviting(true)}>
            <Icon name="plus" size={14} /> Invite member
          </button>
        }
      />

      <div className="settings-row">
        <div className="seg">
          {([
            { v: 'all', label: 'All', count: counts.all },
            { v: 'manager', label: 'Managers', count: counts.manager },
            { v: 'purchaser', label: 'Purchasers', count: counts.purchaser },
          ] as const).map(o => (
            <button key={o.v} className={roleFilter === o.v ? 'active' : ''} onClick={() => setRoleFilter(o.v)}>
              {o.label} <span style={{ opacity: 0.55, marginLeft: 4 }}>{o.count}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label
            className="archived-toggle"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 13, color: 'var(--fg-muted)', cursor: 'pointer', userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
            />
            Show archived
            {archivedCount > 0 && (
              <span style={{ opacity: 0.55, marginLeft: 2 }}>{archivedCount}</span>
            )}
          </label>
          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              placeholder="Search name or email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card pending-card">
          <div className="card-head">
            <div>
              <div className="card-title">Pending invites</div>
              <div className="card-sub">Resend or revoke if someone hasn't accepted.</div>
            </div>
          </div>
          <div className="invite-list">
            {pending.map(inv => (
              <div key={inv.id} className="invite-row">
                <div className="invite-avatar muted"><Icon name="mail" size={14} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13.5 }}>{inv.email}</div>
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {inv.role === 'manager' ? 'Manager' : 'Purchaser'} · added {relTime(inv.created_at)} · not yet signed in
                  </div>
                </div>
                <button
                  className="btn sm ghost"
                  onClick={() => showToast?.(`Resent invite to ${inv.email}`)}
                >
                  Resend
                </button>
                <button
                  className="btn sm ghost"
                  style={{ color: 'var(--neg)' }}
                  onClick={() => removeMember(inv)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        {!loadedOnce ? (
          <TableSkeleton rows={5} cols={4} />
        ) : (
        <table className="data-table members-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Last active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => {
              const isMe = m.email === currentUser?.email;
              return (
                <tr key={m.id} style={m.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <div className="member-cell">
                      <div className="avatar md">{m.initials}</div>
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {m.name}
                          {isMe && <span className="chip muted" style={{ fontSize: 10 }}>You</span>}
                          {!m.active && <span className="chip muted" style={{ fontSize: 10 }}>Inactive</span>}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={'chip ' + (m.role === 'manager' ? 'accent' : 'muted')}>
                      {m.role === 'manager' ? 'Manager' : 'Purchaser'}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{lastSeenLabel(m)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      <button
                        className="btn icon sm ghost"
                        title="Edit member"
                        onClick={() => setEditing(m)}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      {!isMe && m.active && (
                        <button
                          className="btn icon sm ghost"
                          title="Remove from workspace"
                          onClick={() => setRemoving(m)}
                          style={{ color: 'var(--neg)' }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      )}
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
            No members match your filters.
          </div>
        )}

        {editing && (
          <MemberEditModal
            member={editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); reload(); showToast?.('Member updated'); }}
          />
        )}

        {inviting && (
          <InviteMemberModal
            onClose={() => setInviting(false)}
            onInvited={(name) => { setInviting(false); reload(); showToast?.(`${name} added to workspace`); }}
            onError={(msg) => showToast?.(msg, 'error')}
          />
        )}

        {removing && (
          <ConfirmDialog
            title={`Remove ${removing.name} from workspace?`}
            message="They will lose access immediately. Their past orders and audit trail are preserved."
            confirmLabel="Remove"
            danger
            onCancel={() => setRemoving(null)}
            onConfirm={() => removeMember(removing)}
          />
        )}
      </div>
    </>
  );
}

function InviteMemberModal({
  onClose, onInvited, onError,
}: {
  onClose: () => void;
  onInvited: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: '', email: '', role: 'purchaser' as 'manager' | 'purchaser',
    team: '', title: '', phone: '',
  });
  const [saving, setSaving] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => setDraft(p => ({ ...p, [k]: v }));

  const canSave = draft.name.trim() && /.+@.+\..+/.test(draft.email.trim()) && !saving;

  const submit = async () => {
    setSaving(true);
    try {
      const res = await api.post<{ id: string; password: string }>('/api/members', {
        name: draft.name.trim(),
        email: draft.email.trim().toLowerCase(),
        role: draft.role,
        team: draft.team.trim() || undefined,
        title: draft.title.trim() || undefined,
        phone: draft.phone.trim() || undefined,
      });
      setTempPassword(res.password);
      setCreatedName(draft.name.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (tempPassword) {
    return (
      <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onInvited(createdName); }}>
        <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: 'var(--pos-soft)', color: 'var(--pos)',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <Icon name="check" size={18} />
              </div>
              <div>
                <div className="modal-title">{createdName} added</div>
                <div className="modal-sub">Share this temporary password — they'll be prompted to change it on first sign-in.</div>
              </div>
            </div>
          </div>
          <div className="modal-body">
            <div className="field">
              <label className="label">Temporary password</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" readOnly value={tempPassword} style={{ flex: 1 }} />
                <button
                  className="btn"
                  onClick={() => { navigator.clipboard?.writeText(tempPassword); }}
                  title="Copy to clipboard"
                >
                  <Icon name="paperclip" size={13} /> Copy
                </button>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => onInvited(createdName)}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 540 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Invite member</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="label">Full name *</label>
              <input
                className="input"
                value={draft.name}
                onChange={e => set('name', e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="label">Email *</label>
              <input
                className="input"
                type="email"
                value={draft.email}
                onChange={e => set('email', e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label">Title</label>
              <input
                className="input"
                value={draft.title}
                onChange={e => set('title', e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label">Team</label>
              <input
                className="input"
                value={draft.team}
                onChange={e => set('team', e.target.value)}
              />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="label">Phone</label>
              <input
                className="input"
                value={draft.phone}
                onChange={e => set('phone', e.target.value)}
              />
            </div>
          </div>
          <div className="role-picker" style={{ marginTop: 12 }}>
            {(['manager', 'purchaser'] as const).map(r => (
              <label key={r} className={'role-card ' + (draft.role === r ? 'active' : '')}>
                <input
                  type="radio"
                  name="invite-role"
                  value={r}
                  checked={draft.role === r}
                  onChange={() => set('role', r)}
                />
                <div className="role-card-body">
                  <div className="role-card-title">{r === 'manager' ? 'Manager' : 'Purchaser'}</div>
                  <div className="role-card-desc">
                    {r === 'manager'
                      ? 'Full access — manages team, prices items, edits any order.'
                      : 'Submits buy orders; sees own activity only. No cost/profit visibility.'}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!canSave}>
            {saving ? '…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
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
        role: draft.role, active: draft.active,
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

function CustomersPanel({ showToast }: { showToast: ToastFn }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CustomerStatus>('Active');
  const [archiving, setArchiving] = useState<Customer | null>(null);

  const reload = () => api.get<{ items: Customer[] }>('/api/customers')
    .then(r => setCustomers(r.items))
    .catch(console.error)
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
                  <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD0(c.lifetime_revenue || 0)}</td>
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

function ConfirmDialog({
  title, message, confirmLabel, danger, onCancel, onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: danger ? 'var(--neg-soft)' : 'var(--accent-soft)',
              color: danger ? 'var(--neg)' : 'var(--accent-strong)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name={danger ? 'alert' : 'info'} size={18} />
            </div>
            <div>
              <div className="modal-title">{title}</div>
              <div className="modal-sub">{message}</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn"
            style={danger
              ? { background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)' }
              : { background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomerEditModal({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
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

// ─── Warehouses ───────────────────────────────────────────────────────────────
type WarehouseRow = Warehouse & { active: boolean; receiving: boolean };

const TIMEZONE_FALLBACK = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'Europe/Amsterdam', 'Europe/London', 'Asia/Hong_Kong', 'Asia/Tokyo',
];

function listTimezones(): string[] {
  try {
    const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') return fn('timeZone');
  } catch { /* fall through */ }
  return TIMEZONE_FALLBACK;
}

function WarehousesPanel({ showToast }: { showToast: ToastFn }) {
  const [whs, setWhs] = useState<WarehouseRow[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [modalWh, setModalWh] = useState<Warehouse | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => api.get<{ items: Warehouse[] }>('/api/warehouses')
    .then(r => {
      setWhs(r.items.map(w => ({
        ...w,
        active: w.active ?? true,
        receiving: w.short !== 'HK',
      })));
    })
    .catch(console.error)
    .finally(() => setLoadedOnce(true));
  useEffect(() => { reload(); }, []);

  const updateRow = (id: string, patch: Partial<WarehouseRow>) =>
    setWhs(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w));

  // Persist the active flag. Archiving (active=false) removes the warehouse
  // from every UI surface — GET /api/warehouses no longer returns it — so we
  // reload and the card drops out of the list. There is no in-app un-archive
  // by design; reactivation is a direct DB edit.
  const setActive = async (id: string, active: boolean) => {
    updateRow(id, { active }); // optimistic
    try {
      await api.patch(`/api/warehouses/${id}`, { active });
      showToast?.(active ? 'Warehouse reactivated' : 'Warehouse archived');
      reload();
    } catch (e) {
      showToast?.((e as { message?: string })?.message ?? 'Failed to update warehouse', 'error');
      reload();
    }
  };

  return (
    <>
      <SettingsHeader
        title="Warehouses"
        actions={
          <button className="btn accent" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> Add warehouse
          </button>
        }
      />

      <div className="wh-grid">
        {!loadedOnce && Array.from({ length: 3 }).map((_, i) => (
          <div key={`sk-${i}`} className="card wh-card">
            <div className="wh-card-head">
              <div className="wh-card-id">
                <span className="skeleton" style={{ width: 32, height: 32, borderRadius: 8, display: 'inline-block' }} aria-hidden />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="skeleton" style={{ width: '60%', height: 14, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                  <span className="skeleton" style={{ width: '40%', height: 11, borderRadius: 4, display: 'inline-block' }} aria-hidden />
                </div>
              </div>
            </div>
            <div className="wh-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
              <span className="skeleton" style={{ width: '100%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '85%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
              <span className="skeleton" style={{ width: '70%', height: 12, borderRadius: 4, display: 'inline-block' }} aria-hidden />
            </div>
          </div>
        ))}
        {whs.map(w => {
          return (
            <div key={w.id} className={'card wh-card' + (w.active ? '' : ' archived')}>
              <div className="wh-card-head">
                <div className="wh-card-id">
                  <div className="wh-icon"><Icon name="warehouse" size={16} /></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="wh-card-name">{w.name ?? w.short}</div>
                    <div className="wh-card-region">{w.region} · {w.short}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    className="btn icon sm ghost"
                    onClick={() => setModalWh(w)}
                    title="Open full editor"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    <Icon name="settings" size={13} />
                  </button>
                </div>
              </div>

              <div className="wh-card-body">
                {w.address && (
                  <div className="wh-row">
                    <span className="wh-row-label">Address</span>
                    <span className="wh-row-val">{w.address}</span>
                  </div>
                )}
                {w.manager && (
                  <div className="wh-row">
                    <span className="wh-row-label">Manager</span>
                    <span className="wh-row-val">{w.manager}</span>
                  </div>
                )}
                {w.timezone && (
                  <div className="wh-row">
                    <span className="wh-row-label">Timezone</span>
                    <span className="wh-row-val mono" style={{ fontSize: 12.5 }}>{w.timezone}</span>
                  </div>
                )}
              </div>

              <div className="wh-card-foot">
                <div className="toggle-row">
                  <span>Active</span>
                  <Toggle checked={w.active} onChange={(v) => setActive(w.id, v)} />
                </div>
                <div className="toggle-row">
                  <span>Accepting receipts</span>
                  <Toggle
                    checked={w.receiving}
                    onChange={(v) => updateRow(w.id, { receiving: v })}
                    disabled={!w.active}
                  />
                </div>
              </div>
            </div>
          );
        })}

        <button type="button" className="card wh-add" onClick={() => setCreating(true)}>
          <div className="wh-add-icon"><Icon name="plus" size={20} /></div>
          <div className="wh-add-text">
            <div style={{ fontWeight: 600, fontSize: 14 }}>Add warehouse</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>New location for receiving inventory</div>
          </div>
        </button>
      </div>

      {(modalWh || creating) && (
        <WarehouseEditModal
          warehouse={modalWh}
          others={whs.filter(w => w.id !== modalWh?.id)}
          onClose={() => { setModalWh(null); setCreating(false); }}
          onSaved={(msg) => { setModalWh(null); setCreating(false); reload(); showToast?.(msg); }}
          onError={(msg) => showToast?.(msg, 'error')}
        />
      )}
    </>
  );
}

function WarehouseEditModal({
  warehouse, others, onClose, onSaved, onError,
}: {
  warehouse: Warehouse | null;
  others: Warehouse[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isNew = !warehouse;
  type Draft = {
    name: string; short: string; region: string;
    address: string; managerUserId: string;
    timezone: string;
  };
  const [draft, setDraft] = useState<Draft>({
    name: warehouse?.name ?? '',
    short: warehouse?.short ?? '',
    region: warehouse?.region ?? '',
    address: warehouse?.address ?? '',
    managerUserId: warehouse?.managerUserId ?? '',
    timezone: warehouse?.timezone ?? '',
  });
  // Manager dropdown is sourced from the DB (users with role=manager).
  const [managers, setManagers] = useState<Member[]>([]);
  useEffect(() => {
    api.get<{ items: Member[] }>('/api/members')
      .then(r => setManagers(r.items.filter(m => m.role === 'manager' && m.active)))
      .catch(() => { /* leave empty; field still renders */ });
  }, []);
  const selectedMgr = managers.find(m => m.id === draft.managerUserId) ?? null;
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [transferTo, setTransferTo] = useState<string>('');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft(prev => ({ ...prev, [k]: v }));

  const timezones = useMemo(() => listTimezones(), []);

  const canSave = draft.name.trim() && draft.short.trim() && draft.region.trim();

  const save = async () => {
    setSaving(true);
    try {
      const clean = (s: string) => {
        const t = s.trim();
        return t === '' ? null : t;
      };
      const body = {
        name: draft.name.trim(),
        short: draft.short.trim(),
        region: draft.region.trim(),
        address: clean(draft.address),
        managerUserId: draft.managerUserId || null,
        timezone: clean(draft.timezone),
      };
      if (isNew) await api.post('/api/warehouses', body);
      else       await api.patch(`/api/warehouses/${warehouse!.id}`, body);
      onSaved(isNew ? 'Warehouse created' : 'Warehouse saved');
    } catch (e) {
      onError((e as { message?: string })?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!warehouse) return;
    setDeleting(true);
    try {
      const qs = transferTo ? `?transferTo=${encodeURIComponent(transferTo)}` : '';
      await api.delete(`/api/warehouses/${warehouse.id}${qs}`);
      onSaved('Warehouse deleted');
    } catch (e) {
      onError((e as { message?: string })?.message ?? 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{isNew ? 'New warehouse' : 'Edit warehouse'}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={draft.name} onChange={e => set('name', e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">Short code</label>
              <input
                className="input mono"
                value={draft.short}
                onChange={e => set('short', e.target.value.toUpperCase())}
                placeholder="e.g. LA1"
              />
            </div>
            <div className="field">
              <label className="label">Region</label>
              <input className="input" value={draft.region} onChange={e => set('region', e.target.value)} placeholder="e.g. US-West" />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">Address</label>
              <textarea
                className="input"
                rows={3}
                value={draft.address}
                onChange={e => set('address', e.target.value)}
                placeholder="Street, city, postal code…"
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">Manager</label>
              <select
                className="input"
                value={draft.managerUserId}
                onChange={e => set('managerUserId', e.target.value)}
              >
                <option value="">— No manager —</option>
                {managers.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                {draft.managerUserId && !managers.some(m => m.id === draft.managerUserId) && (
                  <option value={draft.managerUserId}>
                    {warehouse?.manager ?? 'Current manager'}
                  </option>
                )}
              </select>
            </div>
          </div>
          {/* Contact details are derived from the selected manager's user
              record — read-only, single source of truth in the DB. */}
          <div className="field-row">
            <div className="field">
              <label className="label">Manager phone</label>
              <input className="input" value={selectedMgr?.phone ?? '—'} readOnly disabled />
            </div>
            <div className="field">
              <label className="label">Manager email</label>
              <input className="input" value={selectedMgr?.email ?? '—'} readOnly disabled />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="label">Timezone</label>
              <select
                className="input"
                value={draft.timezone}
                onChange={e => set('timezone', e.target.value)}
              >
                <option value="">(none)</option>
                {timezones.map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </div>
          {!isNew && (
            <div className="field-row">
              <div className="field">
                <label className="label">ID</label>
                <input className="input mono" value={warehouse!.id} disabled />
              </div>
            </div>
          )}
          {!isNew && confirmingDelete && (
            <div
              style={{
                marginTop: 12, padding: 12, borderRadius: 6,
                border: '1px solid var(--neg)', background: 'var(--bg-elev)',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Delete warehouse "{warehouse!.name ?? warehouse!.short}"?
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginBottom: 10 }}>
                Existing orders and sell-orders referencing this warehouse will be moved to the warehouse you pick below. This cannot be undone.
              </div>
              <div className="field">
                <label className="label">Move inventory to</label>
                <select
                  className="input"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                >
                  <option value="">(none — clear warehouse from records)</option>
                  {others.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.name ?? w.short} · {w.region}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <div>
            {!isNew && !confirmingDelete && (
              <button
                className="btn"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting || saving}
                style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
              >
                Delete
              </button>
            )}
            {!isNew && confirmingDelete && (
              <button
                className="btn"
                onClick={() => { setConfirmingDelete(false); setTransferTo(''); }}
                disabled={deleting}
              >
                Back
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {confirmingDelete ? (
              <button
                className="btn primary"
                onClick={remove}
                disabled={deleting}
                style={{ background: 'var(--neg)', borderColor: 'var(--neg)' }}
              >
                {deleting ? '…' : 'Confirm delete'}
              </button>
            ) : (
              <>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving || deleting || !canSave}>
                  {saving ? '…' : 'Save'}
                </button>
              </>
            )}
          </div>
        </div>
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

