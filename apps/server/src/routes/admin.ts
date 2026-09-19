import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import type { Auth } from '../auth.js';
import { schemaHash, type Db } from '../db.js';

const FunnelParams = z.object({ funnelId: z.string().min(1) });
const VersionParams = FunnelParams.extend({ version: z.coerce.number().int().positive() });

/** Internal management API: internal login (cookie) or the access key header (CLI scripts). */
export const adminRoutes =
  (services: Services, db: Db, auth: Auth): FastifyPluginAsync =>
  async (app) => {
    // Public URL: slow down token guessing. Scoped to /api/admin only; the funnel and events API are not limited here.
    await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

    // preHandler, not onRequest: scope-level onRequest hooks run before the route-level rate limiter, so a guard there
    // would answer 401 before a wrong key is ever counted.
    app.addHook('preHandler', auth.guard);

    /** Schema fingerprint: must stay identical across publish/rollback (proof for iteration 2). */
    app.get('/schema', async () => ({
      schemaHash: schemaHash(db),
      migrations: db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all(),
    }));

    app.get('/funnels', async () => ({
      funnels: services.versions.funnelIds().map((id) => ({ funnelId: id, activeVersion: services.versions.activeVersion(id) })),
    }));

    app.get('/funnels/:funnelId/versions', async (req) => {
      const { funnelId } = FunnelParams.parse(req.params);
      return services.versions.list(funnelId);
    });

    app.get('/funnels/:funnelId/versions/:version', async (req) => {
      const { funnelId, version } = VersionParams.parse(req.params);
      return services.versions.getRawConfig(funnelId, version);
    });

    /** Upload (store + validate) a config. Does not change what new sessions get. */
    app.post('/funnels/:funnelId/versions', async (req, reply) => {
      const { funnelId } = FunnelParams.parse(req.params);
      const outcome = services.versions.upload(funnelId, req.body);
      return reply.status(outcome.status === 'created' ? 201 : 200).send(outcome);
    });

    app.post('/funnels/:funnelId/versions/:version/publish', async (req) => {
      const { funnelId, version } = VersionParams.parse(req.params);
      return services.versions.publish(funnelId, version, 'admin');
    });

    app.post('/funnels/:funnelId/rollback', async (req) => {
      const { funnelId } = FunnelParams.parse(req.params);
      return services.versions.rollback(funnelId, 'admin');
    });
  };
