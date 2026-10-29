import { describe, expect, it } from 'vitest';
import { fleetResumable, fleetTakesResume } from './fleet';
import { resumeWaiting } from '../pages/desktop/fleet/shared';

describe('Mark healthy', () => {
  it('is offered only for a DEAD connect_failed park', () => {
    expect(fleetResumable('DEAD', { reason: 'connect_failed', operator: true })).toBe(true);
    expect(fleetResumable('DEAD', { reason: 'login_failed' })).toBe(false);
    expect(fleetResumable('DEAD', null)).toBe(false);
    expect(fleetResumable('HEALTHY', { reason: 'connect_failed' })).toBe(false);
  });
  it('needs a worker build that takes the directive', () => {
    expect(fleetTakesResume('0.14.10 (f4d4fdf)')).toBe(false);
    expect(fleetTakesResume('0.15.0 (3576db7)')).toBe(true);
    expect(fleetTakesResume('0.16.2')).toBe(true);
    expect(fleetTakesResume('1.0.0 (x)')).toBe(true);
    expect(fleetTakesResume('unknown (unknown)')).toBe(false);
    expect(fleetTakesResume(null)).toBe(false);
  });
  it('waits until the worker reports something other than DEAD', () => {
    const queued = { id: 'r', requested_at: '2026-10-29T12:00:00Z', requested_by: 'a', delivered_at: null };
    expect(resumeWaiting(queued, 'DEAD')).toBe(true);
    expect(resumeWaiting({ ...queued, delivered_at: '2026-10-29T12:00:20Z' }, 'DEAD')).toBe(true);
    expect(resumeWaiting({ ...queued, delivered_at: '2026-10-29T12:00:20Z' }, 'HEALTHY')).toBe(false);
    expect(resumeWaiting(null, 'DEAD')).toBe(false);
  });
});
