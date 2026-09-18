import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerKind,
  computeProgress,
  isInteractive,
  nextStepId,
  validateAnswer,
  type AnswerValue,
  type Progress,
  type SessionDto,
  type SessionState,
  type Step,
} from '@funnel/shared';
import { ApiError, api } from '../lib/api';
import { storage } from '../lib/storage';
import { createTracker, type Tracker } from '../lib/tracker';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

/** Browser history entries we create carry this, so a refresh can tell its own entries apart. */
interface HistoryMarker {
  funnelSession: string;
  step: string;
  depth: number;
}

function isMarker(value: unknown, sessionId: string): value is HistoryMarker {
  return typeof value === 'object' && value !== null && (value as HistoryMarker).funnelSession === sessionId;
}

function urlFor(step: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('step', step);
  return `${url.pathname}${url.search}`;
}

/**
 * Bootstraps in flight, per funnel. React StrictMode (and fast remounts) run the bootstrap effect twice;
 * without this both runs would create a session and the orphan would count as a "started" session.
 */
const pendingBootstrap = new Map<string, Promise<SessionDto>>();

export type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; session: SessionDto };

export interface FunnelView {
  load: LoadState;
  step: Step | null;
  progress: Progress | null;
  canGoBack: boolean;
  error: string | null;
  submit: (value: AnswerValue | undefined) => void;
  back: () => void;
  restart: () => void;
  retryLoad: () => void;
  tracker: Tracker | null;
  navId: number;
  clearError: () => void;
  /** Resolves when all queued state saves are done (the server computes the result from saved answers). */
  whenSaved: () => Promise<void>;
}

/**
 * Owns one funnel session in the browser:
 *  - resumes the session stored for this funnel (refresh / reopen), or creates one on the active version;
 *  - navigation is driven by the shared engine, so the page has no knowledge of concrete screens;
 *  - every navigation is saved to the server (the source of truth) and mirrored in the browser history,
 *    so the browser Back button behaves like the funnel's Back button (one code path: popstate).
 */
