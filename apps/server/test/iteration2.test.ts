import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AnalyticsReport, IncomingEvent, SessionDto } from '@funnel/shared';
import { schemaHash } from '../src/db.js';
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

async function sendEvents(app: FastifyInstance, events: IncomingEvent[]) {
  return (await app.inject({ method: 'POST', url: '/api/events', payload: { events } })).json() as {
    results: { status: string; reason?: string }[];
  };
}

async function report(app: FastifyInstance, version: number): Promise<AnalyticsReport> {
  return (await app.inject({ method: 'GET', url: `/api/analytics?funnelId=workstyle-planner&version=${version}&include_overrides=true&in_progress_minutes=0`, headers: ADMIN })).json() as AnalyticsReport;
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
    expect((await rollback(app)).body).toEqual({ activeVersion: 1, rolledBackFrom: 2 });
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

    // The new event: accepted only from v3 sessions.
    const outcome = await sendEvents(app, [expandedEvent(v1done), expandedEvent(v2done), expandedEvent(b3done)]);
    expect(outcome.results.map((r) => r.reason ?? r.status)).toEqual(['event_not_allowed_for_version', 'event_not_allowed_for_version', 'accepted']);

    // v3 in flight, then rollback: new sessions go back to v1, the v3 session finishes on v3.
    const inFlight = await createSession(app, { variantOverride: 'B' });
    expect((await rollback(app)).body).toEqual({ activeVersion: 1, rolledBackFrom: 3 });
    const inFlightDone = await walkToResult(app, await getSession(app, inFlight.sessionId));
    expect(inFlightDone.version).toBe(3);
    expect((await createSession(app)).version).toBe(1);

    // Analytics: nothing lost, v3 has its own steps and the new event, schema untouched.
    const r3 = await report(app, 3);
    expect(r3.selected?.variants.B?.steps.map((s) => s.stepId)).not.toContain('tool_count');
    expect(r3.selected?.variants.A?.steps.find((s) => s.stepId === 'security_constraints')?.conditional).toBe(true);
    expect(r3.selected?.otherEvents).toEqual([{ name: 'recommendation_expanded', sessions: 1, byVariant: { B: 1 } }]);
    const r1 = await report(app, 1);
    for (const v of beforeV3.v1) {
      const now = r1.versions.find((x) => x.version === v.version);
      expect(now?.started).toBeGreaterThanOrEqual(v.started);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBeGreaterThanOrEqual(beforeV3.events);
    expect(Object.values(r3.selected?.variants ?? {}).every((v) => v.invariantOk)).toBe(true);
    expect(schemaHash(db)).toBe(hash);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(1);
    await app.close();
  });
});
