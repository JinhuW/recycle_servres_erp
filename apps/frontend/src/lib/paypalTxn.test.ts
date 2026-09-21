import { describe, it, expect } from 'vitest';
import { normalizePaypalTxnInput, isStrictPaypalTxnId, readPaypalScan } from './paypalTxn';

describe('normalizePaypalTxnInput', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizePaypalTxnInput(' 8xy12345 ab678901c ')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnInput('8XY12345AB678901C')).toBe('8XY12345AB678901C');
    expect(normalizePaypalTxnInput('')).toBe('');
  });
});

describe('isStrictPaypalTxnId', () => {
  it('accepts exactly 17 uppercase alphanumerics', () => {
    expect(isStrictPaypalTxnId('8XY12345AB678901C')).toBe(true);
    expect(isStrictPaypalTxnId('8XY12345AB678901')).toBe(false);   // 16
    expect(isStrictPaypalTxnId('8XY12345AB678901CD')).toBe(false); // 18
    expect(isStrictPaypalTxnId('8xy12345ab678901c')).toBe(false);  // lowercase
    expect(isStrictPaypalTxnId('8XY12345-B678901C')).toBe(false);  // punctuation
  });
});

describe('readPaypalScan', () => {
  const scan = (over: Partial<{ txnId: string | null; confidence: number; provider: string }>) =>
    ({ txnId: '7ab12345cd678901e', confidence: 0.9, provider: 'openrouter', ...over });

  it('offers a confident read, normalised', () => {
    expect(readPaypalScan(scan({}))).toEqual({ txnId: '7AB12345CD678901E', noticeKey: 'hoShotRead' });
  });
  it('flags a weak read for checking, and offers nothing below the unreadable floor', () => {
    expect(readPaypalScan(scan({ confidence: 0.4 }))).toEqual({ txnId: '7AB12345CD678901E', noticeKey: 'shipPayVerifyTxn' });
    expect(readPaypalScan(scan({ confidence: 0.2 }))).toEqual({ txnId: null, noticeKey: 'shipPayNoTxnFound' });
    expect(readPaypalScan(scan({ txnId: null }))).toEqual({ txnId: null, noticeKey: 'shipPayNoTxnFound' });
  });
  it('names the demo provider so a canned id is never mistaken for a reading', () => {
    expect(readPaypalScan(scan({ provider: 'stub' })).noticeKey).toBe('stubScanWarn');
  });
});
