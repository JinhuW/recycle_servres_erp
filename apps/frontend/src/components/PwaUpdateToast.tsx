import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { applyPwaUpdate } from '../lib/pwa';
import { useT } from '../lib/i18n';

export function PwaUpdateToast() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onNeedRefresh = () => setOpen(true);
    window.addEventListener('pwa:needRefresh', onNeedRefresh as EventListener);
    return () => window.removeEventListener('pwa:needRefresh', onNeedRefresh as EventListener);
  }, []);

  if (!open) return null;

  // The SW skip-waiting → controllerchange handoff reloads the page; keep the
  // button busy in the meantime so the tap reads as acknowledged.
  const reload = () => {
    setBusy(true);
    applyPwaUpdate();
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
      <button type="button" className="pwa-update-cta" onClick={reload} data-busy={busy}>
        <span className={busy ? 'pwa-update-spin' : undefined}>
          <Icon name="refresh" size={14} />
        </span>
        {t('pwa.update.cta')}
      </button>
    </div>
  );
}
