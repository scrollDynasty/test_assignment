import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AnalyticsReport, SessionDto, VariantReport } from '@funnel/shared';
import { buildApp } from '../src/app.js';
import { openDb, type Db } from '../src/db.js';
import { ADMIN, FUNNEL, uploadAndPublish } from './helpers.js';

/*
 * TZ §7.1 "расчёт основных аналитических показателей".
 *
 * Fixture strategy: sessions are created through the real API (POST /api/sessions) so version pinning,
 * UTM stamping and the server-side `session_started` event are the production ones. The variant is forced
 * with `variantOverride` (hash assignment depends on a random UUID, so it cannot be steered), and then the
 * session and its `session_started` row are relabelled to assignment = 'hash'. This way the report is
 * tested with its DEFAULT filter (overrides excluded, as a real dashboard would be used), and one session
 * deliberately keeps assignment = 'override' to prove it is excluded by default and included on request.
 * Client events are inserted straight into `events` (insert-ignore on event_id, stamped from the session
 * row) — exactly what ingestion stores — so each scenario controls precisely which events exist.
 */

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
/** "now" of the report: 2 hours after the sessions were created. */
const REPORT_NOW = T0 + 120 * MIN;

type Variant = 'A' | 'B';
interface SessionSpec {
  key: string;
  variant: Variant;
  campaign: string | null;
  override?: boolean;
  /** Server-side result (sessions.status = 'completed'). */
  serverResult?: string;
  /** expires_at forced into the past relative to REPORT_NOW. */
  expired?: boolean;
}
interface EventSpec {
  id: string;
  session: string;
  name: string;
  step: string | null;
  props: Record<string, unknown>;
  /** Offset from T0 in ms. */
  t: number;
}

interface Ctx {
  app: FastifyInstance;
  db: Db;
  clock: { now: number };
  sessionIds: Map<string, string>;
}

async function makeClockedApp(): Promise<Ctx> {
  const clock = { now: T0 };
  const db = openDb(':memory:');
  const app = await buildApp({ db, adminToken: 'test-token', now: () => clock.now });
  return { app, db, clock, sessionIds: new Map() };
}

async function createSession(ctx: Ctx, spec: SessionSpec): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { funnelId: FUNNEL, variantOverride: spec.variant, utm: { utm_campaign: spec.campaign } },
  });
  expect(res.statusCode, res.body).toBe(201);
  const dto = res.json() as SessionDto;
  expect(dto.variant).toBe(spec.variant);
  const id = dto.sessionId;
  if (!spec.override) {
    ctx.db.prepare(`UPDATE sessions SET assignment = 'hash' WHERE id = ?`).run(id);
    ctx.db.prepare(`UPDATE events SET assignment = 'hash' WHERE session_id = ?`).run(id);
  }
  if (spec.serverResult) {
    ctx.db.prepare(`UPDATE sessions SET status = 'completed', result_id = ? WHERE id = ?`).run(spec.serverResult, id);
  }
  if (spec.expired) ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(REPORT_NOW - 1, id);
  ctx.sessionIds.set(spec.key, id);
}

interface Stamp {
  serverTs: number;
  clientTs: number;
  seq: number;
}

/** Stores one event like ingestion does: insert-ignore on event_id, session values stamped from `sessions`. */
function insertEvent(ctx: Ctx, e: EventSpec, stamp: Stamp): void {
  const sessionId = ctx.sessionIds.get(e.session);
  if (!sessionId) throw new Error(`unknown session ${e.session}`);
  ctx.db
    .prepare(
      `INSERT INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant,
         assignment, utm_source, utm_medium, utm_campaign, client_ts, server_ts, seq, properties_json)
       SELECT ?, s.id, ?, ?, s.funnel_id, s.funnel_version, s.experiment_id, s.variant, s.assignment,
         s.utm_source, s.utm_medium, s.utm_campaign, ?, ?, ?, ?
       FROM sessions s WHERE s.id = ?
       ON CONFLICT (event_id) DO NOTHING`,
    )
    .run(e.id, e.name, e.step, stamp.clientTs, stamp.serverTs, stamp.seq, JSON.stringify(e.props), sessionId);
}

