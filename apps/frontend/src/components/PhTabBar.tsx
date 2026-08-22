import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import type { Role } from '../lib/types';

export type View = 'dashboard' | 'history' | 'submit' | 'shipping' | 'market' | 'inventory' | 'me';

type Props = {
  view: View;
  setView: (v: View) => void;
  onCenterPress: () => void;
  role: Role;
};

export function PhTabBar({ view, setView, onCenterPress, role }: Props) {
  const { t } = useT();
  // Purchasers get Shipping where Market used to sit — their field work is
  // inbound boxes, and Market keeps a quick link on Home. Managers keep
  // Inventory; they reach /shipping through the Home inbound card.
  const fourth = role === 'manager'
    ? { id: 'inventory' as View, label: t('tabInventory'), icon: 'inventory' as IconName }
    : { id: 'shipping' as View,  label: t('tabShipping'),  icon: 'truck' as IconName };

  const tabs: { id: View; label: string; icon: IconName; center?: boolean }[] = [
    { id: 'dashboard', label: t('tabHome'),    icon: 'dashboard' },
    { id: 'history',   label: t('tabOrders'),  icon: 'history' },
    { id: 'submit',    label: t('tabCapture'), icon: 'camera', center: true },
    fourth,
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
