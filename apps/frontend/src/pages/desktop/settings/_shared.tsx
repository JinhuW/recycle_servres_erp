import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../../components/Icon';
import { relTime } from '../../../lib/format';

// ─── Types ────────────────────────────────────────────────────────────────────
export type Member = {
  id: string; email: string; name: string; initials: string;
  role: 'manager' | 'purchaser';
  team: string | null; phone: string | null; title: string | null;
  active: boolean;
  order_count: number; lifetime_profit: number;
  created_at: string; last_seen_at: string | null;
};

export type Customer = {
  id: string; name: string; short_name: string | null;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  address: string | null; country: string | null;
  region: string | null;
  tags: string[]; notes: string | null; active: boolean;
  lifetime_revenue: number; order_count: number;
  outstanding: number; last_order: string | null;
};

export type ToastFn = ((msg: string, kind?: 'success' | 'error') => void) | undefined;

// ─── Shared primitives ────────────────────────────────────────────────────────
export function SettingsHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
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

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
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

export function StatTile({ label, value, sub, icon, tone }: {
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

// "Pending invites" are real members who were added but have never signed in
// (last_seen_at is null). No separate invites table / acceptance flow exists —
// inviting creates the member immediately — so this is the accurate
// interpretation. Revoke removes the member; Resend has no email backend yet.

// Real "last active" text from users.last_seen_at (stamped on login). A member
// who has never signed in shows "Never" — see pendingInvites().
export function lastSeenLabel(m: Member, locale = 'en-US'): string {
  return m.last_seen_at ? relTime(m.last_seen_at, locale) : 'Never';
}

// PasswordMeter moved to `components/PasswordMeter.tsx` — the desktop
// MembersPanel and the new mobile password sheet both render it, so it lives
// outside the desktop-settings tree now.
