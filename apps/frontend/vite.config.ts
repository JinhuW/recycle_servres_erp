import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // SW registration is owned by src/lib/pwa.ts so we can gate on user consent.
      injectRegister: false,
      // Don't touch the vendor portal: those URLs are short-lived per-vendor
      // tokens and shouldn't be SW-handled or cached at all.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/v\//, /^\/api\//, /^\/oauth\//, /^\/\.well-known\//],
        runtimeCaching: [
          {
            // API: never cache responses — auth is cookie-based and data changes.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/oauth/')
              || url.pathname.startsWith('/.well-known/'),
            handler: 'NetworkOnly',
          },
          {
            // Google Fonts CSS — stale-while-revalidate keeps the app readable offline.
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
      manifest: {
        name: 'Recycle Servers Inventory',
        short_name: 'Recycle ERP',
        description: 'Inventory, sell orders, and vendor management for Recycle Servers.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        lang: 'en',
        icons: [
          { src: '/icons/icon-192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Submit',    short_name: 'Submit',    url: '/submit',    icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Inventory', short_name: 'Inventory', url: '/inventory', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Orders',    short_name: 'Orders',    url: '/orders',    icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            files: [{ name: 'files', accept: ['image/*'] }],
          },
        },
      },
    }),
  ],
  server: {
    host: '0.0.0.0',                  // bind on all interfaces, not just IPv6 loopback
    port: 5173,
    strictPort: true,                 // fail fast if 5173 is taken instead of silently picking 5174
    allowedHosts: ['inventory.recycleservers.com', 'inventory.jinhu.us'],
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:8787',
        changeOrigin: true,
      },
      // OAuth surfaces live off `/api` — RFC 8414 puts discovery at
      // `/.well-known/oauth-authorization-server`, the token/authorize/consent
      // endpoints under `/oauth/*`. Proxy them through so the SPA can talk to
      // the backend without same-origin gymnastics in dev.
      '/oauth': {
        target: process.env.VITE_API_BASE || 'http://localhost:8787',
        changeOrigin: true,
      },
      '/.well-known': {
        target: process.env.VITE_API_BASE || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
