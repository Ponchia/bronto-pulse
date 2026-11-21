import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import type { ProjectReport } from '../../src/report.js';
import type { ReviewRecord } from '../../src/review-record.js';

const token = 'synthetic-browser-test-token-not-a-real-secret';
const reviewPath = '/api/v1/projects/bronto-ui/reviews/';
const deepLink = (id: string) => '/?view=saved-review&project=bronto-ui&review=' + id;
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

async function records(page: Page) {
  const response = await page.request.get(
    '/api/v1/projects/bronto-ui/report?from=2026-11-01&to=2026-11-10',
  );
  expect(response.ok()).toBe(true);
  const template = (await response.json()) as ProjectReport;
  const make = (id: string, value: number, followUpOf?: string): ReviewRecord => {
    const report = structuredClone(template);
    const downloads = report.cards.find((card) => card.metric === 'npm.downloads');
    expect(downloads).toBeDefined();
    report.cards = [{ ...downloads!, value, latestValue: value }];
    const lead = report.investigation!.findings[0]!;
    expect(lead).toBeDefined();
    report.investigation!.findings = Array.from({ length: 6 }, (_, i) => ({
      ...lead,
      id: 'saved-lead-' + i,
      summary: 'Saved evidence lead ' + i,
    }));
    report.investigation!.omittedFindings = 3;
    report.warnings = ['Synthetic saved warning: a download does not identify a person.'];
    return {
      schemaVersion: 1,
      id,
      projectId: 'bronto-ui',
      window: report.window,
      question: '<img src="https://example.invalid/track"> ' + 'Saved question '.repeat(12),
      conclusion: 'No action justified.\nThe original evidence remains available.',
      createdAt: '2026-11-12T10:00:00.000Z',
      actionUrl: 'https://example.invalid/issues/17',
      ...(followUpOf ? { followUpOf } : {}),
      evidence: {
        sha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
        report,
      },
    };
  };
  const parent = make('review-ui-first', 1234);
  const child = make('review-ui-followup', 4321, parent.id);
  await page.route('**/api/v1/projects/bronto-ui/reviews?limit=20', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        projectId: 'bronto-ui',
        reviews: [child, parent].map(({ evidence, ...review }) => ({
          ...review,
          evidence: { sha256: evidence.sha256 },
        })),
      },
    }),
  );
  await page.route('**/api/v1/projects/bronto-ui/report?**', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    report.cards = [
      {
        ...report.cards.find((card: { metric: string }) => card.metric === 'npm.downloads'),
        value: 9999,
        latestValue: 9999,
      },
    ];
    await route.fulfill({ response, json: report });
  });
  for (const record of [child, parent])
    await page.route('**' + reviewPath + record.id, (route) => route.fulfill({ json: record }));
  return { child, parent };
}

