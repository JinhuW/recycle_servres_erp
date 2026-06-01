import { useEffect, useState } from 'react';
import { applyPwaUpdate } from '../lib/pwa';
import { useT } from '../lib/i18n';

export function PwaUpdateToast() {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onNeedRefresh = () => setOpen(true);
    window.addEventListener('pwa:needRefresh', onNeedRefresh as EventListener);
    return () => window.removeEventListener('pwa:needRefresh', onNeedRefresh as EventListener);
  }, []);

  if (!open) return null;
  return (
    <div className="pwa-update-toast" role="status" aria-live="polite">
      <span>{t('pwa.update.title')}</span>
      <button type="button" className="pwa-update-cta" onClick={() => applyPwaUpdate()}>
        {t('pwa.update.cta')}
      </button>
      <button type="button" className="pwa-update-dismiss" onClick={() => setOpen(false)}>
        {t('pwa.update.dismiss')}
      </button>
    </div>
  );
}
