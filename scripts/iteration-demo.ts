/**
 * Reproducible "publish a new version, keep old sessions working, roll back" scenario (TZ §2, §8).
 *
 *   npm run demo:iteration -- --config funnel-v2.json [--url http://localhost:3000] [--traffic 150] [--out docs/iteration-1.md]
 *
 * Everything goes through the public/admin HTTP API of a running instance — no redeploy, no DB access:
 *  1. schema fingerprint + analytics snapshot of every version;
 *  2. an "old" session is started on the active version and left half way;
 *  3. the new config is uploaded and published;
 *  4. a new session gets the new version; the old session continues and finishes on its own version;
 *  5. optional synthetic traffic on the new version;
 *  6. a session on the new version is left half way, then the publish is rolled back;
 *  7. that session still finishes on the new version; new sessions are back on the old one;
 *  8. schema fingerprint is unchanged, stored events per version never decreased, all checks listed.
 * Exit code 1 if any check fails. The markdown report is written to --out.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  answerKind,
  isInteractive,
  nextStepId,
  type AnalyticsReport,
  type AnswerValue,
  type Answers,
  type IncomingEvent,
  type SessionDto,
  type Step,
} from '../packages/shared/src/index.js';

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const API = (opt('url', process.env.API_URL ?? 'http://localhost:3000') as string).replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const CONFIG_PATH = opt('config');
const TRAFFIC = Number(opt('traffic', '0'));
const OUT = opt('out');
if (!CONFIG_PATH) {
  console.error('usage: iteration-demo --config <funnel-vN.json> [--url …] [--traffic N] [--out report.md]');
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { funnelId: string; version: number };
const FUNNEL = config.funnelId;

const log: string[] = [];
const checks: { name: string; ok: boolean; detail: string }[] = [];
const say = (line: string) => {
  console.log(line);
  log.push(line);
};
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  say(`${ok ? '✅' : '❌'} ${name} — ${detail}`);
};

async function http<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (admin) headers['x-admin-token'] = TOKEN;
  const res = await fetch(`${API}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

const schemaHash = async () => (await http<{ schemaHash: string }>('GET', '/api/admin/schema', undefined, true)).schemaHash;
const activeVersion = async () => (await http<{ activeVersion: number }>('GET', `/api/admin/funnels/${FUNNEL}/versions`, undefined, true)).activeVersion;
const analytics = (version: number) =>
  http<AnalyticsReport>('GET', `/api/analytics?funnelId=${FUNNEL}&version=${version}&include_overrides=true&in_progress_minutes=0`, undefined, true);

/** A scripted user: deterministic answers, events sent like the browser does. */
class User {
  private seq = 0;
  private events: IncomingEvent[] = [];
  constructor(public session: SessionDto) {}

  get step(): Step | undefined {
    return this.session.funnel.steps[this.session.state.currentStepId];
  }

  private emit(name: string, stepId: string | null, properties: Record<string, unknown> = {}) {
    const s = this.session;
    this.events.push({
      event_id: randomUUID(), session_id: s.sessionId, name, client_timestamp: new Date().toISOString(), funnel_id: s.funnelId,
      funnel_version: s.version, experiment_id: s.experimentId, variant: s.variant, step_id: stepId,
      utm_source: s.utm.utm_source ?? null, utm_medium: s.utm.utm_medium ?? null, utm_campaign: s.utm.utm_campaign ?? null,
      seq: ++this.seq, properties,
    });
  }

  private answerFor(step: Step): AnswerValue | undefined {
    if (!isInteractive(step)) return undefined;
    // 20 where allowed: with meeting_hours this lands in the v2/v3-only result "meeting_heavy", which proves
    // which version's rules computed a result.
    if (step.type === 'number') return Math.max(step.input.min ?? 0, Math.min(step.input.max ?? 20, 20));
    const first = step.input.options[0]?.value ?? '';
    return step.type === 'multi-select' ? [first] : first;
  }

