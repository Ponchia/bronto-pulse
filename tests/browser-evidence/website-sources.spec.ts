import { test, expect } from '@playwright/test';

const token = 'synthetic-browser-test-token-not-a-real-secret';

for (const width of [320, 1440])
  test('evidence demo explains independent website analytics at ' + width, async ({ page }) => {
    const otherOrigins: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4178')) otherOrigins.push(request.url());
    });
    await page.setViewportSize({ width, height: 920 });
    await page.goto('/login');
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await expect(page.locator('#mode')).toContainText('SYNTHETIC DEMO');
    await expect(page.locator('.project-card')).toHaveCount(4);
    await page.getByRole('button', { name: 'Sense6', exact: true }).click();
    const panel = page.locator('.website-policy-panel');
    await expect(panel).toContainText('sense6.example.org');
    await expect(panel).toContainText('Preferred source: sense6-rum');
    await expect(panel).toContainText('provider-defined pageviews');
    await expect(panel).toContainText('plausible · sense6-plausible');
    await expect(panel).toContainText('umami · sense6-umami');
    await expect(panel).toContainText('Compared with the preferred source');
    await expect(panel).toContainText('The sources report different calendar timezones.');
    await expect(panel).toContainText('No comparable difference');
    await expect(panel).toContainText('side by side');
    await expect(panel).toContainText('of preferred');
    await expect(panel).toContainText('Source values are never summed or silently substituted.');
    await expect(
      page.getByText('Independent adoption and the human/automation split are not measured'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compare website sources' })).toBeVisible();
    expect(otherOrigins).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
  });
