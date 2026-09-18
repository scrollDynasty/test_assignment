import {
  CORE_EVENTS,
  isInteractive,
  resolveVariant,
  type AbTest,
  type AnalyticsFilters,
  type AnalyticsReport,
  type FunnelConfig,
  type IngestionQuality,
  type OtherEventRow,
  type RateWithCi,
  type ResolvedFunnel,
  type SelectedReport,
  type StepRow,
  type StepType,
  type SummaryMetrics,
  type VariantReport,
  type VersionRow,
} from '@funnel/shared';
import type { Db } from '../db.js';
import { notFound } from '../errors.js';
import { mde, newcombeDiff, ratio, srmChiSquare, twoProportionZTest, wilson } from './stats.js';
import type { VersionsService } from './versions.js';

/*
 * Funnel analytics over UNIQUE SESSIONS (TZ §5). Metric definitions — all counts are DISTINCT sessions:
 *
 *  Population   sessions that have a `session_started` event matching the filter (funnel, version,
 *               utm_campaign, and assignment = 'hash' unless overrides are included). `session_started`
 *               is written by the server atomically with the session, so it is never lost.
 *  started      population size.
 *  viewed(s)    sessions with step_viewed OR answer_submitted OR step_completed for step s. A later event
 *               of the same step proves the view even if step_viewed itself was lost. For the result-type
 *               step, reaching the result (below) also counts as having viewed it.
 *  passed(s)    interactive step: has step_completed for s. Info step: viewed any step placed later in
 *               the session's variant sequence, or reached the result. Result step: not applicable (null).
 *  reachedResult  sessions with result_viewed OR cta_clicked (a CTA click proves the result was shown,
 *               so CTR can never exceed 100% because of a lost result_viewed).
 *  furthest step  the viewed step with the maximum position in the session's own variant sequence
 *               (sequence of its pinned version + variant). Arrival order, seq and client/server clocks
 *               are never used, so the result is independent of event order by construction. Going back
 *               does not move it backwards: the furthest step ever seen is where the user stopped.
 *  inProgress   not reachedResult AND session not expired (expires_at > now) AND the session's last event
 *               arrived within the in-progress window (default 30 min, a report parameter; 0 turns it off).
 *  dropoff(s)   not reachedResult, not inProgress, and furthest step = s. Sessions with no viewed step go
 *               to `beforeFirstStep`. Every session lands in exactly one bucket, so
 *               Σ dropoff + beforeFirstStep + reachedResult + inProgress = started. `invariantOk` also requires
 *               started (from events) = sessions of the same filter counted in the sessions table, which is
 *               independent of the event pipeline and fails if a session_started is lost or duplicated.
 *  ctaClicked   sessions with cta_clicked. ctr = ctaClicked / reachedResult; startToCta = ctaClicked /
 *               started (primary A/B metric); completion = reachedResult / started.
 *  backRate     sessions with back_clicked / started.
 *  resultMix    per session one result_id: the one the server computed (sessions.result_id); for sessions
 *               without it, the latest result_id of result_viewed / cta_clicked by client seq.
 *  serverCompleted  sessions of the population with sessions.status = 'completed' (the server computed a
 *               result) — a cross-check for reachedResult, which comes from client events.
 *  stepConversion   passed(s) / viewed(s): of the sessions that saw the step, the share that got past it.
 *               Robust to conditional steps (a hidden office_days is simply not viewed, not a loss).
 *  reach        viewed(s) / started.
 *  otherEvents  event names outside CORE_EVENTS (e.g. v3 recommendation_expanded): distinct sessions.
 * Rates with a zero denominator are null.
 */

/** Default "in progress" window in minutes; the report accepts another one (0 = every unfinished session is a drop-off). */
export const DEFAULT_IN_PROGRESS_MINUTES = 30;

/** Report clock: "now" and the in-progress window. */
interface Clock {
  now: number;
  windowMs: number;
}
const STEP_EVENTS = ['step_viewed', 'answer_submitted', 'step_completed'] as const;
const RESULT_EVENTS = ['result_viewed', 'cta_clicked'] as const;
const UNKNOWN_RESULT = 'unknown';

