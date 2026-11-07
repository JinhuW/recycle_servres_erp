import { useEffect, useRef, useState } from 'react';
import type { FbSellerSettings } from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { FormSkeleton } from '../../../../components/Skeleton';
import { ApiError } from '../../../../lib/api';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../../lib/errorToast';
import {
  fbSellerApi, fbSellerChanged, setSettingsField, settingsDiff, usePolled, validateFbSettings, type FbSettingsProblem,
} from '../../../../lib/fbSeller';
import { useT } from '../../../../lib/i18n';
import { Ago, Field } from './shared';

// Every seller setting, the kill switch first. The form checks what the
// server checks (lib/fbSeller.ts validateFbSettings mirrors fbConfig.ts) so a
// bad value is named before Save; a save someone else beat answers that the
// settings changed, and the form reloads them.

type NumField = { path: string; unit?: string };
const UNIT_KEY: Record<string, string> = { min: 'fbs_unit_min', days: 'fbs_unit_days', s: 'fbs_unit_s' };
const GROUPS: { key: string; fields: NumField[] }[] = [
  { key: 'pacing_ads', fields: [
    { path: 'pacing.ad_action_gap_minutes', unit: 'min' }, { path: 'pacing.max_live_ads_per_account' }, { path: 'pacing.same_ad_location_per_day' },
    { path: 'pacing.renew_days', unit: 'days' }, { path: 'pacing.renew_jitter_days', unit: 'days' },
  ] },
  { key: 'pacing_msgs', fields: [
    { path: 'pacing.send_gap_seconds', unit: 's' }, { path: 'pacing.send_jitter_seconds', unit: 's' }, { path: 'pacing.sends_per_account_day' },
  ] },
  { key: 'pacing_inbox', fields: [
    { path: 'pacing.inbox_every_minutes', unit: 'min' }, { path: 'pacing.inbox_jitter_minutes', unit: 'min' },
    { path: 'pacing.inbox_max_threads' }, { path: 'pacing.inbox_max_messages' },
  ] },
  { key: 'offer', fields: [
    { path: 'offer.opening_pct', unit: '%' }, { path: 'offer.step_pct', unit: '%' }, { path: 'offer.max_rounds' }, { path: 'offer.price_max_age_days', unit: 'days' },
  ] },
  { key: 'agent', fields: [{ path: 'agent.daily_spend_usd', unit: '$' }, { path: 'agent.circuit_breaker_failures' }] },
  { key: 'photos', fields: [{ path: 'photos.low_pool_warning' }] },
];

const read = (v: FbSellerSettings, path: string): unknown => {
  const [g, f] = path.split('.');
  const group = (v as unknown as Record<string, unknown>)[g];
  return f ? (group as Record<string, unknown>)[f] : group;
};
const keyOf = (path: string) => `fbs_set_${path.replace('.', '_')}`;

