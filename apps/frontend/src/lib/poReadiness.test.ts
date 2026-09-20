import { describe, it, expect } from 'vitest';
import { handoffBlockerKeys, type HandoffRules } from './handoff';
import { BLOCKER_TAB, SERVER_BLOCKER_KEY, poReadiness, readinessBlockerKeys } from './poReadiness';

const rules: HandoffRules = {
  source: 'facebook',
  delivery: 'pickup',
  trackingValid: false,
  carrier: null,
  paidBy: 'company',
  method: 'paypal',
  txnId: '8XY12345AB678901C',
  chatAttachmentCount: 0,
  proofAttachmentCount: 0,
  saved: { payment: 'company', paymentMethod: 'paypal', txnRequired: true, chatShotRequired: false, cashShotRequired: false },
};
const lines = { count: 1, goods: 120, everSubmitted: false };
const byTab = (items: ReturnType<typeof poReadiness>) =>
  Object.fromEntries(items.map(i => [i.tab, i.needKeys]));

describe('poReadiness', () => {
  it('a filled-in Draft has three met rows and no blockers', () => {
    const items = poReadiness({ rules, lines });
    expect(items.map(i => i.tab)).toEqual(['products', 'delivery', 'payment']);
    expect(items.every(i => i.ok)).toBe(true);
    expect(readinessBlockerKeys(items)).toEqual([]);
  });

  it('an empty draft wants products first; a $0 unsubmitted one wants a cost', () => {
    expect(byTab(poReadiness({ rules, lines: { count: 0, goods: 0, everSubmitted: false } })).products)
      .toEqual(['poReadyNoProducts']);
    expect(byTab(poReadiness({ rules, lines: { count: 2, goods: 0, everSubmitted: false } })).products)
      .toEqual(['poReadyNoCost']);
    // Re-submitting as accepted: the cost rule is first-submission only.
    expect(byTab(poReadiness({ rules, lines: { count: 2, goods: 0, everSubmitted: true } })).products)
      .toEqual([]);
  });

  it('routes each hand-off key to the section that fixes it', () => {
    const items = poReadiness({
      rules: { ...rules, source: null, delivery: 'label', trackingValid: false, method: null, txnId: '' },
      lines,
    });
    expect(byTab(items)).toEqual({
      products: [],
      delivery: ['hoNeedSource', 'hoNeedTracking'],
      payment: ['hoNeedMethod'],
    });
    expect(readinessBlockerKeys(items)).toEqual(['hoNeedSource', 'hoNeedTracking', 'hoNeedMethod']);
  });

  it('every key the per-field rule can emit has a section', () => {
    const emitted = new Set<string>();
    const variants: Partial<HandoffRules>[] = [
      { source: null, delivery: null },
      { delivery: 'label', trackingValid: false },
      { delivery: 'label', trackingValid: true, carrier: null },
      { method: null },
      { method: 'paypal', txnId: '' },
      { method: 'cash', proofAttachmentCount: 0 },
      { paidBy: 'self', chatAttachmentCount: 0, saved: { payment: 'self', chatShotRequired: true } },
    ];
    for (const v of variants) handoffBlockerKeys({ ...rules, ...v }).forEach(k => emitted.add(k));
    expect(emitted.size).toBeGreaterThanOrEqual(7);
    for (const k of emitted) expect(BLOCKER_TAB[k], k).toBeDefined();
    for (const k of Object.values(SERVER_BLOCKER_KEY)) expect(BLOCKER_TAB[k], k).toBeDefined();
  });

  it('prefers the server list for a clean section and the form for a dirty one', () => {
    // Saved: company/PayPal with an id PayPal has never seen. The form can't
    // know that; the server can. Delivery is clean too.
    const server = ['missingSource', 'unknownTxnId'];
    const clean = poReadiness({ rules, lines, serverBlockers: server });
    expect(byTab(clean)).toEqual({ products: [], delivery: ['hoNeedSource'], payment: ['poTxnUnknown'] });

    // The user just picked a source and retyped the id: the form wins on
    // those sections, the server still speaks for products.
    const dirty = poReadiness({
      rules, lines, serverBlockers: [...server, 'noCost'],
      dirty: { delivery: true, payment: true },
    });
    expect(byTab(dirty)).toEqual({ products: ['poReadyNoCost'], delivery: [], payment: [] });
  });

  it('ignores server kinds it does not know, and a missing list means form only', () => {
    expect(poReadiness({ rules, lines, serverBlockers: ['somethingNew'] }).every(i => i.ok)).toBe(true);
    expect(byTab(poReadiness({ rules: { ...rules, source: null }, lines, serverBlockers: null })).delivery)
      .toEqual(['hoNeedSource']);
  });

  it('a manager gets a commission row that asks but never blocks', () => {
    const noRate = poReadiness({ rules, lines, commission: { rate: null } });
    const row = noRate.find(i => i.tab === 'commission')!;
    expect(row).toMatchObject({ ok: false, blocking: false, needKeys: ['poReadyCommissionUnset'] });
    expect(readinessBlockerKeys(noRate)).toEqual([]);
    expect(poReadiness({ rules, lines, commission: { rate: 0.1 } }).find(i => i.tab === 'commission')!.ok).toBe(true);
    expect(poReadiness({ rules, lines }).some(i => i.tab === 'commission')).toBe(false);
  });
});
