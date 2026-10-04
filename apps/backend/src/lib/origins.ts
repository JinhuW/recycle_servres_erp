// The browser origins allowed to make credentialed calls: the
// CORS_ALLOWED_ORIGINS list when it is set, and otherwise only loopback (the
// Vite SPA on a shifting localhost port) — never an arbitrary remote site.
//
// Shared by the credentialed CORS policy (index.ts) and the VNC WebSocket
// route (routes/coordinator.ts). CORS never applies to a WebSocket handshake,
// and the browser sends the session cookie on one from any site, so a socket
// route has to refuse a foreign Origin itself — this is that check.
export function allowedAppOrigin(origin: string | undefined, configured: string | undefined): string | null {
  const allow = (configured ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length > 0) return origin && allow.includes(origin) ? origin : null;
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return origin;
    }
  } catch { /* malformed Origin header — deny */ }
  return null;
}
