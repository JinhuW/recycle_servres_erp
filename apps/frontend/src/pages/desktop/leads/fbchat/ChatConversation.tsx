import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  FB_CHAT_REPLY_MAX_CHARS,
  type FbChatAccountRow, type FbChatMessageRow, type FbChatThreadRow,
} from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { fbChatListingUrl, fbChatStatusOf } from '../../../../lib/fbChat';
import { fmtDate, relTime } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { fbChatTabPath, hrefFor, onLinkClick } from '../../../../lib/route';
import {
  CHAT_SOURCE_CLASS, chatCanRetry, chatDaysAgo, chatTimeline, type ChatPacing,
} from './ChatHelpers';
import { ChatMessengerIcon, ChatSendIcon, ChatSourceIcon, ChatTelegramIcon } from './ChatIcons';
import { AccountBadge, BuyerAvatar, fbcHueStyle } from './shared';

// The middle column of the Chats tab: who the chat is with, the bubbles, and
// the box a manager types a reply into. It draws what it is given; ChatsTab
// owns the reads and the writes.

export type ChatConversationProps = {
  thread: FbChatThreadRow;
  messages: FbChatMessageRow[];
  /** The chat's account; null until the accounts have loaded. */
  account: FbChatAccountRow | null;
  pacing: ChatPacing | null;
  /**
   * Resolves false when the reply was not accepted, so the text comes back.
   * `clientKey` names this reply to the server: the same text sent again
   * after a false carries the same key, in case the first did get through.
   */
  onSend: (body: string, clientKey: string) => Promise<boolean>;
  /** `force` sends a reply that may already be on Facebook; the server refuses that one without it. */
  onRetry: (messageId: number, force: boolean) => void;
  /** The reply a retry is in flight for. */
  retrying: number | null;
  onBack: () => void;
  onMarkUnread: () => void;
  canMarkUnread: boolean;
  now: number;
};

export function ChatConversation(p: ChatConversationProps) {
  const { t } = useT();
  const { thread } = p;
  const name = thread.buyer_name ?? t('fbcc_unknownBuyer');
  const listingUrl = fbChatListingUrl(thread.listing_id);

  return (
    <div className="fbcc-col fbcc-convo">
      <div className="fbcc-head">
        <button type="button" className="fbcc-iconbtn fbcc-back" onClick={p.onBack} aria-label={t('fbcc_back')}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <BuyerAvatar name={thread.buyer_name} size={38} />
        <div className="fbcc-grow">
          <h2>{name}</h2>
          <div className="fbcc-meta">
            <span className="fbcc-meta-acct"><AccountBadge no={thread.account_no} label={thread.account_label} small /> {thread.account_label}</span>
            {thread.buyer_location && <span className="fbcc-meta-loc">{thread.buyer_location}</span>}
          </div>
        </div>
        <div className="fbcc-acts">
          {/* The details column holds this below 1180px, where it is gone. */}
          {p.canMarkUnread && (
            <button type="button" className="btn sm ghost fbcc-narrow" onClick={p.onMarkUnread} title={t('fbcc_markUnread')} aria-label={t('fbcc_markUnread')}>
              <Icon name="mail" size={13} />
            </button>
          )}
          {thread.telegram_topic_url && (
            <a className="btn sm ghost" href={thread.telegram_topic_url} target="_blank" rel="noreferrer" title={t('fbcc_topicHint')}>
              <ChatTelegramIcon /><span>{t('fbcc_topic')}</span>
            </a>
          )}
          {listingUrl && (
            <a className="btn sm ghost" href={listingUrl} target="_blank" rel="noreferrer" title={t('fbcc_facebookHint')}>
              <ChatMessengerIcon /><span>{t('fbcc_facebook')}</span>
            </a>
          )}
        </div>
      </div>
      {thread.listing_title && (
        <div className="fbcc-listing">
          <span className="fbcc-thumb"><Icon name="tag" size={15} /></span>
          <div className="fbcc-grow"><span>{t('fbcc_marketplace')}</span><b>{thread.listing_title}</b></div>
        </div>
      )}
      <ChatMessages thread={thread} messages={p.messages} onRetry={p.onRetry} retrying={p.retrying} now={p.now} />
      <ChatComposer thread={thread} account={p.account} pacing={p.pacing} onSend={p.onSend} />
    </div>
  );
}

// ── Bubbles ───────────────────────────────────────────────────────────────────

