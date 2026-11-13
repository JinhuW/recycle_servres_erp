import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  FbChatAccountRow, FbChatConfigPage, FbChatMessageRow, FbChatMessagesAnswer, FbChatThreadFilter,
} from '@recycle-erp/shared';
import { ApiError } from '../../../../lib/api';
import { handleFetchError } from '../../../../lib/errorToast';
import {
  FB_CHAT_POLL_MS, FB_CHAT_STATUS_KEY, fbChatAccountName, fbChatApi, fbChatChanged, fbChatStatusOf, usePolled,
} from '../../../../lib/fbChat';
import { useT } from '../../../../lib/i18n';
import { fbChatTabPath, hrefFor, navigate, onLinkClick } from '../../../../lib/route';
import { ChatConversation } from './ChatConversation';
import { ChatDetails } from './ChatDetails';
import { chatMergeMessages, chatPacing, type ChatPendingReply } from './ChatHelpers';
import { ChatList } from './ChatList';
import type { FbChatTabProps } from './FbChatsPage';
import { AccountBadge, fbcHueStyle } from './shared';
import '../../../../styles/fbChatChats.css';

// The Chats tab: the team's one inbox for every buyer account. The strip
// narrows it to an account, the list picks a chat (the chat's id is in the
// URL), and the open chat is read, answered and marked from here. Nothing is
// pushed to the browser, so the list and the open chat are polled.

// Settings change rarely; this only feeds the composer's pacing line.
const CONFIG_POLL_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 300;

export function ChatsTab({ threadId }: FbChatTabProps & { threadId: number | null }) {
  const { t, locale } = useT();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [filter, setFilter] = useState<FbChatThreadFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const accounts = usePolled(fbChatApi.accounts, FB_CHAT_POLL_MS.accounts);
  const config = usePolled(fbChatApi.config, CONFIG_POLL_MS);
  const threads = usePolled(
    () => fbChatApi.threads({ account: accountId ?? undefined, q: query || undefined, filter }),
    FB_CHAT_POLL_MS.threads, [accountId, query, filter],
  );

  // After a write here that moves a count or a chat's place in the list.
  const reloadThreads = threads.reload;
  const reloadAccounts = accounts.reload;
  const changed = useCallback(() => {
    fbChatChanged();
    void reloadThreads();
    void reloadAccounts();
  }, [reloadThreads, reloadAccounts]);

  const rows = accounts.data?.accounts ?? [];
  const unreadAll = rows.reduce((n, a) => n + a.unread, 0);
  const now = Date.now();

  return (
    <>
      <div className="fbcc-strip" role="group" aria-label={t('fbcc_filterAccounts')}>
        <button type="button" className={`fbcc-pill all${accountId === null ? ' on' : ''}`} aria-pressed={accountId === null} onClick={() => setAccountId(null)}>
          {t('fbcc_allAccounts')}
          {unreadAll > 0 && <span className="fbcc-n" title={t('fbcc_unreadN', { n: unreadAll })}>{unreadAll.toLocaleString(locale)}</span>}
        </button>
        {rows.map(a => {
          const status = fbChatStatusOf(a);
          const down = status === 'login' || status === 'checkpoint';
          const name = fbChatAccountName(a);
          return (
            <button
              key={a.id} type="button" style={fbcHueStyle(a.no)}
              className={`fbcc-pill fbc-acct${accountId === a.id ? ' on' : ''}${down ? ' down' : ''}`}
              aria-pressed={accountId === a.id} onClick={() => setAccountId(a.id)}
              title={down ? `${name} · ${t(FB_CHAT_STATUS_KEY[status])}` : name}
            >
              <AccountBadge no={a.no} label={name} />{name}
              {down && <span className="fbcc-warn-dot" role="img" aria-label={t(FB_CHAT_STATUS_KEY[status])} />}
              {a.unread > 0 && <span className="fbcc-n" title={t('fbcc_unreadN', { n: a.unread })}>{a.unread.toLocaleString(locale)}</span>}
            </button>
          );
        })}
      </div>
      <div className={`fbcc-work${threadId !== null ? ' show-convo' : ''}`}>
        <ChatList
          threads={threads.data?.threads ?? null} failed={threads.failed} onRetry={() => void threads.reload()}
          openId={threadId} oneAccount={accountId !== null}
          search={search} onSearch={setSearch} query={query} filter={filter} onFilter={setFilter} now={now}
        />
        {threadId === null
          ? <ChatPlaceholder>{t('fbcc_pick')}</ChatPlaceholder>
          : <ChatOpen key={threadId} threadId={threadId} accounts={rows} config={config.data} onChanged={changed} />}
      </div>
    </>
  );
}