export function useFunnel(funnelId: string): FunnelView {
  const sessionKey = `funnel:session:${funnelId}`;
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  /** Increments on every navigation (load, forward, back, server reset): one step_viewed per value. */
  const [navId, setNavId] = useState(0);

  const sessionRef = useRef<SessionDto | null>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  // ---------- bootstrap: resume or create ----------
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });

    const bootstrapKey = `${funnelId}#${reloadToken}`;
    let bootstrap = pendingBootstrap.get(bootstrapKey);
    if (!bootstrap) {
      bootstrap = resumeOrCreate().finally(() => setTimeout(() => pendingBootstrap.delete(bootstrapKey), 1000));
      pendingBootstrap.set(bootstrapKey, bootstrap);
    }

    async function resumeOrCreate(): Promise<SessionDto> {
      const params = new URLSearchParams(window.location.search);
      const query: Record<string, string> = {};
      params.forEach((v, k) => {
        if (k !== 'step') query[k] = v;
      });

      let session: SessionDto | null = null;
      const stored = storage.getJson<{ sessionId: string }>(sessionKey);
      if (stored?.sessionId) {
        try {
          const existing = await api.getSession(stored.sessionId);
          // An explicit ?variant= that differs from the pinned variant starts a NEW session; the
          // existing one is never mutated, otherwise its events would be split across two variants.
          const forced = query[existing.funnel.overrideQueryParam];
          if (!forced || forced === existing.variant || !existing.funnel.overrideQueryParam) session = existing;
        } catch (e) {
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 410)) throw e;
        }
      }
      if (!session) {
        const utm: Record<string, string> = {};
        for (const k of UTM_KEYS) {
          const v = params.get(k);
          if (v) utm[k] = v;
        }
        session = await api.createSession({ funnelId, utm, query });
        storage.setJson(sessionKey, { sessionId: session.sessionId });
      }
      return session;
    }

    bootstrap
      .then((session) => {
        if (cancelled) return;
        sessionRef.current = session;
        trackerRef.current = createTracker(session);
        syncBrowserHistory(session);
        setLoad({ kind: 'ready', session });
        setNavId((n) => n + 1);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ kind: 'error', message: e instanceof Error ? e.message : 'Failed to load' });
      });

    return () => {
      cancelled = true;
    };
  }, [funnelId, sessionKey, reloadToken]);

  /** Makes the browser history mirror the funnel path, so Back works even right after a refresh. */
  function syncBrowserHistory(session: SessionDto) {
    const { history, currentStepId } = session.state;
    const depth = history.length;
    if (isMarker(window.history.state, session.sessionId) && window.history.state.depth === depth) {
      window.history.replaceState({ funnelSession: session.sessionId, step: currentStepId, depth }, '', urlFor(currentStepId));
      return;
    }
    const path = [...history, currentStepId];
    path.forEach((step, i) => {
      const marker: HistoryMarker = { funnelSession: session.sessionId, step, depth: i };
      if (i === 0) window.history.replaceState(marker, '', urlFor(step));
      else window.history.pushState(marker, '', urlFor(step));
    });
  }

  // ---------- persistence ----------
  const commit = useCallback((next: SessionState) => {
    const session = sessionRef.current;
    if (!session) return;
    const updated: SessionDto = { ...session, state: next };
    sessionRef.current = updated;
    setLoad({ kind: 'ready', session: updated });
    setNavId((n) => n + 1);

    // Saves are serialized; each uses the rev returned by the previous one.
    saveChain.current = saveChain.current.then(async () => {
      const current = sessionRef.current;
      if (!current) return;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const saved = await api.saveState(current.sessionId, next, current.rev);
          // Only the revision is taken from the response: the user may already be one step further locally.
          if (sessionRef.current) sessionRef.current = { ...sessionRef.current, rev: saved.rev };
          return;
        } catch (e) {
          if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
            // Another tab moved on, or the state was rejected: the server copy wins.
            const fresh = await api.getSession(current.sessionId);
            sessionRef.current = fresh;
            setLoad({ kind: 'ready', session: fresh });
            setNavId((n) => n + 1);
            syncBrowserHistory(fresh);
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      setError('Your progress could not be saved. Check your connection.');
    });
  }, []);

  // ---------- navigation ----------
  const submit = useCallback(
    (value: AnswerValue | undefined) => {
      const session = sessionRef.current;
      const tracker = trackerRef.current;
      if (!session || !tracker) return;
      const { funnel, state } = session;
      const step = funnel.steps[state.currentStepId];
      if (!step || step.type === 'result') return;

      const answers = { ...state.answers };
      if (isInteractive(step)) {
        const check = validateAnswer(step, value);
        if (!check.ok) {
          setError(check.message);
          return;
        }
        if (check.value === undefined) delete answers[step.input.name];
        else answers[step.input.name] = check.value;
      }
      const next = nextStepId(funnel, answers, state.currentStepId);
      if (!next) return;
      setError(null);

      if (isInteractive(step)) {
        tracker.track('answer_submitted', step.id, { answer_kind: answerKind(step) });
        tracker.track('step_completed', step.id, { next_step_id: next });
      }
      const nextState: SessionState = { answers, history: [...state.history, state.currentStepId], currentStepId: next };
      window.history.pushState(
        { funnelSession: session.sessionId, step: next, depth: nextState.history.length } satisfies HistoryMarker,
        '',
        urlFor(next),
      );
      commit(nextState);
    },
    [commit],
  );

  /** The UI Back button only asks the browser to go back; the popstate handler does the work. */
  const back = useCallback(() => {
    if ((sessionRef.current?.state.history.length ?? 0) > 0) window.history.back();
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const session = sessionRef.current;
      const tracker = trackerRef.current;
      if (!session || !tracker) return;
      const { state } = session;
      const target = isMarker(event.state, session.sessionId) ? event.state : null;
      const index = target ? state.history.lastIndexOf(target.step) : -1;
      if (!target || index < 0 || target.depth !== index) {
        // Forward button, or an entry that is not on the current path: stay where we are.
        window.history.replaceState(
          { funnelSession: session.sessionId, step: state.currentStepId, depth: state.history.length } satisfies HistoryMarker,
          '',
          urlFor(state.currentStepId),
        );
        return;
      }
      setError(null);
      tracker.track('back_clicked', state.currentStepId, { destination_step_id: target.step });
      commit({ answers: state.answers, history: state.history.slice(0, index), currentStepId: target.step });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [commit]);

  const restart = useCallback(() => {
    storage.remove(sessionKey);
    const url = new URL(window.location.href);
    url.searchParams.delete('step');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    setError(null);
    setReloadToken((t) => t + 1);
  }, [sessionKey]);

  const retryLoad = useCallback(() => setReloadToken((t) => t + 1), []);
  const whenSaved = useCallback(() => saveChain.current, []);

  const session = load.kind === 'ready' ? load.session : null;
  const step = session ? (session.funnel.steps[session.state.currentStepId] ?? null) : null;
  const progress = session ? computeProgress(session.funnel, session.state.answers, session.state.currentStepId) : null;

  return {
    load,
    step,
    progress,
    canGoBack: (session?.state.history.length ?? 0) > 0,
    error,
    submit,
    back,
    restart,
    retryLoad,
    tracker: trackerRef.current,
    navId,
    clearError: () => setError(null),
    whenSaved,
  };
}