type MessagesProps = Pick<ChatConversationProps, 'thread' | 'messages' | 'onRetry' | 'retrying' | 'now'>;

function ChatMessages({ thread, messages, onRetry, retrying, now }: MessagesProps) {
  const { t, locale } = useT();
  const box = useRef<HTMLDivElement>(null);
  // Follows the newest bubble only while the reader is already at the bottom,
  // so a poll never pulls them away from something they scrolled up to read.
  const atBottom = useRef(true);
  const newest = messages[messages.length - 1]?.id;
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [newest, messages.length]);

  const dayLabel = (iso: string) => {
    const ago = chatDaysAgo(iso, now);
    if (ago <= 0) return t('fbcc_today');
    if (ago === 1) return t('fbcc_yesterday');
    if (ago < 7) return new Date(iso).toLocaleDateString(locale, { weekday: 'long' });
    return fmtDate(iso, locale);
  };

  return (
    <div
      className="fbcc-msgs" ref={box} aria-live="polite"
      onScroll={e => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {messages.length === 0 && <div className="fbcc-empty">{t('fbcc_noMessages')}</div>}
      {chatTimeline(messages).map((item, i) => {
        if (item.kind === 'history') return <div key="history" className="fbcc-history">{t('fbcc_history')}</div>;
        if (item.kind === 'day') return <div key={`day-${i}`} className="fbcc-day">{dayLabel(item.at)}</div>;
        const m = item.message;
        return m.direction === 'in'
          ? <InBubble key={m.id} m={m} buyer={thread.buyer_name} endsRun={item.endsRun} />
          : <OutBubble key={m.id} m={m} onRetry={onRetry} busy={retrying === m.id} />;
      })}
    </div>
  );
}

/**
 * When a bubble was sent. History read in bulk only has Facebook's own
 * wording, where the page showed one; its created_at is when it was read.
 */
