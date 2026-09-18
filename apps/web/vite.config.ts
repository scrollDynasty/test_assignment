import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The browser gets the zod-free entry of the shared package (see packages/shared/src/client.ts).
    alias: { '@funnel/shared': fileURLToPath(new URL('../../packages/shared/src/client.ts', import.meta.url)) },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  build: { outDir: 'dist', sourcemap: false },
});
