import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { ADMIN, FUNNEL, uploadAndPublish } from './helpers.js';

/** Internal area = analytics + version management (TZ: "внутренняя страница", "внутренний dashboard"). */
describe('internal area access', () => {
  async function setup() {
    let clock = Date.now();
    const app = await buildApp({ db: openDb(':memory:'), adminToken: 'test-token', now: () => clock });
    await uploadAndPublish(app, 1);
    return { app, advance: (ms: number) => (clock += ms) };
  }
  const analytics = `/api/analytics?funnelId=${FUNNEL}`;

  it('the public funnel and event intake need no login; analytics and admin do', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: { funnelId: FUNNEL } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/events', payload: { events: [{}] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: analytics })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/admin/schema' })).statusCode).toBe(401);
    // Scripts use the key header.
    expect((await app.inject({ method: 'GET', url: analytics, headers: ADMIN })).statusCode).toBe(200);
    await app.close();
  });

  it('login with the key sets an HttpOnly, SameSite=Strict session cookie that opens the internal API', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'wrong' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'test-token' } });
    expect(login.statusCode).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\/api/);
    expect(setCookie).not.toContain('test-token'); // the key itself never goes into the cookie
    const cookie = setCookie.split(';')[0] as string;

    expect((await app.inject({ method: 'GET', url: analytics, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/admin/schema', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json()).toEqual({ authenticated: true });

    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(String(logout.headers['set-cookie'])).toMatch(/funnel_internal=;/);
    await app.close();
  });

  it('a tampered or expired session cookie is rejected', async () => {
    const { app, advance } = await setup();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'test-token' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    const [name, value] = cookie.split('=') as [string, string];
    const [exp, sig] = value.split('.') as [string, string];
    const forged = `${name}=${Number(exp) + 999_999_999}.${sig}`;
    expect((await app.inject({ method: 'GET', url: analytics, headers: { cookie: forged } })).statusCode).toBe(401);
    advance(9 * 3600_000); // sessions last 8 hours
    expect((await app.inject({ method: 'GET', url: analytics, headers: { cookie } })).statusCode).toBe(401);
    await app.close();
  });
});
