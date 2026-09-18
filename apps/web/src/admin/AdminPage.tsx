import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { ApiError, api } from '../lib/api';
import { Nav } from '../Nav';

const FUNNEL = 'workstyle-planner';

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
/** Authenticated by the internal session cookie (see InternalGate): no access key in page code or browser storage. */
export function AdminPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const when = (iso: string) => new Date(iso).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB');

  const refresh = useCallback(async () => {
    try {
      const [versions, s] = await Promise.all([
        api.request<VersionsResponse>('GET', `/api/admin/funnels/${FUNNEL}/versions`),
        api.request<{ schemaHash: string }>('GET', '/api/admin/schema'),
      ]);
      setData(versions);
      setSchema(s.schemaHash);
      if (versions.activeVersion !== null) {
        const cfg = await api.request<unknown>('GET', `/api/admin/funnels/${FUNNEL}/versions/${versions.activeVersion}`);
        setActiveConfig(JSON.stringify(cfg, null, 2));
      }
    } catch (e) {
      // The internal login expired: reload so the gate shows the login form.
      if (e instanceof ApiError && e.status === 401) return window.location.reload();
      // Keep what is already on screen; only report the failure.
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ kind: 'ok', text: ok });
      await refresh(); // a refresh failure replaces the success message with its own error
    } catch (e) {
      const details = e instanceof ApiError && e.details ? ` ${JSON.stringify(e.details)}` : '';
      setMessage({ kind: 'error', text: `${e instanceof Error ? e.message : String(e)}${details}` });
    } finally {
      setBusy(false);
    }
  }

  function parseDraft(): { funnelId: string; version: number } & Record<string, unknown> {
    const parsed = JSON.parse(draft) as { funnelId: string; version: number } & Record<string, unknown>;
    if (parsed.funnelId !== FUNNEL) throw new Error(t('admin.wrongFunnel', { expected: FUNNEL, actual: String(parsed.funnelId) }));
    return parsed;
  }

  const upload = (publish: boolean) =>
    run(async () => {
      const config = parseDraft();
      const up = await api.request('POST', `/api/admin/funnels/${FUNNEL}/versions`, config);
      if (!publish) return up;
      return api.request('POST', `/api/admin/funnels/${FUNNEL}/versions/${config.version}/publish`);
    }, publish ? t('admin.okUploadedPublished') : t('admin.okUploaded'));

  return (
    <div className="page">
      <Nav />
      <header className="page-head">
        <div>
          <h1>{t('admin.title')}</h1>
          <p className="muted">{t('admin.subtitle')}</p>
        </div>
      </header>

      {message && <pre className={`message ${message.kind}`}>{message.text}</pre>}

      {!data && !message && <div className="spinner" role="status" aria-label={t('funnel.loading')} />}
      {data && (
        <>
          <section className="card">
            <div className="row">
              <h2>
                {t('admin.active')} <span className="active-version">v{data.activeVersion ?? '—'}</span>
              </h2>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('admin.rollbackConfirm'))) {
                    void run(() => api.request('POST', `/api/admin/funnels/${FUNNEL}/rollback`), t('admin.okRolledBack'));
                  }
                }}
              >
                {t('admin.rollback')}
              </button>
            </div>
            <p className="muted small">
              {t('admin.schema')} <code>{schema}</code>
            </p>
            {activeConfig && (
              <details>
                <summary>{t('admin.activeConfig', { version: data.activeVersion ?? '—' })}</summary>
                <pre>{activeConfig}</pre>
              </details>
            )}
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('admin.colVersion')}</th><th>{t('admin.colExperiment')}</th><th>{t('admin.colNote')}</th>
                  <th>{t('admin.colUploaded')}</th><th>{t('admin.colHash')}</th><th />
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => (
                  <tr key={v.version} className={v.version === data.activeVersion ? 'current' : ''}>
                    <td>v{v.version}{v.version === data.activeVersion && <span className="badge">{t('admin.badgeActive')}</span>}</td>
                    <td><code>{v.experimentId}</code></td>
                    <td>{v.releaseNote ?? '—'}</td>
                    <td>{when(v.createdAt)}</td>
                    <td><code>{v.configHash.slice(0, 10)}</code></td>
                    <td>
                      {v.version !== data.activeVersion && (
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => api.request('POST', `/api/admin/funnels/${FUNNEL}/versions/${v.version}/publish`),
                              t('admin.okPublished', { version: v.version }),
                            )
                          }
                        >
                          {t('admin.publish')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>

          <section className="card">
            <h2>{t('admin.uploadTitle')}</h2>
            <p className="muted small">{t('admin.uploadHelp')}</p>
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setDraft(await file.text());
              }}
            />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('admin.paste')} rows={8} />
            <div className="row">
              <button className="btn" disabled={busy || !draft} onClick={() => void upload(false)}>{t('admin.upload')}</button>
              <button className="primary" disabled={busy || !draft} onClick={() => void upload(true)}>{t('admin.uploadPublish')}</button>
            </div>
          </section>

          <section className="card">
            <h2>{t('admin.log')}</h2>
            <div className="table-wrap">
            <table>
              <thead>
                <tr><th>#</th><th>{t('admin.colAction')}</th><th>{t('admin.colFrom')}</th><th>{t('admin.colTo')}</th><th>{t('admin.colBy')}</th><th>{t('admin.colWhen')}</th></tr>
              </thead>
              <tbody>
                {[...data.releases].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td><td>{t(`admin.action.${r.action}`)}</td><td>{r.fromVersion === null ? '—' : `v${r.fromVersion}`}</td>
                    <td>v{r.toVersion}</td><td>{r.actor}</td><td>{when(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
