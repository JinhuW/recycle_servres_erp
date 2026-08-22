import { describe, it, expect } from 'vitest';
import { progressedStatus } from './packages';

const T0 = Date.parse('2026-08-22T12:00:00Z');
const min = (n: number) => n * 60_000;

describe('progressedStatus', () => {
  it('stays purchased right after the label is added', () => {
    expect(progressedStatus('2026-08-22T12:00:00Z', T0 + 30_000)).toBe('purchased');
  });

  it('moves to in transit after two minutes', () => {
    expect(progressedStatus('2026-08-22T12:00:00Z', T0 + min(2))).toBe('in_transit');
  });

  it('is delivered after five minutes', () => {
    expect(progressedStatus('2026-08-22T12:00:00Z', T0 + min(5))).toBe('delivered');
  });

  it('stays delivered forever after', () => {
    expect(progressedStatus('2026-08-22T12:00:00Z', T0 + min(600))).toBe('delivered');
  });
});
