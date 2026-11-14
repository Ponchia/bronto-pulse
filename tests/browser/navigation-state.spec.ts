import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});
const current = (page: import('@playwright/test').Page) =>
  page
    .locator('[data-view]')
    .evaluateAll((items) =>
      items
        .filter((item) => item.getAttribute('aria-current') === 'page')
        .map((item) => (item as HTMLElement).dataset.view),
    );

test('a reloaded view marks its own navigation item and period as current', async ({ page }) => {
  // First load: the active item is exposed to assistive technology, not only styled.
  expect(await current(page)).toEqual(['portfolio']);
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto('/?view=brief&from=2026-10-01&to=2026-10-05');
  await expect(
    page.getByRole('heading', { name: 'What changed, and what did not.' }),
  ).toBeVisible();
  expect(await current(page)).toEqual(['brief']);
  // Custom dates are not one of the presets, so none of them claims to be selected.
  for (const name of ['14 days', '30 days', '90 days']) {
    const preset = page.getByRole('button', { name });
    await expect(preset).toHaveAttribute('aria-pressed', 'false');
    await expect(preset).not.toHaveClass(/selected/);
  }
  await page.getByRole('button', { name: '14 days' }).click();
  await expect(page.getByRole('button', { name: '14 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: '30 days' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('opening and leaving a project keeps keyboard focus and announces the result', async ({
  page,
}) => {
  // The whole report is not a live region: only a short status is announced.
  await expect(page.locator('#content')).not.toHaveAttribute('aria-live', /.+/);
  const status = page.locator('#load-status');
  await expect(status).toHaveAttribute('role', 'status');
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).focus();
  await page.keyboard.press('Enter');
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText('Bronto UI');
  // The pressed control no longer exists; focus moves to the new page title.
  await expect(title).toBeFocused();
  await expect(status).toHaveText('Bronto UI loaded.');
  await page.getByRole('button', { name: '← All projects' }).focus();
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('Signals, with context.');
  await expect(title).toBeFocused();
  // A control that survives the reload keeps focus.
  await page.locator('#refresh').focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Signals, with context. loaded.');
  await expect(page.locator('#refresh')).toBeFocused();
  await expect(page.locator('#refresh')).toBeEnabled();
});

test('browser back and forward move between the portfolio and a project', async ({ page }) => {
  await page.getByRole('button', { name: 'Bronto UI', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
  expect(new URL(page.url()).searchParams.get('project')).toBe('bronto-ui');
  await page.getByRole('button', { name: 'Collection health' }).click();
  await expect(page.getByRole('heading', { name: 'Know what is collecting.' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
  expect(await current(page)).toEqual(['portfolio']);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
  await expect(page.locator('.project-card')).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bronto UI');
  // Refreshing or changing dates rewrites the current entry instead of stacking new ones.
  await page.locator('#refresh').click();
  await expect(page.locator('#load-status')).toHaveText('Bronto UI loaded.');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Signals, with context.' })).toBeVisible();
});

test('an unreadable server answer is reported in plain words', async ({ page }) => {
  await page.route('**/api/v1/portfolio?**', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<html><body>Bad gateway</body></html>',
    }),
  );
  await page.locator('#refresh').click();
  await expect(page.locator('#error')).toHaveText(
    'The server returned an unreadable answer (502). Nothing was changed.',
  );
  await expect(page.locator('#content')).toContainText('The report could not be loaded.');
  await expect(page.locator('#load-status')).toHaveText('The report could not be loaded.');
  await expect(page.locator('#download')).toBeDisabled();
});
