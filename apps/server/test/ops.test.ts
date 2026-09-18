import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionDto } from '@funnel/shared';
import { buildApp } from '../src/app.js';
import { openDb, purgeExpiredAnswers } from '../src/db.js';
import { FUNNEL, uploadAndPublish } from './helpers.js';

describe('privacy: raw answers are wiped after the session expires', () => {
  it('purge empties answers of expired sessions only and keeps everything else', async () => {
    let clock = Date.now();
    const db = openDb(':memory:');
    const app = await buildApp({ db, adminToken: 'test-token', now: () => clock });
    await uploadAndPublish(app, 1);
    const create = async () =>
      (await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL, variantOverride: 'A' } })).json() as SessionDto;
    const old = await create();
    const state = { answers: { team_size: 7 }, history: ['intro', 'team_size'], currentStepId: 'work_mode' };
    await app.inject({ method: 'PUT', url: `/api/sessions/${old.sessionId}/state`, payload: { state, rev: 0 } });
    clock += 73 * 3600_000;
    const fresh = await create();
    await app.inject({ method: 'PUT', url: `/api/sessions/${fresh.sessionId}/state`, payload: { state, rev: 0 } });

    expect(purgeExpiredAnswers(db, clock)).toBe(1);
    const rows = db.prepare('SELECT id, state_json FROM sessions').all() as { id: string; state_json: string }[];
    const byId = new Map(rows.map((r) => [r.id, JSON.parse(r.state_json) as { answers: object; currentStepId: string }]));
    expect(byId.get(old.sessionId)).toMatchObject({ answers: {}, currentStepId: 'work_mode' });
    expect(byId.get(fresh.sessionId)?.answers).toEqual({ team_size: 7 });
    expect(purgeExpiredAnswers(db, clock)).toBe(0); // idempotent
    await app.close();
  });
});

describe('single deployable: the API also serves the built web app', () => {
  it('serves index.html for app routes and JSON 404 for unknown API routes', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const app = await buildApp({ db: openDb(':memory:'), adminToken: 'test-token', webDir });
    const page = await app.inject({ method: 'GET', url: '/f/workstyle-planner?step=intro' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="root"');
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('not_found');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true });
    await app.close();
  });
});
