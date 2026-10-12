import { describe, it, expect, vi } from 'vitest';
import { cascadePatch } from '@recycle-erp/shared';
import {
  partQuestionKey, partQuestionPending, settlePartQuestion, settlePartQuestions,
  type PartAnswer, type PartQuestionLine,
} from './ramPartQuestion';

// Samsung 16GB DDR4 RDIMM, Server, 1Rx4, 2400 — the decoder's own example.
const PN = 'M393A2K40BB1-CRC0Q';
type L = PartQuestionLine & { id: string; _confirmed?: boolean };
const line = (over: Partial<L> = {}): L => ({
  id: 'a', category: 'RAM', partNumber: PN, brand: 'Samsung', capacity: '16GB', generation: 'DDR4',
  classification: 'RDIMM', type: 'Server', rank: '1Rx4', speed: '2400', ...over,
});

// Each save writes an answer through the cascade, as the pages do.
const applyVia = () => vi.fn((l: L, patch: Partial<L>): L => ({ ...l, ...cascadePatch('RAM', l, patch) }));
// Hands out the answers in order; a question past the last one is cancelled.
const answering = (...answers: (PartAnswer | null)[]) => {
  const queue = [...answers];
  return vi.fn(async (_l: L, _i?: number) => queue.shift() ?? null);
};

describe('partQuestionPending', () => {
  it('has nothing to ask of a line that agrees, isn’t RAM, or has a part # nothing decodes', () => {
    expect(partQuestionKey(line())).toBeNull();
    expect(partQuestionPending(line())).toBe(false);
    expect(partQuestionPending(line({ category: 'SSD', rank: '2Rx4' }))).toBe(false);
    expect(partQuestionPending(line({ partNumber: 'KKRVFX-HYC', rank: '2Rx4' }))).toBe(false);
  });

  it('asks about a disagreement nobody kept', () => {
    expect(partQuestionPending(line({ rank: '2Rx4' }))).toBe(true);
  });

  it('is answered by keeping exactly what was shown', () => {
    const l = line({ rank: '2Rx4' });
    expect(partQuestionPending({ ...l, _partKept: partQuestionKey(l) })).toBe(false);
  });

  it('does not reopen the rest when one kept disagreement is fixed', () => {
    const kept = partQuestionKey(line({ rank: '2Rx4', speed: '2133' }));
    expect(partQuestionPending(line({ rank: '2Rx4', _partKept: kept }))).toBe(false);
  });

  it('asks again for a disagreement that is new, or one whose value moved', () => {
    const kept = partQuestionKey(line({ rank: '2Rx4' }));
    expect(partQuestionPending(line({ rank: '2Rx4', capacity: '32GB', _partKept: kept }))).toBe(true);
    expect(partQuestionPending(line({ rank: '2Rx8', _partKept: kept }))).toBe(true);
  });

  it('asks again once the part # is a different one', () => {
    const kept = partQuestionKey(line({ rank: '2Rx4' }));
    // The O-for-0 misread decodes to the same stick, but it is not the part #
    // the user kept the form against.
    expect(partQuestionPending(line({ partNumber: 'M393A2K4OBB1-CRC0Q', rank: '2Rx4', _partKept: kept }))).toBe(true);
  });
});

describe('settlePartQuestion', () => {
  it('returns the line without asking when nothing is in question', async () => {
    const ask = answering();
    const l = line();
    await expect(settlePartQuestion(l, ask, applyVia())).resolves.toBe(l);
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeping records what was shown, through apply, and asks no more', async () => {
    const ask = answering({ kind: 'keep' });
    const apply = applyVia();
    const l = line({ rank: '2Rx4' });
    const out = await settlePartQuestion(l, ask, apply);
    expect(out).toMatchObject({ rank: '2Rx4', _partKept: partQuestionKey(l) });
    expect(apply).toHaveBeenCalledWith(l, { _partKept: partQuestionKey(l) });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('takes the part #’s values', async () => {
    const out = await settlePartQuestion(
      line({ rank: '2Rx4', speed: '2133' }),
      answering({ kind: 'use', patch: { rank: '1Rx4', speed: '2400' } }),
      applyVia(),
    );
    expect(out).toMatchObject({ rank: '1Rx4', speed: '2400' });
    expect(partQuestionPending(out!)).toBe(false);
  });

  it('asks about what is left after a fix to one field', async () => {
    const ask = answering({ kind: 'use', patch: { speed: '2400' } }, { kind: 'keep' });
    const out = await settlePartQuestion(line({ rank: '2Rx4', speed: '2133' }), ask, applyVia());
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toMatchObject({ speed: '2400', rank: '2Rx4' });
    expect(out).toMatchObject({ speed: '2400', rank: '2Rx4' });
    expect(partQuestionPending(out!)).toBe(false);
  });

  it('takes a corrected part # that agrees with the form', async () => {
    // HMAA read as HMA8: the reading is the 32GB 2Rx8 the form describes.
    const misread = {
      partNumber: 'HMA84GR7AJR8N-XN', brand: '', capacity: '32GB', rank: '2Rx8',
      generation: 'DDR4', classification: 'RDIMM', type: '', speed: '',
    };
    const out = await settlePartQuestion(
      line(misread), answering({ kind: 'usePart', partNumber: 'HMAA4GR7AJR8N-XN' }), applyVia());
    expect(out?.partNumber).toBe('HMAA4GR7AJR8N-XN');
    expect(partQuestionPending(out!)).toBe(false);
  });

  it('is null on a cancel, with an answer given before it already applied', async () => {
    const apply = applyVia();
    const out = await settlePartQuestion(
      line({ rank: '2Rx4', speed: '2133' }), answering({ kind: 'use', patch: { speed: '2400' } }, null), apply);
    expect(out).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual({ speed: '2400' });
  });
});

describe('settlePartQuestions', () => {
  it('asks only about the lines the save names, in order, with their index', async () => {
    const ask = answering({ kind: 'keep' });
    const { lines, unsettled } = await settlePartQuestions(
      [
        line({ id: 'confirmed', rank: '2Rx4', _confirmed: true }),
        line({ id: 'open', rank: '2Rx4' }),
        line({ id: 'agrees' }),
      ],
      ask, applyVia(), l => !l._confirmed,
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0].id).toBe('open');
    expect(ask.mock.calls[0][1]).toBe(1);
    expect(unsettled).toEqual([]);
    expect(lines.map(l => partQuestionPending(l))).toEqual([true, false, false]);
  });

  it('stops asking at a cancel: that line and every later one in question come back unsettled', async () => {
    const ask = answering({ kind: 'keep' }, null);
    const { lines, unsettled } = await settlePartQuestions(
      [line({ id: 'a', rank: '2Rx4' }), line({ id: 'b', rank: '2Rx4' }), line({ id: 'c' }), line({ id: 'd', rank: '2Rx4' })],
      ask, applyVia(),
    );
    expect(ask).toHaveBeenCalledTimes(2);
    expect(unsettled).toEqual([1, 3]);
    expect(partQuestionPending(lines[0])).toBe(false);
    expect(partQuestionPending(lines[3])).toBe(true);
  });
});
