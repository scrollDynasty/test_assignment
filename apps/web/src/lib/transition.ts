import { flushSync } from 'react-dom';

/**
 * Runs a UI update as a "dissolve" transition: the browser snapshots the current screen, applies the update, then
 * animates the old snapshot out (fade + blur) and the new screen in (see ::view-transition-* rules in styles.css).
 * Uses the native View Transitions API; browsers without it, reduced-motion users and hidden tabs get the update
 * instantly. The update itself is the same either way, so behaviour never depends on the animation.
 */
export function dissolve(update: () => void): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('startViewTransition' in document) || reduced || document.visibilityState !== 'visible') {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}
