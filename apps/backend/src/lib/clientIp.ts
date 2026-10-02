// The caller's address, as far as the backend can know it.
//
// In production the Worker sends X-Client-IP from CF-Connecting-IP. It has to:
// Railway's edge rewrites X-Forwarded-For, which therefore arrives as one of a
// handful of Cloudflare egress addresses shared by every user. X-Forwarded-For
// stays as the fallback for local dev and for any request that predates the
// Worker sending the private header. Behind the PROXY_SECRET gate only the
// Worker reaches the backend, and it strips whatever a caller sent.
export type ClientIp = {
  // As received, for storing alongside a record (login attempts, submissions).
  full: string | null;
  // What a per-address budget counts by: the IPv4 address, or the /64 an IPv6
  // address sits in. A subscriber is handed a whole /64 or more, so a budget
  // per IPv6 address is a fresh budget per request for anyone who rotates.
  key: string;
};

type HeaderGetter = (name: string) => string | undefined;

export function clientIp(header: HeaderGetter): ClientIp {
  const raw = header('x-client-ip')?.trim()
    || header('x-forwarded-for')?.split(',')[0]?.trim()
    || header('x-real-ip')?.trim()
    || '';
  if (!raw) return { full: null, key: 'unknown' };
  return { full: raw, key: limiterKey(raw) };
}

export function limiterKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip.toLowerCase();
  // An IPv4-mapped address (::ffff:a.b.c.d) is the v4 client.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(':') + '::/64';
}

// Eight 16-bit groups, or null when the text is not an IPv6 address.
function expandIpv6(text: string): number[] | null {
  let s = text.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  // A trailing dotted quad stands for the last two groups.
  let tail: number[] = [];
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((n) => n > 255)) return null;
    tail = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!];
    s = v4[1]!.endsWith('::') ? v4[1]! : v4[1]!.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const words: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    words.push(parseInt(p, 16));
  }
  return [...words, ...tail];
}
