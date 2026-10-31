import {
  REPORTING_TZ, redditLeadIsDue, redditLeadIsOpen, redditLeadIsStale, todayIn,
  type RedditLead, type RedditLeadStage,
} from '@recycle-erp/shared';
import { useT } from '../../../lib/i18n';

export const STAGE_KEY: Record<RedditLeadStage, string> = {
  claimed: 'rlStageClaimed', dm: 'rlStageDm', replied: 'rlStageReplied', talks: 'rlStageTalks', won: 'rlStageWon',
};
export const CLOSING_KEY = { nostock: 'rlClosedNoStock', lost: 'rlClosedLost' } as const;

/** The business day, the same clock the API dates follow-ups by. */
export const leadToday = () => todayIn(REPORTING_TZ);

export type RunLead = (request: Promise<RedditLead>, toast?: string) => Promise<RedditLead | null>;

/** The seller's record as the subreddit bots write it: "289 Sale | 4 Buy". */
export function DealRecord({ sales, buys, max }: { sales: number; buys: number; max?: number }) {
  const { t, locale } = useT();
  const record = (
    <span className="rl-record">
      <b>{sales.toLocaleString(locale)}</b> {t('rlSale')}
      <span className="rl-sep" aria-hidden>|</span>
      <span className="rl-buy"><b>{buys.toLocaleString(locale)}</b> {t('rlBuy')}</span>
    </span>
  );
  if (!max) return record;
  return (
    <span className="rl-recordcell">
      {record}
      <span className="rl-bar" style={{ width: Math.max(4, Math.round((64 * sales) / max)) }} aria-hidden />
    </span>
  );
}

export function StageChip({ lead }: { lead: RedditLead }) {
  const { t } = useT();
  if (lead.closed) return <span className="rl-st rl-st-closed">{t(CLOSING_KEY[lead.closed])}</span>;
  return <span className={`rl-st rl-st-${lead.stage}`}>{t(STAGE_KEY[lead.stage])}</span>;
}

/** Who holds a seller, as far as the viewer may know. */
export function Holder({ lead, manager }: { lead: RedditLead; manager: boolean }) {
  const { t } = useT();
  if (!lead.claimed) return <span className="rl-muted">{t('rlAvailable')}</span>;
  if (lead.mine) return <span className="chip accent">{t('rlYou')}</span>;
  return <span className="chip rl-chip-warn">{manager && lead.holderName ? lead.holderName : t('rlClaimed')}</span>;
}

export const fmtDay = (d: string | null, locale: string) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric' }) : '—';

/** What the holder does next, worded for the My leads and Team tables. */
export function NextStep({ lead, today }: { lead: RedditLead; today: string }) {
  const { t, locale } = useT();
  if (lead.closed) return <span className="rl-muted">{lead.followUp ? t('rlCheckBack', { date: fmtDay(lead.followUp, locale) }) : t('rlClosedShort')}</span>;
  if (lead.stage === 'won') return <span className="rl-muted">{t('rlStageWon')}</span>;
  if (redditLeadIsDue(lead, today)) {
    return <span className="chip rl-chip-warn">{lead.followUp! < today ? t('rlFollowOverdue') : t('rlFollowToday')}</span>;
  }
  if (lead.stage === 'claimed') {
    return <span className={`chip ${redditLeadIsStale(lead, Date.now()) ? 'rl-chip-warn' : 'accent'}`}>{t('rlSendFirstDm')}</span>;
  }
  if (lead.stage === 'dm') {
    return <span>{t('rlWaitingReply')}{lead.followUp && <span className="rl-sub">{t('rlNudgeOn', { date: fmtDay(lead.followUp, locale) })}</span>}</span>;
  }
  return lead.followUp && redditLeadIsOpen(lead)
    ? <span>{t('rlFollowOn', { date: fmtDay(lead.followUp, locale) })}</span>
    : <span className="rl-muted">{t('rlSetFollowUp')}</span>;
}
