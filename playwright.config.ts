import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4177', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node --import tsx src/cli.ts demo --serve --db .pulse/browser.db',
    url: 'http://127.0.0.1:4177/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: { PULSE_API_TOKEN: 'synthetic-browser-test-token-not-a-real-secret' },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
