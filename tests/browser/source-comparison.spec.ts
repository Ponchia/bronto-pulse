import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';

test('source comparison requires confirmation and never adds provider pageviews', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();

  await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const first = report.cards[0];
    const card = (id: string, provider: 'cloudflare' | 'umami', value: number) => ({
      ...first,
      key: id + ':pageviews',
      resourceId: id,
      provider,
      metric: provider + '.pageviews',
      label: provider === 'cloudflare' ? 'Cloudflare pageviews' : 'Umami pageviews',
      unit: 'pageviews',
      aggregation: 'sum',
      value,
      latestValue: value / 2,
      methodology: provider + '-test-v1',
      timezone: 'UTC',
      dimensions: {},
      scope: {},
    });
    report.cards.push(card('cf_web', 'cloudflare', 100), card('um_web', 'umami', 80));
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(report),
    });
  });

  let comparisons = 0;
  await page.route('**/api/v1/projects/bronto-ui/source-comparison?**', async (route) => {
    comparisons++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get('same_site')).toBe('confirmed');
    expect(url.searchParams.get('primary')).toBe('cf_web');
    expect(url.searchParams.get('secondary')).toBe('um_web');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        status: 'side_by_side',
        window: { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
        sources: [
          {
            resourceId: 'cf_web',
            metric: 'cloudflare.pageviews',
            provider: 'cloudflare',
            timezone: 'UTC',
            observedDays: 30,
            expectedDays: 30,
            value: 100,
            methodology: 'cloudflare-test-v1',
          },
          {
            resourceId: 'um_web',
            metric: 'umami.pageviews',
            provider: 'umami',
            timezone: 'UTC',
            observedDays: 30,
            expectedDays: 30,
            value: 80,
            methodology: 'umami-test-v1',
          },
        ],
        difference: { absolute: -20, percentOfPrimary: -0.2 },
        reasons: ['Source methods remain independent.'],
        limitation: 'Never add provider totals together.',
      }),
    });
  });
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compare website sources' })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Compare source observations' });
  await expect(submit).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Primary website analytics resource' })
    .selectOption('cf_web');
  await page
    .getByRole('combobox', { name: 'Secondary website analytics resource' })
    .selectOption('um_web');
  await expect(submit).toBeDisabled();
  await page
    .getByText('I confirm both resources represent the same website and intended pageview scope.')
    .click();
  await expect(submit).toBeEnabled();
  expect(comparisons).toBe(0);
  await submit.click();
  await expect(
    page.getByRole('heading', { name: 'Side-by-side source observations' }),
  ).toBeVisible();
  await expect(page.locator('.compare-result')).toContainText('Secondary minus primary: -20');
  await expect(page.locator('.compare-result')).toContainText(
    'Never add provider totals together.',
  );
  expect(comparisons).toBe(1);
  // Changing either source invalidates the manual assertion and clears results.
  await page
    .getByRole('combobox', { name: 'Secondary website analytics resource' })
    .selectOption('cf_web');
  await expect(submit).toBeDisabled();
  await expect(page.locator('.compare-result')).toBeEmpty();
});

test('source comparison controls fit narrow screens and remain keyboard-accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
  await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const first = report.cards[0];
    for (const [id, provider] of [
      ['cf_web', 'cloudflare'],
      ['um_web', 'umami'],
    ] as const)
      report.cards.push({
        ...first,
        key: id,
        resourceId: id,
        provider,
        metric: provider + '.pageviews',
        label: 'Pageviews',
        unit: 'pageviews',
        aggregation: 'sum',
      });
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(report),
    });
  });
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Compare website sources' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Primary website analytics resource' }).focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('combobox', { name: 'Secondary website analytics resource' }),
  ).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
});

test('a changed source selection cancels an in-flight comparison result', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();

  await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    const first = report.cards[0];
    for (const [id, provider] of [
      ['cf_web', 'cloudflare'],
      ['um_web', 'umami'],
    ] as const)
      report.cards.push({
        ...first,
        key: id,
        resourceId: id,
        provider,
        metric: provider + '.pageviews',
        label: 'Pageviews',
        unit: 'pageviews',
        aggregation: 'sum',
      });
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(report),
    });
  });
  await page.route('**/api/v1/projects/bronto-ui/source-comparison?**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        status: 'side_by_side',
        sources: [],
        difference: { absolute: -20, percentOfPrimary: -0.2 },
        reasons: ['Stale result'],
        limitation: 'Stale content must be discarded.',
      }),
    });
  });
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  const primary = page.getByRole('combobox', { name: 'Primary website analytics resource' });
  const secondary = page.getByRole('combobox', { name: 'Secondary website analytics resource' });
  await primary.selectOption('cf_web');
  await secondary.selectOption('um_web');
  await page
    .getByText('I confirm both resources represent the same website and intended pageview scope.')
    .click();
  const response = page.waitForResponse('**/api/v1/projects/bronto-ui/source-comparison?**');
  await page.getByRole('button', { name: 'Compare source observations' }).click();
  await secondary.selectOption('cf_web');
  await response;
  await page.waitForTimeout(30);
  await expect(page.locator('.compare-result')).toBeEmpty();
  await expect(page.getByRole('button', { name: 'Compare source observations' })).toBeDisabled();
});
