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
  },
  projects: [
    {
      name: 'firefox-file',
      use: { ...devices['Desktop Firefox'], launchOptions: { timeout: 20_000 } },
    },
    {
      name: 'webkit-file',
      use: { ...devices['Desktop Safari'], launchOptions: { timeout: 20_000 } },
    },
  ],
});
