import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { isInteractive } from '@funnel/shared';
import { ResultStep } from './ResultStep';
import { InfoStep, MultiSelectStep, NumberStep, SingleSelectStep } from './steps';
import { useFunnel } from './useFunnel';
import { LangSwitch, useI18n } from '../i18n';

export function FunnelPage() {
  const { funnelId = 'workstyle-planner' } = useParams();
  const view = useFunnel(funnelId);
  const { t, tc } = useI18n();
  // Visitors must not see which experiment arm they are in (it would bias the A/B test) nor links to the internal
  // area. Version and variant are shown only in debug mode (?debug=1, remembered for the tab).
  const debug = useDebugFlag();
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
    if (session) document.title = tc(session.funnel.title);
  }, [session, tc]);

  // Move focus to the new question on every navigation, so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (navId > 1) document.querySelector<HTMLElement>('.step h1')?.focus();
  }, [navId]);

  if (load.kind === 'loading') return <Shell><div className="spinner" /></Shell>;
  if (load.kind === 'error') {
    return (
      <Shell>
        <div className="step">
          <h1>{t('funnel.loadError')}</h1>
          <p className="body">{load.message}</p>
          <div className="actions">
            <button className="primary" onClick={view.retryLoad}>{t('funnel.tryAgain')}</button>
          </div>
        </div>
      </Shell>
    );
  }
  if (!session || !step || !currentStepId) return null;

  const answer = isInteractive(step) ? session.state.answers[step.input.name] : undefined;
  const common = { initial: answer, onSubmit: view.submit, onChange: view.clearError, invalid: Boolean(error) && error !== 'session_gone' };

  return (
    <Shell title={tc(session.funnel.title)}>
      {/* No "question N of M" on purpose: visitors do not see how many steps remain (a product decision, see
          WORKLOG). Progress is still computed by the engine and sent with step_viewed for analytics. */}
      <div className="stepbar">
        {view.canGoBack && step.type !== 'result' && (
          <button className="back" onClick={view.back}>{t('funnel.back')}</button>
        )}
      </div>

      {/* key: remount per navigation so each step starts from its saved answer */}
      <div key={`${currentStepId}:${depth}`} className="step-slot">
        {step.type === 'info' && <InfoStep step={step} {...common} />}
        {step.type === 'single-select' && <SingleSelectStep step={step} {...common} />}
        {step.type === 'multi-select' && <MultiSelectStep step={step} {...common} />}
        {step.type === 'number' && <NumberStep step={step} {...common} />}
        {step.type === 'result' && (
          <ResultStep step={step} sessionId={session.sessionId} tracker={tracker} whenSaved={view.whenSaved} onRestart={view.restart} />
        )}
      </div>
      {error === 'session_gone' ? (
        <div className="error" role="alert">
          <p>{t('funnel.sessionGone')}</p>
          <button className="primary" onClick={view.restart}>{t('funnel.startAgain')}</button>
        </div>
      ) : (
        error && (
          <p className="error" role="alert" id="step-error">
            {error === 'save_failed' ? t('funnel.saveError') : tc(error)}
          </p>
        )
      )}
      {debug && <footer className="meta">{t('funnel.meta', { version: session.version, variant: session.variant })}</footer>}
    </Shell>
  );
}

function useDebugFlag(): boolean {
  const flag = new URLSearchParams(window.location.search).get('debug');
  try {
    if (flag === '1') window.sessionStorage.setItem('funnel:debug', '1');
    if (flag === '0') window.sessionStorage.removeItem('funnel:debug');
    return window.sessionStorage.getItem('funnel:debug') === '1';
  } catch {
    return flag === '1';
  }
}

function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="funnel-shell">
      <header className="funnel-head">
        <span className="wordmark">
          <span className="wordmark-glyph" aria-hidden="true" />
          {title}
        </span>
        <LangSwitch />
      </header>
      <main className="funnel">{children}</main>
    </div>
  );
}
