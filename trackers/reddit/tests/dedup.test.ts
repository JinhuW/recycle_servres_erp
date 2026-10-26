// Which pairs of posts are one listing. The cases are real pairs from the
// production posts table (October 2026), with the authors changed.

import {describe, expect, it} from 'vitest';
import {isSameListing, listingWords, type ListingText} from '../src/dedup.ts';

const AT = new Date('2026-10-20T12:00:00Z');

function listing(overrides: Partial<ListingText>): ListingText {
  return {subreddit: 'homelabsales', author: 'seller', title: '', selftext: '', postedAt: AT, ...overrides};
}

const LONG_BODY = 'Selling a large lot of server memory pulled from decommissioned Dell R740s, '
  + 'all tested in a working system for 24 hours. Shipping from Pennsylvania, local pickup okay.';

describe('listingWords', () => {
  it('drops location tags and the wanted half of a swap title', () => {
    expect([...listingWords('[USA-NY] [H] 16 x 64GB DDR4 ECC RAM [W] Paypal G&S')])
      .toEqual(['16', 'x', '64gb', 'ddr4', 'ecc', 'ram']);
  });

  it('keeps text written after [H] in an unusual position', () => {
    expect(listingWords('[SG] Crucial P3 Plus 4Tb m.2 NVME SSD [H] £300').has('crucial')).toBe(true);
  });
});

describe('isSameListing', () => {
  it('pairs a cross-post between the sale and the swap subreddit', () => {
    expect(isSameListing(
      listing({title: '[FS] [USA-NY] 16 x 64GB DDR4 ECC RAM - Paypal G&S'}),
      listing({subreddit: 'hardwareswap', title: '[USA-NY] [H] 16 x 64GB DDR4 ECC RAM [W] Paypal G&S'}),
    )).toBe(true);
  });

  it('pairs a repost the next day', () => {
    expect(isSameListing(
      listing({title: '[FS][US-NC] 1TB matched SK hynix DDR3 ECC RDIMM RAM, 32 × 32GB'}),
      listing({title: '[FS][US-NC] 1TB matched SK hynix DDR3 ECC RDIMM, 32 × 32GB',
               postedAt: new Date(AT.getTime() + 26 * 3600_000)}),
    )).toBe(true);
  });

  it('pairs a cross-post retitled from the body when the body is the same', () => {
    expect(isSameListing(
      listing({title: '[FS][USA-W] MICRON RDIMMS DDR5 128 gb 7200 MHz 2r4', selftext: LONG_BODY}),
      listing({subreddit: 'hardwareswap', title: '[USA-WA] [H] PayPal[W] MICRON RDIMMS', selftext: LONG_BODY}),
    )).toBe(true);
  });

  it('keeps a seller\'s separate lots apart even when they share a template body', () => {
    expect(isSameListing(
      listing({title: '[FS][EU] 16x SKhynix 32GB DDR4-3200 ECC RDIMM (2Rx4) PC4-3200', selftext: LONG_BODY}),
      listing({title: '[FS][EU] 15x Micron 32GB DDR4-3200 ECC RDIMM (2Rx4) PC4-3200', selftext: LONG_BODY}),
    )).toBe(false);
  });

  it('keeps two models of one product line apart', () => {
    expect(isSameListing(
      listing({title: '[FS] [US-TX] Dell OptiPlex 7070 Micro (i7) PayPal (shipped)'}),
      listing({title: '[FS] [US-TX] Dell OptiPlex 5000 Micro (i5) PayPal (shipped)'}),
    )).toBe(false);
  });

  it('needs the same author', () => {
    expect(isSameListing(
      listing({title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM'}),
      listing({author: 'someone-else', title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM'}),
    )).toBe(false);
  });

  it('never pairs deleted authors', () => {
    expect(isSameListing(
      listing({author: '[deleted]', title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM'}),
      listing({author: '[deleted]', title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM'}),
    )).toBe(false);
  });

  it('treats the same listing a week later as new', () => {
    expect(isSameListing(
      listing({title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM'}),
      listing({title: '[FS] 88x 16gb DDR5 UDIMM ECC RAM', postedAt: new Date(AT.getTime() + 4 * 86_400_000)}),
    )).toBe(false);
  });
});
