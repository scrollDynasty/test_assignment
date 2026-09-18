import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AbTest, AnalyticsReport, VariantReport } from '@funnel/shared';
import { api } from '../lib/api';
import { Nav } from '../Nav';

const FUNNEL = 'workstyle-planner';

const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
const ci = (c: [number, number] | null | undefined) => (c ? `${pct(c[0])} … ${pct(c[1])}` : '—');

/**
 * Internal analytics dashboard. Everything is counted in unique sessions (see README "Aggregation rules").
 * Public and read-only: it shows aggregates only; version management lives on /admin behind a token.
 */
export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const version = params.get('version') ?? '';
  const campaign = params.get('utm_campaign') ?? '';
  const includeOverrides = params.get('include_overrides') === 'true';
  const inProgressWindow = params.get('in_progress_minutes') ?? '30';

  const load = useCallback(async () => {
    setLoading(true);
    const q = new URLSearchParams({ funnelId: FUNNEL });
    if (version) q.set('version', version);
    if (campaign) q.set('utm_campaign', campaign);
    if (includeOverrides) q.set('include_overrides', 'true');
    q.set('in_progress_minutes', inProgressWindow);
    try {
      setReport(await api.request<AnalyticsReport>('GET', `/api/analytics?${q.toString()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [version, campaign, includeOverrides, inProgressWindow]);

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

  return (
    <div className="page">
      <Nav />
      <header className="page-head">
        <div>
          <h1>Funnel analytics</h1>
          <p className="muted">All numbers are unique sessions. Duplicates, repeat views, back navigation and out-of-order events do not change them.</p>
        </div>
        <div className="filters">
          <label>
            Version
            <select value={version || String(report?.filters.version ?? '')} onChange={(e) => setFilter('version', e.target.value)}>
              {(report?.availableVersions ?? []).map((v) => (
                <option key={v} value={v}>v{v}</option>
              ))}
            </select>
          </label>
          <label>
            UTM campaign
            <select value={campaign} onChange={(e) => setFilter('utm_campaign', e.target.value)}>
              <option value="">All campaigns</option>
              {(report?.availableCampaigns ?? []).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label title="Unfinished sessions active within this window are shown as in progress instead of drop-off">
            In progress if active within
            <select value={inProgressWindow} onChange={(e) => setFilter('in_progress_minutes', e.target.value === '30' ? '' : e.target.value)}>
              <option value="30">30 min (live traffic)</option>
              <option value="0">off: every unfinished session is a drop-off</option>
              <option value="1440">24 hours</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={includeOverrides} onChange={(e) => setFilter('include_overrides', e.target.checked ? 'true' : '')} />
            Include forced ?variant= sessions
          </label>
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {!report && !error && <div className="spinner" />}

      {report && selected && (
        <>
          <section>
            <h2>
              v{selected.version} · experiment <code>{selected.experimentId}</code>
            </h2>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <Kpis key={name} name={name} v={v} />
              ))}
            </div>
          </section>

          {selected.abTest && <AbCard ab={selected.abTest} />}

          <section>
            <h2>Funnel by step</h2>
            <p className="muted">
              Step order is the variant&apos;s own. <b>Conversion</b> = passed / viewed. <b>Reach</b> = viewed / started.
              <b> Drop-off</b> = sessions whose furthest step was this one and that did not reach the result (sessions active within
              the selected window are &quot;in progress&quot;, not drop-off). Conditional steps are only shown to part of the users.
            </p>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <StepTable key={name} name={name} v={v} />
              ))}
            </div>
          </section>

          <section>
            <h2>Result mix</h2>
            <p className="muted">B only reorders questions and reframes results, so the result distribution should be similar in A and B.</p>
            <div className="variant-grid">
              {variantEntries.map(([name, v]) => (
                <div key={name} className="card">
                  <h3>Variant {name}</h3>
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
            <h2>Versions</h2>
            <p className="muted">Each version runs its own experiment over a different period, so this comparison is observational.</p>
            <table>
              <thead>
                <tr>
                  <th>Version</th><th>Experiment</th><th>Started</th><th>In progress</th><th>Reached result</th><th>Completion</th><th>CTR</th><th>Start → CTA</th>
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
          </section>

          {selected && selected.otherEvents.length > 0 && (
            <section>
              <h2>Other events of this version</h2>
              <table>
                <thead><tr><th>Event</th><th>Sessions</th><th>By variant</th></tr></thead>
                <tbody>
                  {selected.otherEvents.map((e) => (
                    <tr key={e.name}>
                      <td><code>{e.name}</code></td><td>{e.sessions}</td>
                      <td>{Object.entries(e.byVariant).map(([k, n]) => `${k}: ${n}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h2>Data quality</h2>
            <div className="kpis">
              <Kpi label="Stored events (this view)" value={report.ingestion.rawEvents} />
              <Kpi label="Accepted (all batches)" value={report.ingestion.accepted} />
              <Kpi label="Duplicates dropped" value={report.ingestion.duplicates} />
              <Kpi label="Rejected" value={report.ingestion.rejected} />
            </div>
            {Object.keys(report.ingestion.rejectedReasons).length > 0 && (
              <p className="muted">
                Rejected by reason: {Object.entries(report.ingestion.rejectedReasons).map(([r, n]) => `${r} × ${n}`).join(', ')}
              </p>
            )}
            <p className="muted">Generated {new Date(report.generatedAt).toLocaleString()}</p>
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
  return (
    <div className="card">
      <h3>Variant {name}</h3>
      <div className="kpis">
        <Kpi label="Started" value={v.started} />
        <Kpi label="In progress" value={v.inProgress} />
        <Kpi label="Reached result" value={`${v.reachedResult} · ${pct(v.completion)}`} />
        <Kpi label="CTA CTR" value={pct(v.ctr)} hint="CTA clicks / sessions that reached the result" />
        <Kpi label="Start → CTA" value={pct(v.startToCta)} hint="Primary metric" />
        <Kpi label="Used Back" value={pct(v.backRate)} />
      </div>
      <p className={`muted small ${v.invariantOk ? '' : 'error'}`}>
        {v.invariantOk ? '✓' : '✗'} drop-offs + before first step ({v.beforeFirstStep}) + reached + in progress = started ·
        server-completed: {v.serverCompleted}
      </p>
    </div>
  );
}

function StepTable({ name, v }: { name: string; v: VariantReport }) {
  const maxViewed = Math.max(1, v.started);
  return (
    <div className="card">
      <h3>Variant {name}</h3>
      <table className="steps">
        <thead>
          <tr><th>Step</th><th>Viewed</th><th>Passed</th><th>Conv.</th><th>Reach</th><th>Drop-off</th></tr>
        </thead>
        <tbody>
          {v.steps.map((s) => (
            <tr key={s.stepId}>
              <td>
                {s.stepId}
                {s.conditional && <span className="badge" title="Shown only for some answers">conditional</span>}
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
      {v.beforeFirstStep > 0 && <p className="muted small">Left before the first screen: {v.beforeFirstStep}</p>}
    </div>
  );
}

function AbCard({ ab }: { ab: AbTest }) {
  return (
    <section>
      <h2>A/B test · primary metric: start → CTA</h2>
      <div className="card ab">
        <div className="kpis">
          <Kpi label={`Variant ${ab.a.variant} (${ab.a.conversions}/${ab.a.sessions})`} value={pct(ab.a.rate)} hint={`95% CI ${ci(ab.a.ci)}`} />
          <Kpi label={`Variant ${ab.b.variant} (${ab.b.conversions}/${ab.b.sessions})`} value={pct(ab.b.rate)} hint={`95% CI ${ci(ab.b.ci)}`} />
          <Kpi label={`Difference ${ab.b.variant} − ${ab.a.variant}`} value={`${ab.diff >= 0 ? '+' : ''}${(ab.diff * 100).toFixed(1)} pp`} />
          <Kpi label="p-value" value={ab.pValue.toFixed(3)} />
        </div>
        <ul className="notes">
          <li>95% CI: {ab.a.variant} {ci(ab.a.ci)}; {ab.b.variant} {ci(ab.b.ci)}; difference {ci(ab.diffCi)}.</li>
          {Math.min(ab.a.sessions, ab.b.sessions) < 30 && (
            <li className="error">Fewer than 30 sessions in an arm: too little data to draw any conclusion, whatever the p-value says.</li>
          )}
          <li>
            {ab.significant ? <b>Statistically significant at 5%.</b> : <b>Not significant at 5%.</b>} With this sample the smallest reliably
            detectable difference is about {ab.mde === null ? '—' : `${(ab.mde * 100).toFixed(0)} pp`}; &quot;not significant&quot; is not
            &quot;no effect&quot;.
          </li>
          {ab.srm && (
            <li className={ab.srm.ok ? '' : 'error'}>
              Sample ratio check: {Object.entries(ab.srm.observed).map(([k, n]) => `${k} ${n}`).join(' / ')} vs expected{' '}
              {Object.entries(ab.srm.expectedShare).map(([k, s]) => `${k} ${pct(s, 0)}`).join(' / ')} → p = {ab.srm.pValue.toFixed(3)}{' '}
              {ab.srm.ok ? '(ok)' : '(mismatch: check assignment before trusting results)'}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}

function Bars({ data, total }: { data: Record<string, number>; total: number }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <p className="muted">No results yet.</p>;
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
