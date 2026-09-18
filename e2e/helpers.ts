import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AnalyticsReport } from '../packages/shared/src/index';
import { E2E_ADMIN_TOKEN } from '../playwright.config';

/** Opens the funnel on variant A (deterministic order) with a campaign unique to this test. */
export async function openFunnel(page: Page, campaign: string): Promise<void> {
  await page.goto(`/f/workstyle-planner?variant=A&lang=en&utm_source=e2e&utm_medium=test&utm_campaign=${campaign}`);
}

/** The heading of the step on screen (the page moves focus to it on every navigation). */
export const stepHeading = (page: Page) => page.locator('.step-slot h1');

/** Answers whatever question is on screen with a valid answer and continues. */
export async function answerAndContinue(page: Page): Promise<void> {
  const before = await stepHeading(page).textContent();
  const number = page.getByRole('spinbutton');
  if (await number.count()) await number.fill('3');
  else if (await page.getByRole('radio').count()) await page.getByRole('radio').first().check();
  else await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page)).not.toHaveText(before ?? '');
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