/** Builds event specs for one session with a running clock and auto-generated stable ids. */
class Script {
  readonly events: EventSpec[] = [];
  private n = 0;
  private t: number;
  constructor(
    private readonly session: string,
    startMinute = 1,
  ) {
    this.t = startMinute * MIN;
  }
  emit(name: string, step: string | null = null, props: Record<string, unknown> = {}): this {
    this.events.push({ id: `${this.session}-${++this.n}`, session: this.session, name, step, props, t: this.t });
    this.t += 10 * SEC;
    return this;
  }
  view(step: string): this {
    return this.emit('step_viewed', step);
  }
  /** Interactive step done properly: viewed, answered, completed. */
  done(...steps: string[]): this {
    for (const s of steps) this.view(s).emit('answer_submitted', s).emit('step_completed', s);
    return this;
  }
  result(resultId: string, { viewed = true, cta = false }: { viewed?: boolean; cta?: boolean } = {}): this {
    if (viewed) this.view('result').emit('result_viewed', 'result', { result_id: resultId });
    if (cta) this.emit('cta_clicked', 'result', { result_id: resultId, action: 'primary' });
    return this;
  }
}

// v1 sequences:
//   A: intro, team_size, work_mode, priorities, timezone_span, office_days, async_maturity, tool_count, result
//   B: intro, work_mode, timezone_span, team_size, async_maturity, priorities, office_days, tool_count, result
const A_HYBRID = ['team_size', 'work_mode', 'priorities', 'timezone_span', 'office_days', 'async_maturity', 'tool_count'];
const A_REMOTE = A_HYBRID.filter((s) => s !== 'office_days');
const B_HYBRID = ['work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'office_days', 'tool_count'];
const B_REMOTE = B_HYBRID.filter((s) => s !== 'office_days');

const SESSIONS: SessionSpec[] = [
  { key: 'a1', variant: 'A', campaign: 'spring', serverResult: 'async_native' }, // completes + CTA
  { key: 'a2', variant: 'A', campaign: 'spring', serverResult: 'balanced' }, // remote (office_days hidden), no CTA
  { key: 'a3', variant: 'A', campaign: 'summer' }, // drops at work_mode (answered, never completed)
  { key: 'a4', variant: 'A', campaign: 'summer' }, // reaches timezone_span, goes back to work_mode, leaves
  { key: 'a5', variant: 'A', campaign: null }, // only session_started
  { key: 'a6', variant: 'A', campaign: 'spring' }, // recent activity → in progress
  { key: 'a7', variant: 'A', campaign: 'spring', override: true, serverResult: 'office_core' }, // QA override
  { key: 'a8', variant: 'A', campaign: 'summer', expired: true }, // recent activity but expired → dropoff
  { key: 'b1', variant: 'B', campaign: 'spring', serverResult: 'office_core' }, // completes + CTA
  { key: 'b2', variant: 'B', campaign: 'summer', serverResult: 'hybrid_structured' }, // remote; result_viewed lost, CTA present
  { key: 'b3', variant: 'B', campaign: 'spring' }, // sees intro only
  { key: 'b4', variant: 'B', campaign: 'spring' }, // step_viewed(team_size) lost; drops at async_maturity
  { key: 'b5', variant: 'B', campaign: null }, // only session_started
];

function scenarioEvents(): EventSpec[] {
  return [
    new Script('a1').view('intro').done(...A_HYBRID).result('async_native', { cta: true }),
    new Script('a2').view('intro').done(...A_REMOTE).result('balanced'),
    new Script('a3').view('intro').done('team_size').view('work_mode').emit('answer_submitted', 'work_mode'),
    new Script('a4')
      .view('intro')
      .done('team_size', 'work_mode', 'priorities')
      .view('timezone_span')
      .emit('back_clicked', 'timezone_span', { destination_step_id: 'priorities' })
      .view('priorities')
      .emit('back_clicked', 'priorities', { destination_step_id: 'work_mode' })
      .view('work_mode'),
    new Script('a6', 110).view('intro').done('team_size', 'work_mode').view('priorities'),
    new Script('a7').view('intro').done(...A_HYBRID).result('office_core', { cta: true }),
    new Script('a8', 115).view('intro').view('team_size').emit('answer_submitted', 'team_size'),
    new Script('b1').view('intro').done(...B_HYBRID).result('office_core', { cta: true }),
    new Script('b2').view('intro').done(...B_REMOTE).result('hybrid_structured', { viewed: false, cta: true }),
    new Script('b3').view('intro'),
    new Script('b4')
      .view('intro')
      .done('work_mode', 'timezone_span')
      .emit('answer_submitted', 'team_size')
      .emit('step_completed', 'team_size')
      .view('async_maturity'),
  ].flatMap((s) => s.events);
}

/** Deterministic PRNG (mulberry32) for reproducible shuffles. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Publishes v1, creates all sessions, inserts the scenario events and moves the clock to REPORT_NOW.
 * With a seed, events arrive in a shuffled order, with jittered server/client clocks (±50 s, enough to
 * reorder events inside a session) and random seq — none of which may influence the report.
 */
async function buildFixture(seed?: number): Promise<Ctx> {
  const ctx = await makeClockedApp();
  await uploadAndPublish(ctx.app, 1);
  for (const s of SESSIONS) await createSession(ctx, s);
  const events = scenarioEvents();
  if (seed === undefined) {
    events.forEach((e, i) => insertEvent(ctx, e, { serverTs: T0 + e.t, clientTs: T0 + e.t, seq: i + 1 }));
  } else {
    const random = rng(seed);
    for (const e of shuffle(events, random)) {
      const jitter = Math.round((random() - 0.5) * 100 * SEC);
      insertEvent(ctx, e, {
        serverTs: T0 + e.t + jitter,
        clientTs: T0 + e.t - Math.round(random() * 3600 * SEC),
        seq: Math.floor(random() * 1000),
      });
    }
  }
  ctx.clock.now = REPORT_NOW;
  return ctx;
}

async function report(ctx: Ctx, query: Record<string, string> = {}): Promise<AnalyticsReport> {
  const qs = new URLSearchParams({ funnelId: FUNNEL, ...query }).toString();
  const res = await ctx.app.inject({ method: 'GET', url: `/api/analytics?${qs}`, headers: ADMIN });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AnalyticsReport;
}

function variant(r: AnalyticsReport, v: Variant): VariantReport {
  const out = r.selected?.variants[v];
  if (!out) throw new Error(`variant ${v} missing`);
  return out;
}

const dropoffs = (v: VariantReport): Record<string, number> =>
  Object.fromEntries(v.steps.filter((s) => s.dropoff > 0).map((s) => [s.stepId, s.dropoff]));
const column = (v: VariantReport, key: 'viewed' | 'passed'): Record<string, number | null> =>
  Object.fromEntries(v.steps.map((s) => [s.stepId, s[key]]));

function expectInvariant(v: VariantReport): void {
  const dropped = v.steps.reduce((sum, s) => sum + s.dropoff, 0) + v.beforeFirstStep;
  expect(dropped + v.reachedResult + v.inProgress).toBe(v.started);
  expect(v.invariantOk).toBe(true);
}

describe('TZ 7.1 test 5 — analytics over unique sessions', () => {
  it('computes exact per-variant numbers with the default filter (overrides excluded)', async () => {
    const ctx = await buildFixture();
    const r = await report(ctx);

    expect(r.filters).toEqual({ funnelId: FUNNEL, version: 1, utmCampaign: null, includeOverrides: false, inProgressMinutes: 30 });
    expect(r.availableVersions).toEqual([1]);
    expect(r.availableCampaigns).toEqual(['spring', 'summer']);

    const a = variant(r, 'A');
    expect(a).toMatchObject({ started: 7, reachedResult: 2, ctaClicked: 1, inProgress: 1, serverCompleted: 2, beforeFirstStep: 1 });
    expect(a.completion).toBeCloseTo(2 / 7, 12);
    expect(a.ctr).toBe(0.5);
    expect(a.startToCta).toBeCloseTo(1 / 7, 12);
    expect(a.backRate).toBeCloseTo(1 / 7, 12);
    // a3 dropped at work_mode; a4 went back from timezone_span (furthest) to work_mode; a8 expired at team_size.
    expect(dropoffs(a)).toEqual({ team_size: 1, work_mode: 1, timezone_span: 1 });
    expect(column(a, 'viewed')).toEqual({
      intro: 6, team_size: 6, work_mode: 5, priorities: 4, timezone_span: 3, office_days: 1, async_maturity: 2, tool_count: 2, result: 2,
    });
    expect(column(a, 'passed')).toEqual({
      intro: 6, team_size: 5, work_mode: 4, priorities: 3, timezone_span: 2, office_days: 1, async_maturity: 2, tool_count: 2, result: null,
    });
    const office = a.steps.find((s) => s.stepId === 'office_days');
    // Remote a2 never saw the conditional office_days and still reached the result.
    expect(office).toMatchObject({ type: 'number', conditional: true, position: 5, viewed: 1, passed: 1, stepConversion: 1, dropoff: 0 });
    expect(office?.reach).toBeCloseTo(1 / 7, 12);
    expect(a.steps.find((s) => s.stepId === 'work_mode')?.stepConversion).toBeCloseTo(4 / 5, 12);
    expect(a.resultMix).toEqual({ async_native: 1, balanced: 1 });
    expectInvariant(a);

    const b = variant(r, 'B');
    expect(b).toMatchObject({ started: 5, reachedResult: 2, ctaClicked: 2, inProgress: 0, serverCompleted: 2, beforeFirstStep: 1 });
    // b2 lost result_viewed but clicked the CTA: it still counts as reached, so CTR stays ≤ 100%.
    expect(b.ctr).toBe(1);
    expect(b.completion).toBe(0.4);
    expect(b.startToCta).toBe(0.4);
    expect(b.backRate).toBe(0);
    expect(dropoffs(b)).toEqual({ intro: 1, async_maturity: 1 });
    expect(column(b, 'viewed')).toEqual({
      intro: 4, work_mode: 3, timezone_span: 3, team_size: 3, async_maturity: 3, priorities: 2, office_days: 1, tool_count: 2, result: 2,
    });
    // b4's step_viewed(team_size) was lost; answer/complete events still prove the view.
    expect(column(b, 'passed')).toEqual({
      intro: 3, work_mode: 3, timezone_span: 3, team_size: 3, async_maturity: 2, priorities: 2, office_days: 1, tool_count: 2, result: null,
    });
    expect(b.steps.map((s) => s.stepId)).toEqual([...['intro'], ...B_HYBRID, 'result']);
    expect(b.resultMix).toEqual({ hybrid_structured: 1, office_core: 1 });
    expectInvariant(b);

    expect(r.versions).toEqual([
      {
        version: 1,
        experimentId: 'question-order-and-result-framing-v1',
        started: 12,
        reachedResult: 4,
        ctaClicked: 3,
        inProgress: 1,
        completion: 4 / 12,
        ctr: 3 / 4,
        startToCta: 3 / 12,
        serverCompleted: 4,
      },
    ]);
    expect(r.selected?.otherEvents).toEqual([]);
  });

  it('A/B block: rates with Wilson CIs, z-test, MDE and SRM on hash-assigned sessions', async () => {
    const r = await report(await buildFixture());
    const ab = r.selected?.abTest;
    expect(ab).toBeTruthy();
    if (!ab) return;
    expect(ab.metric).toBe('startToCta');
    // The A/B comparison uses finished sessions only: A has one session still in progress (7 started → 6 compared).
    expect(ab.a).toMatchObject({ variant: 'A', sessions: 6, conversions: 1 });
    expect(ab.b).toMatchObject({ variant: 'B', sessions: 5, conversions: 2 });
    expect(ab.diff).toBeCloseTo(0.4 - 1 / 6, 12);
    // pooled 3/11: z = 0.23333 / sqrt(0.19835 * (1/6 + 1/5)) = 0.8652 → p ≈ 0.3869
    expect(ab.pValue).toBeCloseTo(0.3869, 3);
    expect(ab.significant).toBe(false);
    expect(ab.a.ci?.[0]).toBeLessThan(1 / 6);
    expect(ab.a.ci?.[1]).toBeGreaterThan(1 / 6);
    expect(ab.diffCi?.[0]).toBeLessThan(0);
    expect(ab.diffCi?.[1]).toBeGreaterThan(ab.diff);
    expect(ab.mde).toBeGreaterThan(0);
    // SRM checks the assignment itself, so it counts every randomized session, finished or not: 7 vs 5, p = 0.5637.
    expect(ab.srm).toMatchObject({ observed: { A: 7, B: 5 }, expectedShare: { A: 0.5, B: 0.5 }, ok: true });
    expect(ab.srm?.pValue).toBeCloseTo(0.5637, 3);
  });

  it('filters by utm_campaign', async () => {
    const ctx = await buildFixture();
    const spring = await report(ctx, { utm_campaign: 'spring' });
    expect(variant(spring, 'A')).toMatchObject({ started: 3, reachedResult: 2, ctaClicked: 1, inProgress: 1, beforeFirstStep: 0 });
    expect(dropoffs(variant(spring, 'A'))).toEqual({});
    expect(variant(spring, 'B')).toMatchObject({ started: 3, reachedResult: 1, ctaClicked: 1, inProgress: 0 });
    expect(dropoffs(variant(spring, 'B'))).toEqual({ intro: 1, async_maturity: 1 });
    expect(spring.filters.utmCampaign).toBe('spring');
    expect(spring.versions[0]).toMatchObject({ started: 6, reachedResult: 3, ctaClicked: 2 });

    const summer = await report(ctx, { utm_campaign: 'summer' });
    expect(variant(summer, 'A')).toMatchObject({ started: 3, reachedResult: 0, ctaClicked: 0, inProgress: 0, ctr: null });
    expect(dropoffs(variant(summer, 'A'))).toEqual({ team_size: 1, work_mode: 1, timezone_span: 1 });
    expect(variant(summer, 'B')).toMatchObject({ started: 1, reachedResult: 1, ctaClicked: 1, ctr: 1 });
    expect(summer.selected?.abTest).not.toBeNull();

    const none = await report(ctx, { utm_campaign: 'autumn' });
    expect(variant(none, 'A')).toMatchObject({ started: 0, completion: null, ctr: null, startToCta: null, backRate: null, invariantOk: true });
    expect(none.selected?.abTest).toBeNull();
    // Dropdown lists do not depend on the filter.
    expect(none.availableCampaigns).toEqual(['spring', 'summer']);
    for (const r of [spring, summer, none]) for (const v of ['A', 'B'] as const) expectInvariant(variant(r, v));
  });

  it('excludes override sessions by default and includes them on request', async () => {
    const ctx = await buildFixture();
    const withOverrides = await report(ctx, { include_overrides: 'true' });
    const a = variant(withOverrides, 'A');
    expect(a).toMatchObject({ started: 8, reachedResult: 3, ctaClicked: 2, serverCompleted: 3 });
    expect(a.resultMix).toEqual({ async_native: 1, balanced: 1, office_core: 1 });
    expectInvariant(a);
    // SRM ignores non-randomized sessions even when they are shown.
    expect(withOverrides.selected?.abTest?.srm?.observed).toEqual({ A: 7, B: 5 });
    expect(withOverrides.selected?.abTest?.a.sessions).toBe(7); // 8 started, one still in progress
  });

  it('duplicates and repeat views do not change any distinct-session number', async () => {
    const ctx = await buildFixture();
    const base = await report(ctx);

    // Same event_id again (client retry after timeout): the table ignores it, the report is identical.
    scenarioEvents().forEach((e, i) => insertEvent(ctx, e, { serverTs: T0 + e.t + 5 * SEC, clientTs: T0 + e.t, seq: i + 1 }));
    expect(await report(ctx)).toEqual(base);

    // Repeat views / re-answers / repeated result screens get NEW event ids: raw rows grow, sessions don't.
    const repeats: EventSpec[] = [
      { id: 'r1', session: 'a1', name: 'step_viewed', step: 'intro', props: {}, t: 3 * MIN },
      { id: 'r2', session: 'a1', name: 'result_viewed', step: 'result', props: { result_id: 'async_native' }, t: 4 * MIN },
      { id: 'r3', session: 'a1', name: 'cta_clicked', step: 'result', props: { result_id: 'async_native', action: 'primary' }, t: 4 * MIN },
      { id: 'r4', session: 'a3', name: 'step_viewed', step: 'team_size', props: {}, t: 2 * MIN },
      { id: 'r5', session: 'a3', name: 'answer_submitted', step: 'team_size', props: {}, t: 2 * MIN },
      { id: 'r6', session: 'b3', name: 'step_viewed', step: 'intro', props: {}, t: 2 * MIN },
      { id: 'r7', session: 'a4', name: 'back_clicked', step: 'work_mode', props: {}, t: 3 * MIN },
    ];
    repeats.forEach((e) => insertEvent(ctx, e, { serverTs: T0 + e.t, clientTs: T0 + e.t, seq: 99 }));
    const after = await report(ctx);
    expect(after.selected).toEqual(base.selected);
    expect(after.versions).toEqual(base.versions);
    expect(after.ingestion.rawEvents).toBe(base.ingestion.rawEvents + repeats.length);
  });

  it('in_progress_minutes=0 turns every unfinished session into a drop-off; the invariant still holds', async () => {
    const ctx = await buildFixture();
    const live = variant(await report(ctx), 'A');
    const off = variant(await report(ctx, { in_progress_minutes: '0' }), 'A');
    expect(live.inProgress).toBe(1);
    expect(off.inProgress).toBe(0);
    const drops = (v: VariantReport) => v.steps.reduce((s, r) => s + r.dropoff, 0) + v.beforeFirstStep;
    expect(drops(off)).toBe(drops(live) + 1);
    expect(off.invariantOk).toBe(true);
    expect(off.reachedResult).toBe(live.reachedResult);
  });

  it('the invariant can fail: a session whose session_started never arrived is caught by the sessions-table count', async () => {
    const ctx = await buildFixture();
    const before = variant(await report(ctx), 'A');
    expect(before.sessionsInTable).toBe(before.started);
    ctx.db.prepare("DELETE FROM events WHERE session_id = ? AND name = 'session_started'").run(ctx.sessionIds.get('a1'));
    const after = variant(await report(ctx), 'A');
    expect(after.started).toBe(before.started - 1);
    expect(after.sessionsInTable).toBe(before.started);
    expect(after.invariantOk).toBe(false);
  });

  it('is invariant to arrival order, seq and clocks (3 seeded shuffles into fresh DBs)', async () => {
    const reference = await report(await buildFixture());
    for (const seed of [1, 42, 20260918]) {
      const shuffled = await report(await buildFixture(seed));
      expect(shuffled).toEqual(reference);
    }
  });

  it('reports ingestion quality from ingest_log (empty and filled)', async () => {
    const ctx = await buildFixture();
    const empty = await report(ctx);
    // 13 session_started (12 hash + 1 override excluded by the default filter → 12) + client events of hash sessions.
    const clientEvents = scenarioEvents().filter((e) => e.session !== 'a7').length;
    expect(empty.ingestion).toEqual({ rawEvents: 12 + clientEvents, accepted: 0, duplicates: 0, rejected: 0, rejectedReasons: {} });

    const log = ctx.db.prepare('INSERT INTO ingest_log (received_at, accepted, duplicates, rejected, reasons) VALUES (?, ?, ?, ?, ?)');
    log.run(T0, 10, 2, 3, JSON.stringify({ unknown_event: 2, invalid_payload: 1 }));
    log.run(T0, 5, 0, 1, JSON.stringify({ unknown_event: 1 }));
    log.run(T0, 1, 0, 0, '{}');
    const filled = await report(ctx);
    expect(filled.ingestion).toEqual({
      rawEvents: 12 + clientEvents,
      accepted: 16,
      duplicates: 2,
      rejected: 4,
      rejectedReasons: { unknown_event: 3, invalid_payload: 1 },
    });
  });

  it('v3: variant B has no tool_count, extra events show up under otherEvents, versions are compared', async () => {
    const ctx = await makeClockedApp();
    await uploadAndPublish(ctx.app, 1);
    await createSession(ctx, { key: 'v1a', variant: 'A', campaign: null });
    await uploadAndPublish(ctx.app, 3);
    await createSession(ctx, { key: 'v3a', variant: 'A', campaign: null });
    await createSession(ctx, { key: 'v3b', variant: 'B', campaign: null });
    const events = [
      new Script('v1a').view('intro'),
      new Script('v3a').view('intro').done('team_size'),
      new Script('v3b')
        .view('intro')
        .done('work_mode', 'meeting_hours', 'timezone_span', 'team_size', 'async_maturity', 'priorities')
        .result('balanced', { cta: true })
        .emit('recommendation_expanded', 'result', { result_id: 'balanced', action: 'expand', source: 'result' })
        .emit('recommendation_expanded', 'result', { result_id: 'balanced', action: 'expand', source: 'result' }),
    ].flatMap((s) => s.events);
    events.forEach((e, i) => insertEvent(ctx, e, { serverTs: T0 + e.t, clientTs: T0 + e.t, seq: i }));
    ctx.clock.now = REPORT_NOW;

    const r = await report(ctx);
    expect(r.availableVersions).toEqual([1, 3]);
    expect(r.selected?.version).toBe(3); // default = active version
    expect(r.versions.map((v) => [v.version, v.started, v.reachedResult])).toEqual([
      [1, 1, 0],
      [3, 2, 1],
    ]);
    const b = variant(r, 'B');
    expect(b.steps.map((s) => s.stepId)).not.toContain('tool_count');
    expect(b.steps.map((s) => s.stepId)).toEqual([
      'intro', 'work_mode', 'meeting_hours', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'security_constraints', 'office_days', 'result',
    ]);
    // Neither conditional step was shown (remote user without compliance priority) — not a loss.
    expect(b.steps.filter((s) => s.conditional).map((s) => [s.stepId, s.viewed, s.dropoff])).toEqual([
      ['security_constraints', 0, 0],
      ['office_days', 0, 0],
    ]);
    expect(b).toMatchObject({ started: 1, reachedResult: 1, ctaClicked: 1 });
    expect(variant(r, 'A').steps.map((s) => s.stepId)).toContain('tool_count');
    expect(r.selected?.otherEvents).toEqual([{ name: 'recommendation_expanded', sessions: 1, byVariant: { B: 1 } }]);

    const v1 = await report(ctx, { version: '1' });
    expect(v1.selected?.version).toBe(1);
    expect(v1.selected?.otherEvents).toEqual([]);
    expect(variant(v1, 'A')).toMatchObject({ started: 1, beforeFirstStep: 0 });
    expect(dropoffs(variant(v1, 'A'))).toEqual({ intro: 1 });
  });

  it('validates the query and answers 404 for unknown funnels/versions', async () => {
    const ctx = await buildFixture();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/analytics', headers: ADMIN })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/analytics?funnelId=${FUNNEL}&include_overrides=yes`, headers: ADMIN })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/analytics?funnelId=${FUNNEL}&version=abc`, headers: ADMIN })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/analytics?funnelId=${FUNNEL}&version=9`, headers: ADMIN })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/analytics?funnelId=nope', headers: ADMIN })).statusCode).toBe(404);
  });
});
