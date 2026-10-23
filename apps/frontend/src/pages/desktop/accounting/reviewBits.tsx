import type { AccountingCheck, AccountingKind } from '@recycle-erp/shared';
import { FIGURE_KEY, FIELD_KEY, ReviewMark } from '../../../components/AccountingBits';
import { fmtCny, fmtBookDay, type AcctEntry, type AcctReviewRow } from '../../../lib/accounting';
import { fmtDate, fmtMoney } from '../../../lib/format';
import type { Translate } from '../../../lib/orderPresentation';

// How the desktop Accounting surfaces say what a review knows: a check as a
// sentence, a row's one chip, a changed field's old and new value, and the
// book's tick.

const pct = (n: number) => `${(Math.abs(n) * 100).toFixed(1)}%`;

/** A check as Review mode's side panel states it: a bold head, then why. */
export function checkLines(
  c: AccountingCheck, row: Pick<AcctReviewRow, 'kind' | 'targetFacts'>, t: Translate, locale: string,
): { head: string; text: string } {
  switch (c.kind) {
    case 'record': {
      const tf = row.targetFacts;
      const amount = tf?.amount == null ? fmtCny(c.figureCny, locale)
        : tf.currency === 'CNY' ? fmtCny(tf.amount, locale)
        : `${fmtMoney(tf.amount, 'USD', locale)} ≈ ${fmtCny(c.figureCny, locale)}`;
      const head = c.verdict === 'matches' ? t('acctChkMatches')
        : t(c.verdict === 'over' ? 'acctChkOver' : 'acctChkShort', { diff: fmtCny(Math.abs(c.diffCny), locale) });
      return {
        head,
        text: t('acctChkRecordText', {
          figure: t(FIGURE_KEY[row.kind as Exclude<AccountingKind, 'other'>]), amount,
          recorded: fmtCny(c.recordedCny, locale),
        }),
      };
    }
    case 'noFigure': return { head: t('acctChkNoFigure'), text: t('acctChkNoFigureText') };
    case 'noRecord': return { head: t('acctChkNoRecord'), text: t('acctChkNoRecordText') };
    case 'recordGone': return { head: t('acctChkRecordGone'), text: t('acctChkRecordGoneText') };
    case 'rate': return {
      head: t(c.pct > 0 ? 'acctChkRateHigh' : 'acctChkRateLow', { pct: pct(c.pct) }),
      text: t('acctChkRateText', { rate: c.rate.toFixed(4), ledger: c.ledgerRate.toFixed(4) }),
    };
    case 'duplicate': return { head: t('acctChkDuplicate'), text: t('acctChkDuplicateText', { id: c.of }) };
    case 'businessReceived': return { head: t('acctChkBusinessReceived'), text: t('acctChkBusinessReceivedText') };
  }
}

/** The one chip a row carries: what changed, else the first warning, else
 *  how the entry sits against its record. */
export function rowChip(row: AcctReviewRow, t: Translate, locale: string): { label: string; tone: string } {
  if (row.review?.state === 'changed' && row.cleared) {
    const fields = Object.keys(row.cleared.changes).map(k => (FIELD_KEY[k] ? t(FIELD_KEY[k]) : k).toLowerCase());
    return { label: t('acctChipChanged', { fields: fields.join(', ') }), tone: 'warn' };
  }
  const warn = row.checks.find(c => c.tone === 'warn');
  const c = warn ?? row.checks[0];
  if (!c) return { label: '', tone: 'muted' };
  switch (c.kind) {
    case 'record':
      if (c.verdict === 'matches') return { label: t('acctChipMatches'), tone: 'pos' };
      return {
        label: t(c.verdict === 'over' ? 'acctChipOver' : 'acctChipShort', { diff: fmtCny(Math.abs(c.diffCny), locale) }),
        tone: c.verdict === 'over' ? 'warn' : 'muted',
      };
    case 'rate': return { label: t('acctChipRate', { pct: pct(c.pct) }), tone: 'warn' };
    case 'duplicate': return { label: t('acctChipDuplicate'), tone: 'warn' };
    case 'businessReceived': return { label: t('acctChipBusinessReceived'), tone: 'warn' };
    case 'noRecord': return { label: t('acctChipNoRecord'), tone: 'muted' };
    case 'noFigure': case 'recordGone': return { label: checkLines(c, row, t, locale).head.replace(/\.$/, ''), tone: 'muted' };
  }
}

/** A field's value in a was → now line, the way the entry's own form shows it. */
export function fieldValue(
  field: string, v: unknown, ctx: { t: Translate; locale: string; people: { id: string; name: string }[] },
): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (field) {
    case 'amount': return Number(v).toLocaleString(ctx.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'fxRate': return Number(v).toFixed(4);
    case 'direction': return ctx.t('acctDir_' + String(v));
    case 'kind': return ctx.t('acctKind_' + String(v));
    case 'method': return ctx.t('acctMethod_' + String(v));
    case 'occurredOn': return fmtBookDay(String(v), ctx.locale, true);
    case 'managerId': return ctx.people.find(m => m.id === v)?.name ?? '—';
    default: return String(v);
  }
}

const firstName = (name: string) => name.split(/\s+/)[0] || name;

/** The book's last column: who signed the entry off, or what it still waits on. */
export function ReviewTick({ e, me, t, locale }: { e: AcctEntry; me: string; t: Translate; locale: string }) {
  const r = e.review;
  if (!r) return null;
  const own = r.state !== 'reviewed' && r.author?.id === me;
  const title = r.state === 'reviewed'
    ? t('acctTickReviewed', { name: r.by?.name ?? '—', when: r.at ? fmtDate(r.at, locale) : '' })
    : r.state === 'queried' ? t('acctTickQueried', { name: r.query?.by?.name ?? '—', text: r.query?.text ?? '' })
    : r.state === 'changed' ? t('acctTickChangedNobody')
    : own ? t('acctTickOwn') : t('acctTickOpen');
  const label = r.state === 'reviewed' ? firstName(r.by?.name ?? '—')
    : r.state === 'changed' ? t('acctTickChangedShort')
    : t('acctReviewState_' + r.state);
  return (
    <span className={'acct-tick acct-tick-' + (own ? 'own' : r.state)} title={title}>
      <ReviewMark state={r.state} own={own} size={18} />
      <span className="acct-tick-label">{label}</span>
    </span>
  );
}
