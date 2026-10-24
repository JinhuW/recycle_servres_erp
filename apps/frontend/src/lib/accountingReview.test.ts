import { describe, it, expect } from 'vitest';
import {
  accountingReviewActions, accountingReviewRefusal, foldChanges, type AccountingCheck, type AccountingReviewSubject,
} from '@recycle-erp/shared';
import { eventAgent } from '../components/AccountingBits';
import { checkLines, fieldValue, rowChip } from '../pages/desktop/accounting/reviewBits';
import type { AcctEvent, AcctReviewRow } from './accounting';

// The review rules both the API and the pages run, and the pure pieces the
// desktop Accounting surfaces say them with.

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);

describe('accountingReviewRefusal', () => {
  const ALEX = 'alex', SOFIA = 'sofia', TIM = 'tim';
  const subject = (over: Partial<AccountingReviewSubject>): AccountingReviewSubject => ({
    state: 'open', authorId: ALEX, reviewedBy: null, queryBy: null, queryTo: null, addressee: ALEX, ...over,
  });

  it('gives each refusal its reason, in the order the API checks them', () => {
    expect(accountingReviewRefusal(subject({ state: null }), SOFIA, 'review')).toBe('voided');
    expect(accountingReviewRefusal(subject({ state: 'reviewed', reviewedBy: TIM }), SOFIA, 'review')).toBe('reviewed');
    expect(accountingReviewRefusal(subject({}), ALEX, 'review')).toBe('own');
    expect(accountingReviewRefusal(subject({}), SOFIA, 'review')).toBeNull();
    // A sign-off may close an open question.
    expect(accountingReviewRefusal(subject({ state: 'queried', queryBy: SOFIA, queryTo: ALEX }), SOFIA, 'review')).toBeNull();
  });

  it('lets only the reviewer withdraw a sign-off', () => {
    const done = subject({ state: 'reviewed', reviewedBy: SOFIA });
    expect(accountingReviewRefusal(done, SOFIA, 'withdraw')).toBeNull();
    expect(accountingReviewRefusal(done, TIM, 'withdraw')).toBe('notReviewer');
    expect(accountingReviewRefusal(subject({}), SOFIA, 'withdraw')).toBe('notReviewed');
    expect(accountingReviewRefusal(subject({ state: null }), SOFIA, 'withdraw')).toBe('notReviewed');
  });

  it('asks one question at a time, never of the asker', () => {
    expect(accountingReviewRefusal(subject({ state: 'changed' }), SOFIA, 'query')).toBeNull();
    expect(accountingReviewRefusal(subject({ state: 'queried' }), SOFIA, 'query')).toBe('openQuestion');
    expect(accountingReviewRefusal(subject({ state: 'reviewed' }), SOFIA, 'query')).toBe('reviewed');
    expect(accountingReviewRefusal(subject({}), ALEX, 'query')).toBe('own');
    // Nobody wrote it and it is Sofia's money: hers to correct, not to ask about.
    expect(accountingReviewRefusal(subject({ authorId: null, addressee: SOFIA }), SOFIA, 'query')).toBe('yours');
  });

  it('lets only the addressee answer and only the asker withdraw', () => {
    const asked = subject({ state: 'queried', queryBy: SOFIA, queryTo: TIM });
    expect(accountingReviewRefusal(asked, TIM, 'answer')).toBeNull();
    // The author is not the addressee once the question was put to someone else.
    expect(accountingReviewRefusal(asked, ALEX, 'answer')).toBe('notAddressee');
    expect(accountingReviewRefusal(asked, SOFIA, 'withdrawQuery')).toBeNull();
    expect(accountingReviewRefusal(asked, TIM, 'withdrawQuery')).toBe('notAsker');
    expect(accountingReviewRefusal(subject({}), TIM, 'answer')).toBe('noQuestion');
    expect(accountingReviewRefusal(subject({ state: null, queryBy: SOFIA }), SOFIA, 'withdrawQuery')).toBe('noQuestion');
  });

  it('offers exactly what it does not refuse', () => {
    const asked = subject({ state: 'queried', queryBy: SOFIA, queryTo: ALEX });
    expect(accountingReviewActions(asked, ALEX)).toEqual({
      review: false, withdraw: false, query: false, answer: true, withdrawQuery: false, own: true,
    });
    expect(accountingReviewActions(asked, SOFIA)).toEqual({
      review: true, withdraw: false, query: false, answer: false, withdrawQuery: true, own: false,
    });
    expect(accountingReviewActions(subject({ state: 'reviewed', reviewedBy: SOFIA }), ALEX).own).toBe(false);
  });
});

