import { getTestDb } from './db';

export type SellOrderEventRow = {
  kind: string;
  detail: Record<string, unknown>;
  actor_id: string | null;
};

// Read all events for a sell order in chronological order. Used by audit
// tests to assert event shape after a mutation.
export async function eventsOf(sellOrderId: string): Promise<SellOrderEventRow[]> {
  const sql = getTestDb();
  return (await sql<SellOrderEventRow[]>`
    SELECT kind, detail, actor_id
    FROM sell_order_events
    WHERE sell_order_id = ${sellOrderId}
    ORDER BY created_at ASC, id ASC
  `) as unknown as SellOrderEventRow[];
}
