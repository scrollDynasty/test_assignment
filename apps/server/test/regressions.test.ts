import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterEventProperties, type AnalyticsReport, type EventsConfig, type IncomingEvent, type SessionDto } from '@funnel/shared';
import { assignVariant } from '../src/modules/assignment.js';
import { ADMIN, FUNNEL, configFile, createSession, getSession, makeApp, putState, uploadAndPublish, walkToResult, type TestContext } from './helpers.js';

/* Regression tests for mutations that the rest of the suite did not catch. */

function event(s: SessionDto, name: string, stepId: string | null, extra: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    event_id: randomUUID(),
    session_id: s.sessionId,
    name,
    client_timestamp: Date.now(),
    funnel_id: s.funnelId,
    funnel_version: s.version,
    experiment_id: s.experimentId,
    variant: s.variant,
    step_id: stepId,
    ...extra,
  };
}

async function send(app: FastifyInstance, events: IncomingEvent[]): Promise<string[]> {
  const res = await app.inject({ method: 'POST', url: '/api/events', payload: { events } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: { status: string; reason?: string }[] }).results.map((r) => r.reason ?? r.status);
}

async function report(app: FastifyInstance, includeOverrides: boolean): Promise<AnalyticsReport> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/analytics?funnelId=${FUNNEL}&include_overrides=${includeOverrides}&in_progress_minutes=0`,
    headers: ADMIN,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsReport;
}

async function postResult(app: FastifyInstance, id: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/sessions/${id}/result` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { resultId: string }).resultId;
}

describe('regressions', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('a finished session whose result_viewed was lost reached the result and is not a drop-off', async () => {
    const { app } = ctx;
    const s = await walkToResult(app, await createSession(app, { variantOverride: 'A' }));
    const last = s.state.history[s.state.history.length - 1] as string;
    expect(await send(app, [event(s, 'step_viewed', last), event(s, 'step_completed', last)])).toEqual(['accepted', 'accepted']);
    await postResult(app, s.sessionId); // …and the result_viewed that followed never arrived
    const a = (await report(app, true)).selected?.variants.A;
    expect(a).toMatchObject({ started: 1, reachedResult: 1, serverCompleted: 1, invariantOk: true });
    expect(a?.steps.every((row) => row.dropoff === 0)).toBe(true);
  });

  it('resultMix counts the server-computed result over the result_id of client events', async () => {
    const { app } = ctx;
    const s = await walkToResult(app, await createSession(app, { variantOverride: 'A' }), { work_mode: 'office', async_maturity: 'low' });
    expect(await postResult(app, s.sessionId)).toBe('office_core');
    // The client claims another (existing) result.
    expect(await send(app, [event(s, 'result_viewed', 'result', { seq: 1, properties: { result_id: 'balanced' } })])).toEqual(['accepted']);

    const r = await report(app, true);
    expect(r.selected?.variants.A?.resultMix).toEqual({ office_core: 1 });
  });

  it('without a server result, resultMix takes the latest result event by client seq', async () => {
    const { app } = ctx;
    const s = await walkToResult(app, await createSession(app, { variantOverride: 'A' }), { work_mode: 'office', async_maturity: 'low' });
    // seq 2 arrives first, has the earlier client clock and the smaller event_id: only seq can put it last.
    const [low, high] = [randomUUID(), randomUUID()].sort() as [string, string];
    const t = Date.now();
    const second = event(s, 'result_viewed', 'result', { event_id: low, seq: 2, client_timestamp: t - 60_000, properties: { result_id: 'balanced' } });
    const first = event(s, 'result_viewed', 'result', { event_id: high, seq: 1, client_timestamp: t, properties: { result_id: 'office_core' } });
    expect(await send(app, [second, first])).toEqual(['accepted', 'accepted']);
    expect((await getSession(app, s.sessionId)).resultId).toBeNull();

    const r = await report(app, true);
    expect(r.selected?.variants.A?.resultMix).toEqual({ balanced: 1 });
  });

  it('saving new state reopens a finished session and the next /result is recomputed', async () => {
    const { app } = ctx;
    const done = await walkToResult(app, await createSession(app, { variantOverride: 'A' }), { work_mode: 'hybrid', async_maturity: 'low' });
    expect(await postResult(app, done.sessionId)).toBe('hybrid_structured');
    const finished = await getSession(app, done.sessionId);
    expect(finished).toMatchObject({ status: 'completed', resultId: 'hybrid_structured' });

    const changed = { ...finished.state, answers: { ...finished.state.answers, async_maturity: 'high' } };
    const saved = await putState(app, done.sessionId, changed, finished.rev);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ status: 'active', resultId: null });
    expect(await getSession(app, done.sessionId)).toMatchObject({ status: 'active', resultId: null });

    expect(await postResult(app, done.sessionId)).toBe('async_native');
    expect(await getSession(app, done.sessionId)).toMatchObject({ status: 'completed', resultId: 'async_native' });
  });

  it('SRM is flagged (ok: false) when the hash split is far from the configured weights', async () => {
    const { app, db } = ctx;
    const create = async (variant: 'A' | 'B') => {
      const res = await app.inject({ method: 'POST', url: '/api/sessions', headers: ADMIN, payload: { funnelId: FUNNEL, variantOverride: variant } });
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as SessionDto).sessionId;
      // Relabelled as hash-assigned, like analytics.test.ts does: the split itself cannot be steered otherwise.
      db.prepare(`UPDATE sessions SET assignment = 'hash' WHERE id = ?`).run(id);
      db.prepare(`UPDATE events SET assignment = 'hash' WHERE session_id = ?`).run(id);
    };
    for (let i = 0; i < 40; i++) await create('A');
    for (let i = 0; i < 5; i++) await create('B');

    const srm = (await report(app, false)).selected?.abTest?.srm;
    expect(srm?.observed).toEqual({ A: 40, B: 5 });
    expect(srm?.expectedShare).toEqual({ A: 0.5, B: 0.5 });
    expect(srm?.pValue).toBeLessThan(0.001);
    expect(srm?.ok).toBe(false);
  });

  it('the same idempotency key for another funnel is a 409 idempotency_conflict, not the other funnel\'s session', async () => {
    const { app } = ctx;
    const other = { ...configFile(1), funnelId: 'other-funnel' };
    expect((await app.inject({ method: 'POST', url: '/api/admin/funnels/other-funnel/versions', headers: ADMIN, payload: other })).statusCode).toBeLessThan(300);
    expect((await app.inject({ method: 'POST', url: '/api/admin/funnels/other-funnel/versions/1/publish', headers: ADMIN })).statusCode).toBe(200);

    const key = '3c9e2b1a-7f6d-4e5c-8b4a-9d8c7b6a5f4e';
    const first = await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL, idempotencyKey: key } });
    expect(first.statusCode).toBe(201);
    const conflict = await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: 'other-funnel', idempotencyKey: key } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('idempotency_conflict');
    expect((await getSession(app, first.json().sessionId)).funnelId).toBe(FUNNEL);
  });

  it('an event claiming another funnel version or funnel is rejected as context_mismatch', async () => {
    const { app } = ctx;
    const s = await createSession(app, { variantOverride: 'A' });
    expect(
      await send(app, [
        event(s, 'step_viewed', 'intro', { funnel_version: s.version + 1 }),
        event(s, 'step_viewed', 'intro', { funnel_id: 'other-funnel' }),
        event(s, 'step_viewed', 'intro'),
      ]),
    ).toEqual(['context_mismatch', 'context_mismatch', 'accepted']);
  });
});

