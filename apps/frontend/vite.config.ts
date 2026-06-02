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
      // injectManifest: the Web Share Target POST handler needs custom SW code
      // (intercept multipart, stash file in SW memory, redirect, postMessage to
      // the page) — declarative runtimeCaching can't express that, so the
      // equivalent routes are wired up in src/sw.ts via registerRoute().
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff,woff2}'],
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
          { name: 'Sell orders', short_name: 'Sell orders', url: '/sell-orders',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
        // Receive images shared from the OS into the AI label flow. The SW's
        // POST handler stashes the file and 303-redirects to ShareTarget,
        // which forwards it to the desktop dropzone via sessionStorage.
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
  // @jsquash/jpeg ships a WASM module it fetches at runtime; pre-bundling it
  // breaks that fetch, so exclude it from Vite's dep optimizer.
  optimizeDeps: {
    exclude: ['@jsquash/jpeg', '@jsquash/jpeg/encode'],
  },
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
