import { expect, test, type Page } from '@playwright/test';

async function start(page: Page, pointer = false) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await expect(page.getByRole('navigation', { name: '主工具栏' }).getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette.getByRole('option').first()).toHaveText(/设置中心/u);
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  if (pointer) await palette.getByRole('option').first().click();
  else await palette.getByRole('textbox', { name: '搜索命令' }).press('Enter');
  await expect(page.getByRole('region', { name: '设置中心', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '云同步', exact: true })).toHaveAttribute('aria-current', 'page');
}

test('settings shares navigation across all six owner pages and keeps command search independent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await start(page);
  const center = page.getByRole('region', { name: '设置中心', exact: true });
  const nav = center.getByRole('navigation', { name: '设置分类' });
  await expect(nav.getByRole('button')).toHaveText(['云同步', '书籍与恢复', '命令与快捷键', '外观', '插件', '内核与诊断']);
  for (const [category, heading] of [
    ['外观', '全局颜色设置'], ['命令与快捷键', '命令与快捷键'], ['云同步', '云同步'],
    ['书籍与恢复', '书籍与恢复'], ['插件', '插件'], ['内核与诊断', '内核与诊断'],
  ]) {
    await nav.getByRole('button', { name: category, exact: true }).click();
    await expect(nav.getByRole('button', { name: category, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(center.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(center.locator('.settings-page-header')).toHaveCount(1);
  }
  await expect(center.getByText('详细运行信息', { exact: true })).toBeVisible();
  await expect(center.getByRole('heading', { name: '插件健康' })).toBeHidden();
  await center.getByText('详细运行信息', { exact: true }).click();
  await expect(center.getByRole('heading', { name: '插件健康' })).toBeVisible();
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开全局颜色设置');
  await palette.getByRole('option', { name: /^打开全局颜色设置/u }).click();
  await expect(palette).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '外观', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(center).toHaveCount(0);
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  await palette.getByRole('option').first().click();
  await expect(nav.getByRole('button', { name: '云同步', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '命令面板', exact: true }).focus();
  await page.keyboard.press('Control+Alt+k');
  await expect(page.getByRole('heading', { name: '命令与快捷键', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('command preferences filter sources and custom bindings and remove stopped plugin pages', async ({ page }) => {
  await start(page);
  const nav = page.getByRole('navigation', { name: '设置分类' });
  await nav.getByRole('button', { name: '命令与快捷键', exact: true }).click();
  const panel = page.getByRole('region', { name: '快捷键中心', exact: true });
  await panel.getByPlaceholder('搜索操作或分类…').fill('canvas.focusSelection');
  const binding = panel.getByRole('textbox', { name: '修改聚焦选中项的快捷键', exact: true });
  await expect(binding).toBeVisible();
  await binding.focus();
  await binding.press('Control+Alt+Shift+9');
  await panel.getByRole('combobox', { name: '筛选命令' }).selectOption('custom');
  await expect(binding).toHaveValue(/9/u);
  await panel.getByRole('button', { name: '恢复聚焦选中项的默认快捷键', exact: true }).click();
  await expect(panel.locator('.shortcut-row')).toHaveCount(0);
  await nav.getByRole('button', { name: '插件', exact: true }).click();
  const plugins = page.getByRole('region', { name: '插件中心', exact: true });
  await plugins.getByRole('textbox', { name: '搜索插件' }).fill('diagnostic-center');
  await plugins.getByRole('switch', { name: '停用诊断中心', exact: true }).click();
  await expect(nav.getByRole('button', { name: '内核与诊断', exact: true })).toHaveCount(0);
  await plugins.getByRole('switch', { name: '启用诊断中心', exact: true }).click();
  await expect(nav.getByRole('button', { name: '内核与诊断', exact: true })).toBeVisible();
});

test('narrow screens keep navigation, content, and close controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, true);
  const center = page.getByRole('region', { name: '设置中心', exact: true });
  await center.getByRole('button', { name: '命令与快捷键', exact: true }).click();
  await expect(center.getByRole('heading', { name: '命令与快捷键', exact: true })).toBeVisible();
  expect(await center.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await center.getByRole('button', { name: '关闭快捷键中心', exact: true }).click();
  await expect(center).toHaveCount(0);
  await expect(page.getByRole('button', { name: '命令面板', exact: true })).toBeFocused();
});
