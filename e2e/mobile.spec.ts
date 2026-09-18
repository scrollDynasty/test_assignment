import { expect, test } from '@playwright/test';
import { openFunnel, stepHeading } from './helpers';

/** Phone layout: no visible Back button (swipe instead, with a one-time hint), a numberless progress line. */
test('on a touch phone Back is a swipe with a one-time hint, and progress has no step counter', async ({ page }) => {
  await openFunnel(page, `e2e-mobile-${Date.now()}`);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('spinbutton').fill('8');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page)).toHaveText('Where does the team work most of the time?');

  await expect(page.getByRole('status').filter({ hasText: 'Swipe right to go back' })).toBeVisible();
  await expect(page.getByRole('button', { name: '← Back' })).not.toBeInViewport();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByText(/Question \d+ of \d+/)).toHaveCount(0);

  // Swipe right across the screen: back to the previous question.
  const box = await page.locator('.funnel-shell').boundingBox();
  if (!box) throw new Error('no layout');
  const y = box.y + box.height / 2;
  await page.locator('.funnel-shell').dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 60, clientY: y }], changedTouches: [{ identifier: 1, clientX: 60, clientY: y }] });
  for (const x of [100, 160, 220, 280]) {
    await page.locator('.funnel-shell').dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: x, clientY: y }], changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  }
  await page.locator('.funnel-shell').dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 280, clientY: y }] });
  await expect(stepHeading(page)).toHaveText('How many people are on the team?');
  await expect(page.getByRole('spinbutton')).toHaveValue('8');
});
