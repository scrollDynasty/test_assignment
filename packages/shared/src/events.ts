import { z } from 'zod';
import type { EventsConfig } from './config.js';

/** Events the runtime itself knows how to emit. A version may allow more (see iteration 2). */
export const CORE_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;
export type CoreEventName = (typeof CORE_EVENTS)[number];

export const MAX_BATCH_SIZE = 100;

const nullableString = z.string().max(256).nullable().optional();

/**
 * Wire format of one event. Field names follow `events.baseProperties` from the configs.
 * `funnel_version` / `variant` / UTM are sent by the client but the server stores the session's values.
 */
export const IncomingEventSchema = z.object({
  event_id: z.uuid(),
  session_id: z.uuid(),
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  client_timestamp: z.union([z.iso.datetime({ offset: true }), z.number().int().nonnegative()]),
  funnel_id: z.string().min(1).max(128),
  funnel_version: z.number().int().positive(),
  experiment_id: z.string().max(256).optional(),
  variant: z.string().min(1).max(32),
  step_id: nullableString,
  utm_source: nullableString,
  utm_medium: nullableString,
  utm_campaign: nullableString,
  seq: z.number().int().nonnegative().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});
export type IncomingEvent = z.infer<typeof IncomingEventSchema>;

export const EventBatchSchema = z.object({ events: z.array(z.unknown()).min(1) });

export type EventStatus =
  | { event_id: string | null; status: 'accepted' }
  | { event_id: string | null; status: 'duplicate' }
  | { event_id: string | null; status: 'rejected'; reason: string };

export interface EventBatchResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  results: EventStatus[];
}

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
