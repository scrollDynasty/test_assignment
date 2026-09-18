import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AnalyticsReport } from '../packages/shared/src/index';
import { E2E_ADMIN_TOKEN } from './constants';

/** Opens the funnel on variant A (deterministic order) with a campaign unique to this test. */
export async function openFunnel(page: Page, campaign: string): Promise<void> {
  await page.goto(`/f/workstyle-planner?variant=A&lang=en&utm_source=e2e&utm_medium=test&utm_campaign=${campaign}`);
}

/** The heading of the step on screen (the page moves focus to it on every navigation). */
export const stepHeading = (page: Page) => page.locator('.step-slot h1');

/** The label shown only on a computed result (not on the "Building your recommendation…" loading screen). */
export const resultLabel = (page: Page) => page.getByText('Your recommendation', { exact: true });

/** Answers whatever question is on screen with a valid answer (the lowest allowed number) and continues. */
export async function answerAndContinue(page: Page): Promise<void> {
  const before = await stepHeading(page).textContent();
  const number = page.getByRole('spinbutton');
  if (await number.count()) await number.fill((await number.getAttribute('min')) ?? '1');
  else if (await page.getByRole('radio').count()) await page.getByRole('radio').first().check();
  else await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page)).not.toHaveText(before ?? '');
}

/** Answers questions until the computed result is on screen; returns the titles of the questions answered. */
export async function answerUntilResult(page: Page): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 15; i++) {
    if (await page.locator('.result').count()) {
      await expect(resultLabel(page)).toBeVisible();
      return seen;
    }
    seen.push((await stepHeading(page).textContent()) ?? '');
    await answerAndContinue(page);
  }
  throw new Error(`no result after 15 questions: ${seen.join(' › ')}`);
}

/** Automated WCAG 2.2 A/AA audit (axe-core) of what is rendered now. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(violations.map((v) => `${label}: ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** The dashboard report for one campaign, read with the access key like the CLI scripts do. */
export async function report(request: APIRequestContext, campaign: string): Promise<AnalyticsReport> {
  const res = await request.get(
    `/api/analytics?funnelId=workstyle-planner&include_overrides=true&in_progress_minutes=0&utm_campaign=${campaign}`,
    { headers: { 'x-admin-token': E2E_ADMIN_TOKEN } },
  );
  expect(res.ok()).toBe(true);
  return (await res.json()) as AnalyticsReport;
}
