import { flushSync } from 'react-dom';

let running: Promise<void> | null = null;

/**
 * Runs a UI update as a "dissolve" transition: the browser snapshots the current screen, applies the update, then
 * animates the old snapshot out (fade + blur) and the new screen in (see ::view-transition-* rules in styles.css).
 * Uses the native View Transitions API; browsers without it, reduced-motion users and hidden tabs get the update
 * instantly. The update itself is the same either way, so behaviour never depends on the animation.
 *
 * `variant` adds a class to <html> for the duration of the transition, so CSS can style that kind of change
 * differently (e.g. "reveal": only part of the screen changes). Transitions are queued rather than cut short:
 * an update that arrives mid-transition (e.g. the result arriving right after the last answer) waits for the
 * running one to finish, so every change gets its full animation.
 */
export function dissolve(update: () => void, variant?: string): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('startViewTransition' in document) || reduced || document.visibilityState !== 'visible') {
    update();
    return;
  }
  if (running) {
    void running.then(() => dissolve(update, variant));
    return;
  }
  const root = document.documentElement;
  const cls = variant ? `vt-${variant}` : null;
  if (cls) root.classList.add(cls);
  const transition = document.startViewTransition(() => flushSync(update));
  running = transition.finished
    .catch(() => undefined)
    .finally(() => {
      if (cls) root.classList.remove(cls);
      running = null;
    });
}
