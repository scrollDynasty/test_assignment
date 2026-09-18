import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { AnalyticsService } from './modules/analytics.js';
import { EventsService } from './modules/events.js';
import { SessionsService } from './modules/sessions.js';
import { VersionsService } from './modules/versions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { eventRoutes } from './routes/events.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: Db;
  adminToken: string;
  logger?: boolean;
  /** Directory with the built web app; when set, the server also serves the SPA. */
  webDir?: string;
  /** Behind a reverse proxy (Fly.io): take the client IP from X-Forwarded-For (used by rate limits). */
  trustProxy?: boolean;
  /** Requests per minute per IP on the public write API (sessions, events). */
  publicRateLimit?: number;
  /** Clock, injectable for tests (TTL). */
  now?: () => number;
}

export interface Services {
  versions: VersionsService;
  sessions: SessionsService;
  events: EventsService;
  analytics: AnalyticsService;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: opts.trustProxy ?? false });
  const versions = new VersionsService(opts.db);
  const sessions = new SessionsService(opts.db, versions, opts.now);
  const services: Services = {
    versions,
    sessions,
    events: new EventsService(opts.db, sessions, opts.now),
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
  // Public write endpoints get a per-IP limit; generous enough for the traffic generator from one machine.
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, { max: opts.publicRateLimit ?? 3000, timeWindow: '1 minute' });
      await scope.register(sessionRoutes(services));
      await scope.register(eventRoutes(services));
    },
    { prefix: '/api' },
  );
  await app.register(analyticsRoutes(services), { prefix: '/api' });
  await app.register(adminRoutes(services, opts.db, opts.adminToken), { prefix: '/api/admin' });

  if (opts.webDir) {
    // Single deployable: the server also serves the built SPA; unknown non-API GETs fall back to index.html.
    await app.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
    });
  }

  return app;
}
