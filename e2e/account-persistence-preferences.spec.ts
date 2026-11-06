import { test, expect, type Browser, type Page } from '@playwright/test';
import dataWorker from '../cloud/data-worker/worker.js';
import { SQLiteD1 } from '../tests/helpers/d1.ts';
import { signDataToken } from '../src/server/cloud/crypto.ts';

async function command(page: Page, label: string) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '命令面板' });
  await panel.getByRole('textbox', { name: '搜索命令' }).fill(label);
  await panel.getByRole('option', { name: new RegExp(`^${label}`, 'u') }).first().click();
}

async function account(browser: Browser) {
  const db = new SQLiteD1();
  const env = { DB: db, DATA_WORKER_VERSION: '6', STORAGE_MODE: 'd1', INSTALLATION_ID: 'preferences-browser-installation', DATA_SIGNING_SECRET: 'browser-preferences-test-secret', ALLOWED_ORIGIN: 'http://localhost:3000' };
  const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
  const device = async (user = 'alice') => {
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage();
    const token = await signDataToken({ sub: user, aud: env.INSTALLATION_ID, installationId: env.INSTALLATION_ID, scope: ['projects:read', 'projects:write'] }, env.DATA_SIGNING_SECRET, 600);
    await page.route('**/api/cloud/status', route => route.fulfill({ json: {
      configured: true, authenticated: true, user: { id: user }, accounts: [],
      installations: [{ id: env.INSTALLATION_ID, accountId: 'preferences-account', accountName: '个人账户', workerUrl: 'https://preferences-data.test', workerVersion: 6, latestWorkerVersion: 6, upgradeAvailable: false, status: 'ready' }],
    } }));
    await page.route('**/api/cloud/token', route => route.fulfill({ json: { installationId: env.INSTALLATION_ID, workerUrl: 'https://preferences-data.test', token: token.token, expiresAt: Date.now() + 600_000 } }));
    await page.route('https://preferences-data.test/**', async route => {
      const request = route.request();
      const response = await dataWorker.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(),
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postData() ?? undefined }) }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('/');
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await command(page, '云同步设置');
    await expect(page.getByText(/^保存设置已同步：/u)).toBeVisible();
    await command(page, '书籍与恢复设置');
    return page;
  };
  const stored = () => db.sqlite.prepare("SELECT revision, body_json FROM account_preferences WHERE user_id='alice'").get();
  return { device, stored, close: async () => { await Promise.all(contexts.map(context => context.close())); db.sqlite.close(); } };
}

const interval = (page: Page) => page.getByRole('combobox', { name: '自动保存当前目标的间隔' });
const retention = (page: Page) => page.getByRole('combobox', { name: '恢复副本自动保留数量' });
async function keep(page: Page, value: string) {
  await retention(page).selectOption(value);
  await page.getByRole('group', { name: '确认清理恢复副本' }).getByRole('button', { name: '确认更改', exact: true }).click();
  await expect(retention(page)).toHaveValue(value);
}

test('personal cadence and retention restore on fresh devices, including disabled and unlimited, without transferring recovery copies', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await account(browser);
  try {
    const first = await a.device();
    await interval(first).selectOption('0'); await keep(first, '8');
    await first.getByRole('button', { name: '创建手动恢复点', exact: true }).click();
    await expect(first.locator('.recovery-row')).toHaveCount(1);
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 0, recoveryRetentionLimit: 8 });
    const second = await a.device();
    await expect(interval(second)).toHaveValue('0'); await expect(retention(second)).toHaveValue('8');
    await expect(second.locator('.recovery-row')).toHaveCount(0);
    await interval(second).selectOption('1000'); await keep(second, 'none');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 1000, recoveryRetentionLimit: null });
    const third = await a.device();
    await expect(interval(third)).toHaveValue('1000'); await expect(retention(third)).toHaveValue('none');
    await interval(third).selectOption('300000');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 300000 });
    await third.reload(); await third.getByRole('region', { name: 'Echo-8 书库' }).press('Escape'); await command(third, '书籍与恢复设置');
    await expect(interval(third)).toHaveValue('300000'); await expect(retention(third)).toHaveValue('none');
    const other = await a.device('bob'); await expect(interval(other)).toHaveValue('60000'); await expect(retention(other)).toHaveValue('none');
  } finally { await a.close(); }
});

test('concurrent device preference edits retain local choices until explicit account conflict resolution', async ({ browser }, info) => {
  const a = await account(browser);
  try {
    const first = await a.device(), second = await a.device();
    await interval(first).selectOption('0');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json)).autosaveIntervalMs).toBe(0);
    await interval(second).selectOption('300000');
    await command(second, '云同步设置');
    await expect(second.getByRole('button', { name: '使用账号保存设置', exact: true })).toBeVisible();
    await second.screenshot({ path: info.outputPath('saving-preferences-conflict.png') });
    expect(JSON.parse(String(a.stored()?.body_json)).autosaveIntervalMs).toBe(0);
    await second.getByRole('button', { name: '使用账号保存设置', exact: true }).click();
    await command(second, '书籍与恢复设置'); await expect(interval(second)).toHaveValue('0');
    await expect(second.locator('.text-node-card')).toHaveCount(2);
  } finally { await a.close(); }
});

test('a failed account preference write rolls back both local policies and retention cleanup', async ({ browser }) => {
  test.setTimeout(60_000);
  const a = await account(browser);
  try {
    const first = await a.device(), second = await a.device();
    for (let count = 0; count < 9; count++) await second.getByRole('button', { name: '创建手动恢复点', exact: true }).click();
    await expect(second.locator('.recovery-row')).toHaveCount(9);
    await interval(first).selectOption('0'); await keep(first, '8');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 0, recoveryRetentionLimit: 8 });
    await second.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === 'meta' && key === 'autosave-interval-ms') {
          IDBObjectStore.prototype.put = original;
          throw new DOMException('模拟设置写入失败', 'QuotaExceededError');
        }
        return original.call(this, value, key);
      };
    });
    await command(second, '云同步设置');
    await second.getByRole('button', { name: '同步保存设置', exact: true }).click();
    await expect(second.getByText('模拟设置写入失败', { exact: true })).toBeVisible();
    await command(second, '书籍与恢复设置');
    await expect(interval(second)).toHaveValue('60000'); await expect(retention(second)).toHaveValue('none');
    await expect(second.locator('.recovery-row')).toHaveCount(9);
    await expect(second.locator('.text-node-card')).toHaveCount(2);
    await second.reload(); await second.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await command(second, '书籍与恢复设置');
    await expect(interval(second)).toHaveValue('0'); await expect(retention(second)).toHaveValue('8');
    await expect(second.locator('.recovery-row')).toHaveCount(8);
  } finally { await a.close(); }
});
