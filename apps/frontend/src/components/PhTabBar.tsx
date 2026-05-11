import { Icon, type IconName } from './Icon';
import { useT } from '../lib/i18n';
import type { Role } from '../lib/types';

export type View = 'dashboard' | 'history' | 'submit' | 'market' | 'inventory' | 'me';

type Props = {
  view: View;
  setView: (v: View) => void;
  onCenterPress: () => void;
  role: Role;
};

export function PhTabBar({ view, setView, onCenterPress, role }: Props) {
  const { t } = useT();
  const fourth = role === 'manager'
    ? { id: 'inventory' as View, label: t('tabInventory'), icon: 'inventory' as IconName }
    : { id: 'market' as View,    label: t('tabMarket'),    icon: 'tag' as IconName };

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
