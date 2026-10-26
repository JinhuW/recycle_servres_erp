import { useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import { useEffectiveUser } from './tweaks';
import { ACCOUNTING_REVIEW_PATH } from './route';
import type { HomeData, ManagerHome } from './types';

// Home's data and the few rules both shells read it by.

// Days in a stage before the row is tinted: a nudge at 3, a problem at 7.
export const STALE_WARN_DAYS = 3;
export const STALE_BAD_DAYS = 7;

const DAY_MS = 86_400_000;

export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

export type AgeTone = 'ok' | 'warn' | 'bad';

export function ageTone(days: number): AgeTone {
  return days >= STALE_BAD_DAYS ? 'bad' : days >= STALE_WARN_DAYS ? 'warn' : 'ok';
}

/** The PO list opened on one stage (DesktopOrders reads `?stage=`). */
export function poStagePath(stage: string): string {
  return `/purchase-orders?stage=${encodeURIComponent(stage)}`;
}

/** The sell-order list opened on one status (DesktopSellOrders reads `?status=`). */
export function sellStatusPath(status: string): string {
  return `/sell-orders?status=${encodeURIComponent(status)}`;
}

export type AttentionTile = { key: string; labelKey: string; count: number; to: string };

/** The manager's tile row, in the order the work flows: goods in, review,
 *  money, sales, then the side queues. */
export function managerTiles(m: ManagerHome): AttentionTile[] {
  return [
    { key: 'arriving', labelKey: 'homeTileArriving', count: m.inbound.arriving, to: '/shipping' },
    { key: 'inboundNeeds', labelKey: 'homeTileInboundNeeds', count: m.inbound.needs, to: '/shipping' },
    { key: 'review', labelKey: 'homeTileReview', count: m.review.count, to: poStagePath('reviewing') },
    { key: 'reverts', labelKey: 'homeTileReverts', count: m.reverts.count, to: '/purchase-orders' },
    { key: 'readyToPay', labelKey: 'homeTileReadyToPay', count: m.readyToPay.count, to: poStagePath('ready_to_pay') },
    { key: 'signoffs', labelKey: 'homeTileSignoffs', count: m.signoffs.count, to: '/sell-orders' },
    { key: 'unlinked', labelKey: 'homeTileUnlinked', count: m.bank.unlinked, to: '/payments' },
    { key: 'rmb', labelKey: 'homeTileRmb', count: m.rmb.forMe + m.rmb.asked, to: ACCOUNTING_REVIEW_PATH },
  ];
}

// Waiting work goes stale while the page sits open, so Home re-reads on
// return to the tab and every couple of minutes while it is shown.
const REFRESH_MS = 120_000;

export function useHomeData(): HomeData | null {
  const user = useEffectiveUser();
  const [data, setData] = useState<HomeData | null>(null);
  // The role-preview tweak flips the effective role; Home re-scopes with it,
  // as the backend's effectiveRole does.
  const effRole = user?.role;
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get<HomeData>('/api/home')
        .then(r => { if (alive) setData(r); })
        .catch(handleFetchError);
    };
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [effRole]);
  // A stale payload of the other role would render the wrong layout.
  return data && data.role === effRole ? data : null;
}
