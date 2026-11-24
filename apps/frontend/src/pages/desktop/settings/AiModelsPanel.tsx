import { useEffect, useState } from 'react';
import { AI_FEATURES, isAiModelsSetting, isModelRef, type AiFeature, type AiModelsSetting } from '@recycle-erp/shared';
import { useT } from '../../../lib/i18n';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import {
  loadAiProviders, READS_IMAGES, removeAiKey, resyncAiKey, saveAiKey, type AiProviderStatus,
} from '../../../lib/aiModels';
import { ProviderModelSelect, useAiProviders } from '../../../components/ProviderModelSelect';

// ─── AI models ────────────────────────────────────────────────────────────────
// The providers' API keys, and which provider and model each image read uses.
// A pasted key is tested, stored sealed, pushed to the Reddit tracker, and
// shown again only as its last four characters. Keys and models live only
// here: the server's old env vars were imported once and are ignored. Models are the `ai_models` workspace setting, read by the backend's
// ai/llm.ts on every call (cached ~30 s), and a draft until Save because the
// model field takes typed ids too.

const FEATURE_LABEL: Record<AiFeature, string> = {
  scan: 'aiFeatureScan', receipt: 'aiFeatureReceipt', paypal: 'aiFeaturePaypal', serial: 'aiFeatureSerial',
};

const EMPTY: AiModelsSetting = { default: null };

export function ProviderKeyRow({ p, canStore, onChanged }: {
  p: AiProviderStatus;
  canStore: boolean;
  onChanged: () => void;
}) {
  const { t } = useT();
  // Never pre-filled: the page only ever knows the last four characters.
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackerError, setTrackerError] = useState<string | null>(null);

  async function run(kind: 'save' | 'remove' | 'sync') {
    setBusy(kind);
    setError(null);
    try {
      const r = kind === 'save' ? await saveAiKey(p.id, key.trim())
        : kind === 'remove' ? await removeAiKey(p.id)
        : await resyncAiKey(p.id);
      if (kind !== 'sync') setKey('');
      setTrackerError(r.trackerSynced ? null : (r.trackerError ?? ''));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const status = p.source === 'ui' ? t('aiKeySetHere', { last4: p.last4 ?? '' }) : t('aiProviderNoKey');
  // Read from the server unless this row's last action just answered: a
  // removal the tracker missed leaves no key row, only trackerSynced false.
  const unsynced = trackerError !== null || p.trackerSynced === false;

  return (
    <div className="field" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{p.label}</strong>
        <span className={`chip ${p.configured ? 'pos' : 'muted'}`}>{status}</span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          aria-label={t('aiKeyFor', { provider: p.label })}
          id={`ai-key-${p.id}`}
          placeholder={p.source === 'ui' ? t('aiKeyReplace') : t('aiKeyPaste')}
          value={key}
          disabled={!canStore || busy !== null}
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && key.trim()) void run('save'); }}
          style={{ flex: 1 }}
        />
        <button className="btn primary" disabled={!canStore || !key.trim() || busy !== null} onClick={() => run('save')}>
          {busy === 'save' ? t('aiKeyTesting') : t('save')}
        </button>
        {p.source === 'ui' && (
          <button className="btn" disabled={busy !== null} onClick={() => run('remove')}>
            {t('aiKeyRemove')}
          </button>
        )}
      </div>
      {error && <div className="help rt-help-invalid" role="alert">{error}</div>}
      {p.unreadable && <div className="help rt-help-invalid">{t('aiKeyUnreadable')}</div>}
      {unsynced && (
        <div className="help rt-help-invalid" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{p.source === 'ui' ? t('aiKeyTrackerUnsynced') : t('aiKeyTrackerRemovalUnsynced')}</span>
          <button className="btn sm" disabled={busy !== null} onClick={() => run('sync')}>
            {busy === 'sync' ? t('aiKeyRetrying') : t('aiKeyRetrySync')}
          </button>
        </div>
      )}
    </div>
  );
}

