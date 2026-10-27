import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

// ─── One probe through a proxy ────────────────────────────────────────────────
// Asks an IP-geo service *through* the proxy, so the answer is the exit
// Facebook sees and the time is the round trip a worker pays. Hand-rolled on
// node:net and node:tls because fetch takes no per-request proxy: an HTTP or
// HTTPS proxy is asked to CONNECT, a SOCKS5 one is spoken to directly, and the
// lookup then runs over that tunnel. The error is always worded here: a
// socket's own message can carry the host, and the URL carries the login.

export const LOOKUP_URL = 'https://ipinfo.io/json';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;

export type ProxyExit = { ip: string | null; city: string | null; region: string | null; country: string | null; org: string | null };
export type ProbeResult =
  | { ok: true; latency_ms: number; exit: ProxyExit }
  | { ok: false; latency_ms: number; error: string };

/** Already worded for the manager. */
class ProbeError extends Error {}

const ERRNO_WORDS: Record<string, string> = {
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset',
  ENOTFOUND: 'Proxy host not found',
  EAI_AGAIN: 'Proxy host not found',
  EHOSTUNREACH: 'Proxy host unreachable',
  ENETUNREACH: 'Proxy host unreachable',
  EPIPE: 'Connection reset',
};

function worded(e: unknown): string {
  if (e instanceof ProbeError) return e.message;
  const code = (e as { code?: string }).code ?? '';
  if (ERRNO_WORDS[code]) return ERRNO_WORDS[code];
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.includes('CERT')) return 'TLS handshake failed';
  return 'Could not connect';
}

/** Reads a socket in exact pieces until handed on. */
function reader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let failed: Error | null = null;
  let want: { test: () => number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  const pump = () => {
    if (!want) return;
    if (failed) { want.reject(failed); want = null; return; }
    const n = want.test();
    if (n < 0) return;
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    const w = want;
    want = null;
    w.resolve(out);
  };
  const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); pump(); };
  const onEnd = () => { failed ??= new ProbeError('Proxy closed the connection'); pump(); };
  const onError = (e: Error) => { failed ??= e; pump(); };
  sock.on('data', onData).on('end', onEnd).on('close', onEnd).on('error', onError);
  const wait = (test: () => number) => new Promise<Buffer>((resolve, reject) => { want = { test, resolve, reject }; pump(); });
  return {
    bytes: (n: number) => wait(() => (buf.length >= n ? n : -1)),
    head: () => wait(() => {
      const at = buf.indexOf('\r\n\r\n');
      if (at < 0 && buf.length > 8192) failed = new ProbeError('Proxy sent a malformed answer');
      return at < 0 ? -1 : at + 4;
    }),
    /** Stops reading; whatever came early goes back on the socket. */
    release() {
      sock.pause();
      sock.off('data', onData).off('end', onEnd).off('close', onEnd).off('error', onError);
      if (buf.length) sock.unshift(buf);
    },
  };
}

/** Kept to destroy at the end. A socket that errors after its reader let go
 *  must not take the process down with an unheard 'error'. */
function track(sockets: net.Socket[], sock: net.Socket): net.Socket {
  sockets.push(sock.on('error', () => {}));
  return sock;
}

function connected(sock: net.Socket, event: 'connect' | 'secureConnect'): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.once(event, () => { sock.off('error', reject); resolve(); });
    sock.once('error', reject);
  });
}

