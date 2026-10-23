import { useState } from 'react';
import { ACCOUNTING_QUERY_MAX } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { FIELD_KEY, ReviewMark } from '../../../components/AccountingBits';
import { useAuth } from '../../../lib/auth';
import { useT } from '../../../lib/i18n';
import { handleFetchError } from '../../../lib/errorToast';
import { fmtDate } from '../../../lib/format';
import { useMemberNames } from '../../../lib/useManagers';
import {
  acctAnswer, acctAsk, acctMarkReviewed, acctWithdrawQuery, acctWithdrawReview,
  changesSinceReview, clearedReviewer, fmtCny, reviewActions, type AcctEntryDetail,
} from '../../../lib/accounting';
import { fieldValue } from './reviewBits';

type Props = {
  entry: AcctEntryDetail;
  // Any write: the drawer and the page re-read.
  onChanged: () => void;
  onToast?: (msg: string) => void;
};

// The entry's sign-off, in the drawer: the sell order's Sign-off card with
// one signer. It says who signed and when, what changed since, or the
// question that holds it up, and offers the viewer only what the API allows.
export function ReviewCard({ entry, onChanged, onToast }: Props) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const people = useMemberNames();
  const me = user?.id ?? '';
  const [form, setForm] = useState<null | 'query' | 'answer'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const r = entry.review;
  if (!r) return null;
  const can = reviewActions(entry, me);

  const act = async (run: () => Promise<unknown>, toast: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      onToast?.(toast);
      setForm(null);
      setText('');
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
      // A refusal usually means the entry moved under the reviewer: show them what it is now.
      onChanged();
    }
  };

  const reviewer = clearedReviewer(entry.events, r.clearedAt);
  const changes = r.state === 'changed' ? changesSinceReview(entry.events, r.clearedAt) : {};
  const lastEdit = entry.events.filter(e => e.kind === 'edited').at(-1);
  const q = r.query;
  const addressee = q?.to?.name ?? r.author?.name ?? entry.manager.name;

  let line: string;
  let detail: string | null = null;
  let foot = t('acctRvFoot');
  let warnFoot = false;
  switch (r.state) {
    case 'reviewed':
      line = r.by?.id === me ? t('acctRvReviewedByYou') : t('acctRvReviewedBy', { name: r.by?.name ?? '—' });
      detail = t('acctRvSignedAt', { when: r.at ? fmtDate(r.at, locale) : '', amount: fmtCny(entry.amountCny, locale) });
      break;
    case 'changed':
      line = reviewer ? t('acctTickChanged', { name: reviewer.name }) : t('acctTickChangedNobody');
      detail = lastEdit
        ? `${lastEdit.detail.synced === 'po' ? t('acctEvSyncedPo') : lastEdit.actor?.name ?? '—'} · ${fmtDate(lastEdit.at, locale)}`
        : null;
      foot = t('acctRvChangedFoot');
      warnFoot = true;
      break;
    case 'queried':
      line = q?.by?.id === me ? t('acctRvYouAsked', { name: addressee }) : t('acctRvQueried', { name: q?.by?.name ?? '—' });
      foot = can.answer ? t('acctRvQueriedFoot') : t('acctRvAskedFoot');
      break;
    default:
      line = can.own ? t('acctRvYours') : t('acctRvWaiting');
      detail = can.own ? t('acctRvYoursDetail')
        : r.author ? t('acctRvWaitingDetail', { name: r.author.name }) : t('acctRvWaitingNobody');
  }

  return (
    <>
      <div className="so-section-head" style={{ marginTop: 22 }}>
        <Icon name="shield" size={14} /> {t('acctReviewSection')}
        <span className={'chip dot acct-rv-chip ' + ({ open: 'muted', changed: 'warn', queried: 'info', reviewed: 'pos' }[r.state])}>
          {t('acctReviewState_' + r.state)}
        </span>
      </div>
      <div className="acct-rv-card">
        <div className="acct-rv-row">
          <ReviewMark state={r.state} own={can.own} />
          <div className="acct-rv-who">
            <div className="acct-rv-line">{line}</div>
            {detail && <div className="acct-rv-detail">{detail}</div>}
            {Object.keys(changes).length > 0 && (
              <dl className="acct-rv-diff">
                {Object.entries(changes).map(([k, ch]) => (
                  <div key={k}>
                    <dt>{FIELD_KEY[k] ? t(FIELD_KEY[k]) : k}</dt>
                    <dd>
                      <span className="acct-was">{fieldValue(k, ch.from, { t, locale, people })}</span>
                      <span aria-hidden="true">→</span>
                      <b>{fieldValue(k, ch.to, { t, locale, people })}</b>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {q && (
              <div className="acct-rv-quote">
                <div className="acct-rv-quote-by">{q.by?.name ?? '—'} · {fmtDate(q.at, locale)}</div>
                {q.text}
                {q.answer && (
                  <div className="acct-rv-answer">
                    <div className="acct-rv-quote-by">
                      {q.answer.text === null
                        ? t('acctRvAnsweredByEdit', { name: q.answer.by?.name ?? '—' })
                        : t('acctRvAnswered', { name: q.answer.by?.name ?? '—' })} · {fmtDate(q.answer.at, locale)}
                    </div>
                    {q.answer.text}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="acct-rv-actions">
            {can.query && !form && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => setForm('query')}>{t('acctQueryBtn')}</button>
            )}
            {can.answer && !form && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => setForm('answer')}>{t('acctAnswerBtn')}</button>
            )}
            {can.withdrawQuery && (
              <button type="button" className="btn sm" disabled={busy}
                      onClick={() => act(() => acctWithdrawQuery(entry.id), t('acctQueryWithdrawnToast'))}>
                {t('acctWithdrawQuery')}
              </button>
            )}
            {can.review && (
              <button type="button" className="btn sm accent" disabled={busy}
                      onClick={() => act(() => acctMarkReviewed(entry.id, r.version), t('acctReviewedToast', { id: entry.id }))}>
                <Icon name="check" size={12} /> {r.state === 'changed' ? t('acctReviewAgain') : t('acctMarkReviewed')}
              </button>
            )}
            {can.withdraw && (
              <button type="button" className="btn sm" disabled={busy}
                      onClick={() => act(() => acctWithdrawReview(entry.id), t('acctUnreviewedToast', { id: entry.id }))}>
                {t('acctWithdraw')}
              </button>
            )}
          </div>
        </div>
        {form && (
          <div className="acct-rv-form">
            <label className="label" htmlFor="acct-rv-text">
              {form === 'query' ? t('acctQueryLabel', { name: addressee }) : t('acctAnswerLabel', { name: q?.by?.name ?? '—' })}
            </label>
            <textarea id="acct-rv-text" className="input" rows={3} autoFocus maxLength={ACCOUNTING_QUERY_MAX}
                      placeholder={form === 'query' ? t('acctQueryPh') : undefined}
                      value={text} onChange={e => setText(e.target.value)} />
            <div className="acct-rv-form-row">
              <button type="button" className="btn sm" disabled={busy} onClick={() => { setForm(null); setText(''); }}>{t('cancel')}</button>
              <button type="button" className="btn sm accent" disabled={busy || !text.trim()}
                      onClick={() => act(
                        () => (form === 'query' ? acctAsk(entry.id, text.trim()) : acctAnswer(entry.id, text.trim())),
                        form === 'query' ? t('acctQueriedToast', { name: addressee }) : t('acctAnsweredToast'),
                      )}>
                {form === 'query' ? t('acctSendQuery') : t('acctSendAnswer')}
              </button>
            </div>
          </div>
        )}
        <div className={'acct-rv-foot' + (warnFoot ? ' warn' : '')}>{foot}</div>
      </div>
    </>
  );
}