/** Everything the report needs to know about one session, extracted once. */
interface SessionFacts {
  id: string;
  version: number;
  variant: string;
  assignment: string;
  completedOnServer: boolean;
  expiresAt: number;
  lastTs: number;
  reached: boolean;
  cta: boolean;
  back: boolean;
  /** Steps with any step-level event. */
  viewed: Set<string>;
  /** Steps with step_completed. */
  completed: Set<string>;
  resultId: string | null;
  /** Result computed and stored by the server (sessions.result_id): the source of truth for the result mix. */
  serverResultId: string | null;
}

interface PopulationRow {
  id: string;
  version: number;
  variant: string;
  assignment: string;
  status: string;
  serverResultId: string | null;
  expiresAt: number;
  lastTs: number;
  back: number;
  reached: number;
  cta: number;
}

type Params = Record<string, string | number>;

const sqlList = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly versions: VersionsService,
    private readonly now: () => number = Date.now,
  ) {}

  report(filters: AnalyticsFilters): AnalyticsReport {
    const now = this.now();
    const clock: Clock = { now, windowMs: (filters.inProgressMinutes ?? DEFAULT_IN_PROGRESS_MINUTES) * 60 * 1000 };
    const versionRows = this.db
      .prepare('SELECT version, experiment_id AS experimentId FROM funnel_versions WHERE funnel_id = ? ORDER BY version')
      .all(filters.funnelId) as { version: number; experimentId: string }[];
    if (versionRows.length === 0) throw notFound(`Funnel ${filters.funnelId}`);
    const selectedVersion = filters.version ?? this.versions.activeVersion(filters.funnelId);
    if (selectedVersion !== null && !versionRows.some((v) => v.version === selectedVersion)) {
      throw notFound(`Version ${selectedVersion} of ${filters.funnelId}`);
    }

    const { where, params } = this.eventFilter(filters);
    const facts = this.loadFacts(where, params);

    const versions: VersionRow[] = versionRows.map((v) => ({
      version: v.version,
      experimentId: v.experimentId,
      ...summarize(facts.filter((f) => f.version === v.version), clock),
    }));

    let selected: SelectedReport | null = null;
    if (selectedVersion !== null) {
      const config = this.versions.getConfig(filters.funnelId, selectedVersion);
      const inTable = this.sessionCounts(filters, selectedVersion);
      selected = this.selectedReport(config, facts.filter((f) => f.version === selectedVersion), where, params, clock, inTable);
    }

    return {
      generatedAt: new Date(now).toISOString(),
      filters: {
        funnelId: filters.funnelId,
        version: selectedVersion,
        utmCampaign: filters.utmCampaign ?? null,
        includeOverrides: filters.includeOverrides,
        inProgressMinutes: filters.inProgressMinutes ?? DEFAULT_IN_PROGRESS_MINUTES,
      },
      availableVersions: versionRows.map((v) => v.version),
      availableCampaigns: (
        this.db
          .prepare('SELECT DISTINCT utm_campaign AS c FROM sessions WHERE funnel_id = ? AND utm_campaign IS NOT NULL ORDER BY utm_campaign')
          .all(filters.funnelId) as { c: string }[]
      ).map((r) => r.c),
      versions,
      selected,
      ingestion: this.ingestion(where, params, selectedVersion),
    };
  }

  /** WHERE fragment over `e` (an events alias). Version/variant/assignment/UTM are the session's stamped values. */
  private eventFilter(filters: AnalyticsFilters): { where: string; params: Params } {
    const clauses = ['e.funnel_id = @funnelId'];
    const params: Params = { funnelId: filters.funnelId };
    if (filters.utmCampaign !== undefined) {
      clauses.push('e.utm_campaign = @utmCampaign');
      params.utmCampaign = filters.utmCampaign;
    }
    if (!filters.includeOverrides) clauses.push(`e.assignment = 'hash'`);
    return { where: clauses.join(' AND '), params };
  }

  /** Sessions per variant straight from the sessions table (no events involved): the cross-check for `started`. */
  private sessionCounts(filters: AnalyticsFilters, version: number): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT variant, COUNT(*) AS n FROM sessions
         WHERE funnel_id = @funnelId AND funnel_version = @version
           AND (@utmCampaign IS NULL OR utm_campaign = @utmCampaign)
           AND (@includeOverrides = 1 OR assignment = 'hash')
         GROUP BY variant`,
      )
      .all({
        funnelId: filters.funnelId,
        version,
        utmCampaign: filters.utmCampaign ?? null,
        includeOverrides: filters.includeOverrides ? 1 : 0,
      }) as { variant: string; n: number }[];
    return new Map(rows.map((r) => [r.variant, r.n]));
  }

  /** Set extraction in SQL (grouped per session); all per-session logic stays in TypeScript. */
  private loadFacts(where: string, params: Params): SessionFacts[] {
    const pop = `pop AS (
      SELECT e.session_id, e.funnel_version, e.variant, e.assignment FROM events e
      WHERE e.name = 'session_started' AND ${where} GROUP BY e.session_id)`;

    const rows = this.db
      .prepare(
        `WITH ${pop}
         SELECT pop.session_id AS id, pop.funnel_version AS version, pop.variant AS variant, pop.assignment AS assignment,
           s.status AS status, s.result_id AS serverResultId, s.expires_at AS expiresAt,
           MAX(ev.server_ts) AS lastTs,
           MAX(ev.name = 'back_clicked') AS back,
           MAX(ev.name IN (${sqlList(RESULT_EVENTS)})) AS reached,
           MAX(ev.name = 'cta_clicked') AS cta
         FROM pop
         JOIN sessions s ON s.id = pop.session_id
         JOIN events ev ON ev.session_id = pop.session_id
         GROUP BY pop.session_id
         ORDER BY pop.session_id`,
      )
      .all(params) as PopulationRow[];

    const facts = new Map<string, SessionFacts>();
    for (const r of rows) {
      facts.set(r.id, {
        id: r.id,
        version: r.version,
        variant: r.variant,
        assignment: r.assignment,
        completedOnServer: r.status === 'completed',
        expiresAt: r.expiresAt,
        lastTs: r.lastTs,
        reached: r.reached === 1,
        cta: r.cta === 1,
        back: r.back === 1,
        viewed: new Set(),
        completed: new Set(),
        resultId: null,
        serverResultId: r.serverResultId,
      });
    }

    const stepRows = this.db
      .prepare(
        `WITH ${pop}
         SELECT ev.session_id AS id, ev.step_id AS stepId, MAX(ev.name = 'step_completed') AS completed
         FROM events ev JOIN pop ON pop.session_id = ev.session_id
         WHERE ev.name IN (${sqlList(STEP_EVENTS)}) AND ev.step_id IS NOT NULL
         GROUP BY ev.session_id, ev.step_id`,
      )
      .all(params) as { id: string; stepId: string; completed: number }[];
    for (const r of stepRows) {
      const f = facts.get(r.id);
      if (!f) continue;
      f.viewed.add(r.stepId);
      if (r.completed === 1) f.completed.add(r.stepId);
    }

    // Latest result per session: ordered ascending, so the last row seen per session wins. The user's own
    // order (client seq) comes first: events of one batch share server_ts, so server time cannot order them.
    const resultRows = this.db
      .prepare(
        `WITH ${pop}
         SELECT ev.session_id AS id, json_extract(ev.properties_json, '$.result_id') AS resultId
         FROM events ev JOIN pop ON pop.session_id = ev.session_id
         WHERE ev.name IN (${sqlList(RESULT_EVENTS)})
         ORDER BY ev.session_id, COALESCE(ev.seq, -1), ev.client_ts, ev.server_ts, ev.event_id`,
      )
      .all(params) as { id: string; resultId: string | number | null }[];
    for (const r of resultRows) {
      const f = facts.get(r.id);
      if (f && r.resultId !== null) f.resultId = String(r.resultId);
    }

    return [...facts.values()];
  }

  private selectedReport(
    config: FunnelConfig,
    facts: SessionFacts[],
    where: string,
    params: Params,
    clock: Clock,
    inTable: Map<string, number>,
  ): SelectedReport {
    const variantIds = Object.keys(config.experiment.variants).sort();
    const variants: Record<string, VariantReport> = {};
    for (const variant of variantIds) {
      const report = variantReport(resolveVariant(config, variant), facts.filter((f) => f.variant === variant), clock);
      const sessionsInTable = inTable.get(variant) ?? 0;
      variants[variant] = { ...report, sessionsInTable, invariantOk: report.invariantOk && report.started === sessionsInTable };
    }

    const otherRows = this.db
      .prepare(
        `SELECT e.name AS name, e.variant AS variant, COUNT(DISTINCT e.session_id) AS sessions
         FROM events e
         WHERE ${where} AND e.funnel_version = @version AND e.name NOT IN (${sqlList(CORE_EVENTS)})
           AND e.session_id IN (SELECT e.session_id FROM events e WHERE e.name = 'session_started' AND ${where})
         GROUP BY e.name, e.variant
         ORDER BY e.name, e.variant`,
      )
      .all({ ...params, version: config.version }) as { name: string; variant: string; sessions: number }[];
    const other = new Map<string, OtherEventRow>();
    for (const r of otherRows) {
      const row = other.get(r.name) ?? { name: r.name, sessions: 0, byVariant: {} };
      row.sessions += r.sessions; // a session belongs to exactly one variant, so per-variant counts add up
      row.byVariant[r.variant] = r.sessions;
      other.set(r.name, row);
    }

    return {
      version: config.version,
      experimentId: config.experiment.id,
      variants,
      abTest: abTest(config, facts, clock),
      otherEvents: [...other.values()],
    };
  }

  private ingestion(where: string, params: Params, version: number | null): IngestionQuality {
    const raw =
      version === null
        ? 0
        : (this.db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${where} AND e.funnel_version = @version`).get({ ...params, version }) as {
            n: number;
          }).n;
    const totals = this.db
      .prepare('SELECT COALESCE(SUM(accepted), 0) AS accepted, COALESCE(SUM(duplicates), 0) AS duplicates, COALESCE(SUM(rejected), 0) AS rejected FROM ingest_log')
      .get() as { accepted: number; duplicates: number; rejected: number };
    // Aggregated in SQL: the log grows with every batch, it must not be loaded into memory per request.
    const rejectedReasons: Record<string, number> = {};
    const reasonRows = this.db
      .prepare(
        `SELECT r.key AS reason, SUM(r.value) AS n
         FROM ingest_log l, json_each(CASE WHEN json_valid(l.reasons) THEN l.reasons ELSE '{}' END) r
         WHERE r.type IN ('integer', 'real')
         GROUP BY r.key ORDER BY r.key`,
      )
      .all() as { reason: string; n: number }[];
    for (const { reason, n } of reasonRows) rejectedReasons[reason] = n;
    return { rawEvents: raw, ...totals, rejectedReasons };
  }
}

