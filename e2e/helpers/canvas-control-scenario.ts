import { expect, test, type Page } from '@playwright/test';
import type { CanvasControlPlan } from '../../src/protocols/canvas-control.ts';
import { parseProject } from '../../src/plugins/import-export/codec.ts';

const plan: CanvasControlPlan = { version: 1, actions: [
  { type: 'create-node', ref: 'hero', title: '主角｜林渊', text: '修钟学徒。\n\n寻找父亲🧭', color: '#a83d44' },
  { type: 'create-node', ref: 'heading', title: '主角', presentation: 'text-box', color: '#a83d44' },
  { type: 'create-node', ref: 'chapter', title: '正文｜第001章', text: '旧钟响了第十三下。', color: '#454851' },
  { type: 'create-group', ref: 'people', title: '主角组', members: ['hero', 'heading'] },
  { type: 'create-connection', ref: 'quote', from: 'hero', to: 'chapter', line: 'dashed', label: '引用' },
  { type: 'create-connection', ref: 'order', from: 'people', to: 'chapter', line: 'solid', label: '展开' },
] };

export function canvasControlScenarios(url: string): void {
  test('AI node editing binds the selected object and refuses a review after the user edits it', async ({ page }) => {
    test.setTimeout(60_000);
    let targetId = '';
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const request = route.request().postDataJSON() as { messages: Array<{ content: string }> };
      const instruction = request.messages.find(message => message.content.includes('<untrusted-canvas-objects>'))!.content;
      const raw = /<untrusted-canvas-objects>\n(.*)\n<\/untrusted-canvas-objects>/u.exec(instruction)![1];
      const directory = JSON.parse(raw) as { nodes: Array<{ id: string; title: string }> };
      expect(directory.nodes).toHaveLength(1);
      expect(directory.nodes[0].title).toBe('AI 助手使用指南');
      targetId = directory.nodes[0].id;
      const text = JSON.stringify({ version: 1, actions: [{ type: 'update-node', id: targetId, text: 'AI 的旧计划正文' }] });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const source = page.getByRole('article', { name: /文本节点：AI 助手使用指南$/u });
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await source.click({ position: { x: 20, y: 70 } });
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    await ai.locator('.ai-composer textarea').fill('@画布操作 把选中节点的正文替换为简短说明。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control.getByText('1 项操作', { exact: true })).toBeVisible();
    expect(targetId).toBeTruthy();
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await source.focus(); await source.press('Enter');
    const editor = page.locator('.editor-writing-area').first();
    await editor.focus(); await editor.press('Control+End'); await page.keyboard.insertText('用户保留的最新编辑🧭');
    await page.getByRole('button', { name: '关闭编辑器', exact: true }).click();
    await page.getByRole('button', { name: '画布控制', exact: true }).click();
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByRole('alert')).toContainText('已经变化');
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await source.focus(); await source.press('Enter');
    await expect(page.locator('.editor-writing-area').first()).toContainText('用户保留的最新编辑🧭');
    await expect(page.locator('.editor-writing-area').first()).not.toContainText('AI 的旧计划正文');
  });
  test('AI canvas control reviews a mixed plan, applies once, undoes, saves and reopens', async ({ page }, info) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
    let requestText = '';
    await page.route('https://canvas-control.test/**', route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      requestText = route.request().postData() ?? '';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await configure(page, url);
    const before = await page.locator('.text-node-card').count();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('@画布操作 新建主角和第一章，主角分类标题用文本框，与人物一起成组，再用虚线引用章节、实线连接群组和章节。');
    await ai.getByRole('button', { name: '发送给模型', exact: true }).click();
    const control = page.getByRole('region', { name: '画布控制', exact: true });
    await expect(control).toBeVisible();
    await expect(control.getByText('6 项操作', { exact: true })).toBeVisible();
    await expect(page.locator('.text-node-card')).toHaveCount(before);
    await expect(ai).not.toContainText('"create-node"');
    await expect(ai).toContainText('已生成 6 项画布操作计划');
    const messages = (JSON.parse(requestText) as { messages: Array<{ content: string }> }).messages;
    const directory = messages.find(message => message.content.includes('<untrusted-canvas-objects>'))?.content;
    expect(directory).toContain('untrusted-canvas-objects');
    // Default creation-only scope does not send titles of unselected onboarding nodes.
    expect(directory).not.toContain('"title":"AI 助手使用指南"');
    await control.screenshot({ path: info.outputPath('control-review.png') });
    await control.getByRole('button', { name: '应用整份计划' }).click();
    await expect(control.getByText('已应用', { exact: true })).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
    await expect(page.locator('.connection-path:not(.title-connection):not(.draft)')).toHaveCount(1);
    await control.getByRole('button', { name: '关闭画布控制' }).click();
    await ai.getByRole('button', { name: '关闭AI 助手' }).click();
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u }).locator('header')).toHaveCSS('background-color', 'rgb(168, 61, 68)');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u })).toHaveCount(0);
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u })).toBeVisible();
    await page.getByRole('button', { name: '命令面板', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await palette.getByRole('textbox', { name: '搜索命令' }).fill('另存本地副本');
    const downloadPromise = page.waitForEvent('download');
    await palette.getByRole('option', { name: /^另存本地副本/u }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.e8$/u);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    const project = await parseProject(new Blob([buffer]));
    expect(Object.keys(project.document.namespaces.groups)).toHaveLength(1);
    expect(Object.keys(project.document.namespaces.connections)).toHaveLength(2);
    await page.goto(url);
    await page.getByRole('region', { name: 'Echo-8 书库' }).locator('input[type=file]').setInputFiles({ name: '画布控制结果.e8', mimeType: 'application/octet-stream', buffer });
    await expect(page.getByRole('article', { name: /文本节点：主角｜林渊$/u })).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

async function configure(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
  await ai.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
  const provider = page.getByRole('region', { name: 'AI 模型连接与密钥', exact: true });
  await provider.getByRole('combobox', { name: '选择平台', exact: true }).selectOption('openai');
  await provider.getByLabel('API KEY', { exact: true }).fill('test-key-not-real');
  await provider.getByText('自定义地址（可选）', { exact: true }).click();
  await provider.getByLabel('完整接口地址', { exact: true }).fill('https://canvas-control.test/v1/chat/completions');
  await provider.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(provider.getByText('当前连接已就绪', { exact: true })).toBeVisible();
  await ai.getByRole('button', { name: 'AI 对话', exact: true }).click();
}
