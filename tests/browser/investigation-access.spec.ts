import { test, expect, type Page, type Route } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

type Lead = { id: string; summary: string; limitations: string[] };
/** Synthetic leads cloned from a real demo lead, so every field keeps its real shape. */
function leads(template: Lead, count: number): Lead[] {
  return Array.from({ length: count }, (_, i) => ({
    ...template,
    id: `${template.id}~synthetic-${i + 1}`,
    summary: `Synthetic lead ${i + 1} of ${count}.`,
    limitations: [`Synthetic limit for lead ${i + 1}.`],
  }));
}
/** Serve the demo report for Bronto UI with a chosen number of listed and omitted leads. */
async function reportWith(page: Page, listed: number, omitted: number) {
  const seen: { window?: { from: string; to: string }; template?: Lead } = {};
  await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    seen.window = report.window;
    seen.template = report.investigation.findings[0];
    report.investigation.findings = leads(seen.template!, listed);
    report.investigation.omittedFindings = omitted;
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(report),
    });
  });
  return seen;
}
const openProject = (page: Page) =>
  page.getByRole('button', { name: 'Bronto UI', exact: true }).click();

test('leads beyond the first five open in place with the keyboard and keep their limits', async ({
  page,
}) => {
  await reportWith(page, 8, 0);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await openProject(page);
  const panel = page.locator('.investigation-panel');
  await expect(panel.locator('.investigation-item')).toHaveCount(5);
  await expect(panel.locator('.investigation-count')).toHaveText('Showing 5 of 8 leads.');
  await expect(panel).not.toContainText('API');
  await expect(panel).not.toContainText('JSON report');
  const more = panel.getByRole('button', { name: 'Show all 8 leads' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('.investigation-item')).toHaveCount(8);
  await expect(panel.locator('.investigation-count')).toHaveText('Showing all 8 leads.');
  await expect(more).toHaveCount(0);
  // Focus lands on the first newly shown lead, so reading continues from there.
  await expect(panel.locator('.investigation-item').nth(5)).toBeFocused();
  await expect(panel.locator('.investigation-item').nth(5)).toContainText('Synthetic lead 6 of 8.');
  // Every lead, including the newly shown ones, still carries its own limit.
  const last = panel.locator('.investigation-item').nth(7);
  await last.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(last).toContainText('Synthetic limit for lead 8.');
  // Leads already in the report need no further request.
  expect(requests.filter((path) => path.endsWith('/investigation'))).toEqual([]);
});

test('leads the report omitted load on demand for the same project and dates', async ({ page }) => {
  const seen = await reportWith(page, 20, 4);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const asked: URL[] = [];
  await page.route('**/api/v1/projects/bronto-ui/investigation?**', async (route) => {
    asked.push(new URL(route.request().url()));
    await held;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        project: { id: 'bronto-ui', label: 'Bronto UI', description: '' },
        window: seen.window,
        generatedAt: new Date().toISOString(),
        demo: true,
        investigation: {
          schemaVersion: 1,
          findings: leads(seen.template!, 24),
          omittedFindings: 0,
          limitation: 'Synthetic limitation.',
        },
      }),
    });
  });
  await openProject(page);
  const panel = page.locator('.investigation-panel');
  await expect(panel.locator('.investigation-count')).toHaveText('Showing 5 of 24 leads.');
  // An edited but unapplied date must not change which report the leads belong to.
  await page.getByLabel('From').fill('2020-01-01');
  const first = panel.locator('.investigation-item').first();
  await first.locator('summary').click();
  await expect(first.locator('details')).toHaveAttribute('open', '');
  await panel.getByRole('button', { name: 'Show all 24 leads' }).click();
  // While the request is pending the control says so and cannot be pressed twice.
  const busy = panel.getByRole('button', { name: 'Loading leads…' });
  await expect(busy).toBeDisabled();
  await expect(panel.locator('.investigation-list')).toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator('.investigation-item')).toHaveCount(5);
  release();
  await expect(panel.locator('.investigation-item')).toHaveCount(24);
  await expect(panel.locator('.investigation-count')).toHaveText('Showing all 24 leads.');
  await expect(panel.locator('.investigation-list')).not.toHaveAttribute('aria-busy', 'true');
  await expect(panel.locator('.investigation-item').nth(5)).toBeFocused();
  // A lead the reader had opened stays open.
  await expect(panel.locator('.investigation-item').first().locator('details')).toHaveAttribute(
    'open',
    '',
  );
  expect(asked).toHaveLength(1);
  expect(asked[0]!.searchParams.get('from')).toBe(seen.window!.from);
  expect(asked[0]!.searchParams.get('to')).toBe(seen.window!.to);
  expect(asked[0]!.searchParams.get('limit')).toBe('100');
});

