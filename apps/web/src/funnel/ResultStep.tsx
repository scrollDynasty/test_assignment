import { useEffect, useRef, useState } from 'react';
import type { Result, Step } from '@funnel/shared';
import { api } from '../lib/api';
import type { Tracker } from '../lib/tracker';

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
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const viewed = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });
    whenSaved()
      .then(() => api.result(sessionId))
      .then((r) => !cancelled && setPhase({ kind: 'ready', resultId: r.resultId, result: r.result }))
      .catch(() => !cancelled && setPhase({ kind: 'error' }));
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

  if (phase.kind === 'loading') {
    return (
      <div className="step result" aria-busy="true">
        <h1>{step.content.loadingTitle ?? 'Loading…'}</h1>
        <div className="spinner" />
      </div>
    );
  }
  if (phase.kind === 'error') {
    return (
      <div className="step result">
        <h1>{step.content.errorTitle ?? 'Something went wrong'}</h1>
        <div className="actions">
          <button className="primary" onClick={() => setAttempt((a) => a + 1)}>
            {step.content.retryLabel ?? 'Try again'}
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
    if (cta.action === 'expand_recommendation') setExpanded(true);
  };

  return (
    <div className="step result">
      <p className="eyebrow">Your recommendation</p>
      <h1>{result.title}</h1>
      {result.summary && <p className="body">{result.summary}</p>}
      {expanded && result.recommendations && (
        <ol className="recommendations">
          {result.recommendations.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      )}
      <div className="actions">
        {cta && !expanded && (
          <button className="primary" onClick={onCta}>
            {cta.label}
          </button>
        )}
        <button className="link" onClick={onRestart}>
          Start again
        </button>
      </div>
    </div>
  );
}