describe('privacy: allowAnswerKinds', () => {
  const events: EventsConfig = {
    baseProperties: [],
    allowed: [{ name: 'answer_submitted', trigger: 'A valid answer is submitted.', properties: ['answer_kind'] }],
    privacy: { storeRawAnswers: false, allowAnswerKinds: false },
  } as EventsConfig;

  it('allowAnswerKinds: false drops answer_kind; true or absent keeps it', () => {
    const props = { answer_kind: 'number', value: 42 };
    expect(filterEventProperties(events, 'answer_submitted', props)).toEqual({});
    expect(filterEventProperties({ ...events, privacy: { storeRawAnswers: false, allowAnswerKinds: true } } as EventsConfig, 'answer_submitted', props)).toEqual({
      answer_kind: 'number',
    });
    expect(filterEventProperties({ ...events, privacy: undefined } as EventsConfig, 'answer_submitted', props)).toEqual({ answer_kind: 'number' });
  });
});

describe('assignment salt', () => {
  it('two experiments assign the same sessions independently (~50% agreement, not 100%)', () => {
    const weights = { A: { weight: 50 }, B: { weight: 50 } };
    const n = 2000;
    let agree = 0;
    let firstIsA = 0;
    for (let i = 0; i < n; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const one = assignVariant('experiment-one', id, weights);
      const two = assignVariant('experiment-two', id, weights);
      expect(assignVariant('experiment-one', id, weights)).toBe(one);
      if (one === two) agree++;
      if (one === 'A') firstIsA++;
    }
    expect(agree / n).toBeGreaterThan(0.4);
    expect(agree / n).toBeLessThan(0.6);
    expect(firstIsA / n).toBeGreaterThan(0.45);
    expect(firstIsA / n).toBeLessThan(0.55);
  });
});
