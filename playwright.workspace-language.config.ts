import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './language-e2e', fullyParallel: true, workers: 3,
  timeout: 45_000, expect: { timeout: 3000 }, retries: 0,
  outputDir: 'local-data/workspace-language-results',
  reporter: [['list'], ['./language-e2e/reporter.ts']],
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000',
    permissions: ['clipboard-read', 'clipboard-write'], trace: 'off', serviceWorkers: 'block', actionTimeout: 5000 },
  webServer: { command: 'node node_modules/vinext/dist/cli.js dev', env: { PLAYWRIGHT_TEST: 'true' },
    url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
});
