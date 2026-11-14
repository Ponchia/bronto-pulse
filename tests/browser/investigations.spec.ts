import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});
for (const width of [320, 390, 1440]) {
  test(
    'investigation evidence and next checks are safe and readable at ' + width,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const externalRequests: string[] = [];
      page.on('request', (request) => {
        if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname))
          externalRequests.push(request.url());
      });
      const hostile =
        '<img src="https://example.invalid/track" onerror="window.__pulseProbe=true">' +
        'long-source-'.repeat(20);
      await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
        const response = await route.fetch();
        const report = await response.json();
        expect(report.investigation.findings.length).toBeGreaterThan(0);
        report.investigation.findings[0].summary = hostile;
        await route.fulfill({
          response,
          contentType: 'application/json',
          body: JSON.stringify(report),
        });
      });
      await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
      const panel = page.locator('.investigation-panel');
      await expect(
        panel.getByRole('heading', { name: 'What to verify next', exact: true }),
      ).toBeVisible();
      await expect(panel.locator('.investigation-item').first()).toContainText(hostile);
      await expect(panel.getByLabel('Next checks').first()).toBeVisible();
      const details = panel.locator('details').first();
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('open', '');
      await expect(panel.locator('img')).toHaveCount(0);
      expect(await page.evaluate(() => Reflect.get(window, '__pulseProbe'))).toBeUndefined();
      const graph = page.locator('.resource-graph-panel');
      await graph.locator('summary').click();
      await expect(graph).toHaveAttribute('open', '');
      await expect(graph).toContainText('Declared resource relationships');
      await expect(graph).toContainText('config declared');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
      expect(externalRequests).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('investigation-' + width + '.png'),
        fullPage: true,
      });
    },
  );
}

test('portfolio briefing exposes investigation steps while retaining original metric findings', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Project briefing', exact: true }).click();
  await expect(page.locator('.brief-panel')).toHaveCount(4);
  await expect(page.locator('.brief-panel .investigation-panel')).toHaveCount(4);
  await expect(page.locator('.brief-panel .findings').first()).toBeVisible();
});
