import { expect, test, type Locator } from '@playwright/test';

async function controlStyle(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
      radius: style.borderRadius, height: element.getBoundingClientRect().height };
  });
}

test('assistant views share control typography, spacing and section headings', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const panel = page.getByRole('region', { name: 'AI 助手', exact: true });
  const chatSelect = await controlStyle(panel.locator('.ai-model-selector select'));
  await panel.screenshot({ path: info.outputPath('ai-chat.png') });
  await panel.getByRole('button', { name: 'Prompt 模板', exact: true }).click();
  const prompt = page.getByRole('region', { name: 'AI Prompt 模板', exact: true });
  expect(await controlStyle(prompt.getByRole('combobox'))).toEqual(chatSelect);
  expect(await controlStyle(prompt.getByPlaceholder('例如：代码审查、新闻稿、产品分析'))).toEqual(chatSelect);
  const promptHeading = await prompt.getByRole('heading', { name: 'Prompt 模板', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  });
  const promptPadding = await prompt.evaluate(element => getComputedStyle(element).padding);
  await prompt.screenshot({ path: info.outputPath('ai-prompts.png') });
  await panel.getByRole('button', { name: 'AI 记忆中心', exact: true }).click();
  const memory = page.getByRole('region', { name: 'AI 记忆中心', exact: true });
  expect(await memory.evaluate(element => getComputedStyle(element).padding)).toBe(promptPadding);
  expect(await memory.getByRole('heading', { name: '记忆库', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  })).toEqual(promptHeading);
  const memoryButton = await controlStyle(memory.getByRole('button', { name: '选择保存路径', exact: true }));
  expect(memoryButton.height).toBe(chatSelect.height);
  expect(memoryButton.fontFamily).toBe(chatSelect.fontFamily);
  expect(memoryButton.radius).toBe(chatSelect.radius);
  await memory.screenshot({ path: info.outputPath('ai-memory.png') });
  await panel.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  expect(await controlStyle(provider.locator('.ai-provider-profile-toolbar select'))).toEqual(chatSelect);
  expect(await provider.getByRole('heading', { name: '连接模型', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  })).toEqual(promptHeading);
  await panel.screenshot({ path: info.outputPath('ai-provider.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => panel.locator('.ai-provider-settings-host').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await panel.getByRole('button', { name: 'AI 记忆中心', exact: true }).click();
  expect(await memory.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect((await memory.locator('.ai-memory-daily-action').boundingBox())!.height).toBeLessThan(160);
  await panel.screenshot({ path: info.outputPath('ai-memory-narrow.png') });
});

test('assistant controls retain the shared panel foreground in dark appearance', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开全局颜色设置');
  await palette.getByRole('option', { name: /^打开全局颜色设置/u }).click();
  await page.getByRole('button', { name: /^B 暗调/u }).click();
  await page.getByRole('button', { name: '关闭全局颜色设置', exact: true }).click();
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const panel = page.getByRole('region', { name: 'AI 助手', exact: true });
  await expect(panel).toHaveCSS('color', 'rgb(255, 255, 255)');
  for (const [button, selector] of [
    ['Prompt 模板', '.ai-prompt-center select'], ['AI 记忆中心', '.ai-memory-daily-action strong'],
    ['配置模型平台与 KEY', '.ai-provider-profile-toolbar select'],
  ]) {
    await panel.getByRole('button', { name: button, exact: true }).click();
    await expect(panel.locator(selector)).toHaveCSS('color', 'rgb(255, 255, 255)');
  }
  await panel.screenshot({ path: info.outputPath('ai-provider-dark.png') });
});
