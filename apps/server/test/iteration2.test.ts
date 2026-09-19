import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AnalyticsReport, IncomingEvent, SessionDto } from '@funnel/shared';
import { schemaHash, type Db } from '../src/db.js';
import { ADMIN, createSession, getSession, makeApp, putState, rollback, uploadAndPublish, walkToResult } from './helpers.js';

/*
 * TZ §8 — second iteration with the real funnel-v3.json, following the real release history of this project:
 * v1 → v2 → rollback (iteration 1) → v3 → rollback (iteration 2).
 * v3 adds a conditional branch (security_constraints, shown only when "compliance" is chosen), removes tool_count
 * for variant B and adds the event recommendation_expanded. Nothing here may need a schema change.
 */

const expandedEvent = (s: SessionDto): IncomingEvent => ({
  event_id: randomUUID(),
  session_id: s.sessionId,
  name: 'recommendation_expanded',
  client_timestamp: new Date().toISOString(),
  funnel_id: s.funnelId,
  funnel_version: s.version,
  experiment_id: s.experimentId,
  variant: s.variant,
  step_id: 'result',
  properties: { result_id: s.resultId ?? 'balanced', action: 'expand_recommendation', source: 'result_cta' },
});

const clientEvent = (s: SessionDto, name: string, stepId: string | null, seq: number, properties: Record<string, unknown> = {}): IncomingEvent => ({
  event_id: randomUUID(),
  session_id: s.sessionId,
  name,
  client_timestamp: new Date().toISOString(),
  funnel_id: s.funnelId,
  funnel_version: s.version,
  experiment_id: s.experimentId,
  variant: s.variant,
  step_id: stepId,
  seq,
  properties,
});

async function sendEvents(app: FastifyInstance, events: IncomingEvent[]) {
  return (await app.inject({ method: 'POST', url: '/api/events', payload: { events } })).json() as {
    results: { status: string; reason?: string }[];
  };
}

async function report(app: FastifyInstance, version: number): Promise<AnalyticsReport> {
  return (await app.inject({ method: 'GET', url: `/api/analytics?funnelId=workstyle-planner&version=${version}&include_overrides=true&in_progress_minutes=0`, headers: ADMIN })).json() as AnalyticsReport;
}

/**
 * Everything a rollback must leave untouched. Only `generatedAt` may differ: no event is sent and no session is
 * created or finished between a snapshot and its comparison, so every count, rate, the ingestion totals and the
 * events table itself must be exactly the same (in_progress_minutes=0 keeps the wall clock out of the report).
 */
async function snapshot(app: FastifyInstance, db: Db, versions: number[]) {
  const reports: Record<number, AnalyticsReport> = {};
  for (const v of versions) reports[v] = { ...(await report(app, v)), generatedAt: '' };
  return { reports, events: db.prepare('SELECT * FROM events ORDER BY event_id').all(), sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all() };
}

