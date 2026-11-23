import { useEffect, useMemo, useRef, useState } from 'react';
import { AI_PROVIDERS, AI_PROVIDER_LABELS, parseModelRef, type AiProviderId } from '@recycle-erp/shared';
import { ModelPicker, useAiModels } from './ModelPicker';
import { loadAiProviders, modelsFor, preselectModel, type AiModel, type AiProviderStatus } from '../lib/aiModels';
import { trackerApi, trackerProviderStatus, type TrackerKeyStatus } from '../lib/tracker';
import { useT } from '../lib/i18n';

/** Which providers have a key; null while it loads. Bump `version` to re-read. */
export function useAiProviders(version = 0): AiProviderStatus[] | null {
  const [list, setList] = useState<AiProviderStatus[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadAiProviders()
      .then(r => { if (alive) setList(r.providers); })
      // Unknown: offer them all and let the save's 400 say which has no key.
      .catch(() => {
        if (alive) {
          setList(AI_PROVIDERS.map(id => ({
            id, label: AI_PROVIDER_LABELS[id], configured: true, source: null, last4: null, trackerSynced: null, keyName: '',
          })));
        }
      });
    return () => { alive = false; };
  }, [version]);
  return list;
}

/**
 * The providers the Reddit tracker can call, for its model pickers; null
 * while either list loads. See trackerProviderStatus for the fallback.
 */
export function useTrackerAiProviders(): AiProviderStatus[] | null {
  const erp = useAiProviders();
  const [tracker, setTracker] = useState<TrackerKeyStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    trackerApi.llmKeys()
      .then(r => { if (alive) setTracker(r); })
      .catch(() => { if (alive) setTracker(null); });
    return () => { alive = false; };
  }, []);
  return useMemo(
    () => (erp === null || tracker === undefined ? null : trackerProviderStatus(erp, tracker)),
    [erp, tracker],
  );
}

/** Bare for OpenRouter: every saved setting already holds the bare id. */
function toRef(provider: AiProviderId, model: string): string {
  return provider === 'openrouter' ? model : `${provider}:${model}`;
}

/**
 * A model setting as two dropdowns: the provider, then one of its models.
 * `value` is a model ref ('' = the default when `defaultLabel` is given).
 * The model field still takes a typed id the catalogue doesn't list yet.
 */
export function ProviderModelSelect({
  value, onChange, id, filter, defaultLabel, invalid, unavailableText, providers: given, noKeyText,
}: {
  value: string;
  onChange: (ref: string) => void;
  id?: string;
  /** Narrows each provider's models to the ones the caller can use. Keep it stable. */
  filter?: (m: AiModel) => boolean;
  /** Offers a "use the default" choice, which sets ''. */
  defaultLabel?: string;
  invalid?: boolean;
  unavailableText?: string;
  /** Whose keys decide which providers can be picked; the ERP's when omitted. */
  providers?: AiProviderStatus[] | null;
  /** Shown beside a provider without a key. */
  noKeyText?: string;
}) {
  const { t } = useT();
  const erpProviders = useAiProviders();
  const providers = given === undefined ? erpProviders : given;
  const { models } = useAiModels();
  const current = value === '' ? null : parseModelRef(value);
  // Remembered so picking a provider shows its empty model field before a
  // model is chosen. A value set from outside (a reset, a reload) replaces it.
  const [picked, setPicked] = useState<AiProviderId | null>(current?.provider ?? null);
  const emitted = useRef<string | null>(null);
  useEffect(() => {
    if (value === emitted.current) return;
    setPicked(value === '' ? null : parseModelRef(value).provider);
  }, [value]);
  const provider = current?.provider ?? picked;

  function emit(ref: string) {
    emitted.current = ref;
    onChange(ref);
  }

  const modelFilter = useMemo(() => (provider ? modelsFor(provider, filter) : undefined), [provider, filter]);

  function pickProvider(next: string) {
    if (next === '') { setPicked(null); emit(''); return; }
    const p = next as AiProviderId;
    setPicked(p);
    emit(preselectModel(models, p, filter));
  }

  const status = (p: AiProviderId) => providers?.find(x => x.id === p);

  return (
    <div className="ai-provider-model" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 200px) 1fr', gap: 8 }}>
      <select
        className="input"
        aria-label={t('aiProvider')}
        id={id ? `${id}-provider` : undefined}
        value={provider ?? ''}
        onChange={e => pickProvider(e.target.value)}
      >
        {defaultLabel !== undefined && <option value="">{defaultLabel}</option>}
        {defaultLabel === undefined && provider === null && <option value="" disabled>{t('aiPickProvider')}</option>}
        {AI_PROVIDERS.map(p => {
          const s = status(p);
          // The current choice stays selectable even if its key was removed,
          // so the field still shows what is saved.
          const off = s !== undefined && !s.configured && p !== provider;
          return (
            <option key={p} value={p} disabled={off}>
              {AI_PROVIDER_LABELS[p]}{s && !s.configured ? ` — ${noKeyText ?? t('aiProviderNoKey')}` : ''}
            </option>
          );
        })}
      </select>
      {provider === null
        ? <input className="input" disabled value="" placeholder={defaultLabel ?? ''} aria-label={t('aiModel')} />
        : (
          <ModelPicker
            id={id}
            value={current?.model ?? ''}
            onChange={m => emit(m.trim() === '' ? '' : toRef(provider, m))}
            filter={modelFilter}
            provider={provider}
            invalid={invalid}
            unavailableText={unavailableText}
          />
        )}
    </div>
  );
}
