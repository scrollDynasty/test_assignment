/**
 * Consistent online backup of the SQLite database (safe while the server is running, unlike copying the file in WAL mode).
 *
 *   npm run db:backup                              # data/funnel.db -> backups/funnel-<timestamp>.db
 *   DB_PATH=/data/funnel.db npm run db:backup -- /data/backups/funnel.db
 *
 * On Fly.io, run it from the machine (`fly ssh console -C "node … "`) or rely on volume snapshots; for point-in-time
 * recovery the next step would be Litestream streaming the WAL to object storage.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = process.env.DB_PATH ?? resolve('data/funnel.db');
const target = process.argv[2] ?? resolve('backups', `funnel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
mkdirSync(dirname(target), { recursive: true });

const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(target);
db.close();

const copy = new Database(target, { readonly: true });
const check = copy.pragma('integrity_check', { simple: true });
const sessions = (copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
const events = (copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
copy.close();
console.log(JSON.stringify({ source, target, integrity: check, sessions, events }, null, 2));
if (check !== 'ok') process.exit(1);
