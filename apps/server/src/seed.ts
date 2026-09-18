import { readFileSync } from 'node:fs';
import type { VersionsService } from './modules/versions.js';

/** On an empty database, upload and publish the initial config so the funnel works right after deploy. */
export function seedIfEmpty(versions: VersionsService, configPath: string): { seeded: boolean; funnelId?: string; version?: number } {
  if (versions.funnelIds().length > 0) return { seeded: false };
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { funnelId?: unknown };
  if (typeof raw.funnelId !== 'string') throw new Error(`Seed config ${configPath} has no funnelId`);
  const { version } = versions.upload(raw.funnelId, raw);
  versions.publish(raw.funnelId, version, 'seed');
  return { seeded: true, funnelId: raw.funnelId, version };
}
