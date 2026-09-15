import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import { MOBILE_VIEW_TO_PATH, hrefFor, onLinkClick, type MobileViewId } from '../lib/route';

export type View = 'dashboard' | 'history' | 'submit' | 'shipping' | 'market' | 'inventory' | 'me';

type Props = {
  view: View;
  onCenterPress: () => void;
};

// A route tab is a real anchor (⌘-click / middle-click open a tab, plain click
// routes in place); the centre capture tab is an action, so it stays a button.
type Tab =
  | { id: MobileViewId; label: string; icon: IconName; center?: false }
  | { id: 'submit'; label: string; icon: IconName; center: true };

export function PhTabBar({ view, onCenterPress }: Props) {
  const { t } = useT();
  // Shipping is unlisted for now: a box is handed off from the order itself
  // (the In Transit sheet), so the tab had nothing left to start. The screen
  // still resolves by URL. Market and Inventory live as quick links on Home.
  const tabs: Tab[] = [
    { id: 'dashboard', label: t('tabHome'),    icon: 'dashboard' },
    { id: 'history',   label: t('tabOrders'),  icon: 'history' },
    { id: 'submit',    label: t('tabCapture'), icon: 'camera', center: true },
    { id: 'me',        label: t('tabProfile'), icon: 'user' },
  ];

  return (
    <div className="ph-tabbar">
      {tabs.map(tab => {
        const cls = 'ph-tab ' + (view === tab.id ? 'active' : '');
        if (tab.center) {
          return (
            <button key={tab.id} className={cls + ' center'} onClick={onCenterPress}>
              <div className="center-fab"><Icon name={tab.icon} size={22} /></div>
            </button>
          );
        }
        const path = MOBILE_VIEW_TO_PATH[tab.id];
        return (
          <a
            key={tab.id}
            className={cls}
            href={hrefFor(path)}
            onClick={onLinkClick(path)}
            aria-current={view === tab.id ? 'page' : undefined}
          >
            <Icon name={tab.icon} size={20} />
            <span>{tab.label}</span>
          </a>
        );
      })}
    </div>
  );
}
