import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { usePreference } from '../lib/preferences';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useFocusTrap } from '../lib/useFocusTrap';
import { fmtUSD0 } from '../lib/format';
import {
  closeWalkthrough, placeCard, tourSteps, PHONE_SIDE,
  type Box, type Placement, type TourAnchor, type TourShell, type TourVisual,
} from '../lib/onboarding';

import '../styles/onboarding.css';

type Props = {
  shell: TourShell;
  // The last step's main button: Submit on desktop, the capture flow on the
  // phone. The walkthrough has already closed when it runs.
  onStartOrder: () => void;
};

// Where the anchor is on screen, re-read when the window moves under it. A
// missing or hidden anchor (a folded group, a screen without the tab bar)
// leaves the step centred instead of pointing at nothing.
function useAnchorBox(anchor: TourAnchor | null): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!anchor) { setBox(null); return; }
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
      const r = el?.getBoundingClientRect();
      setBox(r && r.width > 0 && r.height > 0
        ? { top: r.top, left: r.left, width: r.width, height: r.height }
        : null);
    };
    measure();
    // The sidebar's fold and the web fonts can still move things after the
    // first frame.
    const late = window.setTimeout(measure, 300);
    window.addEventListener('resize', measure);
    return () => { window.clearTimeout(late); window.removeEventListener('resize', measure); };
  }, [anchor]);
  return box;
}

function cardStyle(p: Placement): CSSProperties {
  switch (p.kind) {
    case 'center': return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    case 'right': return { top: p.top, left: p.left };
    case 'below': return { top: p.top, right: p.right };
    case 'above': return { bottom: p.bottom, left: PHONE_SIDE, right: PHONE_SIDE };
  }
}

function arrowStyle(p: Placement): CSSProperties | null {
  switch (p.kind) {
    case 'right': return { top: p.arrowTop };
    case 'below': return { right: p.arrowRight };
    case 'above': return p.arrowLeft == null ? null : { left: p.arrowLeft };
    default: return null;
  }
}

