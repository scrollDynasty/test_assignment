import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '@funnel/shared';
import { funnelV1, funnelV3 } from './fixtures';

/**
 * The event outbox is the client half of "at-least-once + de-duplication": an event may only leave the durable queue
 * after the server answered for it. The tests drive it with a fake fetch and fake timers and look at what was sent
 * and at what is still queued in localStorage.
 */

type Tracker = { track(name: string, stepId: string | null, properties?: Record<string, unknown>): void };
type Sent = { events: { event_id: string; name: string; seq: number; properties: Record<string, unknown> }[] };

const session = (version: 1 | 3): SessionDto => ({
  sessionId: '8f14e45f-ceea-4e7a-9c1a-000000000001',
  funnelId: 'workstyle-planner',
  version,
  experimentId: 'exp',
  variant: 'A',
  assignment: 'hash',
  utm: { utm_campaign: 'spring' },
  funnel: version === 1 ? funnelV1('A') : funnelV3('A'),
  state: { answers: {}, history: [], currentStepId: 'intro' },
  status: 'active',
  resultId: null,
  rev: 0,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

const queued = (): { event_id: string; name: string }[] => JSON.parse(window.localStorage.getItem('funnel:outbox') ?? '[]');
const acceptAll = (body: Sent) =>
  new Response(JSON.stringify({ accepted: body.events.length, duplicates: 0, rejected: 0, results: body.events.map((e) => ({ event_id: e.event_id, status: 'accepted' })) }), { status: 200 });

let sent: Sent[];
let respond: (body: Sent) => Response | Promise<Response>;

async function freshTracker(version: 1 | 3 = 1): Promise<Tracker> {
  vi.resetModules(); // the outbox is a module-level singleton
  const { createTracker } = await import('../src/lib/tracker');
  return createTracker(session(version));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  respond = acceptAll;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    return respond(body);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('event outbox', () => {
  it('batches events, stamps the session context and a per-session sequence, and empties the queue on success', async () => {
    const tracker = await freshTracker();
    tracker.track('step_viewed', 'intro', { step_type: 'info', visible_step_index: 0, visible_step_count: 6 });
    tracker.track('step_completed', 'team_size', { next_step_id: 'work_mode', answer: 'secret' });
    expect(queued()).toHaveLength(2); // durable before anything is sent
    await vi.advanceTimersByTimeAsync(2500);
    expect(sent).toHaveLength(1);
    const events = sent[0]?.events ?? [];
    expect(events.map((e) => [e.name, e.seq])).toEqual([['step_viewed', 1], ['step_completed', 2]]);
    // Only properties declared by the version reach the wire: raw answers never do.
    expect(events[1]?.properties).toEqual({ next_step_id: 'work_mode' });
    expect(queued()).toHaveLength(0);
  });

  it('keeps events through a network failure and delivers the same event ids on retry', async () => {
    const tracker = await freshTracker();
    respond = () => {
      throw new TypeError('Failed to fetch');
    };
    tracker.track('step_viewed', 'intro', { step_type: 'info' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(sent).toHaveLength(1);
    const firstIds = queued().map((e) => e.event_id);
    expect(firstIds).toHaveLength(1);

    respond = acceptAll;
    await vi.advanceTimersByTimeAsync(1500); // back-off 1 s
    expect(sent).toHaveLength(2);
    expect(sent[1]?.events.map((e) => e.event_id)).toEqual(firstIds); // same ids: the server de-duplicates
    expect(queued()).toHaveLength(0);
  });

  it('on 429 waits for Retry-After instead of dropping the batch', async () => {
    const tracker = await freshTracker();
    respond = () => new Response('{}', { status: 429, headers: { 'retry-after': '5' } });
    tracker.track('step_viewed', 'intro', {});
    await vi.advanceTimersByTimeAsync(2500);
    respond = acceptAll;
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toHaveLength(1); // still waiting
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toHaveLength(2);
    expect(queued()).toHaveLength(0);
  });

  it('drops a batch the server refused as malformed (4xx): resending the same bytes can never succeed', async () => {
    const tracker = await freshTracker();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    respond = () => new Response('{"error":"bad_request"}', { status: 400 });
    tracker.track('step_viewed', 'intro', {});
    await vi.advanceTimersByTimeAsync(2500);
    expect(queued()).toHaveLength(0);
  });

  it("sends an event only if the session's own version declares it (safe to ship code before publishing v3)", async () => {
    const v1 = await freshTracker(1);
    v1.track('recommendation_expanded', 'result', { result_id: 'x', action: 'expand', source: 'result_cta' });
    expect(queued()).toHaveLength(0);
    const v3 = await freshTracker(3);
    v3.track('recommendation_expanded', 'result', { result_id: 'x', action: 'expand', source: 'result_cta' });
    expect(queued().map((e) => e.name)).toEqual(['recommendation_expanded']);
  });
});
