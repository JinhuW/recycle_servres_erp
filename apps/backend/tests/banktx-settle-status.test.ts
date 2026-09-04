import { describe, it, expect } from 'vitest';
import { paypalSettleStatus } from '../src/banktx/paypal';
import { mercurySettleStatus } from '../src/banktx/mercury';

// Pure mapping, no DB: the whole point of these two functions is that the
// provider vocabularies can be checked against the docs without a wire.
describe('settlement status mapping', () => {
  it('maps every PayPal transaction_status', () => {
    expect(paypalSettleStatus('S')).toBe('settled');
    expect(paypalSettleStatus('P')).toBe('pending');
    expect(paypalSettleStatus('D')).toBe('failed');
    expect(paypalSettleStatus('V')).toBe('reversed');
  });

  it('maps all six Mercury statuses', () => {
    expect(mercurySettleStatus('sent')).toBe('settled');
    expect(mercurySettleStatus('pending')).toBe('pending');
    expect(mercurySettleStatus('cancelled')).toBe('failed');
    expect(mercurySettleStatus('failed')).toBe('failed');
    expect(mercurySettleStatus('blocked')).toBe('failed');
    expect(mercurySettleStatus('reversed')).toBe('reversed');
  });

  // A state nobody has seen should be shown and chased, not filed away as a
  // non-event — 'failed' would take it out of the queue and every tile.
  it('treats an unrecognised or missing status as pending', () => {
    expect(paypalSettleStatus(undefined)).toBe('pending');
    expect(paypalSettleStatus('Z')).toBe('pending');
    expect(mercurySettleStatus(undefined)).toBe('pending');
    expect(mercurySettleStatus('quarantined')).toBe('pending');
  });
});
