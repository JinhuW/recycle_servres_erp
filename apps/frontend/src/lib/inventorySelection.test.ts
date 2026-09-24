import { describe, expect, it } from 'vitest';
import { rememberSelectedRows, resolveSelectedRows } from './inventorySelection';

type Row = { id: string; qty: number };

const rows = (prefix: string, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, qty: 1 }));
const byId = (list: Row[]) => new Map(list.map((r) => [r.id, r]));

describe('inventory selection across searches', () => {
  it('keeps lots picked under an earlier search once that search is gone', () => {
    const poA = rows('a', 7);
    const poB = rows('b', 5);
    const selected = new Set<string>();

    // Search PO A, select its 7 lots.
    let fresh = byId(poA);
    poA.forEach((r) => selected.add(r.id));
    let remembered = rememberSelectedRows(selected, fresh, new Map<string, Row>());
    expect(resolveSelectedRows(selected, fresh, remembered)).toHaveLength(7);

    // Search PO B: A's lots are no longer loaded. Select B's 5.
    fresh = byId(poB);
    poB.forEach((r) => selected.add(r.id));
    remembered = rememberSelectedRows(selected, fresh, remembered);
    expect(resolveSelectedRows(selected, fresh, remembered)).toHaveLength(12);

    // Clear the search: the capped list holds neither PO.
    fresh = byId(rows('z', 3));
    remembered = rememberSelectedRows(selected, fresh, remembered);
    expect(resolveSelectedRows(selected, fresh, remembered).map((r) => r.id))
      .toEqual([...poA, ...poB].map((r) => r.id));
  });

  it('forgets a lot once it is deselected', () => {
    const [a, b] = rows('a', 2);
    const remembered = rememberSelectedRows(new Set([a.id, b.id]), byId([a, b]), new Map<string, Row>());
    const next = rememberSelectedRows(new Set([b.id]), new Map<string, Row>(), remembered);
    expect([...next.keys()]).toEqual([b.id]);
  });

  it('prefers freshly loaded data over the remembered snapshot', () => {
    const stale = { id: 'a0', qty: 4 };
    const current = { id: 'a0', qty: 2 };
    const selected = new Set(['a0']);
    const remembered = rememberSelectedRows(selected, byId([stale]), new Map<string, Row>());
    const fresh = byId([current]);
    expect(resolveSelectedRows(selected, fresh, remembered)).toEqual([current]);
    expect(rememberSelectedRows(selected, fresh, remembered).get('a0')).toBe(current);
  });

  it('returns the same map when nothing changed, so the effect settles', () => {
    const list = rows('a', 3);
    const selected = new Set(list.map((r) => r.id));
    const fresh = byId(list);
    const remembered = rememberSelectedRows(selected, fresh, new Map<string, Row>());
    expect(rememberSelectedRows(selected, fresh, remembered)).toBe(remembered);
    expect(rememberSelectedRows(selected, new Map<string, Row>(), remembered)).toBe(remembered);
  });
});
