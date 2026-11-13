import { FB_CHAT_THREAD_FILTERS, type FbChatThreadFilter, type FbChatThreadRow } from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { fmtDateShort } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { fbChatThreadPath, hrefFor, onLinkClick } from '../../../../lib/route';
import { CHAT_SOURCE_CLASS, chatDaysAgo, chatFirstName } from './ChatHelpers';
import { AccountBadge, BuyerAvatar } from './shared';

// The left column of the Chats tab: search, the All / Unread / Not sent
// filter, and one row per chat, newest activity first.

// GET /threads answers at most this many; at the cap the count says so.
const LIST_CAP = 500;

const FILTER_KEY: Record<FbChatThreadFilter, string> = {
  all: 'fbcc_filterAll', unread: 'fbcc_filterUnread', failed: 'fbcc_filterFailed',
};

/** A clock time today, a weekday this week, a date before that. */
export function chatWhen(iso: string, nowMs: number, locale: string): string {
  const ago = chatDaysAgo(iso, nowMs);
  const d = new Date(iso);
  if (ago <= 0) return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (ago < 7) return d.toLocaleDateString(locale, { weekday: 'short' });
  return fmtDateShort(d, locale);
}

export type ChatListProps = {
  /** Null until the first answer. */
  threads: FbChatThreadRow[] | null;
  /** The read failed and there is nothing to show in its place. */
  failed: boolean;
  onRetry: () => void;
  openId: number | null;
  /** An account is picked on the strip, so rows need not name theirs. */
  oneAccount: boolean;
  search: string;
  onSearch: (text: string) => void;
  /** The search the rows on screen answer. */
  query: string;
  filter: FbChatThreadFilter;
  onFilter: (filter: FbChatThreadFilter) => void;
  now: number;
};

export function ChatList(p: ChatListProps) {
  const { t, locale } = useT();
  const n = p.threads?.length ?? 0;

  return (
    <div className="fbcc-col fbcc-list">
      <div className="fbcc-tools">
        <label className="fbcc-search">
          <Icon name="search" size={14} />
          <input
            className="input" type="search" value={p.search} onChange={e => p.onSearch(e.target.value)}
            placeholder={t('fbcc_search')} aria-label={t('fbcc_searchLabel')} maxLength={100}
          />
        </label>
        <div className="fbcc-tools-row">
          <div className="seg" role="group" aria-label={t('fbcc_show')}>
            {FB_CHAT_THREAD_FILTERS.map(f => (
              <button key={f} type="button" className={p.filter === f ? 'active' : ''} aria-pressed={p.filter === f} onClick={() => p.onFilter(f)}>
                {t(FILTER_KEY[f])}
              </button>
            ))}
          </div>
          {p.threads && (
            <span className="fbcc-count">{t(n >= LIST_CAP ? 'fbcc_countCapped' : 'fbcc_count', { n: n.toLocaleString(locale) })}</span>
          )}
        </div>
      </div>
      {!p.threads ? (
        p.failed
          ? <div className="fbcc-empty" role="alert">{t('fbcc_loadFailed')}<button type="button" className="btn sm" onClick={p.onRetry}>{t('fbcc_tryAgain')}</button></div>
          : <div className="fbcc-empty">{t('fbcc_loading')}</div>
      ) : n === 0 ? (
        <div className="fbcc-empty">{emptyText(p, t)}</div>
      ) : (
        <ul className="fbcc-convs">
          {p.threads.map(c => <ChatRow key={c.id} chat={c} open={c.id === p.openId} oneAccount={p.oneAccount} now={p.now} />)}
        </ul>
      )}
    </div>
  );
}

function emptyText(p: ChatListProps, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (p.query) return t('fbcc_emptySearch', { q: p.query });
  if (p.filter === 'failed') return t('fbcc_emptyFailed');
  if (p.filter === 'unread') return t(p.oneAccount ? 'fbcc_emptyUnreadAccount' : 'fbcc_emptyUnread');
  return t(p.oneAccount ? 'fbcc_emptyAccount' : 'fbcc_emptyAll');
}

function ChatRow({ chat, open, oneAccount, now }: { chat: FbChatThreadRow; open: boolean; oneAccount: boolean; now: number }) {
  const { t, locale } = useT();
  const path = fbChatThreadPath(chat.id);
  const last = chat.last_message;
  const name = chat.buyer_name ?? t('fbcc_unknownBuyer');

  return (
    <li>
      <a
        className={`fbcc-conv${chat.unread ? ' unread' : ''}${open ? ' on' : ''}`}
        href={hrefFor(path)} onClick={onLinkClick(path)} aria-current={open ? 'true' : undefined}
      >
        <span className="fbcc-avwrap">
          <BuyerAvatar name={chat.buyer_name} />
          <AccountBadge no={chat.account_no} label={chat.account_label} small />
        </span>
        <span className="fbcc-who">{name}{!oneAccount && <small>{chat.account_label}</small>}</span>
        <span className="fbcc-when">{chatWhen(chat.last_activity_at, now, locale)}</span>
        <span className="fbcc-prev">
          {last?.direction === 'out' && (
            <span className={`fbcc-pfx fbcc-pfx-${CHAT_SOURCE_CLASS[last.source]}`}>
              {last.source === 'facebook'
                ? t('fbcc_pfxFb')
                : `${t(last.source === 'telegram' ? 'fbcc_pfxTg' : 'fbcc_pfxErp')} ${chatFirstName(last.author_name)}`.trim()}
            </span>
          )}
          <span>{last ? last.body || (last.images > 0 ? t(last.direction === 'in' ? 'fbcc_photoIn' : 'fbcc_photo') : '') : ''}</span>
        </span>
        {chat.failed
          ? <span className="fbcc-fail" title={t('fbcc_notSentHint')}><Icon name="alert" size={14} /></span>
          : chat.unread ? <span className="fbcc-dot" role="img" aria-label={t('fbcc_unread')} /> : <span />}
      </a>
    </li>
  );
}
