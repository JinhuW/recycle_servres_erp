// The inventory list only loads what the current search returns (and is capped),
// so a lot picked under an earlier search is no longer in it. The selection keeps
// a snapshot of every picked row so the count, totals and bulk actions still see
// it after the search changes.

/**
 * Next snapshot: each selected id keeps its freshly loaded row, else the row
 * remembered from when it was last loaded; deselected ids are dropped. Returns
 * `prev` itself when nothing changed, so a state setter fed this settles.
 */
export function rememberSelectedRows<T>(
  selected: ReadonlySet<string>,
  fresh: ReadonlyMap<string, T>,
  prev: Map<string, T>,
): Map<string, T> {
  const next = new Map<string, T>();
  let changed = false;
  for (const id of selected) {
    const row = fresh.get(id) ?? prev.get(id);
    if (row === undefined) continue;
    next.set(id, row);
    if (prev.get(id) !== row) changed = true;
  }
  return changed || next.size !== prev.size ? next : prev;
}

/** Selected rows in selection order, preferring freshly loaded data. */
export function resolveSelectedRows<T>(
  selected: ReadonlySet<string>,
  fresh: ReadonlyMap<string, T>,
  remembered: ReadonlyMap<string, T>,
): T[] {
  const out: T[] = [];
  for (const id of selected) {
    const row = fresh.get(id) ?? remembered.get(id);
    if (row !== undefined) out.push(row);
  }
  return out;
}
