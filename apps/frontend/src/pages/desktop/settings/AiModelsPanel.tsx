import { useEffect, useState } from 'react';
import { AI_FEATURES, isAiModelsSetting, isModelRef, type AiFeature, type AiModelsSetting } from '@recycle-erp/shared';
import { useT } from '../../../lib/i18n';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { loadAiProviders, type AiModel } from '../../../lib/aiModels';
import { ProviderModelSelect, useAiProviders } from '../../../components/ProviderModelSelect';

// ─── AI models ────────────────────────────────────────────────────────────────
// Which provider and model each image read uses, stored as the `ai_models`
// workspace setting and read by the backend's ai/llm.ts on every call (cached
// ~30 s). Provider keys stay in the server's env; this page only shows which
// are set. A draft until Save, because the model field takes typed ids too.

const FEATURE_LABEL: Record<AiFeature, string> = {
  scan: 'aiFeatureScan', receipt: 'aiFeatureReceipt', paypal: 'aiFeaturePaypal', serial: 'aiFeatureSerial',
};

// Every feature here sends a photo.
const READS_IMAGES = (m: AiModel) => m.inputModalities.includes('image') && m.outputModalities.includes('text');

const EMPTY: AiModelsSetting = { default: null };

export function AiModelsPanel() {
  const { t } = useT();
  const providers = useAiProviders();
  const [envModel, setEnvModel] = useState('');
  const [saved, setSaved] = useState<AiModelsSetting>(EMPTY);
  const [draft, setDraft] = useState<AiModelsSetting>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAiProviders().then(r => setEnvModel(r.envModel)).catch(() => {});
    api.get<{ settings: Record<string, unknown> }>('/api/workspace')
      .then(({ settings }) => {
        const v = isAiModelsSetting(settings.ai_models) ? settings.ai_models : EMPTY;
        setSaved(v);
        setDraft(v);
      })
      .catch(handleFetchError);
  }, []);

  const keys = ['default', ...AI_FEATURES] as const;
  const val = (k: (typeof keys)[number]) => draft[k] ?? '';
  const set = (k: (typeof keys)[number], ref: string) => setDraft(d => ({ ...d, [k]: ref === '' ? null : ref }));
  const bad = keys.filter(k => val(k) !== '' && !isModelRef(val(k)));
  const dirty = keys.some(k => (draft[k] ?? null) !== (saved[k] ?? null));

  function save() {
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
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(providers ?? []).map(p => (
            <span key={p.id} className={`chip ${p.configured ? 'pos' : 'muted'}`} title={p.keyName}>
              {p.label} · {p.configured ? t('aiProviderReady') : t('aiProviderNoKey')}
            </span>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
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
              defaultLabel={t('aiUseDefaultModel', { model: envModel })}
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
            <button className="btn primary" disabled={!dirty || saving || bad.length > 0} onClick={save}>
              {t('save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
