import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Two test projects:
 *  - node: engine, server (API through Fastify inject on in-memory SQLite), scripts;
 *  - web:  React components and browser-side modules in jsdom, resolving "@funnel/shared" to the same zod-free
 *          entry the browser bundle uses.
 * End-to-end tests in a real browser live in e2e/ and run with Playwright (npm run test:e2e).
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@funnel/shared': path('./packages/shared/src/index.ts') } },
        test: {
          name: 'node',
          include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@funnel/shared': path('./packages/shared/src/client.ts') } },
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['apps/web/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/shared/src/**', 'apps/server/src/**', 'apps/web/src/**'],
      // Entry points and type-only modules have no logic to cover; styles are not code.
      exclude: ['**/*.d.ts', '**/*.css', 'apps/server/src/main.ts', 'apps/web/src/main.tsx', 'packages/shared/src/{index,client,api,analytics}.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      // Floors just below the measured values, so coverage cannot silently erode. The web pages (FunnelPage,
      // useFunnel, dashboard, admin) are exercised end to end by Playwright (e2e/), which unit coverage does not see.
      thresholds: {
        'packages/shared/src/**': { lines: 92, statements: 88, functions: 92, branches: 80 },
        'apps/server/src/**': { lines: 92, statements: 90, functions: 90, branches: 82 },
        'apps/web/src/**': { lines: 30, statements: 28, functions: 28, branches: 22 },
      },
    },
  },
});
