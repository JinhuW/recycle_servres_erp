import type { FbChatAlsoMessaged, FbChatThreadRow } from '@recycle-erp/shared';
import { fmtDate, relTime } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { fbChatThreadPath, hrefFor, onLinkClick } from '../../../../lib/route';
import { ChatTelegramIcon } from './ChatIcons';
import { AccountBadge, BuyerAvatar, fbcHueStyle } from './shared';

// The right column of the Chats tab: what Facebook says about the buyer, the
// chat's facts, its Telegram topic, and the buyer's chats on our other
// accounts.

export type ChatDetailsProps = {
  thread: FbChatThreadRow;
  alsoMessaged: FbChatAlsoMessaged[];
  onMarkUnread: () => void;
  canMarkUnread: boolean;
};

export function ChatDetails({ thread, alsoMessaged, onMarkUnread, canMarkUnread }: ChatDetailsProps) {
  const { t, locale } = useT();
  const name = thread.buyer_name ?? t('fbcc_unknownBuyer');

  return (
    <aside className="fbcc-col fbcc-details" aria-label={t('fbcc_details')}>
      <div className="fbcc-who-big">
        <BuyerAvatar name={thread.buyer_name} size={64} />
        <h3>{name}</h3>
        <p>
          {thread.rating !== null
            ? <><span className="fbcc-stars">★ {thread.rating.toFixed(1)}</span>{thread.rating_count !== null && <> {t('fbcc_rating', { n: thread.rating_count })}</>}</>
            : t('fbcc_noRatings')}
        </p>
        {thread.joined_year !== null && <p>{t('fbcc_joined', { year: thread.joined_year })}</p>}
      </div>

      <section className="fbcc-sec">
        <h4>{t('fbcc_secChat')}</h4>
        <dl className="fbcc-kv">
          <dt>{t('fbcc_kvAccount')}</dt>
          <dd className="fbc-acct" style={fbcHueStyle(thread.account_no)}>#{thread.account_no} {thread.account_label}</dd>
          <dt>{t('fbcc_kvLocation')}</dt><dd>{thread.buyer_location ?? '—'}</dd>
          <dt>{t('fbcc_kvFirstSeen')}</dt><dd>{fmtDate(thread.created_at, locale)}</dd>
        </dl>
      </section>

      <section className="fbcc-sec">
        <h4>{t('fbcc_secTelegram')}</h4>
        {thread.telegram_topic_url ? (
          <a className="fbcc-link" href={thread.telegram_topic_url} target="_blank" rel="noreferrer">
            <span className="fbcc-tg"><ChatTelegramIcon size={14} /></span>
            <span className="fbcc-grow">{name}<small>{t('fbcc_topicOpen')}</small></span>
          </a>
        ) : (
          <p className="fbcc-quiet">{t(thread.telegram_topic_id !== null ? 'fbcc_topicNoLink' : 'fbcc_topicNone')}</p>
        )}
      </section>

      {alsoMessaged.length > 0 && (
        <section className="fbcc-sec">
          <h4>{t('fbcc_secAlso')}</h4>
          {alsoMessaged.map(o => {
            const path = fbChatThreadPath(o.thread_id);
            return (
              <a key={o.thread_id} className="fbcc-other" href={hrefFor(path)} onClick={onLinkClick(path)}>
                <AccountBadge no={o.account_no} label={o.account_label} />
                <span className="fbcc-grow">{o.account_label}{o.last_body && <> · {o.last_body}</>}</span>
                <span className="fbcc-other-when">{relTime(o.last_activity_at, locale)}</span>
              </a>
            );
          })}
        </section>
      )}

      {canMarkUnread && (
        <div className="fbcc-sec fbcc-actions">
          <button type="button" className="btn ghost" onClick={onMarkUnread}>{t('fbcc_markUnread')}</button>
        </div>
      )}
    </aside>
  );
}
