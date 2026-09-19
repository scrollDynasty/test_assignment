import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingEvent, SessionDto } from '@funnel/shared';
import { FUNNEL, makeApp, uploadAndPublish, walkToResult, type TestContext } from './helpers.js';

async function newSession(app: FastifyInstance, body: Record<string, unknown> = {}): Promise<SessionDto> {
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL, ...body } });
  return res.json() as SessionDto;
}

function event(s: SessionDto, name: string, stepId: string | null, extra: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    event_id: randomUUID(),
    session_id: s.sessionId,
    name,
    client_timestamp: new Date().toISOString(),
    funnel_id: s.funnelId,
    funnel_version: s.version,
    experiment_id: s.experimentId,
    variant: s.variant,
    step_id: stepId,
    utm_source: s.utm.utm_source ?? null,
    utm_medium: s.utm.utm_medium ?? null,
    utm_campaign: s.utm.utm_campaign ?? null,
    ...extra,
  };
}

async function send(app: FastifyInstance, events: unknown[]) {
  return app.inject({ method: 'POST', url: '/api/events', payload: { events } });
}

function count(ctx: TestContext, where = '1=1'): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE name <> 'session_started' AND ${where}`).get() as { n: number }).n;
}

describe('TZ 7.1 test 3 — event de-duplication and batching', () => {
  let ctx: TestContext;
  let s: SessionDto;
  beforeEach(async () => {
    ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
    s = await newSession(ctx.app, { variantOverride: 'A', utm: { utm_campaign: 'spring' } });
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  function fiveEvents(): IncomingEvent[] {
    return [
      event(s, 'step_viewed', 'intro', { seq: 1, properties: { step_type: 'info', visible_step_index: 0, visible_step_count: 6 } }),
      event(s, 'step_viewed', 'team_size', { seq: 2 }),
      event(s, 'answer_submitted', 'team_size', { seq: 3, properties: { answer_kind: 'number' } }),
      event(s, 'step_completed', 'team_size', { seq: 4, properties: { next_step_id: 'work_mode' } }),
      event(s, 'step_viewed', 'work_mode', { seq: 5 }),
    ];
  }

  it('a batch is accepted; re-sending the same batch (retry after timeout) creates no duplicates', async () => {
    const batch = fiveEvents();
    const first = await send(ctx.app, batch);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 5, duplicates: 0, rejected: 0 });
    expect(count(ctx)).toBe(5);

    const retry = await send(ctx.app, batch);
    expect(retry.json()).toMatchObject({ accepted: 0, duplicates: 5, rejected: 0 });
    expect(retry.json().results.every((r: { status: string }) => r.status === 'duplicate')).toBe(true);
    expect(count(ctx)).toBe(5);

    // The same event twice inside one batch is also stored once.
    const e = event(s, 'back_clicked', 'work_mode', { properties: { destination_step_id: 'team_size' } });
    const inBatch = await send(ctx.app, [e, e]);
    expect(inBatch.json()).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(count(ctx)).toBe(6);
  });

  it('one bad event does not break the batch: the others are stored, the bad one is reported', async () => {
    const [a, b, c, d] = fiveEvents();
    const broken = { ...event(s, 'step_viewed', 'priorities'), event_id: 'not-a-uuid' };
    const res = await send(ctx.app, [a, b, broken, c, d]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 4, rejected: 1 });
    expect(res.json().results[2]).toMatchObject({ event_id: 'not-a-uuid', status: 'rejected' });
    expect(res.json().results[2].reason).toMatch(/^invalid_payload/);
    expect(count(ctx)).toBe(4);
  });

  it('rejects, with a reason, events that do not fit the session', async () => {
    const other = await newSession(ctx.app, { variantOverride: 'B' });
    const res = await send(ctx.app, [
      event(s, 'session_started', null), // server-only
      event(s, 'made_up_event', 'intro'), // not declared by v1
      event(s, 'step_viewed', 'meeting_hours'), // v2-only step
      event(s, 'step_viewed', 'intro', { variant: 'B' }), // claims another variant
      event(s, 'step_viewed', 'intro', { session_id: randomUUID() }), // unknown session
      event(other, 'step_viewed', 'intro'), // valid
    ]);
    const reasons = res.json().results.map((r: { status: string; reason?: string }) => r.reason ?? r.status);
    expect(reasons).toEqual([
      'server_only_event',
      'event_not_allowed_for_version',
      'unknown_step',
      'context_mismatch',
      'unknown_session',
      'accepted',
    ]);
  });

  it('the same event_id in upper case is still a duplicate', async () => {
    const original = event(s, 'step_viewed', 'intro');
    await send(ctx.app, [original]);
    const res = await send(ctx.app, [{ ...original, event_id: original.event_id.toUpperCase() }]);
    expect(res.json()).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(count(ctx)).toBe(1);
  });

  it('result and CTA events count only from the result step of a session whose answers reach it', async () => {
    const cta = (step: string | null) => event(s, 'cta_clicked', step, { properties: { result_id: 'balanced', action: 'expand_recommendation' } });
    const early = await send(ctx.app, [cta('result'), event(s, 'result_viewed', 'result'), cta('team_size'), event(s, 'step_viewed', null)]);
    expect(early.json().results.map((r: { reason?: string }) => r.reason)).toEqual([
      'result_not_reached',
      'result_not_reached',
      'result_not_reached',
      'missing_step',
    ]);
    await walkToResult(ctx.app, s);
    const done = await send(ctx.app, [cta('result'), cta('team_size'), cta(null)]);
    expect(done.json().results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual([
      'accepted',
      'result_not_reached',
      'missing_step',
    ]);
  });

  it('first write wins: a retried event_id with a different payload does not overwrite the stored event', async () => {
    await walkToResult(ctx.app, s);
    const original = event(s, 'cta_clicked', 'result', { properties: { result_id: 'balanced', action: 'expand_recommendation' } });
    await send(ctx.app, [original]);
    const tampered = { ...original, properties: { result_id: 'async_native', action: 'expand_recommendation' } };
    const res = await send(ctx.app, [tampered]);
    expect(res.json()).toMatchObject({ duplicates: 1, conflicts: 1 });
    const row = ctx.db.prepare('SELECT properties_json FROM events WHERE event_id = ?').get(original.event_id) as { properties_json: string };
    expect(JSON.parse(row.properties_json)).toEqual({ result_id: 'balanced', action: 'expand_recommendation' });
  });

  it('raw answers never reach analytics: undeclared properties are dropped; context comes from the session', async () => {
    const e = event(s, 'answer_submitted', 'team_size', {
      properties: { answer_kind: 'number', value: 42, answers: { team_size: 42 } },
      utm_campaign: 'forged',
    });
    await send(ctx.app, [e]);
    const row = ctx.db.prepare('SELECT properties_json, utm_campaign, funnel_version, variant FROM events WHERE event_id = ?').get(e.event_id);
    expect(row).toEqual({ properties_json: '{"answer_kind":"number"}', utm_campaign: 'spring', funnel_version: 1, variant: 'A' });
  });

  it('batch size is limited and a malformed request is refused as a whole', async () => {
    const many = Array.from({ length: 101 }, () => event(s, 'step_viewed', 'intro'));
    expect((await send(ctx.app, many)).statusCode).toBe(413);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/events', payload: { nope: 1 } })).statusCode).toBe(400);
    expect(count(ctx)).toBe(0);
  });

  it('every batch is recorded in ingest_log for the data-quality panel', async () => {
    const batch = fiveEvents();
    await send(ctx.app, batch);
    await send(ctx.app, [...batch, { event_id: randomUUID() }]);
    const log = ctx.db.prepare('SELECT accepted, duplicates, rejected FROM ingest_log ORDER BY id').all();
    expect(log).toEqual([
      { accepted: 5, duplicates: 0, rejected: 0 },
      { accepted: 0, duplicates: 5, rejected: 1 },
    ]);
  });
});

describe('events of a newer version (iteration 2 readiness)', () => {
  it('recommendation_expanded is accepted from a v3 session and rejected from a v1 session', async () => {
    const ctx = await makeApp();
    await uploadAndPublish(ctx.app, 1);
    const v1 = await newSession(ctx.app);
    await uploadAndPublish(ctx.app, 3);
    const v3 = await newSession(ctx.app);
    const props = { result_id: 'balanced', action: 'expand_recommendation', source: 'result_cta' };
    const res = await send(ctx.app, [event(v1, 'recommendation_expanded', 'result', { properties: props }), event(v3, 'recommendation_expanded', 'result', { properties: props })]);
    expect(res.json().results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual([
      'event_not_allowed_for_version',
      'accepted',
    ]);
    await ctx.app.close();
  });
});
