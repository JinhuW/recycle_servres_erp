import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../../../components/Icon';
import { fbMockOn, useFbSellerSummary } from '../../../../lib/fbSeller';
import { useT } from '../../../../lib/i18n';
import { fbSellerTabPath, hrefFor, matchFbSellerRoute, onLinkClick, useRoute, type FbSellerTab } from '../../../../lib/route';
import { AdsTab } from './AdsTab';
import { AgentTab } from './AgentTab';
import { ThreadList } from './ThreadList';
import { ThreadView } from './ThreadView';
import { PhotosTab } from './PhotosTab';
import { SettingsTab } from './SettingsTab';
import '../../../../styles/redditLeads.css';
import '../../../../styles/fbSeller.css';

// ─── Leads ▸ Facebook ─────────────────────────────────────────────────────────
// Conversations on the fleet's seller accounts, the "we buy" ads they post,
// the photo pools those ads draw from, and the agent that answers sellers.
// Manager-only (DesktopApp bounces anyone else). Needs human is the default:
// it is the only tab where somebody is waiting.

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
  const { t, locale } = useT();
  const route = matchFbSellerRoute(path);
  // A thread belongs to the conversations, so it keeps Inbox lit.
  const tab: FbSellerTab = route?.kind === 'tab' ? route.tab : 'inbox';
  const s = useFbSellerSummary();

  // The count beside a tab, and whether it is work waiting (warn) or a tally.
  const counts: Partial<Record<FbSellerTab, { n: number; hot: boolean; hint?: string }>> = s ? {
    needs: { n: s.needs_human, hot: s.needs_human > 0 },
    inbox: { n: s.unread, hot: false, hint: t('fbs_count_unread', { n: s.unread }) },
    ...(s.uncertain_placements + s.needs_photos > 0 ? { ads: { n: s.uncertain_placements + s.needs_photos, hot: true, hint: t('fbs_count_ads', { uncertain: s.uncertain_placements, short: s.needs_photos }) } } : {}),
    ...(s.low_pools > 0 ? { photos: { n: s.low_pools, hot: true, hint: t('fbs_count_low_pools', { n: s.low_pools }) } } : {}),
  } : {};

  let body: ReactNode;
  if (route?.kind === 'thread') body = <ThreadView key={route.id} id={route.id} />;
  else if (tab === 'needs') body = <ThreadList view="needs_human" />;
  else if (tab === 'inbox') body = <ThreadList view="inbox" />;
  else if (tab === 'ads') body = <AdsTab />;
  else if (tab === 'photos') body = <PhotosTab />;
  else if (tab === 'agent') body = <AgentTab />;
  else body = <SettingsTab />;

  return (
    <>
      <div className="page-head"><div>
        <div className="page-sub">{t('nav_leads')} / {t('nav_leads_facebook')}</div>
        <h1 className="page-title">{t('fbs_title')}</h1>
      </div>
      {fbMockOn() && <span className="chip warn" title={t('fbs_mock_hint')}>{t('fbs_mock')}</span>}
      </div>
      <nav className="tabs rl-tabs" aria-label={t('fbs_views')}>
        {TABS.map(x => {
          const href = fbSellerTabPath(x.id);
          const c = counts[x.id];
          return (
            <a key={x.id} className={`tab ${tab === x.id ? 'active' : ''}`} href={hrefFor(href)} onClick={onLinkClick(href)} aria-current={tab === x.id ? 'page' : undefined}>
              <Icon name={x.icon} size={14} />{t(x.key)}
              {c && <span className={`chip muted${c.hot ? ' rl-hot' : ''}`} title={c.hint}>{c.n.toLocaleString(locale)}</span>}
            </a>
          );
        })}
      </nav>
      {route?.kind !== 'thread' && (
        <div className="rl-tab-head"><p className="rl-lede">{t(`fbs_lede_${tab}`)}</p></div>
      )}
      {body}
    </>
  );
}
