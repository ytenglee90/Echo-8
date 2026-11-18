import { expect, type Page } from '@playwright/test';

/** Exercise the settings-center destination through its retained command entry. */
export async function openModelSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('配置 AI 模型连接与密钥');
  await palette.getByRole('option', { name: /^配置 AI 模型连接与密钥/u }).click();
  await expect(page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 模型连接', exact: true }))
    .toHaveAttribute('aria-current', 'page');
}