function useSentTime() {
  const { locale } = useT();
  return (m: FbChatMessageRow): string | null =>
    m.backfill
      ? m.fb_sent_label
      : new Date(m.sent_at ?? m.created_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** The text, then a placeholder per photo: Facebook's image links are signed and expire, so they are not loaded here. */
function BubbleBody({ m }: { m: FbChatMessageRow }) {
  const { t } = useT();
  return (
    <>
      {m.body && <div className="fbcc-b">{m.body}</div>}
      {m.images.map((_, i) => <div key={i} className="fbcc-img"><Icon name="image" size={16} />{t('fbcc_photo')}</div>)}
    </>
  );
}

function InBubble({ m, buyer, endsRun }: { m: FbChatMessageRow; buyer: string | null; endsRun: boolean }) {
  const sentTime = useSentTime()(m);
  return (
    <div className={`fbcc-m in${endsRun ? ' ends-run' : ''}`}>
      <span className="fbcc-mini"><BuyerAvatar name={buyer} size={26} /></span>
      <div className="fbcc-bwrap">
        <BubbleBody m={m} />
        {endsRun && sentTime && <div className="fbcc-stamp">{sentTime}</div>}
      </div>
    </div>
  );
}

function OutBubble({ m, onRetry, busy }: { m: FbChatMessageRow; onRetry: ChatConversationProps['onRetry']; busy: boolean }) {
  const { t } = useT();
  const sentTime = useSentTime()(m);
  const src = CHAT_SOURCE_CLASS[m.source];
  const state = m.send_state ?? 'sent';
  const author = m.source === 'facebook'
    ? t('fbcc_srcFb')
    : [m.author_name, t(m.source === 'telegram' ? 'fbcc_srcTg' : 'fbcc_srcErp')].filter(Boolean).join(' · ');
  const stopped = state === 'failed' || state === 'uncertain';

  return (
    <div className={`fbcc-m out src-${src} ${state}`}>
      <div className="fbcc-bwrap">
        <BubbleBody m={m} />
        {stopped && m.error && <div className="fbcc-stamp fbcc-error">{m.error}</div>}
        <div className="fbcc-stamp">
          <span className="fbcc-src"><ChatSourceIcon source={m.source} />{author}</span>
          {state === 'queued' && <>· {t('fbcc_queued')}</>}
          {state === 'sending' && <>· <span className="fbcc-typing" aria-hidden="true"><i /><i /><i /></span> {t('fbcc_typing')}</>}
          {state === 'sent' && sentTime && <>· {sentTime}</>}
          {stopped && (
            <>
              · <span className={state === 'failed' ? 'fbcc-state-failed' : 'fbcc-state-uncertain'}>{t(state === 'failed' ? 'fbcc_failed' : 'fbcc_uncertain')}</span>
              {chatCanRetry(m) && (
                // "Uncertain" means the text may be on Facebook already, so
                // the action says what pressing it risks.
                <> · <button type="button" disabled={busy} onClick={() => onRetry(m.id, state === 'uncertain')} title={state === 'uncertain' ? t('fbcc_retryUncertainHint') : undefined}>
                  {t(state === 'failed' ? 'fbcc_retry' : 'fbcc_retryUncertain')}
                </button></>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────────────

type ComposerProps = Pick<ChatConversationProps, 'thread' | 'account' | 'pacing' | 'onSend'>;

// The counter only shows once the limit is near.
const COUNTER_FROM = FB_CHAT_REPLY_MAX_CHARS - 200;
const BOX_MAX_PX = 140;

function ChatComposer({ thread, account, pacing, onSend }: ComposerProps) {
  const { t, locale } = useT();
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const body = text.trim();
  const status = account ? fbChatStatusOf(account) : null;
  const accountsPath = fbChatTabPath('accounts');

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, BOX_MAX_PX)}px`;
  }, [text]);

  // The reply whose answer never came. The server may have queued it all the
  // same, so sending that text again reuses its key and cannot queue it twice.
  const unanswered = useRef<{ body: string; key: string } | null>(null);
  const send = async () => {
    if (!body) return;
    const key = unanswered.current?.body === body ? unanswered.current.key : crypto.randomUUID();
    unanswered.current = null;
    setText('');
    if (await onSend(body, key)) return;
    unanswered.current = { body, key };
    // Back into the box unless something new was typed meanwhile.
    setText(now => now || body);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an input method is composing picks a candidate; it is not a send.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  return (
    <div className="fbcc-composer">
      {account && (status === 'login' || status === 'checkpoint' || status === 'stale') && (
        <div className="fbcc-note neg" role="status">
          <Icon name="alert" size={14} />
          <span>
            <b>{status === 'stale'
              ? t('fbcc_downStale', { name: thread.account_label, when: relTime(account.last_seen_at, locale) })
              : t(status === 'login' ? 'fbcc_downLogin' : 'fbcc_downCheckpoint', { name: thread.account_label })}</b>
            {' '}{t('fbcc_downQueue')}
          </span>
        </div>
      )}
      {status === 'paused' && (
        <div className="fbcc-note" role="status">
          <Icon name="alert" size={14} />
          <span>
            <b>{t('fbcc_paused')}</b> {t('fbcc_pausedQueue')}{' '}
            <a href={hrefFor(accountsPath)} onClick={onLinkClick(accountsPath)}>{t('fbcc_pausedLink')}</a>
          </span>
        </div>
      )}
      <div className="fbcc-as fbc-acct" style={fbcHueStyle(thread.account_no)}>
        {t('fbcc_replyingAs')} <AccountBadge no={thread.account_no} label={thread.account_label} /><b>{thread.account_label}</b>
        {pacing && (
          <>
            <span className="fbcc-sep" aria-hidden="true">|</span>
            <span>{t('fbcc_pacing', { pace: pacing.pace.toLocaleString(locale), sec: pacing.gapSec.toLocaleString(locale) })}</span>
          </>
        )}
        {text.length >= COUNTER_FROM && (
          <span className="fbcc-left">{t('fbcc_charsLeft', { n: (FB_CHAT_REPLY_MAX_CHARS - text.length).toLocaleString(locale) })}</span>
        )}
      </div>
      <div className="fbcc-box">
        <textarea
          ref={area} rows={1} value={text} maxLength={FB_CHAT_REPLY_MAX_CHARS}
          onChange={e => setText(e.target.value)} onKeyDown={onKeyDown}
          placeholder={t('fbcc_placeholder', { name: thread.buyer_name ?? t('fbcc_unknownBuyer') })} aria-label={t('fbcc_message')}
        />
        <button type="button" className="fbcc-send" disabled={!body} onClick={() => void send()} aria-label={t('fbcc_send')} title={t('fbcc_sendHint')}>
          <ChatSendIcon />
        </button>
      </div>
    </div>
  );
}
