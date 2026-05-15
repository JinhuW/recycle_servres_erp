import { useT } from '../lib/i18n';
import { useEffectiveUser } from '../lib/tweaks';

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
    </div>
  );
}
