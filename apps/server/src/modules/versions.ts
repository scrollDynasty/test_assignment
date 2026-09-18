import { createHash } from 'node:crypto';
import { FunnelConfigSchema, validateConfig, type FunnelConfig } from '@funnel/shared';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';

export interface VersionSummary {
  version: number;
  experimentId: string;
  releaseNote: string | null;
  configHash: string;
  createdAt: string;
}

export interface ReleaseEntry {
  id: number;
  action: 'publish' | 'rollback';
  fromVersion: number | null;
  toVersion: number;
  actor: string;
  createdAt: string;
}

export type UploadOutcome = { status: 'created' | 'unchanged'; version: number; warnings: unknown[] };

/** Stable JSON: object keys sorted, so formatting and key order do not change the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface ReleaseRow {
  id: number;
  action: 'publish' | 'rollback';
  from_version: number | null;
  to_version: number;
  actor: string;
  created_at: number;
}

/**
 * Versions are immutable snapshots. Publishing and rolling back only move the `funnel_active` pointer
 * and append to `release_log`; nothing is ever updated or deleted, so sessions pinned to any version
 * keep resolving their config and analytics of every version stays intact.
 */
export class VersionsService {
  /** Parsed configs by "funnel@version". Safe to cache forever: rows are never modified. */
  private readonly cache = new Map<string, FunnelConfig>();

  constructor(private readonly db: Db) {}

  upload(funnelId: string, raw: unknown): UploadOutcome {
    const validation = validateConfig(raw);
    if (!validation.ok) {
      throw new HttpError(422, 'invalid_config', 'Config failed validation', { errors: validation.errors, warnings: validation.warnings });
    }
    const config = validation.config;
    if (config.funnelId !== funnelId) {
      throw new HttpError(400, 'funnel_mismatch', `Config is for funnel "${config.funnelId}", not "${funnelId}"`);
    }
    const hash = createHash('sha256').update(canonicalJson(raw)).digest('hex');
    const existing = this.db
      .prepare('SELECT config_hash FROM funnel_versions WHERE funnel_id = ? AND version = ?')
      .get(funnelId, config.version) as { config_hash: string } | undefined;
    if (existing) {
      if (existing.config_hash === hash) return { status: 'unchanged', version: config.version, warnings: validation.warnings };
      throw new HttpError(409, 'version_conflict', `Version ${config.version} already exists with different content; bump "version"`);
    }
    this.db
      .prepare(
        `INSERT INTO funnel_versions (funnel_id, version, config_json, config_hash, experiment_id, release_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(funnelId, config.version, JSON.stringify(raw), hash, config.experiment.id, config.releaseNote ?? null, Date.now());
    return { status: 'created', version: config.version, warnings: validation.warnings };
  }

  /** Makes an uploaded version active for new sessions. Publishing the already active version is a no-op. */
  publish(funnelId: string, version: number, actor: string): { activeVersion: number; changed: boolean } {
    return this.db.transaction(() => {
      if (!this.exists(funnelId, version)) throw notFound(`Version ${version} of ${funnelId}`);
      const current = this.activeVersion(funnelId);
      if (current === version) return { activeVersion: version, changed: false };
      this.setActive(funnelId, version);
      this.log(funnelId, 'publish', current, version, actor);
      return { activeVersion: version, changed: true };
    }).immediate();
  }

  /** Undoes the most recent publish that has not been undone yet (a stack over release_log). */
  rollback(funnelId: string, actor: string): { activeVersion: number; rolledBackFrom: number } {
    return this.db.transaction(() => {
      const stack: ReleaseRow[] = [];
      for (const row of this.releaseRows(funnelId)) {
        if (row.action === 'publish') stack.push(row);
        else stack.pop();
      }
      const last = stack[stack.length - 1];
      if (!last || last.from_version === null) {
        throw new HttpError(409, 'nothing_to_rollback', 'There is no earlier published version to roll back to');
      }
      this.setActive(funnelId, last.from_version);
      this.log(funnelId, 'rollback', last.to_version, last.from_version, actor);
      return { activeVersion: last.from_version, rolledBackFrom: last.to_version };
    }).immediate();
  }

  activeVersion(funnelId: string): number | null {
    const row = this.db.prepare('SELECT version FROM funnel_active WHERE funnel_id = ?').get(funnelId) as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  }

  getConfig(funnelId: string, version: number): FunnelConfig {
    const key = `${funnelId}@${version}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const row = this.db
      .prepare('SELECT config_json FROM funnel_versions WHERE funnel_id = ? AND version = ?')
      .get(funnelId, version) as { config_json: string } | undefined;
    if (!row) throw notFound(`Version ${version} of ${funnelId}`);
    const config = FunnelConfigSchema.parse(JSON.parse(row.config_json));
    this.cache.set(key, config);
    return config;
  }

  getRawConfig(funnelId: string, version: number): unknown {
    const row = this.db
      .prepare('SELECT config_json FROM funnel_versions WHERE funnel_id = ? AND version = ?')
      .get(funnelId, version) as { config_json: string } | undefined;
    if (!row) throw notFound(`Version ${version} of ${funnelId}`);
    return JSON.parse(row.config_json);
  }

  list(funnelId: string): { activeVersion: number | null; versions: VersionSummary[]; releases: ReleaseEntry[] } {
    const versions = (
      this.db
        .prepare(
          `SELECT version, experiment_id, release_note, config_hash, created_at
           FROM funnel_versions WHERE funnel_id = ? ORDER BY version`,
        )
        .all(funnelId) as { version: number; experiment_id: string; release_note: string | null; config_hash: string; created_at: number }[]
    ).map((r) => ({
      version: r.version,
      experimentId: r.experiment_id,
      releaseNote: r.release_note,
      configHash: r.config_hash,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    const releases = this.releaseRows(funnelId).map((r) => ({
      id: r.id,
      action: r.action,
      fromVersion: r.from_version,
      toVersion: r.to_version,
      actor: r.actor,
      createdAt: new Date(r.created_at).toISOString(),
    }));
    return { activeVersion: this.activeVersion(funnelId), versions, releases };
  }

  funnelIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT funnel_id FROM funnel_versions ORDER BY funnel_id').all() as { funnel_id: string }[]).map(
      (r) => r.funnel_id,
    );
  }

  private exists(funnelId: string, version: number): boolean {
    return this.db.prepare('SELECT 1 FROM funnel_versions WHERE funnel_id = ? AND version = ?').get(funnelId, version) !== undefined;
  }

  private setActive(funnelId: string, version: number): void {
    this.db
      .prepare(
        `INSERT INTO funnel_active (funnel_id, version, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (funnel_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(funnelId, version, Date.now());
  }

  private log(funnelId: string, action: 'publish' | 'rollback', from: number | null, to: number, actor: string): void {
    this.db
      .prepare('INSERT INTO release_log (funnel_id, action, from_version, to_version, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(funnelId, action, from, to, actor, Date.now());
  }

  private releaseRows(funnelId: string): ReleaseRow[] {
    return this.db
      .prepare('SELECT id, action, from_version, to_version, actor, created_at FROM release_log WHERE funnel_id = ? ORDER BY id')
      .all(funnelId) as ReleaseRow[];
  }
}
