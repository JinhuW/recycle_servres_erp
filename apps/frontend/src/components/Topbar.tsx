import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { useEffectiveUser } from '../lib/tweaks';
import { openWalkthrough } from '../lib/onboarding';

// Thin top label that prefixes every page with the workspace context.
// Mirrors the design's Topbar (app.jsx:15-25).
export function Topbar() {
  const { t } = useT();
  const user = useEffectiveUser();
  if (!user) return null;
  const label = user.role === 'manager' ? t('adminWorkspace') : t('purchaserWorkspace');
  return (
    <div className="topbar">
      <span className="topbar-label">{label}</span>
      <button
        type="button"
        className="btn ghost sm topbar-guide"
        onClick={openWalkthrough}
        title={t('onbGuideHint')}
        data-tour="guide"
      >
        <Icon name="book" size={13} />
        {t('onbGuide')}
      </button>
    </div>
  );
}
