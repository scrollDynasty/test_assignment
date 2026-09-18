import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const FUNNEL = 'workstyle-planner';
export const ADMIN = { 'x-admin-token': 'test-token' };

/** Provided config file, parsed from disk as-is. */
export function configFile(version: 1 | 2 | 3): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}funnel-v${version}.json`, 'utf8')) as Record<string, unknown>;
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
}

export async function makeApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const app = await buildApp({ db, adminToken: 'test-token' });
  return { app, db };
}

export async function uploadAndPublish(app: FastifyInstance, version: 1 | 2 | 3): Promise<void> {
  const up = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/versions`, headers: ADMIN, payload: configFile(version) });
  if (up.statusCode >= 300) throw new Error(`upload v${version}: ${up.statusCode} ${up.body}`);
  const pub = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/versions/${version}/publish`, headers: ADMIN });
  if (pub.statusCode !== 200) throw new Error(`publish v${version}: ${pub.statusCode} ${pub.body}`);
}

export async function rollback(app: FastifyInstance): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/rollback`, headers: ADMIN });
  return { statusCode: res.statusCode, body: res.json() };
}

export async function activeVersion(app: FastifyInstance): Promise<number | null> {
  const res = await app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL}/versions`, headers: ADMIN });
  return (res.json() as { activeVersion: number | null }).activeVersion;
}
