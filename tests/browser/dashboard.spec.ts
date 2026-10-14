import { test, expect } from '@playwright/test';
const token = 'synthetic-browser-test-token-not-a-real-secret';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});
test('portfolio, source quality and metric definitions work without external tracking', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4177')) external.push(r.url());
  });
  await expect(page.locator('#mode')).toContainText('SYNTHETIC DEMO');
  await expect(page.locator('.project-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bronto UI', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project timeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Collection health' }).click();
  await expect(page.getByRole('heading', { name: 'Know what is collecting.' })).toBeVisible();
  await page.getByRole('button', { name: 'Metric definitions' }).click();
  await expect(page.getByRole('heading', { name: 'Every number has a contract.' })).toBeVisible();
  expect(external).toEqual([]);
});
for (const size of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
])
  test(`responsive layout ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    await expect(page.locator('.project-card')).toHaveCount(4);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await page.screenshot({ path: `artifacts/pulse-${size.width}.png`, fullPage: true });
  });
test('tokens are not stored in browser storage', async ({ page }) => {
  const stored = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
  }));
  expect(stored.local).toBe(0);
  expect(stored.session).toBe(0);
  expect(stored.cookie).not.toContain('pulse_session');
});

test('briefings and plans expose their limits and work with keyboard navigation', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Project briefing', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'What changed, and what did not.' }),
  ).toBeVisible();
  await expect(page.locator('.brief-panel')).toHaveCount(4);
  await page.getByRole('button', { name: 'Collection plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Know what a sync will do.' })).toBeVisible();
  await expect(
    page.getByText('Preview only — no provider requests, writes or scheduled jobs.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Know what a sync will do.' })).toBeVisible();
  await page.getByRole('button', { name: 'Collection health', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Next step' })).toBeVisible();
});
test('project CSV and Markdown downloads preserve private authenticated access', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  const csv = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV', exact: true }).click();
  expect((await csv).suggestedFilename()).toBe('pulse-bronto-ui-report.csv');
  const markdown = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download briefing', exact: true }).click();
  expect((await markdown).suggestedFilename()).toBe('pulse-bronto-ui-brief.md');
});
test('failed refresh prevents exporting stale data and can recover', async ({ page }) => {
  await expect(page.locator('#download')).toBeEnabled();
  await page.route('**/api/v1/portfolio?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic service unavailable' } }),
    }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: false }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic service unavailable');
  await expect(page.locator('#download')).toBeDisabled();
  await page.unroute('**/api/v1/portfolio?**');
  await page.getByRole('button', { name: 'Refresh', exact: false }).click();
  await expect(page.locator('#download')).toBeEnabled();
  await expect(page.getByRole('alert')).toBeHidden();
});
test('briefing and project views fit the narrowest supported width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  for (const name of ['Project briefing', 'Collection plan', 'Collection health']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('.loading')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  }
});

test('small-screen navigation retains definitions and an accessible sign-out control', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByRole('button', { name: 'Metric definitions', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Access token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open workspace' })).toBeVisible();
});
