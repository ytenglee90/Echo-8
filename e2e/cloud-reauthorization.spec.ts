import { test, expect } from '@playwright/test';

for (const expiredAtStartup of [true, false]) test(`Cloudflare reconnect is reachable ${expiredAtStartup ? 'on expired login' : 'after a control API rejection'} and preserves the local book`, async ({ page }) => {
  let restored = false;
  await page.route('**/api/cloud/status', route => route.fulfill({ json: {
    configured: true, authenticated: true, reauthorizationRequired: expiredAtStartup && !restored,
    user: { id: 'reconnect-user', email: 'reader@example.test' }, accounts: [],
    installations: [{ id: 'installation-reconnect', accountId: 'reconnect-account', accountName: '个人账户', workerUrl: 'https://reconnect-data.test', workerVersion: 5, latestWorkerVersion: 6, upgradeAvailable: true, status: 'ready' }],
  } }));
  await page.route('**/api/cloud/upgrade', route => route.fulfill({ status: 401, json: { error: 'Cloudflare 授权已过期，请重新连接' } }));
  await page.route('**/api/cloud/token', route => route.fulfill({ json: { installationId: 'installation-reconnect', workerUrl: 'https://reconnect-data.test', token: 'test-only', expiresAt: Date.now() + 600_000 } }));
  await page.route('https://reconnect-data.test/**', route => route.fulfill({ json: { projects: [], revision: 0, overrides: [] } }));
  await page.route('**/api/cloud/oauth/start?*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Cloudflare authorization</h1>' }));
  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library).toBeVisible();
  if (expiredAtStartup) {
    await expect(library.getByRole('button', { name: '重新连接 Cloudflare', exact: true })).toBeVisible();
  }
  await expect(library.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
  await library.press('Escape');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(3);
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('云同步设置');
  await palette.getByRole('option', { name: /^云同步设置/u }).click();
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步', exact: true });
  if (!expiredAtStartup) {
    await expect(panel.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: '一键升级', exact: true }).click();
  }
  await expect(panel.getByRole('button', { name: '重新连接 Cloudflare', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '重新连接 Cloudflare', exact: true }).click();
  await expect(page).toHaveURL(/\/api\/cloud\/oauth\/start\?returnTo=\/$/u);
  restored = true;
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Echo-8 书库' }).getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await expect(page.locator('.text-node-card')).toHaveCount(3);
  await page.locator('.canvas-surface').click({ position: { x: 1100, y: 600 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.text-node-card')).toHaveCount(2);
});
