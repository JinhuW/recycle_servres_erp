import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',                  // bind on all interfaces, not just IPv6 loopback
    port: 5173,
    strictPort: true,                 // fail fast if 5173 is taken instead of silently picking 5174
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
