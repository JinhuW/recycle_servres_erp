import { describe, it, expect } from 'vitest';
import { carrierToken, normalizeShippoStatus, trackToInfo } from '../src/shipping/shippo';
import { parseEta } from '../src/shipping/types';

describe('shippo — status normalization', () => {
  it('maps every documented Shippo status', () => {
    expect(normalizeShippoStatus('DELIVERED')).toBe('delivered');
    expect(normalizeShippoStatus('TRANSIT')).toBe('in_transit');
    expect(normalizeShippoStatus('RETURNED')).toBe('exception');
    expect(normalizeShippoStatus('FAILURE')).toBe('exception');
    // No movement yet — never regress the status machine.
    expect(normalizeShippoStatus('PRE_TRANSIT')).toBe('purchased');
    expect(normalizeShippoStatus('UNKNOWN')).toBe('purchased');
  });

  it('never claims voided — Shippo does not own our labels', () => {
    for (const s of ['DELIVERED', 'TRANSIT', 'RETURNED', 'FAILURE', 'PRE_TRANSIT', 'UNKNOWN', 'GIBBERISH']) {
      expect(normalizeShippoStatus(s)).not.toBe('voided');
    }
  });

  it('treats an unrecognized status as no movement, not an exception', () => {
    expect(normalizeShippoStatus('SOMETHING_NEW')).toBe('purchased');
  });
});

describe('shippo — carrier tokens', () => {
  it('maps the three package carriers', () => {
    expect(carrierToken('UPS')).toBe('ups');
    expect(carrierToken('FedEx')).toBe('fedex');
    expect(carrierToken('USPS')).toBe('usps');
  });

  it('passes anything else through lowercased', () => {
    // shipments.carrier is not held to the package vocabulary; an exhaustive
    // map would throw on these forever.
    expect(carrierToken('DHL')).toBe('dhl_express');
    expect(carrierToken('OnTrac')).toBe('ontrac');
    // The test carrier has to stay reachable for wiring checks.
    expect(carrierToken('shippo')).toBe('shippo');
    expect(carrierToken(null)).toBe('');
  });
});

describe('shippo — track payloads', () => {
  // The exact shape GET /tracks/shippo/SHIPPO_DELIVERED returns.
  const live = {
    carrier: 'shippo',
    tracking_number: 'SHIPPO_DELIVERED',
    eta: '2026-08-27T20:42:29.622Z',
    tracking_status: {
      status: 'DELIVERED',
      substatus: null,
      status_details: 'Your shipment has been delivered.',
      status_date: '2026-08-25T22:01:59.222Z',
    },
  };

  it('reads status, human detail and ETA from tracking_status', () => {
    const info = trackToInfo(live);
    expect(info.normalized).toBe('delivered');
    expect(info.raw).toBe('Your shipment has been delivered.');
    // A full ISO instant collapses to UTC midnight — the frontend renders it
    // as a timezone-free calendar date.
    expect(info.eta?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('falls back to the bare status when there is no human detail', () => {
    expect(trackToInfo({ tracking_status: { status: 'TRANSIT', status_details: '  ' } }).raw).toBe('TRANSIT');
    expect(trackToInfo({ tracking_status: { status: 'TRANSIT' } }).raw).toBe('TRANSIT');
  });

  it('treats a payload with no tracking_status as unknown, not a crash', () => {
    const info = trackToInfo({ tracking_number: 'X' });
    expect(info.normalized).toBe('purchased');
    expect(info.raw).toBe('UNKNOWN');
    expect(info.eta).toBeNull();
  });
});

describe('parseEta', () => {
  it('collapses every wire shape to UTC midnight on the same calendar day', () => {
    expect(parseEta('2026-08-27T20:42:29.622Z')?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(parseEta('2026-08-27')?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(parseEta('2025-08-26 22:37:27')?.toISOString()).toBe('2025-08-26T00:00:00.000Z');
  });

  it('answers null for nothing and for junk', () => {
    expect(parseEta(null)).toBeNull();
    expect(parseEta(undefined)).toBeNull();
    expect(parseEta('')).toBeNull();
    expect(parseEta('not a date')).toBeNull();
  });
});
