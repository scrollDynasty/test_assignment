import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { createAuth } from './auth.js';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { AnalyticsService } from './modules/analytics.js';
import { EventsService } from './modules/events.js';
import { SessionsService, sessionIdNamespace } from './modules/sessions.js';
import { VersionsService } from './modules/versions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { eventRoutes } from './routes/events.js';
import { sessionRoutes } from './routes/sessions.js';

export interface AppOptions {
  db: Db;
  adminToken: string;
  logger?: FastifyServerOptions['logger'];
  /** Directory with the built web app; when set, the server also serves the SPA. */
  webDir?: string;
  /**
   * Number of reverse-proxy hops to trust for X-Forwarded-For (one reverse proxy: 1). Never `true`: that trusts every hop,
   * so a client could spoof its IP with its own X-Forwarded-For header and bypass all rate limits.
   */
  trustProxy?: number;
  /** Requests per minute per IP on the public write API (sessions, events). */
  publicRateLimit?: number;
  /** Clock, injectable for tests (TTL). */
  now?: () => number;
  /** True once shutdown has begun: health answers 503 so the platform stops routing new traffic here. */
  draining?: () => boolean;
}

export interface Services {
  versions: VersionsService;
  sessions: SessionsService;
  events: EventsService;
  analytics: AnalyticsService;
}

/** Origin "https://a.b" vs Host "a.b[:443]": compared after URL normalisation (default ports dropped). */
function sameHost(origin: string, host: string): boolean {
  if (!URL.canParse(origin)) return false;
  const o = new URL(origin);
  return URL.canParse(`${o.protocol}//${host}`) && new URL(`${o.protocol}//${host}`).host === o.host;
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
  const sessions = new SessionsService(opts.db, versions, opts.now, sessionIdNamespace(opts.adminToken));
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
        fontSrc: ["'self'"],
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

  // Health includes the database: a machine with a broken volume must not report healthy. While draining (SIGTERM
  // received, in-flight requests finishing) it answers 503, and responses ask clients not to reuse the connection.
  app.get('/api/health', async (_req, reply) => {
    if (opts.draining?.()) return reply.status(503).send({ ok: false, draining: true });
    opts.db.prepare('SELECT 1').get();
    return { ok: true };
  });
  app.addHook('onSend', async (_req, reply) => {
    if (opts.draining?.()) reply.header('connection', 'close');
  });
  const auth = createAuth(opts.adminToken, opts.now);
  // Public write endpoints get a per-IP limit sized for people, not for load tests; requests carrying the access key
  // (the traffic generator, demo scripts) are exempt, so a load run never locks visitors out.
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        max: opts.publicRateLimit ?? 600,
        timeWindow: '1 minute',
        allowList: (req) => auth.keyMatches(req.headers['x-admin-token']),
      });
      await scope.register(sessionRoutes(services));
      await scope.register(eventRoutes(services));
    },
    { prefix: '/api' },
  );
  // Internal area: analytics and version management need a login.
  await app.register(fastifyCookie);
  // CSRF defence in depth on top of SameSite=Strict: state-changing internal requests must come from our own origin.
  // Modern browsers say so themselves in Sec-Fetch-Site (a sibling subdomain is "same-site", not "same-origin"); for
  // browsers without it, Origin is compared with Host. CLI scripts send neither (they authenticate with the key header).
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !/^\/api\/(admin|auth)\//.test(req.url)) return;
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    const foreign =
      site !== undefined ? site === 'cross-site' || site === 'same-site' : origin !== undefined && !sameHost(origin, req.host);
    if (foreign) {
      throw new HttpError(403, 'forbidden_origin', 'Cross-site request rejected');
    }
  });
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
