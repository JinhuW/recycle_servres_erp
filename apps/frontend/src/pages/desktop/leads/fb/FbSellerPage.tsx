import { Icon, type IconName } from '../../../../components/Icon';
import { useT } from '../../../../lib/i18n';
import { fbSellerTabPath, hrefFor, matchFbSellerRoute, onLinkClick, useRoute, type FbSellerTab } from '../../../../lib/route';

// ─── Leads ▸ Facebook ─────────────────────────────────────────────────────────
// Conversations on the fleet's seller accounts, the "we buy" ads they post,
// the photo pools those ads draw from, and the agent that answers sellers.
// Manager-only. Each tab is still to come.

const TABS: { id: FbSellerTab; icon: IconName; key: string }[] = [
  { id: 'needs', icon: 'alert', key: 'fbs_tab_needs' },
  { id: 'inbox', icon: 'chats', key: 'fbs_tab_inbox' },
  { id: 'ads', icon: 'tag', key: 'fbs_tab_ads' },
  { id: 'photos', icon: 'image', key: 'fbs_tab_photos' },
  { id: 'agent', icon: 'sparkles', key: 'fbs_tab_agent' },
  { id: 'settings', icon: 'settings', key: 'fbs_tab_settings' },
];

export function FbSellerPage() {
  const { path } = useRoute();
  const { t } = useT();
  const route = matchFbSellerRoute(path);
  // A thread belongs to the conversations, so it keeps Inbox lit.
  const tab: FbSellerTab = route?.kind === 'tab' ? route.tab : 'inbox';

  return (
    <>
      <div className="page-head"><div>
        <div className="page-sub">{t('nav_leads')} / {t('nav_leads_facebook')}</div>
        <h1 className="page-title">{t('fbs_title')}</h1>
      </div></div>
      <nav className="tabs" aria-label={t('fbs_views')}>
        {TABS.map(x => {
          const href = fbSellerTabPath(x.id);
          return (
            <a key={x.id} className={`tab ${tab === x.id ? 'active' : ''}`} href={hrefFor(href)} onClick={onLinkClick(href)} aria-current={tab === x.id ? 'page' : undefined}>
              <Icon name={x.icon} size={14} />{t(x.key)}
            </a>
          );
        })}
      </nav>
      <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--fg-muted)' }}>{t('fbs_coming_soon')}</div>
    </>
  );
}
