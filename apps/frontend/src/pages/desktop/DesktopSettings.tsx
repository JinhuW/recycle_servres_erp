import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { useAppVersion } from '../../lib/useAppVersion';
// The settings panels + their modals/dialogs/shared primitives were extracted
// verbatim into ./settings/* — pure code-motion, no logic or JSX changes.
import { MembersPanel } from './settings/MembersPanel';
import { WarehousesPanel } from './settings/WarehousesPanel';
import { CustomersPanel } from './settings/CustomersPanel';
import { CategoriesPanel } from './settings/CategoriesPanel';
import { GeneralPanel } from './settings/GeneralPanel';
import { AccountPanel } from './settings/AccountPanel';
import { FxRatesPanel } from '../../components/FxRatesPanel';
import { DesktopSettingsConnectors } from './DesktopSettingsConnectors';

// ─── Shell ────────────────────────────────────────────────────────────────────
type SectionId = 'account' | 'members' | 'warehouses' | 'customers' | 'categories' | 'general' | 'fx' | 'connectors';

// Section labels are looked up via t() at render time — id ↔ tKey is the
// only declarative mapping we need; pluralization / casing belongs to the
// dictionary.
const SECTIONS: { id: SectionId; labelKey: string; subKey: string; icon: IconName; managerOnly?: boolean }[] = [
  { id: 'account',    labelKey: 'settingsNavAccount',    subKey: 'settingsNavAccountSub',    icon: 'lock' },
  { id: 'members',    labelKey: 'settingsNavMembers',    subKey: 'settingsNavMembersSub',    icon: 'user' },
  { id: 'warehouses', labelKey: 'settingsNavWarehouses', subKey: 'settingsNavWarehousesSub', icon: 'warehouse' },
  { id: 'customers',  labelKey: 'settingsNavCustomers',  subKey: 'settingsNavCustomersSub',  icon: 'shield' },
  { id: 'categories', labelKey: 'settingsNavCategories', subKey: 'settingsNavCategoriesSub', icon: 'box' },
  { id: 'general',    labelKey: 'settingsNavGeneral',    subKey: 'settingsNavGeneralSub',    icon: 'settings' },
  { id: 'fx',         labelKey: 'settingsNavFx',         subKey: 'settingsNavFxSub',         icon: 'refresh', managerOnly: true },
  { id: 'connectors', labelKey: 'connectorsTab',         subKey: 'settingsNavConnectorsSub', icon: 'chip', managerOnly: true },
];

export function DesktopSettings({ showToast }: { showToast?: (msg: string, kind?: 'success' | 'error') => void }) {
  const { t } = useT();
  const { user } = useAuth();
  const [section, setSection] = useState<SectionId>('account');
  const sections = SECTIONS.filter(s => !s.managerOnly || user?.role === 'manager');
  const build = useAppVersion();

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('settings')}</h1>
          <div className="page-sub">{t('settingsSub')}</div>
        </div>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label={t('settingsNavAriaLabel')}>
          {sections.map(s => (
            <button
              key={s.id}
              className={'settings-nav-item ' + (section === s.id ? 'active' : '')}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon"><Icon name={s.icon} size={14} /></span>
              <span className="settings-nav-text">
                <span className="settings-nav-label">{t(s.labelKey)}</span>
                <span className="settings-nav-sub">{t(s.subKey)}</span>
              </span>
            </button>
          ))}
          {build && (
            <div className="settings-nav-version mono" title={build.commit}>
              v{build.version} · {build.commit}
            </div>
          )}
        </nav>

        <div className="settings-body">
          {section === 'account'    && <AccountPanel    showToast={showToast} />}
          {section === 'members'    && <MembersPanel    showToast={showToast} />}
          {section === 'warehouses' && <WarehousesPanel showToast={showToast} />}
          {section === 'customers'  && <CustomersPanel  showToast={showToast} />}
          {section === 'categories' && <CategoriesPanel />}
          {section === 'general'    && <GeneralPanel />}
          {section === 'fx'         && <FxRatesPanel />}
          {section === 'connectors' && <DesktopSettingsConnectors />}
        </div>
      </div>
    </>
  );
}
