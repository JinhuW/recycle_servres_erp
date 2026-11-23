import { describe, it, expect } from 'vitest';
import { parseEbayListingRef } from '@recycle-erp/shared';

const canon = (id: string) => ({ itemId: id, url: `https://www.ebay.com/itm/${id}` });

describe('parseEbayListingRef', () => {
  it('reads the item from every usual form of an eBay listing link', () => {
    for (const raw of [
      'https://www.ebay.com/itm/256712340987',
      'https://www.ebay.com/itm/Samsung-32GB-2Rx4-DDR4-3200-RDIMM/256712340987?hash=item3bc5&_trksid=p2047675',
      'http://ebay.com/itm/256712340987',
      'ebay.com/itm/256712340987',
      'www.ebay.com/itm/256712340987/',
      'https://m.ebay.com/itm/256712340987?_mwBanner=1',
      'm.ebay.com/itm/Some-title/256712340987',
      '  https://www.ebay.com/itm/256712340987#desc  ',
      '256712340987',
    ]) expect(parseEbayListingRef(raw), raw).toEqual(canon('256712340987'));
  });

  it('refuses another site, and an eBay page that is not a listing', () => {
    expect(parseEbayListingRef('https://www.amazon.com/itm/256712340987')).toEqual({ error: 'not_ebay' });
    expect(parseEbayListingRef('https://ebay.com.evil.example/itm/256712340987')).toEqual({ error: 'not_ebay' });
    expect(parseEbayListingRef('https://www.ebay.co.uk/itm/256712340987')).toEqual({ error: 'not_ebay' });
    expect(parseEbayListingRef('https://www.ebay.com/sch/i.html?_nkw=ddr4')).toEqual({ error: 'no_item' });
    expect(parseEbayListingRef('https://www.ebay.com/itm/')).toEqual({ error: 'no_item' });
    expect(parseEbayListingRef('https://www.ebay.com/itm/some-title')).toEqual({ error: 'no_item' });
    expect(parseEbayListingRef('12345')).toEqual({ error: 'not_ebay' });
    expect(parseEbayListingRef('   ')).toEqual({ error: 'empty' });
  });
});
