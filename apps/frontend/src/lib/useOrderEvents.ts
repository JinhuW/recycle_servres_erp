import { useEffect, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import type { OrderEvent } from './types';

// The PO's audit log, fetched once per page. The activity tab renders it and
// the status section's look-back reads it — one request, not two, and both
// move together when `refreshKey` bumps after a save.
export type OrderEvents = { events: OrderEvent[]; loaded: boolean };

/** Null skips the fetch — for a component whose host already holds them. */
export function useOrderEvents(orderId: string | null, refreshKey = 0): OrderEvents {
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (orderId === null) return;
    let alive = true;
    api.get<{ events: OrderEvent[] }>(`/api/orders/${orderId}/events`)
      .then(r => { if (alive) setEvents(r.events); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [orderId, refreshKey]);
  return { events, loaded };
}