export function Walkthrough({ shell, onStartOrder }: Props) {
  const { t, lang, setLang } = useT();
  const { user } = useAuth();
  const [, setDone] = usePreference('onboarding.done', false);
  const steps = useMemo(() => tourSteps(shell), [shell]);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const box = useAnchorBox(step.anchor);

  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(cardRef);

  // Measured after each layout so placement can keep the card on screen.
  const [cardSize, setCardSize] = useState({ width: 420, height: 360 });
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { offsetWidth: width, offsetHeight: height } = el;
    setCardSize(s => (s.width === width && s.height === height ? s : { width, height }));
  });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useLayoutEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => { primaryRef.current?.focus(); }, []);

  // Skipping counts as done: it can be replayed, and asking again at every
  // sign-in is what makes people stop reading it.
  const finish = (startOrder: boolean) => {
    setDone(true);
    closeWalkthrough();
    if (startOrder) onStartOrder();
  };
  useEscapeKey(() => finish(false));

  const next = () => { if (last) finish(true); else setIndex(i => i + 1); };
  const back = () => setIndex(i => Math.max(0, i - 1));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight' && !last) { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); back(); }
  };

  const placement = placeCard(shell, box, viewport, cardSize);
  const arrow = arrowStyle(placement);
  // With nothing to point at, the hole shrinks to a point in the middle so
  // the next step's spotlight grows out of it instead of popping in.
  const spot: CSSProperties = box
    ? { top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 }
    : { top: viewport.height / 2, left: viewport.width / 2, width: 0, height: 0 };
  const firstName = (user?.name ?? '').split(/\s+/)[0] ?? '';

  return (
    <div className={'onb-root onb-' + shell}>
      <div className={'onb-spot' + (box ? ' on' : '')} style={spot} aria-hidden="true" />
      <div
        ref={cardRef}
        className={'onb-card onb-at-' + placement.kind}
        style={cardStyle(placement)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onb-title"
        aria-describedby="onb-body"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {arrow && <span className={'onb-arrow onb-arrow-' + placement.kind} style={arrow} aria-hidden="true" />}

        <div className="onb-top">
          <span className="onb-step mono">{t('onbStepOf', { n: index + 1, total: steps.length })}</span>
          <div className="seg onb-lang" role="group" aria-label={t('language')}>
            <button type="button" className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
            <button type="button" className={lang === 'zh' ? 'active' : ''} aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>中文</button>
          </div>
          <button type="button" className="btn ghost sm onb-skip" onClick={() => finish(false)}>
            {t('onbSkip')}
          </button>
        </div>

        <div className="onb-scroll">
          <StepVisual visual={step.visual} shell={shell} />
          <h2 id="onb-title" className="onb-title" aria-live="polite">
            {t(step.titleKey, { name: firstName })}
          </h2>
          <p id="onb-body" className="onb-body">{t(step.bodyKey)}</p>
          {step.pointKeys.length > 0 && (
            <ul className="onb-points">
              {step.pointKeys.map(k => (
                <li key={k}><Icon name="check2" size={13} /><span>{t(k)}</span></li>
              ))}
            </ul>
          )}
        </div>

        <div className={'onb-foot' + (last ? ' last' : '')}>
          <div className="onb-dots" aria-hidden="true">
            {steps.map((s, i) => <span key={s.id} className={i === index ? 'on' : i < index ? 'seen' : ''} />)}
          </div>
          {index > 0 && !last && (
            <button type="button" className="btn ghost" onClick={back}>{t('onbBack')}</button>
          )}
          {last && (
            <button type="button" className="btn ghost" onClick={() => finish(false)}>{t('onbExplore')}</button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className={'btn ' + (last ? 'accent' : 'primary')}
            onClick={next}
          >
            {last ? t('onbStartOrder') : index === 0 ? t('onbStart') : t('onbNext')}
            <Icon name="arrow" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step pictures ──────────────────────────────────────────────────────────
// Drawn from the same tokens as the screens they stand for, so the first
// time a purchaser meets the real one it already looks familiar.

function StepVisual({ visual, shell }: { visual: TourVisual; shell: TourShell }) {
  switch (visual) {
    case 'journey': return <Journey />;
    case 'numbers': return <Numbers />;
    case 'categories': return <Categories />;
    case 'handoff': return <Handoff />;
    case 'payment': return <Payment />;
    case 'stages': return <Stages />;
    case 'commission': return <Commission />;
    case 'tools': return <Tools shell={shell} />;
    case 'ready': return <Ready shell={shell} />;
  }
}

function Journey() {
  const { t } = useT();
  const items: { icon: IconName; key: string }[] = [
    { icon: 'search', key: 'onbJourneyFind' },
    { icon: 'camera', key: 'onbJourneyLog' },
    { icon: 'truck', key: 'onbJourneyShip' },
    { icon: 'dollar', key: 'onbJourneyPaid' },
  ];
  return (
    <ol className="onb-vis onb-journey">
      {items.map((it, i) => (
        <li key={it.key}>
          <span className="onb-journey-dot"><Icon name={it.icon} size={16} /></span>
          <span className="onb-journey-label"><span className="mono">{i + 1}</span>{t(it.key)}</span>
        </li>
      ))}
    </ol>
  );
}

function Numbers() {
  const { t, locale } = useT();
  return (
    <div className="onb-vis onb-numbers">
      <span className="chip muted onb-example">{t('onbExample')}</span>
      <div className="onb-tile wide">
        <span className="onb-tile-label">{t('profitYouGenerated')}</span>
        <span className="onb-tile-value pos">{fmtUSD0(2480, locale)}</span>
        <svg className="onb-spark" viewBox="0 0 120 28" aria-hidden="true">
          <path d="M2 24 L20 18 L36 21 L54 12 L72 15 L90 7 L118 4" />
        </svg>
      </div>
      <div className="onb-tile">
        <span className="onb-tile-label">{t('yourCommission')}</span>
        <span className="onb-tile-value">{fmtUSD0(1240, locale)}</span>
      </div>
      <div className="onb-tile">
        <span className="onb-tile-label">{t('yourRank')}</span>
        <span className="onb-tile-value">{t('onbRankOf', { n: 2, total: 6 })}</span>
      </div>
    </div>
  );
}

function Categories() {
  const { t } = useT();
  const cats: { label: string; icon: IconName; tone: string }[] = [
    { label: 'RAM', icon: 'chip', tone: 'info' },
    { label: 'SSD', icon: 'drive', tone: 'pos' },
    { label: 'HDD', icon: 'drive', tone: 'cool' },
    { label: t('onbCatOther'), icon: 'box', tone: 'warn' },
  ];
  return (
    <div className="onb-vis onb-cats">
      <div className="onb-cat-row">
        {cats.map(c => (
          <span key={c.label} className={'onb-cat ' + c.tone}>
            <Icon name={c.icon} size={18} /><span>{c.label}</span>
          </span>
        ))}
      </div>
      <div className="onb-scanline">
        <Icon name="sparkles" size={14} />
        <span>{t('onbAiReads')}</span>
      </div>
    </div>
  );
}

function Handoff() {
  const { t } = useT();
  return (
    <div className="onb-vis onb-handoff">
      <span className="onb-pill draft">{t('poStageDraft')}</span>
      <span className="onb-handoff-btn"><Icon name="truck" size={14} />{t('hoTitle')}</span>
      <Icon name="arrow" size={14} className="onb-handoff-to" />
      <span className="onb-pill transit">{t('poStageInTransit')}</span>
    </div>
  );
}

function Payment() {
  const { t } = useT();
  const opts: { icon: IconName; title: string; need: string }[] = [
    { icon: 'dollar', title: t('onbPayPaypalTitle'), need: t('onbPayPaypalNeed') },
    { icon: 'cash', title: t('onbPayCashTitle'), need: t('onbPayCashNeed') },
    { icon: 'user', title: t('onbPaySelfTitle'), need: t('onbPaySelfNeed') },
  ];
  return (
    <div className="onb-vis onb-pay">
      {opts.map(o => (
        <div key={o.title} className="onb-pay-opt">
          <span className="onb-pay-icon"><Icon name={o.icon} size={15} /></span>
          <span className="onb-pay-text">
            <span className="onb-pay-title">{o.title}</span>
            <span className="onb-pay-need">{o.need}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Stages() {
  const { t } = useT();
  const stages: { key: string; who: 'you' | 'mgr' }[] = [
    { key: 'poStageDraft', who: 'you' },
    { key: 'poStageInTransit', who: 'you' },
    { key: 'poStageReviewing', who: 'mgr' },
    { key: 'poStageReadyToPay', who: 'mgr' },
    { key: 'poStageDone', who: 'mgr' },
  ];
  return (
    <div className="onb-vis onb-stages">
      <ol>
        {stages.map(s => (
          <li key={s.key} className={s.who}>
            <span className="onb-stage-dot" />
            <span className="onb-stage-name">{t(s.key)}</span>
            <span className="onb-stage-who">{t(s.who === 'you' ? 'onbWhoYou' : 'onbWhoManager')}</span>
          </li>
        ))}
      </ol>
      <div className="onb-stage-window"><span>{t('onbEditWindow')}</span></div>
    </div>
  );
}

function Commission() {
  const { t, locale } = useT();
  const usd = (n: number) => fmtUSD0(n, locale);
  return (
    <div className="onb-vis onb-comm">
      <span className="chip muted onb-example">{t('onbExample')}</span>
      <div className="onb-comm-row"><span>{t('onbCommSell')}</span><span className="mono">{usd(1600)}</span></div>
      <div className="onb-comm-row"><span>{t('onbCommCost')}</span><span className="mono">−{usd(1000)}</span></div>
      <div className="onb-comm-row sub"><span>{t('onbCommProfit')}</span><span className="mono">{usd(600)}</span></div>
      <div className="onb-comm-row"><span>{t('onbCommRate')}</span><span className="mono">× 50%</span></div>
      <div className="onb-comm-row total"><span>{t('yourCommission')}</span><span className="mono">{usd(300)}</span></div>
      <div className="onb-comm-self">
        <Icon name="user" size={13} />
        <span>{t('onbCommSelf', { cost: usd(1000), total: usd(1300) })}</span>
      </div>
    </div>
  );
}

function Tools({ shell }: { shell: TourShell }) {
  const { t } = useT();
  const rows: { icon: IconName; title: string; sub: string }[] = shell === 'desktop'
    ? [
        { icon: 'tag', title: t('nav_market'), sub: t('onbToolMarket') },
        { icon: 'book', title: t('nav_clients'), sub: t('onbToolClients') },
        { icon: 'shield', title: t('fpTitle'), sub: t('onbToolPool') },
      ]
    : [
        { icon: 'tag', title: t('tabMarket'), sub: t('onbToolMarket') },
        { icon: 'bell', title: t('notifications'), sub: t('onbToolNotify') },
        { icon: 'dashboard', title: t('onbToolDesktopTitle'), sub: t('onbToolDesktop') },
      ];
  return (
    <div className="onb-vis onb-tools">
      {rows.map(r => (
        <div key={r.title} className="onb-tool">
          <span className="onb-tool-icon"><Icon name={r.icon} size={15} /></span>
          <span className="onb-tool-text">
            <span className="onb-tool-title">{r.title}</span>
            <span className="onb-tool-sub">{r.sub}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Ready({ shell }: { shell: TourShell }) {
  const { t } = useT();
  return (
    <div className="onb-vis onb-ready">
      <span className="onb-ready-mark"><Icon name="check2" size={26} stroke={2.2} /></span>
      {shell === 'phone' && (
        <span className="onb-ready-tip"><Icon name="zap" size={13} />{t('onbInstallTip')}</span>
      )}
    </div>
  );
}
