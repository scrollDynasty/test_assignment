import { expect, test } from '@playwright/test';
import { answerAndContinue, openFunnel, report, stepHeading } from './helpers';

/**
 * A visitor's whole journey in a real browser against the production build: config-driven screens, state that
 * survives refresh and Back, the server-computed result, and the analytics that journey produces — counted once
 * per session no matter how the events travelled.
 */
test('a visitor completes the funnel; refresh and Back keep state; the dashboard counts the session exactly once', async ({ page, request }) => {
  const campaign = `e2e-journey-${Date.now()}`;
  await openFunnel(page, campaign);

  await expect(page.getByRole('heading', { name: 'Build a work model your team can actually follow' })).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(stepHeading(page)).toHaveText('How many people are on the team?');
  await page.getByRole('spinbutton').fill('12');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(stepHeading(page)).toHaveText('Where does the team work most of the time?');
  await page.getByRole('radio', { name: 'Hybrid' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page)).toHaveText('What should the operating model improve?');

  // Refresh: same step, nothing lost.
  await page.reload();
  await expect(stepHeading(page)).toHaveText('What should the operating model improve?');

  // Back (the corner link on a mouse device): previous step with the saved answer, and the progress line shrinks.
  const progress = page.getByRole('progressbar');
  const filledBefore = Number(await progress.getAttribute('aria-valuenow'));
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(stepHeading(page)).toHaveText('Where does the team work most of the time?');
  await expect(page.getByRole('radio', { name: 'Hybrid' })).toBeChecked();
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(filledBefore);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Hybrid opens the conditional office_days question somewhere ahead; answer everything until the result.
  const seen: string[] = [];
  while (!(await page.getByText('Your recommendation').isVisible())) {
    seen.push((await stepHeading(page).textContent()) ?? '');
    await answerAndContinue(page);
  }
  expect(seen).toContain('How many office days are expected each week?');

  await page.getByRole('button', { name: 'View the action list' }).click();
  await expect(page.getByRole('listitem').first()).toBeVisible();

  // Events are delivered in batches in the background; the report must converge to exactly one session.
  await expect
    .poll(async () => {
      const v = (await report(request, campaign)).selected?.variants.A;
      return v && { started: v.started, reached: v.reachedResult, cta: v.ctaClicked, backRate: v.backRate, ok: v.invariantOk };
    }, { timeout: 20_000 })
    .toEqual({ started: 1, reached: 1, cta: 1, backRate: 1, ok: true });
});

test('validation messages come from the config and are exposed to assistive technology', async ({ page }) => {
  await openFunnel(page, `e2e-validation-${Date.now()}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter the team size.');
  await expect(page.getByRole('spinbutton')).toHaveAttribute('aria-invalid', 'true');

  await page.getByRole('spinbutton').fill('500');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toHaveText('For this demo, enter a value up to 200.');
});

test('a visitor sees neither the experiment arm nor links to the internal area; ?debug=1 shows the arm', async ({ page }) => {
  await openFunnel(page, `e2e-privacy-${Date.now()}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/variant/i)).toHaveCount(0);
  await expect(page.locator('a[href^="/internal"]')).toHaveCount(0);
  await page.goto('/f/workstyle-planner?variant=A&lang=en&debug=1');
  await expect(page.getByText(/variant A/i)).toBeVisible();
});
