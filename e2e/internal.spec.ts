import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { E2E_ADMIN_TOKEN } from '../playwright.config';

/** The internal area: login with the access key, the dashboard and the versions page, logout. */
test('login, dashboard, versions and logout; a wrong key is refused', async ({ page }) => {
  await page.goto('/internal?lang=en');
  const key = page.getByLabel('Access key');
  await key.fill('not-the-key');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Wrong access key')).toBeVisible();

  await key.fill(E2E_ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Funnel analytics' })).toBeVisible();
  const dashboard = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(dashboard.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByRole('link', { name: 'Versions' }).click();
  await expect(page.getByRole('heading', { name: /Active version/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Roll back last publish' })).toBeVisible();

  // The session is an HttpOnly cookie: page scripts cannot read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain('funnel_internal');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByLabel('Access key')).toBeVisible();
});
