import { defineConfig, devices } from '@playwright/test';

const externalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './browser-performance',
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-performance',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: externalServer ? undefined : {
    command: 'node node_modules/vinext/dist/cli.js dev',
    env: {
      PLAYWRIGHT_TEST: 'true',
    },
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
