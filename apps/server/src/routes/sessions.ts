import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';

// Ad platforms put long dynamic values into UTM tags and click ids: they are cut, not rejected, otherwise such a
// visitor could never start the funnel (the page would retry the same 400 forever).
const utmValue = z
  .string()
  .max(2048)
  .transform((v) => v.trim().slice(0, 128) || null)
  .nullable()
  .optional();

const CreateBody = z.object({
  funnelId: z.string().min(1).max(128),
  idempotencyKey: z.uuid().optional(),
  utm: z
    .object({ utm_source: utmValue, utm_medium: utmValue, utm_campaign: utmValue, utm_content: utmValue, utm_term: utmValue })
    .optional(),
  variantOverride: z.string().max(32).optional(),
  // Only the override parameter is read from here; oversize foreign keys/values (fbclid, gclid…) are dropped, not rejected.
  query: z
    .record(z.string(), z.string())
    .transform((q) => Object.fromEntries(Object.entries(q).filter(([k, v]) => k.length <= 64 && v.length <= 256)))
    .optional(),
});

const IdParams = z.object({ id: z.uuid() });

const answerValue = z.union([z.string().max(256), z.number(), z.array(z.string().max(256)).max(50)]);
const StateBody = z.object({
  state: z.object({
    answers: z.record(z.string().max(128), answerValue),
    history: z.array(z.string().max(128)).max(200),
    currentStepId: z.string().min(1).max(128),
  }),
  rev: z.number().int().nonnegative(),
});

/** Public runtime API used by the funnel page. */
export const sessionRoutes =
  (services: Services, createLimit?: number): FastifyPluginAsync =>
  async (app) => {
    // A person starts a handful of sessions; a tighter per-IP limit on creation keeps an outsider from filling the
    // database (and slowing the synchronous analytics report) at the full public rate.
    const createOptions = createLimit ? { config: { rateLimit: { max: createLimit, timeWindow: '1 minute' } } } : {};
    app.post('/sessions', createOptions, async (req, reply) => {
      const body = CreateBody.parse(req.body);
      const { session, created } = services.sessions.create({
        funnelId: body.funnelId,
        idempotencyKey: body.idempotencyKey,
        utm: body.utm ?? {},
        variantOverride: body.variantOverride,
        query: body.query ?? {},
      });
      return reply.status(created ? 201 : 200).send(session);
    });

    app.get('/sessions/:id', async (req) => {
      const { id } = IdParams.parse(req.params);
      return services.sessions.get(id);
    });

    app.put('/sessions/:id/state', async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = StateBody.parse(req.body);
      return services.sessions.saveState(id, body.state, body.rev);
    });

    app.post('/sessions/:id/result', async (req) => {
      const { id } = IdParams.parse(req.params);
      return services.sessions.result(id);
    });
  };