export function AiModelsPanel() {
  const { t } = useT();
  // Bumped after a key changes, to re-read the key status and the model lists.
  const [version, setVersion] = useState(0);
  const providers = useAiProviders(version);
  const [canStore, setCanStore] = useState(true);
  const [fallbackModel, setFallbackModel] = useState('');
  const [saved, setSaved] = useState<AiModelsSetting>(EMPTY);
  const [draft, setDraft] = useState<AiModelsSetting>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Save stays off until the stored setting has loaded: a draft built on the
  // empty placeholder would overwrite every model saved there.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadAiProviders().then(r => { setFallbackModel(r.fallbackModel); setCanStore(r.canStore); }).catch(() => {});
    api.get<{ settings: Record<string, unknown> }>('/api/workspace')
      .then(({ settings }) => {
        const v = isAiModelsSetting(settings.ai_models) ? settings.ai_models : EMPTY;
        setSaved(v);
        setDraft(v);
        setLoaded(true);
      })
      .catch(handleFetchError);
  }, []);

  const keys = ['default', ...AI_FEATURES] as const;
  const val = (k: (typeof keys)[number]) => draft[k] ?? '';
  const set = (k: (typeof keys)[number], ref: string) => setDraft(d => ({ ...d, [k]: ref === '' ? null : ref }));
  const bad = keys.filter(k => val(k) !== '' && !isModelRef(val(k)));
  const dirty = keys.some(k => (draft[k] ?? null) !== (saved[k] ?? null));

  function save() {
    if (!loaded) return;
    // Only the keys that hold something: an all-default setting is {default: null}.
    const body: AiModelsSetting = { default: draft.default ?? null };
    for (const f of AI_FEATURES) if (draft[f]) body[f] = draft[f];
    setSaving(true);
    setError(null);
    api.patch('/api/workspace', { ai_models: body })
      .then(() => setSaved(body))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('aiProvidersTitle')}</div>
            <div className="card-sub">{t('aiProvidersSub')}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!canStore && <div className="help rt-help-invalid">{t('aiKeyCantStore')}</div>}
          {(providers ?? []).map(p => (
            <ProviderKeyRow key={p.id} p={p} canStore={canStore} onChanged={() => setVersion(v => v + 1)} />
          ))}
        </div>
      </div>

      {/* Re-mounted after a key change so every model list is fetched again. */}
      <div className="card" style={{ marginTop: 'var(--gap)' }} key={version}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('aiModelsTitle')}</div>
            <div className="card-sub">{t('aiModelsSub')}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="field">
            <label className="label" htmlFor="ai-model-default">{t('aiDefaultModel')}</label>
            <ProviderModelSelect
              id="ai-model-default"
              value={val('default')}
              onChange={ref => set('default', ref)}
              filter={READS_IMAGES}
              defaultLabel={t('aiUseDefaultModel', { model: fallbackModel })}
              invalid={bad.includes('default')}
            />
            <div className="help">{t('aiDefaultModelHelp')}</div>
          </div>
          {AI_FEATURES.map(f => (
            <div className="field" key={f}>
              <label className="label" htmlFor={`ai-model-${f}`}>{t(FEATURE_LABEL[f])}</label>
              <ProviderModelSelect
                id={`ai-model-${f}`}
                value={val(f)}
                onChange={ref => set(f, ref)}
                filter={READS_IMAGES}
                defaultLabel={t('aiUseDefaultModel', { model: t('aiDefaultModel') })}
                invalid={bad.includes(f)}
              />
            </div>
          ))}
          <div className="help">{t('aiModelsTrackerNote')}</div>
          {error && <div className="help rt-help-invalid" role="alert">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" disabled={!dirty || saving} onClick={() => { setDraft(saved); setError(null); }}>
              {t('cancel')}
            </button>
            <button className="btn primary" disabled={!loaded || !dirty || saving || bad.length > 0} onClick={save}>
              {t('save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
