import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { VersionsService } from './modules/versions.js';
import { seedIfEmpty } from './seed.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const isProd = process.env.NODE_ENV === 'production';

const dbPath = process.env.DB_PATH ?? resolve(repoRoot, 'data/funnel.db');
const seedPath = process.env.SEED_CONFIG ?? resolve(repoRoot, 'funnel-v1.json');
const webDir = process.env.WEB_DIR ?? resolve(repoRoot, 'apps/web/dist');
const port = Number(process.env.PORT ?? 3000);
const adminToken = process.env.ADMIN_TOKEN ?? (isProd ? '' : 'dev-admin-token');
if (!adminToken) throw new Error('ADMIN_TOKEN must be set in production');

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const seed = seedIfEmpty(new VersionsService(db), seedPath);

const app = await buildApp({ db, adminToken, logger: true, ...(existsSync(webDir) ? { webDir } : {}) });
if (seed.seeded) app.log.info(seed, 'seeded initial funnel version');
await app.listen({ port, host: '0.0.0.0' });
