/**
 * Prints a sha256 fingerprint of the database schema (all tables and indexes with their DDL) plus
 * the applied migrations. Run before and after publishing/rolling back a funnel version to prove
 * that the schema was not changed.
 *
 *   npm run db:schema-hash                      # local data/funnel.db
 *   DB_PATH=/data/funnel.db npm run db:schema-hash
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { schemaHash } from '../apps/server/src/db.js';

const path = process.env.DB_PATH ?? resolve('data/funnel.db');
const db = new Database(path, { readonly: true, fileMustExist: true });
const migrations = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as { id: number; name: string }[];
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];

console.log(JSON.stringify({
  db: path,
  schemaHash: schemaHash(db),
  migrations: migrations.map((m) => `${m.id}:${m.name}`),
  tables: tables.map((t) => t.name),
}, null, 2));
db.close();
