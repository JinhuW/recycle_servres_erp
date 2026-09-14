import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';

export type View = 'dashboard' | 'history' | 'submit' | 'shipping' | 'market' | 'inventory' | 'me';

type Props = {
  view: View;
  setView: (v: View) => void;
  onCenterPress: () => void;
};

export function PhTabBar({ view, setView, onCenterPress }: Props) {
  const { t } = useT();
  // Shipping is unlisted for now: a box is handed off from the order itself
  // (the In Transit sheet), so the tab had nothing left to start. The screen
  // still resolves by URL. Market and Inventory live as quick links on Home.
  const tabs: { id: View; label: string; icon: IconName; center?: boolean }[] = [
    { id: 'dashboard', label: t('tabHome'),    icon: 'dashboard' },
    { id: 'history',   label: t('tabOrders'),  icon: 'history' },
    { id: 'submit',    label: t('tabCapture'), icon: 'camera', center: true },
    { id: 'me',        label: t('tabProfile'), icon: 'user' },
  ];

  return (
    <div className="ph-tabbar">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={'ph-tab ' + (view === tab.id ? 'active' : '') + (tab.center ? ' center' : '')}
          onClick={() => tab.center ? onCenterPress() : setView(tab.id)}
        >
          {tab.center ? (
            <div className="center-fab"><Icon name={tab.icon} size={22} /></div>
          ) : (
            <>
              <Icon name={tab.icon} size={20} />
              <span>{tab.label}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
