import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
