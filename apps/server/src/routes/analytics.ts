import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';

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
 * Public, read-only analytics report. No admin token by product decision: the response contains only
 * aggregated counts and rates over sessions — no session ids, answers or other personal data.
 */
export const analyticsRoutes =
  (services: Services): FastifyPluginAsync =>
  async (app) => {
    app.get('/analytics', async (req) => {
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
