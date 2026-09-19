import {
  MAX_BATCH_SIZE,
  filterEventProperties,
  isEventAllowed,
  type EventBatchResponse,
  type IncomingEvent,
  type SessionDto,
} from '@funnel/shared';
import { storage } from './storage';
import { uuid } from './uuid';

/**
 * Client side of the event pipeline.
 *
 * Every event is written to a persistent outbox (localStorage) first and removed only after the server
 * answered for it (accepted / duplicate / rejected). Refresh, a closed tab or a timeout therefore never
 * loses an event, and a retry is safe because the server de-duplicates by event_id: at-least-once delivery
 * plus idempotent ingestion gives exactly-once in the table.
 */

const OUTBOX_KEY = 'funnel:outbox';
const FLUSH_DELAY_MS = 2000;
const FLUSH_AT = 10;
/** fetch keepalive (used on page hide) has a 64 KiB budget; stay well below it. */
const MAX_BATCH_BYTES = 48 * 1024;

type Queued = IncomingEvent;

/**
 * In-memory copy of the outbox. localStorage is the durable mirror (survives refresh / tab close); when it is
 * unavailable (private mode, disabled storage, quota) the memory copy keeps analytics working for this page.
 */
let memory: Queued[] | null = null;

function readOutbox(): Queued[] {
  const stored = storage.getJson<Queued[]>(OUTBOX_KEY);
  if (stored) return stored;
  return memory ?? [];
}

function writeOutbox(events: Queued[]): void {
  memory = events;
  storage.setJson(OUTBOX_KEY, events);
}

/** Takes a prefix of the queue that fits both the count and the byte limit. */
function nextChunk(queue: Queued[], maxCount: number): Queued[] {
  const chunk: Queued[] = [];
  let bytes = 2;
  for (const e of queue) {
    const size = JSON.stringify(e).length + 1;
    if (chunk.length >= maxCount || (chunk.length > 0 && bytes + size > MAX_BATCH_BYTES)) break;
    chunk.push(e);
    bytes += size;
  }
  return chunk;
}

class Outbox {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private backoffMs = 0;
  private maxCount = MAX_BATCH_SIZE;

  constructor() {
    if (typeof window === 'undefined') return;
    const flushNow = () => void this.flush(true);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
    window.addEventListener('online', () => void this.flush());
    // Anything left over from a previous page load goes out right away.
    if (readOutbox().length > 0) this.schedule(500);
  }

  push(event: Queued): void {
    const queue = readOutbox();
    queue.push(event);
    writeOutbox(queue);
    if (queue.length >= FLUSH_AT) void this.flush();
    else this.schedule(FLUSH_DELAY_MS);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush(pageHiding = false): Promise<void> {
    if (this.inFlight) return;
    const chunk = nextChunk(readOutbox(), this.maxCount);
    if (chunk.length === 0) return;
    this.inFlight = true;
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: chunk }),
        keepalive: pageHiding,
      });
      if (res.status === 413 && this.maxCount > 1) {
        this.maxCount = Math.max(1, Math.floor(this.maxCount / 2));
        return this.retrySoon(0);
      }
      if (res.status === 429 || res.status === 408) {
        // Throttled or timed out: the events are fine, send them later (Retry-After in seconds when given).
        const retryAfter = Number(res.headers.get('retry-after'));
        return this.retrySoon(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      if (res.ok) {
        const body = (await res.json()) as EventBatchResponse;
        this.remove(new Set(body.results.map((r) => r.event_id).filter((id): id is string => id !== null)));
        this.backoffMs = 0;
      } else if (res.status >= 400 && res.status < 500) {
        // The whole request was refused as malformed: retrying the same bytes can never succeed.
        console.warn('events batch refused', res.status);
        this.remove(new Set(chunk.map((e) => e.event_id)));
      } else {
        return this.retrySoon();
      }
    } catch {
      return this.retrySoon(); // network error / timeout: keep the events, try again later
    } finally {
      this.inFlight = false;
    }
    if (readOutbox().length > 0) this.schedule(0);
  }

  private retrySoon(ms?: number): void {
    this.inFlight = false;
    this.backoffMs = ms ?? Math.min(30_000, this.backoffMs ? this.backoffMs * 2 : 1000);
    this.schedule(this.backoffMs);
  }

  private remove(ids: Set<string>): void {
    // Re-read: another tab (or a push during the request) may have changed the outbox meanwhile.
    writeOutbox(readOutbox().filter((e) => !ids.has(e.event_id)));
  }
}

let outbox: Outbox | null = null;
function getOutbox(): Outbox {
  outbox ??= new Outbox();
  return outbox;
}

export interface Tracker {
  track(name: string, stepId: string | null, properties?: Record<string, unknown>): void;
}

/** Tracker bound to one session: stamps version/variant/UTM and a per-session sequence number. */
export function createTracker(session: SessionDto): Tracker {
  const seqKey = `funnel:seq:${session.sessionId}`;
  // In-memory floor for the counter: with storage blocked every event would otherwise get seq 1.
  let lastSeq = 0;
  return {
    track(name, stepId, properties = {}) {
      // Only events the session's own version declares. This is what makes shipping code for a newer
      // version's event safe for sessions that are pinned to an older version.
      if (!isEventAllowed(session.funnel.events, name)) return;
      const seq = Math.max(storage.getJson<number>(seqKey) ?? 0, lastSeq) + 1;
      lastSeq = seq;
      storage.setJson(seqKey, seq);
      getOutbox().push({
        event_id: uuid(),
        session_id: session.sessionId,
        name,
        client_timestamp: new Date().toISOString(),
        funnel_id: session.funnelId,
        funnel_version: session.version,
        experiment_id: session.experimentId,
        variant: session.variant,
        step_id: stepId,
        utm_source: session.utm.utm_source ?? null,
        utm_medium: session.utm.utm_medium ?? null,
        utm_campaign: session.utm.utm_campaign ?? null,
        seq,
        properties: filterEventProperties(session.funnel.events, name, properties),
      });
    },
  };
}
