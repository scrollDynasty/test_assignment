import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AbTest, AnalyticsReport, VariantReport } from '@funnel/shared';
import { useI18n } from '../i18n';
import { ApiError, api } from '../lib/api';
import { Nav } from '../Nav';

const FUNNEL = 'workstyle-planner';

const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
const ci = (c: [number, number] | null | undefined) => (c ? `${pct(c[0])} … ${pct(c[1])}` : '—');

/**
 * Internal analytics dashboard (behind the internal login). Everything is counted in unique sessions
 * (see README "Правила агрегации"). Filters live in the URL, so a view can be shared as a link.
 */
export function DashboardPage() {
  const { t, lang, plural } = useI18n();
  /** Only the latest request may update the page: fast filter changes must not show an older response. */
  const requestSeq = useRef(0);
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const version = params.get('version') ?? '';
  const campaign = params.get('utm_campaign') ?? '';
  const includeOverrides = params.get('include_overrides') === 'true';
  const inProgressWindow = params.get('in_progress_minutes') ?? '30';

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const q = new URLSearchParams({ funnelId: FUNNEL });
    if (version) q.set('version', version);
    if (campaign) q.set('utm_campaign', campaign);
    if (includeOverrides) q.set('include_overrides', 'true');
    q.set('in_progress_minutes', inProgressWindow);
    try {
      const next = await api.request<AnalyticsReport>('GET', `/api/analytics?${q.toString()}`);
      if (seq !== requestSeq.current) return;
      setReport(next);
      setError(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      // The 8-hour login expired: reload so the gate shows the login form instead of a raw error.
      if (e instanceof ApiError && e.status === 401) return window.location.reload();
      setError(t('dash.loadError'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [version, campaign, includeOverrides, inProgressWindow, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const selected = report?.selected;
  const variantEntries = selected ? Object.entries(selected.variants) : [];
  const inProgressTotal = selected ? Object.values(selected.variants).reduce((s, v) => s + v.inProgress, 0) : 0;

  return (
    <div className="page">
      <Nav />
      <header className="page-head">
        <div>
          <h1>{t('dash.title')}</h1>
          <p className="muted">{t('dash.subtitle')}</p>
        </div>
        <div className="filters">
          <label>
            {t('dash.version')}
            <select value={version || String(report?.filters.version ?? '')} onChange={(e) => setFilter('version', e.target.value)}>
              {(report?.availableVersions ?? []).map((v) => (
                <option key={v} value={v}>v{v}</option>
              ))}
            </select>
          </label>
          <label>
            {t('dash.campaign')}
            <select value={campaign} onChange={(e) => setFilter('utm_campaign', e.target.value)}>
              <option value="">{t('dash.allCampaigns')}</option>
              {(report?.availableCampaigns ?? []).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label title={t('dash.windowHint')}>
            {t('dash.window')}
            <select value={inProgressWindow} onChange={(e) => setFilter('in_progress_minutes', e.target.value === '30' ? '' : e.target.value)}>
              <option value="30">{t('dash.window30')}</option>
              <option value="0">{t('dash.window0')}</option>
              <option value="1440">{t('dash.window1440')}</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={includeOverrides} onChange={(e) => setFilter('include_overrides', e.target.checked ? 'true' : '')} />
            {t('dash.includeOverrides')}
          </label>
          <button onClick={() => void load()} disabled={loading}>{loading ? t('dash.loading') : t('dash.refresh')}</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {!report && !error && <div className="spinner" />}

      {report && selected && report.filters.inProgressMinutes > 0 && inProgressTotal > 0 && (
        <p className="notice">
          {t('dash.notice', { n: inProgressTotal, minutes: report.filters.inProgressMinutes, sessions: t(`dash.session.${plural(inProgressTotal)}`) })}{' '}
          <button className="link" onClick={() => setFilter('in_progress_minutes', '0')}>
            {t('dash.noticeAction')}
          </button>{' '}
          {t('dash.noticeTail')}
        </p>
      )}

      {report && selected && (
        <>
          <section>
            <h2>
              v{selected.version} · {t('dash.experiment')} <code>{selected.experimentId}</code>
            </h2>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <Kpis key={name} name={name} v={v} />
              ))}
            </div>
          </section>

          {selected.abTest && <AbCard ab={selected.abTest} />}

          <section>
            <h2>{t('dash.stepsTitle')}</h2>
            <p className="muted">{t('dash.stepsHelp')}</p>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <StepTable key={name} name={name} v={v} />
              ))}
            </div>
          </section>

          <section>
            <h2>{t('dash.resultMix')}</h2>
            <p className="muted">{t('dash.resultMixHelp')}</p>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <div key={name} className="card">
                  <h3>{t('dash.variant', { name })}</h3>
                  <Bars data={v.resultMix} total={v.reachedResult} />
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {report && (
        <>
          <section>
            <h2>{t('dash.versions')}</h2>
            <p className="muted">{t('dash.versionsHelp')}</p>
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('dash.version')}</th><th>{t('dash.experiment')}</th><th>{t('dash.started')}</th><th>{t('dash.inProgress')}</th>
                  <th>{t('dash.reached')}</th><th>{t('dash.completion')}</th><th>{t('dash.ctrShort')}</th><th>{t('dash.startToCta')}</th>
                </tr>
              </thead>
              <tbody>
                {report.versions.map((v) => (
                  <tr key={v.version} className={v.version === selected?.version ? 'current' : ''}>
                    <td>v{v.version}</td><td><code>{v.experimentId}</code></td><td>{v.started}</td><td>{v.inProgress}</td>
                    <td>{v.reachedResult}</td><td>{pct(v.completion)}</td><td>{pct(v.ctr)}</td><td>{pct(v.startToCta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>

          {selected && selected.otherEvents.length > 0 && (
            <section>
              <h2>{t('dash.otherEvents')}</h2>
              <table>
                <thead><tr><th>{t('dash.event')}</th><th>{t('dash.sessions')}</th><th>{t('dash.byVariant')}</th></tr></thead>
                <tbody>
                  {selected.otherEvents.map((e) => (
                    <tr key={e.name}>
                      <td><code>{e.name}</code></td><td>{e.sessions}</td>
                      <td>
                        {Object.entries(e.byVariant)
                          .map(([k, n]) => {
                            const cta = selected.variants[k]?.ctaClicked ?? 0;
                            return `${k}: ${n}${cta ? ` (${pct(n / cta, 0)})` : ''}`;
                          })
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h2>{t('dash.quality')}</h2>
            <div className="kpis">
              <Kpi label={t('dash.stored')} value={report.ingestion.rawEvents} />
              <Kpi label={t('dash.accepted')} value={report.ingestion.accepted} />
              <Kpi label={t('dash.duplicates')} value={report.ingestion.duplicates} />
              <Kpi label={t('dash.rejected')} value={report.ingestion.rejected} />
            </div>
            {Object.keys(report.ingestion.rejectedReasons).length > 0 && (
              <p className="muted">
                {t('dash.rejectedBy', { list: Object.entries(report.ingestion.rejectedReasons).map(([r, n]) => `${r} × ${n}`).join(', ') })}
              </p>
            )}
            <p className="muted">{t('dash.generated', { time: new Date(report.generatedAt).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB') })}</p>
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

function Kpis({ name, v }: { name: string; v: VariantReport }) {
  const { t } = useI18n();
  return (
    <div className="card">
      <h3>{t('dash.variant', { name })}</h3>
      <div className="kpis">
        <Kpi label={t('dash.started')} value={v.started} />
        <Kpi label={t('dash.inProgress')} value={v.inProgress} />
        <Kpi label={t('dash.reached')} value={`${v.reachedResult} · ${pct(v.completion)}`} />
        <Kpi label={t('dash.ctr')} value={pct(v.ctr)} hint={t('dash.ctrHint')} />
        <Kpi label={t('dash.startToCta')} value={pct(v.startToCta)} hint={t('dash.startToCtaHint')} />
        <Kpi label={t('dash.back')} value={pct(v.backRate)} />
      </div>
      <p className={`muted small ${v.invariantOk ? '' : 'error'}`}>
        {v.invariantOk ? '✓' : '✗'} {t('dash.invariant', { before: v.beforeFirstStep, table: v.sessionsInTable, server: v.serverCompleted })}
      </p>
    </div>
  );
}

function StepTable({ name, v }: { name: string; v: VariantReport }) {
  const { t } = useI18n();
  const maxViewed = Math.max(1, v.started);
  return (
    <div className="card">
      <h3>{t('dash.variant', { name })}</h3>
      <div className="table-wrap">
      <table className="steps">
        <thead>
          <tr><th>{t('dash.step')}</th><th>{t('dash.viewed')}</th><th>{t('dash.passed')}</th><th>{t('dash.conv')}</th><th>{t('dash.reach')}</th><th>{t('dash.dropoff')}</th></tr>
        </thead>
        <tbody>
          {v.steps.map((s) => (
            <tr key={s.stepId}>
              <td>
                {s.stepId}
                {s.conditional && <span className="badge" title={t('dash.conditionalHint')}>{t('dash.conditional')}</span>}
              </td>
              <td>{s.viewed}</td>
              <td>{s.passed ?? '—'}</td>
              <td>{pct(s.stepConversion, 0)}</td>
              <td>
                <div className="bar"><div style={{ width: `${(s.viewed / maxViewed) * 100}%` }} /></div>
              </td>
              <td className={s.dropoff > 0 ? 'drop' : ''}>{s.dropoff}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {v.beforeFirstStep > 0 && <p className="muted small">{t('dash.beforeFirst', { n: v.beforeFirstStep })}</p>}
    </div>
  );
}

function AbCard({ ab }: { ab: AbTest }) {
  const { t } = useI18n();
  return (
    <section>
      <h2>{t('dash.abTitle')}</h2>
      <div className="card ab">
        <div className="kpis">
          <Kpi label={`${t('dash.variant', { name: ab.a.variant })} (${ab.a.conversions}/${ab.a.sessions})`} value={pct(ab.a.rate)} hint={ci(ab.a.ci)} />
          <Kpi label={`${t('dash.variant', { name: ab.b.variant })} (${ab.b.conversions}/${ab.b.sessions})`} value={pct(ab.b.rate)} hint={ci(ab.b.ci)} />
          <Kpi label={t('dash.abDiff', { a: ab.a.variant, b: ab.b.variant })} value={`${ab.diff >= 0 ? '+' : ''}${(ab.diff * 100).toFixed(1)} ${t('dash.pp')}`} />
          <Kpi label={t('dash.pValue')} value={ab.pValue.toFixed(3)} />
        </div>
        <ul className="notes">
          <li>{t('dash.ci', { a: ab.a.variant, aci: ci(ab.a.ci), b: ab.b.variant, bci: ci(ab.b.ci), dci: ci(ab.diffCi) })}</li>
          {Math.min(ab.a.sessions, ab.b.sessions) < 30 && <li className="error">{t('dash.smallSample')}</li>}
          <li>
            <b>{ab.significant ? t('dash.significant') : t('dash.notSignificant')}</b>{' '}
            {t('dash.mde', { mde: ab.mde === null ? '—' : `${(ab.mde * 100).toFixed(0)} ${t('dash.pp')}` })}
          </li>
          {ab.srm && (
            <li className={ab.srm.ok ? '' : 'error'}>
              {t('dash.srm', {
                observed: Object.entries(ab.srm.observed).map(([k, n]) => `${k} ${n}`).join(' / '),
                expected: Object.entries(ab.srm.expectedShare).map(([k, s]) => `${k} ${pct(s, 0)}`).join(' / '),
                p: ab.srm.pValue.toFixed(3),
              })}{' '}
              {ab.srm.ok ? t('dash.srmOk') : t('dash.srmBad')}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

function Bars({ data, total }: { data: Record<string, number>; total: number }) {
  const { t } = useI18n();
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <p className="muted">{t('dash.noResults')}</p>;
  return (
    <div className="bars">
      {entries.map(([k, n]) => (
        <div key={k} className="bars-row">
          <span className="bars-label">{k}</span>
          <div className="bar"><div style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></div>
          <span className="bars-value">{n} · {pct(total ? n / total : null, 0)}</span>
        </div>
      ))}
    </div>
  );
}
