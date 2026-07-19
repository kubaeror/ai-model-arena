import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the API + WebSocket live on the dashboard server (default :4000).
// Vite proxies them so the client can use same-origin relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
