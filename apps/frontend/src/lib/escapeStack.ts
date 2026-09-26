// One press of Escape closes one layer: only the top entry fires. Entries
// sort by an order the caller allocates once per layer (at first render, so
// a parent sorts below the child it renders), not by when they were pushed —
// a layer that switches its handler off and back on while a child is open
// must not climb above that child.
//
// Kept free of the DOM so the ordering can be tested without a window.

type Entry = { order: number; handler: () => void };

export type EscapeStack = {
  // Returns the function that removes this entry again.
  push: (order: number, handler: () => void) => () => void;
  // Fires the top entry only. A top entry that ignores the press (its dialog
  // is busy) still swallows it, so the layer beneath never sees it.
  dispatch: () => boolean;
  size: () => number;
};

export function createEscapeStack(): EscapeStack {
  const entries: Entry[] = [];
  return {
    push(order, handler) {
      const entry: Entry = { order, handler };
      let i = entries.length;
      while (i > 0 && entries[i - 1].order > order) i--;
      entries.splice(i, 0, entry);
      return () => {
        const at = entries.indexOf(entry);
        if (at >= 0) entries.splice(at, 1);
      };
    },
    dispatch() {
      const top = entries[entries.length - 1];
      if (!top) return false;
      top.handler();
      return true;
    },
    size: () => entries.length,
  };
}

let nextOrder = 0;

export function allocateEscapeOrder(): number {
  return ++nextOrder;
}