for (const width of [320, 1440]) {
  test(
    'saved evidence remains frozen through navigation and reload at ' + width,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { child, parent } = await records(page);
      const requests: string[] = [];
      const external: string[] = [];
      const writes: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
        if (url.origin !== 'http://127.0.0.1:4177') external.push(request.url());
        if (request.method() !== 'GET') writes.push(request.method());
      });
      await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
      await expect(page.locator('.metric-value')).toHaveText('9,999');
      const originalUrl = page.url();
      const link = page.getByRole('link', { name: 'Read saved review', exact: true }).first();
      await expect(link).toHaveAttribute('href', deepLink(child.id));
      requests.length = 0;
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saved review · Bronto UI');
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      const summary = page.getByRole('region', { name: 'Saved review conclusion' });
      await expect(summary).toContainText(child.question);
      await expect(summary).toContainText(child.conclusion);
      await expect(summary).toContainText('Frozen evidence');
      await expect(summary.locator('img')).toHaveCount(0);
      await expect(page.locator('.metric-value')).toHaveText('4,321');
      await expect(page.getByLabel('From', { exact: true })).toHaveValue(child.window.from);
      await expect(page.getByLabel('To', { exact: true })).toHaveValue(child.window.to);
      for (const id of ['from', 'to', 'apply']) await expect(page.locator('#' + id)).toBeDisabled();
      await expect(page.getByRole('button', { name: '30 days' })).toBeDisabled();
      await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(page.locator('#mode')).toHaveText('SYNTHETIC DEMO');
      await expect(page.locator('#freshness')).toHaveText('Saved ' + child.createdAt);
      await summary.getByText('Evidence identity', { exact: true }).click();
      await expect(summary).toContainText(child.evidence.sha256);
      await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Download briefing' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Saved project reviews' })).toHaveCount(0);
      await expect(page.locator('.source-comparison')).toHaveCount(0);
      const leads = page.getByRole('region', { name: 'What to verify next' });
      await expect(leads.locator('.investigation-checks button')).toHaveCount(0);
      await leads.getByRole('button', { name: 'Show 6 of 9 leads' }).click();
      await expect(leads.locator('.investigation-item')).toHaveCount(6);
      await expect(leads).toContainText('remaining 3 were not included in this saved evidence');
      expect(requests).toEqual([reviewPath + child.id]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
        false,
      );
      await page.screenshot({
        path: testInfo.outputPath('saved-review-' + width + '.png'),
        fullPage: true,
      });

      await summary.getByRole('link', { name: 'Open preceding review · ' + parent.id }).click();
      await expect(page.locator('.metric-value')).toHaveText('1,234');
      await expect(page.getByRole('link', { name: /Open preceding review/ })).toHaveCount(0);
      expect(requests).toEqual([reviewPath + child.id, reviewPath + parent.id]);
      await page.goBack();
      await expect(page.locator('.metric-value')).toHaveText('4,321');
      await page.reload();
      await expect(page.locator('.metric-value')).toHaveText('4,321');
      expect(new URL(page.url()).searchParams.has('from')).toBe(false);
      await page.locator('#refresh').click();
      await expect(page.locator('#load-status')).toHaveText('Saved review · Bronto UI loaded.');
      expect(requests.every((path) => path.startsWith(reviewPath))).toBe(true);

      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export saved review ↓' }).click();
      const exported = await download;
      expect(exported.suggestedFilename()).toBe('pulse-review-' + child.id + '.json');
      const exportedRecord = JSON.parse(await readFile((await exported.path())!, 'utf8'));
      expect(exportedRecord).toEqual(child);
      await page.getByRole('button', { name: 'Open current evidence for these dates' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
      await expect(page.getByRole('region', { name: 'Saved review conclusion' })).toHaveCount(0);
      await expect(page.locator('.metric-value')).toHaveText('9,999');
      await expect(page.getByLabel('From', { exact: true })).toBeEnabled();
      await expect(page.getByLabel('From', { exact: true })).toHaveValue(child.window.from);
      expect(new URL(page.url()).searchParams.get('review')).toBeNull();
      expect(
        requests.some(
          (path) =>
            path ===
            '/api/v1/projects/bronto-ui/report?from=' +
              child.window.from +
              '&to=' +
              child.window.to,
        ),
      ).toBe(true);
      await page.goBack();
      await expect(page.locator('.metric-value')).toHaveText('4,321');
      await page.goBack();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
      expect(page.url()).toBe(originalUrl);
      await page.goForward();
      await expect(page.locator('.metric-value')).toHaveText('4,321');
      expect(external).toEqual([]);
      expect(writes).toEqual([]);
    },
  );
}

test('missing or mismatched saved evidence never falls back to a current report, and retry recovers', async ({
  page,
}) => {
  const { child } = await records(page);
  let mode: 'missing' | 'mismatched' | 'valid' = 'missing';
  await page.route('**' + reviewPath + child.id, (route) =>
    mode === 'missing'
      ? route.fulfill({ status: 404, json: { error: { message: 'Review was not found.' } } })
      : route.fulfill({ json: mode === 'mismatched' ? { ...child, id: 'other-review' } : child }),
  );
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push(path);
  });
  await page.goto(deepLink(child.id));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saved review unavailable');
  await expect(page.locator('#error')).toHaveText('Review was not found.');
  await expect(page.locator('#content')).toContainText('not replaced with a current report');
  await expect(page.locator('#download')).toBeDisabled();
  mode = 'mismatched';
  await page.locator('#refresh').click();
  await expect(page.locator('#error')).toContainText('does not match this review');
  await expect(page.locator('.metric-card')).toHaveCount(0);
  await expect(page.locator('#download')).toBeDisabled();
  mode = 'valid';
  await page.locator('#refresh').click();
  await expect(page.locator('.metric-value')).toHaveText('4,321');
  await expect(page.locator('#download')).toBeEnabled();
  expect(requests).toEqual(Array(3).fill(reviewPath + child.id));
});

test('an incomplete saved-review link fails before a broader private read', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push(path);
  });
  await page.goto('/?view=saved-review&project=bronto-ui&review=bad');
  await expect(page.locator('#error')).toContainText('incomplete or invalid');
  await expect(page.locator('#download')).toBeDisabled();
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Open project report', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
  await expect(page.getByLabel('From', { exact: true })).toBeEnabled();
});
