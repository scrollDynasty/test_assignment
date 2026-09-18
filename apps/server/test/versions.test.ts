import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaHash } from '../src/db.js';
import { ADMIN, FUNNEL, activeVersion, configFile, makeApp, rollback, uploadAndPublish, type TestContext } from './helpers.js';

interface ReleaseJson {
  action: string;
  fromVersion: number | null;
  toVersion: number;
}

/** TZ 7.1 test 4 — publish and rollback (version part; session continuity is covered in sessions.test.ts). */
describe('publishing and rolling back versions', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  const url = `/api/admin/funnels/${FUNNEL}`;

  it('v1 -> v2 -> rollback returns to v1 without touching the schema', async () => {
    const { app, db } = ctx;
    const hashBefore = schemaHash(db);

    await uploadAndPublish(app, 1);
    expect(await activeVersion(app)).toBe(1);
    await uploadAndPublish(app, 2);
    expect(await activeVersion(app)).toBe(2);

    expect(await rollback(app)).toEqual({ statusCode: 200, body: { activeVersion: 1, rolledBackFrom: 2 } });
    expect(await activeVersion(app)).toBe(1);

    // Both versions are still stored: rollback moves the pointer, it deletes nothing.
    const list = (await app.inject({ method: 'GET', url: `${url}/versions`, headers: ADMIN })).json();
    expect(list.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(list.releases.map((r: ReleaseJson) => [r.action, r.fromVersion, r.toVersion])).toEqual([
      ['publish', null, 1],
      ['publish', 1, 2],
      ['rollback', 2, 1],
    ]);

    // The very first publish cannot be undone: there is nothing before it.
    expect((await rollback(app)).statusCode).toBe(409);
    expect(await activeVersion(app)).toBe(1);

    expect(schemaHash(db)).toBe(hashBefore);
    const viaApi = await app.inject({ method: 'GET', url: '/api/admin/schema', headers: ADMIN });
    expect(viaApi.json().schemaHash).toBe(hashBefore);
  });

  it('rollback undoes publishes like a stack: v1 -> v2 -> v3 -> rollback -> rollback', async () => {
    const { app } = ctx;
    await uploadAndPublish(app, 1);
    await uploadAndPublish(app, 2);
    await uploadAndPublish(app, 3);
    expect(await activeVersion(app)).toBe(3);
    await rollback(app);
    expect(await activeVersion(app)).toBe(2);
    await rollback(app);
    expect(await activeVersion(app)).toBe(1);
  });

  it('a rolled back version can be published again and rolled back again', async () => {
    const { app } = ctx;
    await uploadAndPublish(app, 1);
    await uploadAndPublish(app, 2);
    await rollback(app);
    await uploadAndPublish(app, 2); // upload is a no-op, publish activates it again
    expect(await activeVersion(app)).toBe(2);
    await rollback(app);
    expect(await activeVersion(app)).toBe(1);
  });

  it('an invalid config is rejected with 422 and the active version does not change', async () => {
    const { app } = ctx;
    await uploadAndPublish(app, 1);
    const broken = structuredClone(configFile(2)) as { steps: Record<string, { type: string }> };
    const step = broken.steps.meeting_hours;
    if (!step) throw new Error('fixture');
    step.type = 'slider';
    const res = await app.inject({ method: 'POST', url: `${url}/versions`, headers: ADMIN, payload: broken });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('invalid_config');
    expect(await activeVersion(app)).toBe(1);
    const publish = await app.inject({ method: 'POST', url: `${url}/versions/2/publish`, headers: ADMIN });
    expect(publish.statusCode).toBe(404);
  });

  it('uploading the same config twice is a no-op; same version number with other content is a conflict', async () => {
    const { app } = ctx;
    const first = await app.inject({ method: 'POST', url: `${url}/versions`, headers: ADMIN, payload: configFile(2) });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: `${url}/versions`, headers: ADMIN, payload: configFile(2) });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('unchanged');

    const changed = { ...configFile(2), title: 'Something else' };
    const conflict = await app.inject({ method: 'POST', url: `${url}/versions`, headers: ADMIN, payload: changed });
    expect(conflict.statusCode).toBe(409);
  });

  it('publishing the active version again does not add a release entry', async () => {
    const { app } = ctx;
    await uploadAndPublish(app, 1);
    const res = await app.inject({ method: 'POST', url: `${url}/versions/1/publish`, headers: ADMIN });
    expect(res.json()).toEqual({ activeVersion: 1, changed: false });
    const list = (await app.inject({ method: 'GET', url: `${url}/versions`, headers: ADMIN })).json();
    expect(list.releases).toHaveLength(1);
  });

  it('admin API requires the token and checks the funnel id', async () => {
    const { app } = ctx;
    const noToken = await app.inject({ method: 'POST', url: `${url}/versions`, payload: configFile(1) });
    expect(noToken.statusCode).toBe(401);
    const wrongFunnel = await app.inject({ method: 'POST', url: '/api/admin/funnels/other/versions', headers: ADMIN, payload: configFile(1) });
    expect(wrongFunnel.statusCode).toBe(400);
  });
});
