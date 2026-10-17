import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Skeleton } from '../../components/Skeleton';
import { coordinatorApi, type FilterPrompt, type FleetDoc, type ReviewStatsDay } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import {
  FLOW_STAGES, STAGE_FORMS, flowCounts, settingsDraft, settingsPatch,
  type FlowStage, type ItemField, type SearchField, type SettingsDraft,
} from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';

// ─── From a search to an alert ────────────────────────────────────────────────
// The pipeline a Marketplace listing goes through, stage by stage, as the
// monitor and the coordinator run it (see FLOW_STAGES in lib/fleetView.ts):
// the cheap keyword gates first, the model only on what survives them. Each
// stage names the code behind it and the settings it reads; a stage with
// settings has an Edit form (STAGE_FORMS) that the console writes into every
// worker's config. Counts are today's fleet totals from /v1/stats/reviews.

type Setting = { label: string; value: string; fixed?: boolean };

// What Facebook's own filters accept; the console checks the same lists.
const DATE_WINDOWS = ['all', 'last 24 hours', 'last 7 days', 'last 30 days'] as const;
const DELIVERY = ['local_pick_up', 'shipping', 'all'] as const;

// The settings a stage reads, from /v1/fleet. `fixed` marks behaviour that is
// code, not config, so a reader does not go looking for the knob.
function stageSettings(t: Translate, stage: FlowStage, fleet: FleetDoc | null): Setting[] {
  const s = fleet?.search ?? {};
  const items = (fleet?.items ?? []).filter(i => i.enabled);
  const window = Array.isArray(s.date_listed) ? s.date_listed[s.date_listed.length - 1] : s.date_listed;
  const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((n, i) => n + f(i), 0);
  const v = (x: unknown) => (x === undefined || x === null || x === '' ? '—' : String(x));
  switch (stage) {
    case 'search': return [
      { label: t('fbcSetPhrases'), value: String(sum(i => i.search_phrases.length)) },
      { label: t('fbcSetStartAt'), value: s.start_at?.length ? s.start_at.join(', ') : '—' },
      { label: t('fbcSetWindow'), value: v(window) },
      { label: t('fbcSetDelivery'), value: v(s.delivery_method?.replace(/_/g, ' ')) },
      { label: t('fbcSetMaxResults'), value: v(s.max_results) },
      { label: t('fbcSetInterval'), value: s.search_interval ? `${s.search_interval} – ${s.max_search_interval ?? s.search_interval}` : '—' },
      { label: t('fbcFixedFloor'), value: '30', fixed: true },
    ];
    case 'cards': return [
      { label: t('fbcSetMaxResults'), value: v(s.max_results) },
      { label: t('fbcFixedSeenOnce'), value: t('fbcFixedPerSweep'), fixed: true },
    ];
    case 'title': return [
      { label: t('fbcSetPrefilter'), value: s.title_prefilter == null ? '—' : s.title_prefilter ? t('fbcOn') : t('fbcOff') },
      { label: t('fbcSetAntikeywords'), value: String(sum(i => i.antikeywords.length)) },
    ];
    case 'open': return [
      { label: t('fbcFixedPause'), value: '5 s', fixed: true },
      { label: t('fbcFixedCache'), value: t('fbcFixedCacheBy'), fixed: true },
      { label: t('fbcFixedAffiliate'), value: t('fbcFixedSkipped'), fixed: true },
    ];
    case 'keywords': return [
      { label: t('fbcSetKeywords'), value: String(sum(i => i.keywords.length)) },
      { label: t('fbcSetAntikeywords'), value: String(sum(i => i.antikeywords.length)) },
      { label: t('fbcSetSellerRating'), value: s.min_seller_rating == null ? '—' : `${s.min_seller_rating} / 5` },
      { label: t('fbcSetUnrated'), value: s.exclude_unrated_sellers == null ? '—' : s.exclude_unrated_sellers ? t('fbcSetDropped') : t('fbcSetAllowed') },
    ];
    case 'fresh': return [{ label: t('fbcFixedNotified'), value: t('fbcFixedPerUser'), fixed: true }];
    case 'ai': return [
      { label: t('fbcSetRating'), value: s.rating == null ? '—' : `${s.rating} / 5` },
      { label: t('fbcSetMinUnits'), value: v(s.min_unit_count) },
      { label: t('fbcSetModel'), value: v(fleet?.ai_model) },
    ];
    case 'coordinator': return [
      { label: t('fbcFixedDedupe'), value: t('fbcFixedItemId'), fixed: true },
      { label: t('fbcFixedOutbox'), value: t('fbcFixedDurable'), fixed: true },
    ];
    case 'alert': return [{ label: t('fbcFixedTopics'), value: '50+ / 10–49 / 5–9', fixed: true }];
  }
}

