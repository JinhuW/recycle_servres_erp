import { describe, it, expect } from 'vitest';
import { placeCard, shouldAutoStart, tourSteps, type TourShell } from './onboarding';
import { shownNav } from './desktopNav';
import { I18N } from './i18n';
import zh from './i18n.zh';

const shells: TourShell[] = ['desktop', 'phone'];

describe('tourSteps', () => {
  // Step copy is looked up by key from a table, which the literal-t() coverage
  // test cannot see.
  it.each(shells)('has every %s step string in English and Chinese', (shell) => {
    for (const s of tourSteps(shell)) {
      for (const key of [s.titleKey, s.bodyKey, ...s.pointKeys]) {
        expect(I18N.en?.[key], key).toBeTruthy();
        expect(zh[key], key).toBeTruthy();
      }
    }
  });

  it('covers submitting, the hand-off, the payment proof and getting paid on both shells', () => {
    for (const shell of shells) {
      expect(tourSteps(shell).map(s => s.id)).toEqual(
        ['welcome', 'home', 'submit', 'handoff', 'payment', 'review', 'paid', 'tools', 'done'],
      );
    }
  });

  // A step pointing at something the purchaser's sidebar does not render
  // would sit centred over a hole in nothing.
  it('only points at places a purchaser has on desktop', () => {
    const leaves = shownNav('purchaser', 'dashboard').flatMap(g =>
      g.items.flatMap(i => (i.kind === 'leaf' ? [i.leaf.id] : i.children.map(c => c.leaf.id))));
    const anchors = tourSteps('desktop').map(s => s.anchor).filter(a => a !== null);
    for (const a of anchors) expect([...leaves, 'guide']).toContain(a);
  });

  it('only points at tabs a purchaser has on the phone', () => {
    const tabs = ['dashboard', 'history', 'submit', 'market', 'me'];
    for (const s of tourSteps('phone')) if (s.anchor) expect(tabs).toContain(s.anchor);
  });
});

describe('shouldAutoStart', () => {
  it('opens for a purchaser with no flag anywhere', () => {
    expect(shouldAutoStart({ role: 'purchaser', done: false, serverDone: undefined })).toBe(true);
  });

  it('stays shut once either the live preference or the sign-in snapshot says done', () => {
    expect(shouldAutoStart({ role: 'purchaser', done: true, serverDone: undefined })).toBe(false);
    expect(shouldAutoStart({ role: 'purchaser', done: false, serverDone: true })).toBe(false);
  });

  it('never opens by itself for a manager', () => {
    expect(shouldAutoStart({ role: 'manager', done: false, serverDone: undefined })).toBe(false);
    expect(shouldAutoStart({ role: undefined, done: false, serverDone: undefined })).toBe(false);
  });
});

describe('placeCard', () => {
  const viewport = { width: 1440, height: 900 };
  const card = { width: 420, height: 380 };

  it('centres a desktop step with nothing to point at', () => {
    expect(placeCard('desktop', null, viewport, card)).toEqual({ kind: 'center' });
  });

  it('puts the card beside a sidebar item, arrow level with it', () => {
    const p = placeCard('desktop', { top: 200, left: 12, width: 200, height: 32 }, viewport, card);
    expect(p.kind).toBe('right');
    if (p.kind !== 'right') return;
    expect(p.left).toBe(12 + 200 + 14);
    expect(p.top + p.arrowTop + 7).toBe(216);
  });

  it('keeps a card beside a low sidebar item on screen', () => {
    const p = placeCard('desktop', { top: 860, left: 12, width: 200, height: 32 }, viewport, card);
    if (p.kind !== 'right') throw new Error(p.kind);
    expect(p.top + card.height).toBeLessThanOrEqual(viewport.height - 16);
  });

  it('drops the card under the top-right Guide button', () => {
    const p = placeCard('desktop', { top: 10, left: 1340, width: 76, height: 26 }, viewport, card);
    expect(p.kind).toBe('below');
    if (p.kind !== 'below') return;
    expect(p.top).toBe(10 + 26 + 14);
    expect(p.right).toBe(1440 - 1416);
  });

  it('docks the phone card above the tab it points at', () => {
    const phone = { width: 390, height: 844 };
    const p = placeCard('phone', { top: 780, left: 160, width: 70, height: 56 }, phone, { width: 366, height: 400 });
    expect(p).toEqual({ kind: 'above', bottom: 844 - 780 + 14, arrowLeft: 160 + 35 - 12 - 7 });
  });
});
