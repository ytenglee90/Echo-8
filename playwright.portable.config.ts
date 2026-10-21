import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './portable-e2e',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'chromium-file',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
