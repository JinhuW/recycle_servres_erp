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
  // Shipping for every role: purchasers track the boxes they buy, managers
  // receive them at the dock (and scan labels there). Market and Inventory
  // both live as quick links on Home instead.
  const tabs: { id: View; label: string; icon: IconName; center?: boolean }[] = [
    { id: 'dashboard', label: t('tabHome'),    icon: 'dashboard' },
    { id: 'history',   label: t('tabOrders'),  icon: 'history' },
    { id: 'submit',    label: t('tabCapture'), icon: 'camera', center: true },
    { id: 'shipping',  label: t('tabShipping'), icon: 'truck' },
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
