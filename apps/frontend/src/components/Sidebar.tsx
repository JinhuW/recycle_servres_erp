import { Fragment, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useEffectiveUser } from '../lib/tweaks';
import { shownNav, type ShownLeaf } from '../lib/desktopNav';
import { DESKTOP_VIEW_TO_PATH, hrefFor, onLinkClick, type DesktopViewId } from '../lib/route';

export type DesktopView = DesktopViewId;

type Props = {
  view: DesktopView;
  // Folded = the icon rail at any width. Under 900px the rail is forced by
  // CSS and the toggle is hidden, whatever this says.
  folded: boolean;
  onToggleFold: () => void;
};

// Nav items are real anchors so ⌘-click / middle-click open a tab; a plain
// click still routes through navigate() (see onLinkClick).
function NavLink({ view, className, label, icon, current, children }: {
  view: DesktopViewId;
  className: string;
  label: string;
  icon: IconName;
  current?: boolean;
  children?: ReactNode;
}) {
  const path = DESKTOP_VIEW_TO_PATH[view];
  return (
    <a
      className={className}
      href={hrefFor(path)}
      onClick={onLinkClick(path)}
      aria-current={current ? 'page' : undefined}
      // The rail hides the label with display:none, which takes it out of
      // the accessibility tree too.
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={15} className="nav-icon" />
      <span>{label}</span>
      {children}
    </a>
  );
}

function LeafLink({ item, sub }: { item: ShownLeaf; sub?: boolean }) {
  const { t } = useT();
  const { leaf, active } = item;
  return (
    <NavLink
      view={leaf.id}
      className={'nav-item' + (sub ? ' nav-sub' : '') + (active ? ' active' : '')}
      label={t(leaf.tKey)}
      icon={leaf.icon}
      current={active}
    >
      {leaf.badge && <span className="badge">{leaf.badge}</span>}
    </NavLink>
  );
}

export function Sidebar({ view, folded, onToggleFold }: Props) {
  const { t } = useT();
  const { logout } = useAuth();
  const user = useEffectiveUser();
  if (!user) return null;
  const foldLabel = folded ? t('sidebarExpand') : t('sidebarCollapse');
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">RS</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="brand-name">{t('appBrand')}</div>
          <div className="brand-sub">{t('brandSub')}</div>
        </div>
        <button
          type="button"
          className="btn ghost icon sm sidebar-toggle"
          onClick={onToggleFold}
          aria-expanded={!folded}
          aria-label={foldLabel}
          title={foldLabel}
        >
          <Icon name={folded ? 'chevronRight' : 'chevronLeft'} size={14} />
        </button>
      </div>

      {shownNav(user.role, view).map(group => (
        <div key={group.tKey} className="nav-group">
          <div className="nav-section">{t(group.tKey)}</div>
          {group.items.map(item => {
            if (item.kind === 'leaf') return <LeafLink key={item.leaf.id} item={item} />;
            const label = t(item.parent.tKey);
            return (
              <Fragment key={item.parent.tKey}>
                {/* Not aria-current: while it is open, the page is one of its
                    children. */}
                <NavLink
                  view={item.target}
                  className={'nav-item nav-parent' + (item.open ? ' open' : '')}
                  label={label}
                  icon={item.parent.icon}
                >
                  <span className="nav-caret">
                    <Icon name={item.open ? 'chevronDown' : 'chevronRight'} size={13} />
                  </span>
                </NavLink>
                {item.open && (
                  <div className="nav-children" role="group" aria-label={label}>
                    {item.children.map(c => <LeafLink key={c.leaf.id} item={c} sub />)}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
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
