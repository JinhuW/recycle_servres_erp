import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useEffectiveUser } from '../lib/tweaks';
import type { Role } from '../lib/types';

export type DesktopView =
  | 'dashboard' | 'submit' | 'history' | 'market'
  | 'inventory' | 'analysis' | 'sellorders' | 'vendorbids' | 'transfers'
  | 'activity' | 'settings';

type NavItem = { id: DesktopView; tKey: string; icon: IconName; roles: Role[]; badge?: string };

// Two groups: where you do the work, and where you check it. Activity and
// Settings are the latter — neither is a place a purchase gets made.
const NAV: { tKey: string; items: NavItem[] }[] = [
  {
    tKey: 'workspace',
    items: [
      { id: 'dashboard',  tKey: 'nav_dashboard',  icon: 'dashboard',  roles: ['manager', 'purchaser'] },
      { id: 'submit',     tKey: 'nav_submit',     icon: 'submit',     roles: ['manager', 'purchaser'], badge: '+' },
      { id: 'history',    tKey: 'nav_history',    icon: 'history',    roles: ['manager', 'purchaser'] },
      { id: 'market',     tKey: 'nav_market',     icon: 'tag',        roles: ['manager', 'purchaser'] },
      { id: 'inventory',  tKey: 'nav_inventory',  icon: 'inventory',  roles: ['manager'] },
      { id: 'sellorders', tKey: 'nav_sellorders', icon: 'tag',        roles: ['manager'] },
      { id: 'vendorbids', tKey: 'nav_vendorbids', icon: 'invoice',    roles: ['manager'] },
      { id: 'transfers',  tKey: 'nav_transfers',  icon: 'truck',      roles: ['manager'] },
    ],
  },
  {
    tKey: 'nav_group_oversight',
    items: [
      { id: 'activity',   tKey: 'nav_activity',   icon: 'clock',      roles: ['manager'] },
      { id: 'settings',   tKey: 'nav_settings',   icon: 'settings',   roles: ['manager'] },
    ],
  },
];

type Props = {
  view: DesktopView;
  setView: (v: DesktopView) => void;
};

export function Sidebar({ view, setView }: Props) {
  const { t } = useT();
  const { logout } = useAuth();
  const user = useEffectiveUser();
  if (!user) return null;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">RS</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name">{t('appBrand')}</div>
          <div className="brand-sub">{t('brandSub')}</div>
        </div>
      </div>

      {/* Analysis lives as a tab under Inventory — keep Inventory lit there. */}
      {NAV.map(group => {
        const items = group.items.filter(n => n.roles.includes(user.role));
        if (!items.length) return null;
        return (
          <div key={group.tKey} className="nav-group">
            <div className="nav-section">{t(group.tKey)}</div>
            {items.map(n => {
              const active = view === n.id || (n.id === 'inventory' && view === 'analysis');
              return (
                <button
                  key={n.id}
                  className={'nav-item ' + (active ? 'active' : '')}
                  onClick={() => setView(n.id)}
                >
                  <Icon name={n.icon} size={15} className="nav-icon" />
                  <span>{t(n.tKey)}</span>
                  {n.badge && <span className="badge">{n.badge}</span>}
                </button>
              );
            })}
          </div>
        );
      })}

      <div className="sidebar-foot">
        <div className="avatar">{user.initials}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="avatar-name">{user.name}</div>
          <div className="avatar-role">{user.role === 'manager' ? t('role_manager') : t('role_purchaser')}</div>
        </div>
        <button className="btn icon sm" onClick={logout} title={t('signOut')}>
          <Icon name="logout" size={14} />
        </button>
      </div>
    </aside>
  );
}