describe('TZ §8 — iteration 2 (funnel-v3.json) without schema changes', () => {
  it('publishes v3 at runtime, keeps v1/v2 sessions working, rolls back, loses nothing', async () => {
    const { app, db } = await makeApp();
    const hash = schemaHash(db);

    // Iteration 1 history: v1 → v2 → rollback. A v2 session is still in flight after the rollback.
    await uploadAndPublish(app, 1);
    const v1Session = await createSession(app, { variantOverride: 'A' });
    await uploadAndPublish(app, 2);
    const v2Session = await createSession(app, { variantOverride: 'B' });
    await putState(app, v2Session.sessionId, { answers: { work_mode: 'remote' }, history: [], currentStepId: 'meeting_hours' }, v2Session.rev);
    expect(
      await sendEvents(app, [
        clientEvent(v2Session, 'step_viewed', 'work_mode', 1),
        clientEvent(v2Session, 'answer_submitted', 'work_mode', 2, { answer_kind: 'single_select' }),
        clientEvent(v2Session, 'step_completed', 'work_mode', 3, { next_step_id: 'meeting_hours' }),
        clientEvent(v2Session, 'step_viewed', 'meeting_hours', 4),
      ]),
    ).toMatchObject({ results: Array(4).fill({ status: 'accepted' }) });
    const beforeFirstRollback = await snapshot(app, db, [1, 2]);
    expect(beforeFirstRollback.reports[2]?.selected?.variants.B?.steps.find((s) => s.stepId === 'work_mode')).toMatchObject({ viewed: 1, passed: 1 });
    expect((await rollback(app)).body).toEqual({ activeVersion: 1, rolledBackFrom: 2 });
    expect(await snapshot(app, db, [1, 2])).toEqual(beforeFirstRollback);
    const beforeV3 = { v1: (await report(app, 1)).versions, events: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n };

    // Iteration 2: publish v3 without redeploy.
    await uploadAndPublish(app, 3);
    expect(schemaHash(db)).toBe(hash);

    // New branch: security_constraints only when "compliance" is selected; it also opens the new result.
    const a3 = await createSession(app, { variantOverride: 'A' });
    expect(a3.version).toBe(3);
    const compliance = await walkToResult(app, a3, { priorities: ['compliance'], security_constraints: 'regulated' });
    expect(compliance.state.history).toContain('security_constraints');
    const regulated = await app.inject({ method: 'POST', url: `/api/sessions/${a3.sessionId}/result` });
    expect(regulated.json().resultId).toBe('regulated_scale');

    const a3b = await createSession(app, { variantOverride: 'A' });
    const noCompliance = await walkToResult(app, a3b, { priorities: ['speed'] });
    expect(noCompliance.state.history).not.toContain('security_constraints');

    // Variant B of v3 has no tool_count and still completes.
    const b3 = await createSession(app, { variantOverride: 'B' });
    expect(b3.funnel.sequence).not.toContain('tool_count');
    const b3done = await walkToResult(app, b3);
    expect(b3done.state.history).not.toContain('tool_count');
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${b3.sessionId}/result` })).statusCode).toBe(200);

    // Old sessions (v1 and the in-flight v2) finish on their own versions after v3 is live.
    const v1done = await walkToResult(app, await getSession(app, v1Session.sessionId));
    expect(v1done.version).toBe(1);
    expect(v1done.funnel.steps.security_constraints).toBeUndefined();
    const v2done = await walkToResult(app, await getSession(app, v2Session.sessionId), { meeting_hours: 20 });
    expect(v2done.version).toBe(2);
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${v2Session.sessionId}/result` })).json().resultId).toBe('meeting_heavy');
    expect(
      await sendEvents(app, [
        clientEvent(v2done, 'step_viewed', 'result', 5),
        clientEvent(v2done, 'result_viewed', 'result', 6, { result_id: 'meeting_heavy' }),
        clientEvent(v2done, 'cta_clicked', 'result', 7, { result_id: 'meeting_heavy', action: 'expand_recommendation' }),
      ]),
    ).toMatchObject({ results: Array(3).fill({ status: 'accepted' }) });

    // The new event: accepted only from v3 sessions.
    const outcome = await sendEvents(app, [expandedEvent(v1done), expandedEvent(v2done), expandedEvent(b3done)]);
    expect(outcome.results.map((r) => r.reason ?? r.status)).toEqual(['event_not_allowed_for_version', 'event_not_allowed_for_version', 'accepted']);

    // v3 in flight, then rollback: new sessions go back to v1, the v3 session finishes on v3.
    const inFlight = await createSession(app, { variantOverride: 'B' });
    const beforeSecondRollback = await snapshot(app, db, [1, 2, 3]);
    expect(beforeSecondRollback.reports[2]?.selected?.variants.B).toMatchObject({ started: 1, reachedResult: 1, ctaClicked: 1, resultMix: { meeting_heavy: 1 } });
    expect((await rollback(app)).body).toEqual({ activeVersion: 1, rolledBackFrom: 3 });
    expect(await snapshot(app, db, [1, 2, 3])).toEqual(beforeSecondRollback);
    const inFlightDone = await walkToResult(app, await getSession(app, inFlight.sessionId));
    expect(inFlightDone.version).toBe(3);
    expect((await createSession(app)).version).toBe(1);

    // Analytics: nothing lost, v3 has its own steps and the new event, schema untouched.
    const r3 = await report(app, 3);
    expect(r3.selected?.variants.B?.steps.map((s) => s.stepId)).not.toContain('tool_count');
    expect(r3.selected?.variants.A?.steps.find((s) => s.stepId === 'security_constraints')?.conditional).toBe(true);
    expect(r3.selected?.otherEvents).toEqual([{ name: 'recommendation_expanded', sessions: 1, byVariant: { B: 1 } }]);
    // Since beforeV3 exactly one v1 session was started (after the last rollback) and no v2 session; the events table
    // grew by 5 session_started (a3, a3b, b3, inFlight, that v1 session), 3 v2 result/CTA events and 1 accepted v3 event.
    const r1 = await report(app, 1);
    expect(r1.versions.filter((v) => v.version < 3).map((v) => [v.version, v.started])).toEqual(
      beforeV3.v1.map((v) => [v.version, v.version === 1 ? v.started + 1 : v.started]),
    );
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(beforeV3.events + 9);
    expect(Object.values(r3.selected?.variants ?? {}).every((v) => v.invariantOk)).toBe(true);
    expect(schemaHash(db)).toBe(hash);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(1);
    await app.close();
  });
});
