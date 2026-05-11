// USD + date formatters lifted from data.jsx so values render the same as the
// prototype.

export const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtUSD = (n: number) => '$' + fmt(n);

export const fmt0 = (n: number) => Math.round(n).toLocaleString('en-US');

export const fmtUSD0 = (n: number) => '$' + fmt0(n);

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const fmtDateShort = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const relTime = (d: Date | string): string => {
  const date = new Date(d);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return fmtDateShort(date);
};
