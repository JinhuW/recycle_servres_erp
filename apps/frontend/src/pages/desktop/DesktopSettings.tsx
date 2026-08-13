import { lazy, Suspense, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { useAppVersion } from '../../lib/useAppVersion';
import { fmtDate } from '../../lib/format';
// The settings panels + their modals/dialogs/shared primitives were extracted
// verbatim into ./settings/* — pure code-motion, no logic or JSX changes.
// AccountPanel is the section Settings opens on, so it stays in this chunk;
// the rest load when their tab is picked.
import { AccountPanel } from './settings/AccountPanel';

const MembersPanel = lazy(() => import('./settings/MembersPanel').then(m => ({ default: m.MembersPanel })));
const WarehousesPanel = lazy(() => import('./settings/WarehousesPanel').then(m => ({ default: m.WarehousesPanel })));
const CustomersPanel = lazy(() => import('./settings/CustomersPanel').then(m => ({ default: m.CustomersPanel })));
const CategoriesPanel = lazy(() => import('./settings/CategoriesPanel').then(m => ({ default: m.CategoriesPanel })));
const GeneralPanel = lazy(() => import('./settings/GeneralPanel').then(m => ({ default: m.GeneralPanel })));
const FxRatesPanel = lazy(() => import('../../components/FxRatesPanel').then(m => ({ default: m.FxRatesPanel })));
const DesktopSettingsConnectors = lazy(() => import('./DesktopSettingsConnectors').then(m => ({ default: m.DesktopSettingsConnectors })));

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
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
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
            // The sha stays reachable on hover — it's what a deploy check needs
            // and what the date can't tell you.
            <div className="settings-nav-version mono" title={build.commit}>
              v{build.version}
              {build.builtAt && ` · ${fmtDate(build.builtAt, locale)}`}
            </div>
          )}
        </nav>

        <div className="settings-body">
          <Suspense fallback={<div className="settings-panel-loading" />}>
            {section === 'account'    && <AccountPanel    showToast={showToast} />}
            {section === 'members'    && <MembersPanel    showToast={showToast} />}
            {section === 'warehouses' && <WarehousesPanel showToast={showToast} />}
            {section === 'customers'  && <CustomersPanel  showToast={showToast} />}
            {section === 'categories' && <CategoriesPanel />}
            {section === 'general'    && <GeneralPanel />}
            {section === 'fx'         && <FxRatesPanel />}
            {section === 'connectors' && <DesktopSettingsConnectors />}
          </Suspense>
        </div>
      </div>
    </>
  );
}
