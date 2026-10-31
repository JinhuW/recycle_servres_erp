import { useEffect, useRef, useState } from 'react';
import { REDDIT_LEAD_STAGES, addDays, redditLeadIsDue, redditLeadIsOpen } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { useT } from '../../../lib/i18n';
import { relTime } from '../../../lib/format';
import { useEscapeKey } from '../../../lib/useEscapeKey';
import { useFocusTrap } from '../../../lib/useFocusTrap';
import { handleFetchError } from '../../../lib/errorToast';
import {
  DM_TEMPLATES, composeUrl, dmDraft, leadsApi, profileUrl,
  type DmTemplateId, type RedditLead, type RedditLeadEvent,
} from '../../../lib/redditLeads';
import { CLOSING_KEY, DealRecord, STAGE_KEY, StageChip, fmtDay, leadToday, type RunLead } from './shared';

const TEMPLATE_KEY: Record<DmTemplateId, string> = { bulk: 'rlTplBulk', item: 'rlTplItem', follow: 'rlTplFollow' };
const QUICK_FOLLOW = [[1, 'rlTomorrow'], [3, 'rlIn3Days'], [7, 'rlNextWeek']] as const;

type Props = {
  lead: RedditLead;
  me: { name: string };
  manager: boolean;
  run: RunLead;
  onClose: () => void;
  onBuyer: (username: string) => void;
};

/**
 * One seller's whole workflow: the stage bar, the next step spelled out, the
 * DM writer, the reply log, the follow-up and closing, and the history. A
 * purchaser opening someone else's seller gets only "taken".
 */
