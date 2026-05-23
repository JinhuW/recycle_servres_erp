// USD + date formatters lifted from data.jsx so values render the same as the
// prototype.
//
// All formatters accept an optional `locale` string (e.g. 'zh-CN' or 'en-US').
// Call sites obtain the locale via `useT().lang` from i18n.tsx and convert with
// `lang === 'zh' ? 'zh-CN' : 'en-US'`. Defaults to 'en-US' when omitted.

export const fmt = (n: number | null | undefined, locale = 'en-US') =>
  n == null
    ? '—'
    : n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtUSD = (n: number | null | undefined, locale = 'en-US') =>
  n == null ? '—' : '$' + fmt(n, locale);

export const fmt0 = (n: number | null | undefined, locale = 'en-US') =>
  n == null ? '—' : Math.round(n).toLocaleString(locale);

export const fmtUSD0 = (n: number | null | undefined, locale = 'en-US') =>
  n == null ? '—' : '$' + fmt0(n, locale);

export const fmtDate = (d: Date | string, locale = 'en-US') =>
  new Date(d).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateShort = (d: Date | string, locale = 'en-US') =>
  new Date(d).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

// Canonical part number for *grouping* — the key that decides whether two PO
// lines are the same product. Mirrors the scan-time canonicaliser in
// backend/src/ai/normalize.ts#stripPartPrefix, then strips all whitespace and
// upper-cases so "ABC-123", " abc-123 " and "PN: ABC-123" collapse to one key.
// Keep this in lockstep with the SQL canonicaliser in
// backend/src/routes/inventory.ts (GET /events/by-part).
export const canonicalPartNumber = (pn: string | null | undefined): string =>
  !pn ? '' : pn
    .replace(/^\s*(?:P\s*\/?\s*N|S\s*\/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();

export const relTime = (d: Date | string, locale = 'en-US'): string => {
  const date = new Date(d);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return fmtDateShort(date, locale);
};
