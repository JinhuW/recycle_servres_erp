// The purchaser walkthrough: which steps each shell shows, who gets it
// without asking, and the open/closed state the shells, the replay entries
// and the phone's install card all read.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import { usePreference } from './preferences';

export type TourShell = 'desktop' | 'phone';

// Each is a `data-tour` attribute on something the shell already renders —
// labels are translated, so text and class selectors would not hold.
export type TourAnchor = 'dashboard' | 'submit' | 'history' | 'market' | 'guide' | 'me';

export type TourVisual =
  | 'journey' | 'numbers' | 'categories' | 'handoff' | 'payment'
  | 'stages' | 'commission' | 'tools' | 'ready';

export type TourStep = {
  id: string;
  titleKey: string;
  bodyKey: string;
  pointKeys: string[];
  visual: TourVisual;
  anchor: TourAnchor | null;
};

export function tourSteps(shell: TourShell): TourStep[] {
  const desk = shell === 'desktop';
  return [
    { id: 'welcome', titleKey: 'onbWelcomeTitle', bodyKey: 'onbWelcomeBody', pointKeys: [], visual: 'journey', anchor: null },
    {
      id: 'home', titleKey: 'onbHomeTitle', bodyKey: desk ? 'onbHomeBodyDesktop' : 'onbHomeBodyPhone',
      pointKeys: [], visual: 'numbers', anchor: 'dashboard',
    },
    {
      id: 'submit', titleKey: 'onbSubmitTitle', bodyKey: desk ? 'onbSubmitBodyDesktop' : 'onbSubmitBodyPhone',
      pointKeys: ['onbSubmitPointCost', 'onbSubmitPointRam', 'onbSubmitPointOther'],
      visual: 'categories', anchor: 'submit',
    },
    {
      id: 'handoff', titleKey: 'onbHandoffTitle', bodyKey: desk ? 'onbHandoffBodyDesktop' : 'onbHandoffBodyPhone',
      pointKeys: ['onbHandoffPointWarehouse', 'onbHandoffPointSource', 'onbHandoffPointDelivery'],
      visual: 'handoff', anchor: 'history',
    },
    { id: 'payment', titleKey: 'onbPayTitle', bodyKey: 'onbPayBody', pointKeys: [], visual: 'payment', anchor: null },
    {
      id: 'review', titleKey: 'onbReviewTitle', bodyKey: 'onbReviewBody',
      pointKeys: ['onbReviewPointEdit', 'onbReviewPointRevert'], visual: 'stages', anchor: null,
    },
    {
      id: 'paid', titleKey: 'onbPaidTitle', bodyKey: 'onbPaidBody',
      pointKeys: ['onbPaidPointOwed', 'onbPaidPointSale', 'onbPaidPointSelf'], visual: 'commission', anchor: null,
    },
    { id: 'tools', titleKey: 'onbToolsTitle', bodyKey: 'onbToolsBody', pointKeys: [], visual: 'tools', anchor: 'market' },
    {
      id: 'done', titleKey: 'onbDoneTitle', bodyKey: desk ? 'onbDoneBodyDesktop' : 'onbDoneBodyPhone',
      pointKeys: [], visual: 'ready', anchor: desk ? 'guide' : 'me',
    },
  ];
}

// The real role, never the preview: a manager looking at the purchaser shell
// has not just joined.
export function shouldAutoStart(opts: {
  role: string | undefined;
  done: boolean;
  serverDone: unknown;
}): boolean {
  return opts.role === 'purchaser' && !opts.done && opts.serverDone !== true;
}

// ── Open / closed ──────────────────────────────────────────────────────────

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export function openWalkthrough(): void { setOpen(true); }
export function closeWalkthrough(): void { setOpen(false); }

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useWalkthroughOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

// Opens the walkthrough once per signed-in session for someone who has never
// finished or skipped it. `ready` is the shell saying its chrome (the sidebar,
// the tab bar) is on screen to point at.
export function useWalkthroughAutoStart(ready: boolean): void {
  const { user } = useAuth();
  const [done] = usePreference('onboarding.done', false);
  // The preference bag is seeded from this browser's cache and reconciled
  // with the server only after the first render, so on a new device `done`
  // reads false for a moment. The sign-in snapshot covers that moment.
  const serverDone = user?.preferences?.['onboarding.done'];
  const startedFor = useRef<string | null>(null);
  const eligible = shouldAutoStart({ role: user?.role, done, serverDone });
  useEffect(() => {
    if (!ready || !eligible || !user || startedFor.current === user.id) return;
    startedFor.current = user.id;
    openWalkthrough();
  }, [ready, eligible, user]);
  // A walkthrough left open at sign-out must not greet whoever signs in next.
  // Not an unmount cleanup: StrictMode's mount-unmount-mount would close it
  // the moment it opened, and the guard above would keep it shut.
  useEffect(() => { if (!user) closeWalkthrough(); }, [user]);
}

// ── Where the card sits ────────────────────────────────────────────────────

export type Box = { top: number; left: number; width: number; height: number };

export type Placement =
  | { kind: 'center' }
  // Beside a sidebar item, the arrow pointing left at it.
  | { kind: 'right'; top: number; left: number; arrowTop: number }
  // Under something at the top right (the Guide button), arrow pointing up.
  | { kind: 'below'; top: number; right: number; arrowRight: number }
  // Phone: docked above the tab bar, arrow pointing down at the tab.
  | { kind: 'above'; bottom: number; arrowLeft: number | null };

const GAP = 14;
const EDGE = 16;
// The phone card spans the screen less this margin on each side.
export const PHONE_SIDE = 12;
const PHONE_BOTTOM = 24;
const ARROW = 14;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function placeCard(
  shell: TourShell,
  anchor: Box | null,
  viewport: { width: number; height: number },
  card: { width: number; height: number },
): Placement {
  if (shell === 'phone') {
    if (!anchor) return { kind: 'above', bottom: PHONE_BOTTOM, arrowLeft: null };
    const cardWidth = viewport.width - PHONE_SIDE * 2;
    return {
      kind: 'above',
      bottom: viewport.height - anchor.top + GAP,
      arrowLeft: clamp(anchor.left + anchor.width / 2 - PHONE_SIDE - ARROW / 2, EDGE, cardWidth - EDGE - ARROW),
    };
  }
  if (!anchor) return { kind: 'center' };
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  if (centerX > viewport.width / 2) {
    const right = Math.max(EDGE, viewport.width - (anchor.left + anchor.width));
    const cardRight = viewport.width - right;
    return {
      kind: 'below',
      top: anchor.top + anchor.height + GAP,
      right,
      arrowRight: clamp(cardRight - centerX - ARROW / 2, EDGE, card.width - EDGE - ARROW),
    };
  }
  const top = clamp(centerY - 48, EDGE, Math.max(EDGE, viewport.height - card.height - EDGE));
  return {
    kind: 'right',
    top,
    left: anchor.left + anchor.width + GAP,
    arrowTop: clamp(centerY - top - ARROW / 2, EDGE, Math.max(EDGE, card.height - EDGE - ARROW)),
  };
}