  /** Answers and advances `count` steps (or until the result step), saving state and sending events. */
  async advance(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const step = this.step;
      if (!step || step.type === 'result') break;
      this.emit('step_viewed', step.id, { step_type: step.type });
      const answers: Answers = { ...this.session.state.answers };
      const value = this.answerFor(step);
      if (value !== undefined && isInteractive(step)) answers[step.input.name] = value;
      const next = nextStepId(this.session.funnel, answers, step.id);
      if (!next) break;
      if (isInteractive(step)) {
        this.emit('answer_submitted', step.id, { answer_kind: answerKind(step) });
        this.emit('step_completed', step.id, { next_step_id: next });
      }
      const state = { answers, history: [...this.session.state.history, step.id], currentStepId: next };
      this.session = await http<SessionDto>('PUT', `/api/sessions/${this.session.sessionId}/state`, { state, rev: this.session.rev });
    }
    await this.flush();
  }

  async finish(): Promise<string> {
    await this.advance(100);
    const { resultId, result } = await http<{ resultId: string; result: { cta?: { action: string } } }>('POST', `/api/sessions/${this.session.sessionId}/result`);
    this.emit('result_viewed', this.session.state.currentStepId, { result_id: resultId });
    this.emit('cta_clicked', this.session.state.currentStepId, { result_id: resultId, action: result.cta?.action ?? 'expand_recommendation' });
    // Like the web client: the v3 event only when the session's pinned version declares it.
    if (this.session.funnel.events.allowed.some((e) => e.name === 'recommendation_expanded')) {
      this.emit('recommendation_expanded', this.session.state.currentStepId, { result_id: resultId, action: result.cta?.action ?? 'expand_recommendation', source: 'result_cta' });
    }
    await this.flush();
    return resultId;
  }

  async reload(): Promise<void> {
    this.session = await http<SessionDto>('GET', `/api/sessions/${this.session.sessionId}`);
  }

  private async flush(): Promise<void> {
    if (this.events.length === 0) return;
    const res = await http<{ rejected: number; results: { status: string; reason?: string }[] }>('POST', '/api/events', { events: this.events });
    if (res.rejected > 0) throw new Error(`events rejected: ${JSON.stringify(res.results.filter((r) => r.status === 'rejected'))}`);
    this.events = [];
  }
}

async function newUser(label: string): Promise<User> {
  const s = await http<SessionDto>('POST', '/api/sessions', { funnelId: FUNNEL, utm: { utm_source: 'demo', utm_campaign: 'iteration_demo', utm_content: label } });
  return new User(s);
}

function traffic(sessions: number) {
  if (sessions <= 0) return;
  say(`\n— generating ${sessions} synthetic sessions (npm run traffic) —`);
  const r = spawnSync('npx', ['tsx', 'scripts/traffic.ts', '--url', API, '--sessions', String(sessions), '--seed', String(Date.now() % 100000), '--verify'], {
    encoding: 'utf8',
    shell: true,
  });
  const verified = /VERIFY OK/.test(r.stdout);
  check('synthetic traffic accepted and dashboard matches its ground truth', verified, verified ? `${sessions} sessions, --verify OK` : r.stdout.slice(-400));
}

