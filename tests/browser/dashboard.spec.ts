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

for (const width of [320, 1440])
  test(`adoption interpretation is visible and fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Interpretation', exact: true })).toBeVisible();
    await expect(
      page.getByText('Independent adoption and the human/automation split are not measured', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('Evidence: distribution', { exact: true }).first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
    await page.screenshot({ path: `artifacts/pulse-evidence-${width}.png`, fullPage: true });
  });

test('owner review is a keyboard-navigable, project-scoped agenda with private Markdown', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4177')) external.push(request.url());
  });
  await page.getByRole('button', { name: 'Owner review', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'What deserves a closer look.' })).toBeVisible();
  await expect(page.locator('.owner-review-project')).toHaveCount(4);
  await expect(
    page.getByText('An operator agenda, not a priority score', { exact: false }),
  ).toBeVisible();
  const first = page.locator('.owner-review-project').first();
  await expect(first).toHaveAttribute('open', '');
  await first.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(first).not.toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('open', '');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download private Markdown review' }).click();
  expect((await download).suggestedFilename()).toBe('pulse-private-owner-review.md');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'What deserves a closer look.' })).toBeVisible();
  await first.getByRole('button', { name: /Inspect .* in detail/ }).click();
  await expect(page.getByRole('heading', { name: 'Project timeline' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'What deserves a closer look.' })).toBeVisible();
  expect(external).toEqual([]);
});

test('owner review fits phone width without concealing project navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.getByRole('button', { name: 'Owner review', exact: true }).click();
  await expect(page.locator('.loading')).toHaveCount(0);
  await expect(page.locator('.owner-review-project')).toHaveCount(4);
  await expect(page.locator('.owner-review-project').first().locator('summary')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
});

test('owner review preserves source and exact dates when opening a targeted collection plan', async ({
  page,
}) => {
  // The first demo project's missing GitHub snapshots cannot be backfilled,
  // so they correctly offer a health check instead of a fictitious plan.
  // Supply a legitimate bounded plan check in the controlled API fixture.
  await page.route('**/api/v1/review?**', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const project = payload.projects.find(
      (p: { project: { id: string } }) => p.project.id === 'bronto-ui',
    );
    const qualified = project.focus.find((f: { lane: string }) => f.lane === 'qualify');
    qualified.lead.nextChecks = [
      {
        id: 'plan.window_coverage',
        surface: 'pulse_plan',
        resourceId: 'ui-package',
        window: { from: '2026-10-20', to: '2026-10-21' },
        text: 'Inspect these source-local dates before requesting explicit collection.',
      },
    ];
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.getByRole('button', { name: 'Owner review', exact: true }).click();
  const first = page.locator('.owner-review-project').first();
  await expect(first).toHaveAttribute('open', '');
  const button = first.getByRole('button', { name: 'Inspect collection plan' });
  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Know what a sync will do.' })).toBeVisible();
  const current = new URL(page.url());
  assertRequestedSource(current.searchParams.get('resource'));
  expect(current.searchParams.get('view')).toBe('plan');
  expect(current.searchParams.get('from')).toBe('2026-10-20');
  expect(current.searchParams.get('to')).toBe('2026-10-21');
  const focused = current.searchParams.get('resource');
  expect(focused).toBe('ui-package');
  await expect(page.locator('.focus-notice')).toContainText(focused!);
  await expect(page.locator('.table-wrap tbody tr').first()).toContainText(focused!);
  const api = await page.request.get(
    '/api/v1/plan?' +
      new URLSearchParams({ from: '2026-10-20', to: '2026-10-21', resource: focused! }),
  );
  expect(api.status()).toBe(200);
  const data = await api.json();
  expect(data.jobs.length).toBeGreaterThan(0);
  expect(data.jobs.every((job: { resourceId: string }) => job.resourceId === focused)).toBe(true);
  await page.reload();
  await expect(page.locator('.focus-notice')).toContainText(focused!);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'What deserves a closer look.' })).toBeVisible();
  await page.goForward();
  await expect(page.locator('.focus-notice')).toContainText(focused!);
  await page.getByRole('button', { name: 'Show all sources' }).click();
  await expect(page.locator('.focus-notice')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('resource')).toBe(false);
});

function assertRequestedSource(resource: string | null) {
  expect(resource).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
}

test('project investigation links to exact source health and can return via browser history', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  // GitHub snapshots absent in the fixture cannot be reconstructed historically.
  await expect(
    page.locator('.investigation-panel').getByRole('button', { name: 'Inspect collection plan' }),
  ).toHaveCount(0);
  const healthLink = page
    .locator('.investigation-panel')
    .getByRole('button', {
      name: 'Open source health',
    })
    .first();
  await expect(healthLink).toBeVisible();
  await healthLink.click();
  await expect(page.getByRole('heading', { name: 'Know what is collecting.' })).toBeVisible();
  const resource = new URL(page.url()).searchParams.get('resource');
  assertRequestedSource(resource);
  await expect(page.locator('.focus-notice')).toContainText(resource!);
  const rows = page.locator('.table-wrap tbody tr');
  await expect(rows).not.toHaveCount(0);
  for (const label of await rows.locator('td:first-child').allTextContents())
    expect(label).toContain(resource!);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Bronto UI', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('resource')).toBe(null);
});

test('focused source panels remain readable on 320px and do not leak navigation targets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/?view=health&resource=source');
  await expect(page.locator('.focus-notice')).toContainText('source');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false,
  );
  await page.getByRole('button', { name: 'Collection plan' }).click();
  expect(new URL(page.url()).searchParams.has('resource')).toBe(false);
  await expect(page.locator('.focus-notice')).toHaveCount(0);
});

test('a supported comparison opens the relevant source report rather than an unrelated card', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Owner review', exact: true }).click();
  const first = page.locator('.owner-review-project').first();
  await expect(first).toHaveAttribute('open', '');
  await first.getByRole('button', { name: 'Inspect source report' }).click();
  await expect(page.getByRole('heading', { name: 'Bronto UI', exact: true })).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(params.get('view')).toBe('portfolio');
  expect(params.get('project')).toBe('bronto-ui');
  expect(params.get('resource')).toBe('ui-package');
  await expect(page.locator('.focus-notice')).toContainText('ui-package');
  const metricCards = page.locator('.metric-grid .metric-card');
  await expect(metricCards).not.toHaveCount(0);
  for (const label of await metricCards.locator('.resource').allTextContents())
    expect(label).toBe('ui-package');
  await expect(page.getByRole('heading', { name: 'Metric contract' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all sources' }).click();
  expect(new URL(page.url()).searchParams.has('resource')).toBe(false);
});

test('an explicit plan deep link stays constrained to its resource/group across reload and back', async ({
  page,
}) => {
  await page.goto('/?view=plan&resource=ui-package&group=downloads&from=2026-10-20&to=2026-10-21');
  await expect(page.getByRole('heading', { name: 'Know what a sync will do.' })).toBeVisible();
  await expect(page.locator('.focus-notice')).toContainText('ui-package / downloads');
  const rows = page.locator('.table-wrap tbody tr');
  await expect(rows).not.toHaveCount(0);
  for (const label of await rows.locator('td:first-child').allTextContents())
    expect(label).toContain('ui-package / downloads');
  await page.reload();
  await expect(page.locator('.focus-notice')).toContainText('ui-package / downloads');
  await page.getByRole('button', { name: 'Show all sources' }).click();
  await expect(page.locator('.focus-notice')).toHaveCount(0);
  const params = new URL(page.url()).searchParams;
  expect(params.has('resource')).toBe(false);
  expect(params.has('group')).toBe(false);
  await page.goBack();
  await expect(page.locator('.focus-notice')).toContainText('ui-package / downloads');
});

test('a plan next check without a specific resource stays text-only', async ({ page }) => {
  await page.route('**/api/v1/review?**', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const focus = payload.projects
      .find((p: { project: { id: string } }) => p.project.id === 'bronto-ui')
      .focus.find((f: { lane: string }) => f.lane === 'qualify');
    focus.lead.nextChecks = [
      {
        id: 'plan.window_coverage',
        surface: 'pulse_plan',
        resourceId: null,
        window: { from: '2026-10-20', to: '2026-10-21' },
        text: 'The source has not been selected; inspect configuration before planning.',
      },
    ];
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.getByRole('button', { name: 'Owner review', exact: true }).click();
  const first = page.locator('.owner-review-project').first();
  await expect(first).toHaveAttribute('open', '');
  await expect(first).toContainText('The source has not been selected');
  await expect(first.getByRole('button', { name: 'Inspect collection plan' })).toHaveCount(0);
});