function isInProgress(f: SessionFacts, { now, windowMs }: Clock): boolean {
  return !f.reached && f.expiresAt > now && f.lastTs > now - windowMs;
}

function summarize(facts: SessionFacts[], clock: Clock): SummaryMetrics {
  const started = facts.length;
  let reachedResult = 0;
  let ctaClicked = 0;
  let inProgress = 0;
  let serverCompleted = 0;
  for (const f of facts) {
    if (f.reached) reachedResult++;
    if (f.cta) ctaClicked++;
    if (isInProgress(f, clock)) inProgress++;
    if (f.completedOnServer) serverCompleted++;
  }
  return {
    started,
    reachedResult,
    ctaClicked,
    inProgress,
    completion: ratio(reachedResult, started),
    ctr: ratio(ctaClicked, reachedResult),
    startToCta: ratio(ctaClicked, started),
    serverCompleted,
  };
}

/** Everything except the sessions-table cross-check, which the caller adds. */
function variantReport(funnel: ResolvedFunnel, facts: SessionFacts[], clock: Clock): Omit<VariantReport, 'sessionsInTable'> {
  const summary = summarize(facts, clock);
  const position = new Map(funnel.sequence.map((id, i) => [id, i] as const));
  const resultStepIds = funnel.sequence.filter((id) => funnel.steps[id]?.type === 'result');

  const viewed = new Map<string, number>(funnel.sequence.map((id) => [id, 0]));
  const passed = new Map<string, number>(funnel.sequence.map((id) => [id, 0]));
  const dropoff = new Map<string, number>(funnel.sequence.map((id) => [id, 0]));
  const resultMix: Record<string, number> = {};
  let beforeFirstStep = 0;
  let back = 0;

  for (const f of facts) {
    if (f.back) back++;
    // Steps of this session's sequence it has seen (unknown step ids are ignored).
    const seen = new Set([...f.viewed].filter((id) => position.has(id)));
    if (f.reached) for (const id of resultStepIds) seen.add(id);

    let furthest = -1;
    for (const id of seen) furthest = Math.max(furthest, position.get(id) ?? -1);

    for (const id of seen) {
      viewed.set(id, (viewed.get(id) ?? 0) + 1);
      const step = funnel.steps[id];
      const pos = position.get(id) ?? -1;
      const isPassed = step === undefined ? false : isInteractive(step) ? f.completed.has(id) : step.type === 'info' ? f.reached || furthest > pos : false;
      if (isPassed) passed.set(id, (passed.get(id) ?? 0) + 1);
    }

    if (f.reached) {
      const key = f.serverResultId ?? f.resultId ?? UNKNOWN_RESULT;
      resultMix[key] = (resultMix[key] ?? 0) + 1;
    } else if (!isInProgress(f, clock)) {
      const stepId = furthest >= 0 ? funnel.sequence[furthest] : undefined;
      if (stepId === undefined) beforeFirstStep++;
      else dropoff.set(stepId, (dropoff.get(stepId) ?? 0) + 1);
    }
  }

  const steps: StepRow[] = funnel.sequence.map((id, i) => {
    const step = funnel.steps[id];
    const type: StepType = step?.type ?? 'info';
    const v = viewed.get(id) ?? 0;
    const p = type === 'result' ? null : (passed.get(id) ?? 0);
    return {
      stepId: id,
      type,
      conditional: step?.visibleWhen !== undefined,
      position: i,
      viewed: v,
      passed: p,
      stepConversion: p === null ? null : ratio(p, v),
      reach: ratio(v, summary.started),
      dropoff: dropoff.get(id) ?? 0,
    };
  });

  const dropped = steps.reduce((s, r) => s + r.dropoff, 0) + beforeFirstStep;
  return {
    ...summary,
    backRate: ratio(back, summary.started),
    steps,
    beforeFirstStep,
    invariantOk: dropped + summary.reachedResult + summary.inProgress === summary.started,
    resultMix: sortKeys(resultMix),
  };
}

