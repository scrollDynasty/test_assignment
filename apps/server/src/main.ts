import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDb, purgeExpiredAnswers } from './db.js';
import { VersionsService } from './modules/versions.js';
import { seedIfEmpty } from './seed.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Local development only (`npm run dev`); never set on a deployed instance. */
const isDev = process.argv.includes('--dev');

const dbPath = process.env.DB_PATH ?? resolve(repoRoot, 'data/funnel.db');
const seedPath = process.env.SEED_CONFIG ?? resolve(repoRoot, 'funnel-v1.json');
const webDir = process.env.WEB_DIR ?? resolve(repoRoot, 'apps/web/dist');
const port = Number(process.env.PORT ?? 3000);
const adminToken = process.env.ADMIN_TOKEN ?? (isDev ? 'dev-admin-token' : '');
if (adminToken.length < (isDev ? 1 : 16)) {
  throw new Error('ADMIN_TOKEN (16+ chars) is required; the dev default is only used with --dev');
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const seed = seedIfEmpty(db, new VersionsService(db), seedPath);

const app = await buildApp({
  db,
  adminToken,
  // Request logs mask ids in URLs: a session id is enough to read that session's answers until it expires.
  logger: {
    serializers: {
      req: (req: { method: string; url: string; ip: string }) => ({
        method: req.method,
        url: req.url.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id'),
        remoteAddress: req.ip,
      }),
    },
  },
  // Number of trusted reverse proxies in front of the app (Railway and similar: 1). "true" means 1, never "trust all".
  trustProxy: process.env.TRUST_PROXY === 'true' ? 1 : Number(process.env.TRUST_PROXY ?? 0),
  publicRateLimit: Number(process.env.PUBLIC_RATE_LIMIT ?? 600),
  ...(existsSync(webDir) ? { webDir } : {}),
});
if (seed.seeded) app.log.info(seed, 'seeded initial funnel version');
const purge = () => {
  const n = purgeExpiredAnswers(db);
  if (n > 0) app.log.info({ sessions: n }, 'wiped answers of expired sessions');
};
purge();
setInterval(purge, 3600_000).unref();

await app.listen({ port, host: '0.0.0.0' });

// Graceful shutdown (deploys send SIGTERM): stop accepting, finish in-flight requests, close SQLite cleanly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .catch((e: unknown) => app.log.error(e))
      .finally(() => {
        db.close();
        process.exit(0);
      });
  });
}
