import { splitHash } from './route';

// Screens holding edits nobody has saved, each with the routes it survives. A
// route change asks only when it would unmount one of them: the phone PO's two
// screens are one instance, so moving between them loses nothing.
type Holder = { keepsOn: (path: string) => boolean };

const holders = new Set<Holder>();

export function registerHolder(keepsOn: (path: string) => boolean): () => void {
  const holder: Holder = { keepsOn };
  holders.add(holder);
  return () => { holders.delete(holder); };
}

/**
 * Whether going to `nextPath` would drop unsaved edits. With no path, whether
 * anything is unsaved at all: the layout switch unmounts every screen.
 */
export function hasUnsavedChanges(nextPath?: string): boolean {
  if (nextPath === undefined) return holders.size > 0;
  const path = splitHash(nextPath).path || '/';
  for (const h of holders) if (!h.keepsOn(path)) return true;
  return false;
}
