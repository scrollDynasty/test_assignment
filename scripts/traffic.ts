/**
 * Synthetic traffic generator (TZ §6).
 *
 *   npm run traffic -- --sessions 150 --seed 42 --url http://localhost:3000 --verify
 *
 * Drives the PUBLIC API exactly like browsers do (create session → events in batches → save state → result),
 * so ingestion, de-duplication and aggregation are exercised end to end. Steps, options and number ranges
 * come from the config each session receives, so the same script works for v1, v2 and v3.
 *
 * Covered on purpose: several UTM campaigns, natural A/B assignment, every branch (remote hides office_days,
 * compliance opens security_constraints in v3), drop-off at different steps, back navigation with changed
 * answers, repeated views, whole batches re-sent (retry after timeout), shuffled events inside a batch,
 * batches delivered out of order, malformed events, a lost result_viewed, bounces before the first screen.
 *
 * The generator keeps its own ground truth (what it actually delivered) and, with --verify, compares it with
 * GET /api/analytics (delta before/after the run, in-progress window off). Exit code 1 on any mismatch.
 * Run --verify against a quiet instance: other traffic during the run would change the deltas.
 */
import { randomUUID } from 'node:crypto';
import {
  answerKind,
  computeProgress,
  isInteractive,
  nextStepId,
  type AnalyticsReport,
  type AnswerValue,
  type Answers,
  type IncomingEvent,
  type ResolvedFunnel,
  type SessionDto,
  type Step,
} from '../packages/shared/src/index.js';

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const SESSIONS = Number(opt('sessions', '150'));
const SEED = Number(opt('seed', '42'));
const API = opt('url', process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const FUNNEL = opt('funnel', 'workstyle-planner');
const VERIFY = args.includes('--verify');
// One worker by default: the behaviour model then consumes the seeded RNG in a fixed order (reproducible runs).
const CONCURRENCY = Number(opt('concurrency', '1'));
const RUN_ID = `trafficgen-${SEED}-${Date.now().toString(36)}`;

// ---------------------------------------------------------------- deterministic randomness
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const chance = (p: number) => rand() < p;
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ---------------------------------------------------------------- traffic model
const CAMPAIGNS = [
  { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'spring_search', weight: 4 },
  { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'team_leads', weight: 3 },
  { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'april_digest', weight: 2 },
  { utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'ops_managers', weight: 2 },
] as const;
type Campaign = (typeof CAMPAIGNS)[number];
function pickCampaign(): Campaign {
  let r = rand() * CAMPAIGNS.reduce((s, c) => s + c.weight, 0);
  for (const c of CAMPAIGNS) if ((r -= c.weight) < 0) return c;
  return CAMPAIGNS[0];
}

const P = {
  bounce: 0.04, // leaves before the first screen renders
  dropPerStep: { A: 0.07, B: 0.05 } as Record<string, number>, // B is built to be a bit easier to finish
  dropNumberExtra: 0.04, // numeric input is more effort
  back: 0.14, // uses Back once somewhere in the middle
  changeAnswerOnBack: 0.5,
  repeatView: 0.1, // re-renders the same step (e.g. focus/refresh) -> duplicate step_viewed with a new id
  lostResultView: 0.06, // result_viewed never arrives
  cta: { A: 0.42, B: 0.55 } as Record<string, number>,
  resendBatch: 0.2, // retry of a whole batch after a (simulated) timeout
  shuffleBatch: 0.2, // events inside a batch out of order
  swapBatches: 0.15, // two batches delivered in reverse order
  malformed: 0.08, // a broken event inside a batch
};

// ---------------------------------------------------------------- HTTP
async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------- ground truth
interface Truth {
  version: number;
  variant: string;
  campaign: string;
  viewed: Set<string>;
  reached: boolean;
  cta: boolean;
  back: boolean;
}
const truths: Truth[] = [];
/** Resolved funnel per "version/variant", taken from the generated sessions (used for expected drop-offs). */
const funnels = new Map<string, ResolvedFunnel>();
const stats = { sessions: 0, events: 0, batches: 0, resentBatches: 0, shuffledBatches: 0, swappedBatches: 0, malformed: 0, repeatViews: 0, backs: 0, lostResultViews: 0, bounces: 0 };
const ingest = { accepted: 0, duplicates: 0, rejected: 0 };

function randomAnswer(step: Step): AnswerValue | undefined {
  if (!isInteractive(step)) return undefined;
  if (step.type === 'number') {
    const min = step.input.min ?? 0;
    const max = step.input.max ?? min + 20;
    // Skewed to realistic small values, with a tail (meeting_hours >= 15 happens regularly).
    const span = Math.min(max - min, step.input.name === 'meeting_hours' ? 30 : 25);
    return min + Math.floor(rand() ** 1.6 * span);
  }
  const values = step.input.options.map((o) => o.value);
  if (step.type === 'single-select') return pick(values);
  const min = Math.max(1, step.validation?.minSelections ?? 1);
  const max = Math.min(values.length, step.validation?.maxSelections ?? values.length);
  return shuffle(values).slice(0, between(min, max));
}

async function simulateSession(): Promise<void> {
  const campaign = pickCampaign();
  const utm = { utm_source: campaign.utm_source, utm_medium: campaign.utm_medium, utm_campaign: campaign.utm_campaign, utm_content: RUN_ID };
  const session = await http<SessionDto>('POST', '/api/sessions', { funnelId: FUNNEL, utm });
  const funnel: ResolvedFunnel = session.funnel;
  funnels.set(`${session.version}/${session.variant}`, funnel);
  const truth: Truth = { version: session.version, variant: session.variant, campaign: campaign.utm_campaign, viewed: new Set(), reached: false, cta: false, back: false };
  truths.push(truth);
  stats.sessions++;
  if (chance(P.bounce)) {
    stats.bounces++;
    return;
  }

  // Simulated user time: sessions spread over the last 6 days, 5-40 s between actions.
  let t = Date.now() - between(10 * 60_000, 6 * 24 * 3600_000);
  let seq = 0;
  const events: IncomingEvent[] = [];
  const emit = (name: string, stepId: string | null, properties: Record<string, unknown> = {}) => {
    t += between(5_000, 40_000);
    events.push({
      event_id: randomUUID(), session_id: session.sessionId, name, client_timestamp: new Date(t).toISOString(),
      funnel_id: funnel.funnelId, funnel_version: session.version, experiment_id: session.experimentId, variant: session.variant,
      step_id: stepId, utm_source: utm.utm_source, utm_medium: utm.utm_medium, utm_campaign: utm.utm_campaign, seq: ++seq, properties,
    });
  };
  const view = (stepId: string, answers: Answers) => {
    const step = funnel.steps[stepId];
    const progress = computeProgress(funnel, answers, stepId);
    emit('step_viewed', stepId, { step_type: step?.type, visible_step_index: progress.index, visible_step_count: progress.count });
    truth.viewed.add(stepId);
  };

  const answers: Answers = {};
  const history: string[] = [];
  let current = session.state.currentStepId;
  let usedBack = false;
  const dropRate = P.dropPerStep[session.variant] ?? 0.06;

  for (let guard = 0; guard < 60; guard++) {
    const step = funnel.steps[current];
    if (!step || step.type === 'result') break;
    view(current, answers);
    if (chance(P.repeatView)) {
      stats.repeatViews++;
      view(current, answers);
    }
    if (chance(dropRate + (step.type === 'number' ? P.dropNumberExtra : 0))) {
      await deliver(session, events);
      return; // abandoned on this step
    }
    // Back once, from a step in the middle; half of the time the previous answer is changed.
    if (!usedBack && history.length >= 2 && chance(P.back)) {
      usedBack = true;
      truth.back = true;
      stats.backs++;
      const previous = history.pop() as string;
      emit('back_clicked', current, { destination_step_id: previous });
      current = previous;
      const prevStep = funnel.steps[current];
      if (prevStep && isInteractive(prevStep) && chance(P.changeAnswerOnBack)) {
        const value = randomAnswer(prevStep);
        if (value !== undefined) answers[prevStep.input.name] = value;
      }
      continue; // the loop re-views the previous step
    }
    if (isInteractive(step)) {
      const value = answers[step.input.name] ?? randomAnswer(step);
      if (value !== undefined) answers[step.input.name] = value;
    }
    const next = nextStepId(funnel, answers, current);
    if (!next) break;
    if (isInteractive(step)) {
      emit('answer_submitted', current, { answer_kind: answerKind(step) });
      emit('step_completed', current, { next_step_id: next });
    }
    history.push(current);
    current = next;
  }

  // Reached the result step: save state, let the server compute the result, render it.
  await http('PUT', `/api/sessions/${session.sessionId}/state`, { state: { answers, history, currentStepId: current }, rev: session.rev });
  const { resultId, result } = await http<{ resultId: string; result: { cta?: { action: string } } }>('POST', `/api/sessions/${session.sessionId}/result`);
  const resultStep = current;
  if (chance(P.lostResultView)) stats.lostResultViews++;
  else {
    emit('result_viewed', resultStep, { result_id: resultId });
    truth.reached = true;
  }
  if (chance(P.cta[session.variant] ?? 0.5)) {
    emit('cta_clicked', resultStep, { result_id: resultId, action: result.cta?.action ?? 'expand_recommendation' });
    truth.reached = true;
    truth.cta = true;
  }
  await deliver(session, events);
}

/** Sends a session's events like a flaky client: small batches, retries, reordering, garbage. */
async function deliver(session: SessionDto, events: IncomingEvent[]): Promise<void> {
  stats.events += events.length;
  const batches: unknown[][] = [];
  for (let i = 0; i < events.length; ) {
    const size = between(2, 8);
    batches.push(events.slice(i, i + size));
    i += size;
  }
  for (const b of batches) {
    if (chance(P.shuffleBatch)) {
      stats.shuffledBatches++;
      b.splice(0, b.length, ...shuffle(b));
    }
    if (chance(P.malformed)) {
      stats.malformed++;
      b.push({ event_id: randomUUID(), session_id: session.sessionId, name: 'step_viewed' }); // missing required fields
    }
  }
  if (batches.length >= 2 && chance(P.swapBatches)) {
    stats.swappedBatches++;
    const i = between(0, batches.length - 2);
    [batches[i], batches[i + 1]] = [batches[i + 1] as unknown[], batches[i] as unknown[]];
  }
  for (const b of batches) {
    const sends = chance(P.resendBatch) ? 2 : 1;
    if (sends === 2) stats.resentBatches++;
    for (let k = 0; k < sends; k++) {
      const res = await http<{ accepted: number; duplicates: number; rejected: number }>('POST', '/api/events', { events: b });
      stats.batches++;
      ingest.accepted += res.accepted;
      ingest.duplicates += res.duplicates;
      ingest.rejected += res.rejected;
    }
  }
}

// ---------------------------------------------------------------- expected metrics from ground truth
interface Expected {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  beforeFirstStep: number;
  back: number;
  dropoff: Record<string, number>;
  viewed: Record<string, number>;
}

function expectedFor(version: number, variant: string, funnel: ResolvedFunnel): Expected {
  const e: Expected = { started: 0, reachedResult: 0, ctaClicked: 0, beforeFirstStep: 0, back: 0, dropoff: {}, viewed: {} };
  const resultStep = funnel.sequence.find((id) => funnel.steps[id]?.type === 'result');
  for (const t of truths.filter((x) => x.version === version && x.variant === variant)) {
    e.started++;
    if (t.back) e.back++;
    if (t.cta) e.ctaClicked++;
    for (const id of t.viewed) e.viewed[id] = (e.viewed[id] ?? 0) + 1;
    if (t.reached && resultStep) e.viewed[resultStep] = (e.viewed[resultStep] ?? 0) + 1;
    if (t.reached) {
      e.reachedResult++;
      continue;
    }
    // Furthest viewed step in this variant's sequence (the same definition the server uses, computed independently).
    let furthest = -1;
    for (const id of t.viewed) furthest = Math.max(furthest, funnel.sequence.indexOf(id));
    const id = furthest >= 0 ? funnel.sequence[furthest] : undefined;
    if (id === undefined) e.beforeFirstStep++;
    else e.dropoff[id] = (e.dropoff[id] ?? 0) + 1;
  }
  return e;
}

async function report(version: number): Promise<AnalyticsReport> {
  return http<AnalyticsReport>('GET', `/api/analytics?funnelId=${FUNNEL}&version=${version}&in_progress_minutes=0`);
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`Generating ${SESSIONS} sessions against ${API} (seed ${SEED}, run ${RUN_ID})`);
  // Snapshot of the active version before the run: --verify compares deltas, so earlier traffic does not matter.
  const probe = await http<AnalyticsReport>('GET', `/api/analytics?funnelId=${FUNNEL}&in_progress_minutes=0`);
  const activeVersion = probe.filters.version;
  const before = VERIFY && activeVersion !== null ? await report(activeVersion) : null;

  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
      while (next < SESSIONS) {
        next++;
        await simulateSession();
      }
    }),
  );
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.table({ ...stats });
  console.log('Ingestion responses:', ingest);

  const versions = [...new Set(truths.map((t) => t.version))];
  let ok = true;
  for (const version of versions) {
    const after = await report(version);
    const beforeReport = before && before.selected?.version === version ? before : null;
    console.log(`\nVersion v${version} — expected (from generator ground truth) vs dashboard (delta over this run):`);
    const rows: Record<string, Record<string, string | number>> = {};
    for (const [variant, v] of Object.entries(after.selected?.variants ?? {})) {
      const funnel = funnels.get(`${version}/${variant}`);
      if (!funnel) continue;
      const exp = expectedFor(version, variant, funnel);
      const prev = beforeReport?.selected?.variants[variant];
      const delta = (k: 'started' | 'reachedResult' | 'ctaClicked' | 'beforeFirstStep') => v[k] - (prev?.[k] ?? 0);
      const check = (label: string, expected: number, actual: number) => {
        const match = expected === actual;
        if (VERIFY && !match) ok = false;
        rows[`${variant} ${label}`] = { expected, dashboard: VERIFY ? actual : '(run with --verify)', match: VERIFY ? (match ? 'ok' : 'MISMATCH') : '' };
      };
      check('started', exp.started, delta('started'));
      check('reached result', exp.reachedResult, delta('reachedResult'));
      check('CTA clicked', exp.ctaClicked, delta('ctaClicked'));
      check('before first step', exp.beforeFirstStep, delta('beforeFirstStep'));
      const backCount = (r: { backRate: number | null; started: number } | undefined) => Math.round((r?.backRate ?? 0) * (r?.started ?? 0));
      check('sessions with Back', exp.back, backCount(v) - backCount(prev));
      for (const s of v.steps) {
        const prevViewed = prev?.steps.find((p) => p.stepId === s.stepId)?.viewed ?? 0;
        check(`viewed ${s.stepId}`, exp.viewed[s.stepId] ?? 0, s.viewed - prevViewed);
      }
      for (const s of v.steps) {
        const prevDrop = prev?.steps.find((p) => p.stepId === s.stepId)?.dropoff ?? 0;
        const expDrop = exp.dropoff[s.stepId] ?? 0;
        if (expDrop > 0 || s.dropoff - prevDrop > 0) check(`drop-off ${s.stepId}`, expDrop, s.dropoff - prevDrop);
      }
      if (!v.invariantOk) ok = false;
    }
    console.table(rows);
  }
  // Fresh synthetic sessions are all "recently active"; the link turns the in-progress window off so they show as drop-offs.
  console.log(`\nDashboard: ${API.replace(/:3000$/, ':5173')}/analytics?in_progress_minutes=0`);
  if (VERIFY) {
    console.log(ok ? '\nVERIFY OK: dashboard numbers match the generator ground truth.' : '\nVERIFY FAILED');
    process.exit(ok ? 0 : 1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
