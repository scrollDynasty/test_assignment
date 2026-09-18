import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { answerAndContinue, openFunnel } from './helpers';

/**
 * Automated WCAG 2.2 A/AA audit (axe-core) of the rendered pages in a real browser, in both themes. Automated rules
 * catch roughly a third of accessibility problems (contrast, names, roles, structure); keyboard flow and focus are
 * covered by the functional tests.
 */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function audit(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(violations.map((v) => `${label}: ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`funnel screens pass the WCAG 2.2 AA audit (${colorScheme} theme)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openFunnel(page, `e2e-a11y-${colorScheme}-${Date.now()}`);
    await audit(page, 'intro');
    await page.getByRole('button', { name: 'Start' }).click();
    await audit(page, 'number question');
    await answerAndContinue(page);
    await page.getByRole('button', { name: 'Continue' }).click(); // empty submit: the error state
    await audit(page, 'question with a validation error');
    while (!(await page.getByText('Your recommendation').isVisible())) await answerAndContinue(page);
    await page.getByRole('button', { name: 'View the action list' }).click();
    await audit(page, 'result with the action list');
  });
}

test('the internal login page passes the audit', async ({ page }) => {
  await page.goto('/internal?lang=en');
  await expect(page.getByRole('heading', { name: 'Internal area' })).toBeVisible();
  await audit(page, 'login');
});
