import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
// MARCUS, not ALEX: the seed only populates notifications for purchasers, and
// we want this test to actually exercise the mark-read path rather than
// silently no-op'ing on an empty inbox.
import { loginAs, MARCUS } from './helpers/auth';

describe('notifications mark-read', () => {
  beforeEach(async () => { await resetDb(); });

  it('mark-read moves every unread notification to read', async () => {
    const { token } = await loginAs(MARCUS);
    const list = await api<{ items: { id: string; unread: boolean }[]; unreadCount: number }>('GET', '/api/notifications', { token });
    expect(list.body.unreadCount, 'seed should leave at least one unread notification for the purchaser').toBeGreaterThan(0);
    const r = await api('POST', '/api/notifications/mark-read', { token });
    expect(r.status).toBe(200);
    const after = await api<{ items: { id: string; unread: boolean }[]; unreadCount: number }>('GET', '/api/notifications', { token });
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items.every(i => !i.unread)).toBe(true);
  });
});
