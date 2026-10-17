import { useMemo, useState, type ReactNode } from 'react';
import type { FilterPrompt, FleetDoc, ReviewStatsDay } from '../../lib/coordinator';
import { FLOW_STAGES, flowCounts, type FlowStage } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';

// ─── From a search to an alert ────────────────────────────────────────────────
// The pipeline a Marketplace listing goes through, stage by stage, as the
// monitor and the coordinator run it (see FLOW_STAGES in lib/fleetView.ts):
// the cheap keyword gates first, the model only on what survives them. Each
// stage names the code behind it and the settings it reads from the fleet
// document; settings are read-only here because nothing writes master.toml
// from the ERP yet. Counts exist only where the coordinator keeps them.

type Setting = { label: string; value: string; fixed?: boolean };

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

export function FlowCard({ fleet, stats, prompt }: {
  fleet: FleetDoc | null;
  stats: ReviewStatsDay[] | 'unavailable' | null;
  prompt: FilterPrompt | 'unavailable' | null;
}) {
  const { t, locale } = useT();
  const [stage, setStage] = useState<FlowStage>('ai');
  const counts = flowCounts(Array.isArray(stats) ? stats : null);
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const items = (fleet?.items ?? []).filter(i => i.enabled);

  const extra: ReactNode = (() => {
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
      if (!prompt || prompt === 'unavailable') return <span className="fp-muted">{t('fbcFlowPromptUnavailable')}</span>;
      return (
        <>
          <div className="fp-section-label">{t('fbcPromptMain')}</div>
          <pre className="ff-prompt">{prompt.prompt}</pre>
          {prompt.rating_prompt && <>
            <div className="fp-section-label">{t('fbcPromptRating')}</div>
            <pre className="ff-prompt">{prompt.rating_prompt}</pre>
          </>}
        </>
      );
    }
    return null;
  })();

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
              className={`ff-stage${k === 'ai' || k === 'alert' ? ' ff-stage-key' : ''}`} onClick={() => setStage(k)}>
              <span className="ff-stage-title">{t(`fbcFlow_${k}`)}</span>
              <span className="ff-stage-n" title={n === undefined ? t('fbcFlowNotCounted') : undefined}>
                {n === undefined ? '—' : fmt.format(n)}
              </span>
              <span className="ff-stage-unit">{n === undefined ? t('fbcFlowNotCounted') : t(`fbcFlowUnit_${k}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="ff-flow-detail" role="tabpanel">
        <div>
          <div className="ff-flow-head">
            <h3>{t(`fbcFlow_${stage}`)}</h3>
            <span className="mono fp-muted">{t(`fbcFlowWhere_${stage}`)}</span>
          </div>
          <p className="ff-flow-what">{t(`fbcFlowWhat_${stage}`)}</p>
          <div className="ff-settings">
            {stageSettings(t, stage, fleet).map(s => (
              <span key={s.label} className={`ff-setting${s.fixed ? ' ff-fixed' : ''}`}
                title={s.fixed ? t('fbcFixedHint') : t('fbcSettingsReadOnly')}>
                {s.label} <b>{s.value}</b>
              </span>
            ))}
          </div>
        </div>
        {extra && <div className="ff-flow-extra">{extra}</div>}
      </div>
    </section>
  );
}
