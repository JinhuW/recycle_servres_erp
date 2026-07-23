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

export const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥' };

export const fmtMoney = (
  n: number | null | undefined,
  currency: string,
  locale = 'en-US',
) => {
  if (n == null) return '—';
  const sym = CURRENCY_SYMBOL[currency];
  return sym ? sym + fmt(n, locale) : `${currency} ${fmt(n, locale)}`;
};

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

// Built-in Intl.RelativeTimeFormat localises "just now / 5m ago / 2d ago" into
// every browser locale we care about, so we don't need to ship dictionary
// entries for each unit. `numeric: 'auto'` produces "now" / "刚刚" for 0s.
const RTF_CACHE = new Map<string, Intl.RelativeTimeFormat>();
function getRtf(locale: string): Intl.RelativeTimeFormat {
  let rtf = RTF_CACHE.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    RTF_CACHE.set(locale, rtf);
  }
  return rtf;
}

export const relTime = (d: Date | string, locale = 'en-US'): string => {
  const date = new Date(d);
  const diff = (Date.now() - date.getTime()) / 1000;
  const rtf = getRtf(locale);
  if (diff < 60) return rtf.format(0, 'second');
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), 'hour');
  if (diff < 86400 * 7) return rtf.format(-Math.floor(diff / 86400), 'day');
  return fmtDateShort(date, locale);
};
