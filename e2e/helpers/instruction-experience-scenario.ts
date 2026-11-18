import { expect, test } from '@playwright/test';

export function instructionExperienceScenario(url: string) {
  test('instruction directory is searchable without an account and follows plugin availability', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await expect(library.getByRole('button', { name: /AI 助手/u })).toHaveCount(0);
    await library.press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await expect(ai.getByText('当前书籍：当前本地书籍')).toBeVisible();
    await ai.getByRole('combobox', { name: '助手默认控制范围' }).selectOption('canvas');
    await expect(ai.getByRole('combobox', { name: '助手默认控制范围' })).toHaveValue('canvas');
    await ai.getByRole('button', { name: '查看指令', exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI 指令与偏好', exact: true });
    await expect(panel.getByRole('tab', { name: '全部指令', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => panel.getByRole('listitem').count()).toBeGreaterThan(100);
    await panel.getByRole('searchbox').fill('给选中节点编组');
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await expect(panel.getByRole('listitem')).toContainText('把选中的节点分组');
    await panel.getByRole('searchbox').fill('');
    await panel.getByRole('combobox', { name: '动作类别' }).selectOption('连线');
    await expect(panel.getByText('用虚线连接选中节点', { exact: true })).toBeVisible();
    await panel.screenshot({ path: info.outputPath('instructions-directory.png') });
    await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    await expect(panel.getByText('连接账户后可以保存个人设置，全部指令可直接浏览。')).toBeVisible();
    await panel.getByRole('tab', { name: '我的用语', exact: true }).press('ArrowRight');
    await expect(panel.getByRole('tab', { name: '默认偏好', exact: true })).toBeFocused();
    await panel.getByRole('tab', { name: '全部指令', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '插件', exact: true }).click();
    const plugins = page.getByRole('region', { name: '插件中心', exact: true });
    await plugins.getByRole('textbox', { name: '搜索插件' }).fill('groups');
    await plugins.getByRole('switch', { name: '停用群组', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '指令与偏好', exact: true }).click();
    await panel.getByRole('combobox', { name: '动作类别' }).selectOption('');
    await panel.getByRole('searchbox').fill('给选中节点编组');
    await expect(panel.getByRole('listitem')).toContainText('当前不可用');
    expect(errors).toEqual([]);
  });

  test('large independent creation reports batches and the reported compound request stays under the atomic limit', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const input = ai.locator('.ai-composer textarea');
    await input.fill('创建120张批量卡'); await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('已创建 120 个节点，共 2 批');
    await expect(ai).toContainText('全部撤销需要 2 次');
    await input.fill('生成60张空白，三张人物，两张角色，一张势力，一张地图，地图连接势力实线。60张空白打一个组');
    await input.press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 69 项操作');
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await expect(ai.getByText('这次超过 80 项操作，请分批发送。')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
