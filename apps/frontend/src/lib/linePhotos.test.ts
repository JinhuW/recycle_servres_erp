import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LINE_PHOTO_CAP,
  limitPhotoPick,
  planPhotoCarry,
  photoSourceFile,
  type CarryLine,
  type LinePhoto,
} from './linePhotos';

const img = (name: string) => new File(['x'], name, { type: 'image/jpeg' });
const photo = (over: Partial<LinePhoto> = {}): LinePhoto => ({
  id: 'p1', url: 'https://static.example/p1.jpg', source: 'upload', ...over,
});
const line = (over: Partial<CarryLine> = {}): CarryLine => ({
  cid: 'c1', persisted: false, pending: [], ...over,
});

describe('limitPhotoPick', () => {
  it('keeps a selection that fits', () => {
    const r = limitPhotoPick([img('a.jpg'), img('b.jpg')], 0);
    expect(r.accepted).toHaveLength(2);
    expect(r.overCap).toBe(0);
  });

  it('trims to the cap and reports the surplus rather than letting it 409', () => {
    const files = Array.from({ length: 8 }, (_, i) => img(`${i}.jpg`));
    const r = limitPhotoPick(files, 0);
    expect(r.accepted).toHaveLength(LINE_PHOTO_CAP);
    expect(r.overCap).toBe(8 - LINE_PHOTO_CAP);
  });

  it('counts what the line already holds', () => {
    const r = limitPhotoPick([img('a.jpg'), img('b.jpg')], LINE_PHOTO_CAP - 1);
    expect(r.accepted.map(f => f.name)).toEqual(['a.jpg']);
    expect(r.overCap).toBe(1);
  });

  it('accepts nothing once the line is full', () => {
    const r = limitPhotoPick([img('a.jpg')], LINE_PHOTO_CAP);
    expect(r.accepted).toEqual([]);
    expect(r.overCap).toBe(1);
  });

  it('drops non-images without charging them against the cap', () => {
    const pdf = new File(['x'], 'receipt.pdf', { type: 'application/pdf' });
    const r = limitPhotoPick([pdf, img('a.jpg')], 0);
    expect(r.accepted.map(f => f.name)).toEqual(['a.jpg']);
    expect(r.overCap).toBe(0);
  });

  it('tolerates a null FileList', () => {
    expect(limitPhotoPick(null, 0)).toEqual({ accepted: [], overCap: 0 });
  });
});