async function main() {
  say(`# Iteration demo: publish v${config.version} without redeploy, keep old sessions, roll back`);
  say(`Instance: ${API} · ${new Date().toISOString()}\n`);

  const oldVersion = await activeVersion();
  const hashBefore = await schemaHash();
  const versionsBefore = (await analytics(oldVersion)).versions;
  say(`Active version before: v${oldVersion}. Schema fingerprint: ${hashBefore}`);

  // 2. An old session left half way.
  const oldUser = await newUser('old-session');
  await oldUser.advance(3);
  check('old session starts on the active version', oldUser.session.version === oldVersion, `session ${oldUser.session.sessionId.slice(0, 8)} on v${oldUser.session.version}, variant ${oldUser.session.variant}, at "${oldUser.session.state.currentStepId}"`);

  // 3. Publish the new version through the admin API (no redeploy).
  const upload = await http<{ status: string }>('POST', `/api/admin/funnels/${FUNNEL}/versions`, JSON.parse(readFileSync(CONFIG_PATH as string, 'utf8')), true);
  const publish = await http<{ activeVersion: number }>('POST', `/api/admin/funnels/${FUNNEL}/versions/${config.version}/publish`, undefined, true);
  check(`v${config.version} published at runtime`, publish.activeVersion === config.version, `upload: ${upload.status}, active now v${publish.activeVersion}`);
  check('schema unchanged by publish', (await schemaHash()) === hashBefore, 'fingerprint equal');

  // 4. New sessions get the new version; the old one continues on its own version.
  const newUser1 = await newUser('new-after-publish');
  check('new session starts on the new version', newUser1.session.version === config.version, `v${newUser1.session.version}, ${newUser1.session.funnel.sequence.length} steps in variant ${newUser1.session.variant}`);
  await newUser1.finish();
  await oldUser.reload();
  check('old session still pinned after publish', oldUser.session.version === oldVersion, `reloaded: v${oldUser.session.version}, still at "${oldUser.session.state.currentStepId}"`);
  const oldResult = await oldUser.finish();
  check('old session finishes on its own version', oldUser.session.version === oldVersion, `result "${oldResult}" computed with v${oldVersion} rules`);

  // 5. Traffic on the new version.
  traffic(TRAFFIC);

  // 6. A session on the new version left half way, then roll back.
  const midUser = await newUser('new-in-flight');
  await midUser.advance(3);
  const rollback = await http<{ activeVersion: number; rolledBackFrom: number }>('POST', `/api/admin/funnels/${FUNNEL}/rollback`, undefined, true);
  check('rollback restores the previous version for new sessions', rollback.activeVersion === oldVersion, `v${rollback.rolledBackFrom} → v${rollback.activeVersion}`);

  // 7. The in-flight session keeps the rolled-back version; new sessions are on the old version again.
  await midUser.reload();
  const midResult = await midUser.finish();
  check('session started before rollback finishes on its version', midUser.session.version === config.version, `result "${midResult}" on v${midUser.session.version}`);
  const afterRollback = await newUser('new-after-rollback');
  check('new session after rollback starts on the old version', afterRollback.session.version === oldVersion, `v${afterRollback.session.version}`);
  await afterRollback.finish();

  // 8. Nothing lost, schema untouched.
  const hashAfter = await schemaHash();
  check('schema unchanged after publish + rollback', hashAfter === hashBefore, hashAfter);
  const after = await analytics(oldVersion);
  for (const before of versionsBefore) {
    const now = after.versions.find((v) => v.version === before.version);
    check(
      `analytics of v${before.version} kept (started never decreases)`,
      now !== undefined && now.started >= before.started && now.reachedResult >= before.reachedResult,
      `started ${before.started} → ${now?.started}, reached result ${before.reachedResult} → ${now?.reachedResult}`,
    );
  }
  const newStats = after.versions.find((v) => v.version === config.version);
  check(`analytics of v${config.version} present after rollback`, (newStats?.started ?? 0) > 0, `started ${newStats?.started}, reached result ${newStats?.reachedResult}`);
  // What the new version changes must be visible in its own analytics (generic: read from the config).
  const newConfig = JSON.parse(readFileSync(CONFIG_PATH as string, 'utf8')) as {
    events: { allowed: { name: string }[] };
    experiment: { variants: Record<string, { stepSequence: string[] }> };
  };
  const reportNew = await analytics(config.version);
  for (const [variant, def] of Object.entries(newConfig.experiment.variants)) {
    const steps = reportNew.selected?.variants[variant]?.steps.map((s) => s.stepId) ?? [];
    check(`v${config.version} variant ${variant}: analytics steps follow the config`, JSON.stringify(steps) === JSON.stringify(def.stepSequence), steps.join(' › '));
  }
  const core = ['session_started', 'step_viewed', 'answer_submitted', 'step_completed', 'back_clicked', 'result_viewed', 'cta_clicked'];
  for (const name of newConfig.events.allowed.map((e) => e.name).filter((n) => !core.includes(n))) {
    const row = reportNew.selected?.otherEvents.find((o) => o.name === name);
    check(`new event "${name}" collected for v${config.version}`, (row?.sessions ?? 0) > 0, row ? `${row.sessions} sessions (${JSON.stringify(row.byVariant)})` : 'missing');
    const inOld = (await analytics(oldVersion)).selected?.otherEvents.find((o) => o.name === name);
    check(`new event "${name}" absent from v${oldVersion}`, !inOld, inOld ? `${inOld.sessions} sessions` : 'none — older sessions never send it');
  }

  for (const v of [oldVersion, config.version]) {
    const r = await analytics(v);
    const bad = Object.entries(r.selected?.variants ?? {}).filter(([, x]) => !x.invariantOk);
    check(`v${v}: drop-offs + reached + in progress = started (every variant)`, bad.length === 0, bad.length ? `broken in ${bad.map(([k]) => k).join(', ')}` : 'holds');
  }

  const failed = checks.filter((c) => !c.ok);
  say(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} (${checks.length} checks)`);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${log.join('\n')}\n`);
    console.log(`report written to ${OUT}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
