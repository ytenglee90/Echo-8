import { expect, test, type Locator } from '@playwright/test';
import { openModelSettings } from './helpers/model-settings.ts';

async function controlStyle(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
      radius: style.borderRadius, height: element.getBoundingClientRect().height };
  });
}

test('model selector follows the selected name and keeps composer actions visible in narrow windows', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const panel = page.getByRole('region', { name: 'AI 助手', exact: true });
  await expect(panel.getByRole('combobox', { name: '当前模型平台', exact: true })).toBeDisabled();
  await expect(panel.locator('.ai-model-selector')).toContainText('模型未配置');
  const composer = panel.locator('.ai-composer textarea');
  await composer.fill('保留这个输入草稿');
  await expect(panel.locator('.ai-composer-input')).toHaveCSS('box-shadow', 'none');
  const models = ['deepseek-flash', '中文模型 · reasoning-pro-2026', 'long-model-'.repeat(8)];
  await openModelSettings(page);
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  for (const model of models) {
    await provider.getByRole('button', { name: '新建模型连接', exact: true }).click();
    await provider.getByRole('combobox', { name: '选择平台', exact: true }).selectOption('openai');
    await provider.getByLabel('模型', { exact: true }).fill(model);
    await provider.getByLabel('API KEY', { exact: true }).fill('test-key-not-real');
    await provider.getByRole('button', { name: '保存连接', exact: true }).click();
    await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
  }
  await provider.getByRole('button', { name: '关闭 AI 模型连接', exact: true }).click();
  await panel.getByRole('button', { name: 'AI 对话', exact: true }).click();
  const select = panel.getByRole('combobox', { name: '当前模型平台', exact: true });
  await expect(composer).toHaveValue('保留这个输入草稿');
  await expect(select.locator('option')).toHaveText(models);
  const width = async () => (await select.boundingBox())!.width;
  await select.selectOption({ label: models[0] });
  await expect(select).toHaveAttribute('title', `切换模型：${models[0]}`);
  const shortWidth = await width();
  expect(shortWidth).toBeGreaterThan(100);
  expect(shortWidth).toBeLessThan(165);
  await select.selectOption({ label: models[1] });
  await expect.poll(width).toBeGreaterThan(shortWidth + 30);
  await select.selectOption({ label: models[0] });
  await expect.poll(width).toBeCloseTo(shortWidth, 0);
  await select.focus();
  await expect(select).toBeFocused();
  await panel.screenshot({ path: info.outputPath('model-selector-fit.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await select.selectOption({ label: models[2] });
  await expect(select).toHaveAttribute('title', `切换模型：${models[2]}`);
  const footer = panel.locator('.ai-composer-footer');
  await expect.poll(() => footer.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  for (const name of [/^Prompt：/u, '选择本轮记忆，前往记忆中心', '发送给模型']) {
    await expect(footer.getByRole('button', { name, exact: typeof name === 'string' })).toBeInViewport();
  }
  await panel.screenshot({ path: info.outputPath('model-selector-narrow.png') });
});

test('assistant views share control typography, spacing and section headings', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const panel = page.getByRole('region', { name: 'AI 助手', exact: true });
  const chatSelect = await controlStyle(panel.locator('.ai-model-selector select'));
  await panel.screenshot({ path: info.outputPath('ai-chat.png') });
  await panel.getByRole('button', { name: /^Prompt：/u }).click();
  const prompt = page.getByRole('region', { name: 'AI Prompt 模板', exact: true });
  const formSelect = await controlStyle(prompt.getByRole('combobox'));
  const { height: compactHeight, ...compactTypography } = chatSelect;
  const { height: formHeight, ...formTypography } = formSelect;
  expect(compactTypography).toEqual(formTypography);
  expect(compactHeight).toBeGreaterThanOrEqual(28);
  expect(compactHeight).toBeLessThanOrEqual(formHeight);
  expect(await controlStyle(prompt.getByPlaceholder('例如：代码审查、新闻稿、产品分析'))).toEqual(formSelect);
  const promptHeading = await prompt.getByRole('heading', { name: 'Prompt 模板', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  });
  const promptPadding = await prompt.evaluate(element => getComputedStyle(element).padding);
  await prompt.screenshot({ path: info.outputPath('ai-prompts.png') });
  await panel.getByRole('button', { name: 'AI 对话', exact: true }).click();
  await panel.getByRole('button', { name: '选择本轮记忆，前往记忆中心', exact: true }).click();
  const memory = page.getByRole('region', { name: 'AI 记忆中心', exact: true });
  expect(await memory.evaluate(element => getComputedStyle(element).padding)).toBe(promptPadding);
  expect(await memory.getByRole('heading', { name: '记忆库', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  })).toEqual(promptHeading);
  const memoryButton = await controlStyle(memory.getByRole('button', { name: '选择保存路径', exact: true }));
  expect(memoryButton.height).toBe(formSelect.height);
  expect(memoryButton.fontFamily).toBe(chatSelect.fontFamily);
  expect(memoryButton.radius).toBe(chatSelect.radius);
  await memory.screenshot({ path: info.outputPath('ai-memory.png') });
  await openModelSettings(page);
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  expect(await controlStyle(provider.locator('.ai-provider-profile-toolbar select'))).toEqual(formSelect);
  expect(await provider.getByRole('heading', { name: '连接模型', exact: true }).evaluate(element => {
    const style = getComputedStyle(element); return [style.fontSize, style.fontWeight, style.lineHeight];
  })).toEqual(promptHeading);
  const retrievalButton = provider.getByRole('button', { name: '打开检索设置', exact: true });
  await retrievalButton.scrollIntoViewIfNeeded();
  await expect(retrievalButton).toBeInViewport();
  const providerBox = (await provider.locator('.ai-provider-connection-module').boundingBox())!;
  expect((await retrievalButton.boundingBox())!.y).toBeGreaterThanOrEqual(providerBox.y + providerBox.height);
  await provider.screenshot({ path: info.outputPath('ai-provider.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await retrievalButton.scrollIntoViewIfNeeded();
  await expect(retrievalButton).toBeInViewport();
  await expect.poll(() => provider.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await provider.screenshot({ path: info.outputPath('ai-provider-footer-narrow.png') });
  await provider.getByRole('button', { name: '关闭 AI 模型连接', exact: true }).click();
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
    [/^Prompt：/u, '.ai-prompt-center select'], ['选择本轮记忆，前往记忆中心', '.ai-memory-daily-action strong'],
  ] as const) {
    await panel.getByRole('button', { name: 'AI 对话', exact: true }).click();
    await panel.getByRole('button', { name: button, exact: typeof button === 'string' }).click();
    await expect(panel.locator(selector)).toHaveCSS('color', 'rgb(255, 255, 255)');
  }
  await openModelSettings(page);
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  await expect(provider.locator('.ai-provider-profile-toolbar select')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await provider.screenshot({ path: info.outputPath('ai-provider-dark.png') });
});
