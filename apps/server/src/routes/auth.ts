import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, type Auth } from '../auth.js';
import { HttpError } from '../errors.js';

const LoginBody = z.object({ key: z.string().min(1).max(512) });

/** Login / logout / "am I logged in" for the internal pages. */
export const authRoutes =
  (auth: Auth): FastifyPluginAsync =>
  async (app) => {
    // Brute force protection on the login route only (20/min per IP); /auth/me and logout are not limited by it.
    await app.register(rateLimit, { global: false });

    app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { key } = LoginBody.parse(req.body);
      if (!auth.keyMatches(key)) throw new HttpError(401, 'invalid_key', 'Invalid access key');
      const session = auth.issue();
      reply.setCookie(SESSION_COOKIE, session.value, {
        path: '/api',
        httpOnly: true,
        sameSite: 'strict',
        // Always Secure in production, even if a misconfigured proxy makes the request look like plain http.
        secure: process.env.NODE_ENV === 'production' || req.protocol === 'https',
        maxAge: session.maxAgeSeconds,
      });
      return { authenticated: true };
    });

    app.post('/auth/logout', async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/api' });
      return { authenticated: false };
    });

    // Cookie only: answering for the x-admin-token header here would give an unlimited key-guessing oracle.
    app.get('/auth/me', async (req) => ({ authenticated: auth.hasSession(req) }));
  };
