import { describe, it, expect } from 'vitest';
import { buildPublishPayload, ebayCondition, listingImages, type PublishLot, type PublishListing } from '../src/ebay/publish';

// The pure half of publishing: what the ERP's free-text fields become in
// eBay's inventory item and offer.

const lot: PublishLot = {
  category: 'SSD', brand: 'Intel', capacity: '1.92TB', generation: null, type: null, classification: null,
  rank: null, speed: null, interface: 'SATA', form_factor: '2.5"', description: null, condition: 'Pulled — Tested',
  health: 98, rpm: null, part_number: 'SSDSC2KB019T8',
};
const listing: PublishListing = {
  id: 'EB-7', ebay_sku: 'RS-EB-7', status: 'Queued', remaining: 4, list_price: 120, title: null, spec: null,
  condition: null, ebay_offer_id: null, ebay_item_id: null, inventory_id: 'x',
};
const defaults = { merchantLocationKey: 'l', fulfillmentPolicyId: 'f', paymentPolicyId: 'p', returnPolicyId: 'r' };

describe('eBay publish payload', () => {
  it('maps the ERP condition text onto eBay’s enum', () => {
    expect(ebayCondition('New')).toBe('NEW');
    expect(ebayCondition('Brand new, sealed')).toBe('NEW');
    expect(ebayCondition('New pull')).toBe('NEW_OTHER');
    expect(ebayCondition('Open box')).toBe('NEW_OTHER');
    expect(ebayCondition('Refurbished')).toBe('SELLER_REFURBISHED');
    expect(ebayCondition('For parts / not working')).toBe('FOR_PARTS_OR_NOT_WORKING');
    expect(ebayCondition('Used')).toBe('USED_EXCELLENT');
    expect(ebayCondition(null)).toBe('USED_EXCELLENT');
  });

  it('sends https uploads, and the label scan only when there is no upload', () => {
    const scan = { url: 'https://cdn/scan.jpg', mime: null, source: 'scan' as const };
    expect(listingImages([
      scan,
      { url: 'https://cdn/a.jpg', mime: 'image/jpeg', source: 'upload' },
      { url: 'https://cdn/b.pdf', mime: 'application/pdf', source: 'upload' },
      { url: 'data:image/jpeg;name=x', mime: 'image/jpeg', source: 'upload' },
    ])).toEqual(['https://cdn/a.jpg']);
    expect(listingImages([scan])).toEqual(['https://cdn/scan.jpg']);
  });

  it('builds the item and offer from the lot, and refuses a category eBay has no id for here', () => {
    const p = buildPublishPayload(listing, lot, [], defaults);
    if (typeof p === 'string') throw new Error(p);
    expect(p.item.product.title).toBe('Intel 1.92TB SATA · 2.5" · 98%');
    expect(p.item.condition).toBe('USED_EXCELLENT');
    expect(p.item.conditionDescription).toBe('Pulled — Tested');
    expect(p.item.product.aspects).toMatchObject({ Brand: ['Intel'], MPN: ['SSDSC2KB019T8'], Interface: ['SATA'] });
    expect(p.offer).toMatchObject({ categoryId: '175669', availableQuantity: 4, pricingSummary: { price: { value: '120.00' } } });

    const fresh = buildPublishPayload({ ...listing, condition: 'New' }, lot, [], defaults);
    if (typeof fresh === 'string') throw new Error(fresh);
    expect(fresh.item.conditionDescription).toBeUndefined();

    expect(buildPublishPayload(listing, { ...lot, category: 'Other' }, [], defaults)).toMatch(/no eBay category for Other/);
    expect(buildPublishPayload({ ...listing, title: 'x'.repeat(120) }, lot, [], defaults)).toMatchObject({
      item: { product: { title: 'x'.repeat(80) } },
    });
  });
});
