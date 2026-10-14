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
