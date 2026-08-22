import { describe, it, expect } from 'vitest';
import { carrierTrackingUrl } from './packages';
import type { Carrier } from './carrierDetect';

describe('carrierTrackingUrl', () => {
  it('links each carrier to its public tracking page with the number encoded', () => {
    expect(carrierTrackingUrl('UPS', '1Z999AA10123456784'))
      .toBe('https://www.ups.com/track?tracknum=1Z999AA10123456784');
    expect(carrierTrackingUrl('FedEx', '123456789012'))
      .toBe('https://www.fedex.com/fedextrack/?trknbr=123456789012');
    expect(carrierTrackingUrl('USPS', '9400 1118'))
      .toBe('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400%201118');
  });

  it('returns null for a carrier outside the union — no href-less links', () => {
    expect(carrierTrackingUrl('DHL' as Carrier, 'X')).toBeNull();
  });
});
