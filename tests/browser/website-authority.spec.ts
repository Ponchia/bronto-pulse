import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

for (const width of [320, 1440])
  test(
    'declared website source policy is private, readable and responsive at ' + width,
    async ({ page }) => {
      await page.setViewportSize({ width, height: 850 });
      await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
        const response = await route.fetch();
        const report = await response.json();
        report.websites = [
          {
            id: 'bronto',
            hostname: 'brontolotto.observer',
            status: 'ready',
            source: 'cf_web',
            metric: 'cloudflare.pageviews',
            value: 200,
            effectiveFrom: '2026-10-01',
            alternatives: [
              {
                source: 'cf_web',
                provider: 'cloudflare',
                metric: 'cloudflare.pageviews',
                observedValue: 200,
                coverage: 'complete',
                timezone: 'UTC',
              },
              {
                source: 'pl_web',
                provider: 'plausible',
                metric: 'plausible.pageviews',
                observedValue: 180,
                coverage: 'complete',
                timezone: 'Europe/Madrid',
              },
            ],
            reason: 'The declared preferred source has complete, observed daily pageview evidence.',
            limitation:
              'Alternative providers remain visible. Source values are never summed or silently substituted.',
          },
        ];
        await route.fulfill({
          response,
          contentType: 'application/json',
          body: JSON.stringify(report),
        });
      });
      await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
      const panel = page.locator('.website-policy-panel');
      await expect(panel.getByRole('heading', { name: 'Website source policy' })).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'brontolotto.observer' })).toBeVisible();
      await expect(panel).toContainText('200 provider-defined pageviews');
      await expect(panel).toContainText('Preferred source: cf_web');
      await expect(panel).toContainText('plausible · pl_web');
      await expect(panel).toContainText('180');
      await expect(panel).toContainText('never summed or silently substituted');
      await expect(panel).not.toContainText('380 provider-defined pageviews');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
    },
  );

test('existing projects without a website policy remain unchanged', async ({ page }) => {
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  await expect(page.locator('.website-policy-panel')).toHaveCount(0);
  await expect(page.locator('.metric-card').first()).toBeVisible();
});
