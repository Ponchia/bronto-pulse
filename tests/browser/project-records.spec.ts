import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

test('empty saved history explains the optional owner workflow without a write control', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Saved project reviews' });
  await expect(panel).toContainText('No conclusions have been saved');
  await expect(panel).toContainText('pulse review-record');
  await expect(panel).toContainText('no action justified is a valid conclusion');
  await expect(panel.locator('input, textarea, form')).toHaveCount(0);
});

for (const width of [320, 1440]) {
  test(
    'saved conclusions and URL inspections preserve evidence and safe text at ' + width,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const external: string[] = [];
      const writes: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith('http://127.0.0.1:4177')) external.push(request.url());
        if (request.method() !== 'GET') writes.push(request.method() + ' ' + request.url());
      });
      const hostile =
        '<img src="https://example.invalid/track" onerror="window.__pulseReviewProbe=true">' +
        'long-question-'.repeat(12);
      await page.route('**/api/v1/projects/bronto-ui/reviews?limit=20', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            schemaVersion: 1,
            projectId: 'bronto-ui',
            reviews: [
              {
                schemaVersion: 1,
                id: 'review-ui-followup',
                projectId: 'bronto-ui',
                window: { from: '2026-09-01', to: '2026-09-30' },
                createdAt: '2026-10-01T10:00:00.000Z',
                question: hostile,
                conclusion:
                  'No action justified.\nCoverage remains insufficient for this question.',
                followUpOf: 'review-ui-first',
                actionUrl: 'https://example.invalid/issues/17',
                evidence: { sha256: 'a'.repeat(64) },
              },
              {
                schemaVersion: 1,
                id: 'review-ui-first',
                projectId: 'bronto-ui',
                window: { from: '2026-08-01', to: '2026-08-31' },
                createdAt: '2026-09-01T10:00:00.000Z',
                question: 'Does an unsafe action link become executable?',
                conclusion: 'The displayed conclusion is plain text.',
                actionUrl: 'javascript:window.__pulseReviewProbe=true',
                evidence: { sha256: 'b'.repeat(64) },
              },
            ],
          }),
        }),
      );
      await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
        const response = await route.fetch();
        const report = await response.json();
        const base = {
          resourceId: 'demo-search',
          inspectedAt: '2026-10-01T09:00:00.000Z',
          declaredCanonical: null,
          googleCanonical: null,
          lastCrawlTime: null,
          sitemaps: null,
          errorCode: null,
          verdict: null,
          coverageState: null,
        };
        report.inspections = [
          {
            ...base,
            id: 'seen',
            url: 'https://example.invalid/' + 'long-path-'.repeat(30),
            status: 'observed',
            verdict: 'NEUTRAL',
            coverageState: 'Crawled - currently not indexed',
          },
          {
            ...base,
            id: 'error',
            url: 'https://example.invalid/error',
            status: 'error',
            errorCode: 'RATE_LIMIT',
          },
          { ...base, id: 'unknown', url: 'https://example.invalid/unknown', status: 'unknown' },
        ];
        await route.fulfill({
          response,
          contentType: 'application/json',
          body: JSON.stringify(report),
        });
      });
      await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
      const history = page.getByRole('region', { name: 'Saved project reviews' });
      await expect(history.locator('.saved-review')).toHaveCount(2);
      await expect(history).toContainText(hostile);
      await expect(history).toContainText('2026-09-01 → 2026-09-30');
      await expect(history).toContainText('Follows review review-ui-first');
      await expect(history).toContainText('Action link unavailable');
      await expect(history.locator('img')).toHaveCount(0);
      await expect(history.locator('a[href^="javascript:"]')).toHaveCount(0);
      const action = history.getByRole('link', { name: 'Open action link · example.invalid' });
      await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(action).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(
        history.getByRole('link', { name: 'Download saved evidence' }).first(),
      ).toHaveAttribute('href', '/api/v1/projects/bronto-ui/reviews/review-ui-followup');
      const inspections = page.getByRole('region', { name: 'Stored URL inspections' });
      await expect(inspections.locator('.inspection-record')).toHaveCount(3);
      await expect(inspections).toContainText('Provider verdict: NEUTRAL');
      await expect(inspections).toContainText('Crawled - currently not indexed');
      await expect(inspections).toContainText('Inspection error: RATE_LIMIT');
      await expect(inspections).toContainText('Response: unknown');
      await expect(
        inspections.getByText('No indexed verdict is available from this inspection.', {
          exact: true,
        }),
      ).toHaveCount(2);
      await expect(inspections).toContainText(
        'An observed response is not proof that a URL is indexed',
      );
      expect(await page.evaluate(() => Reflect.get(window, '__pulseReviewProbe'))).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
      expect(external).toEqual([]);
      expect(writes).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('project-records-' + width + '.png'),
        fullPage: true,
      });
    },
  );
}

test('a history read failure preserves the current report and offers a bounded retry', async ({
  page,
}) => {
  await page.route('**/api/v1/projects/bronto-ui/reviews?limit=20', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Synthetic unavailable' } }),
    }),
  );
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  const history = page.getByRole('region', { name: 'Saved project reviews' });
  await expect(history).toContainText('Saved reviews could not be loaded');
  await expect(page.getByRole('heading', { name: 'Metric contract', exact: true })).toBeVisible();
  await expect(page.locator('#download')).toBeEnabled();
  await page.unroute('**/api/v1/projects/bronto-ui/reviews?limit=20');
  await history.getByRole('button', { name: 'Retry saved reviews', exact: true }).click();
  await expect(history).toContainText('No conclusions have been saved');
});
