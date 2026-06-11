import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + HLS media to the backend so the SPA can use same-origin paths.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/media': 'http://localhost:4000',
    },
  },
});
