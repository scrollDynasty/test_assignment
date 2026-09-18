import { readFileSync } from 'node:fs';
import type { Db } from './db.js';
import type { VersionsService } from './modules/versions.js';

/**
 * On an empty database, upload and publish the initial config so the funnel works right after deploy.
 * Upload + publish run in one transaction: a crash in between must not leave a funnel with no active version.
 */
export function seedIfEmpty(db: Db, versions: VersionsService, configPath: string): { seeded: boolean; funnelId?: string; version?: number } {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { funnelId?: unknown };
  if (typeof raw.funnelId !== 'string') throw new Error(`Seed config ${configPath} has no funnelId`);
  const funnelId = raw.funnelId;
  return db.transaction(() => {
    if (versions.activeVersion(funnelId) !== null) return { seeded: false };
    const { version } = versions.upload(funnelId, raw);
    versions.publish(funnelId, version, 'seed');
    return { seeded: true, funnelId, version };
  })();
}
