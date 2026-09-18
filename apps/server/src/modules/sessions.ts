import { createHmac, randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import {
  computeResult,
  initialState,
  resolveVariant,
  validateState,
  type Assignment,
  type ResolvedFunnel,
  type Result,
  type SessionDto,
  type SessionState,
  type SessionStatus,
  type Utm,
} from '@funnel/shared';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { assignVariant } from './assignment.js';
import type { VersionsService } from './versions.js';

/** Namespace for deterministic ids of server-generated events (uuid v5). */
const SERVER_EVENT_NAMESPACE = '6f1c7f7e-3b0a-4c8e-9d7a-2f64a7b1c9e5';

export function sessionStartedEventId(sessionId: string): string {
  return uuidv5(`session_started:${sessionId}`, SERVER_EVENT_NAMESPACE);
}

export interface SessionRow {
  id: string;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string;
  variant: string;
  assignment: Assignment;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  state_json: string;
  state_rev: number;
  status: SessionStatus;
  result_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/**
 * A uuid namespace derived from a server secret. Session ids made from a client's idempotency key live in it, so the
 * client cannot predict (and therefore cannot shop for) the id that its A/B variant is hashed from.
 */
export function sessionIdNamespace(secret: string): string {
  const b = createHmac('sha256', secret).update('funnel-runtime/session-ids').digest().subarray(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface CreateSessionInput {
  funnelId: string;
  /** Client-generated uuid, reused on retries: the same key always yields the same session (no duplicate start). */
  idempotencyKey?: string | undefined;
  utm: Utm;
  variantOverride?: string | undefined;
  /** Page query; the override parameter name comes from the active version's config. */
  query?: Record<string, string>;
}

export class SessionsService {
  private readonly resolved = new Map<string, ResolvedFunnel>();

  constructor(
    private readonly db: Db,
    private readonly versions: VersionsService,
    private readonly now: () => number = Date.now,
    private readonly idNamespace: string = sessionIdNamespace(randomUUID()),
  ) {}

  /**
   * New sessions always start on the currently active version; version and variant are pinned for life.
   * With an idempotency key, a retried request (the response was lost) returns the session already created for that
   * key instead of starting a second one, which would inflate "started" and the A/B denominator.
   */
  create(input: CreateSessionInput): { session: SessionDto; created: boolean } {
    const id = input.idempotencyKey ? uuidv5(input.idempotencyKey, this.idNamespace) : randomUUID();
    const existing = input.idempotencyKey ? this.findRow(id) : undefined;
    if (existing) {
      if (existing.funnel_id !== input.funnelId) throw new HttpError(409, 'idempotency_conflict', 'Key already used for another funnel');
      return { session: this.get(id), created: false };
    }

    const version = this.versions.activeVersion(input.funnelId);
    if (version === null) throw notFound(`Funnel ${input.funnelId}`);
    const config = this.versions.getConfig(input.funnelId, version);

    const variants = config.experiment.variants;
    const requested = input.variantOverride ?? input.query?.[config.experiment.overrideQueryParam ?? 'variant'];
    // Object.hasOwn: user input must never match inherited keys like "toString" or "__proto__".
    const override = requested && Object.hasOwn(variants, requested) ? requested : undefined;
    const variant = override ?? assignVariant(config.experiment.id, id, variants);
    const assignment: Assignment = override ? 'override' : 'hash';
    const funnel = this.funnelOf({ funnel_id: input.funnelId, funnel_version: version, variant });

    const now = this.now();
    const row: SessionRow = {
      id,
      funnel_id: input.funnelId,
      funnel_version: version,
      experiment_id: config.experiment.id,
      variant,
      assignment,
      utm_source: input.utm.utm_source ?? null,
      utm_medium: input.utm.utm_medium ?? null,
      utm_campaign: input.utm.utm_campaign ?? null,
      utm_content: input.utm.utm_content ?? null,
      utm_term: input.utm.utm_term ?? null,
      state_json: JSON.stringify(initialState(funnel)),
      state_rev: 0,
      status: 'active',
      result_id: null,
      created_at: now,
      updated_at: now,
      expires_at: now + config.session.ttlHours * 3600_000,
    };

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, funnel_id, funnel_version, experiment_id, variant, assignment,
             utm_source, utm_medium, utm_campaign, utm_content, utm_term,
             state_json, state_rev, status, result_id, created_at, updated_at, expires_at)
           VALUES (@id, @funnel_id, @funnel_version, @experiment_id, @variant, @assignment,
             @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term,
             @state_json, @state_rev, @status, @result_id, @created_at, @updated_at, @expires_at)`,
        )
        .run(row);
      // `session_started` is emitted by the server (config trigger: "A server-side session is created"),
      // atomically with the session and with a deterministic id, so it can never be lost or duplicated.
      this.db
        .prepare(
          `INSERT INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant,
             assignment, utm_source, utm_medium, utm_campaign, client_ts, server_ts, seq, properties_json)
           VALUES (?, ?, 'session_started', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}')
           ON CONFLICT (event_id) DO NOTHING`,
        )
        .run(sessionStartedEventId(id), id, row.funnel_id, version, row.experiment_id, variant, assignment,
          row.utm_source, row.utm_medium, row.utm_campaign, now, now);
    })();

    return { session: this.toDto(row, funnel), created: true };
  }

  get(id: string): SessionDto {
    const row = this.load(id);
    return this.toDto(row, this.funnelOf(row));
  }

  /**
   * Saves client state after re-validating it against the session's pinned version.
   * `rev` is an optimistic lock: a stale tab gets 409 with the current state instead of overwriting it.
   */
  saveState(id: string, state: SessionState, rev: number): SessionDto {
    const row = this.load(id);
    const funnel = this.funnelOf(row);
    if (rev !== row.state_rev) {
      throw new HttpError(409, 'stale_state', 'Session state was changed elsewhere', { current: this.toDto(row, funnel) });
    }
    const check = validateState(funnel, state);
    if (!check.ok) throw new HttpError(422, 'invalid_state', 'State is not valid for this session', { errors: check.errors });

    const now = this.now();
    const updated = this.db
      // Any state change reopens a completed session: its stored result is recomputed on the next /result.
      .prepare(`UPDATE sessions SET state_json = ?, state_rev = state_rev + 1, updated_at = ?, status = 'active', result_id = NULL
               WHERE id = ? AND state_rev = ?`)
      .run(JSON.stringify(check.state), now, id, rev);
    if (updated.changes === 0) throw new HttpError(409, 'stale_state', 'Session state was changed elsewhere');
    return this.toDto({ ...row, state_json: JSON.stringify(check.state), state_rev: rev + 1, updated_at: now, status: 'active', result_id: null }, funnel);
  }

  /** The result is computed on the server from saved answers; the client cannot pick its own result. */
  result(id: string): { resultId: string; result: Result } {
    const row = this.load(id);
    const funnel = this.funnelOf(row);
    const state = JSON.parse(row.state_json) as SessionState;
    const resultStep = funnel.sequence.find((s) => funnel.steps[s]?.type === 'result');
    if (!resultStep) throw new HttpError(500, 'result_missing', 'Funnel has no result step');
    // Reachability of the result step == every visible question has a valid answer.
    const check = validateState(funnel, { ...state, currentStepId: resultStep });
    if (!check.ok) throw new HttpError(409, 'not_finished', 'Answer all questions before requesting the result', { errors: check.errors });
    const resultId = computeResult(funnel, check.state.answers);
    const result = funnel.results[resultId];
    if (!result) throw new HttpError(500, 'result_missing', `Result ${resultId} is not defined`);
    this.db
      .prepare(`UPDATE sessions SET status = 'completed', result_id = ?, updated_at = ? WHERE id = ?`)
      .run(resultId, this.now(), id);
    return { resultId, result };
  }

  /** Row for event ingestion; does not enforce TTL (late events of an expired session are still valid facts). */
  findRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  /** Resolved funnel per (funnel, version, variant); versions are immutable, so the cache never goes stale. */
  funnelOf(row: Pick<SessionRow, 'funnel_id' | 'funnel_version' | 'variant'>): ResolvedFunnel {
    const key = `${row.funnel_id}@${row.funnel_version}/${row.variant}`;
    let funnel = this.resolved.get(key);
    if (!funnel) {
      funnel = resolveVariant(this.versions.getConfig(row.funnel_id, row.funnel_version), row.variant);
      this.resolved.set(key, funnel);
    }
    return funnel;
  }

  private load(id: string): SessionRow {
    const row = this.findRow(id);
    if (!row) throw notFound('Session');
    if (row.expires_at <= this.now()) throw new HttpError(410, 'session_expired', 'Session expired; start a new one');
    return row;
  }

  private toDto(row: SessionRow, funnel: ResolvedFunnel): SessionDto {
    return {
      sessionId: row.id,
      funnelId: row.funnel_id,
      version: row.funnel_version,
      experimentId: row.experiment_id,
      variant: row.variant,
      assignment: row.assignment,
      status: row.status,
      resultId: row.result_id,
      utm: {
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        utm_content: row.utm_content,
        utm_term: row.utm_term,
      },
      funnel,
      state: JSON.parse(row.state_json) as SessionState,
      rev: row.state_rev,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
}