async function connectTunnel(proxy: URL, host: string, port: number, sockets: net.Socket[]): Promise<net.Socket> {
  const scheme = proxy.protocol.replace(/:$/, '');
  const proxyPort = Number(proxy.port || (scheme === 'https' ? 443 : scheme === 'socks5' ? 1080 : 80));
  const user = decodeURIComponent(proxy.username);
  const pass = decodeURIComponent(proxy.password);

  const sock = track(sockets, scheme === 'https'
    ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: net.isIP(proxy.hostname) ? undefined : proxy.hostname })
    : net.connect({ host: proxy.hostname, port: proxyPort }));
  await connected(sock, scheme === 'https' ? 'secureConnect' : 'connect');
  const r = reader(sock);

  if (scheme === 'socks5') {
    sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await r.bytes(2);
    if (ver !== 5) throw new ProbeError('Not a SOCKS5 proxy');
    if (method === 2) {
      if (!user) throw new ProbeError('Proxy wants a login');
      const u = Buffer.from(user);
      const p = Buffer.from(pass);
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await r.bytes(2);
      if (status !== 0) throw new ProbeError('Proxy refused the login');
    } else if (method !== 0) {
      throw new ProbeError('Proxy refused the login');
    }
    const name = Buffer.from(host);
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
    const [, rep, , atyp] = await r.bytes(4);
    if (rep !== 0) throw new ProbeError(`Proxy could not reach the lookup (SOCKS ${rep})`);
    const addr = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.bytes(1))[0];
    await r.bytes(addr + 2);
  } else {
    const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n` : '';
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec((await r.head()).toString('latin1'))?.[1] ?? NaN);
    if (status === 407) throw new ProbeError('Proxy refused the login');
    if (status !== 200) throw new ProbeError(Number.isNaN(status) ? 'Proxy sent a malformed answer' : `Proxy answered ${status}`);
  }
  r.release();
  return sock;
}

function lookupOver(tunnel: net.Socket, lookup: URL, sockets: net.Socket[]): Promise<ProxyExit> {
  const secure = lookup.protocol === 'https:';
  const sock = secure ? track(sockets, tls.connect({ socket: tunnel, servername: lookup.hostname })) : tunnel;
  // The reader paused the tunnel so no early byte was lost; nothing arrives
  // before the request below is written, and the parser is listening by then.
  tunnel.resume();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: lookup.hostname, path: lookup.pathname + lookup.search, method: 'GET',
      headers: { Host: lookup.host, Accept: 'application/json', Connection: 'close' },
      createConnection: () => sock,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new ProbeError(`Lookup answered ${res.statusCode}`));
        return;
      }
      let size = 0;
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_BODY) { req.destroy(); reject(new ProbeError('Lookup answer too large')); return; }
        parts.push(d);
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
          const pick = (k: string) => (typeof body[k] === 'string' && body[k] ? String(body[k]).slice(0, 200) : null);
          resolve({ ip: pick('ip'), city: pick('city'), region: pick('region'), country: pick('country'), org: pick('org') });
        } catch {
          reject(new ProbeError('Lookup answer was not JSON'));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Dials `proxyUrl` (http, https or socks5, login in it) and asks `lookupUrl` through it. Never throws. */
export async function probeProxy(proxyUrl: string, lookupUrl = LOOKUP_URL, timeoutMs = TIMEOUT_MS): Promise<ProbeResult> {
  const started = performance.now();
  const sockets: net.Socket[] = [];
  let timer: NodeJS.Timeout | undefined;
  const latency = () => Math.round(performance.now() - started);
  try {
    const proxy = new URL(proxyUrl);
    const lookup = new URL(lookupUrl);
    const port = Number(lookup.port || (lookup.protocol === 'https:' ? 443 : 80));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeError('Timed out')), timeoutMs);
    });
    const work = connectTunnel(proxy, lookup.hostname, port, sockets).then((t) => lookupOver(t, lookup, sockets));
    // The loser of the race still settles; its rejection is not news.
    work.catch(() => {});
    const exit = await Promise.race([work, timeout]);
    return { ok: true, latency_ms: latency(), exit };
  } catch (e) {
    return { ok: false, latency_ms: latency(), error: e instanceof TypeError ? 'Not a proxy URL' : worded(e) };
  } finally {
    clearTimeout(timer);
    for (const s of sockets) s.destroy();
  }
}
