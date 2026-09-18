import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { ApiError, api } from '../lib/api';
import { Nav } from '../Nav';

type Status = 'checking' | 'in' | 'out';

/**
 * The internal area (analytics, versions) is behind a login. The access key is sent once; the server answers with
 * an HttpOnly session cookie, so the key is never stored in the browser and page scripts cannot read the session.
 */
export function InternalGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>('checking');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .request<{ authenticated: boolean }>('GET', '/api/auth/me')
      .then((r) => setStatus(r.authenticated ? 'in' : 'out'))
      .catch(() => setStatus('out'));
  }, []);

  const login = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request('POST', '/api/auth/login', { key });
      setKey('');
      setStatus('in');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? t('login.invalid') : e instanceof ApiError && e.status === 429 ? t('login.tooMany') : t('login.network'));
    } finally {
      setBusy(false);
    }
  }, [key, t]);

  if (status === 'checking') return <div className="spinner" role="status" aria-label={t('funnel.loading')} />;
  if (status === 'in') return <>{children}</>;
  return (
    <div className="page">
      <Nav internal={false} />
      <form
        className="card login"
        onSubmit={(e) => {
          e.preventDefault();
          void login();
        }}
      >
        <h1>{t('login.title')}</h1>
        <p className="muted">{t('login.help')}</p>
        <label className="token">
          {t('login.key')}
          <input type="password" autoComplete="current-password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy || !key}>
          {t('login.submit')}
        </button>
      </form>
    </div>
  );
}

export async function logout(): Promise<void> {
  await api.request('POST', '/api/auth/logout').catch(() => undefined);
  window.location.assign('/internal/analytics');
}
