import { flushSync } from 'react-dom';

let running: Promise<void> | null = null;

interface Options {
  /** Adds `vt-<variant>` to <html> for the duration, so CSS can style that kind of change differently. */
  variant?: string;
  /** Called once the snapshots exist, e.g. to drive a custom animation of the pseudo-elements. */
  onReady?: (transition: ViewTransition) => void;
}

/**
 * Runs a UI update as a view transition: the browser snapshots the current screen, applies the update, then
 * animates between the snapshots (see ::view-transition-* rules in styles.css). Browsers without the API,
 * reduced-motion users and hidden tabs get the update instantly; the update itself is the same either way.
 *
 * All transitions of the page share one queue: one that is requested while another runs waits for it to finish
 * (the result arriving right after the last answer, a double click on the theme switch), so none is cut short.
 */
export function viewTransition(update: () => void, options: Options = {}): void {
  const { variant, onReady } = options;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('startViewTransition' in document) || reduced || document.visibilityState !== 'visible') {
    update();
    return;
  }
  if (running) {
    void running.then(() => viewTransition(update, options));
    return;
  }
  const root = document.documentElement;
  const cls = variant ? `vt-${variant}` : null;
  if (cls) root.classList.add(cls);
  const transition = document.startViewTransition(() => flushSync(update));
  if (onReady) transition.ready.then(() => onReady(transition)).catch(() => undefined);
  running = transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (cls) root.classList.remove(cls);
      running = null;
    });
}

/** The step change: the answered screen evaporates and the next one condenses in. `back` plays it in reverse. */
export function dissolve(update: () => void, variant?: 'reveal' | 'back'): void {
  viewTransition(update, variant ? { variant } : {});
}
