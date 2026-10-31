// Model of MobileApp.tsx onSaveLine (:476-674): writeQueue/enqueueWrite (:168-174),
// ensureDraftId memo (:467-483), and the new-line branch's
// `mintedHere = !editingId && !draftId` computed from the *save-time* capture
// snapshot (:627). Uses the real buildOrderSubmit to show what Submit sends after.
import { describe, it, expect } from 'vitest';
import { buildOrderSubmit } from '../../../../apps/frontend/src/lib/orderSubmit';

describe('A7-01 stale mintedHere', () => {
  it('B fails after A landed in the minted draft -> draft D (with A) deleted', async () => {
    const server = { orders: new Map<string, string[]>(), deleted: [] as string[] };
    let releasePost!: () => void;
    const postGate = new Promise<void>(r => (releasePost = r));
    let draftIdPromise: Promise<string> | null = null;
    let capture: { draftId?: string; lines: any[] } = { lines: [] };
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T,>(run: () => Promise<T>) => { const n = queue.then(run, run); queue = n.catch(() => undefined); return n; };
    const ensureDraftId = () => (draftIdPromise ??= postGate.then(() => { server.orders.set('D', []); capture = { ...capture, draftId: 'D' }; return 'D'; }));

    const save = (line: any, patchFails: boolean) => {
      const { draftId } = capture;                 // snapshot at Save (:477)
      capture = { ...capture, lines: [...capture.lines, line] };
      return enqueue(async () => {
        const mintedHere = !draftId;               // :627
        const target = draftId ?? await ensureDraftId();
        try {
          if (patchFails) throw new Error('network');
          server.orders.get(target)!.push(line.cid);
          capture = { ...capture, lines: capture.lines.map(l => l.cid === line.cid ? { ...l, _confirmed: true, id: 'row-' + line.cid } : l) };
        } catch {
          if (mintedHere) { server.deleted.push(target); server.orders.delete(target); draftIdPromise = null; capture = { ...capture, draftId: undefined }; }
        }
      });
    };

    const a = save({ cid: 'A', category: 'RAM', qty: 1, scanImageId: 'orders/D/scanA.jpg' }, false);
    const b = save({ cid: 'B', category: 'RAM', qty: 1 }, true);  // saved while POST pending
    releasePost();
    await Promise.all([a, b]);

    expect(server.deleted).toEqual(['D']);         // A's row (and its R2 scan/photos) went with it
    const req = buildOrderSubmit({ draftId: capture.draftId, lines: capture.lines, originalLineIds: [] });
    expect(req.kind).toBe('create');               // Submit re-POSTs A + B
    expect((req as any).body.lines[0].scanImageId).toBe('orders/D/scanA.jpg'); // points at deleted R2 key
  });
});
