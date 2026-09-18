import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSwipeBack } from '../src/funnel/useSwipeBack';

/** Swipe right = Back. The gesture must be deliberate: short, vertical or edge swipes do nothing. */
function Screen({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useSwipeBack(ref, enabled, onBack);
  return (
    <div ref={ref} data-testid="shell">
      <div className="step-slot">
        <input type="number" aria-label="team size" />
      </div>
    </div>
  );
}

function swipe(el: Element, from: [number, number], to: [number, number], target: Element = el) {
  const point = ([clientX, clientY]: [number, number]) => ({ clientX, clientY, identifier: 1, target });
  fireEvent.touchStart(target, { touches: [point(from)], changedTouches: [point(from)] });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const p: [number, number] = [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps];
    fireEvent.touchMove(target, { touches: [point(p)], changedTouches: [point(p)] });
  }
  fireEvent.touchEnd(target, { touches: [], changedTouches: [point(to)] });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('swipe right to go back', () => {
  it('a long horizontal swipe goes back; while dragging the step follows the finger', () => {
    const onBack = vi.fn();
    render(<Screen enabled onBack={onBack} />);
    const shell = screen.getByTestId('shell');
    const slot = shell.querySelector('.step-slot') as HTMLElement;
    fireEvent.touchStart(shell, { touches: [{ clientX: 60, clientY: 300, identifier: 1 }] });
    fireEvent.touchMove(shell, { touches: [{ clientX: 100, clientY: 302, identifier: 1 }] });
    fireEvent.touchMove(shell, { touches: [{ clientX: 160, clientY: 304, identifier: 1 }] });
    expect(slot.style.transform).toMatch(/translateX\(35px\)/); // 100 px of travel × 0.35
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 160, clientY: 304, identifier: 1 }] });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['too short', [60, 300], [110, 300]],
    ['1 px short of the 80 px threshold', [60, 300], [139, 300]],
    ['mostly vertical (scrolling)', [100, 200], [180, 500]],
    ['leftwards', [300, 300], [100, 300]],
    ['from the screen edge (left to the OS back gesture)', [10, 300], [250, 300]],
    ['starting 1 px inside the 24 px edge zone', [23, 300], [263, 300]],
  ] as const)('does nothing for a swipe that is %s, and puts the step back', (_label, from, to) => {
    const onBack = vi.fn();
    render(<Screen enabled onBack={onBack} />);
    const shell = screen.getByTestId('shell');
    swipe(shell, [...from], [...to]);
    expect(onBack).not.toHaveBeenCalled();
    expect((shell.querySelector('.step-slot') as HTMLElement).style.transform).toBe('');
  });

  it('exactly at the thresholds it does go back: 80 px of travel, starting 24 px from the edge', () => {
    const onBack = vi.fn();
    render(<Screen enabled onBack={onBack} />);
    swipe(screen.getByTestId('shell'), [24, 300], [104, 300]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('never fires while typing in a number field, or when going back is not possible', () => {
    const onBack = vi.fn();
    const { rerender } = render(<Screen enabled onBack={onBack} />);
    const shell = screen.getByTestId('shell');
    swipe(shell, [60, 300], [260, 300], screen.getByLabelText('team size'));
    expect(onBack).not.toHaveBeenCalled();
    rerender(<Screen enabled={false} onBack={onBack} />);
    swipe(shell, [60, 300], [260, 300]);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('if nothing navigated after the swipe, the dragged step is put back instead of staying half-faded', () => {
    render(<Screen enabled onBack={() => undefined} />);
    const shell = screen.getByTestId('shell');
    swipe(shell, [60, 300], [260, 300]);
    const slot = shell.querySelector('.step-slot') as HTMLElement;
    expect(slot.style.opacity).not.toBe('');
    vi.advanceTimersByTime(1000);
    expect(slot.style.transform).toBe('');
    expect(slot.style.opacity).toBe('');
  });
});