export function LeadDrawer({ lead, me, manager, run, onClose, onBuyer }: Props) {
  const { t, locale } = useT();
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel);
  useEscapeKey(onClose);
  const [history, setHistory] = useState<RedditLeadEvent[] | null>(null);
  const [soldTo, setSoldTo] = useState<{ username: string; name: string }[]>([]);
  const can = lead.mine || (manager && lead.claimed);
  const today = leadToday();
  const open = redditLeadIsOpen(lead);
  const due = redditLeadIsDue(lead, today);

  // History follows every change to the lead: the drawer re-reads it whenever
  // the lead the page holds is replaced.
  useEffect(() => {
    let live = true;
    leadsApi.detail(lead.username).then(r => { if (live) { setHistory(r.history); setSoldTo(r.buyers); } }, handleFetchError);
    return () => { live = false; };
  }, [lead]);

  const [writing, setWriting] = useState<DmTemplateId | null>(null);
  const template: DmTemplateId = writing ?? (lead.stage === 'claimed' ? 'bulk' : 'follow');
  const showWriter = can && open && (lead.stage === 'claimed' || due || writing !== null);
  const [draft, setDraft] = useState(() => dmDraft(template, lead, me.name));
  useEffect(() => setDraft(dmDraft(template, lead, me.name)), [template, lead.username]); // eslint-disable-line react-hooks/exhaustive-deps
  const [askSent, setAskSent] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (request: Promise<RedditLead>, toast?: string) => {
    setBusy(true);
    const next = await run(request, toast);
    setBusy(false);
    return next;
  };

  const sent = async () => {
    if (await act(leadsApi.dm(lead.username, t(TEMPLATE_KEY[template])), t('rlDmSentToast'))) {
      setAskSent(false);
      setWriting(null);
    }
  };
  const saveReply = async () => {
    if (!reply.trim()) return;
    if (await act(leadsApi.reply(lead.username, reply), t('rlReplySavedToast'))) setReply('');
  };

  const nextBox = () => {
    if (!lead.claimed) {
      return (
        <div className="rl-next">
          <p><b>{t('rlNobodyWorking')}</b> {t('rlNobodyWorkingHint')}</p>
          <button className="btn primary" disabled={busy} onClick={() => void act(leadsApi.claim(lead.username), t('rlClaimedToast', { name: lead.name }))}>{t('rlClaim')}</button>
        </div>
      );
    }
    if (!can) {
      return <div className="rl-next rl-warn"><p><b>{t('rlTakenTitle')}</b> {t('rlTakenHint')}</p></div>;
    }
    if (!open) {
      return (
        <div className="rl-next">
          <p>
            <b>{lead.stage === 'won' && !lead.closed ? t('rlDealMade') : t('rlClosedAs', { reason: t(CLOSING_KEY[lead.closed as 'nostock' | 'lost']) })}</b>
            {' '}{lead.followUp && t('rlCheckBack', { date: fmtDay(lead.followUp, locale) })}
          </p>
          <button className="btn sm" disabled={busy} onClick={() => void act(leadsApi.reopen(lead.username), t('rlReopenedToast'))}>{t('rlReopen')}</button>
        </div>
      );
    }
    const title = lead.stage === 'claimed' ? t('rlNextFirstDm') : due ? t('rlNextFollowDue') : lead.stage === 'dm' ? t('rlNextWaiting') : t('rlNextKeepGoing');
    return (
      <div className={`rl-next${due ? ' rl-warn' : ''}`}>
        <p><b>{title}</b>{lead.stage === 'dm' && !due && <> {t('rlNextWaitingHint')}</>}</p>
        {showWriter ? (
          <div className="rl-compose">
            <div className="rl-chips" role="group" aria-label={t('rlTemplate')}>
              {DM_TEMPLATES.map(id => (
                <button key={id} className={`btn sm ${id === template ? 'rl-on' : 'ghost'}`} aria-pressed={id === template} onClick={() => setWriting(id)}>
                  {t(TEMPLATE_KEY[id])}
                </button>
              ))}
            </div>
            <input className="input" value={draft.subject} aria-label={t('rlSubject')} onChange={e => setDraft({ ...draft, subject: e.target.value })} />
            <textarea className="textarea" rows={8} value={draft.body} aria-label={t('rlMessage')} onChange={e => setDraft({ ...draft, body: e.target.value })} />
            <div className="rl-row">
              <a className="btn primary" href={composeUrl(lead.name, draft.subject, draft.body)} target="_blank" rel="noopener noreferrer" onClick={() => setAskSent(true)}>
                {t('rlOpenInReddit')}
              </a>
              <button className="btn" onClick={() => { void navigator.clipboard?.writeText(draft.body); setAskSent(true); }}>{t('rlCopyMessage')}</button>
              <span className="rl-sub">{t('rlOpenInRedditHint')}</span>
            </div>
            {askSent && (
              <div className="rl-confirm" role="status">
                {t('rlDidYouSend')}
                <button className="btn sm primary" disabled={busy} onClick={() => void sent()}>{t('rlMarkDmSent')}</button>
                <button className="rl-link" onClick={() => setAskSent(false)}>{t('rlNotYet')}</button>
              </div>
            )}
          </div>
        ) : (
          <button className="btn sm" onClick={() => setWriting('follow')}>{t('rlWriteAnotherDm')}</button>
        )}
      </div>
    );
  };

  const kindText = (e: RedditLeadEvent) => {
    switch (e.kind) {
      case 'claimed': return t('rlEvClaimed', { who: e.actor });
      case 'released': return t('rlEvReleased', { who: e.actor });
      case 'dm': return t('rlEvDm', { who: e.actor, template: e.detail });
      case 'reply': return t('rlEvReply', { who: e.actor });
      case 'stage': return t('rlEvStage', { who: e.actor, stage: t(STAGE_KEY[e.detail as keyof typeof STAGE_KEY] ?? e.detail) });
      case 'follow_up': return e.detail ? t('rlEvFollow', { who: e.actor, date: fmtDay(e.detail, locale) }) : t('rlEvFollowCleared', { who: e.actor });
      case 'closed': return t('rlEvClosed', { who: e.actor, reason: t(CLOSING_KEY[e.detail as 'nostock' | 'lost'] ?? e.detail) });
      case 'reopened': return t('rlEvReopened', { who: e.actor });
      default: return e.kind;
    }
  };

  const stageIdx = REDDIT_LEAD_STAGES.indexOf(lead.stage);
  const rec = lead.sales >= 50 ? 'rlVolumeSeller' : lead.sales >= 10 ? 'rlRegularSeller' : 'rlOccasionalSeller';

  return (
    <>
      <div className="rl-scrim" onClick={onClose} />
      <aside ref={panel} className="rl-drawer" role="dialog" aria-modal="true" aria-label={`u/${lead.name}`}>
        <header className="rl-dhead">
          <h2>
            u/{lead.name}
            {can && <StageChip lead={lead} />}
            <button className="btn icon sm ghost rl-close" onClick={onClose} aria-label={t('close')}><Icon name="x" size={16} /></button>
          </h2>
          <div className="rl-dmeta">
            <DealRecord sales={lead.sales} buys={lead.buys} />
            <span>{t(rec)}</span>
            {lead.subreddits.length > 0 && <span>{lead.subreddits.map(s => `r/${s}`).join(', ')}</span>}
            <a className="rl-link" href={profileUrl(lead.name)} target="_blank" rel="noopener noreferrer">{t('rlProfile')}</a>
          </div>
          {lead.itemsSold.length > 0 && <div className="rl-dmeta">{t('rlSoldLately')}: {lead.itemsSold.join(' · ')}</div>}
          {lead.latestPostUrl && (
            <div className="rl-dmeta">{t('rlOurAlert')}: <a className="rl-link" href={lead.latestPostUrl} target="_blank" rel="noopener noreferrer">{lead.latestPostTitle || lead.latestPostUrl}</a></div>
          )}
          {soldTo.length > 0 && (
            <div className="rl-dmeta">{t('rlSoldToTopBuyers')}: {soldTo.slice(0, 5).map(b => <button key={b.username} className="rl-link" onClick={() => onBuyer(b.username)}>u/{b.name}</button>)}</div>
          )}
        </header>

        <div className="rl-dbody">
          {can && (
            <div className="rl-steps" role="group" aria-label={t('rlStage')}>
              {REDDIT_LEAD_STAGES.map((s, i) => (
                <button
                  key={s}
                  className={`rl-step${i < stageIdx ? ' done' : i === stageIdx ? ' now' : ''}`}
                  aria-current={i === stageIdx ? 'step' : undefined}
                  disabled={busy || !!lead.closed || i === stageIdx}
                  onClick={() => void act(leadsApi.stage(lead.username, s), t('rlMovedTo', { stage: t(STAGE_KEY[s]) }))}
                >
                  {t(STAGE_KEY[s])}
                </button>
              ))}
            </div>
          )}

          {nextBox()}

          {can && open && lead.stage !== 'claimed' && (
            <>
              <section>
                <h3>{t('rlLogReply')}</h3>
                <textarea className="textarea" rows={3} value={reply} onChange={e => setReply(e.target.value)} placeholder={t('rlReplyPlaceholder')} aria-label={t('rlLogReply')} />
                <div className="rl-row rl-end"><button className="btn sm primary" disabled={busy || !reply.trim()} onClick={() => void saveReply()}>{t('rlSaveReply')}</button></div>
              </section>
              <section>
                <h3>{t('rlNextFollowUp')}</h3>
                <div className="rl-chips">
                  {QUICK_FOLLOW.map(([days, key]) => {
                    const date = addDays(today, days);
                    return (
                      <button key={days} className={`btn sm ${lead.followUp === date ? 'rl-on' : 'ghost'}`} disabled={busy}
                        onClick={() => void act(leadsApi.followUp(lead.username, date), t('rlFollowSetToast', { date: fmtDay(date, locale) }))}>
                        {t(key)}
                      </button>
                    );
                  })}
                  <input type="date" className="input rl-date" value={lead.followUp ?? ''} aria-label={t('rlFollowDate')}
                    onChange={e => void act(leadsApi.followUp(lead.username, e.target.value || null))} />
                  {lead.followUp && <span className="rl-sub">{lead.followUp < today ? t('rlOverdueSince', { date: fmtDay(lead.followUp, locale) }) : t('rlOn', { date: fmtDay(lead.followUp, locale) })}</span>}
                </div>
              </section>
              <section>
                <h3>{t('rlCloseLead')}</h3>
                <div className="rl-chips">
                  <button className="btn sm" disabled={busy} onClick={() => void act(leadsApi.stage(lead.username, 'won'), t('rlDealMade'))}>{t('rlStageWon')}</button>
                  {(['nostock', 'lost'] as const).map(c => (
                    <button key={c} className="btn sm ghost" disabled={busy} onClick={() => void act(leadsApi.close(lead.username, c), t('rlClosedToast'))}>{t(CLOSING_KEY[c])}</button>
                  ))}
                </div>
              </section>
            </>
          )}

          {(can || manager) && history && history.length > 0 && (
            <section>
              <h3>{t('rlHistory')}</h3>
              <ul className="rl-time">
                {history.map((e, i) => (
                  <li key={i}>
                    <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString(locale)}>{relTime(new Date(e.at), locale)}</time>
                    <div>{kindText(e)}{e.kind === 'reply' && <div className="rl-quote">{e.detail}</div>}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {can && (
          <footer className="rl-dfoot">
            <span className="rl-sub">{t('rlClaimedBy', { who: lead.mine ? t('rlYouLower') : lead.holderName ?? '', when: lead.claimedAt ? relTime(new Date(lead.claimedAt), locale) : '' })}</span>
            <button className="btn sm ghost" disabled={busy} onClick={async () => { if (await act(leadsApi.release(lead.username), t('rlReleasedToast', { name: lead.name }))) onClose(); }}>
              {t('rlRelease')}
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}
