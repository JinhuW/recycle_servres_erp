import { describe, it, expect } from 'vitest';
import { applyKind, initialForm, pickTarget, previewCny, toRequestBody } from './accountingForm';
import { markDayStarts, phonePeriod, splitYuan, fmtCny, fmtSignedCny } from './accounting';

const ME = '11111111-1111-1111-1111-111111111111';
const TODAY = '2026-10-21';

describe('the entry form', () => {
  it('opens on the kind it was given, with that kind\'s direction and the record locked', () => {
    const f = initialForm({ meId: ME, today: TODAY, preset: { kind: 'sale', target: { id: 'SO-1', party: 'Acme' } } });
    expect(f).toMatchObject({
      kind: 'sale', direction: 'in', targetLocked: true, counterparty: 'Acme', occurredOn: TODAY, managerId: ME, currency: 'CNY',
    });
    expect(applyKind(f, 'purchase')).toBe(f);
  });

  it('follows the kind\'s direction until the manager flips it, and drops a record of another sort', () => {
    let f = initialForm({ meId: ME, today: TODAY });
    f = pickTarget(applyKind(f, 'purchase'), { id: 'PO-1', party: 'Supplier' });
    expect(f).toMatchObject({ direction: 'out', counterparty: 'Supplier' });
    // Commission is the same record type: the PO stays.
    expect(applyKind(f, 'commission').target).toEqual({ id: 'PO-1', party: 'Supplier' });
    const sale = applyKind(f, 'sale');
    expect(sale).toMatchObject({ direction: 'in', target: null, counterparty: '' });
    const flipped = applyKind({ ...f, direction: 'in', directionTouched: true }, 'sale');
    expect(flipped.direction).toBe('in');
    expect(applyKind({ ...flipped, direction: 'out' }, 'after_sales').direction).toBe('out');
  });

  it('keeps a counterparty the manager typed when the record changes', () => {
    const f = { ...initialForm({ meId: ME, today: TODAY, preset: { kind: 'purchase' } }), counterparty: 'Typed', counterpartyTouched: true };
    expect(pickTarget(f, { id: 'PO-2', party: 'Other' }).counterparty).toBe('Typed');
  });

  it('turns into a request, or names what is missing', () => {
    const f = initialForm({ meId: ME, today: TODAY, preset: { kind: 'purchase' } });
    expect(toRequestBody(f)).toEqual({ error: 'acctErrAmount' });
    expect(toRequestBody({ ...f, amount: '12.345' })).toEqual({ error: 'acctErrTarget' });
    expect(toRequestBody({ ...f, amount: '12.345' }, { orphan: true })).toMatchObject({ body: { targetId: null } });
    const ok = toRequestBody(pickTarget({ ...f, amount: '12.345', note: '  ' }, { id: 'PO-1' }));
    expect(ok).toEqual({
      body: {
        direction: 'out', kind: 'purchase', amount: 12.35, currency: 'CNY', fxRate: null, method: 'bank',
        occurredOn: TODAY, managerId: ME, targetId: 'PO-1', counterparty: null, reference: null, note: null,
      },
    });
    expect(toRequestBody({ ...f, kind: 'other', amount: '5', currency: 'USD', fxRate: '700' })).toEqual({ error: 'acctErrRate' });
    // An Other entry never sends a record, whatever was picked before.
    expect(toRequestBody({ ...f, kind: 'other', amount: '5', target: { id: 'PO-1' } })).toMatchObject({ body: { targetId: null } });
  });

  it('previews what dollars come to in the book', () => {
    const f = { ...initialForm({ meId: ME, today: TODAY }), amount: '100', currency: 'USD' as const };
    expect(previewCny(f, 7.2)).toBe(720);
    expect(previewCny({ ...f, fxRate: '7.1' }, 7.2)).toBe(710);
    expect(previewCny({ ...f, currency: 'CNY' }, null)).toBe(100);
    expect(previewCny({ ...f, amount: '' }, 7.2)).toBeNull();
  });
});

describe('book formatting', () => {
  it('splits a figure into whole yuan and fen', () => {
    expect(splitYuan(154500, 'en-US')).toEqual({ sign: '', whole: '154,500', fraction: '.00' });
    expect(splitYuan(-12.5, 'zh-CN')).toEqual({ sign: '−', whole: '12', fraction: '.50' });
    expect(splitYuan(-0.001, 'en-US').sign).toBe('');
    expect(fmtCny(1234.5, 'en-US')).toBe('¥1,234.50');
    expect(fmtSignedCny(-20, 'en-US')).toBe('−¥20.00');
    expect(fmtSignedCny(20, 'en-US')).toBe('+¥20.00');
  });

  it('prints a day once', () => {
    expect(markDayStarts([{ occurredOn: '2026-10-21' }, { occurredOn: '2026-10-21' }, { occurredOn: '2026-10-20' }]))
      .toEqual([true, false, true]);
  });

  it('resolves the phone\'s periods', () => {
    expect(phonePeriod('month', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
    expect(phonePeriod('lastMonth', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(phonePeriod('lastMonth', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(phonePeriod('30d', TODAY)).toEqual({ from: '2026-09-22', to: TODAY });
    expect(phonePeriod('year', TODAY)).toEqual({ from: '2026-01-01', to: TODAY });
  });
});

describe('the book\'s built labels', () => {
  it('names every kind, method, direction and phone period in both languages', async () => {
    const { I18N } = await import('./i18n');
    const zh = (await import('./i18n.zh')).default;
    const { ACCOUNTING_KINDS, ACCOUNTING_METHODS, ACCOUNTING_DIRECTIONS } = await import('@recycle-erp/shared');
    const { PHONE_PERIODS } = await import('./accounting');
    const keys = [
      ...ACCOUNTING_KINDS.map(k => 'acctKind_' + k),
      ...ACCOUNTING_METHODS.map(m => 'acctMethod_' + m),
      ...ACCOUNTING_DIRECTIONS.map(d => 'acctDir_' + d),
      ...PHONE_PERIODS.map(p => 'acctPhPeriod_' + p),
    ];
    expect(keys.filter(k => !(k in I18N.en!))).toEqual([]);
    expect(keys.filter(k => !(k in zh))).toEqual([]);
  });
});
