import { useEffect, type RefObject } from 'react';

const THRESHOLD = 80; // px of horizontal travel that counts as "go back"
const EDGE = 24; // touches starting this close to the left edge belong to the browser's own back gesture

/**
 * "Swipe right to go back" for the funnel, replacing a visible Back button.
 *
 * While the finger moves right, the current step follows it a little and fades, so the gesture has visible feedback;
 * past the threshold it goes back (through the same browser-history path as the browser's Back button, so the step
 * then dissolves like any other navigation). A short or mostly vertical swipe springs back and does nothing.
 *
 * Touches at the very left edge are left to the browser (iOS Safari / Android gesture navigation already go back
 * through history, which the funnel handles), otherwise one swipe would go back twice. Mouse, trackpad and keyboard
 * users keep the browser's own Back (two-finger swipe, Alt+←, the Back button).
 */
export function useSwipeBack(areaRef: RefObject<HTMLElement | null>, enabled: boolean, onBack: () => void): void {
  useEffect(() => {
    const area = areaRef.current;
    if (!area || !enabled) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let horizontal: boolean | null = null;

    const target = () => area.querySelector<HTMLElement>('.step-slot');
    const reset = (animate: boolean) => {
      const el = target();
      if (!el) return;
      el.style.transition = animate ? 'transform 0.25s ease, opacity 0.25s ease, filter 0.25s ease' : '';
      el.style.transform = '';
      el.style.opacity = '';
      el.style.filter = '';
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX < EDGE) return;
      // Typing a number or scrolling a long list must not turn into a swipe.
      if ((e.target as HTMLElement).closest('input[type="number"], textarea')) return;
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
      horizontal = null;
    };

    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!tracking || !t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (horizontal === null && Math.hypot(dx, dy) > 10) horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
      if (!horizontal || dx <= 0) return;
      const el = target();
      if (!el) return;
      const p = Math.min(dx / (THRESHOLD * 2), 1);
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx * 0.35}px)`;
      el.style.opacity = String(1 - p * 0.6);
      el.style.filter = `blur(${p * 4}px)`;
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - startX : 0;
      if (horizontal && dx >= THRESHOLD) {
        // Keep the dragged look: the view transition snapshots it and dissolves it from where the finger left it.
        // If nothing navigated (e.g. the browser refused), the step is still on screen: put it back.
        const el = target();
        onBack();
        setTimeout(() => {
          if (el?.isConnected) reset(true);
        }, 900);
        return;
      }
      reset(true);
    };

    const onCancel = () => {
      tracking = false;
      reset(true);
    };

    area.addEventListener('touchstart', onStart, { passive: true });
    area.addEventListener('touchmove', onMove, { passive: true });
    area.addEventListener('touchend', onEnd);
    area.addEventListener('touchcancel', onCancel);
    return () => {
      area.removeEventListener('touchstart', onStart);
      area.removeEventListener('touchmove', onMove);
      area.removeEventListener('touchend', onEnd);
      area.removeEventListener('touchcancel', onCancel);
    };
  }, [areaRef, enabled, onBack]);
}
