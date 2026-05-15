import { useAuth } from '../lib/auth';
import { useTweaks } from '../lib/tweaks';
import { Icon } from './Icon';

// Shown when a manager has the rolePreview tweak set to "as_purchaser".
// Mirrors the design's _previewing banner (app.jsx:279-284).
export function RolePreviewBanner() {
  const { user } = useAuth();
  const { rolePreview } = useTweaks();
  if (!user || user.role !== 'manager' || rolePreview !== 'as_purchaser') return null;
  const firstName = user.name.split(' ')[0];
  return (
    <div className="role-preview-banner">
      <Icon name="eye" size={13} />
      <span>
        Previewing as <strong>Purchaser</strong> — you're seeing what {firstName} sees with
        restricted access.
      </span>
    </div>
  );
}
