import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { AnalyticsService } from './modules/analytics.js';
import { SessionsService } from './modules/sessions.js';
import { VersionsService } from './modules/versions.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: Db;
  adminToken: string;
  logger?: boolean;
  /** Directory with the built web app; when set, the server also serves the SPA. */
  webDir?: string;
  /** Clock, injectable for tests (TTL). */
  now?: () => number;
}

export interface Services {
  versions: VersionsService;
  sessions: SessionsService;
  analytics: AnalyticsService;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const versions = new VersionsService(opts.db);
  const services: Services = {
    versions,
    sessions: new SessionsService(opts.db, versions, opts.now),
    analytics: new AnalyticsService(opts.db, versions, opts.now),
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid request', details: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(sessionRoutes(services), { prefix: '/api' });
  await app.register(analyticsRoutes(services), { prefix: '/api' });
  await app.register(adminRoutes(services, opts.db, opts.adminToken), { prefix: '/api/admin' });

  return app;
}
