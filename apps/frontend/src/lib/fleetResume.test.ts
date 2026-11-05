import { describe, expect, it } from 'vitest';
import { fleetRestartable, fleetResumable, fleetTakesResume } from './fleet';
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
  it('waits for a resume that went out, until the worker reports or the try has plainly failed', () => {
    const queued = { id: 'r', requested_at: '2026-10-29T12:00:00Z', requested_by: 'a', delivered_at: null };
    const delivered = { ...queued, delivered_at: '2026-10-29T12:00:20Z' };
    const at = (time: string) => Date.parse(`2026-10-29T${time}Z`);
    expect(resumeWaiting(queued, 'DEAD', at('18:00:00'))).toBe(true);
    expect(resumeWaiting(delivered, 'DEAD', at('12:01:00'))).toBe(true);
    expect(resumeWaiting(delivered, 'HEALTHY', at('12:01:00'))).toBe(false);
    expect(resumeWaiting(delivered, 'DEAD', at('12:02:20'))).toBe(false);
    expect(resumeWaiting(null, 'DEAD', at('12:01:00'))).toBe(false);
  });
});

describe('fleetRestartable', () => {
  it('is only a worker parked on a moved exit, which an automatic resume must not touch', () => {
    expect(fleetRestartable('DEAD', { reason: 'exit_moved' })).toBe(true);
    expect(fleetResumable('DEAD', { reason: 'exit_moved' })).toBe(false);
    expect(fleetRestartable('DEAD', { reason: 'connect_failed' })).toBe(false);
    expect(fleetRestartable('HEALTHY', { reason: 'exit_moved' })).toBe(false);
  });
});
