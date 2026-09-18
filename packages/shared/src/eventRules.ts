import type { EventsConfig } from './config.js';

// Event rules used by both the browser tracker and the server (no zod here: the wire schema lives in events.ts).

/** Events the runtime itself knows how to emit. A version may allow more (e.g. v3 adds recommendation_expanded). */
export const CORE_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

export const MAX_BATCH_SIZE = 100;

export function isEventAllowed(events: EventsConfig, name: string): boolean {
  return events.allowed.some((e) => e.name === name);
}

export type PropertyValue = string | number | boolean | null;

/**
 * Keeps only properties declared for this event in the version's config, and only scalar values.
 * This is the privacy gate: raw answers never reach the events table, even if a client sends them.
 */
export function filterEventProperties(
  events: EventsConfig,
  name: string,
  properties: Record<string, unknown> | undefined,
): Record<string, PropertyValue> {
  const definition = events.allowed.find((e) => e.name === name);
  if (!definition || !properties) return {};
  const allowAnswerKinds = events.privacy?.allowAnswerKinds ?? true;
  const out: Record<string, PropertyValue> = {};
  for (const key of definition.properties) {
    if (key === 'answer_kind' && !allowAnswerKinds) continue;
    const value = properties[key];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? value.slice(0, 256) : value;
    }
  }
  return out;
}
