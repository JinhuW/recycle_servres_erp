import { Icon, type IconName } from '../../../../components/Icon';
import { useFbChatSummary } from '../../../../lib/fbChat';
import { useT } from '../../../../lib/i18n';
import {
  FB_CHAT_TABS, fbChatTabPath, hrefFor, matchFbChatRoute, onLinkClick, useRoute, type FbChatTab,
} from '../../../../lib/route';
import { AccountsTab } from './AccountsTab';
import { ChatsTab } from './ChatsTab';
import { SettingsTab } from './SettingsTab';
import '../../../../styles/fbChat.css';

// ─── Leads ▸ Facebook ─────────────────────────────────────────────────────────
// Marketplace chats on the company's buyer accounts, relayed by a Chrome
// extension per account and mirrored into Telegram topics. Chats is the shared
// inbox, Accounts the accounts and the Chromes that relay them, Settings what
// the extensions load from the ERP. Managers only: the shell sends a purchaser
// Home before this renders.

export type FbChatTabProps = { showToast?: (message: string, kind?: 'success' | 'error') => void };

const TAB_ICON: Record<FbChatTab, IconName> = { chats: 'chats', accounts: 'users', settings: 'settings' };
const TAB_KEY: Record<FbChatTab, string> = { chats: 'fbc_tabChats', accounts: 'fbc_tabAccounts', settings: 'fbc_tabSettings' };
const LEDE: Record<FbChatTab, string> = { chats: 'fbc_ledeChats', accounts: 'fbc_ledeAccounts', settings: 'fbc_ledeSettings' };

export function FbChatsPage({ showToast }: FbChatTabProps) {
  const { path } = useRoute();
  const { t, locale } = useT();
  // This page's own route state can trail the shell's by a render while the
  // user leaves, so a path that is no longer ours reads as Chats.
  const route = matchFbChatRoute(path) ?? { tab: 'chats' as const, threadId: null };
  const tab = route.tab;
  const summary = useFbChatSummary(true);

  return (
    <>
      <div className="page-head"><div>
        <div className="page-sub">{t('nav_leads')} / {t('nav_leads_facebook')}</div>
        <h1 className="page-title">{t('fbc_title')}</h1>
      </div></div>
      <nav className="tabs fbc-tabs" aria-label={t('fbc_views')}>
        {FB_CHAT_TABS.map(id => {
          const href = fbChatTabPath(id);
          return (
            <a key={id} className={`tab ${tab === id ? 'active' : ''}`} href={hrefFor(href)} onClick={onLinkClick(href)} aria-current={tab === id ? 'page' : undefined}>
              <Icon name={TAB_ICON[id]} size={14} />{t(TAB_KEY[id])}
              {id === 'chats' && summary.unread > 0 && (
                <span className="chip muted" title={t('fbc_navHint', { n: summary.unread })}>{summary.unread.toLocaleString(locale)}</span>
              )}
              {id === 'accounts' && summary.pending_devices > 0 && (
                <span className="chip warn" title={t('fbc_pendingHint', { n: summary.pending_devices })}>{summary.pending_devices.toLocaleString(locale)}</span>
              )}
            </a>
          );
        })}
      </nav>
      <p className="fbc-lede">{t(LEDE[tab])}</p>
      {/* Chats fills the window and scrolls inside its own columns; the other
          two are ordinary pages that scroll as a whole. */}
      <div className={`fbc-body ${tab === 'chats' ? 'fbc-fill' : 'fbc-scroll'}`}>
        {tab === 'chats' && <ChatsTab threadId={route.threadId} showToast={showToast} />}
        {tab === 'accounts' && <AccountsTab showToast={showToast} />}
        {tab === 'settings' && <SettingsTab showToast={showToast} />}
      </div>
    </>
  );
}