describe('planPhotoCarry', () => {
  it('carries buffered photos so a merge cannot silently drop them', () => {
    const f = img('a.jpg');
    const [plan] = planPhotoCarry([line({ pending: [{ file: f }] })], new Map(), true);
    expect(plan.carry).toEqual([{ kind: 'file', file: f }]);
  });

  it('re-uploads photos already attached to the doomed draft, from the retained File', () => {
    const f = img('a.jpg');
    const [plan] = planPhotoCarry(
      [line({ persisted: true, photos: [photo({ id: 'ph-1' })] })],
      new Map([['ph-1', f]]),
      true,
    );
    expect(plan.carry).toEqual([{ kind: 'file', file: f }]);
  });

  it('falls back to the photo URL when its File is gone', () => {
    const [plan] = planPhotoCarry(
      [line({ persisted: true, photos: [photo({ id: 'ph-1', filename: 'dimm.jpg' })] })],
      new Map(),
      true,
    );
    expect(plan.carry).toEqual([
      { kind: 'url', url: 'https://static.example/p1.jpg', filename: 'dimm.jpg' },
    ]);
  });

  it('never hands the target a scan key the draft is about to delete', () => {
    const [plan] = planPhotoCarry(
      [line({ persisted: true, scanImageId: 'orders/PO-1/scan.jpg', scanImageUrl: 'https://static.example/s.jpg' })],
      new Map(),
      true,
    );
    expect(plan.scanImageId).toBeNull();
    // Dropping the reference must not drop the picture.
    expect(plan.carry).toEqual([
      { kind: 'url', url: 'https://static.example/s.jpg', filename: 'scan.jpg' },
    ]);
  });

  it('keeps the scan key on a line that was never written to the draft', () => {
    const [plan] = planPhotoCarry(
      [line({ persisted: false, scanImageId: 'k', scanImageUrl: 'https://static.example/s.jpg' })],
      new Map(),
      true,
    );
    expect(plan.scanImageId).toBe('k');
    expect(plan.carry).toEqual([]);
  });

  it('keeps the scan key when no draft is being deleted', () => {
    const [plan] = planPhotoCarry(
      [line({ persisted: true, scanImageId: 'k', scanImageUrl: 'https://static.example/s.jpg' })],
      new Map(),
      false,
    );
    expect(plan.scanImageId).toBe('k');
    expect(plan.carry).toEqual([]);
  });

  it('ignores a placeholder scan URL', () => {
    const [plan] = planPhotoCarry(
      [line({ persisted: true, scanImageId: 'k', scanImageUrl: 'data:image/placeholder' })],
      new Map(),
      true,
    );
    expect(plan.scanImageId).toBeNull();
    expect(plan.carry).toEqual([]);
  });

  it('orders the carry as the strip shows it: scan, uploads, then buffered', () => {
    const kept = img('kept.jpg');
    const buffered = img('buffered.jpg');
    const [plan] = planPhotoCarry(
      [line({
        persisted: true,
        scanImageUrl: 'https://static.example/s.jpg',
        photos: [photo({ id: 'ph-1' })],
        pending: [{ file: buffered }],
      })],
      new Map([['ph-1', kept]]),
      true,
    );
    expect(plan.carry).toEqual([
      { kind: 'url', url: 'https://static.example/s.jpg', filename: 'scan.jpg' },
      { kind: 'file', file: kept },
      { kind: 'file', file: buffered },
    ]);
  });

  it('reports what the target has no room for instead of queueing doomed uploads', () => {
    const pending = Array.from({ length: LINE_PHOTO_CAP + 2 }, (_, i) => ({ file: img(`${i}.jpg`) }));
    const [plan] = planPhotoCarry([line({ pending })], new Map(), true);
    expect(plan.carry).toHaveLength(LINE_PHOTO_CAP);
    expect(plan.overCap).toBe(2);
  });

  it('stays index-aligned with the lines it was given', () => {
    const plans = planPhotoCarry(
      [line({ cid: 'a' }), line({ cid: 'b', pending: [{ file: img('b.jpg') }] }), line({ cid: 'c' })],
      new Map(),
      true,
    );
    expect(plans.map(p => p.cid)).toEqual(['a', 'b', 'c']);
    expect(plans.map(p => p.carry.length)).toEqual([0, 1, 0]);
  });

  it('leaves already-uploaded photos alone when the draft survives', () => {
    // Nothing was ever uploaded in this case (no draft, no line ids), but a
    // stale `photos` entry must not produce a pointless re-upload either.
    const [plan] = planPhotoCarry(
      [line({ persisted: true, photos: [photo({ id: 'ph-1' })] })],
      new Map([['ph-1', img('a.jpg')]]),
      false,
    );
    expect(plan.carry).toEqual([]);
  });
});

describe('photoSourceFile', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the retained File without touching the network', async () => {
    const f = img('a.jpg');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(photoSourceFile({ kind: 'file', file: f })).resolves.toBe(f);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a URL source back as an uploadable File', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(['bytes'], { type: 'image/png' }),
    }));
    const f = await photoSourceFile({ kind: 'url', url: 'https://static.example/p.png', filename: 'p.png' });
    expect(f?.name).toBe('p.png');
    expect(f?.type).toBe('image/png');
  });

  it('reports a fetch that cannot be read rather than pretending it worked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('CORS')));
    await expect(
      photoSourceFile({ kind: 'url', url: 'https://static.example/p.png', filename: 'p.png' }),
    ).resolves.toBeNull();
  });

  it('reports a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, blob: async () => new Blob([]) }));
    await expect(
      photoSourceFile({ kind: 'url', url: 'https://static.example/p.png', filename: 'p.png' }),
    ).resolves.toBeNull();
  });

  it('refuses a body that is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, blob: async () => new Blob(['<html>'], { type: 'text/html' }),
    }));
    await expect(
      photoSourceFile({ kind: 'url', url: 'https://static.example/p.png', filename: 'p.png' }),
    ).resolves.toBeNull();
  });
});
