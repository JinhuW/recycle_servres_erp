import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import type { Role, Lang } from '../lib/types';

export type DesktopView =
  | 'dashboard' | 'submit' | 'history' | 'market'
  | 'inventory' | 'sellorders' | 'settings';

const NAV: { id: DesktopView; tKey: string; icon: IconName; roles: Role[]; badge?: string }[] = [
  { id: 'dashboard',  tKey: 'nav_dashboard',  icon: 'dashboard',  roles: ['manager', 'purchaser'] },
  { id: 'submit',     tKey: 'nav_submit',     icon: 'submit',     roles: ['purchaser'], badge: '+' },
  { id: 'history',    tKey: 'nav_history',    icon: 'history',    roles: ['manager', 'purchaser'] },
  { id: 'market',     tKey: 'nav_market',     icon: 'tag',        roles: ['manager', 'purchaser'] },
  { id: 'inventory',  tKey: 'nav_inventory',  icon: 'inventory',  roles: ['manager'] },
  { id: 'sellorders', tKey: 'nav_sellorders', icon: 'tag',        roles: ['manager'] },
  { id: 'settings',   tKey: 'nav_settings',   icon: 'settings',   roles: ['manager'] },
];

function LanguageToggle() {
  const { lang, setLang, t } = useT();
  const opts: { v: Lang; label: string }[] = [
    { v: 'en', label: 'EN' },
    { v: 'zh', label: '中' },
  ];
  return (
    <div
      role="group"
      aria-label={t('languageLabel')}
      style={{
        display: 'inline-flex', alignItems: 'center',
        background: 'var(--bg-soft)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 2, fontSize: 11.5, fontWeight: 600,
      }}
    >
      {opts.map(o => {
        const active = lang === o.v;
        return (
          <button
            key={o.v}
            onClick={() => setLang(o.v)}
            aria-pressed={active}
            title={o.v === 'en' ? 'English' : '简体中文'}
            style={{
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              padding: '4px 10px', borderRadius: 6, minWidth: 28,
              background: active ? 'var(--bg-elev)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-subtle)',
              boxShadow: active ? '0 1px 2px rgba(15,23,42,0.06)' : 'none',
              fontSize: 11.5, fontWeight: 600,
              letterSpacing: o.v === 'zh' ? 0 : '0.04em',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

type Props = {
  view: DesktopView;
  setView: (v: DesktopView) => void;
};

export function Sidebar({ view, setView }: Props) {
  const { t } = useT();
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">RS</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name">{t('appBrand')}</div>
          <div className="brand-sub">{t('brandSub')}</div>
        </div>
        <LanguageToggle />
      </div>

      <div className="nav-section">{t('workspace')}</div>
      {NAV.filter(n => n.roles.includes(user.role)).map(n => (
        <button
          key={n.id}
          className={'nav-item ' + (view === n.id ? 'active' : '')}
          onClick={() => setView(n.id)}
        >
          <Icon name={n.icon} size={15} className="nav-icon" />
          <span>{t(n.tKey)}</span>
          {n.badge && <span className="badge">{n.badge}</span>}
        </button>
      ))}

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
