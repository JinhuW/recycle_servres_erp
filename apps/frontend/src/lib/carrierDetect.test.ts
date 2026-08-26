import { describe, it, expect } from 'vitest';
import {
  detectCarriers, extractTrackingFromBarcode, isValidTracking, normalizeTracking,
} from './carrierDetect';

describe('normalizeTracking', () => {
  it('strips spaces and hyphens and uppercases', () => {
    expect(normalizeTracking(' 1z 999-aa1 0123 456 784 ')).toBe('1Z999AA10123456784');
  });

  it('strips zero-width and bidi characters from chat-app pastes', () => {
    expect(normalizeTracking('1z\u200B999\u200Faa1\u2060 0123\u200E456 784\uFEFF'))
      .toBe('1Z999AA10123456784');
  });

  it('strips barcode control characters (FNC1/GS) a raw decoder can emit', () => {
    expect(normalizeTracking('9400\x1d1118 9922 3333 333333')).toBe('9400111899223333333333');
  });
});

describe('isValidTracking', () => {
  it('accepts real carrier numbers', () => {
    expect(isValidTracking('1Z999AA10123456784')).toBe(true);
    expect(isValidTracking('9400111899223333333333')).toBe(true);
    expect(isValidTracking(' 1z 999-aa1 0123 456 784 ')).toBe(true);
  });

  it('rejects too-short input and whole-barcode dumps', () => {
    expect(isValidTracking('1234567')).toBe(false);
    // A FedEx-96 barcode left unwrapped runs ~34 digits \u2014 never a number to store.
    expect(isValidTracking('9'.repeat(34))).toBe(false);
  });

  it('rejects anything beyond letters and digits', () => {
    expect(isValidTracking('12%45678')).toBe(false);
    expect(isValidTracking('1234_5678')).toBe(false);
    expect(isValidTracking('https://t.co/abc12345')).toBe(false);
  });
});

describe('extractTrackingFromBarcode', () => {
  it('passes a UPS 1Z scan through normalized', () => {
    expect(extractTrackingFromBarcode(' 1z 999-aa1 0123 456 784 ')).toBe('1Z999AA10123456784');
  });

  it('strips the USPS IMpb 420+ZIP5 routing prefix', () => {
    expect(extractTrackingFromBarcode('420802299400111899223333333333'))
      .toBe('9400111899223333333333');
  });

  it('strips the USPS IMpb 420+ZIP9 routing prefix', () => {
    expect(extractTrackingFromBarcode('4208022912349400111899223333333333'))
      .toBe('9400111899223333333333');
  });

  it('leaves a 420-prefixed scan alone when the remainder is not a USPS number', () => {
    expect(extractTrackingFromBarcode('42080229123456')).toBe('42080229123456');
  });

  it('unwraps an IMpb scan whose FNC1 separator lands after the routing prefix', () => {
    expect(extractTrackingFromBarcode('42080229\x1d9400111899223333333333'))
      .toBe('9400111899223333333333');
  });

  it('passes unrecognized input through normalized', () => {
    expect(extractTrackingFromBarcode('hello world')).toBe('HELLOWORLD');
  });
});

describe('detectCarriers', () => {
  it('detects UPS from a 1Z number', () => {
    expect(detectCarriers('1Z999AA10123456784')).toEqual(['UPS']);
  });

  it('detects UPS regardless of case and spacing', () => {
    expect(detectCarriers('1z 999 aa1 0123 456 784')).toEqual(['UPS']);
  });

  it('detects USPS from a 22-digit number starting with 9', () => {
    expect(detectCarriers('9400111899223333333333')).toEqual(['USPS']);
  });

  it('detects USPS from a 20-digit number starting with 9', () => {
    expect(detectCarriers('94001118992233333333')).toEqual(['USPS']);
  });

  it('detects USPS from an international EC…US format', () => {
    expect(detectCarriers('EC123456789US')).toEqual(['USPS']);
  });

  it('detects FedEx from a 12-digit number', () => {
    expect(detectCarriers('123456789012')).toEqual(['FedEx']);
  });

  it('detects FedEx from a 15-digit number', () => {
    expect(detectCarriers('123456789012345')).toEqual(['FedEx']);
  });

  it('reports both FedEx and USPS for 96-prefixed long digit runs', () => {
    expect(detectCarriers('9612345678901234567890')).toEqual(['FedEx', 'USPS']);
  });

  it('keeps the FedEx-first order the add-label form relies on, at the 20-digit boundary', () => {
    expect(detectCarriers('96123456789012345678')).toEqual(['FedEx', 'USPS']);
  });

  it('detects USPS from a lowercase international suffix', () => {
    expect(detectCarriers('ec123456789us')).toEqual(['USPS']);
  });

  it('rejects 9-prefixed digit runs outside the 20–22 length window', () => {
    expect(detectCarriers('9'.repeat(19))).toEqual([]);
    expect(detectCarriers('9'.repeat(23))).toEqual([]);
  });

  it('returns nothing for incomplete input', () => {
    expect(detectCarriers('1Z999')).toEqual([]);
    expect(detectCarriers('94001118')).toEqual([]);
  });

  it('returns nothing for empty or garbage input', () => {
    expect(detectCarriers('')).toEqual([]);
    expect(detectCarriers('hello world')).toEqual([]);
  });
});
