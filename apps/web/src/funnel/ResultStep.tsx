import { useEffect, useRef, useState } from 'react';
import type { Result, Step } from '@funnel/shared';
import { api } from '../lib/api';
import type { Tracker } from '../lib/tracker';
import { useI18n } from '../i18n';
import { dissolve } from '../lib/transition';

interface Props {
  step: Extract<Step, { type: 'result' }>;
  sessionId: string;
  tracker: Tracker | null;
  whenSaved: () => Promise<void>;
  onRestart: () => void;
}

type Phase = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; resultId: string; result: Result };

/**
 * The result is computed by the server from the saved answers (the client cannot choose it).
 * Loading / error / retry texts come from the result step's config.
 */
export function ResultStep({ step, sessionId, tracker, whenSaved, onRestart }: Props) {
  const { t, tc } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const viewed = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    whenSaved()
      .then(() => api.result(sessionId))
      // "Calculating…" dissolves into the result (or the error), like any other change of screen.
      // A cancelled request (unmount, retry) must not start a transition: it would dissolve the screen into itself.
      .then((r) => {
        if (!cancelled) dissolve(() => !cancelled && setPhase({ kind: 'ready', resultId: r.resultId, result: r.result }));
      })
      .catch(() => {
        if (!cancelled) dissolve(() => !cancelled && setPhase({ kind: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt, whenSaved]);

  // result_viewed once per rendered result (guards against React StrictMode double effects).
  useEffect(() => {
    if (phase.kind !== 'ready' || !tracker) return;
    const key = `${sessionId}:${phase.resultId}:${attempt}`;
    if (viewed.current === key) return;
    viewed.current = key;
    tracker.track('result_viewed', step.id, { result_id: phase.resultId });
  }, [phase, tracker, sessionId, step.id, attempt]);

  // `recommendation_expanded` (declared by v3) — "the user opens the detailed recommendation after the result CTA".
  // Sent when the expanded list has actually rendered, once per result. The tracker drops it for sessions whose
  // pinned version does not declare the event (v1/v2), so shipping this code before publishing v3 is safe.
  const expandedSent = useRef<string | null>(null);
  useEffect(() => {
    if (!expanded || phase.kind !== 'ready' || !tracker) return;
    const key = `${sessionId}:${phase.resultId}`;
    if (expandedSent.current === key) return;
    expandedSent.current = key;
    tracker.track('recommendation_expanded', step.id, {
      result_id: phase.resultId,
      action: phase.result.cta?.action ?? 'expand_recommendation',
      source: 'result_cta',
    });
  }, [expanded, phase, tracker, sessionId, step.id]);

  // "Calculating…" → result (or error) is a change of screen without a navigation: move focus to the new heading
  // so keyboard and screen-reader users land on the result, like on every other step.
  const phaseKind = phase.kind;
  useEffect(() => {
    if (phaseKind !== 'loading') document.querySelector<HTMLElement>('.result h1')?.focus();
  }, [phaseKind]);

  if (phase.kind === 'loading') {
    return (
      <div className="step result" aria-busy="true">
        <h1 tabIndex={-1}>{step.content.loadingTitle ? tc(step.content.loadingTitle) : t('funnel.loading')}</h1>
        <div className="spinner" role="status" aria-label={t('funnel.loading')} />
      </div>
    );
  }
  if (phase.kind === 'error') {
    return (
      <div className="step result">
        <h1 tabIndex={-1}>{step.content.errorTitle ? tc(step.content.errorTitle) : t('funnel.loadError')}</h1>
        <div className="actions">
          <button className="primary" onClick={() => setAttempt((a) => a + 1)}>
            {step.content.retryLabel ? tc(step.content.retryLabel) : t('funnel.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  const { result, resultId } = phase;
  const cta = result.cta;
  const onCta = () => {
    if (!cta) return;
    tracker?.track('cta_clicked', step.id, { result_id: resultId, action: cta.action });
    // Only the lower part changes: the button dissolves and the plan condenses in below the title.
    if (cta.action === 'expand_recommendation') dissolve(() => setExpanded(true), 'reveal');
  };

  return (
    <div className="step result">
      <p className="eyebrow">{t('funnel.resultEyebrow')}</p>
      <h1 tabIndex={-1}>{tc(result.title)}</h1>
      {result.summary && <p className="body">{tc(result.summary)}</p>}
      {expanded && result.recommendations && (
        <ol className="recommendations">
          {result.recommendations.map((r) => (
            <li key={r}>{tc(r)}</li>
          ))}
        </ol>
      )}
      <div className="actions">
        {cta && !expanded && (
          <button className="primary" onClick={onCta}>
            {tc(cta.label)}
          </button>
        )}
        <button className="link" onClick={onRestart}>
          {t('funnel.startAgain')}
        </button>
      </div>
    </div>
  );
}
