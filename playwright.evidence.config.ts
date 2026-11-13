import { defineConfig } from '@playwright/test';

// Isolated local synthetic evidence scenario; does not touch the normal demo
// webserver or provider credentials. No external network instrumentation.
export default defineConfig({
  testDir: 'tests/browser-evidence',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'node --import tsx src/cli.ts demo --scenario evidence --serve --port 4178 --db .pulse/browser-evidence.db',
    url: 'http://127.0.0.1:4178/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: { PULSE_API_TOKEN: 'synthetic-browser-test-token-not-a-real-secret' },
  },
  reporter: [['list']],
});
