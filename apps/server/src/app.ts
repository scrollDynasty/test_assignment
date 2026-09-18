import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db.js';
import { HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { VersionsService } from './modules/versions.js';

export interface AppOptions {
  db: Db;
  adminToken: string;
  logger?: boolean;
  /** Directory with the built web app; when set, the server also serves the SPA. */
  webDir?: string;
}

export interface Services {
  versions: VersionsService;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const services: Services = { versions: new VersionsService(opts.db) };

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
  await app.register(adminRoutes(services, opts.db, opts.adminToken), { prefix: '/api/admin' });

  return app;
}
