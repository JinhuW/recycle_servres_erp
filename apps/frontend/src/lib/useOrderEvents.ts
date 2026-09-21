import { useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import type { OrderEvent } from './types';

// The PO's audit log, fetched once per page. The activity tab renders it and
// the status section's look-back reads it — one request, not two, and both
// move together when `refreshKey` bumps after a save.
export type OrderEvents = { events: OrderEvent[]; loaded: boolean };

const EMPTY: OrderEvents = { events: [], loaded: false };

/** Null skips the fetch — for a component whose host already holds them. */
export function useOrderEvents(orderId: string | null, refreshKey = 0): OrderEvents {
  // Tagged with the order they belong to: the phone swaps one PO for another
  // in place, and until the new log lands the old one must not show under
  // the new id. A refresh of the same PO keeps the list up — no flicker.
  const [held, setHeld] = useState<OrderEvents & { id: string | null }>({ id: orderId, ...EMPTY });
  useEffect(() => {
    if (orderId === null) return;
    let alive = true;
    api.get<{ events: OrderEvent[] }>(`/api/orders/${orderId}/events`)
      .then(r => { if (alive) setHeld({ id: orderId, events: r.events, loaded: true }); })
      .catch(e => {
        handleFetchError(e);
        if (alive) setHeld(h => ({ id: orderId, events: h.id === orderId ? h.events : [], loaded: true }));
      });
    return () => { alive = false; };
  }, [orderId, refreshKey]);
  return held.id === orderId ? held : EMPTY;
}
