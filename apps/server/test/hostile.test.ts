import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { validateConfig, type SessionDto } from '@funnel/shared';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { FUNNEL, configFile, createSession, uploadAndPublish } from './helpers.js';

/** Hostile input on a public URL (found by the final code review). */
async function app(opts: { trustProxy?: number } = {}): Promise<FastifyInstance> {
  const a = await buildApp({ db: openDb(':memory:'), adminToken: 'test-token', ...opts });
  await uploadAndPublish(a, 1);
  return a;
}

function event(s: SessionDto, extra: Record<string, unknown>) {
  return {
    event_id: randomUUID(),
    session_id: s.sessionId,
    name: 'step_viewed',
    client_timestamp: new Date().toISOString(),
    funnel_id: s.funnelId,
    funnel_version: s.version,
    variant: s.variant,
    step_id: 'intro',
    ...extra,
  };
}

describe('inherited object keys are never treated as config entries', () => {
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])('?variant=%s is ignored (no 500)', async (key) => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL, query: { variant: key } } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ assignment: 'hash' });
    await a.close();
  });

  it('an event with step_id "constructor" is rejected, not stored', async () => {
    const a = await app();
    const s = await createSession(a);
    const res = await a.inject({ method: 'POST', url: '/api/events', payload: { events: [event(s, { step_id: 'constructor' })] } });
    expect(res.json().results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_step' });
    await a.close();
  });

  it('a config whose sequence names an inherited key is invalid', () => {
    const raw = structuredClone(configFile(1)) as { experiment: { variants: { A: { stepSequence: string[] } } } };
    raw.experiment.variants.A.stepSequence.splice(1, 0, 'constructor');
    const result = validateConfig(raw);
    expect(result.ok).toBe(false);
  });
});

describe('event values are checked against the pinned version', () => {
  it('out-of-range client timestamps are refused', async () => {
    const a = await app();
    const s = await createSession(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/events',
      payload: { events: [event(s, { client_timestamp: 8.64e15 + 1 }), event(s, { client_timestamp: Date.now() - 90 * 24 * 3600_000 }), event(s, {})] },
    });
    expect(res.json().results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual([
      'client_timestamp_out_of_range',
      'client_timestamp_out_of_range',
      'accepted',
    ]);
    await a.close();
  });

  it('property values that are not ids of this version (or are free text) are dropped', async () => {
    const db = openDb(':memory:');
    const a = await buildApp({ db, adminToken: 'test-token' });
    await uploadAndPublish(a, 1);
    const s = await createSession(a);
    const freeText = event(s, { name: 'step_completed', step_id: 'team_size', properties: { next_step_id: 'my team is 12 people in Berlin' } });
    const valid = event(s, { name: 'step_completed', step_id: 'team_size', properties: { next_step_id: 'work_mode' } });
    const madeUp = event(s, { name: 'cta_clicked', step_id: 'result', properties: { result_id: 'made_up', action: 'expand_recommendation' } });
    await a.inject({ method: 'POST', url: '/api/events', payload: { events: [freeText, valid, madeUp] } });
    const stored = (id: string) =>
      JSON.parse((db.prepare('SELECT properties_json FROM events WHERE event_id = ?').get(id) as { properties_json: string }).properties_json);
    expect(stored(freeText.event_id)).toEqual({});
    expect(stored(valid.event_id)).toEqual({ next_step_id: 'work_mode' });
    expect(stored(madeUp.event_id)).toEqual({ action: 'expand_recommendation' });
    await a.close();
  });
});

describe('rate limits cannot be bypassed and are reported correctly', () => {
  it('a spoofed X-Forwarded-For does not reset the login limit behind one trusted proxy', async () => {
    const a = await app({ trustProxy: 1 });
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await a.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { key: 'wrong' },
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }, // client-controlled part first, real proxy hop last
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    const limited = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' }, headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } });
    expect(limited.json().error).toBe('rate_limited');
    // Checking the session does not spend the login budget.
    expect((await a.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' } })).statusCode).toBe(200);
    await a.close();
  });

  it('health checks the database', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true });
    await a.close();
  });
});
