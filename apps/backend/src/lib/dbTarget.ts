// Guard for the scripts that wipe a database: `seed.mjs` deletes every order,
// and `migrate.mjs --reset` drops every table. Both read DATABASE_URL, and the
// shell can carry one left over from a `railway variables` session, so a
// command meant for the laptop has been one export away from the real data.
// They now run only against a local host, unless the caller opts in by name.
//
// No imports: plain-node `.mjs` scripts load this through type-stripping,
// which cannot resolve the extensionless specifiers used elsewhere in src/.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

export type DbTarget = { host: string; local: boolean };

export function dbTarget(url: string): DbTarget {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { host: '(unparseable DATABASE_URL)', local: false };
  }
  return { host, local: LOCAL_HOSTS.has(host) };
}

/** The refusal to print, or null when the script may go ahead. */
export function destructiveRefusal(
  url: string, what: string, overrideVar: string, env: Record<string, string | undefined>,
): string | null {
  const { host, local } = dbTarget(url);
  if (local || env[overrideVar] === 'true') return null;
  return `${what} refused: DATABASE_URL points at ${host}, which is not a local `
    + `database. If you really mean it, re-run with ${overrideVar}=true.`;
}
