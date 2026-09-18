import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

/**
 * Access to the INTERNAL part of the product (TZ: "внутренняя страница", "внутренний dashboard"):
 * version management and analytics. The public funnel, sessions and event intake stay open by necessity.
 *
 * - Humans log in once with the access key and get a signed, HttpOnly, SameSite=Strict cookie (8 h);
 *   the key itself never lives in the page's JavaScript or localStorage.
 * - Scripts (traffic generator, publish CLI, demo) send the key in the `x-admin-token` header.
 */
export const SESSION_COOKIE = 'funnel_internal';
export const SESSION_TTL_MS = 8 * 3600_000;

/** Constant-time comparison that does not leak the length of the secret (both sides are hashed to 32 bytes). */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export interface Auth {
  keyMatches(given: unknown): boolean;
  /** Cookie value "expiresAt.signature"; the signing key is derived from the access key (rotating it logs everyone out). */
  issue(): { value: string; maxAgeSeconds: number };
  isAuthorized(req: FastifyRequest): boolean;
  /** Logged in through the browser (cookie only; the header is for scripts and is not a login check). */
  hasSession(req: FastifyRequest): boolean;
  /** Fastify hook: 401 unless the request carries a valid session cookie or the access key header. */
  guard(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function createAuth(accessKey: string, now: () => number = Date.now): Auth {
  const signingKey = createHmac('sha256', 'funnel-runtime/internal-session').update(accessKey).digest();
  const sign = (payload: string) => createHmac('sha256', signingKey).update(payload).digest('base64url');

  const validCookie = (value: string | undefined): boolean => {
    if (!value) return false;
    const [exp, sig] = value.split('.');
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    return safeEqual(sig, sign(exp)) && Number(exp) > now();
  };

  const auth: Auth = {
    keyMatches: (given) => typeof given === 'string' && safeEqual(given, accessKey),
    issue: () => {
      const exp = String(now() + SESSION_TTL_MS);
      return { value: `${exp}.${sign(exp)}`, maxAgeSeconds: SESSION_TTL_MS / 1000 };
    },
    isAuthorized: (req) => auth.keyMatches(req.headers['x-admin-token']) || validCookie(req.cookies[SESSION_COOKIE]),
    hasSession: (req) => validCookie(req.cookies[SESSION_COOKIE]),
    guard: async (req) => {
      if (!auth.isAuthorized(req)) throw new HttpError(401, 'unauthorized', 'Log in to the internal area (or send x-admin-token)');
    },
  };
  return auth;
}
