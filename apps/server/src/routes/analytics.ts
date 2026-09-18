import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import type { Auth } from '../auth.js';

const Query = z.object({
  funnelId: z.string().min(1).max(128),
  version: z.coerce.number().int().positive().optional(),
  utm_campaign: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v)),
  include_overrides: z.enum(['true', 'false']).default('false'),
  in_progress_minutes: z.coerce.number().int().min(0).max(1440).default(30),
});

/**
 * Analytics report for the internal dashboard (TZ §5 "внутренний dashboard"): requires the internal login
 * or the access key header (traffic generator --verify). Aggregates only — no session ids, no answers.
 */
export const analyticsRoutes =
  (services: Services, auth: Auth): FastifyPluginAsync =>
  async (app) => {
    // Same limit as /api/admin: the endpoint accepts the key header, so key guessing must be slowed down here too.
    await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
    app.get('/analytics', { preHandler: auth.guard }, async (req) => {
      const q = Query.parse(req.query);
      return services.analytics.report({
        funnelId: q.funnelId,
        version: q.version,
        utmCampaign: q.utm_campaign,
        includeOverrides: q.include_overrides === 'true',
        inProgressMinutes: q.in_progress_minutes,
      });
    });
  };
