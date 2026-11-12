import { useEffect, useState } from 'react';
import { fbChatConfigProblem, type FbChatConfigField } from '@recycle-erp/shared';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { SettingsHeader, Toggle } from './_shared';

// ─── Chat bridge ──────────────────────────────────────────────────────────────
// Settings the Marketplace chat extensions load from the ERP. The form is not
// a fixed list: it is drawn from the fields the extensions report, so a new
// setting needs only an extension release. Each extension checks about once
// a minute, so a change arrives within its "Settings check" interval.

type Field = FbChatConfigField & { versions: string[] };
type Entry = { account_id: number | null; key: string; value: unknown; updated_at: string; updated_by: string | null };
type Account = {
  id: number; fb_uid: string; label: string; ext_version: string | null; last_seen_at: string;
  config_rev: string | null; config_seen_at: string | null; expected_rev: string;
};
type Data = { fields: Field[]; entries: Entry[]; accounts: Account[] };

const shown = (value: unknown, unit?: string) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return unit ? `${text} ${unit}` : text;
};

export function FbChatBridgePanel() {
  const { t, locale } = useT();
  const [data, setData] = useState<Data | null>(null);
  // null: the value for every profile; otherwise one profile's own.
  const [scope, setScope] = useState<number | null>(null);

  const reload = () => api.get<Data>('/api/fb-chat/config').then(setData).catch(handleFetchError);
  useEffect(() => {
    reload();
    // Picks up the profiles' check-ins, so "Waiting" turns to "Up to date".
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return <div className="settings-panel-loading" />;

  const entry = (key: string, accountId: number | null) =>
    data.entries.find((e) => e.key === key && e.account_id === accountId);
  const reported = new Set(data.fields.map((f) => f.key));
  // Set on the ERP but reported by no recent extension: kept, shown, resettable.
  const orphans = data.entries.filter((e) => e.account_id === scope && !reported.has(e.key));

  const save = async (key: string, value: unknown) => {
    await api.put(`/api/fb-chat/config/${encodeURIComponent(key)}`, { accountId: scope, value });
    await reload();
  };
  const reset = async (key: string) => {
    const query = scope === null ? '' : `?accountId=${scope}`;
    await api.delete(`/api/fb-chat/config/${encodeURIComponent(key)}${query}`).catch(handleFetchError);
    await reload();
  };

  return (
    <>
      <SettingsHeader title={t('fbcfgTitle')} sub={t('fbcfgSub')} />

      <div className="card">
        <div className="card-head"><div className="card-title">{t('fbcfgProfiles')}</div></div>
        <div className="card-body" style={{ padding: 0 }}>
          {data.accounts.length === 0
            ? <div style={{ padding: 16, color: 'var(--fg-subtle)', fontSize: 13 }}>{t('fbcfgNoProfiles')}</div>
            : (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('fbcfgProfile')}</th>
                    <th>{t('fbcfgVersion')}</th>
                    <th>{t('fbcfgLastSeen')}</th>
                    <th>{t('fbcfgSettingsState')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => {
                    const current = a.config_rev !== null && a.config_rev === a.expected_rev;
                    return (
                      <tr key={a.id}>
                        <td>{a.label || a.fb_uid}</td>
                        <td className="mono">{a.ext_version ?? '–'}</td>
                        <td>{relTime(a.last_seen_at, locale)}</td>
                        <td style={{ color: current ? 'var(--pos)' : 'var(--warn)' }}>
                          {a.config_seen_at === null
                            ? t('fbcfgNeverChecked')
                            : current
                              ? t('fbcfgUpToDate', { when: relTime(a.config_seen_at, locale) })
                              : t('fbcfgWaiting', { when: relTime(a.config_seen_at, locale) })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="card-title">{t('fbcfgSettings')}</div>
            <div className="card-sub">{scope === null ? t('fbcfgScopeAllSub') : t('fbcfgScopeOneSub')}</div>
          </div>
          <select
            className="input"
            style={{ width: 'auto' }}
            aria-label={t('fbcfgScope')}
            value={scope ?? ''}
            onChange={(e) => setScope(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">{t('fbcfgScopeAll')}</option>
            {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.fb_uid}</option>)}
          </select>
        </div>
        <div className="card-body">
          {data.fields.length === 0 && <div style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>{t('fbcfgNoFields')}</div>}
          {data.fields.map((f) => {
            const own = entry(f.key, scope);
            const shared = scope === null ? undefined : entry(f.key, null);
            const value = own ? own.value : shared ? shared.value : f.default;
            const source = own
              ? (scope === null ? t('fbcfgFromAll') : t('fbcfgFromProfile'))
              : shared ? t('fbcfgFromAllInherited') : t('fbcfgFromDefault');
            return (
              <SettingRow
                key={`${scope}:${f.key}`}
                field={f}
                value={value}
                source={source}
                overridden={!!own}
                onSave={save}
                onReset={() => reset(f.key)}
              />
            );
          })}
          {orphans.map((e) => (
            <div key={e.key} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 13 }}>{e.key}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('fbcfgOrphan')}</div>
              </div>
              <code className="mono" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shown(e.value)}</code>
              <button className="btn sm ghost" onClick={() => reset(e.key)}>{t('fbcfgReset')}</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SettingRow({ field, value, source, overridden, onSave, onReset }: {
  field: Field;
  value: unknown;
  source: string;
  overridden: boolean;
  onSave: (key: string, value: unknown) => Promise<void>;
  onReset: () => void;
}) {
  const { t } = useT();
  const asText = (v: unknown) => (field.type === 'json' ? JSON.stringify(v, null, 2) : typeof v === 'string' ? v : String(v));
  const [draft, setDraft] = useState(asText(value));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(asText(value)); setError(null); }, [JSON.stringify(value)]);

  const parse = (text: string): { value?: unknown; error?: string } => {
    if (field.type === 'integer' || field.type === 'number') {
      return text.trim() === '' ? { error: t('fbcfgNeedNumber') } : { value: Number(text) };
    }
    if (field.type === 'json') {
      try { return { value: JSON.parse(text) }; } catch { return { error: t('fbcfgBadJson') }; }
    }
    return { value: text };
  };

  const commit = async (next: unknown) => {
    const problem = fbChatConfigProblem(field, next);
    if (problem) { setError(`${field.label} ${problem}`); return; }
    setError(null);
    setBusy(true);
    try {
      await onSave(field.key, next);
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };
  const commitDraft = () => {
    if (draft === asText(value)) return;
    const parsed = parse(draft);
    if (parsed.error) setError(parsed.error);
    else void commit(parsed.value);
  };

  let control;
  if (field.type === 'boolean') {
    control = <Toggle checked={value === true} disabled={busy} onChange={(v) => void commit(v)} />;
  } else if (field.type === 'string' && field.options) {
    control = (
      <select className="input" style={{ width: 180 }} value={String(value)} disabled={busy} onChange={(e) => void commit(e.target.value)}>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (field.type === 'json') {
    control = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <textarea className="input mono" rows={4} style={{ width: 280, fontSize: 12 }} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn sm" disabled={busy || draft === asText(value)} onClick={commitDraft}>{t('fbcfgSave')}</button>
      </div>
    );
  } else {
    const numeric = field.type === 'integer' || field.type === 'number';
    control = (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          className={'input' + (numeric ? ' mono' : '')}
          style={{ width: numeric ? 110 : 220 }}
          type={numeric ? 'number' : 'text'}
          min={field.min}
          max={field.max}
          step={field.type === 'integer' ? 1 : 'any'}
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        {field.unit && <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{field.unit}</span>}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{field.label}</div>
        {field.help && <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{field.help}</div>}
        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 4 }}>
          {source}
          {' · '}{t('fbcfgDefault', { value: shown(field.default, field.unit) })}
          {' · '}<span className="mono" title={field.versions.join(', ')}>{field.key}</span>
        </div>
        {error && <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>{error}</div>}
      </div>
      {control}
      <button className="btn sm ghost" style={{ visibility: overridden ? 'visible' : 'hidden' }} disabled={busy} onClick={onReset}>
        {t('fbcfgReset')}
      </button>
    </div>
  );
}
