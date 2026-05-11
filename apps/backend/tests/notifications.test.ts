import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
// MARCUS, not ALEX: the seed only populates notifications for purchasers, and
// we want this test to actually exercise the mark-read path rather than
// silently no-op'ing on an empty inbox.
import { loginAs, MARCUS } from './helpers/auth';

describe('notifications mark-read', () => {
  beforeEach(async () => { await resetDb(); });

  it('mark-one moves a specific notification to read', async () => {
    const { token } = await loginAs(MARCUS);
    const list = await api<{ items: { id: string; unread: boolean }[] }>('GET', '/api/notifications', { token });
    const target = list.body.items.find(i => i.unread);
    expect(target, 'seed should leave at least one unread notification for the purchaser').toBeDefined();
    const r = await api('POST', `/api/notifications/${target!.id}/mark-read`, { token });
    expect(r.status).toBe(200);
    const after = await api<{ items: { id: string; unread: boolean }[] }>('GET', '/api/notifications', { token });
    expect(after.body.items.find(i => i.id === target!.id)!.unread).toBe(false);
  });
});
