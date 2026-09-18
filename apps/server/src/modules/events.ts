import {
  IncomingEventSchema,
  STEP_TYPES,
  filterEventProperties,
  isEventAllowed,
  type PropertyValue,
  type ResolvedFunnel,
  type EventBatchResponse,
  type EventStatus,
} from '@funnel/shared';
import type { Db } from '../db.js';
import type { SessionsService } from './sessions.js';

const DAY_MS = 24 * 3600_000;
/** Client clocks drift and outboxes are flushed late, but not by months: older/future timestamps are refused. */
const MAX_CLIENT_AGE_MS = 30 * DAY_MS;
const MAX_CLIENT_AHEAD_MS = DAY_MS;
/** String property values are identifiers only — free text (which could carry raw answers) is dropped. */
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const ANSWER_KINDS = new Set(['single_select', 'multi_select', 'number']);

/**
 * Second privacy/consistency gate after the key whitelist: every value must make sense for the pinned version
 * (step ids are steps of this version, result ids are its results, …); anything else is dropped, not stored.
 */
function sanitizeProperties(funnel: ResolvedFunnel, props: Record<string, PropertyValue>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && !TOKEN.test(value)) continue;
    switch (key) {
      case 'next_step_id':
      case 'destination_step_id':
        if (typeof value === 'string' && Object.hasOwn(funnel.steps, value)) out[key] = value;
        break;
      case 'result_id':
        if (typeof value === 'string' && Object.hasOwn(funnel.results, value)) out[key] = value;
        break;
      case 'step_type':
        if (typeof value === 'string' && (STEP_TYPES as readonly string[]).includes(value)) out[key] = value;
        break;
      case 'answer_kind':
        if (typeof value === 'string' && ANSWER_KINDS.has(value)) out[key] = value;
        break;
      case 'visible_step_index':
      case 'visible_step_count':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000) out[key] = value;
        break;
      default:
        out[key] = value;
    }
  }
  return out;
}

/** Events only the server may emit. */
const SERVER_ONLY_EVENTS = new Set(['session_started']);

export interface IngestOutcome extends EventBatchResponse {
  /** Same event_id seen again with a different payload (kept as first written; reported for diagnostics). */
  conflicts: number;
}

interface StoredEvent {
  session_id: string;
  name: string;
  step_id: string | null;
  properties_json: string;
}

/**
 * Batch ingestion with per-event outcomes.
 *
 * - Idempotent: `INSERT … ON CONFLICT(event_id) DO NOTHING`. An event is an immutable fact, the first write
 *   wins; re-sending a batch after a timeout yields `duplicate` for every event and changes nothing.
 * - One bad event never fails the batch: it gets `rejected` with a reason, the others are stored.
 * - Context (version, variant, assignment, UTM) is taken from the session row, never from the client.
 * - Allowed event names and properties come from the session's pinned version config, so a new event
 *   of a newer version is accepted only from sessions of that version.
 */
export class EventsService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionsService,
    private readonly now: () => number = Date.now,
  ) {}

  ingest(rawEvents: unknown[]): IngestOutcome {
    const results: EventStatus[] = [];
    const reasons: Record<string, number> = {};
    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;
    const serverTs = this.now();

    const insert = this.db.prepare(
      `INSERT INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id, variant,
         assignment, utm_source, utm_medium, utm_campaign, client_ts, server_ts, seq, properties_json)
       VALUES (@event_id, @session_id, @name, @step_id, @funnel_id, @funnel_version, @experiment_id, @variant,
         @assignment, @utm_source, @utm_medium, @utm_campaign, @client_ts, @server_ts, @seq, @properties_json)
       ON CONFLICT (event_id) DO NOTHING`,
    );
    const existing = this.db.prepare('SELECT session_id, name, step_id, properties_json FROM events WHERE event_id = ?');

    const reject = (eventId: string | null, reason: string) => {
      results.push({ event_id: eventId, status: 'rejected', reason });
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };

    this.db.transaction(() => {
      for (const raw of rawEvents) {
        const rawId = typeof raw === 'object' && raw !== null && typeof (raw as { event_id?: unknown }).event_id === 'string'
          ? (raw as { event_id: string }).event_id
          : null;
        const parsed = IncomingEventSchema.safeParse(raw);
        if (!parsed.success) {
          reject(rawId, `invalid_payload:${parsed.error.issues[0]?.path.join('.') ?? ''}`);
          continue;
        }
        const e = parsed.data;
        if (SERVER_ONLY_EVENTS.has(e.name)) {
          reject(e.event_id, 'server_only_event');
          continue;
        }
        const session = this.sessions.findRow(e.session_id);
        if (!session) {
          reject(e.event_id, 'unknown_session');
          continue;
        }
        if (e.funnel_id !== session.funnel_id || e.funnel_version !== session.funnel_version || e.variant !== session.variant) {
          reject(e.event_id, 'context_mismatch');
          continue;
        }
        const funnel = this.sessions.funnelOf(session);
        if (!isEventAllowed(funnel.events, e.name)) {
          reject(e.event_id, 'event_not_allowed_for_version');
          continue;
        }
        const stepId = e.step_id ?? null;
        if (stepId !== null && !Object.hasOwn(funnel.steps, stepId)) {
          reject(e.event_id, 'unknown_step');
          continue;
        }
        const clientTs = typeof e.client_timestamp === 'number' ? e.client_timestamp : Date.parse(e.client_timestamp);
        if (!Number.isFinite(clientTs) || clientTs < serverTs - MAX_CLIENT_AGE_MS || clientTs > serverTs + MAX_CLIENT_AHEAD_MS) {
          reject(e.event_id, 'client_timestamp_out_of_range');
          continue;
        }
        const properties = JSON.stringify(sanitizeProperties(funnel, filterEventProperties(funnel.events, e.name, e.properties)));

        const info = insert.run({
          event_id: e.event_id,
          session_id: session.id,
          name: e.name,
          step_id: stepId,
          funnel_id: session.funnel_id,
          funnel_version: session.funnel_version,
          experiment_id: session.experiment_id,
          variant: session.variant,
          assignment: session.assignment,
          utm_source: session.utm_source,
          utm_medium: session.utm_medium,
          utm_campaign: session.utm_campaign,
          client_ts: clientTs,
          server_ts: serverTs,
          seq: e.seq ?? null,
          properties_json: properties,
        });
        if (info.changes === 1) {
          accepted++;
          results.push({ event_id: e.event_id, status: 'accepted' });
        } else {
          duplicates++;
          results.push({ event_id: e.event_id, status: 'duplicate' });
          const stored = existing.get(e.event_id) as StoredEvent | undefined;
          if (stored && (stored.session_id !== session.id || stored.name !== e.name || stored.step_id !== stepId || stored.properties_json !== properties)) {
            conflicts++;
          }
        }
      }
      const rejected = results.length - accepted - duplicates;
      this.db
        .prepare('INSERT INTO ingest_log (received_at, accepted, duplicates, rejected, reasons) VALUES (?, ?, ?, ?, ?)')
        .run(serverTs, accepted, duplicates, rejected, JSON.stringify(reasons));
    })();

    return { accepted, duplicates, rejected: results.length - accepted - duplicates, conflicts, results };
  }
}
