import { describe, it, expect } from 'vitest';
import { createPrefSaver, type PrefBag } from './prefSaver';

type Deferred = { resolve: (bag: PrefBag) => void; reject: (e: unknown) => void };

function harness(identity: () => string | null) {
  const pending: Deferred[] = [];
  const applied: PrefBag[] = [];
  const overlays: PrefBag[] = [];
  const rolledBack: string[][] = [];
  const saver = createPrefSaver({
    patch: () => new Promise<PrefBag>((resolve, reject) => { pending.push({ resolve, reject }); }),
    identity,
    onServer: (bag, queued) => { applied.push(bag); overlays.push(queued); },
    onRollback: (keys) => rolledBack.push(keys),
  });
  return { saver, pending, applied, overlays, rolledBack };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createPrefSaver', () => {
  it('sends one PATCH at a time, so the newest reply is the last applied', async () => {
    const h = harness(() => 'u1');
    const a = h.saver.save({ 'sidebar.folded': true }, { values: {}, absent: new Set() });
    const b = h.saver.save({ 'sidebar.folded': false }, { values: {}, absent: new Set() });
    await tick();
    // Only the first PATCH is in flight; the second waits for it.
    expect(h.pending).toHaveLength(1);
    h.pending[0].resolve({ 'sidebar.folded': true });
    await a;
    await tick();
    expect(h.pending).toHaveLength(2);
    h.pending[1].resolve({ 'sidebar.folded': false });
    await b;
    expect(h.applied).toEqual([{ 'sidebar.folded': true }, { 'sidebar.folded': false }]);
  });

  // A batch queued behind an in-flight PATCH is in neither that reply nor the
  // provider's pending edits; the reply has to hand it over to be laid on top.
  it('hands each reply the batches still queued behind it', async () => {
    const h = harness(() => 'u1');
    const a = h.saver.save({ 'sidebar.folded': true }, { values: {}, absent: new Set() });
    const b = h.saver.save({ 'sidebar.folded': false }, { values: {}, absent: new Set() });
    await tick();
    h.pending[0].resolve({ 'sidebar.folded': true });
    await a;
    expect(h.overlays[0]).toEqual({ 'sidebar.folded': false });
    await tick();
    h.pending[1].resolve({ 'sidebar.folded': false });
    await b;
    expect(h.overlays[1]).toEqual({});
  });

  it('keeps the queue moving after a failed save, and rolls that save back', async () => {
    const h = harness(() => 'u1');
    const a = h.saver.save({ a: 1 }, { values: { a: 0 }, absent: new Set() });
    const b = h.saver.save({ b: 2 }, { values: {}, absent: new Set(['b']) });
    await tick();
    h.pending[0].reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await tick();
    expect(h.rolledBack).toEqual([['a']]);
    expect(h.pending).toHaveLength(2);
    h.pending[1].resolve({ b: 2 });
    await b;
    expect(h.applied).toEqual([{ b: 2 }]);
  });

  it('drops a reply that comes back after the user changed', async () => {
    let who: string | null = 'u1';
    const h = harness(() => who);
    const a = h.saver.save({ 'sidebar.folded': true }, { values: {}, absent: new Set() });
    await tick();
    who = 'u2';
    h.pending[0].resolve({ 'sidebar.folded': true, 'tweaks.density': 'compact' });
    await a;
    expect(h.applied).toEqual([]);
    expect(h.rolledBack).toEqual([]);
  });

  it('neither rolls back nor reports a failure on behalf of a user who is gone', async () => {
    let who: string | null = 'u1';
    const h = harness(() => who);
    const a = h.saver.save({ a: 1 }, { values: { a: 0 }, absent: new Set() });
    await tick();
    who = null;
    h.pending[0].reject(new Error('boom'));
    await expect(a).resolves.toBeUndefined();
    expect(h.rolledBack).toEqual([]);
    expect(h.applied).toEqual([]);
  });
});
