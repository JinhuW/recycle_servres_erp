import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FbChatAccountRow, FbChatMessageRow, FbChatThreadRow } from '@recycle-erp/shared';

// Smoke tests for the Chats tab: markup only, no DOM, so the polls never start
// (effects do not run in renderToString). With no language provider `t`
// returns its key.
vi.mock('../../../../lib/fbChat', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/fbChat')>('../../../../lib/fbChat');
  const never = () => new Promise(() => undefined);
  return { ...actual, fbChatApi: Object.fromEntries(Object.keys(actual.fbChatApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../../lib/errorToast', () => ({ handleFetchError: vi.fn() }));

const { ChatsTab } = await import('./ChatsTab');
const { ChatList } = await import('./ChatList');
const { ChatConversation } = await import('./ChatConversation');
const { ChatDetails } = await import('./ChatDetails');

const NOW = new Date(2026, 10, 12, 16, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

const THREAD: FbChatThreadRow = {
  id: 12, fb_thread_id: 'Jaden · $1 - Sell Your Server RAM', account_id: 3, account_no: 1, account_label: 'Denver RAM Buyer',
  buyer_name: 'Jaden', buyer_location: 'Watertown, MA', rating: 4.8, rating_count: 23, joined_year: 2019,
  listing_id: '1234567890', listing_title: '$1 - Sell Your Server RAM & SSDs',
  telegram_topic_id: 5521, telegram_topic_url: 'https://t.me/c/1234567890/5521',
  last_message: { direction: 'out', source: 'erp', author_name: 'Jin Hu', body: 'Nope', images: 0, send_state: 'sent', created_at: at(12, 15, 38) },
  unread: true, failed: false, last_activity_at: at(12, 15, 41), created_at: at(3, 11),
};

function msg(id: number, over: Partial<FbChatMessageRow>): FbChatMessageRow {
  return {
    id, seq: id, direction: 'in', source: 'facebook', body: `message ${id}`, images: [], backfill: false,
    fb_sent_label: null, send_state: null, error: null, typing_ms: null, tg_user_name: null,
    erp_user_id: null, author_name: null, created_at: at(12, 15, id), sent_at: null, ...over,
  };
}

const ACCOUNT: FbChatAccountRow = {
  id: 3, no: 1, fb_uid: '100089231457', label: 'Denver RAM Buyer', ext_version: '0.3.0', restricted: null, restricted_at: null,
  last_seen_at: new Date().toISOString(), created_at: at(3, 11), threads: 41, unread: 2, replies_waiting: 0, last_sync_at: null,
  paused: false, stale_after_sec: 300, config_state: 'up_to_date', config_seen_at: null, device: null,
};

const noop = () => undefined;
const listProps = {
  failed: false, onRetry: noop, openId: null, oneAccount: false,
  search: '', onSearch: noop, query: '', filter: 'all' as const, onFilter: noop, now: NOW,
};
const convoProps = {
  thread: THREAD, account: ACCOUNT, pacing: { pace: 1, gapSec: 20 }, onSend: async () => true,
  onRetry: noop, retrying: null, onBack: noop, onMarkUnread: noop, canMarkUnread: true, now: NOW,
};

describe('Chats tab', () => {
  it('opens on the strip, a loading list and the prompt to pick a chat', () => {
    const html = renderToString(<ChatsTab threadId={null} />);
    for (const k of ['fbcc_filterAccounts', 'fbcc_allAccounts', 'fbcc_search', 'fbcc_filterAll', 'fbcc_filterUnread', 'fbcc_filterFailed', 'fbcc_loading', 'fbcc_pick']) {
      expect(html, k).toContain(k);
    }
    expect(html).not.toContain('show-convo');
  });

  it('shows a chat as loading until its messages arrive, and switches the narrow layout to it', () => {
    const html = renderToString(<ChatsTab threadId={12} />);
    expect(html).toContain('fbcc_convLoading');
    expect(html).toContain('show-convo');
    expect(html).not.toContain('fbcc_pick');
  });
});

describe('chat list', () => {
  it('draws a row per chat: who, which account, where the last reply was typed, unread or not sent', () => {
    const failed: FbChatThreadRow = {
      ...THREAD, id: 13, buyer_name: 'Priya N.', unread: false, failed: true,
      last_message: { ...THREAD.last_message!, source: 'telegram', author_name: 'Kevin Lee', send_state: 'failed' },
    };
    const photo: FbChatThreadRow = {
      ...THREAD, id: 14, buyer_name: null, unread: false,
      last_message: { direction: 'in', source: 'facebook', author_name: null, body: '', images: 1, send_state: null, created_at: at(12, 9) },
    };
    const html = renderToString(<ChatList {...listProps} threads={[THREAD, failed, photo]} openId={13} />);
    expect(html).toContain('#/leads/facebook/chat/12');
    expect(html).toContain('Jaden');
    expect(html).toContain('Denver RAM Buyer');
    expect(html).toContain('fbcc-pfx-erp');
    expect(html).toMatch(/fbcc_pfxErp<!-- --> <!-- -->Jin|fbcc_pfxErp Jin/);
    expect(html).toContain('fbcc-pfx-tg');
    expect(html).toContain('fbcc_unread');           // the dot on the unread row
    expect(html).toContain('fbcc_notSentHint');      // the mark on the failed one
    expect(html).toContain('fbcc_unknownBuyer');
    expect(html).toContain('fbcc_photoIn');
    expect(html).toContain('fbcc_count');
    expect(html.match(/fbcc-conv[^"]* on"/g)).toHaveLength(1);
  });

  it('leaves the account off the rows once one is picked', () => {
    const html = renderToString(<ChatList {...listProps} threads={[THREAD]} oneAccount />);
    expect(html).not.toContain('<small>');
  });

  it('says why the list is empty, or that it did not load', () => {
    const empty = (over: object) => renderToString(<ChatList {...listProps} threads={[]} {...over} />);
    expect(empty({})).toContain('fbcc_emptyAll');
    expect(empty({ oneAccount: true })).toContain('fbcc_emptyAccount');
    expect(empty({ filter: 'unread' })).toContain('fbcc_emptyUnread');
    expect(empty({ filter: 'unread', oneAccount: true })).toContain('fbcc_emptyUnreadAccount');
    expect(empty({ filter: 'failed' })).toContain('fbcc_emptyFailed');
    expect(empty({ filter: 'failed', query: 'ram' })).toContain('fbcc_emptySearch');
    const failed = renderToString(<ChatList {...listProps} threads={null} failed />);
    expect(failed).toContain('fbcc_loadFailed');
    expect(failed).toContain('fbcc_tryAgain');
  });
});

describe('conversation', () => {
  const messages = [
    msg(1, { backfill: true, fb_sent_label: 'Tuesday 5:57pm' }),
    msg(2, { created_at: at(11, 18) }),
    msg(3, { direction: 'out', source: 'facebook', send_state: 'sent', created_at: at(11, 19) }),
    msg(4, { body: '', images: ['https://example.test/a.jpg'] }),
    msg(5, { direction: 'out', source: 'telegram', author_name: 'Kevin', send_state: 'sent' }),
    msg(6, { direction: 'out', source: 'erp', author_name: 'Jin Hu', seq: null, send_state: 'failed', error: 'Facebook showed “Couldn’t send”.' }),
    msg(7, { direction: 'out', source: 'erp', author_name: 'Jin Hu', seq: null, send_state: 'uncertain' }),
    msg(8, { direction: 'out', source: 'erp', author_name: 'Jin Hu', seq: null, send_state: 'sending' }),
    msg(9, { direction: 'out', source: 'erp', author_name: 'Jin Hu', seq: null, send_state: 'queued' }),
  ];

  it('draws the header, the listing, the timeline and every reply state', () => {
    const html = renderToString(<ChatConversation {...convoProps} messages={messages} />);
    expect(html).toContain('https://t.me/c/1234567890/5521');
    expect(html).toContain('https://www.facebook.com/marketplace/item/1234567890/');
    expect(html).toContain('$1 - Sell Your Server RAM &amp; SSDs');
    expect(html).toContain('fbcc_history');
    expect(html).toContain('Tuesday 5:57pm');
    expect(html).toContain('fbcc_yesterday');
    expect(html).toContain('fbcc_today');
    expect(html).toContain('fbcc_photo');
    expect(html).not.toContain('example.test');       // signed image links are not loaded
    for (const c of ['src-fb sent', 'src-tg sent', 'src-erp failed', 'src-erp uncertain', 'src-erp sending', 'src-erp queued']) expect(html, c).toContain(c);
    expect(html).toContain('fbcc_srcFb');
    expect(html).toMatch(/Kevin · fbcc_srcTg/);
    expect(html).toMatch(/Jin Hu · fbcc_srcErp/);
    expect(html).toContain('Facebook showed “Couldn’t send”.');
    for (const k of ['fbcc_failed', 'fbcc_retry', 'fbcc_uncertain', 'fbcc_retryUncertain', 'fbcc_retryUncertainHint', 'fbcc_typing', 'fbcc_queued']) expect(html, k).toContain(k);
  });

  it('says who the reply goes out as and how it is paced, with no warning on a running account', () => {
    const html = renderToString(<ChatConversation {...convoProps} messages={messages} />);
    for (const k of ['fbcc_replyingAs', 'fbcc_pacing', 'fbcc_placeholder', 'fbcc_send']) expect(html, k).toContain(k);
    for (const k of ['fbcc_paused', 'fbcc_downLogin', 'fbcc_downCheckpoint', 'fbcc_downStale']) expect(html, k).not.toContain(k);
    expect(html).toMatch(/<button[^>]*class="fbcc-send"[^>]*disabled=""/);
  });

  it('warns when the account is paused, walled or silent, and drops the pacing it does not know', () => {
    const with_ = (over: Partial<FbChatAccountRow>) =>
      renderToString(<ChatConversation {...convoProps} messages={[]} account={{ ...ACCOUNT, ...over }} pacing={null} />);
    const paused = with_({ paused: true });
    expect(paused).toContain('fbcc_paused');
    expect(paused).toContain('#/leads/facebook/accounts');
    expect(paused).not.toContain('fbcc_pacing');
    expect(paused).toContain('fbcc_noMessages');
    expect(with_({ restricted: 'login' })).toContain('fbcc_downLogin');
    expect(with_({ restricted: 'checkpoint' })).toContain('fbcc_downCheckpoint');
    expect(with_({ last_seen_at: at(1, 9) })).toContain('fbcc_downStale');
  });
});

describe('chat details', () => {
  it('shows the buyer, the chat facts, the topic, other accounts and Mark as unread', () => {
    const also = [{ thread_id: 40, account_id: 5, account_no: 3, account_label: 'Front Range Tech', last_body: 'Asked about SSD pricing', last_activity_at: at(1, 12) }];
    const html = renderToString(<ChatDetails thread={THREAD} alsoMessaged={also} onMarkUnread={noop} canMarkUnread />);
    expect(html).toContain('4.8');
    for (const k of ['fbcc_rating', 'fbcc_joined', 'fbcc_kvAccount', 'fbcc_kvLocation', 'fbcc_kvFirstSeen', 'fbcc_topicOpen', 'fbcc_secAlso', 'fbcc_markUnread']) expect(html, k).toContain(k);
    expect(html).toContain('Watertown, MA');
    expect(html).toContain('#/leads/facebook/chat/40');
    expect(html).toContain('Asked about SSD pricing');
  });

  it('shows only what is known', () => {
    const bare = { ...THREAD, rating: null, rating_count: null, joined_year: null, buyer_location: null, telegram_topic_id: null, telegram_topic_url: null };
    const html = renderToString(<ChatDetails thread={bare} alsoMessaged={[]} onMarkUnread={noop} canMarkUnread={false} />);
    expect(html).toContain('fbcc_noRatings');
    expect(html).toContain('fbcc_topicNone');
    for (const k of ['fbcc_joined', 'fbcc_secAlso', 'fbcc_markUnread', 'fbcc_topicOpen']) expect(html, k).not.toContain(k);
  });
});
