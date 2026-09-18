import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  ) STRICT`);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    })();
    ran.push(m.id);
  }
  return ran;
}

/**
 * Fingerprint of the database schema (tables, indexes, their DDL). Used to prove that publishing
 * and rolling back funnel versions never changes the schema.
 */
export function schemaHash(db: Db): string {
  const rows = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Privacy: raw answers are kept only while a session can still be resumed (session.ttlHours).
 * After expiry they are wiped from state; analytics never needed them (events carry no answer values).
 */
export function purgeExpiredAnswers(db: Db, now = Date.now()): number {
  return db
    .prepare(
      `UPDATE sessions SET state_json = json_set(state_json, '$.answers', json('{}'))
       WHERE expires_at <= ? AND json_extract(state_json, '$.answers') <> '{}'`,
    )
    .run(now).changes;
}
