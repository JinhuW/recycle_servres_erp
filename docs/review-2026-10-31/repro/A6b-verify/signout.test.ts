// Repro for A6b-01. Static + behavioural: no DOM test harness in the frontend.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createSaveQueue } from '../../../../apps/frontend/src/lib/useLineSaveQueue';
import { registerHolder, hasUnsavedChanges } from '../../../../apps/frontend/src/lib/leaveRegistry';

const src = (p: string) => readFileSync(resolve(__dirname, '../../../../apps/frontend/src', p), 'utf8');

describe('A6b-01 sign-out vs unsaved guard', () => {
  it('sidebar sign-out calls logout directly, and logout never consults the guard', () => {
    expect(src('components/Sidebar.tsx')).toMatch(/onClick=\{logout\}/);
    const auth = src('lib/auth.tsx');
    const body = auth.slice(auth.indexOf('const logout = async'), auth.indexOf('auth:unauthorized', auth.indexOf('const logout = async')));
    expect(body).not.toMatch(/confirmDiscard|hasUnsavedChanges|unsavedGuard/);
    expect(auth).not.toMatch(/confirmDiscard|hasUnsavedChanges/);
    // A dirty editor is registered, yet nothing on the logout path reads it.
    const off = registerHolder(() => false);
    expect(hasUnsavedChanges()).toBe(true);
    off();
  });

  it('a tick still in the 400 ms debounce at sign-out is sent after the session is gone and the failure is swallowed', async () => {
    vi.useFakeTimers();
    let sessionAlive = true;
    const sent: string[] = [];
    const onWriteError = vi.fn();
    const q = createSaveQueue<null>(() => ({
      send: async (c) => { sent.push(c.lineId); if (!sessionAlive) throw Object.assign(new Error('401'), { status: 401 }); return null; },
      onWriteError,
      refresh: async () => false,
    }));
    q.save({ lineId: 'L1' } as any);           // user ticks a line
    vi.advanceTimersByTime(100);                // signs out within the debounce
    sessionAlive = false;                       // logout() POST revoked cookies, clearLocalAuthState -> shell remount
    q.sendPending();                            // useLineSaveQueue unmount cleanup
    await vi.runAllTimersAsync();
    expect(sent).toEqual(['L1']);               // the write went out with no session
    expect(onWriteError).not.toHaveBeenCalled(); // and nobody is told it failed
    vi.useRealTimers();
  });
});
