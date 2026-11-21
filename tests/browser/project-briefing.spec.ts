import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';
const from = '2026-10-01';
const to = '2026-10-05';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

test('a project review keeps its project and dates through reading, downloads and browser history', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?view=portfolio&project=bronto-ui&from=${from}&to=${to}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/brief')) requests.push(request.url());
  });
  await page.getByRole('button', { name: 'Read project briefing', exact: true }).focus();
  await page.keyboard.press('Enter');
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText('Bronto UI · briefing');
  await expect(title).toBeFocused();
  await expect(page.locator('.brief-panel')).toHaveCount(1);
  await expect(page.locator('[data-view="brief"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#mode')).toHaveText('SYNTHETIC DEMO');
  expect(new URL(page.url()).searchParams.get('project')).toBe('bronto-ui');
  expect(requests.map((request) => new URL(request).pathname)).toEqual([
    '/api/v1/projects/bronto-ui/brief',
  ]);
  const requested = new URL(requests[0]!);
  expect(requested.searchParams.get('from')).toBe(from);
  expect(requested.searchParams.get('to')).toBe(to);
  const markdown = page.getByRole('link', { name: 'Download Markdown briefing', exact: true });
  await expect(markdown).toHaveAttribute(
    'href',
    `/api/v1/projects/bronto-ui/brief?from=${from}&to=${to}&format=markdown`,
  );
  const download = page.waitForEvent('download');
  await markdown.click();
  expect((await download).suggestedFilename()).toBe('pulse-bronto-ui-brief.md');
  await page.screenshot({ path: 'artifacts/pulse-project-briefing-1440.png', fullPage: true });

  await page.reload();
  await expect(title).toHaveText('Bronto UI · briefing');
  await expect(page.locator('.brief-panel')).toHaveCount(1);
  await expect(page.locator('#from')).toHaveValue(from);
  await expect(page.locator('#to')).toHaveValue(to);
  await page.getByRole('button', { name: '← Project report', exact: true }).click();
  await expect(title).toHaveText('Bronto UI');
  expect(new URL(page.url()).searchParams.get('from')).toBe(from);
  expect(new URL(page.url()).searchParams.get('to')).toBe(to);
  await page.goBack();
  await expect(title).toHaveText('Bronto UI · briefing');
  await page.goForward();
  await expect(title).toHaveText('Bronto UI');
  await page.goBack();
  await expect(title).toHaveText('Bronto UI · briefing');
  await page.getByRole('button', { name: 'All project briefings', exact: true }).click();
  await expect(title).toHaveText('What changed, and what did not.');
  await expect(page.locator('.brief-panel')).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get('project')).toBeNull();
});

test('a narrow project briefing keeps its scope when the review period changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/?view=brief&project=bronto-ui&from=${from}&to=${to}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI · briefing');
  await page.getByRole('button', { name: '14 days', exact: true }).click();
  await expect(page.locator('#load-status')).toHaveText('Bronto UI · briefing loaded.');
  await expect(page.locator('.brief-panel')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('project')).toBe('bronto-ui');
  await expect(page.getByRole('button', { name: '← Project report', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'All project briefings', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await page.screenshot({ path: 'artifacts/pulse-project-briefing-320.png', fullPage: true });
});

test('a failed project briefing stays scoped and can retry without substituting the portfolio', async ({
  page,
}) => {
  await page.route('**/api/v1/projects/bronto-ui/brief?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic briefing unavailable' } }),
    }),
  );
  await page.goto(`/?view=brief&project=bronto-ui&from=${from}&to=${to}`);
  await expect(page.getByRole('alert')).toContainText('Synthetic briefing unavailable');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Project briefing unavailable');
  await expect(page.locator('.brief-panel')).toHaveCount(0);
  await expect(page.locator('#download')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Open project report', exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get('project')).toBe('bronto-ui');
  await page.unroute('**/api/v1/projects/bronto-ui/brief?**');
  await page.getByRole('button', { name: 'Refresh', exact: false }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI · briefing');
  await expect(page.locator('.brief-panel')).toHaveCount(1);
  await expect(page.locator('#download')).toBeEnabled();
  await expect(page.getByRole('alert')).toBeHidden();
});
