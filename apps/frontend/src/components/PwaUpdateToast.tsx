import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { applyPwaUpdate, pwaUpdatePending } from '../lib/pwa';
import { BUNDLE_STALE_EVENT, bundleStale, watchBundleVersion } from '../lib/buildVersion';
import { useT } from '../lib/i18n';
import { confirmDiscard, withConfirmedUnload } from '../lib/unsavedGuard';

import '../styles/pwa.css';

// The phone shell's update arrives through its service worker.
export function PwaUpdateToast() {
  return <UpdateToast pending={pwaUpdatePending} event="pwa:needRefresh" apply={applyPwaUpdate} />;
}

// The desktop shell has no service worker; it compares its own build with the
// one deployed, and a plain reload fetches the new one.
export function BundleUpdateToast() {
  useEffect(() => watchBundleVersion(), []);
  return <UpdateToast pending={bundleStale} event={BUNDLE_STALE_EVENT} apply={() => window.location.reload()} />;
}

function UpdateToast({ pending, event, apply }: {
  pending: () => boolean;
  event: string;
  apply: () => void | Promise<void>;
}) {
  const { t } = useT();
  // Initial state, not just the event: this component is lazy-loaded, so an
  // event fired before mount would otherwise be lost for good.
  const [open, setOpen] = useState(() => pending());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onPending = () => setOpen(true);
    window.addEventListener(event, onPending);
    // Dismissal is a snooze, not a decline — the old build keeps serving until
    // the update is applied, so re-surface when the user comes back to the app.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && pending()) setOpen(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(event, onPending);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pending, event]);

  if (!open) return null;

  // Applying reloads the page, after a service-worker handoff on the phone;
  // keep the button busy in the meantime so the tap reads as acknowledged.
  // iOS and iPadOS show no beforeunload prompt, so unsaved edits are guarded
  // here, and the browser's own prompt is then skipped. Busy clears once apply
  // returns: a handoff that never fired must leave the button usable.
  const reload = async () => {
    if (busy || !(await confirmDiscard())) return;
    setBusy(true);
    try {
      await withConfirmedUnload(apply);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pwa-update-toast" role="status" aria-live="polite">
      <div className="pwa-update-head">
        <span className="pwa-update-spark" aria-hidden>
          <Icon name="sparkles" size={18} />
          <span className="pwa-update-pip" />
        </span>
        <span className="pwa-update-copy">
          <span className="pwa-update-title">{t('pwa.update.title')}</span>
          <span className="pwa-update-sub">{t('pwa.update.subtitle')}</span>
        </span>
        <button
          type="button"
          className="pwa-update-dismiss"
          onClick={() => setOpen(false)}
          aria-label={t('pwa.update.dismiss')}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      <button type="button" className="pwa-update-cta" onClick={() => { void reload(); }} data-busy={busy}>
        <span className={busy ? 'pwa-update-spin' : undefined}>
          <Icon name="refresh" size={14} />
        </span>
        {t('pwa.update.cta')}
      </button>
    </div>
  );
}
