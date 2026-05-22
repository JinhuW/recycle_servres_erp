import { useEffect, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import type { Lang } from '../../../lib/types';

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

export function GeneralPanel() {
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
      .catch(handleFetchError);
  useEffect(() => { reload(); }, []);

  const persist = (body: Record<string, unknown>) =>
    api.patch('/api/workspace', body).catch(err => {
      handleFetchError(err);
      reload();
    });

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
