import type { FastifyPluginAsync } from 'fastify';
import { EventBatchSchema, MAX_BATCH_SIZE } from '@funnel/shared';
import type { Services } from '../app.js';
import { HttpError } from '../errors.js';

/** Public batch endpoint. Always 200 with a per-event status unless the request itself is malformed. */
export const eventRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    app.post('/events', async (req) => {
      const body = EventBatchSchema.safeParse(req.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'Expected {"events": [...]} with at least one event');
      if (body.data.events.length > MAX_BATCH_SIZE) {
        throw new HttpError(413, 'batch_too_large', `At most ${MAX_BATCH_SIZE} events per request`);
      }
      const outcome = services.events.ingest(body.data.events);
      if (outcome.conflicts > 0) req.log.warn({ conflicts: outcome.conflicts }, 'event_id reused with a different payload');
      return outcome;
    });
  };
