// Shared diff helper used by services/orderAudit.ts (PO) and
// services/sellOrderAudit.ts (SO). JSON-stable inequality so Date|null
// and number|null compare correctly without coercing 0 to null.

export type AuditChange = { field: string; from: unknown; to: unknown };

export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const f of fields) {
    const a = before[f] ?? null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ field: f as string, from: a, to: b });
    }
  }
  return changes;
}
