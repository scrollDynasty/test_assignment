import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createAuth } from './auth.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { AnalyticsService } from './modules/analytics.js';
import { EventsService } from './modules/events.js';
import { SessionsService } from './modules/sessions.js';
import { VersionsService } from './modules/versions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: Db;
  adminToken: string;
  logger?: boolean;
  /** Directory with the built web app; when set, the server also serves the SPA. */
  webDir?: string;
  /**
   * Number of reverse-proxy hops to trust for X-Forwarded-For (Fly.io: 1). Never `true`: that trusts every hop,
   * so a client could spoof its IP with its own X-Forwarded-For header and bypass all rate limits.
   */
  trustProxy?: number;
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
  const hops = opts.trustProxy ?? 0;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 512 * 1024,
    // Trust only the first `hops` proxies: req.ip is the address that proxy saw, not a client-supplied header value.
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });
  const versions = new VersionsService(opts.db, opts.now);
  const sessions = new SessionsService(opts.db, versions, opts.now);
  const services: Services = {
    versions,
    sessions,
    events: new EventsService(opts.db, sessions, opts.now),
    analytics: new AnalyticsService(opts.db, versions, opts.now),
  };

  // Security headers. CSP allows only our own scripts/styles/API (React sets inline style attributes → 'unsafe-inline'
  // for styles only); frame-ancestors 'none' stops clickjacking of the internal Publish/Rollback buttons.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: 'Invalid request', details: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code: Record<number, string> = { 401: 'unauthorized', 404: 'not_found', 413: 'payload_too_large', 415: 'unsupported_media_type', 429: 'rate_limited' };
      return reply.status(status).send({ error: code[status] ?? 'bad_request', message: (err as Error).message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  // Health includes the database: a machine with a broken volume must not report healthy.
  app.get('/api/health', async () => {
    opts.db.prepare('SELECT 1').get();
    return { ok: true };
  });
  // Public write endpoints get a per-IP limit; generous enough for the traffic generator from one machine.
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, { max: opts.publicRateLimit ?? 3000, timeWindow: '1 minute' });
      await scope.register(sessionRoutes(services));
      await scope.register(eventRoutes(services));
    },
    { prefix: '/api' },
  );
  // Internal area (TZ: "внутренняя страница", "внутренний dashboard"): analytics and version management need a login.
  const auth = createAuth(opts.adminToken, opts.now);
  await app.register(fastifyCookie);
  await app.register(authRoutes(auth), { prefix: '/api' });
  await app.register(analyticsRoutes(services, auth), { prefix: '/api' });
  await app.register(adminRoutes(services, opts.db, auth), { prefix: '/api/admin' });

  if (opts.webDir) {
    // Single deployable: the server also serves the built SPA; unknown non-API GETs fall back to index.html.
    await app.register(fastifyStatic, {
      root: opts.webDir,
      wildcard: false,
      // Vite puts content hashes in asset names: cache them for a year; index.html itself is never cached.
      setHeaders: (res, path) => {
        res.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // App routes fall back to index.html; a missing /assets/* file is a real 404 (not HTML with status 200).
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Route not found' });
    });
  }

  return app;
}