test('a failed load keeps the shown leads, says so and can be retried', async ({
  page,
}, testInfo) => {
  const seen = await reportWith(page, 20, 4);
  let fail = true;
  await page.route('**/api/v1/projects/bronto-ui/investigation?**', async (route: Route) => {
    if (fail)
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Synthetic failure.' } }),
      });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        project: { id: 'bronto-ui', label: 'Bronto UI', description: '' },
        window: seen.window,
        generatedAt: new Date().toISOString(),
        demo: true,
        investigation: {
          schemaVersion: 1,
          findings: leads(seen.template!, 100),
          omittedFindings: 30,
          limitation: 'Synthetic limitation.',
        },
      }),
    });
  });
  await openProject(page);
  const panel = page.locator('.investigation-panel');
  const more = panel.getByRole('button', { name: 'Show all 24 leads' });
  await more.click();
  await expect(panel.getByRole('alert')).toHaveText(
    'The remaining leads could not be loaded. The 5 leads shown are unchanged.',
  );
  await expect(panel.locator('.investigation-item')).toHaveCount(5);
  await expect(more).toBeEnabled();
  await expect(more).toBeFocused();
  // The page-level error is for a failed report, not for this optional load.
  await expect(page.locator('#error')).toBeHidden();
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('leads-load-failed.png') });
  fail = false;
  await more.click();
  await expect(panel.locator('.investigation-item')).toHaveCount(100);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  // More than the view can list: the rest are counted, never silently dropped.
  await expect(panel.locator('.investigation-count')).toHaveText(
    'Showing 100 of 130 leads. This view lists at most 100; the remaining 30 are counted, not listed.',
  );
});

test('a late answer for a project the reader has left is discarded', async ({ page }) => {
  const seen = await reportWith(page, 20, 4);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/projects/bronto-ui/investigation?**', async (route) => {
    await held;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        project: { id: 'bronto-ui', label: 'Bronto UI', description: '' },
        window: seen.window,
        generatedAt: new Date().toISOString(),
        demo: true,
        investigation: {
          schemaVersion: 1,
          findings: leads(seen.template!, 24),
          omittedFindings: 0,
          limitation: 'Synthetic limitation.',
        },
      }),
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openProject(page);
  await page
    .locator('.investigation-panel')
    .getByRole('button', { name: 'Show all 24 leads' })
    .click();
  await page.getByRole('button', { name: '← All projects' }).click();
  await expect(page.locator('.project-card')).toHaveCount(4);
  release();
  await page.waitForTimeout(300);
  await expect(page.locator('.investigation-item')).toHaveCount(0);
  await expect(page.locator('.project-card')).toHaveCount(4);
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

for (const width of [320, 1440])
  test(`a fully opened lead list stays readable and reachable at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await reportWith(page, 20, 0);
    await openProject(page);
    const panel = page.locator('.investigation-panel');
    const more = panel.getByRole('button', { name: 'Show all 20 leads' });
    const box = await more.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await more.click();
    await expect(panel.locator('.investigation-item')).toHaveCount(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
    // Each lead is a named region a screen-reader user can jump between.
    const names = await panel
      .getByRole('article')
      .evaluateAll((items) =>
        items.map(
          (item) =>
            document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent,
        ),
      );
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
    expect(names[19]).toBe('Synthetic lead 20 of 20.');
    await panel.locator('.investigation-count').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`leads-open-${width}.png`) });
  });

test('each briefing panel opens its own project leads', async ({ page }) => {
  await page.route('**/api/v1/brief?**', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const brief of data.briefs) {
      const template = brief.investigation.findings[0];
      if (!template) continue;
      brief.investigation.findings = leads(template, 6).map((lead) => ({
        ...lead,
        summary: `${brief.project.id}: ${lead.summary}`,
      }));
      brief.investigation.omittedFindings = 0;
    }
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.getByRole('button', { name: 'Project briefing', exact: true }).click();
  const panels = page.locator('.brief-panel');
  await expect(panels).toHaveCount(4);
  const first = panels.first();
  await expect(first.locator('.investigation-item')).toHaveCount(3);
  await first.getByRole('button', { name: 'Show all 6 leads' }).click();
  await expect(first.locator('.investigation-item')).toHaveCount(6);
  // Opening one project's leads leaves the others as they were.
  await expect(panels.nth(1).locator('.investigation-item')).toHaveCount(3);
  // The original briefing findings stay below the leads.
  await expect(first.locator('.findings')).toBeVisible();
});
