import { useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
// The settings panels + their modals/dialogs/shared primitives were extracted
// verbatim into ./settings/* — pure code-motion, no logic or JSX changes.
import { MembersPanel } from './settings/MembersPanel';
import { WarehousesPanel } from './settings/WarehousesPanel';
import { CustomersPanel } from './settings/CustomersPanel';
import { CategoriesPanel } from './settings/CategoriesPanel';
import { GeneralPanel } from './settings/GeneralPanel';
import { DesktopSettingsConnectors } from './DesktopSettingsConnectors';

// ─── Shell ────────────────────────────────────────────────────────────────────
type SectionId = 'members' | 'warehouses' | 'customers' | 'categories' | 'general' | 'connectors';

const SECTIONS: { id: SectionId; label: string; sub: string; icon: IconName; managerOnly?: boolean }[] = [
  { id: 'members',    label: 'Members',    sub: 'People & roles',     icon: 'user' },
  { id: 'warehouses', label: 'Warehouses', sub: 'Locations',          icon: 'warehouse' },
  { id: 'customers',  label: 'Customers',  sub: 'Buyers & accounts',  icon: 'shield' },
  { id: 'categories', label: 'Categories', sub: 'Items & SKUs',       icon: 'box' },
  { id: 'general',    label: 'General',    sub: 'Workspace',          icon: 'settings' },
  { id: 'connectors', label: 'Connectors', sub: 'OAuth & scraper',    icon: 'chip', managerOnly: true },
];

export function DesktopSettings({ showToast }: { showToast?: (msg: string, kind?: 'success' | 'error') => void }) {
  const { t } = useT();
  const { user } = useAuth();
  const [section, setSection] = useState<SectionId>('members');
  const sections = SECTIONS.filter(s => !s.managerOnly || user?.role === 'manager');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('settings')}</h1>
          <div className="page-sub">{t('settingsSub')}</div>
        </div>
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(s => (
            <button
              key={s.id}
              className={'settings-nav-item ' + (section === s.id ? 'active' : '')}
              onClick={() => setSection(s.id)}
            >
              <span className="settings-nav-icon"><Icon name={s.icon} size={14} /></span>
              <span className="settings-nav-text">
                <span className="settings-nav-label">{s.id === 'connectors' ? t('connectorsTab') : s.label}</span>
                <span className="settings-nav-sub">{s.sub}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {section === 'members'    && <MembersPanel    showToast={showToast} />}
          {section === 'warehouses' && <WarehousesPanel showToast={showToast} />}
          {section === 'customers'  && <CustomersPanel  showToast={showToast} />}
          {section === 'categories' && <CategoriesPanel />}
          {section === 'general'    && <GeneralPanel />}
          {section === 'connectors' && <DesktopSettingsConnectors />}
        </div>
      </div>
    </>
  );
}
