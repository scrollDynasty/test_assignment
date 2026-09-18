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
import { dissolve } from '../lib/transition';
import { uuid } from '../lib/uuid';
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

const pendingKey = (sessionId: string) => `funnel:pending:${sessionId}`;

/** Same user-visible state (history is rebuilt by the server, so it is not compared). */
function sameState(a: SessionState, b: SessionState): boolean {
  return a.currentStepId === b.currentStepId && JSON.stringify(a.answers) === JSON.stringify(b.answers);
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
  /** Newest state not yet confirmed by the server (latest wins: intermediate states are skipped). */
  const pendingRef = useRef<SessionState | null>(null);
  const flushing = useRef<Promise<void> | null>(null);
  /** Set when we move the browser history ourselves, so the resulting popstate is ignored. */
  const ignorePop = useRef(false);
  /** Set when a navigation has been started and not rendered yet: a double click must not skip a screen. */
  const navigating = useRef(false);

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
        // One idempotency key per visit, kept until the session is stored: if the response is lost and the page
        // retries (Try again, refresh), the server returns the same session instead of counting a second start.
        const createKey = `${sessionKey}:create`;
        const idempotencyKey = storage.getJson<string>(createKey) ?? uuid();
        storage.setJson(createKey, idempotencyKey);
        session = await api.createSession({ funnelId, idempotencyKey, utm, query });
        storage.setJson(sessionKey, { sessionId: session.sessionId });
        storage.remove(createKey);
      }
      return session;
    }

    bootstrap
      .then((session) => {
        if (cancelled) return;
        // A state that was not confirmed before a refresh / tab close is newer than the server copy: resend it.
        const unsaved = storage.getJson<SessionState>(pendingKey(session.sessionId));
        if (unsaved && !sameState(unsaved, session.state)) session = { ...session, state: unsaved };
        sessionRef.current = session;
        trackerRef.current = createTracker(session);
        syncBrowserHistory(session);
        const ready = session;
        dissolve(() => {
          if (cancelled) return;
          setLoad({ kind: 'ready', session: ready });
          setNavId((n) => n + 1);
        });
        if (unsaved) {
          pendingRef.current = unsaved;
          void flush();
        }
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
  /** Server copy wins (another tab moved on, or our state was refused): drop everything queued locally. */
  const adoptServer = useCallback((fresh: SessionDto) => {
    pendingRef.current = null;
    storage.remove(pendingKey(fresh.sessionId));
    sessionRef.current = fresh;
    setLoad({ kind: 'ready', session: fresh });
    setNavId((n) => n + 1);
    syncBrowserHistory(fresh);
  }, []);

  /**
   * Single-flight saver: at most one PUT in flight, always sending the newest pending state with the
   * newest rev. Failures keep the state pending (and in localStorage), so it is resent later.
   */
  const flush = useCallback((): Promise<void> => {
    if (flushing.current) return flushing.current;
    const run = (async () => {
      let failures = 0;
      while (pendingRef.current && sessionRef.current) {
        const state = pendingRef.current;
        const current = sessionRef.current;
        pendingRef.current = null;
        try {
          const saved = await api.saveState(current.sessionId, state, current.rev);
          // Only the revision is taken from the response: the user may already be one step further locally.
          if (sessionRef.current) sessionRef.current = { ...sessionRef.current, rev: saved.rev };
          if (!pendingRef.current) storage.remove(pendingKey(current.sessionId));
          failures = 0;
        } catch (e) {
          if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
            // The session is gone (expired): retrying can never help; the page offers to start again.
            pendingRef.current = null;
            storage.remove(pendingKey(current.sessionId));
            setError('session_gone');
            break;
          }
          if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
            let fresh: SessionDto;
            try {
              fresh = await api.getSession(current.sessionId);
            } catch {
              // Could not even read the server copy: keep our state pending and retry later like a network error.
              pendingRef.current ??= state;
              if (++failures >= 5) {
                setError('save_failed');
                break;
              }
              await new Promise((r) => setTimeout(r, 500 * 2 ** failures));
              continue;
            }
            if (e.status === 409 && sameState(fresh.state, state)) {
              // Our earlier write did land (the response was lost, e.g. a timeout): just take the new rev.
              if (sessionRef.current) sessionRef.current = { ...sessionRef.current, rev: fresh.rev };
              if (!pendingRef.current) storage.remove(pendingKey(current.sessionId));
              continue;
            }
            adoptServer(fresh);
            continue;
          }
          pendingRef.current ??= state; // keep it (a newer local state, if any, still wins)
          if (++failures >= 5) {
            setError('save_failed'); // translated by the page
            break;
          }
          await new Promise((r) => setTimeout(r, 500 * 2 ** failures));
        }
      }
    })().finally(() => {
      flushing.current = null;
    });
    flushing.current = run;
    return run;
  }, [adoptServer]);

  const commit = useCallback(
    (next: SessionState, direction: 'forward' | 'back' = 'forward') => {
      const session = sessionRef.current;
      if (!session) return;
      const updated: SessionDto = { ...session, state: next };
      sessionRef.current = updated;
      // Only the rendering is animated; the state, the save and the events happen right away. The rendered session
      // is read when the (possibly queued) transition runs: a server copy adopted in between must not be overwritten.
      dissolve(
        () => {
          setLoad({ kind: 'ready', session: sessionRef.current ?? updated });
          setNavId((n) => n + 1);
        },
        direction === 'back' ? 'back' : undefined,
      );
      pendingRef.current = next;
      storage.setJson(pendingKey(session.sessionId), next);
      void flush();
    },
    [flush],
  );

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
      if (!next || navigating.current) return;
      navigating.current = true;
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
      if (ignorePop.current) {
        ignorePop.current = false;
        return;
      }
      const session = sessionRef.current;
      const tracker = trackerRef.current;
      if (!session || !tracker) return;
      const { state } = session;
      const depth = state.history.length;
      const here: HistoryMarker = { funnelSession: session.sessionId, step: state.currentStepId, depth };
      const target = isMarker(event.state, session.sessionId) ? event.state : null;
      if (!target) {
        // An entry from before this session (e.g. before "Start again"): keep showing the current step.
        window.history.replaceState(here, '', urlFor(state.currentStepId));
        return;
      }
      if (target.depth >= depth) {
        // Browser Forward: undo it; moving forward always goes through validation (Continue).
        if (target.depth > depth) {
          ignorePop.current = true;
          window.history.go(depth - target.depth);
        } else {
          window.history.replaceState(here, '', urlFor(state.currentStepId));
        }
        return;
      }
      // Back (possibly several entries at once): the destination is our own path at that depth.
      const destination = state.history[target.depth];
      if (!destination) return;
      setError(null);
      tracker.track('back_clicked', state.currentStepId, { destination_step_id: destination });
      window.history.replaceState({ funnelSession: session.sessionId, step: destination, depth: target.depth } satisfies HistoryMarker, '', urlFor(destination));
      commit({ answers: state.answers, history: state.history.slice(0, target.depth), currentStepId: destination }, 'back');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [commit]);

  // A navigation is "done" once it has rendered (navId changed).
  useEffect(() => {
    navigating.current = false;
  }, [navId]);

  const restart = useCallback(() => {
    const old = sessionRef.current?.sessionId;
    if (old) {
      storage.remove(pendingKey(old));
      storage.remove(`funnel:seq:${old}`);
    }
    storage.remove(sessionKey);
    storage.remove(`${sessionKey}:create`);
    const url = new URL(window.location.href);
    url.searchParams.delete('step');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    // The finished screen evaporates here; the new session's first screen condenses in when it has loaded.
    dissolve(() => {
      setError(null);
      setLoad({ kind: 'loading' });
      setReloadToken((t) => t + 1);
    });
  }, [sessionKey]);

  const retryLoad = useCallback(
    () =>
      dissolve(() => {
        setLoad({ kind: 'loading' });
        setReloadToken((t) => t + 1);
      }),
    [],
  );
  /** Resolves when nothing is pending; if an earlier save gave up, this retries it. */
  const whenSaved = useCallback(() => (pendingRef.current ? flush() : (flushing.current ?? Promise.resolve())), [flush]);

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
