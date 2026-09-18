import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { isInteractive } from '@funnel/shared';
import { ResultStep } from './ResultStep';
import { InfoStep, MultiSelectStep, NumberStep, SingleSelectStep } from './steps';
import { useFunnel } from './useFunnel';

export function FunnelPage() {
  const { funnelId = 'workstyle-planner' } = useParams();
  const view = useFunnel(funnelId);
  const { load, step, progress, tracker, error } = view;
  const session = load.kind === 'ready' ? load.session : null;
  const currentStepId = session?.state.currentStepId;
  const depth = session?.state.history.length ?? 0;

  // step_viewed once per navigation to a step (a re-view after Back or refresh is a new, legitimate view).
  // The ref guards against React StrictMode running the effect twice for the same navigation.
  const lastView = useRef<string | null>(null);
  const navId = view.navId;
  useEffect(() => {
    if (!session || !step || !tracker || step.type === 'result') return;
    const key = `${session.sessionId}:${navId}`;
    if (lastView.current === key) return;
    lastView.current = key;
    tracker.track('step_viewed', step.id, {
      step_type: step.type,
      visible_step_index: progress?.index ?? 0,
      visible_step_count: progress?.count ?? 0,
    });
  }, [session, step, tracker, navId, progress]);

  useEffect(() => {
    if (session) document.title = session.funnel.title;
  }, [session]);

  if (load.kind === 'loading') return <Shell><div className="spinner" /></Shell>;
  if (load.kind === 'error') {
    return (
      <Shell>
        <div className="step">
          <h1>We could not load this page</h1>
          <p className="body">{load.message}</p>
          <div className="actions">
            <button className="primary" onClick={view.retryLoad}>Try again</button>
          </div>
        </div>
      </Shell>
    );
  }
  if (!session || !step || !currentStepId) return null;

  const answer = isInteractive(step) ? session.state.answers[step.input.name] : undefined;
  const common = { initial: answer, onSubmit: view.submit, onChange: view.clearError };
  const showProgress = progress !== null && progress.count > 0 && step.type !== 'info' && step.type !== 'result';

  return (
    <Shell>
      <div className="topbar">
        {view.canGoBack && step.type !== 'result' ? (
          <button className="back" onClick={view.back} aria-label="Back">← Back</button>
        ) : (
          <span />
        )}
        {showProgress && (
          <span className="progress-label">
            Question {progress.index} of {progress.count}
          </span>
        )}
      </div>
      {showProgress && (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.count} aria-valuenow={progress.index}>
          <div style={{ width: `${(progress.index / progress.count) * 100}%` }} />
        </div>
      )}

      {/* key: remount per navigation so each step starts from its saved answer */}
      <div key={`${currentStepId}:${depth}`}>
        {step.type === 'info' && <InfoStep step={step} {...common} />}
        {step.type === 'single-select' && <SingleSelectStep step={step} {...common} />}
        {step.type === 'multi-select' && <MultiSelectStep step={step} {...common} />}
        {step.type === 'number' && <NumberStep step={step} {...common} />}
        {step.type === 'result' && (
          <ResultStep step={step} sessionId={session.sessionId} tracker={tracker} whenSaved={view.whenSaved} onRestart={view.restart} />
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="meta">
        v{session.version} · variant {session.variant} · <a href="/analytics">analytics</a> · <a href="/admin">versions</a>
      </footer>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="funnel">{children}</main>;
}