/** The two right-hand columns with one line in them: nothing picked, loading, gone. */
function ChatPlaceholder({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="fbcc-col fbcc-convo"><div className="fbcc-empty fbcc-center">{children}</div></div>
      <aside className="fbcc-col fbcc-details" />
    </>
  );
}

type ChatOpenProps = {
  threadId: number;
  accounts: FbChatAccountRow[];
  config: FbChatConfigPage | null;
  onChanged: () => void;
};

/** One open chat. Mounted per chat id, so nothing here outlives the chat it belongs to. */
function ChatOpen({ threadId, accounts, config, onChanged }: ChatOpenProps) {
  const { t } = useT();
  const listPath = fbChatTabPath('chats');
  // A chat that is gone is an answer, not a failure: the id came from a URL.
  const polled = usePolled<FbChatMessagesAnswer | 'missing'>(
    () => fbChatApi.messages(threadId).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return 'missing' as const;
      throw err;
    }),
    FB_CHAT_POLL_MS.messages, [threadId],
  );
  const answer = polled.data === 'missing' ? null : polled.data;

  // Opening a chat reads it for the whole team, and so does watching it while
  // the buyer writes. A mark that fails is tried again on the next read. A
  // hidden tab reads nothing: nobody is looking.
  const marking = useRef(false);
  useEffect(() => {
    if (!answer?.thread.unread || marking.current || document.visibilityState !== 'visible') return;
    marking.current = true;
    fbChatApi.markRead(threadId)
      .then(onChanged, () => {})
      .finally(() => { marking.current = false; });
  }, [answer, threadId, onChanged]);

  const [pending, setPending] = useState<ChatPendingReply[]>([]);
  const [accepted, setAccepted] = useState<FbChatMessageRow[]>([]);
  const nextKey = useRef(0);
  const reload = polled.reload;
  const send = useCallback(async (body: string, clientKey: string) => {
    const key = ++nextKey.current;
    setPending(p => [...p, { key, body, at: new Date().toISOString() }]);
    try {
      const { message } = await fbChatApi.reply(threadId, body, clientKey);
      setAccepted(a => [...a, message]);
      onChanged();
      void reload();
      return true;
    } catch (err) {
      handleFetchError(err);
      return false;
    } finally {
      setPending(p => p.filter(x => x.key !== key));
    }
  }, [threadId, onChanged, reload]);

  const [retrying, setRetrying] = useState<number | null>(null);
  const retry = async (messageId: number, force: boolean) => {
    setRetrying(messageId);
    try {
      await fbChatApi.retry(messageId, force);
      onChanged();
    } catch (err) {
      handleFetchError(err);
    } finally {
      // Either way the row on screen is out of date: it is queued again, or
      // it was refused because it had already moved on.
      await reload();
      setRetrying(null);
    }
  };

  const markUnread = async () => {
    try {
      await fbChatApi.markUnread(threadId);
    } catch (err) {
      handleFetchError(err);
      return;
    }
    // Leaving the chat is what keeps it unread: staying would read it again.
    navigate(listPath);
    onChanged();
  };

  const messages = useMemo(
    () => chatMergeMessages(answer?.messages ?? [], accepted, pending),
    [answer, accepted, pending],
  );

  if (polled.data === 'missing') {
    return (
      <ChatPlaceholder>
        {t('fbcc_convMissing')}
        <a className="btn sm" href={hrefFor(listPath)} onClick={onLinkClick(listPath)}>{t('fbcc_back')}</a>
      </ChatPlaceholder>
    );
  }
  if (!answer) {
    return polled.failed
      ? <ChatPlaceholder>{t('fbcc_convFailed')}<button type="button" className="btn sm" onClick={() => void reload()}>{t('fbcc_tryAgain')}</button></ChatPlaceholder>
      : <ChatPlaceholder>{t('fbcc_convLoading')}</ChatPlaceholder>;
  }

  const { thread } = answer;
  // The server marks nothing unread without a message from the buyer.
  const canMarkUnread = answer.messages.some(m => m.direction === 'in');
  return (
    <>
      <ChatConversation
        thread={thread} messages={messages}
        account={accounts.find(a => a.id === thread.account_id) ?? null}
        pacing={chatPacing(config, thread.account_id)}
        onSend={send} onRetry={(id, force) => void retry(id, force)} retrying={retrying}
        onBack={() => navigate(listPath)} onMarkUnread={() => void markUnread()} canMarkUnread={canMarkUnread}
        now={Date.now()}
      />
      <ChatDetails thread={thread} alsoMessaged={answer.also_messaged} onMarkUnread={() => void markUnread()} canMarkUnread={canMarkUnread} />
    </>
  );
}
