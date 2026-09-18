import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb, schemaHash } from '../src/db.js';
import { assignVariant } from '../src/modules/assignment.js';
import { createSession, getSession, makeApp, putState, rollback, uploadAndPublish, walkToResult, type TestContext } from './helpers.js';

describe('TZ 7.1 test 1 — version is pinned to the session', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('a v1 session keeps v1 after v2 is published; new sessions get v2', async () => {
    const { app, db } = ctx;
    const old = await createSession(app);
    expect(old.version).toBe(1);
    expect(old.funnel.sequence).toHaveLength(9);

    await uploadAndPublish(app, 2);

    const reloaded = await getSession(app, old.sessionId);
    expect(reloaded.version).toBe(1);
    expect(reloaded.experimentId).toBe('question-order-and-result-framing-v1');
    expect(reloaded.funnel.sequence).toEqual(old.funnel.sequence);
    expect(reloaded.funnel.steps.meeting_hours).toBeUndefined();

    // State is validated against v1: an answer to the v2-only question is rejected.
    const bad = await putState(app, old.sessionId, { answers: { meeting_hours: 10 }, history: [], currentStepId: 'intro' }, reloaded.rev);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.errors).toContainEqual({ code: 'unknown_answer', detail: 'meeting_hours' });

    // The old session still finishes on v1.
    const done = await walkToResult(app, reloaded);
    expect(done.version).toBe(1);
    const result = await app.inject({ method: 'POST', url: `/api/sessions/${old.sessionId}/result` });
    expect(result.statusCode).toBe(200);

    const fresh = await createSession(app);
    expect(fresh.version).toBe(2);
    expect(fresh.funnel.sequence).toHaveLength(10);
    expect(fresh.funnel.sequence).toContain('meeting_hours');

    // session_started is written by the server with the session's pinned version.
    const started = db.prepare(`SELECT session_id, funnel_version FROM events WHERE name = 'session_started' ORDER BY funnel_version`).all();
    expect(started).toEqual([
      { session_id: old.sessionId, funnel_version: 1 },
      { session_id: fresh.sessionId, funnel_version: 2 },
    ]);
  });

  it('TZ 7.1 test 4 (sessions part) — a v2 session survives rollback to v1 and still completes on v2', async () => {
    const { app, db } = ctx;
    const hashBefore = schemaHash(db);
    await uploadAndPublish(app, 2);
    const v2 = await createSession(app);
    expect(v2.version).toBe(2);

    expect((await rollback(app)).statusCode).toBe(200);

    const afterRollback = await getSession(app, v2.sessionId);
    expect(afterRollback.version).toBe(2);
    const done = await walkToResult(app, afterRollback, { meeting_hours: 20 });
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${v2.sessionId}/result` });
    expect(res.statusCode).toBe(200);
    expect(res.json().resultId).toBe('meeting_heavy'); // a v2-only result, computed with v2 rules
    expect(done.version).toBe(2);

    expect((await createSession(app)).version).toBe(1);
    expect(schemaHash(db)).toBe(hashBefore);
  });
});

describe('TZ 7.1 test 2 — A/B variant is assigned on the server and is stable', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('the variant never changes across reloads and state saves', async () => {
    const { app } = ctx;
    const s = await createSession(app);
    expect(['A', 'B']).toContain(s.variant);
    expect(s.assignment).toBe('hash');
    for (let i = 0; i < 20; i++) expect((await getSession(app, s.sessionId)).variant).toBe(s.variant);
    const walked = await walkToResult(app, s);
    expect(walked.variant).toBe(s.variant);
    // The variant decides the order the user actually sees.
    const expectedOrder = s.variant === 'A' ? ['intro', 'team_size'] : ['intro', 'work_mode'];
    expect(s.funnel.sequence.slice(0, 2)).toEqual(expectedOrder);
  });

  it('assignment is a deterministic function of experiment and session, split ~50/50', () => {
    const variants = { A: { weight: 50 }, B: { weight: 50 } };
    expect(assignVariant('exp', 'session-1', variants)).toBe(assignVariant('exp', 'session-1', variants));
    let b = 0;
    const n = 10_000;
    for (let i = 0; i < n; i++) if (assignVariant('question-order-and-result-framing-v1', `s-${i}`, variants) === 'B') b++;
    expect(b / n).toBeGreaterThan(0.48);
    expect(b / n).toBeLessThan(0.52);
    // Weights are respected.
    let heavy = 0;
    for (let i = 0; i < n; i++) if (assignVariant('exp', `s-${i}`, { A: { weight: 90 }, B: { weight: 10 } }) === 'A') heavy++;
    expect(heavy / n).toBeGreaterThan(0.88);
    expect(heavy / n).toBeLessThan(0.92);
  });

  it('?variant= override forces the variant, is marked, and never mutates an existing session', async () => {
    const { app } = ctx;
    const natural = await createSession(app);
    const other = natural.variant === 'A' ? 'B' : 'A';
    const forced = await createSession(app, { variantOverride: other });
    expect(forced.variant).toBe(other);
    expect(forced.assignment).toBe('override');
    expect(forced.sessionId).not.toBe(natural.sessionId);
    expect((await getSession(app, natural.sessionId)).variant).toBe(natural.variant);

    // The page passes its query string; the parameter name comes from experiment.overrideQueryParam ("variant").
    const viaQuery = await createSession(app, { query: { variant: other, utm_source: 'x' } });
    expect(viaQuery).toMatchObject({ variant: other, assignment: 'override' });

    const invalid = await createSession(app, { variantOverride: 'C' });
    expect(['A', 'B']).toContain(invalid.variant);
    expect(invalid.assignment).toBe('hash');
  });
});

describe('session state API', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('refresh returns exactly the saved state (answers, history, current step)', async () => {
    const { app } = ctx;
    const s = await createSession(app, { variantOverride: 'A', utm: { utm_campaign: 'spring', utm_source: 'google' } });
    const state = { answers: { team_size: 12 }, history: ['intro', 'team_size'], currentStepId: 'work_mode' };
    expect((await putState(app, s.sessionId, state, s.rev)).statusCode).toBe(200);
    const reloaded = await getSession(app, s.sessionId);
    expect(reloaded.state).toEqual(state);
    expect(reloaded.rev).toBe(1);
    expect(reloaded.utm).toMatchObject({ utm_campaign: 'spring', utm_source: 'google', utm_medium: null });
  });

  it('a stale tab gets 409 instead of overwriting newer state', async () => {
    const { app } = ctx;
    const s = await createSession(app, { variantOverride: 'A' });
    const state = { answers: { team_size: 3 }, history: ['intro', 'team_size'], currentStepId: 'work_mode' };
    expect((await putState(app, s.sessionId, state, 0)).statusCode).toBe(200);
    const stale = await putState(app, s.sessionId, { answers: {}, history: [], currentStepId: 'intro' }, 0);
    expect(stale.statusCode).toBe(409);
    expect((await getSession(app, s.sessionId)).state).toEqual(state);
  });

  it('cannot skip questions or ask for the result early', async () => {
    const { app } = ctx;
    const s = await createSession(app, { variantOverride: 'A' });
    const skip = await putState(app, s.sessionId, { answers: {}, history: ['intro'], currentStepId: 'priorities' }, 0);
    expect(skip.statusCode).toBe(422);
    const early = await app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/result` });
    expect(early.statusCode).toBe(409);
  });

  it('result is computed on the server from the saved answers, with the variant framing', async () => {
    const { app } = ctx;
    const s = await createSession(app, { variantOverride: 'B' });
    await walkToResult(app, s, { work_mode: 'hybrid', async_maturity: 'low' });
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/result` });
    expect(res.json().resultId).toBe('hybrid_structured');
    expect(res.json().result.title).toBe('Your hybrid model needs clearer rules'); // B override
    expect((await getSession(app, s.sessionId)).status).toBe('completed');
  });

  it('an expired session answers 410 so the client starts a new one', async () => {
    let clock = Date.now();
    const db = openDb(':memory:');
    const app = await buildApp({ db, adminToken: 'test-token', now: () => clock });
    await uploadAndPublish(app, 1);
    const s = await createSession(app);
    clock += 73 * 3600_000; // ttlHours = 72
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}` });
    expect(res.statusCode).toBe(410);
    await app.close();
  });

  it('unknown funnel and malformed ids are rejected cleanly', async () => {
    const { app } = ctx;
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: 'nope' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/not-a-uuid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/sessions/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });
});
