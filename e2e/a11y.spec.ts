import { expect, test } from '@playwright/test';
import { answerAndContinue, answerUntilResult, expectAccessible, openFunnel, stepHeading } from './helpers';

/**
 * Automated WCAG 2.2 A/AA audit (axe-core) of the rendered pages in a real browser, in both themes. Every audit
 * first waits for the state it names, so it never scans the previous screen. Automated rules catch roughly a third
 * of accessibility problems (contrast, names, roles, structure); keyboard flow and focus are covered by the
 * functional tests.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`funnel screens pass the WCAG 2.2 AA audit (${colorScheme} theme)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openFunnel(page, `e2e-a11y-${colorScheme}-${Date.now()}`);
    await expect(page.getByRole('heading', { name: 'Build a work model your team can actually follow' })).toBeVisible();
    await expectAccessible(page, 'intro');

    await page.getByRole('button', { name: 'Start' }).click();
    await expect(stepHeading(page)).toHaveText('How many people are on the team?');
    await expectAccessible(page, 'number question');

    await answerAndContinue(page);
    await page.getByRole('button', { name: 'Continue' }).click(); // empty submit
    await expect(page.getByRole('alert')).toBeVisible();
    await expectAccessible(page, 'question with a validation error');

    await answerUntilResult(page);
    await page.getByRole('button', { name: 'View the action list' }).click();
    await expect(page.getByRole('listitem').first()).toBeVisible();
    await expectAccessible(page, 'result with the action list');
  });
}

test('the internal login page passes the audit', async ({ page }) => {
  await page.goto('/internal?lang=en');
  await expect(page.getByRole('heading', { name: 'Internal area' })).toBeVisible();
  await expectAccessible(page, 'login');
});
