import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function command(page: Page, label: string) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill(label);
  await palette.getByRole('option', { name: new RegExp(`^${label}`, 'u') }).click();
}

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
}

const notice = (page: Page) => page.getByRole('status').filter({ hasText: '选择新的纠错规则' });
const fileInput = (page: Page) => page.locator('[data-ui-contribution="text-assist:text-assist.association-notice"] input[type="file"]');

test('Escape cancels rule selection before the underlying settings page and it can be reopened', async ({ page }) => {
  await start(page);
  await command(page, '设置中心');
  await command(page, '从 TXT 更新纠错规则');
  await expect(notice(page)).toBeVisible();
  await page.locator('.application-shell').dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  await expect(notice(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '设置中心', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '设置中心', exact: true })).toHaveCount(0);
  await command(page, '从 TXT 更新纠错规则');
  await notice(page).getByRole('button', { name: '取消导入纠错规则（Esc）', exact: true }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
});

test('missing-rule prompt can be dismissed and file chooser cancellation releases the surface', async ({ page }) => {
  await page.route('**/Echo-8-text-assist-rules.txt', route => route.fulfill({ status: 404 }));
  await start(page);
  const missing = page.getByRole('status').filter({ hasText: '纠错规则尚未导入' });
  await missing.getByRole('button', { name: '取消导入纠错规则（Esc）', exact: true }).click();
  await expect(missing).toHaveCount(0);
  await command(page, '从 TXT 更新纠错规则');
  await expect(notice(page)).toBeVisible();
  await fileInput(page).dispatchEvent('cancel');
  await expect(notice(page)).toHaveCount(0);
  await command(page, '设置中心');
  await command(page, '从 TXT 更新纠错规则');
  await fileInput(page).setInputFiles('public/Echo-8-text-assist-rules.txt');
  await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '设置中心', exact: true })).toHaveCount(0);
});

test('Escape while reading a selected file prevents a late import from replacing existing rules', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const originalText = File.prototype.text;
    File.prototype.text = async function () {
      const text = await originalText.call(this);
      if (this.name !== 'delayed-rules.txt') return text;
      return new Promise<string>(resolve => {
        (globalThis as unknown as { releaseRuleRead: () => void }).releaseRuleRead = () => resolve(text);
      });
    };
  });
  await command(page, '从 TXT 更新纠错规则');
  await fileInput(page).setInputFiles({
    name: 'delayed-rules.txt', mimeType: 'text/plain',
    buffer: readFileSync('public/Echo-8-text-assist-rules.txt'),
  });
  await expect(page.getByText('正在导入纠错规则…', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (globalThis as unknown as { releaseRuleRead?: unknown }).releaseRuleRead)).toBe('function');
  await page.keyboard.press('Escape');
  await expect(page.locator('.text-assist-association-notice')).toHaveCount(0);
  await page.evaluate(() => (globalThis as unknown as { releaseRuleRead: () => void }).releaseRuleRead());
  await command(page, '打开纠错补全规则');
  await expect(page.locator('.editor-writing-area')).toContainText('不重复写入书籍');
});