export function SettingsTab() {
  const { t } = useT();
  const { data, setData, reload } = usePolled(() => fbSellerApi.settings(), null, []);
  const [v, setV] = useState<FbSellerSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  // A fresh read replaces the form, except that edits not saved yet survive a
  // kill-switch flip, which saves on its own.
  const loaded = useRef<FbSellerSettings | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = loaded.current;
    loaded.current = data.value;
    setV(prev => (prev && before && JSON.stringify(prev) !== JSON.stringify(before)
      ? { ...prev, kill_switch: data.value.kill_switch }
      : structuredClone(data.value)));
  }, [data]);

  if (!data || !v) return <FormSkeleton fields={8} />;
  const problems = validateFbSettings(v);
  const problemAt = (path: string) => problems.find(p => p.path === path);
  const msg = (p: FbSettingsProblem | undefined) => (p ? t(p.key, p.vars) : null);
  const dirty = JSON.stringify(v) !== JSON.stringify(data.value);
  const set = (path: string, value: unknown) => setV(x => x && setSettingsField(x, path, value));

  const save = async (next: FbSellerSettings = v) => {
    setBusy(true);
    try {
      const r = await fbSellerApi.saveSettings(next, data.version);
      setData(r);
      setHistoryKey(k => k + 1);
      fbSellerChanged();
      showSuccessToast(t('fbs_settings_saved'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.body as { error?: string } | undefined)?.error === 'stale_settings') {
        showWarnToast(e.message);
        await reload();
      } else handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  // The kill switch saves on its own, at once: it is the one setting nobody
  // should have to find a Save button for.
  const toggleKill = () => {
    const next = setSettingsField(data.value, 'kill_switch', !data.value.kill_switch);
    void save(next);
  };

  return (
    <div className="fbs-settings">
      <div className={`card fbs-kill${data.value.kill_switch ? ' on' : ''}`}>
        <Icon name={data.value.kill_switch ? 'lock' : 'zap'} size={18} />
        <div>
          <b>{t(data.value.kill_switch ? 'fbs_kill_on' : 'fbs_kill_off')}</b>
          <p>{t('fbs_kill_hint')}</p>
        </div>
        <button className={`btn ${data.value.kill_switch ? 'primary' : 'danger'}`} disabled={busy} onClick={toggleKill}>
          {t(data.value.kill_switch ? 'fbs_kill_release' : 'fbs_kill_pull')}
        </button>
      </div>

      <div className="card fbs-panel">
        <h3>{t('fbs_grp_hours')}</h3>
        <div className="fbs-form">
          <Field label={t('fbs_set_active_hours_start')} error={msg(problemAt('active_hours.start'))}>
            <input className="input" type="time" value={v.active_hours.start} onChange={e => set('active_hours', { ...v.active_hours, start: e.target.value })} />
          </Field>
          <Field label={t('fbs_set_active_hours_end')} error={msg(problemAt('active_hours.end'))}>
            <input className="input" type="time" value={v.active_hours.end} onChange={e => set('active_hours', { ...v.active_hours, end: e.target.value })} />
          </Field>
          <Field label={t('fbs_set_active_hours_tz')} error={msg(problemAt('active_hours.tz'))}>
            <input className="input mono" value={v.active_hours.tz} onChange={e => set('active_hours', { ...v.active_hours, tz: e.target.value })} />
          </Field>
        </div>
      </div>

      {GROUPS.map(g => (
        <div key={g.key} className="card fbs-panel">
          <h3>{t(`fbs_grp_${g.key}`)}</h3>
          <div className="fbs-form">
            {g.fields.map(f => {
              const val = read(v, f.path) as number;
              return (
                <Field key={f.path} label={t(keyOf(f.path))} error={msg(problemAt(f.path))} hint={t(`${keyOf(f.path)}_hint`)}>
                  <span className="fbs-unit">
                    <input className="input" type="number" step={1} value={Number.isFinite(val) ? val : ''}
                      onChange={e => set(f.path, e.target.value === '' ? Number.NaN : e.target.valueAsNumber)} aria-invalid={!!problemAt(f.path)} />
                    {f.unit && <span>{UNIT_KEY[f.unit] ? t(UNIT_KEY[f.unit]) : f.unit}</span>}
                  </span>
                </Field>
              );
            })}
          </div>
        </div>
      ))}

      <div className="card fbs-panel">
        <h3>{t('fbs_grp_alerts')}</h3>
        <div className="fbs-form">
          <Field label={t(keyOf('alerts.telegram_chat_id'))} hint={t(`${keyOf('alerts.telegram_chat_id')}_hint`)}>
            <input className="input mono" value={v.alerts.telegram_chat_id ?? ''} onChange={e => set('alerts.telegram_chat_id', e.target.value.trim() || null)} />
          </Field>
        </div>
      </div>

      <div className="fbs-savebar">
        {problems.length > 0 && <span className="fbs-error">{t('fbs_settings_problems', { n: problems.length })}</span>}
        <button className="btn ghost" disabled={!dirty || busy} onClick={() => setV(structuredClone(data.value))}>{t('fbs_discard')}</button>
        <button className="btn primary" disabled={!dirty || busy || problems.length > 0} onClick={() => void save()}>{t('fbs_save')}</button>
      </div>

      <SettingsHistory key={historyKey} />
    </div>
  );
}

function fmtValue(x: unknown): string {
  if (x === null || x === undefined) return '—';
  if (typeof x === 'object') return JSON.stringify(x);
  return String(x);
}

function SettingsHistory() {
  const { t } = useT();
  const { data } = usePolled(() => fbSellerApi.settingsHistory(), null, []);
  return (
    <section className="card fbs-panel">
      <h3>{t('fbs_history')}</h3>
      {!data ? <FormSkeleton fields={2} withHeader={false} /> : !data.rows.length ? <p className="rl-muted">{t('fbs_history_empty')}</p> : (
        <ul className="fbs-history">
          {data.rows.map(h => {
            const diff = settingsDiff(h.before, h.after);
            return (
              <li key={h.id}>
                <div className="rl-between">
                  <b>{t('fbs_history_version', { n: h.version })}</b>
                  <span className="rl-muted">{h.changed_by_name ?? t('fbs_someone')} · <Ago at={h.changed_at} /></span>
                </div>
                <ul className="fbs-diff">
                  {diff.map(x => (
                    <li key={x.path}>{t(keyOf(x.path))}: <s>{fmtValue(x.from)}</s> → <b>{fmtValue(x.to)}</b></li>
                  ))}
                  {!diff.length && <li className="rl-muted">{t('fbs_history_nochange')}</li>}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
