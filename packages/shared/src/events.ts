import { z } from 'zod';

export { CORE_EVENTS, MAX_BATCH_SIZE, filterEventProperties, isEventAllowed, type PropertyValue } from './eventRules.js';

const nullableString = z.string().max(256).nullable().optional();

/**
 * Wire format of one event. Field names follow `events.baseProperties` from the configs.
 * `funnel_version` / `variant` / UTM are sent by the client but the server stores the session's values.
 */
export const IncomingEventSchema = z.object({
  // Lower-cased: the same UUID in upper case (Swift's uuidString, some SDKs) must still be one event.
  event_id: z.uuid().transform((id) => id.toLowerCase()),
  session_id: z.uuid().transform((id) => id.toLowerCase()),
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
