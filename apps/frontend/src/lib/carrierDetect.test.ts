import { describe, it, expect } from 'vitest';
import { detectCarriers, normalizeTracking } from './carrierDetect';

describe('normalizeTracking', () => {
  it('strips spaces and hyphens and uppercases', () => {
    expect(normalizeTracking(' 1z 999-aa1 0123 456 784 ')).toBe('1Z999AA10123456784');
  });

  it('strips zero-width and bidi characters from chat-app pastes', () => {
    expect(normalizeTracking('1z\u200B999\u200Faa1\u2060 0123\u200E456 784\uFEFF'))
      .toBe('1Z999AA10123456784');
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
