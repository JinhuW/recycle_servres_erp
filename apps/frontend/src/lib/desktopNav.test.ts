import { describe, it, expect } from 'vitest';
import { DESKTOP_NAV, shownNav, type NavLeaf, type ShownLeaf, type ShownParent } from './desktopNav';
import { I18N } from './i18n';
import type { DesktopViewId } from './route';
import type { Role } from './types';

function oversight(role: Role, view: DesktopViewId) {
  return shownNav(role, view).find(g => g.tKey === 'nav_group_oversight');
}

function monitors(view: DesktopViewId): ShownParent | undefined {
  return oversight('manager', view)?.items
    .find((i): i is ShownParent => i.kind === 'parent' && i.parent.tKey === 'nav_monitors');
}

function leaf(role: Role, view: DesktopViewId, id: DesktopViewId): ShownLeaf | undefined {
  for (const g of shownNav(role, view)) {
    for (const i of g.items) {
      const leaves = i.kind === 'parent' ? i.children : [i];
      const hit = leaves.find(l => l.leaf.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

const allLeaves: NavLeaf[] = DESKTOP_NAV.flatMap(g =>
  g.items.flatMap(i => ('children' in i ? [...i.children] : [i])));

describe('shownNav', () => {
  it('gives purchasers no Monitors entry, and only Settings under Oversight', () => {
    const items = oversight('purchaser', 'dashboard')?.items ?? [];
    expect(items.map(i => (i.kind === 'leaf' ? i.leaf.id : i.parent.tKey))).toEqual(['settings']);
  });

  it('shows Monitors closed elsewhere, pointing at Facebook', () => {
    const m = monitors('dashboard');
    expect(m?.open).toBe(false);
    expect(m?.target).toBe('coordinator');
    expect(m?.children.map(c => c.leaf.id)).toEqual(['coordinator', 'accountPool', 'tracker']);
  });

  it('opens Monitors on the Facebook tracker and lights only Facebook', () => {
    const m = monitors('coordinator');
    expect(m?.open).toBe(true);
    expect(m?.children.map(c => [c.leaf.id, c.active]))
      .toEqual([['coordinator', true], ['accountPool', false], ['tracker', false]]);
  });

  it('opens Monitors on the Account Pool and lights only the Account Pool', () => {
    const m = monitors('accountPool');
    expect(m?.open).toBe(true);
    expect(m?.children.map(c => [c.leaf.id, c.active]))
      .toEqual([['coordinator', false], ['accountPool', true], ['tracker', false]]);
  });

  it('opens Monitors on the Reddit tracker and lights only Reddit', () => {
    const m = monitors('tracker');
    expect(m?.open).toBe(true);
    expect(m?.children.map(c => [c.leaf.id, c.active]))
      .toEqual([['coordinator', false], ['accountPool', false], ['tracker', true]]);
  });

  it('keeps Inventory and Payments lit on their tabs', () => {
    expect(leaf('manager', 'analysis', 'inventory')?.active).toBe(true);
    expect(leaf('manager', 'internaltx', 'payments')?.active).toBe(true);
    expect(leaf('manager', 'dashboard', 'inventory')?.active).toBe(false);
  });
});

describe('DESKTOP_NAV', () => {
  it('lists each view once, and never lights two entries for one view', () => {
    const ids = allLeaves.map(l => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aliases = allLeaves.flatMap(l => l.alsoActiveOn ?? []);
    expect(aliases.filter(a => ids.includes(a))).toEqual([]);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  // The sidebar calls t(n.tKey), which the literal-call coverage test can't
  // see, so a key missing from both dictionaries would render as its slug.
  it('has an English label for every key', () => {
    const keys = DESKTOP_NAV.flatMap(g => [
      g.tKey,
      ...g.items.flatMap(i => ('children' in i ? [i.tKey, ...i.children.map(c => c.tKey)] : [i.tKey])),
    ]);
    expect(keys.filter(k => !(k in I18N.en!))).toEqual([]);
  });
});
