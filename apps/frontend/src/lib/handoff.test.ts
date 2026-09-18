import { describe, it, expect } from 'vitest';
import { buildHandoffBody, handoffBlockerKeys, type HandoffRules } from './handoff';

const base: HandoffRules = {
  source: 'facebook',
  delivery: 'pickup',
  trackingValid: false,
  carrier: null,
  paidBy: 'company',
  method: 'cash',
  txnId: '',
  chatAttachmentCount: 0,
  proofAttachmentCount: 1,
  saved: { payment: 'company', txnRequired: true, chatShotRequired: false, cashShotRequired: true },
};

describe('handoffBlockerKeys', () => {
  it('is empty for a company cash pickup with a source', () => {
    expect(handoffBlockerKeys(base)).toEqual([]);
  });

  it('asks for a source and a delivery choice first', () => {
    expect(handoffBlockerKeys({ ...base, source: null, delivery: null }))
      .toEqual(['hoNeedSource', 'hoNeedDelivery']);
  });

  it('a label needs a valid tracking number, then a resolved carrier', () => {
    expect(handoffBlockerKeys({ ...base, delivery: 'label' })).toEqual(['hoNeedTracking']);
    expect(handoffBlockerKeys({ ...base, delivery: 'label', trackingValid: true })).toEqual(['hoNeedCarrier']);
    expect(handoffBlockerKeys({ ...base, delivery: 'label', trackingValid: true, carrier: 'UPS' })).toEqual([]);
  });

  it('company + PayPal needs the transaction id; cash lifts it', () => {
    expect(handoffBlockerKeys({ ...base, method: 'paypal' })).toEqual(['poTxnRequired']);
    expect(handoffBlockerKeys({ ...base, method: 'paypal', txnId: '8XY12345AB678901C' })).toEqual([]);
    expect(handoffBlockerKeys({ ...base, method: 'cash' })).toEqual([]);
  });

  it('company card must say how it paid', () => {
    expect(handoffBlockerKeys({ ...base, method: null })).toEqual(['hoNeedMethod']);
    // Not a company question: a self-paid order carries no method.
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', method: null, chatAttachmentCount: 1, saved: { payment: 'self' } }))
      .toEqual([]);
  });

  it('company + cash needs the amount screenshot, and an older backend blocks too', () => {
    expect(handoffBlockerKeys({ ...base, proofAttachmentCount: 0 })).toEqual(['hoNeedCashShot']);
    expect(handoffBlockerKeys({ ...base, proofAttachmentCount: 2 })).toEqual([]);
    expect(handoffBlockerKeys({ ...base, proofAttachmentCount: 0, saved: { payment: 'company', cashShotRequired: false } }))
      .toEqual([]);
    expect(handoffBlockerKeys({ ...base, proofAttachmentCount: 0, saved: { payment: 'self', cashShotRequired: false } }))
      .toEqual(['hoNeedCashShot']);
    // PayPal never asks for it.
    expect(handoffBlockerKeys({ ...base, method: 'paypal', txnId: '8XY12345AB678901C', proofAttachmentCount: 0 }))
      .toEqual([]);
  });

  it('keeps a pre-cutoff company order exempt, but only while it is still company-paid', () => {
    const exempt = { ...base, method: 'paypal' as const, saved: { payment: 'company' as const, txnRequired: false } };
    expect(handoffBlockerKeys(exempt)).toEqual([]);
    // The exemption was computed for a self-paid order; switching to company
    // in the dialog must not inherit it.
    expect(handoffBlockerKeys({ ...exempt, saved: { payment: 'self', txnRequired: false } })).toEqual(['poTxnRequired']);
  });

  it('self-paid needs the chat screenshot, and an older backend blocks too', () => {
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', saved: { payment: 'self' } })).toEqual(['hoNeedChatShot']);
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', chatAttachmentCount: 1, saved: { payment: 'self' } })).toEqual([]);
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', saved: { payment: 'self', chatShotRequired: false } })).toEqual([]);
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', saved: { payment: 'company', chatShotRequired: false } })).toEqual(['hoNeedChatShot']);
  });

  it('never asks a self-paid order for a transaction id', () => {
    expect(handoffBlockerKeys({ ...base, paidBy: 'self', method: 'paypal', chatAttachmentCount: 1, saved: { payment: 'self' } }))
      .toEqual([]);
  });
});

describe('buildHandoffBody', () => {
  const draft = {
    warehouseId: 'WH-LA1', source: 'reddit' as const, delivery: 'pickup' as const, byUserId: 'u1',
    trackingNumber: '', carrier: null, paidBy: 'self' as const, method: 'paypal' as const,
    txnId: '8XY12345AB678901C', screenshot: { key: 'k', url: 'https://x/k' },
  };

  it('sends no method, id or screenshot for a self-paid order', () => {
    expect(buildHandoffBody(draft)).toEqual({
      warehouseId: 'WH-LA1', source: 'reddit', handoff: { method: 'pickup', byUserId: 'u1' }, payment: 'self',
    });
  });

  it('sends the method, and the id + screenshot only for PayPal', () => {
    expect(buildHandoffBody({ ...draft, paidBy: 'company' })).toMatchObject({
      payment: 'company', paymentMethod: 'paypal', paypalTxnId: '8XY12345AB678901C',
      paymentScreenshotKey: 'k', paymentScreenshotUrl: 'https://x/k',
    });
    const cash = buildHandoffBody({ ...draft, paidBy: 'company', method: 'cash' });
    expect(cash.paymentMethod).toBe('cash');
    expect(cash).not.toHaveProperty('paypalTxnId');
    expect(cash).not.toHaveProperty('paymentScreenshotKey');
  });

  it('shapes a label hand-off and the manager-only fields', () => {
    expect(buildHandoffBody({
      ...draft, delivery: 'label', trackingNumber: '1Z999AA10123456784', carrier: 'UPS',
      ownerId: 'u2', commissionRate: 0.1,
    })).toMatchObject({
      handoff: { method: 'label', trackingNumber: '1Z999AA10123456784', carrier: 'UPS' },
      onBehalfOfUserId: 'u2', commissionRate: 0.1,
    });
  });
});
