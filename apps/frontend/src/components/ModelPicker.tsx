import { useEffect, useMemo, useState } from 'react';
import { Combobox } from './Combobox';
import { loadAiModels, modelMeta, type AiModel } from '../lib/aiModels';
import { useT } from '../lib/i18n';
import { parseModelRef, type AiProviderId } from '@recycle-erp/shared';

/** The model catalogue: null while it loads, and for good once `failed`. */
export function useAiModels(): { models: AiModel[] | null; failed: boolean } {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadAiModels()
      .then(m => { if (alive) setModels(m); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  return { models, failed };
}

/**
 * A model id field: pick from the catalogue, or type an id it doesn't list
 * yet (providers add models before anyone touches the ERP). The value is the
 * text as typed; callers check it. With `provider`, the field holds that
 * provider's own id, without the `anthropic:` / `openai:` prefix.
 */
export function ModelPicker({ value, onChange, id, placeholder, invalid = false, filter, unavailableText, provider }: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
  /** Narrows the catalogue to the models the caller can actually use. Keep it stable. */
  filter?: (m: AiModel) => boolean;
  /** What to say when the catalogue can't be loaded, for a caller that won't take a typed id. */
  unavailableText?: string;
  provider?: AiProviderId;
}) {
  const { t, locale } = useT();
  const { models, failed } = useAiModels();

  const shown = useMemo(() => (models ?? []).filter(m => !filter || filter(m)), [models, filter]);
  const label = (m: AiModel) => (provider ? parseModelRef(m.id).model : m.id);
  const byId = useMemo(() => new Map(shown.map(m => [label(m), m])), [shown, provider]);
  const options = useMemo(() => [...byId.keys()], [byId]);

  return (
    <>
      <Combobox
        id={id}
        className="input mono"
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        invalid={invalid}
        loading={models === null && !failed}
        meta={o => { const m = byId.get(o); return m ? modelMeta(m, locale, t) : undefined; }}
        emptyText={t('aiModelsUnavailable')}
      />
      {failed && <span className="help">{unavailableText ?? t('aiModelsUnavailable')}</span>}
    </>
  );
}
