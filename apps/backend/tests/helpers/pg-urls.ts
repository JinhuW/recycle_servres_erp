// Side-effect free on purpose: global-setup.ts imports this, and it must not
// pull in db.ts (which resolves the worker URL at import time).

// CREATE/DROP DATABASE can't target the DB you're connected to, so run them
// from the always-present `postgres` maintenance database on the same cluster.
export function adminUrl(base: string): string {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}
