// Which Postgres connect failures are worth waiting out.
//
// Lives apart from migrate.mjs only so it can be imported without running a
// migration as a side effect. Kept free of intra-repo imports for the same
// reason log.ts is: the runner is plain-node .mjs.
//
// postgres.js puts both kinds of failure on the same property. Its
// connection-class errors carry a string `code` ('CONNECT_TIMEOUT' and friends,
// from src/errors.js), a raw socket failure arrives as Node's own error with an
// errno code, and a server-side refusal is a PostgresError carrying the
// SQLSTATE — so one `err.code` check covers all three.

// An allowlist, not a denylist: a code nobody anticipated should surface
// immediately rather than hide behind six retries and a misleading message.
const TRANSIENT_CODES = new Set([
  // Socket-level: nothing is listening yet, or the name/route isn't up.
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET',
  // postgres.js connection class.
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED',
  // SQLSTATE. 57P03 is the one that matters most: it is what a server that has
  // accepted the socket but is still starting up (or is in recovery) answers
  // with, which is the single commonest transient in a deploy — and it is a
  // PostgresError, not a socket error, so a socket-only check would treat the
  // ordinary cold start as fatal.
  '57P03',
  // A rolling deploy can briefly overshoot the connection budget.
  '53300',
]);

export function isTransientConnectError(err) {
  const code = err?.code;
  if (typeof code !== 'string') return false;
  // Class 08 — connection exception, every member of it.
  if (code.startsWith('08')) return true;
  return TRANSIENT_CODES.has(code);
}
