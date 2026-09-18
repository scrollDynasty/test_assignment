import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_ADMIN_TOKEN } from './e2e/constants';

/**
 * End-to-end tests against the production build (the same server + SPA the Docker image runs), on a fresh SQLite
 * file. Run `npm run build` first. In CI Playwright's own Chromium is used; locally the installed Microsoft Edge
 * (channel "msedge"), so nothing has to be downloaded on a developer machine.
 */
const PORT = 4173;
const CI = Boolean(process.env.CI);
const channel = CI ? {} : { channel: 'msedge' as const };

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  ...(CI ? { workers: 2 } : {}),
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Functional tests assert states, not animations: without motion, view transitions finish at once.
    reducedMotion: 'reduce',
    // The shell-caching service worker is not under test here, and it would hide requests from page.route().
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec/, use: { ...devices['Desktop Chrome'], ...channel } },
    { name: 'mobile', testMatch: /mobile\.spec/, use: { ...devices['Pixel 7'], ...channel } },
  ],
  webServer: {
    command: 'node apps/server/dist/main.js',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    // Server logs are kept in CI, where a failing test needs them; locally they would only clutter the output.
    stdout: CI ? 'pipe' : 'ignore',
    timeout: 30_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      ADMIN_TOKEN: E2E_ADMIN_TOKEN,
      DB_PATH: join(tmpdir(), `funnel-e2e-${Date.now()}.db`),
    },
  },
});
