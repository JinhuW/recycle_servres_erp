import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';

// Chrome's BeforeInstallPromptEvent isn't in lib.dom.d.ts.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DISMISS_KEY = 'pwa:installDismissedAt';
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

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

export function PwaInstallPrompt() {
  const { t } = useT();
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    if (isIos()) setShowIosHint(true);

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  const accept = async () => {
    if (!evt) return;
    await evt.prompt();
    await evt.userChoice;
    setEvt(null);
  };

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
    setEvt(null);
    setShowIosHint(false);
  };

  if (evt) {
    return (
      <div className="pwa-install-prompt" role="dialog" aria-label={t('pwa.install.cta')}>
        <button type="button" className="pwa-install-cta" onClick={accept}>
          {t('pwa.install.cta')}
        </button>
        <button type="button" className="pwa-install-dismiss" onClick={dismiss}>
          {t('pwa.install.dismiss')}
        </button>
      </div>
    );
  }
  if (showIosHint) {
    return (
      <div className="pwa-install-prompt pwa-install-prompt--ios" role="status">
        <span>{t('pwa.install.iosHint')}</span>
        <button type="button" className="pwa-install-dismiss" onClick={dismiss}>
          {t('pwa.install.dismiss')}
        </button>
      </div>
    );
  }
  return null;
}
