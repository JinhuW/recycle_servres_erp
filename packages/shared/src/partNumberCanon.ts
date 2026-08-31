// The canonical form of a part number — the key that decides whether two lines
// describe the same product. Strips a leading P/N | S/N | PART(NO|NUMBER)
// label, drops the separators a part number is written with — whitespace, `_`
// and `-` — and upper-cases, so "ABC-123", "abc_123", " abc 123 " and
// "PN: ABC-123" collapse to one key.
//
// The separators fold because the same part reaches us spelled three ways: a
// vendor sheet writes i5-10500t, a scan writes i5 10500t, the synthesiser writes
// MIXED_256GB_SATA. Each spelling used to open its own ref_prices row and record
// its own price for one product. Only `.` still separates — M.2, 2.5", 1.92TB
// mean something.
//
// It lives here because both apps have to produce the *same* key or a lookup is
// asked under one and answered under another: the frontend canonicalises the
// part numbers it posts to /api/market/lookup, and the backend keys the
// response map with the same rule. They used to be two hand-kept copies that
// spelled whitespace differently, so a part number carrying a non-breaking
// space went out under one key and came back under another and the recorded
// price silently vanished.
//
// Whitespace is spelled out as an explicit ASCII class rather than `\s` because
// a third implementation has to agree too: the SQL twin in the backend's
// lib/part-number.ts, which Postgres runs as POSIX `[[:space:]]`. JS `\s` also
// matches U+00A0, U+2007, U+202F and U+FEFF, which POSIX does not — and a part
// number pasted out of a vendor PDF routinely carries a non-breaking space.

/** ASCII whitespace: the subset Postgres' POSIX `[[:space:]]` also matches. */
const ASCII_WS_INNER = ' \\t\\n\\v\\f\\r';
const ASCII_WS = `[${ASCII_WS_INNER}]`;

/**
 * The leading-label prefix, parameterised by how the target engine spells a
 * whitespace class — `[[:space:]]` for Postgres, the ASCII class above for JS.
 * One template, so the two can only ever differ in that class.
 *
 * The separator after the label is REQUIRED — `:`/`#`, or whitespace. Without
 * it the label matched the opening letters of part numbers that simply start
 * that way, and this trade stocks plenty: Supermicro's SNK-P0048AP4 came back
 * as K-P0048AP4, which is also what PNK-P0048AP4 came back as, so two products
 * shared one ref_prices key and each recorded the other's paid price.
 */
export function partPrefixPattern(ws: string): string {
  return `^${ws}*(P${ws}*/?${ws}*N|S${ws}*/?${ws}*N|PART${ws}*(NO|NUMBER)?)(${ws}*[:#]${ws}*|${ws}+)`;
}

const PREFIX_RE = new RegExp(partPrefixPattern(ASCII_WS), 'i');

/**
 * The separators dropped from the key, parameterised by the *inside* of the
 * engine's whitespace class — `[:space:]` for Postgres, the ASCII escapes above
 * for JS. `-` sits last so it reads as a literal, not a range. The SQL twin
 * inlines the Postgres spelling into a functional index (0085 → 0089 → 0111),
 * so the two stay one template for the same reason the prefix does.
 */
export function partSepPattern(wsClassInner: string): string {
  return `[${wsClassInner}_-]+`;
}

const SEP_RE = new RegExp(partSepPattern(ASCII_WS_INNER), 'g');

/**
 * Drops a leading P/N | S/N | PART label and nothing else — for callers that
 * want the part number as written, not the lookup key. The OCR normaliser is
 * one: what it keeps is what gets stored.
 */
export function stripPartPrefix(pn: string): string {
  return pn.replace(PREFIX_RE, '');
}

export function canonicalPartNumber(pn: string | null | undefined): string {
  return !pn ? '' : stripPartPrefix(pn).replace(SEP_RE, '').toUpperCase();
}
