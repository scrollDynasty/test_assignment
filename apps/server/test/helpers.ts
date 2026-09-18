import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { isInteractive, nextStepId, type AnswerValue, type SessionDto, type SessionState, type Step } from '@funnel/shared';
import { buildApp } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export const FUNNEL = 'workstyle-planner';
export const ADMIN = { 'x-admin-token': 'test-token' };

/** Provided config file, parsed from disk as-is. */
export function configFile(version: 1 | 2 | 3): Record<string, unknown> {
  return JSON.parse(readFileSync(`${root}funnel-v${version}.json`, 'utf8')) as Record<string, unknown>;
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
}

export async function makeApp(): Promise<TestContext> {
  const db = openDb(':memory:');
  const app = await buildApp({ db, adminToken: 'test-token' });
  return { app, db };
}

export async function uploadAndPublish(app: FastifyInstance, version: 1 | 2 | 3): Promise<void> {
  const up = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/versions`, headers: ADMIN, payload: configFile(version) });
  if (up.statusCode >= 300) throw new Error(`upload v${version}: ${up.statusCode} ${up.body}`);
  const pub = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/versions/${version}/publish`, headers: ADMIN });
  if (pub.statusCode !== 200) throw new Error(`publish v${version}: ${pub.statusCode} ${pub.body}`);
}

export async function rollback(app: FastifyInstance): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({ method: 'POST', url: `/api/admin/funnels/${FUNNEL}/rollback`, headers: ADMIN });
  return { statusCode: res.statusCode, body: res.json() };
}

export async function activeVersion(app: FastifyInstance): Promise<number | null> {
  const res = await app.inject({ method: 'GET', url: `/api/admin/funnels/${FUNNEL}/versions`, headers: ADMIN });
  return (res.json() as { activeVersion: number | null }).activeVersion;
}

export async function createSession(app: FastifyInstance, body: Record<string, unknown> = {}): Promise<SessionDto> {
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL, ...body } });
  expect(res.statusCode).toBe(201);
  return res.json() as SessionDto;
}

export async function getSession(app: FastifyInstance, id: string): Promise<SessionDto> {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json() as SessionDto;
}

export async function putState(app: FastifyInstance, id: string, state: SessionState, rev: number) {
  return app.inject({ method: 'PUT', url: `/api/sessions/${id}/state`, payload: { state, rev } });
}

/** A valid answer for any interactive step: first option / minimum value. */
export function someAnswer(step: Step, preferred: Record<string, AnswerValue>): AnswerValue | undefined {
  if (!isInteractive(step)) return undefined;
  const wanted = preferred[step.input.name];
  if (wanted !== undefined) return wanted;
  if (step.type === 'number') return step.input.min ?? 1;
  const first = step.input.options[0]?.value ?? '';
  return step.type === 'multi-select' ? [first] : first;
}

/** Walks a session to the result step exactly like the UI would: answer, save, advance. */
export async function walkToResult(app: FastifyInstance, dto: SessionDto, preferred: Record<string, AnswerValue> = {}): Promise<SessionDto> {
  let current = dto;
  for (let guard = 0; guard < 50; guard++) {
    const { funnel, state } = current;
    const step = funnel.steps[state.currentStepId];
    if (!step) throw new Error(`unknown step ${state.currentStepId}`);
    if (step.type === 'result') return current;
    const answers = { ...state.answers };
    const value = someAnswer(step, preferred);
    if (value !== undefined && isInteractive(step)) answers[step.input.name] = value;
    const next = nextStepId(funnel, answers, state.currentStepId);
    if (!next) throw new Error('no next step');
    const res = await putState(app, current.sessionId, { answers, history: [...state.history, state.currentStepId], currentStepId: next }, current.rev);
    expect(res.statusCode, res.body).toBe(200);
    current = res.json() as SessionDto;
  }
  throw new Error('did not reach result');
}