const SEARCH_LABEL: Record<SearchField, string> = {
  start_at: 'fbcSetStartAt',
  date_listed: 'fbcSetWindow',
  delivery_method: 'fbcSetDelivery',
  max_results: 'fbcSetMaxResults',
  search_interval: 'fbcSetIntervalMin',
  max_search_interval: 'fbcSetIntervalMax',
  title_prefilter: 'fbcSetPrefilter',
  min_seller_rating: 'fbcSetSellerRating',
  exclude_unrated_sellers: 'fbcSetUnrated',
  rating: 'fbcSetRating',
  min_unit_count: 'fbcSetMinUnits',
};

const ITEM_LABEL: Record<ItemField, string> = {
  search_phrases: 'fbcFlowPhrasesOf',
  keywords: 'fbcFlowKeywordsOf',
  antikeywords: 'fbcFlowAntiOf',
};

export function FlowCard({ fleet, stats, prompt, onSaved }: {
  fleet: FleetDoc | null;
  stats: ReviewStatsDay[] | 'unavailable' | null;
  prompt: FilterPrompt | 'unavailable' | null;
  onSaved: () => void;
}) {
  const { t, locale } = useT();
  const [stage, setStage] = useState<FlowStage>('ai');
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = flowCounts(Array.isArray(stats) ? stats : null);
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const items = (fleet?.items ?? []).filter(i => i.enabled);
  const form = STAGE_FORMS[stage];
  const editable = !!fleet?.settings?.editable;
  const loadedPrompt = prompt && prompt !== 'unavailable' ? prompt : null;

  const pick = (k: FlowStage) => {
    if (busy) return;
    setStage(k);
    setDraft(null);
  };
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft(d => (d ? { ...d, [key]: value } : d));
  const setItem = (name: string, field: ItemField, value: string) =>
    setDraft(d => (d ? { ...d, items: { ...d.items, [name]: { ...d.items[name], [field]: value } } } : d));

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    coordinatorApi.saveSettings(settingsPatch(stage, draft, !!loadedPrompt))
      .then(() => {
        showSuccessToast(t('fbcEditSaved', { stage: t(`fbcFlow_${stage}`) }));
        setDraft(null);
        onSaved();
      })
      .catch(handleFetchError)
      .finally(() => setBusy(false));
  };

  const control = (key: SearchField): ReactNode => {
    if (!draft) return null;
    switch (key) {
      case 'title_prefilter':
      case 'exclude_unrated_sellers':
        return (
          <label className="ff-edit-check">
            <input type="checkbox" checked={draft[key]} onChange={e => set(key, e.target.checked)} />
            {t(key === 'title_prefilter' ? 'fbcEditPrefilterOn' : 'fbcEditDropUnrated')}
          </label>
        );
      case 'date_listed':
        return (
          <select className="input" value={draft.date_listed} onChange={e => set('date_listed', e.target.value)}>
            {DATE_WINDOWS.map(w => <option key={w} value={w}>{t(`fbcWindow_${w.replace(/ /g, '_')}`)}</option>)}
          </select>
        );
      case 'delivery_method':
        return (
          <select className="input" value={draft.delivery_method} onChange={e => set('delivery_method', e.target.value)}>
            {DELIVERY.map(d => <option key={d} value={d}>{t(`fbcDelivery_${d}`)}</option>)}
          </select>
        );
      case 'rating':
        return (
          <select className="input" value={draft.rating} onChange={e => set('rating', e.target.value)}>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={String(n)}>{n} / 5</option>)}
          </select>
        );
      case 'max_results':
      case 'min_unit_count':
      case 'min_seller_rating':
        return (
          <input className="input" type="number" inputMode="decimal" value={draft[key]}
            min={key === 'min_seller_rating' ? 0 : 1} max={key === 'min_seller_rating' ? 5 : undefined}
            step={key === 'min_seller_rating' ? 0.1 : 1} onChange={e => set(key, e.target.value)} />
        );
      default:
        return (
          <input className="input" value={draft[key]} onChange={e => set(key, e.target.value)}
            placeholder={key === 'start_at' ? '10:00, 22:00' : '45m'} />
        );
    }
  };

  const editingExtra: ReactNode = draft && form ? (
    <>
      {form.items.length > 0 && Object.entries(draft.items).map(([name, fields]) => (
        <div key={name} className="ff-flow-group">
          {form.items.map(f => (
            <label key={f} className="ff-edit-field">
              <span className="fp-section-label">{t(ITEM_LABEL[f], { item: name })}</span>
              <textarea className="input ff-edit-list" value={fields[f]} spellCheck={false}
                rows={Math.min(10, Math.max(3, fields[f].split('\n').length + 1))}
                onChange={e => setItem(name, f, e.target.value)} />
            </label>
          ))}
        </div>
      ))}
      {form.items.length > 0 && <span className="fp-muted ff-edit-hint">{t('fbcEditOnePerLine')}</span>}
      {form.ai && (loadedPrompt ? (
        <>
          <label className="ff-edit-field">
            <span className="fp-section-label">{t('fbcPromptMain')}</span>
            <textarea className="input ff-edit-prompt" value={draft.prompt} rows={12}
              onChange={e => set('prompt', e.target.value)} />
          </label>
          <label className="ff-edit-field">
            <span className="fp-section-label">{t('fbcPromptRating')}</span>
            <textarea className="input ff-edit-prompt" value={draft.rating_prompt} rows={10}
              onChange={e => set('rating_prompt', e.target.value)} />
          </label>
        </>
      ) : <span className="fp-muted">{t('fbcEditPromptUnavailable')}</span>)}
    </>
  ) : null;

  const extra: ReactNode = (() => {
    if (editingExtra) return editingExtra;
    if (stage === 'search') {
      return items.map(i => (
        <div key={i.name} className="ff-flow-group">
          <div className="fp-section-label">{t('fbcFlowPhrasesOf', { item: i.name })}</div>
          <div className="fl-cities">{i.search_phrases.map(p => <span key={p} className="chip muted">{p}</span>)}</div>
        </div>
      ));
    }
    if (stage === 'title' || stage === 'keywords') {
      return items.map(i => (
        <div key={i.name} className="ff-flow-group">
          <div className="fp-section-label">{t('fbcFlowKeywordsOf', { item: i.name })}</div>
          {stage === 'keywords' && i.keywords.map(k => <div key={k} className="ff-rule">{k}</div>)}
          <div className="fp-section-label">{t('fbcFlowAntiOf', { item: i.name })}</div>
          {i.antikeywords.length ? i.antikeywords.map(k => <div key={k} className="ff-rule">{k}</div>) : <span className="fp-muted">{t('fbcNone')}</span>}
        </div>
      ));
    }
    if (stage === 'ai') {
      if (prompt === null) {
        return (
          <div className="ff-flow-group" aria-busy="true">
            <Skeleton width={110} height={10} />
            {['92%', '85%', '96%', '70%', '88%', '60%'].map((w, i) => <Skeleton key={i} width={w} height={11} />)}
          </div>
        );
      }
      if (!loadedPrompt) return <span className="fp-muted">{t('fbcFlowPromptUnavailable')}</span>;
      return (
        <>
          <div className="fp-section-label">{t('fbcPromptMain')}</div>
          <pre className="ff-prompt">{loadedPrompt.prompt}</pre>
          {loadedPrompt.rating_prompt && <>
            <div className="fp-section-label">{t('fbcPromptRating')}</div>
            <pre className="ff-prompt">{loadedPrompt.rating_prompt}</pre>
          </>}
        </>
      );
    }
    return null;
  })();

  const saved = fleet?.settings?.updated_at
    ? t('fbcEditLastSaved', {
      who: fleet.settings.updated_by ?? '—',
      when: new Date(fleet.settings.updated_at).toLocaleString(locale),
    })
    : null;

  return (
    <section className="card ff-flow" aria-label={t('fbcFlowTitle')}>
      <div className="card-head">
        <h2 className="card-title">{t('fbcFlowTitle')}</h2>
        <span className="card-sub">{t('fbcFlowSub')}</span>
      </div>
      <div className="ff-flow-row" role="tablist" aria-label={t('fbcFlowTitle')}>
        {FLOW_STAGES.map(k => {
          const n = counts[k];
          return (
            <button key={k} type="button" role="tab" aria-selected={stage === k}
              className={`ff-stage${k === 'ai' || k === 'alert' ? ' ff-stage-key' : ''}`} onClick={() => pick(k)}>
              <span className="ff-stage-title">{t(`fbcFlow_${k}`)}</span>
              {stats === null ? <>
                <span className="ff-stage-n"><Skeleton width={34} height={22} /></span>
                <span className="ff-stage-unit"><Skeleton width={70} height={10} /></span>
              </> : <>
                <span className="ff-stage-n" title={n === undefined ? t('fbcFlowNotCounted') : undefined}>
                  {n === undefined ? '—' : fmt.format(n)}
                </span>
                <span className="ff-stage-unit">{n === undefined ? t('fbcFlowNotCounted') : t(`fbcFlowUnit_${k}`)}</span>
              </>}
            </button>
          );
        })}
      </div>
      <form className="ff-flow-detail" role="tabpanel" onSubmit={save}>
        <div>
          <div className="ff-flow-head">
            <h3>{t(`fbcFlow_${stage}`)}</h3>
            <span className="mono fp-muted">{t(`fbcFlowWhere_${stage}`)}</span>
            {form && !draft && (
              <button type="button" className="btn sm ff-edit-btn" disabled={!editable || !fleet}
                title={editable ? undefined : t('fbcSettingsReadOnly')}
                onClick={() => fleet && setDraft(settingsDraft(fleet, loadedPrompt))}>
                {t('fbcEditStage')}
              </button>
            )}
          </div>
          <p className="ff-flow-what">{t(`fbcFlowWhat_${stage}`)}</p>
          {draft && form ? (
            <div className="ff-edit">
              <div className="ff-edit-grid">
                {form.search.map(key => (
                  <label key={key} className="ff-edit-field">
                    <span>{t(SEARCH_LABEL[key])}</span>
                    {control(key)}
                    {key === 'start_at' && <span className="fp-muted ff-edit-hint">{t('fbcEditStartAtHint')}</span>}
                  </label>
                ))}
                {form.ai && (
                  <label className="ff-edit-field">
                    <span>{t('fbcSetModel')}</span>
                    <input className="input" value={draft.ai_model} spellCheck={false}
                      onChange={e => set('ai_model', e.target.value)} />
                  </label>
                )}
              </div>
              <p className="ff-edit-note">{t('fbcEditSweepNote')}</p>
              <div className="ff-edit-actions">
                <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>{t('cancel')}</button>
                <button type="submit" className="btn primary" disabled={busy}>{busy ? t('fbcEditSaving') : t('fbcEditSave')}</button>
              </div>
            </div>
          ) : (
            <div className="ff-settings">
              {stageSettings(t, stage, fleet).map(s => (
                <span key={s.label} className={`ff-setting${s.fixed ? ' ff-fixed' : ''}`}
                  title={s.fixed ? t('fbcFixedHint') : editable ? t('fbcSettingsEditable') : t('fbcSettingsReadOnly')}>
                  {s.label} <b>{s.value}</b>
                </span>
              ))}
            </div>
          )}
          {!form && <p className="ff-edit-note">{t('fbcEditNothing')}</p>}
          {form && saved && !draft && <p className="ff-edit-note">{saved}</p>}
        </div>
        {extra && <div className="ff-flow-extra">{extra}</div>}
      </form>
    </section>
  );
}
