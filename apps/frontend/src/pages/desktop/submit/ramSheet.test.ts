import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../lib/api';
import type { ScanResponse } from '../../../lib/types';
import { blankLine } from './line';
import { buildRamLinePatches, isPristineLine, runPool, stepStates, withRateLimitRetry } from './ramSheet';

const scan = (partNumber: string | undefined, imageId: string): ScanResponse => ({
  imageId,
  deliveryUrl: `https://img/${imageId}`,
  extracted: {
    brand: 'Samsung', capacity: '32GB', generation: 'DDR4',
    ...(partNumber ? { partNumber } : {}),
  },
  confidence: 0.9,
  provider: 'openrouter',
});

describe('buildRamLinePatches', () => {
  it('maps each stick to a RAM line carrying its scan image, qty and cost', () => {
    const [p] = buildRamLinePatches(
      [{ scan: scan('M471A4G43MB1-CTD', 'a'), qty: 1, unitCost: '18' }],
      { combineByPn: false },
    );
    expect(p).toMatchObject({
      brand: 'Samsung', partNumber: 'M471A4G43MB1-CTD',
      scanImageId: 'a', scanImageUrl: 'https://img/a', qty: 1, unitCost: '18',
    });
  });

  it('combines identical part numbers (canonical form) at the same cost', () => {
    const patches = buildRamLinePatches(
      [
        { scan: scan('M471A4G43MB1-CTD', 'a'), qty: 1, unitCost: '18' },
        { scan: scan('m471a4g43mb1ctd', 'b'), qty: 2, unitCost: '18' },
        { scan: scan('M471A4G43MB1-CTD', 'c'), qty: 1, unitCost: '20' },
        { scan: scan(undefined, 'd'), qty: 1, unitCost: '18' },
        { scan: scan(undefined, 'e'), qty: 1, unitCost: '18' },
      ],
      { combineByPn: true },
    );
    expect(patches.map(p => [p.scanImageId, p.qty])).toEqual([
      ['a', 3], ['c', 1], ['d', 1], ['e', 1],
    ]);
  });

  it('keeps every stick separate when combining is off', () => {
    const patches = buildRamLinePatches(
      [
        { scan: scan('X1', 'a'), qty: 1, unitCost: '5' },
        { scan: scan('X1', 'b'), qty: 1, unitCost: '5' },
      ],
      { combineByPn: false },
    );
    expect(patches).toHaveLength(2);
  });
});

describe('runPool', () => {
  it('caps concurrency and keeps result order', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = [30, 5, 20, 1, 10].map((ms, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, ms));
      inFlight--;
      if (i === 3) throw new Error('boom');
      return i;
    });
    const res = await runPool(tasks, 2);
    expect(peak).toBe(2);
    expect(res.map(r => (r.status === 'fulfilled' ? r.value : 'err'))).toEqual([0, 1, 2, 'err', 4]);
  });
});

describe('withRateLimitRetry', () => {
  it('waits and retries on 429, then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const v = await withRateLimitRetry(async () => {
      if (++calls < 3) throw new ApiError(429, 'Too many scans, please wait.');
      return 'ok';
    }, { waitMs: 7, sleep: async ms => { waits.push(ms); } });
    expect(v).toBe('ok');
    expect(waits).toEqual([7, 7]);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => {
      calls++;
      throw new ApiError(502, 'down');
    }, { sleep: async () => {} })).rejects.toThrow('down');
    expect(calls).toBe(1);
  });
});

describe('isPristineLine', () => {
  it('is true only for the untouched opening line', () => {
    expect(isPristineLine(blankLine('RAM'))).toBe(true);
    expect(isPristineLine({ ...blankLine('RAM'), qty: 2 })).toBe(false);
    expect(isPristineLine({ ...blankLine('RAM'), brand: 'Samsung' })).toBe(false);
    expect(isPristineLine({ ...blankLine('RAM'), _confirmed: true })).toBe(false);
  });
});

describe('stepStates', () => {
  it('is all pending before anything starts', () => {
    expect(stepStates('idle', 'printer')).toEqual({
      connect: 'pending', scan: 'pending', split: 'pending', read: 'pending',
    });
  });

  it('marks earlier steps done and the current one active', () => {
    expect(stepStates('split', 'printer')).toEqual({
      connect: 'done', scan: 'done', split: 'active', read: 'pending',
    });
  });

  it('marks the failed step as the error and leaves later steps pending', () => {
    expect(stepStates('scan', 'printer', 'scan')).toEqual({
      connect: 'done', scan: 'error', split: 'pending', read: 'pending',
    });
  });

  it('skips the printer steps for an uploaded image', () => {
    expect(stepStates('read', 'upload')).toEqual({
      connect: 'skipped', scan: 'skipped', split: 'done', read: 'active',
    });
  });

  it('is all done (or skipped) on review', () => {
    expect(stepStates('review', 'printer')).toEqual({
      connect: 'done', scan: 'done', split: 'done', read: 'done',
    });
  });
});
