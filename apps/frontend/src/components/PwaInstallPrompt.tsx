import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useT } from '../lib/i18n';

// Chrome's BeforeInstallPromptEvent isn't in lib.dom.d.ts.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'pwa:installDismissedAt';
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const CARD_DELAY_MS = 1400; // let the first screen settle before inviting

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent)
    && !(window.navigator as { MSStream?: unknown }).MSStream;
}

type Phase = 'hidden' | 'card' | 'sheet';

export function PwaInstallPrompt() {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('hidden');
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const ios = isIos();

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
      setPhase(p => (p === 'hidden' ? 'card' : p));
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // iOS never fires beforeinstallprompt, so invite after a gentle delay.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (isIos()) timer = setTimeout(() => setPhase(p => (p === 'hidden' ? 'card' : p)), CARD_DELAY_MS);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      if (timer) clearTimeout(timer);
    };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setPhase('hidden');
  };

  const nativeInstall = async () => {
    if (!evt) { setPhase('sheet'); return; }
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    setEvt(null);
    if (outcome === 'accepted') setPhase('hidden');
    else dismiss();
  };

  if (phase === 'hidden') return null;

  return (
    <>
      {phase === 'card' && (
        <IntroCard
          ios={ios}
          canNativeInstall={!!evt}
          onPrimary={() => (evt ? nativeInstall() : setPhase('sheet'))}
          onExpand={() => setPhase('sheet')}
          onDismiss={dismiss}
        />
      )}
      {phase === 'sheet' && (
        <IntroSheet
          ios={ios}
          canNativeInstall={!!evt}
          onInstall={nativeInstall}
          onClose={() => setPhase('card')}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

/* ── Collapsed invitation, floats just above the tab bar ── */
function IntroCard({ ios, canNativeInstall, onPrimary, onExpand, onDismiss }: {
  ios: boolean;
  canNativeInstall: boolean;
  onPrimary: () => void;
  onExpand: () => void;
  onDismiss: () => void;
}) {
  const { t } = useT();
  const primaryLabel = canNativeInstall ? t('pwa.intro.install') : t('pwa.intro.howTo');
  return (
    <div className="pwa-intro-card" role="dialog" aria-label={t('pwa.intro.sheetTitle')}>
      <button type="button" className="pwa-intro-card-body" onClick={onExpand} aria-label={t('pwa.intro.howTo')}>
        <span className="pwa-intro-mark" aria-hidden>
          <span className="brand-mark" />
        </span>
        <span className="pwa-intro-card-copy">
          <span className="pwa-intro-card-title">{t('pwa.intro.title')}</span>
          <span className="pwa-intro-card-sub">{t('pwa.intro.subtitle')}</span>
        </span>
      </button>
      <div className="pwa-intro-card-actions">
        <button type="button" className="pwa-intro-primary" onClick={onPrimary}>
          {!ios && canNativeInstall && <Icon name="download" size={14} />}
          {primaryLabel}
        </button>
        <button type="button" className="pwa-intro-close" onClick={onDismiss} aria-label={t('pwa.intro.dismiss')}>
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}

/* ── Full introduction sheet ── */
function IntroSheet({ ios, canNativeInstall, onInstall, onClose, onDismiss }: {
  ios: boolean;
  canNativeInstall: boolean;
  onInstall: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const { t } = useT();
  const benefits: { icon: IconName; title: string; sub: string }[] = [
    { icon: 'zap',       title: t('pwa.intro.benefit.fast.title'),    sub: t('pwa.intro.benefit.fast.sub') },
    { icon: 'refresh',   title: t('pwa.intro.benefit.offline.title'), sub: t('pwa.intro.benefit.offline.sub') },
    { icon: 'box',       title: t('pwa.intro.benefit.home.title'),    sub: t('pwa.intro.benefit.home.sub') },
    { icon: 'image',     title: t('pwa.intro.benefit.share.title'),   sub: t('pwa.intro.benefit.share.sub') },
  ];

  return (
    <>
      <div className="pwa-intro-backdrop" onClick={onClose} />
      <div className="pwa-intro-sheet" role="dialog" aria-modal="true" aria-label={t('pwa.intro.sheetTitle')}>
        <div className="ph-sheet-grabber" />

        <header className="pwa-intro-hero">
          <span className="pwa-intro-hero-tile" aria-hidden>
            <span className="brand-mark" style={{ width: 40, height: 40 }} />
          </span>
          <div className="pwa-intro-hero-copy">
            <div className="pwa-intro-hero-title">{t('pwa.intro.sheetTitle')}</div>
            <div className="pwa-intro-hero-tagline">{t('pwa.intro.tagline')}</div>
          </div>
          <button type="button" className="pwa-intro-sheet-x" onClick={onClose} aria-label={t('pwa.intro.close')}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <ul className="pwa-intro-benefits">
          {benefits.map((b, i) => (
            <li key={b.icon} className="pwa-intro-benefit" style={{ animationDelay: `${80 + i * 55}ms` }}>
              <span className="pwa-intro-benefit-icon"><Icon name={b.icon} size={16} /></span>
              <span className="pwa-intro-benefit-copy">
                <span className="pwa-intro-benefit-title">{b.title}</span>
                <span className="pwa-intro-benefit-sub">{b.sub}</span>
              </span>
            </li>
          ))}
        </ul>

        {ios ? (
          <div className="pwa-intro-steps">
            <div className="pwa-intro-steps-head">{t('pwa.intro.ios.heading')}</div>
            <Step n={1} text={t('pwa.intro.ios.step1')} glyph={<ShareGlyph />} />
            <Step n={2} text={t('pwa.intro.ios.step2')} glyph={<AddGlyph />} />
            <Step n={3} text={t('pwa.intro.ios.step3')} />
            <p className="pwa-intro-note">{t('pwa.intro.ios.note')}</p>
          </div>
        ) : (
          <div className="pwa-intro-install-block">
            <button type="button" className="pwa-intro-install-btn" onClick={onInstall} disabled={!canNativeInstall}>
              <Icon name="download" size={16} />
              {t('pwa.intro.android.cta')}
            </button>
            <p className="pwa-intro-note">{t('pwa.intro.android.note')}</p>
          </div>
        )}

        <button type="button" className="pwa-intro-later" onClick={onDismiss}>
          {t('pwa.intro.dismiss')}
        </button>
      </div>
    </>
  );
}

function Step({ n, text, glyph }: { n: number; text: string; glyph?: JSX.Element }) {
  return (
    <div className="pwa-intro-step">
      <span className="pwa-intro-step-n">{n}</span>
      <span className="pwa-intro-step-text">{text}</span>
      {glyph && <span className="pwa-intro-step-glyph" aria-hidden>{glyph}</span>}
    </div>
  );
}

/* iOS toolbar Share glyph (box with up-arrow). */
function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
    </svg>
  );
}

/* "Add to Home Screen" glyph (plus in a rounded square). */
function AddGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  );
}
