import { describe, it, expect } from 'vitest';
import { lineRef, newOrdinals, productCount } from './productNo';
import { findDuplicateLine } from './dupParts';
import { duplicatesByIndex, findDuplicatePartNumbers, lineBlockerMessages, type Line } from '../pages/desktop/submit/line';

// A PO product's # is the server's, given on save and never moved: messages
// name a product by it, never by its place in the list.
const t = (key: string, vars?: Record<string, string | number>) =>
  key + (vars ? ' ' + JSON.stringify(vars) : '');

describe('lineRef', () => {
  it('names a saved product by its #, and an unsaved one as new — by its part number or description', () => {
    expect(lineRef({ no: 7, partNumber: 'M393' }, t)).toBe('#7');
    expect(lineRef({}, t)).toBe('lineRefNew');
    expect(lineRef({ no: null, partNumber: ' M393 ' }, t)).toBe('lineRefNewNamed {"name":"M393"}');
    expect(lineRef({ description: 'PSU 750W' }, t)).toBe('lineRefNewNamed {"name":"PSU 750W"}');
  });

  it('names an unsaved product by its place among the new rows, which the # column shows', () => {
    expect(newOrdinals([{ no: 1 }, {}, { no: 3 }, { no: null }])).toEqual([null, 1, null, 2]);
    expect(lineRef({ partNumber: 'B' }, t, 2)).toBe('lineRefNewNNamed {"n":2,"name":"B"}');
    expect(lineRef({}, t, 1)).toBe('lineRefNewN {"n":1}');
    expect(lineRef({ no: 4 }, t, null)).toBe('#4');
  });
});

describe('productCount', () => {
  it('counts a #, not a row: a transfer clone repeats its source\'s #', () => {
    expect(productCount([{ no: 1 }, { no: 3 }, { no: 3 }, { no: 4 }])).toBe(3);
  });

  it('counts each unsaved line as a product of its own', () => {
    expect(productCount([{ no: 1 }, {}, { no: null }])).toBe(3);
  });
});

describe('duplicate part numbers', () => {
  // #2 was removed: the list's places no longer match the #s.
  const lines = [
    { no: 1, partNumber: 'A' },
    { no: 3, partNumber: 'B' },
    { no: 4, partNumber: 'a ' },
    { partNumber: 'B' },
  ];

  it('groups by place in the list, so the caller names each line by its #', () => {
    const groups = findDuplicatePartNumbers(lines);
    expect(groups).toEqual([
      { partNumber: 'A', idxs: [0, 2] },
      { partNumber: 'B', idxs: [1, 3] },
    ]);
    expect(groups[1].idxs.map(i => lineRef(lines[i], t))).toEqual(['#3', 'lineRefNewNamed {"name":"B"}']);
    expect(duplicatesByIndex(groups, lines).get(2)).toEqual([0]);
  });

  it('does not call a transfer\'s clone a duplicate of its source', () => {
    const split = [{ no: 3, partNumber: 'X' }, { no: 3, partNumber: 'X' }, { no: 4, partNumber: 'Y' }];
    expect(findDuplicatePartNumbers(split)).toEqual([]);
    // A third, real duplicate is flagged, and the clone is not named against its source.
    const withDup = [...split, { no: 5, partNumber: 'X' }];
    const groups = findDuplicatePartNumbers(withDup);
    expect(groups).toEqual([{ partNumber: 'X', idxs: [0, 1, 3] }]);
    expect(duplicatesByIndex(groups, withDup).get(0)).toEqual([3]);
  });

  it('hands back the matching line on a scan, not a number', () => {
    expect(findDuplicateLine(lines, 'b')).toBe(lines[1]);
    expect(findDuplicateLine(lines, 'nope')).toBeNull();
  });
});

describe('lineBlockerMessages', () => {
  it('names each line that holds up a submit by its #, or as new', () => {
    const base = { category: 'RAM', condition: 'New', qty: 1, unitCost: 1, _cid: 'x' } as const;
    const lines: Line[] = [{ ...base, no: 5 }, { ...base, _cid: 'y' }];
    const msgs = lineBlockerMessages(lines, t, () => false, () => 'Brand');
    expect(msgs).toEqual([
      'subMissingFieldsLine {"line":"#5","fields":"Brand"}',
      'subMissingFieldsLine {"line":"lineRefNewN {\\"n\\":1}","fields":"Brand"}',
    ]);
  });
});