describe('foldChanges', () => {
  it('reads a run of edits as one, first value to last', () => {
    expect(foldChanges([
      { amount: { from: 100, to: 120 } },
      { amount: { from: 120, to: 130 }, method: { from: 'alipay', to: 'cash' } },
      null,
    ])).toEqual({ amount: { from: 100, to: 130 }, method: { from: 'alipay', to: 'cash' } });
  });

  it('drops a field put back as it was', () => {
    expect(foldChanges([{ amount: { from: 100, to: 120 } }, { amount: { from: 120, to: 100 } }])).toEqual({});
    expect(foldChanges([{ targetId: { from: 'PO-1', to: null } }, { targetId: { from: null, to: 'PO-1' } }])).toEqual({});
  });
});

describe('the review panel\'s words', () => {
  const row = (over: Partial<AcctReviewRow>): AcctReviewRow => ({
    id: 'AC-1', direction: 'out', kind: 'purchase', amount: 100, currency: 'CNY', fxRate: null, amountCny: 100,
    method: 'alipay', occurredOn: '2026-10-05', manager: { id: 'alex', name: 'Alex' },
    target: { type: 'po', id: 'PO-1' }, counterparty: null, reference: null, note: null,
    createdAt: '', updatedAt: '', createdBy: null, voided: null,
    review: { state: 'open', version: 'v', author: null, by: null, at: null, clearedAt: null, query: null },
    targetFacts: { id: 'PO-1', status: 'done', party: null, amount: 100, currency: 'USD', recordedCny: 700 },
    checks: [], cleared: null, attachments: [], ...over,
  });
  const record = (verdict: 'matches' | 'over' | 'short', diffCny: number): AccountingCheck => ({
    kind: 'record', tone: verdict === 'matches' ? 'ok' : verdict === 'over' ? 'warn' : 'info',
    verdict, figureCny: 700, recordedCny: 700 + diffCny, diffCny,
  });

  it('puts what changed before any warning, and a warning before the record', () => {
    const changed = row({
      review: { state: 'changed', version: 'v', author: null, by: null, at: null, clearedAt: 'x', query: null },
      cleared: { reviewer: null, at: 'x', changes: { amount: { from: 1, to: 2 } }, followedPo: false },
      checks: [record('over', 50)],
    });
    expect(rowChip(changed, t, 'en-US')).toEqual({ label: 'acctChipChanged {"fields":"acctfieldamount"}', tone: 'warn' });
    const dup: AccountingCheck = { kind: 'duplicate', tone: 'warn', of: 'AC-2' };
    expect(rowChip(row({ checks: [record('matches', 0), dup] }), t, 'en-US')).toEqual({ label: 'acctChipDuplicate', tone: 'warn' });
    expect(rowChip(row({ checks: [record('matches', 0)] }), t, 'en-US')).toEqual({ label: 'acctChipMatches', tone: 'pos' });
    expect(rowChip(row({ checks: [record('short', -200)] }), t, 'en-US').tone).toBe('muted');
    expect(rowChip(row({ checks: [] }), t, 'en-US')).toEqual({ label: '', tone: 'muted' });
  });

  it('states a record check with the record\'s own figure', () => {
    const l = checkLines(record('over', 50), row({}), t, 'en-US');
    expect(l.head).toContain('acctChkOver');
    expect(l.text).toContain('$100.00');
    expect(checkLines({ kind: 'businessReceived', tone: 'warn' }, row({}), t, 'en-US').head).toBe('acctChkBusinessReceived');
  });

  it('reads a changed value the way the entry\'s form shows it', () => {
    const ctx = { t, locale: 'en-US', people: [{ id: 'tim', name: 'Tim' }] };
    expect(fieldValue('managerId', 'tim', ctx)).toBe('Tim');
    expect(fieldValue('managerId', 'gone', ctx)).toBe('—');
    expect(fieldValue('amount', 1880, ctx)).toBe('1,880.00');
    expect(fieldValue('fxRate', 7.1, ctx)).toBe('7.1000');
    expect(fieldValue('method', 'cash', ctx)).toBe('acctMethod_cash');
    expect(fieldValue('note', '', ctx)).toBe('—');
  });
});

describe('eventAgent', () => {
  const ev = (kind: AcctEvent['kind'], detail: AcctEvent['detail']) => ({ kind, detail });

  it('names what wrote an event nobody made', () => {
    expect(eventAgent(ev('edited', { synced: 'po' }), t)).toBe('acctEvSyncedPo');
    expect(eventAgent(ev('edited', { synced: 'po', clearedReview: { by: 'sofia', at: '' } }), t)).toBe('acctEvSyncedPoCleared');
    expect(eventAgent(ev('voided', { synced: 'po' }), t)).toBe('acctEvVoidedPo');
    expect(eventAgent(ev('created', { backfilled: 'payer' }), t)).toBe('acctEvBackfilledPayer');
    expect(eventAgent(ev('created', { backfilled: 'commission_paid_by' }), t)).toBe('acctEvBackfilledPaidBy');
  });

  it('leaves a person\'s own event to its actor', () => {
    expect(eventAgent(ev('edited', { changes: {} }), t)).toBeNull();
    expect(eventAgent(ev('voided', { reason: 'typo' }), t)).toBeNull();
  });
});