function sortKeys(obj: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A/B test on startToCta. Arms: variants "A" and "B" when present, otherwise the two variants of a
 * two-arm experiment in key order. null if the experiment is not two-armed or an arm has no sessions.
 * SRM is always computed on hash-assigned sessions only: overrides are not randomized, so including
 * them would flag a mismatch that is not a bug in assignment.
 */
/**
 * Sessions still in progress have not had the chance to convert yet; counting them as non-converters would bias
 * early snapshots (a shorter variant finishes sooner and "wins" mechanically). The A/B test uses finished sessions only.
 */
function abTest(config: FunnelConfig, allFacts: SessionFacts[], clock: Clock): AbTest | null {
  const facts = allFacts.filter((f) => !isInProgress(f, clock));
  const keys = Object.keys(config.experiment.variants).sort();
  const [aKey, bKey] = keys.includes('A') && keys.includes('B') ? ['A', 'B'] : keys.length === 2 ? [keys[0], keys[1]] : [undefined, undefined];
  if (aKey === undefined || bKey === undefined) return null;

  const arm = (variant: string): RateWithCi => {
    const own = facts.filter((f) => f.variant === variant);
    const conversions = own.filter((f) => f.cta).length;
    return { variant, sessions: own.length, conversions, rate: ratio(conversions, own.length), ci: wilson(conversions, own.length) };
  };
  const a = arm(aKey);
  const b = arm(bKey);
  if (a.sessions === 0 || b.sessions === 0 || a.rate === null || b.rate === null) return null;

  const test = twoProportionZTest(a.conversions, a.sessions, b.conversions, b.sessions);
  const pValue = test?.pValue ?? 1;
  const pooled = (a.conversions + b.conversions) / (a.sessions + b.sessions);

  const wA = config.experiment.variants[aKey]?.weight ?? 0;
  const wB = config.experiment.variants[bKey]?.weight ?? 0;
  const hashA = allFacts.filter((f) => f.variant === aKey && f.assignment === 'hash').length;
  const hashB = allFacts.filter((f) => f.variant === bKey && f.assignment === 'hash').length;
  const srmTest = srmChiSquare([hashA, hashB], [wA, wB]);

  return {
    metric: 'startToCta',
    a,
    b,
    diff: b.rate - a.rate,
    diffCi: newcombeDiff(a.conversions, a.sessions, b.conversions, b.sessions),
    pValue,
    significant: pValue < 0.05,
    mde: mde(pooled, a.sessions, b.sessions),
    srm: srmTest && {
      pValue: srmTest.pValue,
      chi2: srmTest.chi2,
      observed: { [aKey]: hashA, [bKey]: hashB },
      expectedShare: { [aKey]: wA / (wA + wB), [bKey]: wB / (wA + wB) },
      ok: srmTest.pValue >= 0.001,
    },
  };
}
