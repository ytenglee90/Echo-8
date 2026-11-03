import { expect, test } from '@playwright/test';

for (const textBox of [false, true]) test(`search clears a nonmatching selected ${textBox ? 'text box' : 'node'} and automatically navigates to a canvas match`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const oldSelection = page.locator('.text-node-card').filter({ hasText: '未命名节点' });
  await oldSelection.locator('header').click();
  if (textBox) await page.getByRole('group', { name: '选中项工具', exact: true })
    .getByRole('button', { name: '文本框与文字节点相互转换', exact: true }).click();
  await expect(oldSelection).toHaveClass(/selected/u);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const query = textBox ? '新节点会出现在当前视图中间' : 'AI 助手使用指南';
  const input = panel.getByRole('textbox', { name: '查找标题和正文' });
  await input.fill(query); await input.press('Enter');
  await expect(panel.getByRole('option').first()).toBeVisible();
  await panel.getByRole('button', { name: '下一个', exact: true }).click();
  await expect(oldSelection).not.toHaveClass(/selected/u);
  await expect(page.locator('.text-node-card.selected')).toHaveCount(1);
  await expect(panel.locator('.search-status')).toContainText('全画布：');
  await expect(page.getByText('操作没有完成', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.search-status.error')).toHaveCount(0);
  if (textBox) {
    await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
    await expect.poll(() => page.locator('.editor-writing-area').first().evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe(query);
  } else {
    await expect(page.locator('.text-node-card.selected')).toContainText('AI 助手使用指南');
  }
  expect(errors).toEqual([]);
});
