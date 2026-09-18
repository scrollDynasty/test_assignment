import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { storage } from '../lib/storage';
import { Nav } from '../Nav';

const FUNNEL = 'workstyle-planner';
const TOKEN_KEY = 'funnel:admin-token';

interface VersionSummary {
  version: number;
  experimentId: string;
  releaseNote: string | null;
  configHash: string;
  createdAt: string;
}
interface ReleaseEntry {
  id: number;
  action: 'publish' | 'rollback';
  fromVersion: number | null;
  toVersion: number;
  actor: string;
  createdAt: string;
}
interface VersionsResponse {
  activeVersion: number | null;
  versions: VersionSummary[];
  releases: ReleaseEntry[];
}

/**
 * Internal page for versions: upload a config, publish it (no redeploy), roll back, see the release log.
 * The schema fingerprint is shown to demonstrate that none of these actions changes the database schema.
 */
export function AdminPage() {
  const [token, setToken] = useState(storage.getJson<string>(TOKEN_KEY) ?? '');
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeConfig, setActiveConfig] = useState<string | null>(null);

  const headers = { 'x-admin-token': token };

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const h = { 'x-admin-token': token };
      const [versions, s] = await Promise.all([
        api.request<VersionsResponse>('GET', `/api/admin/funnels/${FUNNEL}/versions`, undefined, h),
        api.request<{ schemaHash: string }>('GET', '/api/admin/schema', undefined, h),
      ]);
      setData(versions);
      setSchema(s.schemaHash);
      if (versions.activeVersion !== null) {
        const cfg = await api.request<unknown>('GET', `/api/admin/funnels/${FUNNEL}/versions/${versions.activeVersion}`, undefined, h);
        setActiveConfig(JSON.stringify(cfg, null, 2));
      }
    } catch (e) {
      setData(null);
      setMessage({ kind: 'error', text: e instanceof ApiError && e.status === 401 ? 'Wrong admin token' : String(e) });
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await action();
      setMessage({ kind: 'ok', text: `${ok}: ${JSON.stringify(res)}` });
      await refresh();
    } catch (e) {
      const details = e instanceof ApiError && e.details ? ` ${JSON.stringify(e.details)}` : '';
      setMessage({ kind: 'error', text: `${e instanceof Error ? e.message : String(e)}${details}` });
    } finally {
      setBusy(false);
    }
  }

  function parseDraft(): { funnelId: string; version: number } & Record<string, unknown> {
    const parsed = JSON.parse(draft) as { funnelId: string; version: number } & Record<string, unknown>;
    if (parsed.funnelId !== FUNNEL) throw new Error(`This page manages "${FUNNEL}", the file is for "${parsed.funnelId}"`);
    return parsed;
  }

  const upload = (publish: boolean) =>
    run(async () => {
      const config = parseDraft();
      const up = await api.request('POST', `/api/admin/funnels/${FUNNEL}/versions`, config, headers);
      if (!publish) return up;
      return api.request('POST', `/api/admin/funnels/${FUNNEL}/versions/${config.version}/publish`, undefined, headers);
    }, publish ? 'Uploaded and published' : 'Uploaded');

  return (
    <div className="page">
      <Nav />
      <header className="page-head">
        <div>
          <h1>Versions</h1>
          <p className="muted">
            Publishing changes only which version <b>new</b> sessions start on. Sessions already in progress stay on the version they started
            with, also after a rollback.
          </p>
        </div>
        <label className="token">
          Admin token
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              storage.setJson(TOKEN_KEY, e.target.value);
            }}
            placeholder="x-admin-token"
          />
        </label>
      </header>

      {message && <pre className={`message ${message.kind}`}>{message.text}</pre>}

      {data && (
        <>
          <section className="card">
            <div className="row">
              <h2>
                Active version: <span className="active-version">v{data.activeVersion ?? '—'}</span>
              </h2>
              <button
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Roll back the last publish? Sessions already started stay on their version.')) {
                    void run(() => api.request('POST', `/api/admin/funnels/${FUNNEL}/rollback`, undefined, headers), 'Rolled back');
                  }
                }}
              >
                Roll back last publish
              </button>
            </div>
            <p className="muted small">
              DB schema fingerprint: <code>{schema}</code>
            </p>
            {activeConfig && (
              <details>
                <summary>Active config (v{data.activeVersion}) as published</summary>
                <pre>{activeConfig}</pre>
              </details>
            )}
            <table>
              <thead>
                <tr><th>Version</th><th>Experiment</th><th>Release note</th><th>Uploaded</th><th>Hash</th><th /></tr>
              </thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.version} className={v.version === data.activeVersion ? 'current' : ''}>
                    <td>v{v.version}{v.version === data.activeVersion && <span className="badge">active</span>}</td>
                    <td><code>{v.experimentId}</code></td>
                    <td>{v.releaseNote ?? '—'}</td>
                    <td>{new Date(v.createdAt).toLocaleString()}</td>
                    <td><code>{v.configHash.slice(0, 10)}</code></td>
                    <td>
                      {v.version !== data.activeVersion && (
                        <button
                          disabled={busy}
                          onClick={() => void run(() => api.request('POST', `/api/admin/funnels/${FUNNEL}/versions/${v.version}/publish`, undefined, headers), `Published v${v.version}`)}
                        >
                          Publish
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2>Upload a config</h2>
            <p className="muted small">The config is validated before it is stored; an invalid one is rejected and nothing changes.</p>
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setDraft(await file.text());
              }}
            />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="…or paste JSON here" rows={8} />
            <div className="row">
              <button disabled={busy || !draft} onClick={() => void upload(false)}>Upload</button>
              <button className="primary" disabled={busy || !draft} onClick={() => void upload(true)}>Upload and publish</button>
            </div>
          </section>

          <section className="card">
            <h2>Release log</h2>
            <table>
              <thead><tr><th>#</th><th>Action</th><th>From</th><th>To</th><th>By</th><th>When</th></tr></thead>
              <tbody>
                {[...data.releases].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td><td>{r.action}</td><td>{r.fromVersion === null ? '—' : `v${r.fromVersion}`}</td>
                    <td>v{r.toVersion}</td><td>{r.actor}</td><td>{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
