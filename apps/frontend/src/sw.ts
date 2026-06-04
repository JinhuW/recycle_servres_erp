/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkOnly, StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';
import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback to /index.html, but never for the vendor portal (short-lived
// per-vendor tokens, must hit the network), backend surfaces, or the
// share-target POST (handled as a fetch event below).
const navRoute = new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/v\//, /^\/api\//, /^\/oauth\//, /^\/\.well-known\//, /^\/share-target$/],
});
registerRoute(navRoute);

// Background-sync only for attachment uploads; the queue retries when
// connectivity returns. Other mutations (status changes, etc.) must NOT be
// auto-replayed — they could race with what the user did since.
const attachmentQueue = new BackgroundSyncPlugin('recycle-erp-attachments', {
  maxRetentionTime: 24 * 60,
});
registerRoute(
  ({ url, request }) => url.pathname === '/api/attachments' && request.method === 'POST',
  new NetworkOnly({ plugins: [attachmentQueue] }),
  'POST',
);

// API / OAuth / well-known: never cache — auth is cookie-based and data changes.
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());
registerRoute(({ url }) => url.pathname.startsWith('/oauth/'), new NetworkOnly());
registerRoute(({ url }) => url.pathname.startsWith('/.well-known/'), new NetworkOnly());

// Google Fonts CSS stale-while-revalidate keeps the app readable offline;
// the font files themselves are immutable so cache-first for a year.
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'google-fonts-stylesheets' }),
);
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [new ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
);

// Web Share Target: intercept POST /share-target, stash the file in SW
// memory, redirect to the SPA page which then asks for the file via
// postMessage. No persistence — files are held only until the page claims
// them or the SW shuts down.
let pendingSharedFile: File | null = null;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith((async () => {
      try {
        const form = await event.request.formData();
        const f = form.get('files');
        if (f instanceof File) pendingSharedFile = f;
      } catch { /* ignore */ }
      return Response.redirect('/share-target?via=sw', 303);
    })());
  }
});

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  // Prompt-mode update: a new SW waits until the user accepts the toast.
  // updateSW(true) -> workbox-window messageSkipWaiting() posts this; only
  // then do we activate, and workbox reloads the page on controllerchange.
  if (data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data?.type === 'pwa:claimSharedFile' && pendingSharedFile) {
    const file = pendingSharedFile;
    pendingSharedFile = null;
    (event.source as { postMessage?: (data: unknown) => void } | null)?.postMessage?.({
      type: 'pwa:sharedFile', file,
    });
  }
});

// No skipWaiting on install — the new SW must wait for the user's tap so the
// update is never applied mid-session. clients.claim() still lets the freshly
// activated SW take control without a second reload.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
