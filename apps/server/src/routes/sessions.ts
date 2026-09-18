import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';

const utmValue = z
  .string()
  .trim()
  .max(128)
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

const CreateBody = z.object({
  funnelId: z.string().min(1).max(128),
  idempotencyKey: z.uuid().optional(),
  utm: z
    .object({ utm_source: utmValue, utm_medium: utmValue, utm_campaign: utmValue, utm_content: utmValue, utm_term: utmValue })
    .optional(),
  variantOverride: z.string().max(32).optional(),
  query: z.record(z.string().max(64), z.string().max(256)).optional(),
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
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    app.post('/sessions', async (req, reply) => {
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
