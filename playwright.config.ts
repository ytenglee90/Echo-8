import { defineConfig, devices } from '@playwright/test';

const externalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium',
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
