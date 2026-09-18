/**
 * Uploads a funnel config to a running server and (optionally) makes it active — no redeploy involved.
 *
 *   npm run publish-config -- funnel-v2.json                       # upload + publish
 *   npm run publish-config -- funnel-v2.json --upload-only
 *   npm run publish-config -- --rollback --funnel workstyle-planner
 *
 * Env: API_URL (default http://localhost:3000), ADMIN_TOKEN (default dev-admin-token).
 */
import { readFileSync } from 'node:fs';

const api = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api);
const token = process.env.ADMIN_TOKEN ?? (isLocal ? 'dev-admin-token' : '');
if (!token) {
  console.error('ADMIN_TOKEN is required for a non-local API_URL');
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${api}/api/admin${path}`, {
    method,
    headers: { 'x-admin-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON (e.g. a proxy error page): show it as text */
  }
  if (!res.ok) {
    console.error(`${method} ${path} -> ${res.status}`, JSON.stringify(json, null, 2));
    process.exit(1);
  }
  return json;
}

if (flag('--rollback')) {
  const funnel = option('--funnel') ?? 'workstyle-planner';
  console.log('rollback:', await call('POST', `/funnels/${funnel}/rollback`));
} else {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: publish-config <config.json> [--upload-only] | --rollback [--funnel id]');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(file, 'utf8')) as { funnelId: string; version: number };
  console.log('schema before:', await call('GET', '/schema'));
  console.log('upload:', await call('POST', `/funnels/${config.funnelId}/versions`, config));
  if (!flag('--upload-only')) {
    console.log('publish:', await call('POST', `/funnels/${config.funnelId}/versions/${config.version}/publish`));
  }
  console.log('schema after:', await call('GET', '/schema'));
}
