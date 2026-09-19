import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '@funnel/shared';
import { ResultStep } from '../src/funnel/ResultStep';
import { I18nProvider } from '../src/i18n';
import { funnelV3 } from './fixtures';

/**
 * The result is computed by the server; the page only shows it. The fake server answers
 * POST /api/sessions/:id/result; the tracker is a spy, so the events the screen emits are asserted directly.
 */
const v3 = funnelV3('A');
const resultStep = v3.steps.result as Extract<Step, { type: 'result' }>;
const regulated = v3.results.regulated_scale;
if (!regulated) throw new Error('v3 has regulated_scale');

function mount(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const tracker = { track: vi.fn() };
  const onRestart = vi.fn();
  // StrictMode runs effects twice in development, exactly what the page does: "once" must survive it.
  const utils = render(
    <StrictMode>
      <I18nProvider>
        <ResultStep step={resultStep} sessionId="s-1" tracker={tracker} whenSaved={() => Promise.resolve()} onRestart={onRestart} />
      </I18nProvider>
    </StrictMode>,
  );
  return { ...utils, tracker, onRestart, user: userEvent.setup() };
}
const ok = () => Promise.resolve(new Response(JSON.stringify({ resultId: 'regulated_scale', result: regulated }), { status: 200 }));

afterEach(() => vi.unstubAllGlobals());

describe('result screen', () => {
  it('shows the loading title from the config, then the result the server computed, and reports result_viewed once', async () => {
    const { tracker, user } = mount(ok);
    expect(screen.getByRole('heading', { name: 'Building your recommendation…' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: regulated.title })).toBeTruthy();
    expect(screen.getByText(regulated.summary as string)).toBeTruthy();
    // Re-render the result (the CTA expands it): still a single result_viewed.
    await user.click(screen.getByRole('button', { name: 'View the action list' }));
    await screen.findAllByRole('listitem');
    expect(tracker.track.mock.calls.filter(([name]) => name === 'result_viewed')).toEqual([['result_viewed', 'result', { result_id: 'regulated_scale' }]]);
  });

  it('CTA reveals the action list as an ordered list and reports cta_clicked and recommendation_expanded', async () => {
    const { tracker, user } = mount(ok);
    await user.click(await screen.findByRole('button', { name: 'View the action list' }));
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(regulated.recommendations);
    expect(tracker.track).toHaveBeenCalledWith('cta_clicked', 'result', { result_id: 'regulated_scale', action: 'expand_recommendation' });
    await waitFor(() =>
      expect(tracker.track).toHaveBeenCalledWith('recommendation_expanded', 'result', {
        result_id: 'regulated_scale',
        action: 'expand_recommendation',
        source: 'result_cta',
      }),
    );
    expect(screen.queryByRole('button', { name: 'View the action list' })).toBeNull();
  });

  it('a failed computation shows the error title and the retry asks the server again', async () => {
    let failing = true;
    let requests = 0;
    const { user } = mount(() => {
      requests++;
      return failing ? Promise.resolve(new Response('{"error":"not_found"}', { status: 404 })) : ok();
    });
    expect(await screen.findByRole('heading', { name: 'We could not build the recommendation' })).toBeTruthy();
    const before = requests;
    failing = false; // the server recovers; nothing is retried automatically for a 404
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: regulated.title })).toBeTruthy();
    expect(requests).toBeGreaterThan(before);
  });

  it('"Start again" asks for a second press, then hands control back to the funnel', async () => {
    const { user, onRestart } = mount(ok);
    await user.click(await screen.findByRole('button', { name: 'Start again' }));
    expect(onRestart).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Erase answers and start again' }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
